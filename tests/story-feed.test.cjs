'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('stories feed maps peers, read boundaries and stateful pagination', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  const now = Math.floor(Date.now() / 1000);
  const story = (id, caption, mediaAreas = []) => new Api.StoryItem({ id, date: now - id, expireDate: now + 3600, caption, media: new Api.MessageMediaUnsupported(), mediaAreas });
  driver.client = { invoke: async request => {
    calls.push(request);
    return {
      state: 'opaque-next', hasMore: true, count: 2,
      peersStories: undefined,
      peerStories: [new Api.PeerStories({ peer: new Api.PeerUser({ userId: bigInt(77) }), maxReadId: 3, stories: [
        story(3, 'read'), story(4, 'unread', [new Api.MediaAreaUrl({
          coordinates: new Api.MediaAreaCoordinates({ x: 45, y: 52, w: 18, h: 12, rotation: 5 }), url: 'https://example.com/story',
        })]),
      ] })],
      users: [new Api.User({ id: bigInt(77), firstName: 'Ada', lastName: 'Lovelace', username: 'ada' })], chats: [],
    };
  } };
  const page = await driver.getStoriesFeed('old-state', true, true);
  assert.equal(calls[0].className, 'stories.GetAllStories');
  assert.equal(calls[0].state, 'old-state'); assert.equal(calls[0].next, true); assert.equal(calls[0].hidden, true);
  assert.deepEqual(page, {
    peers: [{ id: 77, type: 'private', title: 'Ada Lovelace', username: 'ada', isSelf: false, isRead: false, isHidden: true,
      stories: [
        { id: 3, date: now - 3, expireDate: now + 3600, caption: 'read', isPinned: false, mediaType: 'unknown', sentReaction: undefined },
        { id: 4, date: now - 4, expireDate: now + 3600, caption: 'unread', isPinned: false, mediaType: 'unknown', sentReaction: undefined,
          mediaAreas: [{ type: 'url', x: 45, y: 52, w: 18, h: 12, rotation: 5, url: 'https://example.com/story' }] },
      ],
    }], state: 'opaque-next', hasMore: true, count: 2,
  });
  await assert.rejects(driver.getStoriesFeed('', true, false), /Invalid story feed cursor/);
  assert.equal(calls.length, 1);
});

test('story feed route validates opaque pagination and forwards hidden view to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { peers: [], state: 'next-page', hasMore: true, count: 0 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/feed`;
    assert.equal((await fetch(`${base}?next=1`)).status, 400);
    assert.equal((await fetch(`${base}?hidden=maybe`)).status, 400);
    const response = await fetch(`${base}?state=opaque&next=1&hidden=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { peers: [], state: 'next-page', hasMore: true, count: 0 });
    assert.deepEqual(calls, [{ action: 'get_story_feed', payload: { state: 'opaque', next: true, hidden: true } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.handlers = {}; this.className = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  remove() { this.removed = true; }
}

test('stories bar opens the Telegram peer story set and discards late feed responses after account switch', async () => {
  const list = new Element();
  const more = new Element('button');
  const status = new Element();
  const els = new Map([['client-stories-list', list], ['btn-client-stories-more', more], ['client-stories-status', status]]);
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 7, instances: [
    { config: { id: 'a' }, status: 'ONLINE' }, { config: { id: 'b' }, status: 'ONLINE' },
  ] };
  const opened = [], requests = [];
  const context = vm.createContext({ state, document: {
    getElementById: id => els.get(id) || null, createElement: tag => new Element(tag),
  }, URLSearchParams, encodeURIComponent,
  openStoryViewer: (...args) => opened.push(args),
  api: (url) => new Promise(resolve => requests.push({ url, resolve })),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let storyFeedRequestId = 0;');
  const end = source.indexOf('\nfunction ensureStoryViewer()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.load = loadClientStoriesFeed;`, context);

  const loading = context.load(true);
  assert.equal(requests[0].url, '/api/instances/a/account/stories/feed?');
  requests[0].resolve({ peers: [{ id: 77, title: 'Ada', isRead: false, isSelf: false, isHidden: false,
    stories: [{ id: 9, date: 1, expireDate: 2, mediaType: 'photo' }] }], state: 'next', hasMore: true, count: 1 });
  await loading;
  assert.equal(list.children.length, 1);
  assert.equal(more.hidden, false);
  list.children[0].onclick();
  assert.equal(opened[0][0], 77);
  assert.equal(opened[0][2], 0);
  assert.equal(opened[0][3].source, 'feed');

  const staleLoad = context.load(true);
  state.clientSelectedInstance = 'b';
  const currentLoad = context.load(true);
  requests[2].resolve({ peers: [{ id: 88, title: 'Current account', isRead: true, isSelf: false, isHidden: false, stories: [{ id: 10 }] }], state: '', hasMore: false, count: 1 });
  await currentLoad;
  requests[1].resolve({ peers: [{ id: 88, title: 'Wrong account', isRead: true, stories: [{ id: 10 }] }], state: '', hasMore: false, count: 1 });
  await staleLoad;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[1].textContent, 'Current account');
});

test('story updates refresh one matching story without losing the viewer position', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nfunction storyStealthTargetIsCurrent(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 7, currentProfileChatId: 77 };
  const calls = [], shown = [], profileRefresh = [];
  const viewer = { session: { instId: 'a', chatId: 77, selectionVersion: 7, profileRequestId: 3,
    source: 'profile', stories: [{ id: 9 }, { id: 8 }], index: 0 },
    header: { textContent: '' }, previous: { disabled: false }, next: { disabled: false },
    status: { textContent: '' } };
  const context = vm.createContext({ state, storyViewer: viewer, encodeURIComponent,
    api: url => new Promise(resolve => calls.push({ url, resolve })),
    loadPeerStories: id => profileRefresh.push(id), showStoryAt: index => shown.push(index),
    closeStoryViewer: () => { viewer.closed = true; }, });
  vm.runInContext(`let profileRequestId = 3; let storyFeedEpoch = 4;\n${source.slice(start, end)}\nthis.refresh = refreshStoryViewerForUpdate;`, context);
  const pending = context.refresh('a', 77, 9);
  assert.equal(calls[0].url, '/api/instances/a/account/story?chatId=77&storyId=9');
  assert.deepEqual(profileRefresh, [77]);
  calls[0].resolve({ id: 9, caption: 'updated' });
  await pending;
  assert.deepEqual(viewer.session.stories.map(story => story.id), [9, 8]);
  assert.equal(viewer.session.stories[0].caption, 'updated');
  assert.equal(viewer.session.index, 0);
  assert.deepEqual(shown, [0]);
  assert.equal(viewer.header.textContent, '');
});

test('story update responses are discarded after switching the profile', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nfunction storyStealthTargetIsCurrent(', start);
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 7, currentProfileChatId: 77 };
  const viewer = { session: { instId: 'a', chatId: 77, selectionVersion: 7, profileRequestId: 3,
    source: 'profile', stories: [{ id: 9 }], index: 0 },
    header: { textContent: '' }, previous: { disabled: false }, next: { disabled: false },
    status: { textContent: '' } };
  let resolveApi; let shown = 0;
  const context = vm.createContext({ state, storyViewer: viewer, encodeURIComponent,
    api: () => new Promise(resolve => { resolveApi = resolve; }), loadPeerStories() {}, showStoryAt: () => { shown++; }, closeStoryViewer() {}, });
  vm.runInContext(`let profileRequestId = 3; let storyFeedEpoch = 4;\n${source.slice(start, end)}\nthis.refresh = refreshStoryViewerForUpdate;`, context);
  const pending = context.refresh('a', 77, 9);
  state.currentProfileChatId = 88;
  resolveApi({ id: 9, caption: 'stale' });
  await pending;
  assert.deepEqual(viewer.session.stories.map(story => story.id), [9]);
  assert.equal(shown, 0);
});

test('an archived story update removes a deleted item and keeps the selected story visible', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nfunction storyStealthTargetIsCurrent(', start);
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 7, currentProfileChatId: 77 };
  const viewer = { session: { instId: 'a', chatId: 77, selectionVersion: 7, profileRequestId: 3,
    source: 'archive', stories: [{ id: 9 }, { id: 8 }], index: 1 },
    header: { textContent: '' }, previous: { disabled: false }, next: { disabled: false }, status: { textContent: '' } };
  const calls = [], shown = [];
  const context = vm.createContext({ state, storyViewer: viewer, encodeURIComponent,
    api: url => new Promise(resolve => calls.push({ url, resolve })), loadPeerStories() {},
    showStoryAt: index => shown.push(index), closeStoryViewer: () => { viewer.closed = true; }, });
  vm.runInContext(`let profileRequestId = 3; let storyFeedEpoch = 4;\n${source.slice(start, end)}\nthis.refresh = refreshStoryViewerForUpdate;`, context);
  const pending = context.refresh('a', 77, 9);
  assert.equal(calls[0].url, '/api/instances/a/account/story?chatId=77&storyId=9');
  calls[0].resolve(null);
  await pending;
  assert.deepEqual(viewer.session.stories.map(story => story.id), [8]);
  assert.equal(viewer.session.index, 0);
  assert.deepEqual(shown, [0]);
  assert.equal(viewer.closed, undefined);
});

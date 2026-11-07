'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('other peer story albums load by Telegram peer, paginate, open and discard stale views', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('function peerStoryAlbumsAreCurrent(');
  const end = source.indexOf('\nfunction toggleStoryArchive(', start);
  assert.ok(start >= 0 && end > start);
  class Element {
    constructor() { this.children = []; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.attrs = {}; this.className = ''; this.textContent = ''; }
    appendChild(item) { this.children.push(item); return item; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(key, value) { this.attrs[key] = value; }
  }
  const ids = ['profile-story-albums', 'profile-story-albums-select', 'profile-story-albums-cover', 'profile-story-albums-list', 'profile-story-albums-status', 'btn-profile-story-albums-more'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 4,
    currentProfileChatId: -100123, currentProfileIsSelf: false };
  const requests = [], opened = [];
  const api = async url => {
    requests.push(url);
    if (url.includes('/account/stories/albums?')) return [{ id: 4, title: '朋友相册', coverType: 'video' }];
    const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset'));
    if (offset === 0) return { stories: [{ id: 11, date: 100, caption: '海边' }, { id: 12, date: 101 }], count: 3, nextOffset: 2 };
    return { stories: [{ id: 13, date: 102, caption: '山顶' }], count: 3 };
  };
  const context = vm.createContext({ state, nodes, document: { getElementById: id => nodes.get(id) || null, createElement: () => new Element() },
    profileRequestId: 8, profileStoryAlbumsState: null, URLSearchParams, encodeURIComponent, Number, String, Boolean, Date,
    api, openStoryViewer: (...args) => opened.push(args), });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadAlbums = loadPeerStoryAlbums; this.selectAlbum = selectPeerStoryAlbum; this.loadStories = loadPeerStoryAlbumStories; this.stateRef = () => profileStoryAlbumsState;`, context);

  await context.loadAlbums(-100123);
  assert.equal(nodes.get('profile-story-albums').hidden, false);
  assert.equal(nodes.get('profile-story-albums-select').children[1].textContent, '朋友相册');
  assert.match(requests[0], /chatId=-100123/);
  nodes.get('profile-story-albums-select').value = '4';
  await context.selectAlbum();
  assert.equal(nodes.get('profile-story-albums-cover').hidden, false);
  assert.match(nodes.get('profile-story-albums-cover').src, /story-album-cover\?chatId=-100123&albumId=4/);
  assert.equal(nodes.get('profile-story-albums-cover').alt, '相册封面：朋友相册');
  assert.match(requests[1], /chatId=-100123/);
  assert.equal(nodes.get('profile-story-albums-list').children.length, 2);
  assert.equal(nodes.get('btn-profile-story-albums-more').hidden, false);
  nodes.get('profile-story-albums-list').children[0].onclick();
  assert.equal(opened[0][0], -100123);
  assert.equal(opened[0][1][0].id, 11);
  await context.loadStories(true);
  assert.equal(nodes.get('profile-story-albums-list').children.length, 3);
  assert.equal(nodes.get('profile-story-albums-status').textContent, '3 条动态');
  state.clientSelectedInstance = 'b';
  nodes.get('profile-story-albums-list').children[0].onclick();
  assert.equal(opened.length, 1);
});

test('group and channel story settings can pin and unpin the current story on its own peer', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function toggleStoryPinned()');
  const end = source.indexOf('\nfunction openStoryViewer(', start);
  assert.ok(start >= 0 && end > start);
  const story = { id: 22, isPinned: false };
  const session = { instId: 'a', chatId: -100123, index: 0, stories: [story] };
  const pin = { hidden: false, disabled: false, textContent: '' };
  const status = { textContent: '' };
  const calls = [];
  const viewer = { session, pin, status };
  const context = vm.createContext({ storyViewer: viewer, encodeURIComponent, Boolean, Number,
    storyViewerIsCurrent: candidate => candidate === session,
    api: async (url, method, body) => { calls.push({ url, method, body }); },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.togglePin = toggleStoryPinned;`, context);
  await context.togglePin();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { chatId: -100123, storyId: 22, pinned: true });
  assert.equal(story.isPinned, true);
  assert.equal(pin.textContent, '从主页移除');
  await context.togglePin();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { chatId: -100123, storyId: 22, pinned: false });
  assert.equal(story.isPinned, false);
});

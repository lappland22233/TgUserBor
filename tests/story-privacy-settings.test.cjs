'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function storyFixture(privacy = [new Api.PrivacyValueAllowContacts(), new Api.PrivacyValueDisallowUsers({ users: [bigInt(98)] })]) {
  return new Api.StoryItem({
    id: 9, date: 100, media: new Api.MessageMediaEmpty(), privacy,
    contacts: true, pinned: true,
  });
}

function driverWithReplies(story = storyFixture()) {
  const calls = [];
  const users = [
    new Api.User({ id: bigInt(98), accessHash: bigInt(198), firstName: 'Ada', contact: true, closeFriend: true }),
    new Api.User({ id: bigInt(99), accessHash: bigInt(199), firstName: 'Grace', contact: true }),
  ];
  const blockedEntry = new Api.PeerBlocked({ peerId: new Api.PeerUser({ userId: bigInt(97) }), date: 100 });
  const blockedUser = new Api.User({ id: bigInt(97), accessHash: bigInt(197), firstName: 'Hidden' });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = id => new Api.InputPeerSelf();
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'stories.GetStoriesByID') return { stories: [story], users: [] };
    if (request.className === 'contacts.GetContacts') return { users };
    if (request.className === 'contacts.GetBlocked') return new Api.contacts.Blocked({ blocked: [blockedEntry], chats: [], users: [blockedUser] });
    return true;
  } };
  return { driver, calls, users };
}

test('story privacy reads the published audience, close friends and complete story blocklist', async () => {
  const { driver, calls } = driverWithReplies();
  const settings = await driver.getStoryPrivacySettings(42, 9);
  assert.equal(settings.privacyType, 'contacts');
  assert.deepEqual(settings.contactsExcept, ['98']);
  assert.deepEqual(settings.closeFriends, ['98']);
  assert.deepEqual(settings.hideFrom, ['97']);
  assert.equal(settings.isPinned, true);
  assert.equal(settings.editable, true);
  assert.deepEqual(settings.people.map(person => person.id).sort(), ['97', '98', '99']);
  assert.equal(calls.find(call => call.className === 'contacts.GetBlocked').myStoriesFrom, true);
  await assert.rejects(driver.getStoryPrivacySettings(77, 9), /Invalid story privacy request/);
});

test('story privacy saves preserve supported special rules and replace the selected audience', async () => {
  const story = storyFixture([
    new Api.PrivacyValueAllowContacts(),
    new Api.PrivacyValueDisallowUsers({ users: [bigInt(98)] }),
    new Api.PrivacyValueAllowPremium(),
  ]);
  const { driver, calls } = driverWithReplies(story);
  await driver.setStoryPrivacySettings(42, 9, {
    privacyType: 'selected', everyoneExcept: [], contactsExcept: ['98'], selectedContacts: ['99'],
    closeFriends: ['99'], hideFrom: ['97', '98'],
  });
  const closeFriends = calls.find(call => call.className === 'contacts.EditCloseFriends');
  assert.deepEqual(closeFriends.id.map(String), ['99']);
  const blocklist = calls.find(call => call.className === 'contacts.SetBlocked');
  assert.equal(blocklist.myStoriesFrom, true);
  assert.deepEqual(blocklist.id.map(peer => String(peer.userId)), ['97', '98']);
  const edit = calls.find(call => call.className === 'stories.EditStory');
  assert.equal(edit.peer.className, 'InputPeerSelf');
  assert.deepEqual(edit.privacyRules.map(rule => rule.className), ['InputPrivacyValueAllowPremium', 'InputPrivacyValueAllowUsers']);
  assert.deepEqual(edit.privacyRules[1].users.map(user => String(user.userId)), ['99']);
  await assert.rejects(driver.setStoryPrivacySettings(42, 9, {
    privacyType: 'public', everyoneExcept: [], contactsExcept: [], selectedContacts: [], closeFriends: ['42'], hideFrom: [],
  }), /Cannot add the current account/);
  await assert.rejects(driver.setStoryPrivacySettings(77, 9, {}), /Invalid story privacy request/);
});

test('unsupported story privacy rules cannot be silently overwritten', async () => {
  const story = storyFixture([new Api.PrivacyValueAllowAll(), new Api.PrivacyValueDisallowContacts()]);
  const { driver, calls } = driverWithReplies(story);
  const settings = await driver.getStoryPrivacySettings(42, 9);
  assert.equal(settings.editable, false);
  await assert.rejects(driver.setStoryPrivacySettings(42, 9, {
    privacyType: 'public', everyoneExcept: [], contactsExcept: [], selectedContacts: [], closeFriends: ['98'], hideFrom: ['97'],
  }), /无法安全保留/);
  assert.equal(calls.some(call => call.className === 'contacts.EditCloseFriends' || call.className === 'contacts.SetBlocked' || call.className === 'stories.EditStory'), false);
});

test('story privacy routes validate complete lists and dispatch to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_story_privacy_settings' ? { privacyType: 'public', people: [] } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/settings`;
    assert.equal((await fetch(`${url}?chatId=-42&storyId=9`)).status, 400);
    assert.deepEqual(await (await fetch(`${url}?chatId=42&storyId=9`)).json(), { privacyType: 'public', people: [] });
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const validSettings = { privacyType: 'public', everyoneExcept: [], contactsExcept: [], selectedContacts: [], closeFriends: [], hideFrom: [] };
    assert.equal((await post({ chatId: 42, storyId: 9, settings: { ...validSettings, hideFrom: [42] } })).status, 400);
    assert.equal((await post({ chatId: 42, storyId: 9, settings: validSettings })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_story_privacy_settings', payload: { chatId: 42, storyId: 9 } },
      { action: 'set_story_privacy_settings', payload: { chatId: 42, storyId: 9, settings: validSettings } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('story privacy editor binds reads and writes to the active story and keeps stale responses out', async () => {
  class Element {
    constructor() { this.children = []; this.disabled = false; this.value = ''; this.checked = false; this.textContent = ''; this.className = ''; this.isConnected = true; this.handlers = {}; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute() {}
    addEventListener(name, callback) { this.handlers[name] = callback; }
    focus() {}
    querySelector() { return null; }
  }
  const state = { clientSelectedInstance: 'a', currentProfileIsSelf: true, currentProfileChatId: 42, chatSelectionVersion: 3 };
  const session = { instId: 'a', chatId: 42, selectionVersion: 3, profileRequestId: 8, stories: [] };
  const calls = [];
  const document = { createElement: () => new Element(), getElementById: () => null };
  const context = vm.createContext({ state, document, encodeURIComponent, storyArchiveState: session,
    storyArchiveIsCurrent: candidate => candidate === session && state.clientSelectedInstance === 'a' && state.currentProfileIsSelf,
    renderStoryArchiveCards: () => {},
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      return method === 'POST' ? { success: true } : {
        privacyType: 'contacts', everyoneExcept: [], contactsExcept: ['98'], selectedContacts: [],
        closeFriends: ['98'], hideFrom: ['97'], editable: true,
        people: [{ id: '97', title: 'Hidden' }, { id: '98', title: 'Ada' }, { id: '99', title: 'Grace' }],
      };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function editArchivedStoryPrivacySettings(');
  const end = source.indexOf('\nasync function editArchivedStoryCaption(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.edit = editArchivedStoryPrivacySettings;`, context);
  const card = new Element(), story = { id: 9 };
  await context.edit(session, story, card);
  const editor = card.children[0];
  const controls = [];
  const visit = node => { controls.push(node); for (const child of node.children || []) visit(child); };
  visit(editor);
  const save = controls.find(item => item.textContent === '保存隐私设置');
  assert.ok(save); assert.equal(save.disabled, false);
  assert.equal(controls.some(item => item.textContent === 'Ada'), true);
  await save.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), {
    chatId: 42, storyId: 9,
    settings: { privacyType: 'contacts', everyoneExcept: [], contactsExcept: ['98'], selectedContacts: [], closeFriends: ['98'], hideFrom: ['97'] },
  });
  let resolveStale;
  context.api = () => new Promise(resolve => { resolveStale = resolve; });
  const staleCard = new Element();
  const stale = context.edit(session, story, staleCard);
  state.currentProfileIsSelf = false;
  resolveStale({ privacyType: 'public', people: [] });
  await stale;
  assert.equal(staleCard.children[0].children.length > 0, true);
});

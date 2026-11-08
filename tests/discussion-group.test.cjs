'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function makeChannel(id, title, flags = {}) {
  return new Api.Channel({ id: bigInt(id), accessHash: bigInt(id + 1), title,
    photo: new Api.ChatPhotoEmpty(), date: 1, ...flags });
}

function makeDriver(channels, invoke) {
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => {
    const marked = String(Math.abs(id));
    const rawId = marked.startsWith('100') ? marked.slice(3) : marked;
    return new Api.PeerChannel({ channelId: bigInt(rawId) });
  };
  driver.client = {
    getEntity: async peer => channels.get(String(peer.channelId)) || channels.get(String(peer.chatId)),
    getInputEntity: async entity => ({ channelId: entity.id }),
    invoke,
  };
  return driver;
}

test('discussion group lookup maps the current link and only Telegram-provided supergroup choices', async () => {
  const channel = makeChannel(111, 'News', { broadcast: true });
  const linked = makeChannel(222, 'Discussion', { megagroup: true, username: 'discussion', participantsCount: 15 });
  const candidate = makeChannel(333, 'Community', { megagroup: true, username: 'community', participantsCount: 30 });
  const notAvailableToThisAccount = makeChannel(555, 'Not manageable', { megagroup: true, username: 'not_manageable' });
  const ordinaryChannel = makeChannel(444, 'Announcements', { broadcast: true });
  const requests = [];
  const driver = makeDriver(new Map([['111', channel], ['222', linked], ['333', candidate]]), async request => {
    requests.push(request);
    if (request.className === 'channels.GetFullChannel') return { fullChat: { linkedChatId: bigInt(222) }, chats: [linked, notAvailableToThisAccount] };
    if (request.className === 'channels.GetGroupsForDiscussion') return { chats: [candidate, ordinaryChannel] };
    throw new Error(`unexpected ${request.className}`);
  });
  const state = await driver.getDiscussionGroupState(-100111);
  assert.deepEqual(state, { linkedGroup: { id: -100222, title: 'Discussion', username: 'discussion', membersCount: 15 }, groups: [
    { id: -100333, title: 'Community', username: 'community', membersCount: 30 },
    { id: -100222, title: 'Discussion', username: 'discussion', membersCount: 15 },
  ] });
  assert.ok(state.groups.every(group => group.id !== -100555), 'groups not returned as usable choices must not become selectable');
  assert.deepEqual(requests.map(request => request.className), ['channels.GetFullChannel', 'channels.GetGroupsForDiscussion']);
  await assert.rejects(driver.getDiscussionGroupState(111), /Invalid broadcast channel/);
});

test('linking a discussion group validates Telegram peer types and calls channels.SetDiscussionGroup', async () => {
  const channel = makeChannel(111, 'News', { broadcast: true });
  const group = makeChannel(222, 'Community', { megagroup: true });
  const calls = [];
  const driver = makeDriver(new Map([['111', channel], ['222', group]]), async request => { calls.push(request); return true; });
  await driver.linkDiscussionGroup(-100111, -100222);
  assert.equal(calls[0].className, 'channels.SetDiscussionGroup');
  assert.equal(String(calls[0].broadcast.channelId), '111');
  assert.equal(String(calls[0].group.channelId), '222');
  await driver.unlinkDiscussionGroup(-100111);
  assert.equal(calls[1].className, 'channels.SetDiscussionGroup');
  assert.equal(calls[1].group.className, 'InputChannelEmpty');
  await assert.rejects(driver.linkDiscussionGroup(-100111, -100111), /Invalid discussion group link/);
  await assert.rejects(driver.linkDiscussionGroup(-100111, -100333), /require a broadcast channel and a supergroup/);
});

test('discussion group HTTP routes validate IDs and dispatch only to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params });
    return action === 'get_discussion_group_state' ? { groups: [{ id: -100222, title: 'Discussion' }] } : { linked: true };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/discussion-groups`;
    assert.equal((await fetch(`${base}?channelId=1`)).status, 400);
    const state = await fetch(`${base}?channelId=-100111`);
    assert.deepEqual(await state.json(), { groups: [{ id: -100222, title: 'Discussion' }] });
    const post = body => fetch(`${base.replace(/s$/, '')}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post({ channelId: -100111, groupId: -100111 })).status, 400);
    assert.deepEqual(await (await post({ channelId: -100111, groupId: -100222 })).json(), { linked: true });
    assert.deepEqual(await (await post({ channelId: -100111, unlink: true })).json(), { linked: false });
    assert.deepEqual(calls, [
      { action: 'get_discussion_group_state', params: { channelId: -100111 } },
      { action: 'link_discussion_group', params: { channelId: -100111, groupId: -100222 } },
      { action: 'unlink_discussion_group', params: { channelId: -100111 } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('discussion group modal targets the current broadcast channel and confirms before linking', async () => {
  const source = require('node:fs').readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function openDiscussionGroupDialog() {');
  const end = source.indexOf('\nconst automaticTranslationCache', start);
  assert.ok(start >= 0 && end > start);
  const ids = ['modal-discussion-group', 'discussion-group-current', 'discussion-group-select', 'discussion-group-status',
    'btn-discussion-group-link', 'btn-discussion-group-unlink', 'btn-discussion-group-close', 'btn-discussion-group-cancel'];
  const elements = new Map(ids.map(id => [id, { id, style: {}, children: [], disabled: false, value: '', textContent: '',
    replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); } }]));
  const state = { clientActiveDialog: { id: -100111, type: 'channel', title: 'News' }, clientActiveChatId: -100111,
    clientSelectedInstance: 'a', chatSelectionVersion: 6 };
  const calls = [], notices = [];
  let currentLinked = { id: -100222, title: 'Old group', username: 'old_group' };
  class FakeOption { constructor(text, value) { this.text = text; this.value = value; this.disabled = false; } }
  const context = vm.createContext({ state, encodeURIComponent, Option: FakeOption, window: { confirm: () => true },
    document: { getElementById: id => elements.get(id) || null },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (method === 'POST' && body.unlink) { currentLinked = undefined; return { linked: false }; }
      if (method === 'POST') { currentLinked = { id: body.groupId, title: 'New group' }; return { linked: true }; }
      return { ...(currentLinked ? { linkedGroup: currentLinked } : {}),
        groups: [{ id: -100222, title: 'Old group', username: 'old_group' }, { id: -100333, title: 'New group', username: 'new_group' }] };
    }, showToast: (message, kind) => notices.push({ message, kind }) });
  vm.runInContext(`${source.slice(start, end)}\nthis.openDiscussionGroupDialog = openDiscussionGroupDialog;`, context);
  await context.openDiscussionGroupDialog();
  const select = elements.get('discussion-group-select');
  assert.match(select.children[1].text, /@old_group/);
  assert.match(elements.get('discussion-group-current').textContent, /@old_group/);
  select.value = '-100333';
  await elements.get('btn-discussion-group-link').onclick();
  assert.equal(calls[0].url, '/api/instances/a/account/discussion-groups?channelId=-100111');
  assert.equal(calls[1].url, '/api/instances/a/account/discussion-group');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { channelId: -100111, groupId: -100333 });
  await elements.get('btn-discussion-group-unlink').onclick();
  assert.equal(calls[3].body.unlink, true);
  assert.equal(calls[3].body.channelId, -100111);
  assert.equal(notices.at(-1).kind, 'success');
});

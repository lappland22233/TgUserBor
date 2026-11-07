'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('banned participant pages use Telegram kicked-user filters and preserve pagination', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolveAdminInputChannel = async chatId => {
    assert.equal(chatId, -42);
    return new Api.InputChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  };
  const users = [
    new Api.User({ id: bigInt(10), firstName: 'Ada', username: 'ada' }),
    new Api.User({ id: bigInt(11), firstName: 'Lin', lastName: 'Chen' }),
  ];
  driver.client = { invoke: async request => {
    calls.push(request);
    return { count: 5, users, participants: [
      new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: bigInt(10) }), kickedBy: bigInt(1), date: 100, bannedRights: new Api.ChatBannedRights({ viewMessages: true }) }),
      new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: bigInt(11) }), kickedBy: bigInt(1), date: 200, bannedRights: new Api.ChatBannedRights({ viewMessages: true, untilDate: 900 }) }),
    ] };
  } };

  assert.deepEqual(await driver.getBannedParticipants(-42, 0, 2, 'a'), {
    count: 5,
    participants: [
      { user: { id: 10, username: 'ada', firstName: 'Ada', lastName: undefined, isBot: false, phone: undefined }, date: 100 },
      { user: { id: 11, username: undefined, firstName: 'Lin', lastName: 'Chen', isBot: false, phone: undefined }, date: 200, untilDate: 900 },
    ],
    nextOffset: 2,
  });
  assert.ok(calls[0] instanceof Api.channels.GetParticipants);
  assert.ok(calls[0].filter instanceof Api.ChannelParticipantsKicked);
  assert.equal(calls[0].filter.q, 'a');
  assert.equal(calls[0].offset, 0);
  assert.equal(calls[0].limit, 2);
  await assert.rejects(driver.getBannedParticipants(42), /Invalid banned participant query/);
  await assert.rejects(driver.getBannedParticipants(-42, -1), /Invalid banned participant query/);
  await assert.rejects(driver.getBannedParticipants(-42, 0, 20, 'x'.repeat(129)), /Invalid banned participant query/);
  assert.equal(calls.length, 1);
});

test('banned participant and unban routes validate input and stay scoped to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => {
    calls.push(args);
    if (args[0] === 'get_banned_participants') return { count: 1, participants: [{ user: { id: 10 }, date: 100 }] };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    assert.equal((await fetch(`${base}/banned-participants?chatId=42`)).status, 400);
    const page = await fetch(`${base}/banned-participants?chatId=-42&offset=50&limit=25&query=Ada`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await page.json(), { count: 1, participants: [{ user: { id: 10 }, date: 100 }] });
    const post = body => fetch(`${base}/unban`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 42, userId: 10 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: 10 })).status, 200);
    assert.deepEqual(calls, [
      ['get_banned_participants', { chatId: -42, offset: 50, limit: 25, query: 'Ada' }],
      ['unban_user', { chatId: -42, userId: 10 }],
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element {
  constructor(tagName = 'DIV') { this.tagName = tagName; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.isConnected = true; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  remove() { this.isConnected = false; }
}

test('banned-member UI loads account-bound pages, discards stale responses, and confirms unban', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function closeBannedMembersModal() {');
  const end = source.indexOf('\nfunction invalidateGroupMembers()', start);
  assert.ok(start >= 0 && end > start);

  const ids = ['modal-banned-members', 'banned-members-list', 'banned-members-status', 'btn-more-banned-members'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const calls = [];
  let resolvePage;
  const context = vm.createContext({
    state: { clientSelectedInstance: 'a', clientActiveChatId: -42, chatSelectionVersion: 3 },
    document: { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) },
    window: { chatWs: { isConnected: () => false } },
    URLSearchParams, encodeURIComponent, Number, String, Boolean, Array, Date, Promise,
    confirm: () => true,
    api: (url, method = 'GET', body) => {
      calls.push({ url, method, body });
      if (method === 'POST') return Promise.resolve({ success: true });
      return new Promise(resolve => { resolvePage = resolve; });
    },
  });
  vm.runInContext(`let groupMembersContext = { instId: 'a', chatId: -42, selectionVersion: 3 };
    let bannedMemberSession = null; let bannedMemberSearchTimer = null;
    function isCurrentGroupMembersContext(target) { return Boolean(target && target === groupMembersContext && state.clientSelectedInstance === target.instId && String(state.clientActiveChatId) === String(target.chatId) && state.chatSelectionVersion === target.selectionVersion); }
    ${source.slice(start, end)}
    this.open = openBannedMembersModal; this.load = loadBannedMembers; this.unban = unbanBannedMember;
    this.close = closeBannedMembersModal; this.getSession = () => bannedMemberSession;
    this.setSession = value => { bannedMemberSession = value; };`, context);

  context.open();
  assert.equal(elements.get('modal-banned-members').style.display, 'flex');
  assert.equal(calls[0].url, '/api/instances/a/account/banned-participants?chatId=-42&offset=0&limit=50&query=');
  resolvePage({ count: 1, participants: [{ user: { id: 10, firstName: 'Ada', username: 'ada' }, date: 100, untilDate: 200 }] });
  await new Promise(resolve => setImmediate(resolve));
  const session = context.getSession();
  const list = elements.get('banned-members-list');
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].children[0].children[1].textContent, /封禁至/);
  const card = list.children[0];
  const unbanButton = card.children[1].children[0];
  await context.unban(session, 10, 'Ada', card, unbanButton);
  assert.equal(card.isConnected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { url: '/api/instances/a/account/unban', method: 'POST', body: { chatId: -42, userId: 10 } });

  context.state.clientSelectedInstance = 'a';
  context.open();
  const staleResolve = resolvePage;
  context.state.clientSelectedInstance = 'b';
  staleResolve({ count: 1, participants: [{ user: { id: 11, firstName: 'Lin' }, date: 300 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.children.length, 0);
  context.close();
});

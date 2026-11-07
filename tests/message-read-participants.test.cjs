'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('message read receipts map participant IDs to cached Telegram users', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = {
    invoke: async request => {
      calls.push(request);
      return [
        new Api.ReadParticipantDate({ userId: bigInt(77), date: 123 }),
        new Api.ReadParticipantDate({ userId: bigInt(88), date: 124 }),
      ];
    },
    getEntity: async peers => {
      calls.push(peers);
      return [new Api.User({ id: bigInt(77), firstName: 'Ari', lastName: 'Lee', username: 'ari' })];
    },
  };
  const result = await driver.getMessageReadParticipants(-100123, 55);
  assert.equal(calls[0].className, 'messages.GetMessageReadParticipants');
  assert.equal(calls[0].peer.toString(), '-100123');
  assert.equal(calls[0].msgId, 55);
  assert.equal(calls[1].length, 2);
  assert.deepEqual(result, {
    count: 2,
    participants: [
      { user: { id: 77, username: 'ari', firstName: 'Ari', lastName: 'Lee', isBot: false, phone: undefined }, date: 123 },
      { user: { id: 88, isBot: false }, date: 124 },
    ],
  });
  await assert.rejects(driver.getMessageReadParticipants(0, 55), /Invalid message read participants request/);
});

test('message read receipts endpoint validates IDs and targets the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { count: 1, participants: [] };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/message-read-participants`;
    assert.equal((await fetch(`${base}?chatId=1&messageId=0`)).status, 400);
    const response = await fetch(`${base}?chatId=-100123&messageId=55`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1, participants: [] });
    assert.deepEqual(calls, [{ action: 'get_message_read_participants', payload: { chatId: -100123, messageId: 55 } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('read receipt dialog renders dates and discards results after switching chats', async () => {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.handlers = {}; this.hidden = false; this.disabled = false; this.textContent = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    get childElementCount() { return this.children.length; }
  }
  const modal = new Element(), title = new Element(), list = new Element(), status = new Element(), retry = new Element(), close = new Element();
  modal.nodes = { '[data-message-read-participants-title]': title, '[data-message-read-participants-list]': list,
    '[data-message-read-participants-status]': status, '[data-message-read-participants-retry]': retry,
    '[data-message-read-participants-close]': close };
  const nodes = new Map([['message-read-participants-modal', modal]]);
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element() };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 7,
    clientDialogs: [{ id: -100123, type: 'supergroup' }], clientMessages: [{ id: 55, outgoing: true }] };
  const requests = [], toasts = [];
  const context = vm.createContext({ state, document, window: {}, URLSearchParams, encodeURIComponent,
    api: url => new Promise(resolve => requests.push({ url, resolve })), showToast: message => toasts.push(message),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let messageReadParticipantsState = null;');
  const end = source.indexOf('\nasync function closeTelegramPoll(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.show = showMessageReadParticipants;`, context);

  const opening = context.show(-100123, 55);
  assert.equal(title.textContent, '已读成员');
  assert.match(requests[0].url, /message-read-participants\?chatId=-100123&messageId=55$/);
  requests[0].resolve({ count: 1, participants: [{ user: { id: 77, firstName: 'Ari' }, date: 123 }] });
  await opening;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].children[0].textContent, 'Ari');
  assert.equal(list.children[0].children[1].textContent, new Date(123000).toLocaleString());
  assert.equal(status.textContent, '共 1 人已读');

  const stale = context.show(-100123, 55);
  state.clientActiveChatId = 42; state.chatSelectionVersion++;
  requests[1].resolve({ count: 1, participants: [{ user: { id: 99, firstName: 'Stale' }, date: 124 }] });
  await stale;
  assert.equal(modal.hidden, true);
  assert.equal(list.children.length, 0);
  assert.deepEqual(toasts, []);
});

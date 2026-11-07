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

test('message reaction users retain Telegram cursor and map actual peer IDs', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async request => {
    calls.push(request);
    return new Api.messages.MessageReactionsList({
      count: 2, nextOffset: 'next+/cursor',
      reactions: [new Api.MessagePeerReaction({ peerId: new Api.PeerUser({ userId: bigInt(77) }), date: 123, reaction: new Api.ReactionEmoji({ emoticon: '🔥' }) })],
      users: [new Api.User({ id: bigInt(77), firstName: 'Ari', lastName: 'Lee', username: 'ari' })], chats: [],
    });
  } };
  const page = await driver.getMessageReactionUsers(-100123, 55, '🔥', 'old-cursor', 25);
  assert.equal(calls[0].className, 'messages.GetMessageReactionsList');
  assert.equal(calls[0].peer.toString(), '-100123');
  assert.equal(calls[0].id, 55);
  assert.equal(calls[0].reaction.emoticon, '🔥');
  assert.equal(calls[0].offset, 'old-cursor');
  assert.equal(calls[0].limit, 25);
  assert.equal(page.count, 2);
  assert.equal(page.nextOffset, 'next+/cursor');
  assert.deepEqual(page.users[0], {
    user: { id: 77, username: 'ari', firstName: 'Ari', lastName: 'Lee', isBot: false, phone: undefined }, date: 123,
  });
  await assert.rejects(driver.getMessageReactionUsers(-100123, 55, '', '', 50), /Invalid message reaction list request/);
});

test('message reaction user lookup accepts a custom emoji reaction document', async () => {
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async value => {
    request = value;
    return new Api.messages.MessageReactionsList({ count: 0, reactions: [], users: [], chats: [] });
  } };
  await driver.getMessageReactionUsers(-100123, 55, 'custom:98765');
  assert.ok(request.reaction instanceof Api.ReactionCustomEmoji);
  assert.equal(request.reaction.documentId.toString(), '98765');
  await assert.rejects(driver.getMessageReactionUsers(-100123, 55, 'custom:9223372036854775808'), /Invalid message reaction list request/);
});

test('message reaction users endpoint validates pagination and dispatches the requested peer', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { count: 1, users: [] };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/message-reactions`;
    assert.equal((await fetch(`${base}?chatId=1&messageId=9&emoji=%F0%9F%94%A5&limit=101`)).status, 400);
    const response = await fetch(`${base}?chatId=-100123&messageId=55&emoji=%F0%9F%94%A5&offset=opaque%2Bcursor&limit=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1, users: [] });
    const customResponse = await fetch(`${base}?chatId=-100123&messageId=55&emoji=custom%3A98765&limit=20`);
    assert.equal(customResponse.status, 200);
    assert.deepEqual(calls, [{ action: 'get_message_reaction_users', payload: {
      chatId: -100123, messageId: 55, emoji: '🔥', offset: 'opaque+cursor', limit: 20,
    } }, { action: 'get_message_reaction_users', payload: {
      chatId: -100123, messageId: 55, emoji: 'custom:98765', offset: '', limit: 20,
    } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('reaction viewer paginates users and cannot populate a later chat', async () => {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.handlers = {}; this.hidden = false; this.disabled = false; this.textContent = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    get childElementCount() { return this.children.length; }
  }
  const modal = new Element(), title = new Element(), list = new Element(), status = new Element(), more = new Element(), close = new Element();
  modal.nodes = { '[data-message-reactions-title]': title, '[data-message-reactions-list]': list,
    '[data-message-reactions-status]': status, '[data-message-reactions-more]': more, '[data-message-reactions-close]': close };
  const nodes = new Map([['message-reactions-modal', modal]]);
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element() };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 7,
    clientMessages: [{ id: 55, reactions: [{ emoji: '🔥', count: 2 }] }] };
  const requests = [], toasts = [];
  const context = vm.createContext({ state, document, window: {}, URLSearchParams, encodeURIComponent,
    api: url => new Promise(resolve => requests.push({ url, resolve })), showToast: message => toasts.push(message),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let messageReactionUsersState = null;');
  const end = source.indexOf('\nasync function closeTelegramPoll(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.show = showMessageReactionUsers;`, context);
  const opening = context.show(-100123, 55, '🔥');
  assert.equal(title.textContent, '回应 🔥');
  assert.match(requests[0].url, /message-reactions\?chatId=-100123&messageId=55&emoji=%F0%9F%94%A5&offset=&limit=50$/);
  requests[0].resolve({ count: 2, nextOffset: 'opaque+/cursor', users: [{ user: { id: 77, firstName: 'Ari' }, date: 123 }] });
  await opening;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].children[0].textContent, 'Ari');
  more.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(requests[1].url, /offset=opaque%2B%2Fcursor/);
  requests[1].resolve({ count: 2, users: [{ user: { id: 78, firstName: 'Bea' }, date: 124 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.children.length, 2);
  assert.equal(more.hidden, true);

  const stale = context.show(-100123, 55, '🔥');
  state.clientActiveChatId = 42; state.chatSelectionVersion++;
  requests[2].resolve({ count: 1, users: [{ user: { id: 99, firstName: 'Stale' }, date: 125 }] });
  await stale;
  assert.equal(modal.hidden, true);
  assert.equal(list.children.length, 0);
  assert.deepEqual(toasts, []);
});

test('reaction viewer recognizes custom emoji IDs when opening a message reaction list', async () => {
  class Element {
    constructor() { this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.children = []; this.handlers = {}; }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); return item; }
  }
  const title = new Element(), list = new Element(), status = new Element(), more = new Element(), close = new Element(), modal = new Element();
  modal.nodes = { '[data-message-reactions-title]': title, '[data-message-reactions-list]': list,
    '[data-message-reactions-status]': status, '[data-message-reactions-more]': more, '[data-message-reactions-close]': close };
  modal.querySelector = selector => modal.nodes[selector];
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 1,
    clientMessages: [{ id: 55, reactions: [{ emoji: '✨', customEmojiId: '98765', count: 1 }] }] };
  const requests = [];
  const context = vm.createContext({ state, document: { getElementById: id => id === 'message-reactions-modal' ? modal : null, createElement: () => ({}) },
    window: {}, URLSearchParams, encodeURIComponent, api: url => new Promise(resolve => requests.push({ url, resolve })), showToast() {} });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let messageReactionUsersState = null;');
  const end = source.indexOf('\nasync function closeTelegramPoll(', start);
  vm.runInContext(`${source.slice(start, end)}\nthis.show = showMessageReactionUsers;`, context);
  const opening = context.show(-100123, 55, 'custom:98765');
  assert.equal(title.textContent, '回应 ✨');
  assert.match(requests[0].url, /emoji=custom%3A98765/);
  requests[0].resolve({ count: 0, users: [] });
  await opening;
});

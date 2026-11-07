'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const bigInt = require('big-integer');
const { Api } = require('telegram');

test('available reactions map Telegram titles and premium/inactive flags', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return { className: 'messages.AvailableReactions', reactions: [
      { className: 'AvailableReaction', reaction: '🔥', title: 'Fire', premium: true, inactive: false },
      { className: 'AvailableReaction', reaction: '💩', title: 'Poop', premium: false, inactive: true },
    ] };
  } };
  assert.deepEqual(await driver.getAvailableReactions(), [
    { reaction: '🔥', title: 'Fire', premium: true, inactive: false },
    { reaction: '💩', title: 'Poop', premium: false, inactive: true },
  ]);
  assert.equal(calls[0].className, 'messages.GetAvailableReactions');
  assert.equal(calls[0].hash, 0);
});

test('peer reaction settings restrict the global list to Telegram-allowed emoji', async () => {
  const channel = new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(9) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => channel,
    invoke: async request => request.className === 'messages.GetAvailableReactions'
      ? { className: 'messages.AvailableReactions', reactions: [
        { className: 'AvailableReaction', reaction: '🔥', title: 'Fire' },
        { className: 'AvailableReaction', reaction: '💩', title: 'Poop' },
      ] }
      : { fullChat: { availableReactions: new Api.ChatReactionsSome({ reactions: [new Api.ReactionEmoji({ emoticon: '🔥' })] }) } },
  };
  assert.deepEqual(await driver.getAvailableReactions(-100123), [
    { reaction: '🔥', title: 'Fire', premium: false, inactive: false },
  ]);
});

test('custom emoji reactions follow peer permissions and use Telegram reaction constructors', async () => {
  const channel = new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(9) });
  const custom = new Api.ReactionCustomEmoji({ documentId: bigInt(98765) });
  const customAttribute = new Api.DocumentAttributeCustomEmoji({ alt: '🐱', stickerset: new Api.InputStickerSetEmpty({}) });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = () => channel;
  driver.client = {
    getInputEntity: async () => channel,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.messages.GetAvailableReactions) return { className: 'messages.AvailableReactions', reactions: [
        { className: 'AvailableReaction', reaction: '🔥', title: 'Fire' },
      ] };
      if (request instanceof Api.channels.GetFullChannel) return { fullChat: { availableReactions: new Api.ChatReactionsSome({
        reactions: [new Api.ReactionEmoji({ emoticon: '🔥' }), custom],
      }) } };
      if (request instanceof Api.messages.GetCustomEmojiDocuments) return [new Api.Document({ id: bigInt(98765), accessHash: bigInt(1),
        fileReference: Buffer.alloc(0), date: 1, mimeType: 'application/x-tgsticker', size: bigInt(1), dcId: 1, attributes: [customAttribute] })];
      if (request instanceof Api.messages.SendReaction) return true;
      throw new Error('unexpected request');
    },
  };
  assert.deepEqual(await driver.getAvailableReactions(-100123), [
    { reaction: '🔥', title: 'Fire', premium: false, inactive: false },
    { reaction: 'custom:98765', title: '🐱', premium: true, inactive: false, customEmojiId: '98765' },
  ]);
  await driver.reactToMessage(-100123, 55, 'custom:98765');
  const send = calls.find(request => request instanceof Api.messages.SendReaction);
  assert.ok(send);
  assert.ok(send.reaction[0] instanceof Api.ReactionCustomEmoji);
  assert.equal(send.reaction[0].documentId.toString(), '98765');
  await assert.rejects(driver.reactToMessage(-100123, 55, 'custom:0'), /Invalid message reaction/);
});

test('reaction catalog HTTP endpoint reads only the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ id, action, params }); return [{ reaction: '🔥', title: 'Fire' }];
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/instances/a/account/reactions?chatId=-100123`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ reaction: '🔥', title: 'Fire' }]);
    const sendUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/reaction`;
    const send = body => fetch(sendUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ chatId: -100123, messageId: 55, reaction: 'custom:0' })).status, 400);
    assert.equal((await send({ chatId: -100123, messageId: 55, reaction: 'custom:98765' })).status, 200);
    assert.deepEqual(calls, [
      { id: 'a', action: 'get_available_reactions', params: { chatId: -100123 } },
      { id: 'a', action: 'send_reaction', params: { chatId: -100123, messageId: 55, reaction: 'custom:98765' } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('reaction picker loads the current account catalog and sends the selected emoji to that message', async () => {
  class Element {
    constructor(dataset = {}) { this.dataset = dataset; this.style = {}; this.hidden = false; this.disabled = false; this.children = []; this.handlers = {}; this.value = ''; this.attributes = {}; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    contains(target) { return target === this || this.children.includes(target); }
    getBoundingClientRect() { return { bottom: 100 }; }
  }
  const ids = new Map();
  for (const id of ['client-messages-container', 'msg-context-menu', 'menu-backdrop', 'btn-more-message-reactions',
    'msg-reaction-picker', 'msg-reaction-search', 'msg-reaction-grid', 'msg-reaction-status']) ids.set(id, new Element());
  ids.get('msg-reaction-picker').hidden = true;
  const staticPills = ['👍', '❤️'].map(reaction => new Element({ reaction }));
  const requests = [], toasts = [];
  const container = ids.get('client-messages-container');
  const menu = ids.get('msg-context-menu');
  const doc = {
    getElementById: id => ids.get(id) || null,
    querySelectorAll: selector => selector === '.reaction-pill' ? [...staticPills, ids.get('btn-more-message-reactions')] : [],
    createElement: () => new Element(),
  };
  const state = { clientSelectedInstance: 'account-a', clientActiveChatId: -100123, chatSelectionVersion: 7 };
  const context = vm.createContext({
    state, document: doc, window: { innerWidth: 900, innerHeight: 700, addEventListener() {} }, navigator: {},
    requestAnimationFrame: callback => callback(), setTimeout, clearTimeout,
    api: (url, method, body) => new Promise(resolve => requests.push({ url, method, body, resolve })),
    showToast: value => toasts.push(value),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function initMessageContextMenu() {');
  const end = source.indexOf('\n}\n\n// ==========================================\n// Cache & Performance Settings Controller', start);
  assert.ok(start >= 0 && end > start, 'message context menu source is present');
  vm.runInContext(`let activeContextMsg = null; let availableReactionCatalog = { instId: null, chatId: null, reactions: null }; let longPressTimer = null; let touchCoords = { x: 0, y: 0 };\n${source.slice(start, end + 2)}\nthis.init = initMessageContextMenu;`, context);
  context.init();
  const message = new Element({ msgId: '55', isOut: '0', msgText: '', isPinned: '0' });
  container.handlers.contextmenu({ target: { closest: () => message }, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
  assert.equal(menu.style.display, 'flex');
  assert.equal(typeof ids.get('btn-more-message-reactions').onclick, 'function');
  ids.get('btn-more-message-reactions').onclick({ stopPropagation() {} });
  assert.equal(requests.length, 1, `unexpected reaction requests: ${JSON.stringify(requests.map(request => request.url))}`);
  assert.equal(requests[0].url, '/api/instances/account-a/account/reactions?chatId=-100123');
  requests[0].resolve([{ reaction: 'custom:12345', customEmojiId: '12345', title: '🐱', premium: true, inactive: false }]);
  await new Promise(resolve => setImmediate(resolve));
  const pickerButton = ids.get('msg-reaction-grid').children[0];
  assert.equal(pickerButton.children[0].src, '/api/instances/account-a/account/custom-emoji?documentId=12345');
  pickerButton.onclick({ stopPropagation() {} });
  assert.equal(requests[1].url, '/api/instances/account-a/account/reaction');
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].body)), { chatId: -100123, messageId: 55, reaction: 'custom:12345' });
  requests[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(toasts, ['已回应 🐱']);
  assert.equal(menu.style.display, 'none');
});

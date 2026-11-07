'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/gui/web/js/pinned-messages.js', 'utf8');
class Node {
  constructor() { this.children = []; this.hidden = false; this.disabled = false; this.className = ''; this.textContent = ''; this.value = ''; this.handlers = {}; }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  setAttribute() {}
  querySelector(selector) { return this.parts?.[selector] || null; }
}

function setup() {
  const requests = [];
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 7 };
  const button = new Node();
  const parts = Object.fromEntries([
    '#pinned-messages-title', '.pinned-messages-status', '.pinned-messages-list',
    '.pinned-messages-more', '[data-close]', '[data-unpin-all]',
  ].map(selector => [selector, new Node()]));
  let modal;
  let created = 0;
  const document = {
    readyState: 'complete', head: new Node(), body: new Node(),
    addEventListener() {},
    getElementById: id => id === 'btn-chat-pinned' ? button : null,
    createElement: () => {
      const node = new Node();
      if (created++ === 1) { modal = node; node.querySelector = selector => parts[selector] || null; }
      return node;
    },
  };
  const navigations = [];
  const confirmations = [];
  const window = {
    confirm: prompt => { confirmations.push(prompt); return true; },
    loadClientMessagesAround: (...args) => { navigations.push(args); return Promise.resolve(true); },
  };
  const ctx = vm.createContext({
    state, document, window, URLSearchParams, encodeURIComponent, Date,
    api: (url, method, body) => new Promise((resolve, reject) => requests.push({ url, method, body, resolve, reject })),
  });
  vm.runInContext(source, ctx);
  window.PinnedMessages.setDialog({ id: -100123, title: 'group' });
  return { state, button, get modal() { return modal; }, parts, requests, navigations, confirmations, window };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pinned list paginates and opens the selected message as a historical anchor', async () => {
  const h = setup();
  h.button.handlers.click();
  assert.equal(h.modal.hidden, false);
  assert.match(h.requests[0].url, /pinned-messages/);
  h.requests[0].resolve({
    total: 3, nextOffsetId: 9,
    messages: [{ id: 11, text: '<safe text>', date: 1700000000000 }, { id: 10, media: { type: 'photo' }, date: 1699999999000 }],
  });
  await tick();
  assert.equal(h.parts['.pinned-messages-list'].children.length, 2);
  assert.equal(h.parts['.pinned-messages-list'].children[0].children[0].children[1].textContent, '<safe text>');
  assert.equal(h.parts['.pinned-messages-more'].hidden, false);
  h.parts['.pinned-messages-more'].onclick();
  assert.match(h.requests[1].url, /offsetId=9/);
  h.requests[1].resolve({ total: 3, messages: [{ id: 9, text: 'older', date: 1699990000000 }] });
  await tick();
  assert.equal(h.parts['.pinned-messages-list'].children.length, 3);
  h.parts['.pinned-messages-list'].children[2].children[0].onclick();
  await tick();
  assert.equal(h.modal.hidden, true);
  assert.deepEqual(h.navigations, [[-100123, 9, 1699990000]]);
});

test('account switch discards an in-flight pinned message response', async () => {
  const h = setup();
  h.window.PinnedMessages.open();
  h.state.clientSelectedInstance = 'b';
  h.window.PinnedMessages.setDialog(null);
  h.requests[0].resolve({ messages: [{ id: 1, text: 'stale' }], total: 1 });
  await tick();
  assert.equal(h.modal.hidden, true);
  assert.equal(h.parts['.pinned-messages-list'].children.length, 0);
  assert.equal(h.button.hidden, true);
});

test('pinned messages can be unpinned individually or cleared together after confirmation', async () => {
  const h = setup();
  h.window.PinnedMessages.open();
  h.requests[0].resolve({ total: 1, messages: [{ id: 42, text: 'important' }] });
  await tick();
  h.parts['.pinned-messages-list'].children[0].children[2].onclick({ stopPropagation() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].body)), { chatId: -100123, messageId: 42 });
  assert.equal(h.requests[1].method, 'POST');
  h.requests[1].resolve({ success: true }); await tick();
  h.requests[2].resolve({ total: 0, messages: [] }); await tick();
  assert.equal(h.parts['[data-unpin-all]'].hidden, true);
  h.window.PinnedMessages.open();
  h.requests[3].resolve({ total: 1, messages: [{ id: 44, text: 'another' }] }); await tick();
  h.parts['[data-unpin-all]'].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[4].body)), { chatId: -100123 });
  assert.match(h.confirmations[0], /消息 #42/);
  assert.match(h.confirmations[1], /全部消息/);
});

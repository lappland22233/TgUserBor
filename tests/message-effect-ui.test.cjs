'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('let messageEffectsCache =');
const end = source.indexOf('function restoreBotReplyKeyboardState(', start);
if (start < 0 || end < 0) throw new Error('Cannot locate message effect controls');
class Element {
  constructor() { this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; }
  replaceChildren(...items) { this.children = [...items]; }
  appendChild(item) { this.children.push(item); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
}
function harness() {
  const select = new Element();
  const state = { clientSelectedInstance: 'a', clientMessageEffectId: null };
  const calls = [];
  const context = vm.createContext({ state, document: { getElementById: id => id === 'chat-message-effect' ? select : null, createElement: () => new Element() },
    encodeURIComponent, Promise, Array, Map, Number, String,
    api: url => new Promise((resolve, reject) => calls.push({ url, resolve, reject })),
  });
  vm.runInContext(source.slice(start, end) + '\nthis.load = loadMessageEffects; this.init = initMessageEffects;', context);
  return { context, state, select, calls };
}

test('effect picker loads Telegram choices and records an explicitly selected effect', async () => {
  const h = harness();
  const pending = h.context.load('a');
  assert.match(h.calls[0].url, /instances\/a\/account\/message-effects/);
  h.calls[0].resolve([{ id: '123', emoticon: '🎉', premium: false }, { id: '456', emoticon: '✨', premium: true }]);
  await pending;
  assert.equal(h.select.disabled, false);
  assert.deepEqual(h.select.children.map(option => option.value), ['', '123', '456']);
  assert.equal(h.select.children[1].textContent, '🎉');
  assert.equal(h.select.children[2].title, 'Telegram Premium 效果');
  h.context.init();
  h.select.value = '456';
  h.select.listeners.change[0]();
  assert.equal(h.state.clientMessageEffectId, '456');
});

test('late effect catalog responses cannot update a newly selected account', async () => {
  const h = harness();
  const pending = h.context.load('a');
  h.state.clientSelectedInstance = 'b';
  h.calls[0].resolve([{ id: '123', emoticon: '🎉' }]);
  await pending;
  assert.equal(h.select.children.length, 0);
  assert.equal(h.select.disabled, true);
});

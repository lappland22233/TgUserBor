'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');

function part(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Cannot locate ${from}`);
  return source.slice(start, end);
}

test('dice sending uses a validated native endpoint and refreshes only the original chat', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 4 };
  const calls = [], rendered = [], toasts = [];
  let resolve;
  const context = vm.createContext({ state, encodeURIComponent, showToast: (...args) => toasts.push(args),
    api: (url, method, body) => { calls.push({ url, method, body }); return new Promise(r => { resolve = r; }); },
    loadClientMessages: (...args) => rendered.push(args),
  });
  vm.runInContext(part('async function sendTelegramDice(', '\nfunction initPollModal') + '\nthis.send = sendTelegramDice;', context);
  const pending = context.send(-100123, '🎯');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    url: '/api/instances/a/account/dice', method: 'POST', body: { chatId: -100123, emoticon: '🎯' },
  });
  state.clientActiveChatId = -100456;
  resolve({ messageId: 6 });
  await pending;
  assert.equal(rendered.length, 0);
  assert.ok(toasts.some(([text, kind]) => text === '骰子已发送' && kind === 'success'));
});

test('dice cards render Telegram values and fall back safely for unknown emoticons', () => {
  const context = vm.createContext({ escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
  vm.runInContext(part('function renderSharedMessageMedia(', '\nfunction renderTodoChecklist') + '\nthis.render = renderSharedMessageMedia;', context);
  const result = context.render({ type: 'dice', diceEmoji: '🎯', diceValue: 5 });
  assert.match(result, /aria-label="🎯 结果 5"/);
  assert.match(result, />结果 5</);
  const pending = context.render({ type: 'dice', diceEmoji: '<img onerror=x>', diceValue: 0 });
  assert.match(pending, /🎲 正在掷…/);
  assert.doesNotMatch(pending, /<img/);
});

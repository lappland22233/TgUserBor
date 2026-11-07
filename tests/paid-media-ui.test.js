'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('async function buyChatPaidMedia(');
const end = source.indexOf('\nfunction getMessageAlbumGroupId(', start);
if (start < 0 || end < 0) throw new Error('Paid media purchase control is missing');

function harness(confirmed) {
  const state = { clientSelectedInstance: 'account-a', clientActiveChatId: '-10042', chatSelectionVersion: 3 };
  const calls = [], toasts = [], refreshed = [];
  const context = vm.createContext({ state, encodeURIComponent, window: { confirm: () => confirmed },
    api: async (...args) => { calls.push(args); return args[0].endsWith('/prepare')
      ? { token: 't'.repeat(32), stars: '45', itemCount: 2, title: 'Private media', description: 'Two videos' } : { stars: '45' }; },
    loadClientMessages: async (...args) => refreshed.push(args), showToast: (...args) => toasts.push(args), });
  vm.runInContext(source.slice(start, end) + '\nthis.buy = buyChatPaidMedia;', context);
  return { state, calls, toasts, refreshed, buy: context.buy };
}

test('paid media requires explicit Stars confirmation before payment and refreshes after success', async () => {
  const h = harness(true);
  await h.buy(-10042, 9);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0][0], /\/account\/paid-media\/prepare$/);
  assert.equal(JSON.stringify(h.calls[0][2]), JSON.stringify({ chatId: -10042, messageId: 9 }));
  assert.match(h.calls[1][0], /\/account\/paid-media\/confirm$/);
  assert.equal(JSON.stringify(h.calls[1][2]), JSON.stringify({ chatId: -10042, messageId: 9, token: 't'.repeat(32) }));
  assert.deepEqual(h.refreshed, [[-10042, true]]);
  assert.deepEqual(h.toasts, []);
});

test('canceling the Stars confirmation never submits the payment form', async () => {
  const h = harness(false);
  await h.buy(-10042, 9);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.refreshed, []);
});

test('a paid-media form prepared for a previous account is never confirmed', async () => {
  const h = harness(true);
  h.api = undefined;
  const state = h.state;
  const calls = [];
  const context = vm.createContext({ state, encodeURIComponent, window: { confirm: () => true },
    api: async (...args) => { calls.push(args); state.clientSelectedInstance = 'account-b'; return { token: 't'.repeat(32), stars: '45', itemCount: 2 }; },
    loadClientMessages() {}, showToast() {}, });
  vm.runInContext(source.slice(start, end) + '\nthis.buy = buyChatPaidMedia;', context);
  await context.buy(-10042, 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/prepare$/);
});

test('paid media price control appears only for a staged broadcast-channel photo/video', () => {
  const a = source.indexOf('function updatePaidMediaComposerControl(');
  const b = source.indexOf('\n// Lightbox Modal', a);
  assert.ok(a >= 0 && b > a);
  const button = { hidden: true, textContent: '' };
  const state = { clientActiveChatId: '-10042', clientActiveDialog: { type: 'channel', isBroadcast: true },
    clientStagedFiles: [{ type: 'image/jpeg' }], clientPaidMediaStars: null };
  const prompts = ['12', ''];
  const errors = [];
  const context = vm.createContext({ state, document: { getElementById: id => id === 'btn-chat-paid-media' ? button : null },
    window: { prompt: () => prompts.shift() }, showToast: message => errors.push(message), String, Number, Array });
  vm.runInContext(source.slice(a, b) + '\nthis.update = updatePaidMediaComposerControl; this.edit = editStagedPaidMediaPrice;', context);
  context.update();
  assert.equal(button.hidden, false);
  context.edit();
  assert.equal(state.clientPaidMediaStars, 12);
  assert.match(button.textContent, /12/);
  context.edit();
  assert.equal(state.clientPaidMediaStars, null);
  state.clientStagedFiles = [{ type: 'audio/ogg' }];
  context.update();
  assert.equal(button.hidden, true);
  state.clientStagedFiles = [{ type: 'image/jpeg' }];
  state.clientActiveDialog = { type: 'group', isBroadcast: false };
  context.update();
  assert.equal(button.hidden, true);
  assert.deepEqual(errors, []);
});

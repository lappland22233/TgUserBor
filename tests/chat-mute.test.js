'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = source.indexOf('function isDialogMuted(');
const end = source.indexOf('window.showDialogContextMenu', start);
if (start < 0 || end < 0) throw new Error('Cannot locate dialog mute handlers');
function setup() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, clientDialogs: [{ id: 1, muted: false }] };
  const calls = [];
  let resolve, reject;
  const context = vm.createContext({ state, window: {}, Date, encodeURIComponent,
    api: (url, method, body) => { calls.push({ url, method, body }); return new Promise((res, rej) => { resolve = res; reject = rej; }); },
    renderClientDialogs() {}, updateChatMuteButtonState() {}, showToast() {} });
  vm.runInContext(source.slice(start, end) + '\nthis.isDialogMuted = isDialogMuted;', context);
  return { context, state, calls, resolve: () => resolve({}), reject: () => reject(new Error('failed')) };
}
test('mute and unmute send explicit Telegram values and reflect server state', async () => {
  const h = setup();
  let pending = h.context.window.toggleDialogMute(1);
  assert.equal(h.calls[0].body.muteUntil, 2147483647);
  h.resolve(); await pending;
  assert.equal(h.context.isDialogMuted(1), true);
  pending = h.context.window.toggleDialogMute(1);
  assert.equal(h.calls[1].body.muteUntil, 0);
  h.resolve(); await pending;
  assert.equal(h.context.isDialogMuted(1), false);
});
test('failed mute does not alter the displayed server state', async () => {
  const h = setup(); const pending = h.context.window.toggleDialogMute(1);
  h.reject(); await pending;
  assert.equal(h.context.isDialogMuted(1), false);
});
test('a late mute response cannot update another account', async () => {
  const h = setup(); const pending = h.context.window.toggleDialogMute(1);
  h.state.clientSelectedInstance = 'b'; h.state.clientDialogs = [{ id: 1, muted: false }];
  h.resolve(); await pending;
  assert.equal(h.context.isDialogMuted(1), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('async function deleteSingleMsg(');
const end = source.indexOf('async function quickSendTyping(', start);
if (start < 0 || end < 0) throw new Error('Cannot locate deletion handlers');
function harness() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, chatSelectionVersion: 1, clientMessages: [{id:7},{id:8}] };
  const calls = [], notifications = [], refreshed = [];
  let resolve;
  const context = vm.createContext({ state, window: {}, encodeURIComponent, confirm: () => true,
    api: (url, method, body) => { calls.push({url, method, body}); return new Promise(r => {resolve=r;}); },
    showToast: message => notifications.push(message), renderClientMessages() {},
    loadClientMessages: chatId => { refreshed.push(chatId); }, document: { getElementById: () => ({style:{},innerHTML:'',innerText:''}) },
    loadClientDialogs() {},
  });
  vm.runInContext(source.slice(start, end) + '\nthis.deleteSingleMsg = deleteSingleMsg; this.quickPurge = quickPurge; this.quickLeaveChat = quickLeaveChat;', context);
  return {context, state, calls, notifications, refreshed, resolve: value => resolve(value)};
}
test('offline RPC fallback deletes the selected message and never purges another message', async () => {
  const h = harness(); const pending = h.context.deleteSingleMsg(7);
  assert.match(h.calls[0].url, /account\/delete-messages$/);
  assert.deepEqual(Array.from(h.calls[0].body.messageIds), [7]);
  h.resolve({}); await pending;
  assert.deepEqual(h.state.clientMessages.map(m => m.id), [8]);
});
test('late deletion cannot modify the message list of another chat', async () => {
  const h = harness(); const pending = h.context.deleteSingleMsg(7);
  h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++; h.state.clientMessages = [{id:7}];
  h.resolve({}); await pending;
  assert.equal(h.state.clientMessages.length, 1);
});
test('purge and leave responses do not reload or close a different chat', async () => {
  let h = harness(); let pending = h.context.quickPurge(3);
  h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++;
  h.resolve({deletedCount:0}); await pending;
  assert.equal(h.refreshed.length, 0);
  assert.match(h.notifications[0], /0 条/);
  h = harness(); pending = h.context.quickLeaveChat();
  h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++;
  h.resolve({}); await pending;
  assert.equal(h.state.clientActiveChatId, 2);
});

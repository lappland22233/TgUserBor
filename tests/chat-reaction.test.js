'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = source.indexOf('async function quickToggleReaction(');
const end = source.indexOf('async function sendClientMessage(', start);
if (start < 0 || end < 0) throw new Error('Cannot locate reaction handler');

test('a reaction response cannot update a later chat with the same message id', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, chatSelectionVersion: 1, clientMessages: [{ id: 5 }] };
  let resolve;
  const context = vm.createContext({ state, window: {}, api: () => new Promise(r => { resolve = r; }), renderClientMessages() {}, showToast() {} });
  vm.runInContext(source.slice(start, end) + '\nthis.toggle = quickToggleReaction;', context);
  const pending = context.toggle(5, '👍');
  state.clientActiveChatId = 2;
  state.chatSelectionVersion++;
  state.clientMessages = [{ id: 5 }];
  resolve({});
  await pending;
  assert.equal(state.clientMessages[0].reactions, undefined);
});

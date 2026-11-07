'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('let clientSearchRequest = 0;');
const end = app.indexOf('function navigateSearchMatch', start);
if (start < 0 || end < 0) throw new Error('Cannot locate chat search');

function harness() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: '1', clientSearchQuery: 'first', clientMessages: [], searchMatchIds: [], searchMatchIdx: -1 };
  const requests = [], toasts = [];
  const elements = Object.fromEntries(['chat-search-stats', 'btn-chat-search-prev', 'btn-chat-search-next'].map(id => [id, { style: {} }]));
  const context = vm.createContext({
    state, window: {}, document: { getElementById: id => elements[id] || null },
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    renderClientMessages: () => {}, scrollToMessage: () => {}, showToast: text => toasts.push(text),
  });
  vm.runInContext(app.slice(start, end) + '\nthis.executeChatServerSearch = executeChatServerSearch;', context);
  return { state, requests, toasts, context };
}

test('late search results do not enter a different conversation or account', async () => {
  const h = harness();
  const old = h.context.executeChatServerSearch('first');
  h.state.clientSelectedInstance = 'b';
  h.state.clientActiveChatId = '2';
  h.requests[0].resolve([{ id: 1 }]);
  await old;
  assert.equal(h.state.clientMessages.length, 0);
});

test('a newer search wins and stale failures do not show errors', async () => {
  const h = harness();
  const first = h.context.executeChatServerSearch('first');
  h.state.clientSearchQuery = 'second';
  const second = h.context.executeChatServerSearch('second');
  h.requests[1].resolve([{ id: 2 }]);
  await second;
  h.requests[0].reject(new Error('old error'));
  await first;
  assert.equal(h.state.clientMessages[0].id, 2);
  assert.equal(h.toasts.length, 0);
});

test('search results are deduplicated against loaded messages and themselves', async () => {
  const h = harness();
  h.state.clientMessages = [{ id: 1 }];
  const search = h.context.executeChatServerSearch('first');
  h.requests[0].resolve([{ id: '1' }, { id: 2 }, { id: 2 }]);
  await search;
  assert.deepEqual(h.state.clientMessages.map(m => String(m.id)), ['1', '2']);
});

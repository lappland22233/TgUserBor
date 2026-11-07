'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('let isLoadingEarlierMessages = false;');
const end = app.indexOf('function getSenderAvatarColor', start);
if (start < 0 || end < 0) throw new Error('Cannot locate chat history functions');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: '1', clientMessages: [], clientDialogs: [{ id: '1', unreadCount: 2 }] };
  const requests = [];
  const notifications = [];
  let renders = 0;
  const paragraph = { textContent: '' };
  const container = {
    innerHTML: '', scrollHeight: 500, scrollTop: 20,
    querySelector: () => paragraph,
    prepend: () => {},
  };
  const context = vm.createContext({
    state,
    window: {},
    URLSearchParams,
    document: {
      getElementById: id => id === 'client-messages-container' ? container : null,
      createElement: () => ({ style: {}, remove() {} }),
    },
    api: url => { const request = deferred(); requests.push({ url, ...request }); return request.promise; },
    renderClientMessages: () => { renders++; },
    renderClientDialogs: () => {},
    showToast: message => notifications.push(message),
  });
  vm.runInContext(app.slice(start, end) + '\nthis.loadClientMessages = loadClientMessages; this.loadEarlierMessages = loadEarlierMessages; this.returnToLatestMessages = returnToLatestMessages;', context);
  return { state, requests, notifications, container, context, get renders() { return renders; } };
}

test('returning to latest clears history mode and marks the chat read only after loading', async () => {
  const h = createHarness();
  h.state.clientHistoryOffsetDate = 1700000000;
  const pending = h.context.returnToLatestMessages();
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.clientDialogs[0].unreadCount, 2);
  assert.doesNotMatch(h.requests[0].url, /offsetDate/);
  h.requests[0].resolve([{ id: 30 }]);
  await pending;
  assert.equal(h.state.clientHistoryOffsetDate, null);
  assert.equal(h.state.clientMessages[0].id, 30);
  assert.equal(h.state.clientDialogs[0].unreadCount, 2);
  assert.match(h.requests[1].url, /account\/read/);
  h.requests[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.clientDialogs[0].unreadCount, 0);
});

test('a failed read request leaves the visible unread count intact', async () => {
  const h = createHarness();
  h.state.clientHistoryOffsetDate = 1700000000;
  const pending = h.context.returnToLatestMessages();
  h.requests[0].resolve([{ id: 30 }]);
  await pending;
  h.requests[1].reject(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.clientDialogs[0].unreadCount, 2);
});

test('a new message received while read is pending remains unread', async () => {
  const h = createHarness();
  h.state.clientHistoryOffsetDate = 1700000000;
  const pending = h.context.returnToLatestMessages();
  h.requests[0].resolve([{ id: 30 }]);
  await pending;
  h.state.clientDialogs[0].lastMessageId = 31;
  h.state.clientDialogs[0].unreadCount = 3;
  h.requests[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.clientDialogs[0].unreadCount, 3);
});

test('a failed return to latest keeps the historical view and allows retry', async () => {
  const h = createHarness();
  h.state.clientHistoryOffsetDate = 1700000000;
  h.state.clientMessages = [{ id: 7 }];
  const pending = h.context.returnToLatestMessages();
  h.requests[0].reject(new Error('offline'));
  await pending;
  assert.equal(h.state.clientHistoryOffsetDate, 1700000000);
  assert.equal(h.state.clientMessages[0].id, 7);
  assert.equal(h.state.clientDialogs[0].unreadCount, 2);
  assert.equal(h.requests.length, 1);
  assert.match(h.notifications[0], /offline/);
  const retry = h.context.returnToLatestMessages();
  h.requests[1].resolve([{ id: 30 }]);
  await retry;
  assert.equal(h.state.clientHistoryOffsetDate, null);
  assert.equal(h.state.clientMessages[0].id, 30);
});

test('silent refresh preserves the selected historical date', async () => {
  const h = createHarness();
  h.state.clientHistoryOffsetDate = 1700000000;
  let received;
  h.context.loadClientMessagesWithDate = (...args) => { received = args; return Promise.resolve(); };
  await h.context.loadClientMessages('1', true);
  assert.deepEqual(received, ['1', 1700000000, true]);
  assert.equal(h.requests.length, 0);
});

test('a late history response cannot overwrite the newly selected chat', async () => {
  const h = createHarness();
  const old = h.context.loadClientMessages('1');
  h.state.clientActiveChatId = '2';
  const current = h.context.loadClientMessages('2');
  h.requests[1].resolve([{ id: 20 }]);
  await current;
  h.requests[0].resolve([{ id: 10 }]);
  await old;
  assert.equal(h.state.clientMessages[0].id, 20);
  assert.equal(h.renders, 1);
});

test('a late response from a previous account cannot overwrite the current account', async () => {
  const h = createHarness();
  const old = h.context.loadClientMessages('1');
  h.state.clientSelectedInstance = 'b';
  const current = h.context.loadClientMessages('1');
  h.requests[1].resolve([{ id: 20 }]);
  await current;
  h.requests[0].resolve([{ id: 10 }]);
  await old;
  assert.equal(h.state.clientMessages[0].id, 20);
});

test('a history page that starts inside an album fetches and joins the missing prefix', async () => {
  const h = createHarness();
  const album = id => ({ id, groupedId: 'album-1', media: { type: 'photo' } });
  const pending = h.context.loadClientMessages('1');
  h.requests[0].resolve([ { id: 10 }, album(9), album(8) ]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.requests[1].url, /offsetId=8&limit=1|limit=1&offsetId=8/);
  h.requests[1].resolve([album(7)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.requests[2].url, /offsetId=8&limit=10|limit=10&offsetId=8/);
  h.requests[2].resolve([album(7), album(6), { id: 5 }]);
  await pending;
  assert.deepEqual(Array.from(h.state.clientMessages, message => message.id), [5, 6, 7, 8, 9, 10]);
});

test('a complete leading album only probes the previous message and keeps pagination clean', async () => {
  const h = createHarness();
  const album = id => ({ id, groupedId: 'album-1', media: { type: 'photo' } });
  const pending = h.context.loadClientMessages('1');
  h.requests[0].resolve([ { id: 10 }, album(9), album(8) ]);
  await new Promise(resolve => setImmediate(resolve));
  h.requests[1].resolve([{ id: 7 }]);
  await pending;
  assert.deepEqual(Array.from(h.state.clientMessages, message => message.id), [8, 9, 10]);
  assert.equal(h.requests.length, 2);
});

test('a stale failed request does not replace the current chat with an error', async () => {
  const h = createHarness();
  const old = h.context.loadClientMessages('1');
  h.state.clientActiveChatId = '2';
  const current = h.context.loadClientMessages('2');
  h.requests[1].resolve([{ id: 20 }]);
  await current;
  h.container.innerHTML = 'current chat';
  h.requests[0].reject(new Error('old error'));
  await old;
  assert.equal(h.container.innerHTML, 'current chat');
});

test('earlier messages returned after a chat switch do not enter the new chat', async () => {
  const h = createHarness();
  h.state.clientMessages = [{ id: 10 }];
  const old = h.context.loadEarlierMessages();
  h.state.clientActiveChatId = '2';
  const current = h.context.loadClientMessages('2');
  h.requests[1].resolve([{ id: 20 }]);
  await current;
  h.requests[0].resolve([{ id: 9 }]);
  await old;
  assert.equal(h.state.clientMessages.length, 1);
  assert.equal(h.state.clientMessages[0].id, 20);
  assert.equal(h.notifications.length, 0);
});

test('stale and failed history requests release their snapshots', async () => {
  const h = createHarness();
  const active = new Set();
  h.context.window.chatWs = {
    isConnected: () => false,
    beginMessageSnapshot: () => { const snapshot = {}; active.add(snapshot); return snapshot; },
    finishMessageSnapshot: (snapshot, messages) => { active.delete(snapshot); return messages; },
  };
  const old = h.context.loadClientMessages('1');
  h.state.clientActiveChatId = '2';
  const current = h.context.loadClientMessages('2');
  assert.equal(active.size, 2);
  h.requests[0].resolve([{ id: 10 }]);
  await old;
  assert.equal(active.size, 1);
  h.requests[1].reject(new Error('failed'));
  await current;
  assert.equal(active.size, 0);
});

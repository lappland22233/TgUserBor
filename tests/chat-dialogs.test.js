'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('let clientDialogsRequest = 0;');
const end = app.indexOf('function formatDialogTime', start);
if (start < 0 || end < 0) throw new Error('Cannot locate dialog loading function');

function createHarness() {
  const state = {
    clientSelectedInstance: 'a',
    instances: ['a', 'b'].map(id => ({ config: { id }, status: 'ONLINE' })),
    clientDialogs: [],
  };
  const requests = [];
  let renders = 0;
  const container = { innerHTML: '', firstElementChild: { textContent: '' } };
  const context = vm.createContext({
    state,
    window: {},
    URLSearchParams,
    document: { getElementById: () => container },
    api: url => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      requests.push({ url, resolve, reject });
      return promise;
    },
    renderClientDialogs: () => { renders++; },
    populateQuickChatOptions: () => {},
  });
  vm.runInContext(app.slice(start, end) + '\nthis.loadClientDialogs = loadClientDialogs; this.folderScan = () => ({stage: clientCustomFolderStage, incomplete: clientCustomFolderIncomplete, explicitIncomplete: clientCustomFolderExplicitIncomplete, hasMore: clientDialogsHasMore});', context);
  return { state, requests, container, context, get renders() { return renders; } };
}

test('late dialog results cannot overwrite a newer request for the same account', async () => {
  const h = createHarness();
  const old = h.context.loadClientDialogs();
  const current = h.context.loadClientDialogs();
  h.requests[1].resolve([{ id: 'new' }]);
  await current;
  h.requests[0].resolve([{ id: 'old' }]);
  await old;
  assert.equal(h.state.clientDialogs[0].id, 'new');
  assert.equal(h.renders, 1);
});

test('archive switches use a separate Telegram folder and discard stale main-list results', async () => {
  const h = createHarness();
  const main = h.context.loadClientDialogs();
  assert.match(h.requests[0].url, /folderId=0/);
  h.state.clientDialogFilter = 'archived';
  const archived = h.context.loadClientDialogs();
  assert.match(h.requests[1].url, /folderId=1/);
  h.requests[1].resolve([{ id: 9, archived: true }]); await archived;
  h.requests[0].resolve([{ id: 8 }]); await main;
  assert.equal(h.state.clientDialogs[0].id, 9);
});

test('late dialog results cannot overwrite the selected account', async () => {
  const h = createHarness();
  const old = h.context.loadClientDialogs();
  h.state.clientSelectedInstance = 'b';
  const current = h.context.loadClientDialogs();
  h.requests[1].resolve([{ id: 'account-b' }]);
  await current;
  h.requests[0].resolve([{ id: 'account-a' }]);
  await old;
  assert.equal(h.state.clientDialogs[0].id, 'account-b');
  assert.equal(h.renders, 1);
});

test('a stale dialog request failure does not hide the current account', async () => {
  const h = createHarness();
  const old = h.context.loadClientDialogs();
  h.state.clientSelectedInstance = 'b';
  const current = h.context.loadClientDialogs();
  h.requests[1].resolve([{ id: 'account-b' }]);
  await current;
  h.container.innerHTML = 'current dialogs';
  h.requests[0].reject(new Error('stale failure'));
  await old;
  assert.equal(h.container.innerHTML, 'current dialogs');
});

test('dialog loader merges events and releases snapshots after completion or failure', async () => {
  const h = createHarness();
  const open = new Set();
  h.context.window.chatWs = {
    isConnected: () => false,
    beginDialogSnapshot: instId => { const snapshot = { instId }; open.add(snapshot); return snapshot; },
    finishDialogSnapshot: (snapshot, dialogs) => {
      open.delete(snapshot);
      return dialogs?.map(dialog => ({ ...dialog, lastMessage: 'live' }));
    },
  };
  const first = h.context.loadClientDialogs();
  h.requests[0].resolve([{ id: '1', lastMessage: 'stale' }]);
  await first;
  assert.equal(h.state.clientDialogs[0].lastMessage, 'live');
  assert.equal(open.size, 0);
  const second = h.context.loadClientDialogs();
  h.requests[1].reject(new Error('unavailable'));
  await second;
  assert.equal(open.size, 0);
});

const page = (start) => Array.from({ length: 50 }, (_, i) => ({ id: start + i, lastMessageId: 100 + i, lastMessageDate: 1000000 - i * 1000 }));

test('custom folders page main and archive independently, deduplicating across both', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  let pending = h.context.loadClientDialogs();
  assert.match(h.requests[0].url, /folderId=0/);
  h.requests[0].resolve(page(1)); await pending;
  pending = h.context.loadClientDialogs(true);
  assert.match(h.requests[1].url, /folderId=0/);
  assert.match(h.requests[1].url, /offsetPeer=50/);
  h.requests[1].resolve([]); await pending;
  assert.equal(h.context.folderScan().stage, 1);
  assert.equal(h.context.folderScan().hasMore, true);
  pending = h.context.loadClientDialogs(true);
  assert.match(h.requests[2].url, /folderId=1/);
  assert.doesNotMatch(h.requests[2].url, /offsetPeer/);
  h.requests[2].resolve([{ id: 1, archived: true }, { id: 90, archived: true }]); await pending;
  assert.equal(h.state.clientDialogs.length, 51);
  assert.equal(h.state.clientDialogs.filter(d => d.id === 1).length, 1);
  assert.equal(h.state.clientDialogs.at(-1).id, 90);
  assert.equal(h.context.folderScan().hasMore, false);
});

test('custom folder loads explicit peers without changing the Telegram page cursor', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  h.context.window.DialogFolders = { getExplicitPeerIds: () => [120], apply: (_filter, dialogs) => dialogs };
  const pending = h.context.loadClientDialogs();
  h.requests[0].resolve(page(1));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.requests[1].url, /account\/dialogs\/explicit\?peerIds=120/);
  h.requests[1].resolve([{ id: 120, type: 'private', title: 'No history yet', unreadCount: 0 }]);
  await pending;
  assert.equal(h.state.clientDialogs.length, 51);
  assert.equal(h.state.clientDialogs.at(-1).id, 120);
  assert.equal(h.context.folderScan().hasMore, true);
  const next = h.context.loadClientDialogs(true);
  assert.match(h.requests[2].url, /folderId=0/);
  assert.match(h.requests[2].url, /offsetPeer=50/);
  h.requests[2].resolve([]);
  await next;
});

test('an inaccessible explicit peer does not hide the successfully loaded folder page', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  h.context.window.DialogFolders = { getExplicitPeerIds: () => [120], apply: (_filter, dialogs) => dialogs };
  const pending = h.context.loadClientDialogs();
  h.requests[0].resolve([{ id: 1, lastMessageId: 10, lastMessageDate: 1000 }]);
  await new Promise(resolve => setImmediate(resolve));
  h.requests[1].reject(new Error('peer unavailable'));
  await pending;
  assert.equal(h.state.clientDialogs[0].id, 1);
  assert.equal(h.context.folderScan().explicitIncomplete, true);
});

test('custom archive page can be retried after a network failure', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  let pending = h.context.loadClientDialogs(); h.requests[0].resolve([{ id: 1 }]); await pending;
  h.context.showToast = () => {};
  pending = h.context.loadClientDialogs(true); h.requests[1].reject(new Error('offline')); await pending;
  assert.equal(h.state.clientDialogs[0].id, 1);
  pending = h.context.loadClientDialogs(true);
  assert.match(h.requests[2].url, /folderId=1/);
  h.requests[2].resolve([{id:2,archived:true}]); await pending;
  assert.deepEqual(Array.from(h.state.clientDialogs, d => d.id), [1, 2]);
});

test('invalid or repeated cursor reports incomplete folder rather than skipping pages', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  let pending = h.context.loadClientDialogs(); h.requests[0].resolve(page(1)); await pending;
  pending = h.context.loadClientDialogs(true); h.requests[1].resolve(page(1)); await pending;
  assert.equal(h.context.folderScan().incomplete, true);
  assert.equal(h.context.folderScan().hasMore, false);
  await h.context.loadClientDialogs(true);
  assert.equal(h.requests.length, 2);
});

test('old custom folder pages cannot enter another account or folder', async () => {
  const h = createHarness(); h.state.clientDialogFilter = 'folder:1';
  let pending = h.context.loadClientDialogs(); h.requests[0].resolve(page(1)); await pending;
  const old = h.context.loadClientDialogs(true);
  h.state.clientSelectedInstance = 'b'; h.state.clientDialogFilter = 'folder:2';
  const current = h.context.loadClientDialogs();
  h.requests[2].resolve([{id:200}]); await current;
  h.requests[1].resolve([{id:99}]); await old;
  assert.deepEqual(Array.from(h.state.clientDialogs, d => d.id), [200]);
});

test('dialog pagination uses the raw page cursor and deduplicates the next page', async () => {
  const h = createHarness();
  const first = h.context.loadClientDialogs();
  h.requests[0].resolve(page(1)); await first;
  // A live event may reorder the UI; pagination must use the server page cursor.
  h.state.clientDialogs.unshift(h.state.clientDialogs.pop());
  const next = h.context.loadClientDialogs(true);
  assert.match(h.requests[1].url, /offsetPeer=50/);
  assert.match(h.requests[1].url, /offsetId=149/);
  h.requests[1].resolve([{ id: 50 }, { id: 51 }, { id: 52 }]); await next;
  assert.equal(h.state.clientDialogs.length, 52);
  assert.equal(h.state.clientDialogs.filter(d => d.id === 50).length, 1);
  await h.context.loadClientDialogs(true);
  assert.equal(h.requests.length, 2);
});

test('only one page request runs and old pages cannot contaminate another account', async () => {
  const h = createHarness();
  const first = h.context.loadClientDialogs();
  h.requests[0].resolve(page(1)); await first;
  const old = h.context.loadClientDialogs(true);
  await h.context.loadClientDialogs(true);
  assert.equal(h.requests.length, 2);
  h.state.clientSelectedInstance = 'b';
  const current = h.context.loadClientDialogs();
  h.requests[2].resolve([{ id: 'account-b' }]); await current;
  h.requests[1].resolve([{ id: 'old-page' }]); await old;
  assert.equal(h.state.clientDialogs.length, 1);
  assert.equal(h.state.clientDialogs[0].id, 'account-b');
});

test('a failed later page can be retried without losing the visible list', async () => {
  const h = createHarness();
  h.context.showToast = () => {};
  const first = h.context.loadClientDialogs();
  h.requests[0].resolve(page(1)); await first;
  const failed = h.context.loadClientDialogs(true);
  h.requests[1].reject(new Error('temporary')); await failed;
  assert.equal(h.state.clientDialogs.length, 50);
  const retry = h.context.loadClientDialogs(true);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve([{ id: 51 }]); await retry;
  assert.equal(h.state.clientDialogs.length, 51);
});

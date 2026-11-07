'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

const filters = {
  photos: 'InputMessagesFilterPhotos', videos: 'InputMessagesFilterVideo', files: 'InputMessagesFilterDocument',
  links: 'InputMessagesFilterUrl', music: 'InputMessagesFilterMusic', voice: 'InputMessagesFilterVoice',
  'round-video': 'InputMessagesFilterRoundVideo', 'round-voice': 'InputMessagesFilterRoundVoice',
  geo: 'InputMessagesFilterGeo', calls: 'InputMessagesFilterPhoneCalls',
};

test('chat search maps Telegram media filters to their MTProto constructors', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const received = [];
  driver.resolvePeer = chatId => chatId;
  driver.client = { getMessages: async (_peer, options) => { received.push(options); return []; } };
  for (const [filter, className] of Object.entries(filters)) {
    await driver.getMessages(42, { search: 'invoice', searchFilter: filter });
    assert.equal(received.at(-1).search, 'invoice');
    assert.equal(received.at(-1).filter.className, className);
  }
  assert.equal(received.at(-1).filter.missed, undefined);
  await driver.getMessages(42, { search: 'invoice' });
  assert.equal(received.at(-1).filter, undefined);
  await driver.getMessages(42, { search: 'invoice', searchFilter: 'photos', offsetId: 61 });
  assert.equal(received.at(-1).offsetId, 61);
});

test('HTTP message search accepts only known Telegram filters and forwards them', async t => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return [];
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(() => {
    if (!res.headersSent) { res.statusCode = 500; res.end(); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/messages?chatId=42&search=invoice`;
  let response = await fetch(`${base}&searchFilter=round-video&offsetId=61`);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { action: 'get_messages', payload: {
    chatId: 42, limit: 40, offsetId: 61, offsetDate: undefined, search: 'invoice', searchFilter: 'round-video',
  } });
  response = await fetch(`${base}&searchFilter=admin`);
  assert.equal(response.status, 400);
  response = await fetch(`${base}&offsetId=-1`);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
});

test('chat search sends a type filter through WebSocket and discards responses after switching chat', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function executeChatServerSearch(query)');
  const end = source.indexOf('\nfunction navigateSearchMatch', start);
  assert.ok(start >= 0 && end > start);
  let request, finish;
  const ids = { 'chat-search-filter': { value: 'photos' }, 'chat-search-stats': { style: {} },
    'btn-chat-search-prev': { style: {} }, 'btn-chat-search-next': { style: {} } };
  const state = { clientActiveChatId: 42, clientSelectedInstance: 'a', clientSearchQuery: 'invoice', clientMessages: [], searchMatchIds: [], searchMatchIdx: -1 };
  const window = { chatWs: { isConnected: () => true, sendRpc: (action, payload) => {
    request = { action, payload }; return new Promise(resolve => { finish = resolve; });
  } } };
  const context = vm.createContext({ state, window, document: { getElementById: id => ids[id] || null },
    renderClientMessages() {}, scrollToMessage() {}, showToast() {}, api: async () => { throw Error('unexpected HTTP fallback'); } });
  vm.runInContext(`let clientSearchRequest=0;\n${source.slice(start, end)}\nthis.search=executeChatServerSearch;`, context);
  const pending = context.search('invoice');
  assert.equal(request.action, 'get_messages');
  assert.equal(request.payload.searchFilter, 'photos');
  state.clientActiveChatId = 99;
  finish([{ id: 7 }]);
  await pending;
  assert.deepEqual(Array.from(state.clientMessages), []);
  assert.deepEqual(Array.from(state.searchMatchIds), []);
});

test('chat search loads older matches when the user moves past the newest page', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let clientSearchRequest = 0;');
  const navigation = source.indexOf('function navigateSearchMatch(direction)', start);
  const end = source.indexOf('\nfunction enterSelectionMode', navigation);
  assert.ok(start >= 0 && navigation > start && end > navigation);
  const calls = [], scrolled = [];
  const ids = { 'chat-search-input': { value: 'invoice' }, 'chat-search-filter': { value: 'files' },
    'chat-search-stats': { style: {} }, 'btn-chat-search-prev': { style: {} }, 'btn-chat-search-next': { style: {} } };
  const state = { clientActiveChatId: 42, clientSelectedInstance: 'a', clientSearchQuery: 'invoice', clientMessages: [], searchMatchIds: [], searchMatchIdx: -1 };
  const window = { chatWs: { isConnected: () => true, sendRpc: (action, payload) => {
    let resolve; const promise = new Promise(r => { resolve = r; }); calls.push({ action, payload, resolve }); return promise;
  } } };
  const context = vm.createContext({ state, window, document: { getElementById: id => ids[id] || null },
    renderClientMessages() {}, scrollToMessage: id => scrolled.push(id), showToast() {}, api: async () => { throw Error('unexpected HTTP fallback'); } });
  vm.runInContext(`${source.slice(start, end)}\nthis.search=executeChatServerSearch; this.next=navigateSearchMatch; this.hasMore=()=>clientSearchHasMore;`, context);
  const initial = context.search('invoice');
  calls[0].resolve(Array.from({ length: 60 }, (_, index) => ({ id: 120 - index })));
  await initial;
  assert.equal(context.hasMore(), true);
  assert.equal(state.searchMatchIds.length, 60);
  context.next('next');
  assert.equal(calls[1].payload.offsetId, 61);
  assert.equal(calls[1].payload.searchFilter, 'files');
  calls[1].resolve(Array.from({ length: 60 }, (_, index) => ({ id: 60 - index })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.searchMatchIds.length, 120);
  assert.equal(state.searchMatchIdx, 60);
  assert.equal(scrolled.at(-1), 60);
  for (let index = 0; index < 59; index++) context.next('next');
  context.next('next');
  assert.equal(calls[2].payload.offsetId, 1);
  calls[2].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.hasMore(), false);
});

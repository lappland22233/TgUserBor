'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function makeHarness(sendRpc) {
  const app = fs.readFileSync(require.resolve('../src/gui/web/app.js'), 'utf8');
  const start = app.indexOf('function initJumpToDate()');
  const end = app.indexOf('// Scheduled Messages Controller', start);
  const helpersStart = app.indexOf('function isAlbumMediaMessage(');
  const helpersEnd = app.indexOf('async function loadClientMessages(', helpersStart);
  if (start < 0 || end < 0 || helpersStart < 0 || helpersEnd < 0) throw new Error('date jump functions not found');
  const input = { value: '' };
  const elements = {
    'btn-chat-search-calendar': {}, 'modal-jump-date': { style: {} },
    'btn-jump-date-close': {}, 'btn-jump-date-cancel': {},
    'btn-jump-date-confirm': {}, 'jump-date-input': input,
  };
  const state = { clientActiveChatId: 12, clientSelectedInstance: 'a', clientMessages: [] };
  const notices = [];
  const ws = { isConnected: () => true, sendRpc, beginMessageSnapshot: () => ({}), finishMessageSnapshot: (_, messages) => messages };
  const context = vm.createContext({ state, window: { chatWs: ws }, URLSearchParams, document: { getElementById: id => elements[id] || null, querySelectorAll: () => [] },
    showToast: msg => notices.push(msg), renderClientMessages: () => {}, updateClientHistoryBanner: () => {}, api: async () => { throw Error('unexpected HTTP fallback'); } });
  vm.runInContext(`let clientMessagesRequest = 0; let isLoadingEarlierMessages = false; let hasReachedEarliestMessage = false;
  function isCurrentMessagesRequest(request, instId, chatId) { return request === clientMessagesRequest && state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId); }\n${app.slice(helpersStart,helpersEnd)}\n${app.slice(start,end)}\nthis.initJumpToDate=initJumpToDate; this.loadClientMessagesWithDate=loadClientMessagesWithDate;`, context);
  context.initJumpToDate();
  return { context, elements, input, state, notices };
}

test('date selection requests all of the selected local day and displays results oldest first', async () => {
  let request;
  const h = makeHarness(async (action, params) => { request = { action, params }; return [{ id: 2 }, { id: 1 }]; });
  h.input.value = '2024-03-10';
  await h.elements['btn-jump-date-confirm'].onclick();
  assert.equal(request.action, 'get_messages');
  assert.equal(request.params.offsetDate, Math.floor(new Date(2024, 2, 11).getTime() / 1000));
  assert.deepEqual(Array.from(h.state.clientMessages, x => x.id), [1, 2]);
  assert.equal(h.state.clientHistoryOffsetDate, request.params.offsetDate);
});

test('late date results cannot overwrite the newly selected account or chat', async () => {
  let resolve;
  const h = makeHarness(() => new Promise(r => { resolve = r; }));
  const old = h.context.loadClientMessagesWithDate(12, 1700000000);
  h.state.clientSelectedInstance = 'b';
  h.state.clientMessages = [{ id: 99 }];
  resolve([{ id: 1 }]);
  await old;
  assert.equal(h.state.clientMessages[0].id, 99);
  assert.equal(h.notices.length, 0);
});

test('HTTP history endpoint forwards the date cursor in Unix seconds', async () => {
  let received, status, body;
  const manager = { getInstance: () => ({ accountAction: async (action, params) => { received = { action, params }; return []; } }) };
  const req = { url: '/api/instances/a/account/messages?chatId=12&offsetDate=1700000000&limit=40', method: 'GET', headers: {} };
  const res = { writeHead: code => { status = code; }, end: value => { body = value; } };
  assert.equal(await handleApiRoute(req, res, manager, ''), true);
  assert.equal(status, 200);
  assert.equal(received.action, 'get_messages');
  assert.equal(received.params.offsetDate, 1700000000);
  assert.deepEqual(JSON.parse(body), []);
});

test('Telegram driver forwards the date cursor to GramJS', async () => {
  let received;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { getMessages: async (peer, options) => { received = options; return []; } };
  await driver.getMessages(12, { offsetDate: 1700000000, limit: 40 });
  assert.equal(received.offsetDate, 1700000000);
  assert.equal(received.limit, 40);
});

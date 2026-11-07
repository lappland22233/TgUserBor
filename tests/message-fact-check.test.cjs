'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const { handleApiRoute } = require('../dist/gui/api');

test('fact-check HTTP route validates message targets and returns Telegram annotations', async () => {
  const calls = [];
  const annotations = [{ needCheck: false, country: 'US', text: 'Verified' }];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params }); return annotations;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/message-fact-check`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 1, messageId: 0 })).status, 400);
    const response = await post({ chatId: -10042, messageId: 52 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), annotations);
    assert.deepEqual(calls, [{ action: 'get_message_fact_checks', params: { chatId: -10042, messageId: 52 } }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('fact-check detail loading is lazy, scoped to the original chat, and safe after a switch', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function loadMessageFactCheck(');
  const end = source.indexOf('\n// A staged file remains visible', start);
  const code = source.slice(start, end);
  const message = { id: 5, factChecks: [{ needCheck: true }] };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 2, chatSelectionVersion: 1, clientMessages: [message] };
  const calls = [];
  let resolve;
  const response = new Promise(done => { resolve = done; });
  let renders = 0;
  const context = vm.createContext({ state, encodeURIComponent, api: (url, method, body) => {
    calls.push({ url, method, body }); return response;
  }, renderClientMessages: () => { renders++; }, showToast() {} });
  vm.runInContext(`${code}\nthis.loadMessageFactCheck = loadMessageFactCheck;`, context);
  const pending = context.loadMessageFactCheck(5);
  assert.equal(message.factCheckLoading, true);
  assert.equal(JSON.stringify(calls), JSON.stringify([{
    url: '/api/instances/a/account/message-fact-check', method: 'POST', body: { chatId: 2, messageId: 5 },
  }]));
  state.clientSelectedInstance = 'b';
  state.clientActiveChatId = 3;
  state.chatSelectionVersion++;
  resolve([{ needCheck: false, text: 'Verified' }]);
  await pending;
  assert.equal(message.factCheckLoading, false);
  assert.equal(message.factCheckLoaded, undefined);
  assert.equal(renders, 1);
});

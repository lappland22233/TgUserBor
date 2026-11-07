'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleApiRoute } = require('../dist/gui/api');

test('reply keyboard sensitive requests validate coordinates and target the selected account', async t => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { messageId: 90 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(() => {
    if (!res.headersSent) { res.statusCode = 500; res.end(); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/bot-keyboard`;
  const common = { chatId: 7, messageId: 50, row: 1, column: 2 };
  let response = await fetch(`${base}/phone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(common) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, result: { messageId: 90 } });
  response = await fetch(`${base}/location`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...common, latitude: 91, longitude: 0 }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/location`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...common, latitude: 51.5, longitude: -0.12 }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { action: 'send_bot_keyboard_phone', payload: common },
    { action: 'send_bot_keyboard_location', payload: { ...common, latitude: 51.5, longitude: -0.12 } },
  ]);
});

test('reply keyboard state route validates the peer and reads only from the selected account', async t => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { latestMessageId: 20, complete: true };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(() => {
    if (!res.headersSent) { res.statusCode = 500; res.end(); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/reply-keyboard-state`;
  let response = await fetch(`${base}?chatId=0`);
  assert.equal(response.status, 400);
  response = await fetch(`${base}?chatId=-100123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { latestMessageId: 20, complete: true });
  assert.deepEqual(calls, [{ action: 'get_reply_keyboard_state', payload: { chatId: -100123 } }]);
});

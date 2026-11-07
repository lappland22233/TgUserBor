'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const http = require('node:http');

test('pinned messages use Telegram pinned filter and return a bounded history cursor', async () => {
  const peer = new Api.InputPeerChannel({ channelId: 1234567890n, accessHash: 1n });
  const raw = Array.from({ length: 30 }, (_, i) => new Api.Message({ id: 50 - i, date: 100 + i, message: `message ${i}` }));
  Object.defineProperty(raw, 'total', { value: 45 });
  let requested;
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => { assert.equal(id, -1001234567890); return peer; };
  driver.client = { getMessages: async (entity, options) => { requested = { entity, options }; return raw; } };
  driver.mapMessage = async message => ({ id: message.id, text: message.message, date: message.date * 1000 });

  const page = await driver.getPinnedMessages(-1001234567890, 30, 80);
  assert.equal(requested.entity, peer);
  assert.equal(requested.options.limit, 30);
  assert.equal(requested.options.offsetId, 80);
  assert.equal(requested.options.filter.className, 'InputMessagesFilterPinned');
  assert.equal(page.total, 45);
  assert.equal(page.nextOffsetId, 21);
  assert.equal(page.messages.length, 30);
  await assert.rejects(driver.getPinnedMessages(0), /Invalid pinned messages/);
  await assert.rejects(driver.getPinnedMessages(-1001234567890, 51), /Invalid pinned messages/);
});

test('pinned messages API validates pagination and dispatches to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? {
    accountAction: async (action, params) => { calls.push({ action, params }); return { messages: [], total: 0 }; },
  } : undefined };
  const server = http.createServer((req, res) => {
    handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/pinned-messages`;
    assert.equal((await fetch(`${base}?chatId=-100123&limit=20&offsetId=50`)).status, 200);
    assert.equal((await fetch(`${base}?chatId=0`)).status, 400);
    assert.equal((await fetch(`${base}?chatId=-100123&limit=51`)).status, 400);
    assert.equal((await fetch(`${base}?chatId=-100123&offsetId=-1`)).status, 400);
    assert.deepEqual(calls, [{ action: 'get_pinned_messages', params: { chatId: -100123, limit: 20, offsetId: 50 } }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

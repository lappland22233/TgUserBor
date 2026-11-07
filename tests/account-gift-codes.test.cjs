'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram Premium gift code preview maps safe redemption state and apply rechecks the current code', async () => {
  const calls = [];
  const available = () => new Api.payments.CheckedGiftCode({ viaGiveaway: true, fromId: new Api.PeerUser({ userId: bigInt(7) }),
    toId: bigInt(42), date: 1700000000, months: 6, chats: [], users: [] });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.CheckGiftCode) return available();
    return new Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
  } };
  const preview = await driver.checkAccountGiftCode('Gift_code-123');
  assert.deepEqual(preview, { slug: 'Gift_code-123', months: 6, date: 1700000000, viaGiveaway: true, recipientMatches: true });
  assert.ok(calls[0] instanceof Api.payments.CheckGiftCode);
  assert.equal(calls[0].slug, 'Gift_code-123');
  assert.deepEqual(await driver.applyAccountGiftCode('Gift_code-123'), { applied: true, months: 6 });
  assert.ok(calls[1] instanceof Api.payments.CheckGiftCode);
  assert.ok(calls[2] instanceof Api.payments.ApplyGiftCode);
  assert.equal(calls[2].slug, 'Gift_code-123');
  await assert.rejects(driver.checkAccountGiftCode('bad/slug'), /Invalid Telegram gift code/);
});

test('gift code activation refuses used links and links assigned to another account', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  let response = new Api.payments.CheckedGiftCode({ date: 1, months: 3, usedDate: 2, chats: [], users: [] });
  let applyCount = 0;
  driver.client = { invoke: async request => {
    if (request instanceof Api.payments.CheckGiftCode) return response;
    applyCount++;
    return new Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
  } };
  assert.deepEqual(await driver.checkAccountGiftCode('code_1234'), {
    slug: 'code_1234', months: 3, date: 1, usedDate: 2, viaGiveaway: false, recipientMatches: true,
  });
  await assert.rejects(driver.applyAccountGiftCode('code_1234'), /already been used|已被使用/);
  response = new Api.payments.CheckedGiftCode({ toId: bigInt(99), date: 1, months: 3, chats: [], users: [] });
  assert.equal((await driver.checkAccountGiftCode('code_1234')).recipientMatches, false);
  await assert.rejects(driver.applyAccountGiftCode('code_1234'), /belongs to another account|其他账号/);
  assert.equal(applyCount, 0);
});

test('gift code HTTP routes validate slugs and return only Telegram preview fields', async () => {
  const calls = [];
  const manager = { getInstance: () => ({ accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'check_account_gift_code') return { slug: payload.slug, months: 12, date: 1700000000,
      usedDate: undefined, viaGiveaway: false, recipientMatches: true, users: [{ phone: 'private' }] };
    if (action === 'apply_account_gift_code') return { applied: true, months: 12 };
  } }) };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/gift-codes`;
    const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('check', { slug: 'bad/slug' })).status, 400);
    const checked = await post('check', { slug: 'gift-code-1' });
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), { slug: 'gift-code-1', months: 12, date: 1700000000, viaGiveaway: false, recipientMatches: true });
    assert.equal((await post('apply', { slug: 'bad/slug' })).status, 400);
    const applied = await post('apply', { slug: 'gift-code-1' });
    assert.deepEqual(await applied.json(), { applied: true, months: 12 });
    assert.deepEqual(calls, [
      { action: 'check_account_gift_code', payload: { slug: 'gift-code-1' } },
      { action: 'apply_account_gift_code', payload: { slug: 'gift-code-1' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Telegram gift code service messages expose only a validated in-app gift action', async () => {
  const sender = new Api.User({ id: bigInt(7), firstName: 'Sender' });
  const message = new Api.Message({ id: 5, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: '' });
  message.action = new Api.MessageActionGiftCode({ slug: 'Gift_code-123', months: 6, unclaimed: true, viaGiveaway: true });
  message.getChat = async () => sender;
  message.getSender = async () => sender;
  const driver = Object.create(TelegramDriver.prototype);
  const mapped = await driver.mapMessage(message);
  assert.equal(mapped.service.type, 'gift_code');
  assert.match(mapped.service.text, /6 个月 Premium 礼物链接/);
  assert.deepEqual(mapped.service.giftCode, { slug: 'Gift_code-123', months: 6, unclaimed: true, viaGiveaway: true });

  message.action = new Api.MessageActionGiftCode({ slug: 'not/a/link', months: 6 });
  const invalid = await driver.mapMessage(message);
  assert.equal(invalid.service.giftCode, undefined);
});

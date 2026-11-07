'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('available Telegram message effects map only valid effect IDs and emoji labels', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const calls = [];
  driver.client = { invoke: async request => {
    calls.push(request);
    return new Api.messages.AvailableEffects({ hash: 1, effects: [
      new Api.AvailableEffect({ id: bigInt(123), emoticon: '🎉', effectStickerId: bigInt(1), staticIconId: bigInt(10) }),
      new Api.AvailableEffect({ id: bigInt(456), emoticon: '✨', effectStickerId: bigInt(2), premiumRequired: true }),
      new Api.AvailableEffect({ id: bigInt(0), emoticon: '🎈', effectStickerId: bigInt(3) }),
      new Api.AvailableEffect({ id: bigInt(789), emoticon: 'hello', effectStickerId: bigInt(4) }),
    ], documents: [] });
  } };
  assert.deepEqual(await driver.getMessageEffects(), [
    { id: '123', emoticon: '🎉', premium: false, staticIconId: '10' },
    { id: '456', emoticon: '✨', premium: true },
  ]);
  assert.ok(calls[0] instanceof Api.messages.GetAvailableEffects);
});

test('sending a text effect includes the Telegram effect ID with normal formatting, reply, schedule, and silent flags', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  const inputPeer = new Api.InputPeerSelf();
  driver.client = {
    getInputEntity: async peer => { assert.equal(peer, 7n); return inputPeer; },
    invoke: async request => { calls.push(request); return { updates: [] }; },
    _getResponseMessage: async (request, response, peer) => ({ id: 91, request, response, peer }),
    sendMessage: async () => { throw new Error('effect request must use native MTProto'); },
  };
  const id = await driver.sendMessage(7, '**Hello**', {
    parseMode: 'markdown', replyTo: 4, schedule: 1900000000, silent: true, effectId: '123',
  });
  assert.equal(id, 91);
  const request = calls[0];
  assert.ok(request instanceof Api.messages.SendMessage);
  assert.equal(String(request.effect), '123');
  assert.equal(request.replyTo.replyToMsgId, 4);
  assert.equal(request.scheduleDate, 1900000000);
  assert.equal(request.silent, true);
  assert.equal(request.message, 'Hello');
  assert.equal(request.entities[0].className, 'MessageEntityBold');
  assert.notEqual(String(request.randomId), '0');
  await assert.rejects(driver.sendMessage(7, 'text', { effectId: '0' }), /Invalid Telegram message effect/);
});

test('message effect endpoints expose account effects and reject malformed IDs before dispatch', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_message_effects' ? [{ id: '123', emoticon: '🎉', premium: false }] : { messageId: 1 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const effects = await fetch(`${base}/message-effects`);
    assert.equal(effects.status, 200);
    assert.deepEqual(await effects.json(), [{ id: '123', emoticon: '🎉', premium: false }]);
    const send = options => fetch(`${base}/send`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 7, text: 'hello', options }) });
    assert.equal((await send({ effectId: '0' })).status, 400);
    assert.equal((await send({ effectId: '123' })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_message_effects', payload: undefined },
      { action: 'send_message', payload: { chatId: 7, text: 'hello', options: { effectId: '123' } } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

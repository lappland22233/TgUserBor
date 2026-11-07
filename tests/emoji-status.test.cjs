'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('account Emoji status maps current status and Telegram default choices', async () => {
  const calls = [];
  const currentStatus = new Api.EmojiStatus({ documentId: bigInt(555), until: 1900000000 });
  const emoji = new Api.DocumentAttributeCustomEmoji({ alt: '🎉', stickerset: new Api.InputStickerSetEmpty({}) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfUser = { id: 42 };
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.users.GetFullUser) return { users: [new Api.User({ id: bigInt(42), self: true, emojiStatus: currentStatus })] };
    if (request instanceof Api.account.GetDefaultEmojiStatuses) return new Api.account.EmojiStatuses({ hash: bigInt(0), statuses: [
      new Api.EmojiStatus({ documentId: bigInt(123) }), new Api.EmojiStatus({ documentId: bigInt(456) }),
    ] });
    if (request instanceof Api.messages.GetCustomEmojiDocuments) return [new Api.Document({ id: bigInt(123), accessHash: bigInt(1),
      fileReference: Buffer.alloc(0), date: 1, mimeType: 'application/x-tgsticker', size: bigInt(1), dcId: 1, attributes: [emoji] })];
    throw new Error('unexpected RPC');
  } };
  assert.deepEqual(await driver.getAccountEmojiStatus(), {
    currentDocumentId: '555', until: 1900000000,
    options: [{ documentId: '123', emoji: '🎉' }, { documentId: '456', emoji: '' }],
  });
  assert.ok(calls[0] instanceof Api.users.GetFullUser);
  assert.ok(calls[1] instanceof Api.account.GetDefaultEmojiStatuses);
  assert.ok(calls[2] instanceof Api.messages.GetCustomEmojiDocuments);
});

test('Emoji status updates support expiry, permanent status, and clearing', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { calls.push(request); return true; } };
  const before = Math.floor(Date.now() / 1000);
  await driver.setAccountEmojiStatus('123', 3600);
  const temporary = calls.at(-1).emojiStatus;
  assert.ok(calls.at(-1) instanceof Api.account.UpdateEmojiStatus);
  assert.ok(temporary instanceof Api.EmojiStatus);
  assert.equal(String(temporary.documentId), '123');
  assert.ok(temporary.until >= before + 3600 && temporary.until <= before + 3601);

  await driver.setAccountEmojiStatus('123', 0);
  assert.equal(calls.at(-1).emojiStatus.until, undefined);
  await driver.setAccountEmojiStatus(null);
  assert.ok(calls.at(-1).emojiStatus instanceof Api.EmojiStatusEmpty);
  await assert.rejects(driver.setAccountEmojiStatus('0'), /Invalid Emoji status/);
  await assert.rejects(driver.setAccountEmojiStatus('123', 7200), /Invalid Emoji status/);
});

test('Emoji status HTTP route validates status IDs and expiry before targeting one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_account_emoji_status' ? { currentDocumentId: '123', options: [{ documentId: '123', emoji: '🎉' }] } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/emoji-status`;
    const read = await fetch(base);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { currentDocumentId: '123', options: [{ documentId: '123', emoji: '🎉' }] });
    const send = body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ documentId: '0', durationSeconds: 3600 })).status, 400);
    assert.equal((await send({ documentId: '123', durationSeconds: 7200 })).status, 400);
    assert.equal((await send({ documentId: '123', durationSeconds: 3600 })).status, 200);
    assert.equal((await send({ documentId: null })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_account_emoji_status', payload: undefined },
      { action: 'set_account_emoji_status', payload: { documentId: '123', durationSeconds: 3600 } },
      { action: 'set_account_emoji_status', payload: { documentId: null, durationSeconds: undefined } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

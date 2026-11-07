'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram sticker search trims queries, maps sendable documents and keeps the next offset', async () => {
  let request;
  const sticker = new Api.Document({
    id: bigInt(12345), accessHash: bigInt(67890), fileReference: Buffer.from('reference'),
    date: 1, mimeType: 'image/webp', size: bigInt(20), dcId: 2,
    attributes: [new Api.DocumentAttributeSticker({ alt: '🐈', stickerset: new Api.InputStickerSetShortName({ shortName: 'cats' }) })],
  });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async value => {
    request = value;
    return new Api.messages.FoundStickers({ hash: bigInt(0), nextOffset: 40, stickers: [sticker] });
  } };
  const page = await driver.searchStickers('  cats  ', 10, 30);
  assert.ok(request instanceof Api.messages.SearchStickers);
  assert.equal(request.q, 'cats');
  assert.equal(request.offset, 10);
  assert.equal(request.limit, 30);
  assert.deepEqual(page, { nextOffset: 40, stickers: [{
    id: '12345', accessHash: '67890', fileReference: Buffer.from('reference').toString('base64'),
    mimeType: 'image/webp', emoji: '🐈', width: undefined, height: undefined, thumbDataUri: undefined,
  }] });
  await assert.rejects(driver.searchStickers('   '), /Invalid Telegram sticker search/);
  await assert.rejects(driver.searchStickers('cat', -1), /Invalid Telegram sticker search/);
});

test('Telegram sticker search route validates pagination and targets only the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return { stickers: [{ id: '12' }], nextOffset: 40 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/sticker-search`;
    assert.equal((await fetch(`${base}?q=`)).status, 400);
    assert.equal((await fetch(`${base}?q=cats&offset=-1`)).status, 400);
    assert.equal((await fetch(`${base}?q=cats&limit=51`)).status, 400);
    const response = await fetch(`${base}?q=cats&offset=10&limit=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stickers: [{ id: '12' }], nextOffset: 40 });
    assert.deepEqual(calls, [{ action: 'search_stickers', payload: { query: 'cats', offset: 10, limit: 20 } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

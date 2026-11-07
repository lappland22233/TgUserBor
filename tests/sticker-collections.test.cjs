'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function stickerDoc(id, alt = '🙂') {
  return new Api.Document({
    id: bigInt(id), accessHash: bigInt(Number(id) + 100), fileReference: Buffer.from('ref'),
    date: 1, mimeType: 'image/webp', size: bigInt(10), dcId: 2,
    attributes: [new Api.DocumentAttributeSticker({ alt, stickerset: new Api.InputStickerSetEmpty() })],
    thumbs: [],
  });
}

test('Telegram sticker collections map favorites and recents and save sent stickers to recent use', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(1) });
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetFavedStickers') {
      return new Api.messages.FavedStickers({ hash: bigInt(1), packs: [], stickers: [stickerDoc(10, '⭐')] });
    }
    if (request.className === 'messages.GetRecentStickers') {
      return new Api.messages.RecentStickers({ hash: bigInt(1), packs: [], stickers: [stickerDoc(11, '✨')], dates: [100] });
    }
    return true;
  }, sendFile: async () => ({ id: 55 }) };
  const collections = await driver.getStickerCollections();
  assert.equal(collections.favorites[0].id, '10');
  assert.equal(collections.favorites[0].emoji, '⭐');
  assert.equal(collections.recent[0].id, '11');
  assert.equal(calls[0].className, 'messages.GetFavedStickers');
  assert.equal(calls[1].className, 'messages.GetRecentStickers');
  const messageId = await driver.sendStickerDocument(8, '10', '110', 'cmVm');
  assert.equal(messageId, 55);
  assert.equal(calls[2].className, 'messages.SaveRecentSticker');
  assert.equal(calls[2].id.id.toString(), '10');
  assert.equal(calls[2].unsave, false);
});

test('favoriting and unfavoriting send Telegram InputDocument references and reject malformed documents', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { calls.push(request); return true; } };
  await driver.setStickerFavorite('10', '110', 'cmVm', true);
  await driver.setStickerFavorite('10', '110', 'cmVm', false);
  assert.equal(calls[0].className, 'messages.FaveSticker');
  assert.equal(calls[0].id.className, 'InputDocument');
  assert.equal(calls[0].id.fileReference.toString(), 'ref');
  assert.equal(calls[0].unfave, false);
  assert.equal(calls[1].unfave, true);
  await assert.rejects(driver.setStickerFavorite('0', '110', '', true), /Invalid sticker favorite request/);
  await assert.rejects(driver.setStickerFavorite('10', '110', '', 'yes'), /Invalid sticker favorite request/);
  assert.equal(calls.length, 2);
});

test('sticker collection routes validate document fields and target the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return action === 'get_sticker_collections' ? { favorites: [], recent: [] } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    assert.deepEqual(await (await fetch(`${base}/sticker-collections`)).json(), { favorites: [], recent: [] });
    const post = body => fetch(`${base}/sticker-favorite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ docId: '0', accessHash: '100', fileReference: '', favorite: true })).status, 400);
    assert.equal((await post({ docId: '10', accessHash: '100', fileReference: 'cmVm', favorite: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_sticker_collections', payload: {} },
      { action: 'set_sticker_favorite', payload: { docId: '10', accessHash: '100', fileReference: 'cmVm', favorite: true } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('sticker tiles toggle Telegram favorites without confusing send and favorite clicks', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; this.title = ''; this.handlers = {}; this.attributes = {}; }
    appendChild(child) { this.children.push(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  const state = { clientSelectedInstance: 'a', clientStickerCollections: { favorites: [], recent: [] } };
  const calls = []; let rendered = 0;
  const context = vm.createContext({ state, document: { createElement: () => new Element() },
    encodeURIComponent, expressionAccountEpoch: 2,
    scheduler: { loadImage: () => {} }, sendSticker: () => { throw new Error('favorite click must not send'); },
    renderStickerStream: () => rendered++, showToast: () => {},
    api: async (url, method, body) => calls.push({ url, method, body }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function createStickerTile(');
  const end = source.indexOf('\nfunction renderStickerStream(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.makeTile = createStickerTile;`, context);
  const sticker = { id: '10', accessHash: '110', fileReference: 'cmVm', emoji: '⭐' };
  const tile = context.makeTile(sticker, 'a', new Set());
  tile.children[1].onclick({ preventDefault() {}, stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].url, '/api/instances/a/account/sticker-favorite');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { docId: '10', accessHash: '110', fileReference: 'cmVm', favorite: true });
  assert.equal(state.clientStickerCollections.favorites[0].id, '10');
  assert.equal(rendered, 1);
});

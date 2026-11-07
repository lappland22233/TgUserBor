'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('async function searchTelegramStickers(');
const end = source.indexOf('\nfunction renderStickerStream(', start);
if (start < 0 || end < 0) throw new Error('Telegram sticker search UI not found');

function setup(api) {
  const makeNode = () => ({
    children: [], dataset: {}, disabled: false, hidden: false, textContent: '', value: '', className: '',
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  const nodes = {
    'stickers-search-input': makeNode(), 'sticker-search-status': makeNode(),
    'sticker-search-results': makeNode(), 'btn-search-telegram-stickers': makeNode(),
  };
  const sent = [];
  const context = vm.createContext({
    state: { clientSelectedInstance: 'account-a' },
    expressionAccountEpoch: 1,
    stickerSearchRequest: 0,
    api,
    document: { getElementById: id => nodes[id], createElement: makeNode },
    scheduler: { loadImage: (image, url) => { image.src = url; } },
    sendSticker: sticker => sent.push(sticker),
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.searchTelegramStickers = searchTelegramStickers;`, context);
  nodes['stickers-search-input'].value = 'cats & dogs';
  return { context, nodes, sent };
}

test('Telegram sticker search renders sendable results and pagination', async () => {
  const sticker = { id: '12', accessHash: '34', fileReference: 'ref', emoji: '🐈', thumbDataUri: 'data:image/jpeg;base64,a' };
  let requested;
  const fixture = setup(async url => { requested = url; return { stickers: [sticker], nextOffset: 40 }; });
  await fixture.context.searchTelegramStickers();
  assert.match(requested, /\/api\/instances\/account-a\/account\/sticker-search\?q=cats%20%26%20dogs&offset=0&limit=40/);
  assert.equal(fixture.nodes['sticker-search-results'].children.length, 2);
  fixture.nodes['sticker-search-results'].children[0].onclick();
  assert.deepEqual(fixture.sent, [sticker]);
  assert.equal(fixture.nodes['btn-search-telegram-stickers'].disabled, false);
});

test('late Telegram sticker results are discarded after the account changes', async () => {
  let resolveSearch;
  const fixture = setup(() => new Promise(resolve => { resolveSearch = resolve; }));
  const pending = fixture.context.searchTelegramStickers();
  fixture.context.state.clientSelectedInstance = 'account-b';
  resolveSearch({ stickers: [{ id: '12', accessHash: '34', fileReference: '' }] });
  await pending;
  assert.equal(fixture.nodes['sticker-search-results'].children.length, 0);
});

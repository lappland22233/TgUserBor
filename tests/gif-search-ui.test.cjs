'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.attributes = {}; this._text = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text; }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get innerHTML() { return this._html || ''; }
}

test('GIF search pages target the active chat, render Telegram results, and ignore a late chat response', async () => {
  const input = new Element('input'); input.value = 'funny cat';
  const results = new Element(); const status = new Element(); const more = new Element('button');
  const elements = new Map([['gif-search-input', input], ['gif-search-results', results], ['gif-search-status', status], ['btn-more-gif-search', more]]);
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 1, clientGifs: [] };
  const calls = [];
  const context = vm.createContext({ state, document: { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) },
    URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
    showToast: () => {},
    api: (url, method) => { calls.push(url); return Promise.resolve(method === 'POST' ? { success: true } : { results: [{ token: 'g'.repeat(32), saveToken: 's'.repeat(32), title: 'Funny cat', id: '77', accessHash: '-88', fileReference: 'AQI=', mimeType: 'video/mp4' }], nextOffset: 'opaque-cursor' }); },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function queueClientGifSearch()');
  const end = source.indexOf('\nasync function sendGif(gif)', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`let expressionAccountEpoch = 1; let gifSearchRequest = 0; let gifSearchTimer; let gifSearchNextOffset = ''; let gifSearchHasMore = false;\n${source.slice(start, end)}\nthis.loadSearch = loadClientGifSearch;`, context);

  await context.loadSearch(true);
  assert.match(calls[0], /\/account\/gifs\/search\?/);
  assert.match(calls[0], /chatId=42/);
  assert.match(calls[0], /q=funny\+cat/);
  assert.equal(results.children.length, 1);
  assert.equal(results.children[0].children[0].tagName, 'video');
  assert.equal(results.children[0].children[0].muted, true);
  const save = results.children[0].children.find(child => child.className === 'gif-save-toggle');
  assert.ok(save);
  save.onclick({ stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(save.textContent, '✓');
  assert.equal(state.clientGifs.length, 1);
  assert.match(calls[1], /\/account\/gifs\/save-search-result$/);
  assert.equal(more.hidden, false);
  assert.match(status.textContent, /可继续加载/);

  await context.loadSearch(false);
  assert.match(calls[2], /offset=opaque-cursor/);
  assert.equal(results.children.length, 2);

  let resolveLate;
  context.api = () => new Promise(resolve => { resolveLate = resolve; });
  const pending = context.loadSearch(true);
  state.clientActiveChatId = 43; state.chatSelectionVersion++;
  resolveLate({ results: [{ token: 'z'.repeat(32), id: '88', accessHash: '99', mimeType: 'video/webm' }], nextOffset: '' });
  await pending;
  assert.equal(results.children.length, 0, 'results for the previous chat are discarded');
});

test('saved GIF cards remove the selected document from the account collection', async () => {
  const stream = new Element();
  const elements = new Map([['gifs-stream-container', stream]]);
  const state = { clientSelectedInstance: 'a', clientGifs: [{ id: '77', accessHash: '-88', fileReference: 'AQI=' }] };
  const calls = [];
  const context = vm.createContext({ state, document: { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) },
    encodeURIComponent, showToast: () => {},
    api: async (url, method, body) => { calls.push({ url, method, body }); return { success: true }; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function renderGifStream()');
  const end = source.indexOf('\nasync function sendGif(gif)', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`let expressionAccountEpoch = 1;\n${source.slice(start, end)}\nthis.render = renderGifStream;`, context);

  context.render();
  const card = stream.children[0];
  const remove = card.children.find(child => child.className === 'gif-save-toggle');
  assert.ok(remove);
  remove.onclick({ stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(calls), JSON.stringify([{ url: '/api/instances/a/account/gifs/remove-saved', method: 'POST',
    body: { docId: '77', accessHash: '-88', fileReference: 'AQI=' } }]));
  assert.equal(state.clientGifs.length, 0);
  assert.match(stream.innerHTML, /暂无收藏的 GIF/);
});

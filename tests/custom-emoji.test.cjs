'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('message mapping preserves Telegram custom emoji document IDs', async () => {
  const user = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  const message = new Api.Message({
    id: 5, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: '🙂',
    entities: [new Api.MessageEntityCustomEmoji({ offset: 0, length: 2, documentId: bigInt(12345) })],
    reactions: new Api.MessageReactions({ results: [new Api.ReactionCount({
      reaction: new Api.ReactionCustomEmoji({ documentId: bigInt(98765) }), count: 2, chosenOrder: 0,
    })] }),
  });
  message.getChat = async () => user;
  message.getSender = async () => user;
  const mapped = await Object.create(TelegramDriver.prototype).mapMessage(message);
  assert.deepEqual(mapped.entities, [{
    type: 'MessageEntityCustomEmoji', offset: 0, length: 2, url: undefined, userId: undefined, documentId: '12345',
  }]);
  assert.deepEqual(mapped.reactions, [{ emoji: '✨', customEmojiId: '98765', count: 2, chosen: true }]);
});

test('custom emoji search resolves Telegram documents and sends the matching custom entity', async () => {
  const requests = [], sent = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  const custom = new Api.DocumentAttributeCustomEmoji({ alt: '🙂', stickerset: new Api.InputStickerSetEmpty({}) });
  driver.client = {
    invoke: async request => {
      requests.push(request);
      if (request instanceof Api.messages.SearchCustomEmoji) return new Api.EmojiList({ hash: bigInt(0), documentId: [bigInt(12345)] });
      return [new Api.Document({ id: bigInt(12345), accessHash: bigInt(22), fileReference: Buffer.from('ref'),
        date: 1, mimeType: 'application/x-tgsticker', size: bigInt(10), dcId: 2, attributes: [custom] })];
    },
    sendMessage: async (peer, options) => { sent.push({ peer, options }); return { id: 71 }; },
  };
  assert.deepEqual(await driver.searchCustomEmoji('🙂'), [{ id: '12345', emoji: '🙂' }]);
  assert.ok(requests[0] instanceof Api.messages.SearchCustomEmoji);
  assert.equal(requests[0].emoticon, '🙂');
  assert.deepEqual(requests[1].documentId.map(String), ['12345']);
  assert.equal(await driver.sendCustomEmoji(42, '🙂', '12345'), 71);
  assert.equal(sent[0].peer, 42n);
  assert.equal(sent[0].options.message, '🙂');
  assert.ok(sent[0].options.formattingEntities[0] instanceof Api.MessageEntityCustomEmoji);
  assert.equal(sent[0].options.formattingEntities[0].length, 2);
  assert.equal(String(sent[0].options.formattingEntities[0].documentId), '12345');
  await assert.rejects(driver.searchCustomEmoji('hello'), /Invalid custom emoji search/);
  await assert.rejects(driver.sendCustomEmoji(42, '🙂', '0'), /Invalid custom emoji message/);
});

test('Emoji keyword search reads Telegram language packs once and combines Chinese and English matches', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.emojiKeywordIndexes = new Map();
  driver.emojiKeywordLoads = new Map();
  driver.emojiKeywordEpoch = 0;
  driver.logger = { debug: () => {} };
  const calls = [];
  driver.client = { invoke: async request => {
    calls.push(request);
    if (!(request instanceof Api.messages.GetEmojiKeywords)) throw new Error('unexpected RPC');
    const keywords = request.langCode === 'zh-hans'
      ? [new Api.EmojiKeyword({ keyword: '猫', emoticons: ['🐱'] })]
      : [new Api.EmojiKeyword({ keyword: 'cat face', emoticons: ['🐱', '😺'] })];
    return new Api.EmojiKeywordsDifference({ langCode: request.langCode, fromVersion: 0, version: 1, keywords });
  } };
  assert.deepEqual(await driver.searchEmojiKeywords('猫'), ['🐱']);
  assert.deepEqual(await driver.searchEmojiKeywords('cat'), ['🐱', '😺']);
  assert.equal(calls.length, 2, 'both Telegram language packs are cached for later searches');
  assert.deepEqual(calls.map(call => call.langCode).sort(), ['en-us', 'zh-hans']);
  await assert.rejects(driver.searchEmojiKeywords(''), /Invalid Emoji search/);
  await assert.rejects(driver.searchEmojiKeywords('x'.repeat(65)), /Invalid Emoji search/);
});

test('Emoji picker groups use Telegram category titles and retain only valid Unicode emoji', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.emojiKeywordEpoch = 0;
  driver.emojiGroupsCache = undefined;
  driver.emojiGroupsLoad = undefined;
  let calls = 0;
  driver.client = { invoke: async request => {
    calls++;
    assert.ok(request instanceof Api.messages.GetEmojiGroups);
    return new Api.messages.EmojiGroups({ hash: 7, groups: [
      new Api.EmojiGroup({ title: '动物与自然', iconEmojiId: bigInt(12), emoticons: ['🐈', '🦊', 'not emoji'] }),
      new Api.EmojiGroupGreeting({ title: '问候', iconEmojiId: bigInt(13), emoticons: ['👋'] }),
      new Api.EmojiGroupPremium({ title: 'Premium', iconEmojiId: bigInt(14) }),
    ] });
  } };
  assert.deepEqual(await driver.getEmojiGroups(), [
    { title: '动物与自然', emoticons: ['🐈', '🦊'] },
    { title: '问候', emoticons: ['👋'] },
  ]);
  await driver.getEmojiGroups();
  assert.equal(calls, 1, 'Telegram emoji groups are cached per driver');
});

test('custom emoji previews use Telegram documents and an account-isolated cache', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.config = { telegram: { sessionPath: path.join(os.tmpdir(), 'custom-emoji-test.session') } };
  let requested;
  driver.client = {
    invoke: async request => {
      requested = request;
      return [new Api.Document({ id: bigInt(987654321), accessHash: bigInt(12), fileReference: Buffer.from('ref'),
        date: 1, mimeType: 'image/webp', size: bigInt(4), dcId: 2, attributes: [] })];
    },
    downloadMedia: async (_document, options) => options.outputFile.write(Buffer.from('webp')),
  };
  const preview = await driver.downloadCustomEmojiPreview('987654321');
  try {
    assert.ok(requested instanceof Api.messages.GetCustomEmojiDocuments);
    assert.deepEqual(requested.documentId.map(String), ['987654321']);
    assert.equal(preview.mimeType, 'image/webp');
    assert.match(path.basename(preview.filePath), /987654321\.webp$/);
    assert.equal(await fsp.readFile(preview.filePath, 'utf8'), 'webp');
    await assert.rejects(driver.downloadCustomEmojiPreview('../invalid'), /Invalid/);
  } finally {
    if (preview?.filePath) await fsp.rm(preview.filePath, { force: true });
  }
});

test('custom emoji preview route validates document IDs and streams private image content', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'custom-emoji-route-'));
  const filePath = path.join(root, 'preview.webp');
  await fsp.writeFile(filePath, Buffer.from('webp-data'));
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return { filePath, mimeType: 'image/webp' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/custom-emoji`;
    assert.equal((await fetch(`${base}?documentId=0`)).status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(`${base}?documentId=12345`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'webp-data');
    assert.deepEqual(calls, [{ action: 'get_custom_emoji_preview', payload: { documentId: '12345' } }]);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('custom emoji search and send routes validate input and dispatch to the selected Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'search_custom_emoji') return [{ id: '12345', emoji: '🙂' }];
    if (action === 'search_emoji_keywords') return ['🐱'];
    if (action === 'get_emoji_groups') return [{ title: '动物与自然', emoticons: ['🐱'] }];
    return { messageId: 71 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const search = `http://127.0.0.1:${server.address().port}/api/instances/a/account/custom-emoji-search`;
    assert.equal((await fetch(`${search}?emoticon=hello`)).status, 400);
    const results = await fetch(`${search}?emoticon=${encodeURIComponent('🙂')}`);
    assert.equal(results.status, 200);
    assert.deepEqual(await results.json(), [{ id: '12345', emoji: '🙂' }]);
    const keywordSearch = `http://127.0.0.1:${server.address().port}/api/instances/a/account/emoji-search`;
    assert.equal((await fetch(`${keywordSearch}?q=`)).status, 400);
    const keywordResults = await fetch(`${keywordSearch}?q=${encodeURIComponent('cat')}`);
    assert.equal(keywordResults.status, 200);
    assert.deepEqual(await keywordResults.json(), ['🐱']);
    const groupsUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/emoji-groups`;
    const groups = await fetch(groupsUrl);
    assert.equal(groups.status, 200);
    assert.deepEqual(await groups.json(), [{ title: '动物与自然', emoticons: ['🐱'] }]);
    const send = `http://127.0.0.1:${server.address().port}/api/instances/a/account/send-custom-emoji`;
    const post = body => fetch(send, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 42, emoticon: '🙂', documentId: '0' })).status, 400);
    const accepted = await post({ chatId: 42, emoticon: '🙂', documentId: '12345' });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { success: true, messageId: 71 });
    assert.deepEqual(calls, [
      { action: 'search_custom_emoji', payload: { emoticon: '🙂' } },
      { action: 'search_emoji_keywords', payload: { query: 'cat' } },
      { action: 'get_emoji_groups', payload: {} },
      { action: 'send_custom_emoji', payload: { chatId: 42, emoticon: '🙂', documentId: '12345' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Emoji keyword search renders Telegram matches and discards an old-account response', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let customEmojiSearchRequest = 0;');
  const end = source.indexOf('\nasync function searchCustomEmoji()', start);
  assert.ok(start >= 0 && end > start);
  class Node {
    constructor() { this.children = []; this.value = ''; this.hidden = true; this.textContent = ''; this.attributes = {}; }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); return item; }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  const input = new Node(); input.value = 'cat';
  const categoryBar = new Node(), results = new Node(), status = new Node();
  const nodes = { 'emoji-search-input': input, 'emoji-category-bar': categoryBar, 'emoji-grid': results, 'emoji-keyword-search-status': status };
  const state = { clientSelectedInstance: 'a' }, calls = [];
  const context = vm.createContext({ state, document: { getElementById: id => nodes[id] || null, querySelector: () => null, createElement: () => new Node() },
    encodeURIComponent, setTimeout, clearTimeout, getEmojiSvgUrl: value => `emoji:${value}`, insertEmoji: () => {},
    api: url => new Promise(resolve => calls.push({ url, resolve })),
  });
  vm.runInContext(`let expressionAccountEpoch = 1;\n${source.slice(start, end)}\nthis.update = updateEmojiPickerSearch;`, context);
  context.update('cat');
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal(calls[0].url, '/api/instances/a/account/emoji-search?q=cat');
  assert.equal(categoryBar.hidden, true);
  calls[0].resolve(['🐱', '😺']); await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.children.length, 2);
  assert.equal(results.children[0].children[0].src, 'emoji:🐱');
  assert.equal(status.textContent, '2 个 Emoji');

  input.value = 'dog'; context.update('dog');
  await new Promise(resolve => setTimeout(resolve, 210));
  state.clientSelectedInstance = 'b';
  calls[1].resolve(['🐶']); await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.children.length, 0, 'old-account results are discarded');
});

test('recently selected Emoji stay local and are isolated by Telegram instance', () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('function recentEmojiStorageKey()');
  const end = source.indexOf('\nfunction insertEmoji(emoji)', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'alice' }, records = new Map();
  const context = vm.createContext({ state,
    document: { querySelector: () => null },
    localStorage: { getItem: key => records.get(key) || null, setItem: (key, value) => records.set(key, value) },
    encodeURIComponent, isSingleEmojiQuery: value => typeof value === 'string' && /\p{Extended_Pictographic}/u.test(value),
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.get = getRecentEmoji; this.record = recordRecentEmoji;`, context);
  context.record('🐱'); context.record('😀'); context.record('🐱');
  assert.equal(JSON.stringify(context.get()), JSON.stringify(['🐱', '😀']));
  state.clientSelectedInstance = 'bob';
  assert.equal(context.get().length, 0);
  context.record('🐶');
  assert.equal(JSON.stringify(context.get()), JSON.stringify(['🐶']));
  state.clientSelectedInstance = 'alice';
  assert.equal(JSON.stringify(context.get()), JSON.stringify(['🐱', '😀']));
});

test('emoji picker renders Telegram localized groups and all group emoji', () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('function renderEmojiPicker(');
  const end = source.indexOf('\nfunction recentEmojiStorageKey()', start);
  assert.ok(start >= 0 && end > start);
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.classList = { add() {}, remove() {} }; }
    set innerHTML(value) { this._html = String(value); this.children = []; }
    get innerHTML() { return this._html || ''; }
    appendChild(item) { this.children.push(item); return item; }
  }
  const categoryBar = new Node(), grid = new Node();
  const groups = [{ id: 'recent', icon: '🕒', name: '最近使用', emoticons: [] },
    { id: 'telegram-0', icon: '🐈', name: '动物与自然', emoticons: ['🐈', '🦊'] }];
  const context = vm.createContext({
    document: { getElementById: id => id === 'emoji-category-bar' ? categoryBar : id === 'emoji-grid' ? grid : null,
      querySelectorAll: () => [], createElement: () => new Node() },
    getEmojiPickerGroups: () => groups, getEmojiSvgUrl: emoji => `emoji:${emoji}`,
    updateEmojiPickerSearch: () => {}, insertEmoji: () => {},
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.render = renderEmojiPicker;`, context);
  context.render('telegram-0');
  assert.equal(categoryBar.children.length, 2);
  assert.equal(categoryBar.children[1].title, '动物与自然');
  assert.equal(grid.children.length, 2);
  assert.equal(grid.children[0].title, '🐈');
});

test('custom emoji picker sends a result only to the account and chat that loaded it', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let customEmojiSearchRequest = 0;');
  const end = source.indexOf('\nfunction renderEmojiPicker(', start);
  assert.ok(start >= 0 && end > start);
  class Node {
    constructor() { this.children = []; this.value = ''; this.disabled = false; this.hidden = true; this.textContent = ''; }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); return item; }
    append(...items) { this.children.push(...items); }
    setAttribute() {}
  }
  const input = new Node(); input.value = '🙂';
  const results = new Node(), status = new Node();
  const nodes = { 'emoji-search-input': input, 'custom-emoji-search-results': results, 'custom-emoji-search-status': status };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 5 };
  const calls = [], toasts = [], toggles = [];
  const context = vm.createContext({ state, document: { getElementById: id => nodes[id] || null, createElement: () => new Node() },
    encodeURIComponent, api: (url, method, body) => new Promise(resolve => calls.push({ url, method, body, resolve })),
    toggleExpressionDrawer: open => toggles.push(open), showToast: (...args) => toasts.push(args), });
  vm.runInContext(`${source.slice(start, end)}\nthis.search = searchCustomEmoji;`, context);
  const pending = context.search();
  assert.equal(calls[0].url, '/api/instances/a/account/custom-emoji-search?emoticon=%F0%9F%99%82');
  calls[0].resolve([{ id: '12345', emoji: '🙂' }]); await pending;
  assert.equal(results.children.length, 1);
  assert.equal(results.children[0].children[0].children[0].src, '/api/instances/a/account/custom-emoji?documentId=12345');
  results.children[0].children[0].onclick();
  assert.equal(calls[1].url, '/api/instances/a/account/send-custom-emoji');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { chatId: 42, emoticon: '🙂', documentId: '12345' });
  calls[1].resolve({}); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(toggles, [false]);
  assert.deepEqual(toasts, [['动态自定义表情已发送', 'success']]);
});

test('custom emoji picker inserts a native emoji token into the current draft without sending it', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let customEmojiSearchRequest = 0;');
  const end = source.indexOf('\nfunction renderEmojiPicker(', start);
  class Node {
    constructor() { this.children = []; this.value = ''; this.hidden = true; this.textContent = ''; this.selectionStart = 0; this.selectionEnd = 0; }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); return item; }
    append(...items) { this.children.push(...items); }
    setAttribute() {}
    focus() {}
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const input = new Node(); input.value = '🙂';
  const textarea = new Node(); textarea.value = 'hello'; textarea.selectionStart = 5; textarea.selectionEnd = 5;
  const results = new Node(), status = new Node();
  const nodes = { 'emoji-search-input': input, 'custom-emoji-search-results': results, 'custom-emoji-search-status': status, 'client-message-textarea': textarea };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 5, clientParseMode: 'markdown' };
  const calls = [], drafts = [], toasts = [];
  const context = vm.createContext({ state, document: { getElementById: id => nodes[id] || null, createElement: () => new Node() },
    encodeURIComponent, api: (url, method, body) => new Promise(resolve => calls.push({ url, method, body, resolve })),
    autoResizeTextarea() {}, notifyCurrentDraftChanged: () => drafts.push(textarea.value), toggleExpressionDrawer() {}, showToast: (...args) => toasts.push(args) });
  vm.runInContext(`${source.slice(start, end)}\nthis.search = searchCustomEmoji;`, context);
  const pending = context.search();
  calls[0].resolve([{ id: '12345', emoji: '🙂' }]); await pending;
  results.children[0].children[1].onclick({ stopPropagation() {} });
  assert.equal(textarea.value, 'hello[🙂](tg://emoji?id=12345)');
  assert.equal(textarea.selectionStart, textarea.value.length);
  assert.deepEqual(drafts, [textarea.value]);
  assert.equal(calls.length, 1, 'inserting a custom emoji does not send a Telegram message');
  assert.deepEqual(toasts, [['动态自定义表情已插入消息文本', 'success']]);
});

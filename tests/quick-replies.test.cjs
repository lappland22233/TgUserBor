'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('quick reply catalog maps shortcuts and sending uses opaque stored message IDs', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetQuickReplies') return { quickReplies: [
      new Api.QuickReply({ shortcutId: 4, shortcut: 'hello', topMessage: 11, count: 2 }),
    ] };
    if (request.className === 'messages.GetQuickReplyMessages') return { messages: [{ id: 11 }, { id: 13 }, { id: 13 }] };
    return { className: 'Updates' };
  } };
  assert.deepEqual(await driver.getQuickReplies(), [{ shortcutId: 4, shortcut: 'hello', count: 2 }]);
  await driver.sendQuickReply(123, 4);
  await driver.renameQuickReply(4, 'greeting_2');
  await driver.deleteQuickReply(4);
  assert.equal(calls[0].className, 'messages.GetQuickReplies');
  assert.equal(calls[0].hash.toString(), '0');
  assert.equal(calls[1].className, 'messages.GetQuickReplyMessages');
  assert.equal(calls[1].shortcutId, 4);
  assert.deepEqual(calls[2].id, [11, 13]);
  assert.equal(calls[2].shortcutId, 4);
  assert.equal(calls[2].peer.toString(), '123');
  assert.equal(calls[2].randomId.length, 2);
  assert.ok(calls[2].randomId.every(id => typeof id === 'bigint'));
  assert.equal(calls[3].className, 'messages.EditQuickReplyShortcut');
  assert.equal(calls[3].shortcut, 'greeting_2');
  assert.equal(calls[4].className, 'messages.DeleteQuickReplyShortcut');
  await assert.rejects(driver.sendQuickReply(-100123, 4), /Invalid quick reply request/);
  await assert.rejects(driver.sendQuickReply(123, 0), /Invalid quick reply request/);
});

test('quick reply templates use Telegram shortcut message APIs for create, add, edit and delete', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.CheckQuickReplyShortcut') return true;
    if (request.className === 'messages.GetQuickReplyMessages') return { messages: [
      { id: 19, message: 'hello', date: 2 }, { id: 20, message: 'photo caption', date: 3, media: { className: 'MessageMediaPhoto' } },
    ] };
    return { className: 'Updates' };
  } };
  await driver.createQuickReply('hello', 'first template');
  await driver.addQuickReplyMessage(4, 'second template');
  await driver.editQuickReplyMessage(4, 19, 'updated template');
  await driver.deleteQuickReplyMessages(4, [20]);
  assert.deepEqual(await driver.getQuickReplyMessages(4), [
    { id: 19, text: 'hello', date: 2000, hasMedia: false, editable: true },
    { id: 20, text: 'photo caption', date: 3000, hasMedia: true, editable: true },
  ]);
  assert.equal(calls[0].className, 'messages.CheckQuickReplyShortcut');
  assert.equal(calls[1].className, 'messages.SendMessage');
  assert.equal(calls[1].peer.className, 'InputPeerSelf');
  assert.equal(calls[1].quickReplyShortcut.shortcut, 'hello');
  assert.equal(typeof calls[1].randomId, 'bigint');
  assert.equal(calls[2].className, 'messages.SendMessage');
  assert.equal(calls[2].quickReplyShortcut.className, 'InputQuickReplyShortcutId');
  assert.equal(calls[2].quickReplyShortcut.shortcutId, 4);
  assert.equal(calls[3].className, 'messages.EditMessage');
  assert.equal(calls[3].quickReplyShortcutId, 4);
  assert.equal(calls[4].className, 'messages.DeleteQuickReplyMessages');
  assert.deepEqual(calls[4].id, [20]);
  await assert.rejects(driver.createQuickReply('bad name', 'text'), /Invalid quick reply content/);
});

test('quick reply media uploads to Saved Messages with an opaque shortcut ID', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-quick-reply-'));
  const filePath = path.join(directory, 'photo.jpg'); fs.writeFileSync(filePath, Buffer.from('photo-bytes'));
  const calls = [], uploads = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    uploadFile: async options => { uploads.push(options); return { className: 'InputFile' }; },
    invoke: async request => { calls.push(request); return { updates: [] }; },
  };
  try {
    await driver.addQuickReplyMedia(8, filePath, 'photo.jpg', 'image/jpeg', 'caption');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].file.name, 'photo.jpg');
    assert.equal(uploads[0].file.size, 11);
    assert.equal(calls[0].className, 'messages.SendMedia');
    assert.equal(calls[0].peer.className, 'InputPeerSelf');
    assert.equal(calls[0].media.className, 'InputMediaUploadedPhoto');
    assert.equal(calls[0].message, 'caption');
    assert.equal(calls[0].quickReplyShortcut.className, 'InputQuickReplyShortcutId');
    assert.equal(calls[0].quickReplyShortcut.shortcutId, 8);
    await driver.addQuickReplyMedia(8, filePath, 'photo.jpg', 'application/pdf');
    assert.equal(calls[1].media.className, 'InputMediaUploadedDocument');
    assert.equal(calls[1].media.attributes[0].fileName, 'photo.jpg');
    await driver.replaceQuickReplyMedia(8, 19, filePath, 'replacement.png', 'image/png', 'retained caption');
    assert.equal(calls[2].className, 'messages.EditMessage');
    assert.equal(calls[2].peer.className, 'InputPeerSelf');
    assert.equal(calls[2].id, 19);
    assert.equal(calls[2].quickReplyShortcutId, 8);
    assert.equal(calls[2].media.className, 'InputMediaUploadedPhoto');
    assert.equal(calls[2].message, 'retained caption');
    await assert.rejects(driver.addQuickReplyMedia(0, filePath, 'photo.jpg', 'image/jpeg'), /Invalid quick reply media/);
    await assert.rejects(driver.replaceQuickReplyMedia(8, 0, filePath, 'photo.jpg', 'image/jpeg'), /Invalid quick reply media replacement/);
    assert.equal(uploads.length, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('quick reply API validates the destination and forwards actions to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return action === 'get_quick_replies' ? [{ shortcutId: 4, shortcut: 'hello', count: 2 }] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const replies = await fetch(`${base}/quick-replies`);
    assert.equal(replies.status, 200);
    assert.deepEqual(await replies.json(), [{ shortcutId: 4, shortcut: 'hello', count: 2 }]);
    const post = (route, body) => fetch(`${base}/quick-reply/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('send', { chatId: 0, shortcutId: 4 })).status, 400);
    assert.equal((await post('send', { chatId: -100123, shortcutId: 4 })).status, 400);
    assert.equal((await post('send', { chatId: 123, shortcutId: 4 })).status, 200);
    assert.equal((await post('rename', { shortcutId: 4, shortcut: 'bad name' })).status, 400);
    assert.equal((await post('rename', { shortcutId: 4, shortcut: 'hey_2' })).status, 200);
    assert.equal((await post('delete', { shortcutId: 4 })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_quick_replies', payload: undefined },
      { action: 'send_quick_reply', payload: { chatId: 123, shortcutId: 4 } },
      { action: 'rename_quick_reply', payload: { shortcutId: 4, shortcut: 'hey_2' } },
      { action: 'delete_quick_reply', payload: { shortcutId: 4 } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('quick reply content routes validate template IDs and dispatch account actions', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_quick_reply_messages' ? [{ id: 19, text: 'hello', editable: true }] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const get = await fetch(`${base}/quick-reply/messages?shortcutId=4`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), [{ id: 19, text: 'hello', editable: true }]);
    const post = (route, body) => fetch(`${base}/quick-reply/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('create', { shortcut: 'bad name', text: 'hello' })).status, 400);
    assert.equal((await post('create', { shortcut: 'hello', text: 'hello' })).status, 200);
    assert.equal((await post('message/add', { shortcutId: 4, text: 'second' })).status, 200);
    assert.equal((await post('message/edit', { shortcutId: 4, messageId: 19, text: 'updated' })).status, 200);
    assert.equal((await post('message/delete', { shortcutId: 4, messageIds: [0] })).status, 400);
    assert.equal((await post('message/delete', { shortcutId: 4, messageIds: [19] })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_quick_reply_messages', payload: { shortcutId: 4 } },
      { action: 'create_quick_reply', payload: { shortcut: 'hello', text: 'hello' } },
      { action: 'add_quick_reply_message', payload: { shortcutId: 4, text: 'second' } },
      { action: 'edit_quick_reply_message', payload: { shortcutId: 4, messageId: 19, text: 'updated' } },
      { action: 'delete_quick_reply_messages', payload: { shortcutId: 4, messageIds: [19] } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('quick reply media routes stream bytes to the worker and remove staged uploads', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? {
    getInfo: () => ({ pid: process.pid }),
    accountAction: async (action, payload) => {
      calls.push({ action, payload, existsDuringSend: fs.existsSync(payload.uploadPath) });
    },
  } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/quick-reply/media`;
    const send = (url, metadata) => {
      const encoded = Buffer.from(JSON.stringify(metadata));
      const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
        body: Buffer.concat([length, encoded, Buffer.from('media-bytes')]) });
    };
    assert.equal((await send(base, { shortcutId: 0, fileName: 'bad.txt', mimeType: 'text/plain' })).status, 400);
    assert.equal((await send(`${base}/replace`, { shortcutId: 4, messageId: 0, fileName: 'bad.txt', mimeType: 'text/plain' })).status, 400);
    const response = await send(base, { shortcutId: 4, fileName: 'photo.jpg', mimeType: 'image/jpeg', caption: '' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'add_quick_reply_media');
    assert.equal(calls[0].payload.shortcutId, 4); assert.equal(calls[0].payload.fileName, 'photo.jpg');
    assert.equal(calls[0].existsDuringSend, true);
    assert.equal(fs.existsSync(calls[0].payload.uploadPath), false);
    const replacement = await send(`${base}/replace`, { shortcutId: 4, messageId: 19, fileName: 'new.png', mimeType: 'image/png', caption: 'caption' });
    assert.equal(replacement.status, 200);
    assert.equal(calls.length, 2); assert.equal(calls[1].action, 'replace_quick_reply_media');
    assert.equal(calls[1].payload.messageId, 19); assert.equal(calls[1].payload.caption, 'caption');
    assert.equal(fs.existsSync(calls[1].payload.uploadPath), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('quick reply picker targets one account/chat and closes after sending', async () => {
  class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.handlers = {}; this.disabled = false; this.textContent = ''; this.className = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    get childElementCount() { return this.children.length; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
  }
  const modal = new Element(), list = new Element(), status = new Element(), close = new Element(), button = new Element();
  modal.dataset.initialized = 'false';
  modal.nodes = { '[data-quick-replies-list]': list, '[data-quick-replies-status]': status, '[data-quick-replies-close]': close };
  const ids = new Map([['modal-quick-replies', modal], ['btn-chat-quick-replies', button]]);
  const document = { getElementById: id => ids.get(id) || null, createElement: () => new Element(), querySelector: () => status };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 123, chatSelectionVersion: 5 };
  const calls = [], toasts = [], reloads = [];
  const pending = [];
  const context = vm.createContext({ state, document, window: { addEventListener() {} }, encodeURIComponent,
    api: (url, method = 'GET', body) => new Promise((resolve, reject) => pending.push({ url, method, body, resolve, reject })),
    showToast: value => toasts.push(value), loadClientMessages: (...args) => reloads.push(args),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let quickRepliesDialogRequest = 0;');
  const end = source.indexOf('const pendingPollVotes = {};', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.open = openQuickRepliesDialog; this.send = sendQuickReplyFromPicker;`, context);
  const opening = context.open();
  assert.equal(pending[0].url, '/api/instances/a/account/quick-replies');
  pending[0].resolve([{ shortcutId: 4, shortcut: 'hello', count: 2 }]);
  await opening;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].children[0].textContent, '/hello');
  list.children[0].children[0].onclick();
  assert.equal(pending[1].url, '/api/instances/a/account/quick-reply/send');
  assert.equal(pending[1].method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[1].body)), { chatId: 123, shortcutId: 4 });
  pending[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(modal.style.display, 'none');
  assert.deepEqual(toasts, ['快捷回复已发送']);
  assert.deepEqual(reloads, [[123, true]]);
});

test('quick reply picker creates a shortcut and edits its stored text message', async () => {
  class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.handlers = {}; this.disabled = false; this.hidden = false; this.textContent = ''; this.className = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    focus() {}
    click() { this.clicked = true; }
    remove() { this.removed = true; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    get childElementCount() { return this.children.length; }
  }
  const modal = new Element(), list = new Element(), status = new Element(), close = new Element(), open = new Element();
  const form = new Element(), name = new Element(), text = new Element(), create = new Element();
  modal.dataset.initialized = 'false';
  modal.nodes = { '[data-quick-replies-list]': list, '[data-quick-replies-status]': status,
    '[data-quick-replies-close]': close, '[data-quick-reply-create-form]': form,
    '[data-quick-reply-create-name]': name, '[data-quick-reply-create-text]': text,
    '[data-quick-reply-create-save]': create };
  const ids = new Map([['modal-quick-replies', modal], ['btn-chat-quick-replies', open]]);
  const document = { getElementById: id => ids.get(id) || null, createElement: () => new Element(), querySelector: () => status };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 123, chatSelectionVersion: 5 };
  const pending = [], toasts = [];
  const context = vm.createContext({ state, document, window: { addEventListener() {}, confirm: () => true }, encodeURIComponent,
    api: (url, method = 'GET', body) => new Promise((resolve, reject) => pending.push({ url, method, body, resolve, reject })),
    showToast: value => toasts.push(value), loadClientMessages() {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let quickRepliesDialogRequest = 0;');
  const end = source.indexOf('const pendingPollVotes = {};', start);
  vm.runInContext(`${source.slice(start, end)}\nthis.open = openQuickRepliesDialog; this.create = saveNewQuickReplyFromPicker; this.manage = openQuickReplyMessages; this.target = () => quickRepliesDialogTarget;`, context);

  const opening = context.open();
  pending[0].resolve([]);
  await opening;
  name.value = 'hello'; text.value = 'initial';
  const creating = context.create(context.target());
  assert.equal(pending[1].url, '/api/instances/a/account/quick-reply/create');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[1].body)), { shortcut: 'hello', text: 'initial' });
  pending[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[2].url, '/api/instances/a/account/quick-replies');
  pending[2].resolve([{ shortcutId: 4, shortcut: 'hello', count: 1 }]);
  await creating;
  const target = context.target(), row = list.children[0];
  const managing = context.manage(target, 4, 'hello', row);
  assert.equal(pending[3].url, '/api/instances/a/account/quick-reply/messages?shortcutId=4');
  pending[3].resolve([{ id: 19, text: 'initial', editable: true, hasMedia: false }]);
  await managing;
  const detail = row.children.at(-1);
  detail.children.at(-1).children[1].onclick();
  const editor = detail.children.at(-1);
  editor.children[0].value = 'edited';
  const saving = editor.children[1].onclick();
  assert.equal(pending[4].url, '/api/instances/a/account/quick-reply/message/edit');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[4].body)), { shortcutId: 4, messageId: 19, text: 'edited' });
  pending[4].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[5].url, '/api/instances/a/account/quick-reply/messages?shortcutId=4');
  pending[5].resolve([{ id: 19, text: 'edited', editable: true, hasMedia: false }]);
  await saving;
  assert.equal(detail.children.at(-1).children[0].textContent, 'edited');
  assert.deepEqual(toasts, ['快捷回复 /hello 已创建']);
});

test('quick reply content editor adds media, edits captions, and replaces stored media', async () => {
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.value = ''; this.files = []; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() {}
    click() { this.clicked = true; }
    remove() { this.removed = true; }
    querySelector(selector) { return selector === '[data-quick-reply-message-status]' ? this.children.find(item => item.attributes['data-quick-reply-message-status'] !== undefined) || null : null; }
  }
  const detail = new Element();
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 123, chatSelectionVersion: 5 };
  const apiCalls = [], streamCalls = [];
  const context = vm.createContext({ state, document: { createElement: () => new Element() }, window: { confirm: () => true }, encodeURIComponent,
    api: async (...args) => { apiCalls.push(args); return [{ id: 30, text: 'existing caption', hasMedia: true, editable: true }]; },
    sendMediaStream: async (...args) => { streamCalls.push(args); return { success: true }; }, showToast() {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let quickRepliesDialogRequest = 0;');
  const end = source.indexOf('const pendingPollVotes = {};', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.setTarget = target => { quickRepliesDialogTarget = target; }; this.load = loadQuickReplyMessagesInto;`, context);
  const target = { instId: 'a', chatId: 123, selectionVersion: 5 };
  context.setTarget(target);
  await context.load(target, 4, detail);
  assert.equal(detail.children[2].textContent, '添加媒体消息');
  const captionEdit = detail.children.at(-1).children.find(child => child.textContent === '编辑说明');
  assert.ok(captionEdit);
  const mediaInput = detail.children[3];
  mediaInput.files = [{ size: 4, name: 'photo.png', type: 'image/png' }];
  await mediaInput.onchange();
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0][0], '/api/instances/a/account/quick-reply/media');
  assert.deepEqual(JSON.parse(JSON.stringify(streamCalls[0][2])), { shortcutId: 4, fileName: 'photo.png', mimeType: 'image/png', caption: '' });
  assert.equal(apiCalls.length, 2);
  const mediaRow = detail.children.find(child => child.children?.some(item => item.textContent === 'existing caption'));
  const replaceButton = mediaRow.children.find(child => child.textContent === '替换媒体');
  const replaceInput = mediaRow.children.find(child => child.type === 'file');
  replaceButton.onclick(); assert.equal(replaceInput.clicked, true);
  replaceInput.files = [{ size: 4, name: 'replacement.jpg', type: 'image/jpeg' }];
  await replaceInput.onchange();
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[1][0], '/api/instances/a/account/quick-reply/media/replace');
  assert.deepEqual(JSON.parse(JSON.stringify(streamCalls[1][2])), {
    shortcutId: 4, messageId: 30, fileName: 'replacement.jpg', mimeType: 'image/jpeg', caption: 'existing caption',
  });
  assert.equal(apiCalls.length, 3);
});

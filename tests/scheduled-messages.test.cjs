'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const { Api } = require('telegram');
const { Api: ModernApi } = require('teleproto');

test('scheduled messages use Telegram history, send-now and delete methods for the selected peer', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetScheduledHistory') return { messages: [{ id: 9, date: 200, message: 'Scheduled text', scheduleRepeatPeriod: 604800 }, { id: 10, date: 300, message: '' }] };
    if (request.className === 'messages.GetScheduledMessages') return { messages: [{ id: 9, date: 500, message: 'Old text', scheduleRepeatPeriod: 604800 }] };
    return { className: 'Updates' };
  } };
  assert.deepEqual(await driver.getScheduledMessages(-100123), [
    { id: 9, date: 200000, scheduleRepeatPeriod: 604800, text: 'Scheduled text' }, { id: 10, date: 300000, text: '[计划消息]' },
  ]);
  await driver.sendScheduledMessageNow(-100123, [9, 9, 10]);
  await driver.deleteScheduledMessages(-100123, [10]);
  await driver.editScheduledMessage(-100123, 9, 'Edited text');
  assert.equal(calls[0].className, 'messages.GetScheduledHistory');
  assert.equal(calls[0].CONSTRUCTOR_ID, ModernApi.messages.GetScheduledHistory.CONSTRUCTOR_ID);
  assert.equal(calls[0].peer.toString(), '-100123');
  assert.equal(calls[1].className, 'messages.SendScheduledMessages');
  assert.deepEqual(calls[1].id, [9, 10]);
  assert.equal(calls[2].className, 'messages.DeleteScheduledMessages');
  assert.deepEqual(calls[2].id, [10]);
  assert.equal(calls[3].className, 'messages.GetScheduledMessages');
  assert.equal(calls[3].CONSTRUCTOR_ID, ModernApi.messages.GetScheduledMessages.CONSTRUCTOR_ID);
  assert.equal(calls[4].className, 'messages.EditMessage');
  assert.equal(calls[4].scheduleDate, 500);
  assert.equal(calls[4].scheduleRepeatPeriod, 604800);
  assert.equal(calls[4].message, 'Edited text');
  assert.deepEqual(calls[4].entities, []);
  await assert.rejects(driver.deleteScheduledMessages(-100123, [0]), /Invalid scheduled message request/);
});

test('repeating text and media sends use the current MTProto repeat-period fields', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = {
    getInputEntity: async peer => peer,
    invoke: async request => { calls.push(request); return { updates: [{ id: 41 }] }; },
  };
  assert.equal(await driver.sendMessage(123, 'repeat me', { parseMode: 'plain', schedule: 1900000000, scheduleRepeatPeriod: 86400 }), 41);
  assert.equal(calls[0].className, 'messages.SendMessage');
  assert.equal(calls[0].scheduleDate, 1900000000);
  assert.equal(calls[0].scheduleRepeatPeriod, 86400);

  const mediaCalls = [];
  driver.client = { invoke: async request => { mediaCalls.push(request); return { updates: [{ id: 52 }] }; } };
  const proxy = driver.clientWithMessageEffect('123', 604800);
  const legacyRequest = new Api.messages.SendMedia({
    peer: new Api.InputPeerSelf(), media: new Api.InputMediaEmpty(), message: 'caption', randomId: BigInt(1),
    scheduleDate: 1900000000,
  });
  const response = await proxy.invoke(legacyRequest);
  assert.equal(mediaCalls[0].className, 'messages.SendMedia');
  assert.equal(mediaCalls[0].scheduleDate, 1900000000);
  assert.equal(mediaCalls[0].scheduleRepeatPeriod, 604800);
  assert.equal(String(mediaCalls[0].effect), '123');
  assert.equal(proxy._getResponseMessage(legacyRequest, response, legacyRequest.peer).id, 52);
  await assert.rejects(driver.sendMessage(123, 'bad', { scheduleRepeatPeriod: 17 }), /repeat period/);
  await assert.rejects(driver.sendMediaAlbum(-100123, ['one.jpg', 'two.jpg'], { schedule: 1900000000, scheduleRepeatPeriod: 86400 }), /does not support repeating/);
  assert.equal(ModernApi.messages.SendMessage.CONSTRUCTOR_ID, calls[0].CONSTRUCTOR_ID);
});

test('scheduled message edits can explicitly clear a repeat period', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  const schedule = Math.floor(Date.now() / 1000) + 7200;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetScheduledMessages') {
      return { messages: [{ id: 9, date: schedule, scheduleRepeatPeriod: 604800 }] };
    }
    return { className: 'Updates' };
  } };
  await driver.editScheduledMessage(-100123, 9, 'edited', { schedule, scheduleRepeatPeriod: null });
  assert.equal(calls[1].className, 'messages.EditMessage');
  assert.equal(calls[1].scheduleDate, schedule);
  assert.equal(calls[1].scheduleRepeatPeriod, undefined);
});

test('scheduled message edit parses the editor markdown into Telegram entities', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetScheduledMessages') return { messages: [{ id: 9, date: 1900000000 }] };
    return { className: 'Updates' };
  } };
  await driver.editScheduledMessage(-100123, 9, '**important**', { parseMode: 'markdown' });
  assert.equal(calls[1].message, 'important');
  assert.equal(calls[1].entities[0].className, 'MessageEntityBold');
});

test('scheduled message API validates peer and message IDs before dispatch', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return action === 'get_scheduled_messages' ? [] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/scheduled-messages`;
    assert.equal((await fetch(`${base}?chatId=0`)).status, 400);
    assert.equal((await fetch(`${base}?chatId=-100123`)).status, 200);
    const post = (route, messageIds) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageIds }) });
    assert.equal((await post('send-now', [0])).status, 400);
    assert.equal((await post('send-now', [9])).status, 200);
    assert.equal((await post('delete', [10])).status, 200);
    const invalidEdit = await fetch(`${base}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageId: 0, text: 'bad' }) });
    assert.equal(invalidEdit.status, 400);
    const editResponse = await fetch(`${base}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageId: 9, text: 'edited' }) });
    assert.equal(editResponse.status, 200);
    const invalidFormat = await fetch(`${base}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageId: 9, text: 'edited', parseMode: 'xml' }) });
    assert.equal(invalidFormat.status, 400);
    const invalidSchedule = await fetch(`${base}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, messageId: 9, text: 'edited', schedule: 1 }) });
    assert.equal(invalidSchedule.status, 400);
    const changedSchedule = await fetch(`${base}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      chatId: -100123, messageId: 9, text: 'edited', schedule: 1900000000, scheduleRepeatPeriod: 432000,
    }) });
    assert.equal(changedSchedule.status, 200);
    assert.deepEqual(calls, [
      { action: 'get_scheduled_messages', payload: { chatId: -100123 } },
      { action: 'send_scheduled_now', payload: { chatId: -100123, messageIds: [9] } },
      { action: 'delete_scheduled_messages', payload: { chatId: -100123, messageIds: [10] } },
      { action: 'edit_scheduled_message', payload: { chatId: -100123, messageId: 9, text: 'edited' } },
      { action: 'edit_scheduled_message', payload: { chatId: -100123, messageId: 9, text: 'edited', schedule: 1900000000, scheduleRepeatPeriod: 432000 } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('message-send API accepts only supported repeat periods with a scheduled date', async () => {
  const calls = [];
  const manager = { getInstance: () => ({ accountAction: async (action, payload) => { calls.push({ action, payload }); return { id: 1 }; } }) };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/send`;
    const post = options => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 9, text: 'repeat', options }) });
    assert.equal((await post({ scheduleRepeatPeriod: 86400 })).status, 400);
    assert.equal((await post({ schedule: 1900000000, scheduleRepeatPeriod: 3600 })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await post({ schedule: 1900000000, scheduleRepeatPeriod: 604800 })).status, 200);
    assert.deepEqual(calls, [{ action: 'send_message', payload: {
      chatId: 9, text: 'repeat', options: { schedule: 1900000000, scheduleRepeatPeriod: 604800 },
    } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('scheduled message dialog only acts on the open chat and refreshes after sending now', async () => {
  class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.handlers = {}; this.disabled = false; this.textContent = ''; this.className = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    querySelectorAll(selector) {
      if (selector === 'button') return this.children.filter(child => child.type === 'button');
      if (selector === '[data-scheduled-message-select]') return this.children.flatMap(child => child.className === 'scheduled-message-select'
        ? [child] : child.querySelectorAll?.(selector) || []);
      return [];
    }
    get childElementCount() { return this.children.length; }
    setAttribute() {}
    focus() {}
    remove() { this.isRemoved = true; }
  }
  const modal = new Element(), list = new Element(), status = new Element(), close = new Element(), button = new Element();
  modal.nodes = { '[data-scheduled-messages-list]': list, '[data-scheduled-messages-status]': status, '[data-scheduled-messages-close]': close };
  const nodes = new Map([['modal-scheduled-messages', modal], ['btn-chat-scheduled-messages', button]]);
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element(), querySelector: () => status };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 6 };
  const pending = [], toasts = [], reloads = [];
  const context = vm.createContext({ state, document, window: { addEventListener() {}, confirm: () => true }, encodeURIComponent,
    api: (url, method = 'GET', body) => new Promise((resolve, reject) => pending.push({ url, method, body, resolve, reject })),
    showToast: value => toasts.push(value), loadClientMessages: (...args) => reloads.push(args),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let scheduledMessagesRequest = 0;');
  const end = source.indexOf('const pendingPollVotes = {};', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.open = openScheduledMessagesDialog; this.bulk = performScheduledMessagesBulkAction; this.target = () => scheduledMessagesTarget;`, context);
  const opening = context.open();
  assert.equal(pending[0].url, '/api/instances/a/account/scheduled-messages?chatId=-100123');
  pending[0].resolve([{ id: 9, date: 1900000000000, scheduleRepeatPeriod: 604800, text: '<literal>' }]);
  await opening;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, '<literal>');
  list.children[0].children[2].onclick();
  const editor = list.children[0].children[6];
  editor.children[0].value = 'edited';
  const newDate = new Date(Date.now() + 7200000);
  const pad = value => String(value).padStart(2, '0');
  editor.children[1].value = `${newDate.getFullYear()}-${pad(newDate.getMonth() + 1)}-${pad(newDate.getDate())}T${pad(newDate.getHours())}:${pad(newDate.getMinutes())}`;
  editor.children[2].value = '86400';
  const saving = editor.children[3].onclick();
  assert.equal(pending[1].url, '/api/instances/a/account/scheduled-messages/edit');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[1].body)), {
    chatId: -100123, messageId: 9, text: 'edited', parseMode: 'markdown',
    schedule: Math.floor(newDate.getTime() / 60000) * 60, scheduleRepeatPeriod: 86400,
  });
  pending[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[2].url, '/api/instances/a/account/scheduled-messages?chatId=-100123');
  pending[2].resolve([{ id: 9, date: 1900000000000, scheduleRepeatPeriod: 604800, text: 'edited' }]);
  await saving;
  list.children[0].children[3].onclick();
  assert.equal(pending[3].url, '/api/instances/a/account/scheduled-messages/send-now');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[3].body)), { chatId: -100123, messageIds: [9] });
  pending[3].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reloads, [[-100123, true]]);
  assert.equal(pending[4].url, '/api/instances/a/account/scheduled-messages?chatId=-100123');
  pending[4].resolve([{ id: 9, date: 1900000000000, scheduleRepeatPeriod: 604800, text: 'edited' }, { id: 10, date: 1900000001000, text: 'second' }]);
  await new Promise(resolve => setImmediate(resolve));
  list.children[0].children[5].checked = true;
  list.children[1].children[5].checked = true;
  const bulk = context.bulk(context.target(), 'send-now');
  assert.equal(pending[5].url, '/api/instances/a/account/scheduled-messages/send-now');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[5].body)), { chatId: -100123, messageIds: [9, 10] });
  pending[5].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reloads, [[-100123, true], [-100123, true]]);
  assert.equal(pending[6].url, '/api/instances/a/account/scheduled-messages?chatId=-100123');
  pending[6].resolve([]);
  await bulk;
  assert.deepEqual(toasts, ['计划消息内容与发送时间已更新', '计划消息已立即发送', '已立即发送 2 条计划消息']);
});

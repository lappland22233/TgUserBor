'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram message auto-delete writes the selected timer to the resolved peer', async () => {
  const calls = [];
  const peer = new Api.InputPeerChannel({ channelId: bigInt(9), accessHash: bigInt(99) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async id => { assert.equal(String(id), '-1009'); return peer; },
    invoke: async request => { calls.push(request); return { updates: [] }; },
  };
  assert.deepEqual(await driver.setChatHistoryTtl(-1009, 604800), { period: 604800 });
  assert.ok(calls[0] instanceof Api.messages.SetHistoryTTL);
  assert.equal(calls[0].peer, peer);
  assert.equal(calls[0].period, 604800);
  await assert.rejects(driver.setChatHistoryTtl(-1009, 31536001), /Invalid Telegram message auto-delete period/);
});

test('default auto-delete period uses Telegram default timer RPCs', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return request instanceof Api.messages.GetDefaultHistoryTTL ? { period: 604800 } : true;
  } };
  assert.deepEqual(await driver.getDefaultHistoryTtl(), { period: 604800 });
  assert.deepEqual(await driver.setDefaultHistoryTtl(31536000), { period: 31536000 });
  assert.ok(calls[0] instanceof Api.messages.GetDefaultHistoryTTL);
  assert.ok(calls[1] instanceof Api.messages.SetDefaultHistoryTTL);
  assert.equal(calls[1].period, 31536000);
  await assert.rejects(driver.setDefaultHistoryTtl(31536001), /Invalid Telegram default auto-delete period/);
});

test('applying an auto-delete timer continues after per-chat permission failures and de-duplicates peers', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async id => {
      if (String(id) === '-1008') throw new Error('CHAT_ADMIN_REQUIRED');
      return new Api.InputPeerChannel({ channelId: bigInt(9), accessHash: bigInt(99) });
    },
    invoke: async request => { calls.push(request); return { updates: [] }; },
  };
  assert.deepEqual(await driver.applyChatHistoryTtl([-1009, -1008, -1009], 172800), {
    updated: 1, failedChatIds: [-1008],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].period, 172800);
  await assert.rejects(driver.applyChatHistoryTtl([], 86400), /Invalid Telegram auto-delete selection/);
});

test('chat auto-delete route validates the timer before dispatching to one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_default_history_ttl') return { period: 604800 };
    if (action === 'apply_chat_history_ttl') return { updated: 1, failedChatIds: [-9] };
    return { period: payload.period };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/instances/a/account/chat-history-ttl';
    const send = (chatId, period) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, period }) });
    assert.equal((await send(0, 86400)).status, 400);
    assert.equal((await send(7, 31536001)).status, 400);
    const result = await send(-9, 2592000);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { period: 2592000 });
    const defaultTtl = await fetch(base.replace('/chat-history-ttl', '/default-history-ttl'));
    assert.deepEqual(await defaultTtl.json(), { period: 604800 });
    const defaultUpdate = await fetch(base.replace('/chat-history-ttl', '/default-history-ttl'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ period: 31536000 }),
    });
    assert.equal(defaultUpdate.status, 200);
    const bulk = await fetch(base.replace('/chat-history-ttl', '/chat-history-ttl/bulk'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatIds: [7, -9], period: 172800 }),
    });
    assert.deepEqual(await bulk.json(), { updated: 1, failedChatIds: [-9] });
    const invalidBulk = await fetch(base.replace('/chat-history-ttl', '/chat-history-ttl/bulk'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatIds: [7], period: 31536001 }),
    });
    assert.equal(invalidBulk.status, 400);
    assert.deepEqual(calls, [
      { action: 'set_chat_history_ttl', payload: { chatId: -9, period: 2592000 } },
      { action: 'get_default_history_ttl', payload: undefined },
      { action: 'set_default_history_ttl', payload: { period: 31536000 } },
      { action: 'apply_chat_history_ttl', payload: { chatIds: [7, -9], period: 172800 } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('profile auto-delete control ignores responses from an earlier account or peer', async () => {
  const app = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = app.indexOf('async function setPeerHistoryTtl(');
  const end = app.indexOf('async function loadPeerProfile(', start);
  if (start < 0 || end < 0) throw new Error('Cannot locate peer auto-delete control');
  const select = { value: '604800', disabled: false, dataset: { savedPeriod: '604800' } };
  const status = { textContent: '' };
  const state = { clientSelectedInstance: 'a', currentProfileChatId: 7, chatSelectionVersion: 2 };
  const calls = [];
  const context = vm.createContext({ state, profileRequestId: 5, Number, String, Array, encodeURIComponent,
    document: { getElementById: id => id === 'profile-history-ttl' ? select : id === 'profile-history-ttl-status' ? status : null },
    api: (...args) => new Promise(resolve => calls.push({ args, resolve })),
  });
  vm.runInContext(app.slice(start, end) + String.fromCharCode(10) + 'this.save = setPeerHistoryTtl;', context);
  const saving = context.save(7, 2592000, { instId: 'a', request: 5, selectionVersion: 2 });
  assert.match(calls[0].args[0], /account\/chat-history-ttl$/);
  assert.equal(calls[0].args[1], 'POST');
  assert.equal(calls[0].args[2].chatId, 7);
  assert.equal(calls[0].args[2].period, 2592000);
  calls[0].resolve({ period: 2592000 });
  await saving;
  assert.equal(select.value, '2592000');
  assert.equal(select.dataset.savedPeriod, '2592000');
  assert.match(status.textContent, /计时器已更新/);

  const stale = context.save(7, 0, { instId: 'a', request: 5, selectionVersion: 2 });
  state.currentProfileChatId = 8;
  select.value = '86400';
  select.dataset.savedPeriod = '86400';
  calls[1].resolve({ period: 0 });
  await stale;
  assert.equal(select.value, '86400');
  assert.equal(select.dataset.savedPeriod, '86400');
});

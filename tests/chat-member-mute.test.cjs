'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');
const { ChatWSGateway } = require('../dist/gui/ws-chat');

test('member mute duration maps to Telegram banned rights and rejects values over one year', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolveAdminInputChannel = async () => new Api.InputChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  driver.resolveAdminInputUser = async () => new Api.InputUser({ userId: bigInt(10), accessHash: bigInt(99) });
  driver.client = { invoke: async request => { calls.push(request); return true; } };
  await driver.muteUser(-42, 10, 31536000);
  assert.ok(calls[0] instanceof Api.channels.EditBanned);
  assert.equal(calls[0].bannedRights.sendMessages, true);
  assert.equal(calls[0].bannedRights.sendMedia, true);
  assert.ok(calls[0].bannedRights.untilDate > Math.floor(Date.now() / 1000));
  await assert.rejects(driver.muteUser(-42, 10, -1), /Invalid mute duration/);
  await assert.rejects(driver.muteUser(-42, 10, 31536001), /Invalid mute duration/);
  assert.equal(calls.length, 1);
});

test('member mute HTTP route validates peer IDs and the supported duration range', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return true; } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/a/account/mute`;
    const post = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 42, userId: 10, seconds: 3600 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: 10, seconds: 31536001 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: 10, seconds: 0 })).status, 200);
    assert.deepEqual(calls, [['mute_user', { chatId: -42, userId: 10, seconds: 0 }]]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('member mute WebSocket action validates the selected account and duration', async () => {
  const calls = [];
  const manager = new EventEmitter();
  manager.getInstance = id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return true; } } : undefined;
  const gateway = new ChatWSGateway(manager, {});
  try {
    await gateway.handleRpcAction('mute_user', { instId: 'a', chatId: -42, userId: 10, seconds: 86400 });
    assert.deepEqual(calls, [['mute_user', { chatId: -42, userId: 10, seconds: 86400 }]]);
    await assert.rejects(gateway.handleRpcAction('mute_user', { instId: 'a', chatId: 42, userId: 10, seconds: 0 }), /Invalid Telegram member mute/);
    await assert.rejects(gateway.handleRpcAction('mute_user', { instId: 'a', chatId: -42, userId: 10, seconds: 31536001 }), /Invalid Telegram member mute/);
  } finally {
    gateway.rpcWss.close();
    gateway.streamWss.close();
  }
});

test('member ban driver and account routes enforce a current finite expiry or permanent ban', async () => {
  const requests = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolveAdminInputChannel = async () => new Api.InputChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  driver.resolveAdminInputUser = async () => new Api.InputUser({ userId: bigInt(10), accessHash: bigInt(99) });
  driver.client = { invoke: async request => { requests.push(request); return true; } };
  const untilDate = Math.floor(Date.now() / 1000) + 86400;
  await driver.banUser(-42, 10, untilDate);
  assert.ok(requests[0] instanceof Api.channels.EditBanned);
  assert.equal(requests[0].bannedRights.viewMessages, true);
  assert.equal(requests[0].bannedRights.untilDate, untilDate);
  await assert.rejects(driver.banUser(-42, 10, Math.floor(Date.now() / 1000) - 1), /Invalid ban target or duration/);
  await assert.rejects(driver.banUser(-42, 10, Math.floor(Date.now() / 1000) + 31536001), /Invalid ban target or duration/);
  assert.equal(requests.length, 1);
});

test('member ban HTTP and WebSocket actions validate the target and expiry', async () => {
  const calls = [];
  const manager = new EventEmitter();
  manager.getInstance = id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return true; } } : undefined;
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gateway = new ChatWSGateway(manager, {});
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/a/account/ban`;
    const post = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: -42, userId: 10, untilDate: 1 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: 10, untilDate: 0 })).status, 200);
    await gateway.handleRpcAction('ban_user', { instId: 'a', chatId: -42, userId: 11, untilDate: 0 });
    await assert.rejects(gateway.handleRpcAction('ban_user', { instId: 'a', chatId: -42, userId: 11, untilDate: Date.now() }), /Invalid Telegram member ban/);
    assert.deepEqual(calls, [
      ['ban_user', { chatId: -42, userId: 10, untilDate: 0 }],
      ['ban_user', { chatId: -42, userId: 11, untilDate: 0 }],
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    gateway.rpcWss.close();
    gateway.streamWss.close();
  }
});

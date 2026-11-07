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

test('Telegram chat creation selects the correct MTProto method and maps the returned peer', async () => {
  const requests = [];
  const group = new Api.Chat({ id: bigInt(42), title: 'New group', photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 1, version: 1 });
  const channel = new Api.Channel({ id: bigInt(55), title: 'Forum', photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true, forum: true });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 1;
  driver.resolveAdminInputUser = async id => new Api.InputUser({ userId: bigInt(id), accessHash: bigInt(id + 100) });
  driver.client = { invoke: async request => {
    requests.push(request);
    return { chats: [request instanceof Api.messages.CreateChat ? group : channel] };
  } };

  assert.deepEqual(await driver.createChat({ type: 'group', title: ' New group ', userIds: [2, 3] }), {
    id: -42, type: 'group', title: 'New group', username: undefined, unreadCount: 0,
    isChannel: false, isBroadcast: false, isForum: false,
  });
  assert.ok(requests[0] instanceof Api.messages.CreateChat);
  assert.equal(requests[0].title, 'New group');
  assert.equal(requests[0].users.length, 2);

  const createdForum = await driver.createChat({ type: 'supergroup', title: 'Forum', about: 'Topics', forum: true });
  assert.equal(createdForum.id, -10055);
  assert.equal(createdForum.type, 'supergroup');
  assert.equal(createdForum.isForum, true);
  assert.ok(requests[1] instanceof Api.channels.CreateChannel);
  assert.equal(requests[1].broadcast, false);
  assert.equal(requests[1].megagroup, true);
  assert.equal(requests[1].forum, true);

  await assert.rejects(driver.createChat({ type: 'group', title: 'No members' }), /Invalid Telegram chat creation options/);
  await assert.rejects(driver.createChat({ type: 'supergroup', title: 'Bad forum', forum: true, userIds: [1] }), /Invalid Telegram chat creation options/);
  assert.equal(requests.length, 2);
});

test('chat creation HTTP route validates user selections and dispatches to one Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return { id: -10042, title: 'Public' }; } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/a/account/create-chat`;
    const post = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ type: 'group', title: 'Empty', userIds: [] })).status, 400);
    assert.equal((await post({ type: 'channel', title: 'Topics', forum: true })).status, 400);
    const response = await post({ type: 'channel', title: ' Public ', about: '', userIds: [], forum: false });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: -10042, title: 'Public' });
    assert.deepEqual(calls, [['create_chat', { type: 'channel', title: 'Public', about: '', userIds: [], forum: false }]]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('chat creation WebSocket RPC validates and dispatches typed options', async () => {
  const calls = [];
  const manager = new EventEmitter();
  manager.getInstance = id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return { id: -42 }; } } : undefined;
  const gateway = new ChatWSGateway(manager, {});
  try {
    assert.deepEqual(await gateway.handleRpcAction('create_chat', { instId: 'a', type: 'supergroup', title: 'Forum', about: 'Topics', forum: true }), { id: -42 });
    assert.deepEqual(calls, [['create_chat', { type: 'supergroup', title: 'Forum', about: 'Topics', userIds: [], forum: true }]]);
    await assert.rejects(gateway.handleRpcAction('create_chat', { instId: 'a', type: 'group', title: 'Empty' }), /Invalid Telegram chat creation options/);
  } finally {
    gateway.rpcWss.close();
    gateway.streamWss.close();
  }
});

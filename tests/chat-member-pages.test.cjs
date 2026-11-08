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

test('channel member pages use Telegram search, native offsets, and map participant roles', async () => {
  const calls = [];
  const peer = new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => { assert.equal(id, -42); return id; };
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipantAdmin({
        userId: bigInt(77), promotedBy: bigInt(1), date: 1,
        adminRights: new Api.ChatAdminRights({ banUsers: true, inviteUsers: true, addAdmins: true }),
      }) };
      if (request instanceof Api.channels.GetFullChannel) return { fullChat: { defaultBannedRights: new Api.ChatBannedRights({}) } };
      return {
        count: 60,
        users: [new Api.User({ id: bigInt(10), firstName: 'Ada', username: 'ada' })],
        participants: [{
          className: 'ChannelParticipantAdmin', userId: bigInt(10), date: 123,
          adminRights: new Api.ChatAdminRights({ banUsers: true }),
        }],
      };
    },
  };

  const page = await driver.getParticipantsPage(-42, 50, 1, ' ada ');
  assert.equal(page.count, 60);
  assert.equal(page.nextOffset, 51);
  assert.equal(page.participants[0].role, 'admin');
  assert.equal(page.participants[0].joinedDate, 123);
  assert.equal(page.participants[0].user.username, 'ada');
  assert.deepEqual(page.selfPermissions, { isCreator: false, canInviteUsers: true, canBanUsers: true, canAddAdmins: true });
  assert.ok(calls[0] instanceof Api.channels.GetParticipants);
  assert.ok(calls[0].filter instanceof Api.ChannelParticipantsSearch);
  assert.equal(calls[0].filter.q, 'ada');
  assert.equal(calls[0].offset, 50);
  assert.equal(calls[0].limit, 1);
  assert.ok(calls.some(request => request instanceof Api.channels.GetFullChannel));
  await assert.rejects(driver.getParticipantsPage(-42, -1), /Invalid participant query/);
  await assert.rejects(driver.getParticipantsPage(42), /Invalid participant query/);
  await assert.rejects(driver.getParticipantsPage(-42, 0, 1, 'x'.repeat(129)), /Invalid participant query/);
  assert.ok(calls.some(request => request instanceof Api.channels.GetParticipant));
  assert.equal(calls.length, 3);
});

test('ordinary members can invite only when both default and individual rights allow it', async () => {
  const peer = new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  const read = async ({ defaultInviteBanned = false } = {}) => {
    const driver = Object.create(TelegramDriver.prototype);
    driver.selfId = 77;
    driver.resolvePeer = id => id;
    driver.client = {
      getInputEntity: async () => peer,
      invoke: async request => {
        if (request instanceof Api.channels.GetParticipants) return { count: 0, participants: [], users: [] };
        if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipant({ userId: bigInt(77), date: 1 }) };
        if (request instanceof Api.channels.GetFullChannel) return { fullChat: {
          defaultBannedRights: new Api.ChatBannedRights({ inviteUsers: defaultInviteBanned }),
        } };
        throw new Error(`unexpected ${request.className}`);
      },
    };
    const permissions = (await driver.getParticipantsPage(-42)).selfPermissions;
    return permissions;
  };
  assert.equal((await read()).canInviteUsers, true);
  assert.equal((await read({ defaultInviteBanned: true })).canInviteUsers, false);

  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.resolvePeer = id => id;
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      if (request instanceof Api.channels.GetParticipants) return { count: 0, participants: [], users: [] };
      if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipantBanned({
        peer: new Api.PeerUser({ userId: bigInt(77) }), kickedBy: bigInt(1), date: 1,
        bannedRights: new Api.ChatBannedRights({ inviteUsers: true }), left: false,
      }) };
      if (request instanceof Api.channels.GetFullChannel) return { fullChat: { defaultBannedRights: new Api.ChatBannedRights({}) } };
      throw new Error(`unexpected ${request.className}`);
    },
  };
  assert.equal((await driver.getParticipantsPage(-42)).selfPermissions.canInviteUsers, false);
});

test('restricted channel participants remain distinct from participants who left', () => {
  const driver = Object.create(TelegramDriver.prototype);
  const user = new Api.User({ id: bigInt(10), firstName: 'Restricted' });
  const restricted = new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: bigInt(10) }),
    kickedBy: bigInt(1), date: 1, bannedRights: new Api.ChatBannedRights({ sendMessages: true }), left: false });
  const left = new Api.ChannelParticipantBanned({ peer: new Api.PeerUser({ userId: bigInt(10) }),
    kickedBy: bigInt(1), date: 1, bannedRights: new Api.ChatBannedRights({ viewMessages: true }), left: true });
  const mapped = driver.mapParticipantEntities([{ ...user, participant: restricted }, { ...user, participant: left }], true);
  assert.equal(mapped[0].role, 'banned');
  assert.equal(Boolean(mapped[0].isLeft), false);
  assert.equal(mapped[1].role, 'banned');
  assert.equal(mapped[1].isLeft, true);
});

test('basic-group member pages filter IDs locally and paginate the Telegram roster', async () => {
  const peer = new Api.InputPeerChat({ chatId: bigInt(42) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.resolvePeer = id => id;
  driver.client = {
    getInputEntity: async () => peer,
    getParticipants: async (_peer, options) => {
      assert.equal(options.limit, Number.MAX_SAFE_INTEGER);
      return [
        new Api.User({ id: bigInt(10), firstName: 'Alice' }),
        new Api.User({ id: bigInt(11), firstName: 'Bob' }),
        new Api.User({ id: bigInt(110), firstName: 'Robert' }),
      ];
    },
    invoke: async request => {
      assert.ok(request instanceof Api.messages.GetFullChat);
      return { fullChat: { participants: { participants: [new Api.ChatParticipantAdmin({
        userId: bigInt(77), inviterId: bigInt(1), date: 1,
      })] } } };
    },
  };
  assert.deepEqual(await driver.getParticipantsPage(-42, 0, 1, '11'), {
    count: 2,
    participants: [{ user: { id: 11, username: undefined, firstName: 'Bob', lastName: undefined, isBot: false, phone: undefined }, role: 'member', joinedDate: undefined, supportsCustomAdminRights: false, adminPermissions: undefined }],
    selfPermissions: { isCreator: false, canInviteUsers: true, canBanUsers: true, canAddAdmins: false },
    nextOffset: 1,
  });
  const second = await driver.getParticipantsPage(-42, 1, 1, '11');
  assert.equal(second.participants[0].user.id, 110);
  assert.equal(second.nextOffset, undefined);
});

test('member-page HTTP API validates bounds and dispatches the account-scoped search', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => {
    calls.push(args);
    return { count: 2, participants: [], nextOffset: 50 };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/participants`;
    assert.equal((await fetch(`${base}?chatId=42`)).status, 400);
    assert.equal((await fetch(`${base}?chatId=-42&offset=0&limit=101`)).status, 400);
    const response = await fetch(`${base}?chatId=-42&offset=50&limit=50&query=Ada`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { count: 2, participants: [], nextOffset: 50 });
    assert.deepEqual(calls, [['get_participants', { chatId: -42, offset: 50, limit: 50, query: 'Ada' }]]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('member-page WebSocket RPC validates and dispatches pagination to the selected account', async () => {
  const calls = [];
  const manager = new EventEmitter();
  manager.getInstance = id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return { count: 0, participants: [] }; } } : undefined;
  const gateway = new ChatWSGateway(manager, {});
  try {
    assert.deepEqual(await gateway.handleRpcAction('get_participants', { instId: 'a', chatId: -42, offset: 50, limit: 25, query: 'Mina' }), { count: 0, participants: [] });
    assert.deepEqual(calls, [['get_participants', { chatId: -42, offset: 50, limit: 25, query: 'Mina' }]]);
    await assert.rejects(gateway.handleRpcAction('get_participants', { instId: 'a', chatId: 42 }), /Invalid participant query/);
  } finally {
    gateway.rpcWss.close();
    gateway.streamWss.close();
  }
});

test('group member invitation HTTP route rejects malformed peers and targets the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); return true; } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/instances/a/account/invite-user`;
    const post = body => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 42, userId: 10 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: -10 })).status, 400);
    assert.equal((await post({ chatId: -42, userId: 10 })).status, 200);
    assert.deepEqual(calls, [['invite_user', { chatId: -42, userId: 10 }]]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

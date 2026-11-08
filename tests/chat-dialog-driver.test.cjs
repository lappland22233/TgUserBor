'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramDriver } = require('../dist/bot/driver/telegram.js');
const { handleApiRoute } = require('../dist/gui/api');

test('dialog cursor resolves the Telegram peer and converts milliseconds to seconds', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const peer = { kind: 'input-peer' };
  let requestedPeer, requestedOptions;
  driver.client = {
    async getInputEntity(value) { requestedPeer = value; return peer; },
    async getDialogs(options) { requestedOptions = options; return []; },
  };
  await driver.getDialogs(50, { peer: '-10042', id: 123, date: 1700000000000 });
  assert.equal(requestedPeer, -10042n);
  assert.deepEqual(requestedOptions, { limit: 50, offsetPeer: peer, offsetId: 123, offsetDate: 1700000000, ignorePinned: true, folder: 0 });
});

test('archive pagination requests Telegram folder 1 using the original cursor', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  let requestedOptions;
  driver.client = { getInputEntity: async () => 'peer', getDialogs: async options => { requestedOptions = options; return []; } };
  await driver.getDialogs(50, { peer: '-10042', id: 123, date: 1700000000000 }, 1);
  assert.deepEqual(requestedOptions, { limit: 50, offsetPeer: 'peer', offsetId: 123, offsetDate: 1700000000, ignorePinned: true, folder: 1 });
});

test('Saved Messages dialog is identified against the currently authorized Telegram account', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { getDialogs: async () => [
    { id: 77, entity: { className: 'User', id: 77, firstName: 'Saved Messages' }, isUser: true, unreadCount: 0 },
    { id: 88, entity: { className: 'User', id: 88, firstName: 'Other' }, isUser: true, unreadCount: 0 },
  ] };
  const dialogs = await driver.getDialogs();
  assert.equal(dialogs[0].isSelf, true);
  assert.equal(dialogs[1].isSelf, false);
});

test('dialog list includes Telegram auto-delete periods for the client clock icon', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { getDialogs: async () => [
    { id: -42, entity: { className: 'Chat', id: 42, title: 'Group' }, isGroup: true, unreadCount: 0,
      dialog: { ttlPeriod: 604800 } },
  ] };
  const dialogs = await driver.getDialogs();
  assert.equal(dialogs[0].ttlPeriod, 604800);
});

test('megagroups are classified as groups and retain their public username', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { getDialogs: async () => [{
    id: -10042,
    entity: { className: 'Channel', id: 42, title: 'Public group', username: 'public_group', megagroup: true },
    isChannel: true,
    unreadCount: 0,
  }] };
  const [dialog] = await driver.getDialogs();
  assert.equal(dialog.type, 'supergroup');
  assert.equal(dialog.username, 'public_group');
});

test('HTTP archive endpoint forwards folder and pagination to the selected account', async () => {
  let received;
  const manager = { getInstance: id => ({ accountAction: async (action, params) => { received = {id, action, params}; return []; } }) };
  const req = { url: '/api/instances/a/account/dialogs?limit=50&folderId=1&offsetPeer=-10042&offsetId=123&offsetDate=1700000000000', method: 'GET', headers: {} };
  const res = { writeHead() {}, end() {} };
  assert.equal(await handleApiRoute(req, res, manager, ''), true);
  assert.deepEqual(received, { id: 'a', action: 'get_dialogs', params: { limit: 50, offset: { peer: '-10042', id: 123, date: 1700000000000 }, folderId: 1 } });
});

test('explicit dialog endpoint bounds peer IDs and forwards them only to the selected account', async () => {
  let received, status, body;
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    received = { id, action, params }; return [{ id: 12, type: 'private', title: 'Mina', unreadCount: 0 }];
  } } : undefined };
  const invoke = async peers => {
    const req = { url: `/api/instances/a/account/dialogs/explicit?peerIds=${encodeURIComponent(peers)}`, method: 'GET', headers: {} };
    const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
    assert.equal(await handleApiRoute(req, res, manager, ''), true);
    return JSON.parse(body);
  };
  assert.deepEqual(await invoke('12,-10056,12'), [{ id: 12, type: 'private', title: 'Mina', unreadCount: 0 }]);
  assert.deepEqual(received, { id: 'a', action: 'get_explicit_dialogs', params: { peerIds: [12, -10056] } });
  assert.deepEqual(await invoke('0'), { error: 'Invalid explicit dialog peers' });
  assert.equal(status, 400);
  assert.equal(received.action, 'get_explicit_dialogs');
});

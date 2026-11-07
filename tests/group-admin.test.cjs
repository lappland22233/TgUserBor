'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

function makeDriver(chatKind = 'channel') {
  const calls = [];
  const channel = new Api.InputChannel({ channelId: bigInt(1234567890), accessHash: bigInt(5) });
  const user = new Api.InputUser({ userId: bigInt(42), accessHash: bigInt(7) });
  const basicChat = new Api.InputPeerChat({ chatId: bigInt(123) });
  const client = {
    getInputEntity: async entity => {
      if (typeof entity === 'bigint' && entity < 0n) return chatKind === 'channel' ? channel : basicChat;
      return user;
    },
    invoke: async request => { calls.push(request); return {}; },
  };
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = client;
  return { driver, calls };
}

test('channel admin promotion maps granular permissions to channels.EditAdmin', async () => {
  const { driver, calls } = makeDriver();
  await driver.promoteUser(-1001234567890, 42, { changeInfo: true, banUsers: false, manageTopics: true, postStories: true, addAdmins: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].className, 'channels.EditAdmin');
  assert.equal(calls[0].adminRights.changeInfo, true);
  assert.equal(calls[0].adminRights.banUsers, false);
  assert.equal(calls[0].adminRights.manageTopics, true);
  assert.equal(calls[0].adminRights.postStories, true);
  assert.equal(calls[0].adminRights.addAdmins, false);
});

test('basic group admin changes use messages.EditChatAdmin', async () => {
  const { driver, calls } = makeDriver('basic');
  await driver.promoteUser(-123, 42, { banUsers: true });
  await driver.demoteUser(-123, 42);
  assert.deepEqual(calls.map(request => request.className), ['messages.EditChatAdmin', 'messages.EditChatAdmin']);
  assert.equal(calls[0].isAdmin, true);
  assert.equal(calls[1].isAdmin, false);
});

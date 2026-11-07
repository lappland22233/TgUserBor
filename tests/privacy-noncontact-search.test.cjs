'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

test('Telegram search results can be used to add a non-contact user privacy exception', async () => {
  const calls = [];
  const targetUser = new Api.User({ id: bigInt(99), firstName: 'Dana', lastName: 'Example', username: 'dana', accessHash: bigInt(999) });
  const targetPeer = new Api.InputPeerUser({ userId: bigInt(99), accessHash: bigInt(999) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 7;
  driver.client = {
    getInputEntity: async peer => { assert.equal(peer, 99n); return targetPeer; },
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.contacts.Search) return {
        myResults: [new Api.PeerUser({ userId: bigInt(99) })], results: [], users: [targetUser], chats: [],
      };
      if (request instanceof Api.account.GetPrivacy) return {
        users: [], chats: [], rules: [new Api.PrivacyValueAllowContacts()],
      };
      return true;
    },
  };
  const [result] = await driver.searchDialogs('dana');
  assert.equal(result.id, 99);
  assert.equal(result.title, 'Dana Example');
  assert.equal(result.type, 'private');
  assert.equal(result.isBot, false);
  await driver.addAccountPrivacyUserException('lastSeen', 'blockedUsers', String(result.id));
  const update = calls.find(request => request instanceof Api.account.SetPrivacy);
  assert.ok(update);
  assert.equal(update.rules[0].className, 'InputPrivacyValueDisallowUsers');
  assert.equal(update.rules[0].users[0].userId.toString(), '99');
  assert.equal(update.rules[0].users[0].accessHash.toString(), '999');
});

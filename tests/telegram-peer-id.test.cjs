'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { getPeerId } = require('telegram/Utils');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

function makeDriver(client = {}) {
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = client;
  return driver;
}

test('real GramJS message, dialog and group entities use the same marked peer ID', async () => {
  const user = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  const cases = [
    [user, '42', 'private'],
    [new Api.Chat({ id: bigInt(123), title: 'Group', photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: 0, version: 1 }), '-123', 'group'],
    [new Api.ChatForbidden({ id: bigInt(123), title: 'Forbidden group' }), '-123', 'group'],
    [new Api.Channel({ id: bigInt(123), title: 'Broadcast', photo: new Api.ChatPhotoEmpty(), date: 0, broadcast: true }), '-100123', 'channel'],
    [new Api.Channel({ id: bigInt(456), title: 'Supergroup', photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true }), '-100456', 'supergroup'],
    [new Api.ChannelForbidden({ id: bigInt(789), title: 'Forbidden channel', accessHash: bigInt(1), broadcast: true }), '-100789', 'channel'],
  ];
  for (const [entity, expected, type] of cases) {
    const message = new Api.Message({ id: 5, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: 'hello' });
    message.getChat = async () => entity;
    message.getSender = async () => user;
    const mapped = await makeDriver().mapMessage(message);
    assert.equal(String(mapped.chat.id), expected, entity.className);
    assert.equal(mapped.chat.type, type, entity.className);
    assert.equal(getPeerId(entity), expected, entity.className);
  }
});

test('forum message mapping preserves the root topic ID from Telegram reply headers', async () => {
  const user = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  const message = new Api.Message({ id: 70, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), date: 1, message: 'topic reply' });
  message.replyTo = { replyToMsgId: 65, replyToTopId: 55 };
  message.getChat = async () => user;
  message.getSender = async () => user;
  const mapped = await makeDriver().mapMessage(message);
  assert.equal(mapped.topicId, 55);
  message.replyTo = { replyToMsgId: 58, forumTopic: true };
  assert.equal((await makeDriver().mapMessage(message)).topicId, 58);
});

test('forum topic edit service messages carry the changed topic properties', async () => {
  const user = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  const message = new Api.Message({ id: 70, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), date: 1, message: '' });
  message.replyTo = { replyToMsgId: 65, replyToTopId: 55 };
  message.action = new Api.MessageActionTopicEdit({ title: 'Renamed', iconEmojiId: bigInt(9876), closed: true, hidden: false });
  message.getChat = async () => user;
  message.getSender = async () => user;
  const mapped = await makeDriver().mapMessage(message);
  assert.equal(mapped.topicId, 55);
  assert.deepEqual(mapped.topicUpdate, { title: 'Renamed', closed: true, hidden: false, iconEmojiId: '9876' });
  assert.equal(mapped.service.type, 'topic_edited');
});

test('ordinary group invitations use positive raw chat ID and channel failures are not retried as group requests', async () => {
  const calls = [];
  const driver = makeDriver({
    getInputEntity: async peer => peer === -123n
      ? new Api.InputPeerChat({ chatId: bigInt(123) })
      : new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(2) }),
    invoke: async request => { calls.push(request); if (request instanceof Api.channels.InviteToChannel) throw new Error('forbidden'); },
  });
  await driver.inviteUser(-123, 42);
  assert.ok(calls[0] instanceof Api.messages.AddChatUser);
  assert.equal(calls[0].chatId.toString(), '123');
  await assert.rejects(driver.inviteUser(-100456, 42), /forbidden/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1] instanceof Api.channels.InviteToChannel);
});

test('a missing group entity never turns a group message into a private chat', async () => {
  const sender = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  for (const [peer, id, type] of [
    [new Api.PeerChat({ chatId: bigInt(123) }), -123, 'group'],
    [new Api.PeerChannel({ channelId: bigInt(456) }), -100456, 'unknown'],
  ]) {
    const message = new Api.Message({ id: 5, peerId: peer, date: 1, message: 'hello' });
    message.getChat = async () => undefined;
    message.getSender = async () => sender;
    const mapped = await makeDriver().mapMessage(message);
    assert.equal(mapped.chat.id, id);
    assert.equal(mapped.chat.type, type);
    assert.equal(mapped.chat.firstName, undefined);
  }
});

test('message-derived channel peers are converted to the matching input channel', async () => {
  const origin = new Api.InputPeerChat({ chatId: bigInt(11) });
  const source = new Api.InputPeerChannelFromMessage({ peer: origin, msgId: 5, channelId: bigInt(456) });
  let request;
  const driver = makeDriver({ getInputEntity: async () => source, invoke: async value => { request = value; } });
  await driver.inviteUser(-100456, 42);
  assert.ok(request.channel instanceof Api.InputChannelFromMessage);
  assert.equal(request.channel.channelId.toString(), '456');
  assert.equal(request.channel.msgId, 5);
});

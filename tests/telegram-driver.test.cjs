'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

function driverWith(client) {
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = client;
  driver.pendingMessageReports = new Map();
  return driver;
}

test('plain text is not parsed for sends, edits or media captions', async () => {
  const calls = [];
  const driver = driverWith({
    sendMessage: async (peer, options) => { calls.push(options); return { id: 1 }; },
    editMessage: async (peer, options) => { calls.push(options); return { id: 1 }; },
    sendFile: async (peer, options) => { calls.push(options); return { id: 1 }; },
  });
  await driver.sendMessage(123, '**literal**', { parseMode: 'plain' });
  await driver.editMessage(123, 1, '**literal**', { parseMode: 'plain' });
  await driver.sendMedia(123, 'file.ogg', 'voice', {
    caption: '**literal**', parseMode: 'plain', schedule: 200, silent: true, replyTo: 3,
  });
  assert.deepEqual(calls.map(c => c.parseMode), [false, false, false]);
  assert.equal(calls[0].message, '**literal**');
  assert.equal(calls[1].text, '**literal**');
  assert.equal(calls[2].caption, '**literal**');
  assert.equal(calls[2].scheduleDate, 200);
  assert.equal(calls[2].silent, true);
  assert.equal(calls[2].replyTo, 3);
  assert.equal(calls[2].voiceNote, true);
});

test('Markdown sends, edits and captions use the same editor parser', async () => {
  const calls = [];
  const driver = driverWith({
    sendMessage: async (peer, options) => { calls.push(options); return { id: 1 }; },
    editMessage: async (peer, options) => { calls.push(options); return { id: 1 }; },
    sendFile: async (peer, options) => { calls.push(options); return { id: 1 }; },
  });
  await driver.sendMessage(123, '**bold** ~~strike~~', { parseMode: 'markdown' });
  await driver.editMessage(123, 1, '**bold** ~~strike~~', { parseMode: 'markdown' });
  await driver.sendPhoto(123, 'file.jpg', { caption: '**bold** ~~strike~~', parseMode: 'markdown' });
  assert.ok(calls.every(c => typeof c.parseMode.parse === 'function'));
  assert.ok(calls.every(c => c.parseMode === calls[0].parseMode));
  assert.deepEqual([calls[0].message, calls[1].text, calls[2].caption], Array(3).fill('**bold** ~~strike~~'));
});

test('video-note option reaches GramJS video upload attributes', async () => {
  const calls = [];
  const driver = driverWith({ sendFile: async (_peer, options) => { calls.push(options); return { id: 8 }; } });
  assert.equal(await driver.sendVideo(123, 'video.mp4', { videoNote: true }), 8);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].videoNote, true);
  await assert.rejects(driver.sendMedia(123, 'video.mp4', 'video', { videoNote: true, paidStars: 10 }), /付费媒体/);
});

test('failed send does not silently create a second request', async () => {
  let count = 0;
  const driver = driverWith({ sendMessage: async () => { count++; throw new Error('timeout'); } });
  await assert.rejects(driver.sendMessage(123, '**text**', { parseMode: 'markdown' }), /timeout/);
  assert.equal(count, 1);
});

test('Telegram dice results map safely and use native SendMedia for supported dice', async () => {
  const { Api } = require('telegram');
  const user = new Api.User({ id: BigInt(9), firstName: 'Tester' });
  const message = new Api.Message({ id: 42, date: 100, message: '', media: new Api.MessageMediaDice({ value: 5, emoticon: '🎯' }) });
  message.getChat = async () => user;
  message.getSender = async () => user;
  const calls = [];
  const driver = driverWith({ invoke: async request => {
    calls.push(request);
    return { updates: [{ className: 'UpdateMessageID', id: 43 }] };
  } });
  driver.resolvePeer = chatId => BigInt(chatId);
  const topicChecks = [];
  driver.assertForumReply = async (...args) => topicChecks.push(args);

  const mapped = await driver.mapMessage(message);
  assert.deepEqual(mapped.media, { type: 'dice', diceEmoji: '🎯', diceValue: 5 });
  assert.equal(await driver.sendDice(-100123, '🎯', 21), 43);
  assert.equal(calls[0].className, 'messages.SendMedia');
  assert.ok(calls[0].media instanceof Api.InputMediaDice);
  assert.equal(calls[0].media.emoticon, '🎯');
  assert.equal(calls[0].replyTo.replyToMsgId, 21);
  assert.equal(calls[0].replyTo.topMsgId, 21);
  assert.deepEqual(topicChecks, [[-100123, 21, 21]]);
  await assert.rejects(driver.sendDice(-100123, '🧨'), /Invalid Telegram dice request/);
  assert.equal(calls.length, 1);
});

test('shared Telegram stories map to their original peer and record whether this account owns them', async () => {
  const { Api } = require('telegram');
  const user = new Api.User({ id: BigInt(9), firstName: 'Sender' });
  const message = new Api.Message({ id: 45, date: 100, message: '', media: new Api.MessageMediaStory({
    peer: new Api.PeerUser({ userId: BigInt(77) }), id: 12,
  }) });
  message.getChat = async () => user;
  message.getSender = async () => user;
  const driver = driverWith({});
  driver.selfId = 77;
  const mapped = await driver.mapMessage(message);
  assert.deepEqual(mapped.media, { type: 'story', storyChatId: 77, storyId: 12, storyIsSelf: true });
});

test('Telegram message entities preserve a blockquote collapsed flag for the web renderer', async () => {
  const { Api } = require('telegram');
  const user = new Api.User({ id: BigInt(9), firstName: 'Sender' });
  const message = new Api.Message({ id: 46, date: 100, message: '引用内容', entities: [
    new Api.MessageEntityBlockquote({ offset: 0, length: 4, collapsed: true }),
  ] });
  message.getChat = async () => user;
  message.getSender = async () => user;
  const mapped = await driverWith({}).mapMessage(message);
  assert.deepEqual(mapped.entities, [{ type: 'MessageEntityBlockquote', offset: 0, length: 4,
    url: undefined, userId: undefined, documentId: undefined, collapsed: true }]);
});

test('message deletion preserves revoke choice', async () => {
  const calls = [];
  const driver = driverWith({ deleteMessages: async (peer, ids, options) => calls.push({ peer, ids, options }) });
  await driver.deleteMessages(123, [1], false);
  await driver.deleteMessages(123, [2]);
  assert.equal(calls[0].options.revoke, false);
  assert.equal(calls[1].options.revoke, true);
});

test('mark as read propagates failures', async () => {
  const driver = driverWith({ markAsRead: async () => { throw new Error('offline'); } });
  await assert.rejects(driver.markAsRead(123, 42), /offline/);
});

test('message fact-check metadata maps safely and details load through Telegram on demand', async () => {
  const { Api } = require('telegram');
  const factCheck = new Api.FactCheck({ needCheck: true, country: 'US', hash: BigInt(7) });
  const message = new Api.Message({ id: 42, message: 'Claim', date: 100, factcheck: factCheck });
  message.getChat = async () => ({ className: 'Channel', id: BigInt(8), title: 'News', broadcast: true });
  message.getSender = async () => ({ className: 'User', id: BigInt(9), firstName: 'Editor', bot: false });
  const detail = new Api.FactCheck({ needCheck: false, country: 'US', hash: BigInt(7),
    text: new Api.TextWithEntities({ text: 'Verified', entities: [new Api.MessageEntityBold({ offset: 0, length: 8 })] }) });
  const calls = [];
  const driver = driverWith({ invoke: async request => { calls.push(request); return [detail]; } });
  driver.resolvePeer = id => BigInt(id);
  const mapped = await driver.mapMessage(message);
  assert.deepEqual(mapped.factChecks, [{ needCheck: true, country: 'US', hash: '7' }]);
  assert.deepEqual(await driver.getMessageFactChecks(-1008, 42), [{
    needCheck: false, country: 'US', text: 'Verified', entities: [{ type: 'MessageEntityBold', offset: 0, length: 8 }], hash: '7',
  }]);
  assert.equal(calls[0].className, 'messages.GetFactCheck');
  assert.deepEqual(calls[0].msgId, [42]);
  await assert.rejects(driver.getMessageFactChecks(-1008, 0), /Invalid fact-check request/);
});

test('message reports follow Telegram options and keep opaque option bytes behind one-use tokens', async () => {
  const { Api } = require('telegram');
  const choiceBytes = Buffer.from([1, 3, 5]);
  const commentBytes = Buffer.from([2, 4, 6]);
  const responses = [
    new Api.ReportResultChooseOption({ title: '请选择举报原因', options: [
      new Api.MessageReportOption({ text: '垃圾信息', option: choiceBytes }),
    ] }),
    new Api.ReportResultAddComment({ option: commentBytes, optional: false }),
    new Api.ReportResultReported(),
  ];
  const calls = [];
  const driver = driverWith({ invoke: async request => { calls.push(request); return responses.shift(); } });
  driver.resolvePeer = id => BigInt(id);
  const choices = await driver.startMessageReport(-10042, 9);
  assert.equal(choices.status, 'choose');
  assert.equal(choices.title, '请选择举报原因');
  assert.deepEqual(choices.options.map(option => option.text), ['垃圾信息']);
  assert.equal(typeof choices.options[0].token, 'string');
  assert.equal(calls[0].className, 'messages.Report');
  assert.deepEqual(calls[0].id, [9]);
  assert.equal(calls[0].option.length, 0);

  const comment = await driver.continueMessageReport(choices.options[0].token);
  assert.equal(comment.status, 'comment');
  assert.equal(comment.optional, false);
  assert.equal(typeof comment.token, 'string');
  await assert.rejects(driver.continueMessageReport(comment.token), /comment is required/);
  assert.deepEqual(await driver.continueMessageReport(comment.token, '重复广告'), { status: 'reported' });
  assert.deepEqual(calls[1].option, choiceBytes);
  assert.deepEqual(calls[2].option, commentBytes);
  assert.equal(calls[2].message, '重复广告');
  await assert.rejects(driver.continueMessageReport(comment.token, '重复提交'), /expired/);
  await assert.rejects(driver.startMessageReport(-10042, 0), /Invalid message report/);
});

test('scheduled text and each media type reach GramJS with scheduleDate in the MTProto request', async () => {
  const { sendFile } = require('telegram/client/uploads');
  const { sendMessage } = require('telegram/client/messages');
  const { Api } = require('telegram');
  const requests = [];
  const client = {
    getInputEntity: async () => new Api.InputPeerSelf(),
    buildReplyMarkup: () => undefined,
    invoke: async request => { requests.push(request); return {}; },
    _getResponseMessage: () => ({ id: 1 }),
  };
  client.sendFile = function (peer, params) { return sendFile(this, peer, params); };
  client.sendMessage = (peer, params) => sendMessage(client, peer, params);
  const driver = driverWith(client);
  const timestamp = 2000000000;
  await driver.sendMessage(123, 'later', { parseMode: 'plain', schedule: timestamp });
  for (const kind of ['photo', 'video', 'audio', 'document', 'voice']) {
    await driver.sendMedia(123, 'https://example.com/file.jpg', kind, { schedule: timestamp,
      ...(kind === 'photo' ? { effectId: '123', invertMedia: true } : {}) });
  }
  assert.equal(requests.length, 6);
  assert.equal(requests[0].className, 'messages.SendMessage');
  for (const request of requests.slice(1)) assert.equal(request.className, 'messages.SendMedia');
  for (const request of requests) assert.equal(request.scheduleDate, timestamp);
  assert.equal(String(requests[1].effect), '123');
  assert.equal(requests[1].invertMedia, true);
  assert.equal(requests.slice(2).some(request => request.effect != null), false);
});

test('Telegram album send carries formatting, reply, silence and schedule to the GramJS multi-media path', async () => {
  const uploads = require('telegram/client/uploads');
  const { Api } = require('telegram');
  const original = uploads._sendAlbum;
  const calls = [];
  uploads._sendAlbum = async (client, peer, options) => {
    calls.push({ client, peer, options });
    const request = new Api.messages.SendMultiMedia({ peer: new Api.InputPeerSelf(), multiMedia: [] });
    await client.invoke(request);
    calls[0].request = request;
    return [{ id: 42 }, { id: 43 }];
  };
  try {
    const client = { invoke: async () => ({}) };
    const driver = driverWith(client);
    const result = await driver.sendMediaAlbum(123, ['/tmp/one.jpg', '/tmp/two.mp4'], {
      caption: '**album**', parseMode: 'markdown', replyTo: 8, silent: true, schedule: 1900000000, effectId: '456',
      invertMedia: true,
    });
    assert.equal(result, 42);
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].client, client, 'effects use an operation-scoped client proxy');
    assert.equal(String(calls[0].peer), '123');
    assert.deepEqual(calls[0].options.file, ['/tmp/one.jpg', '/tmp/two.mp4']);
    assert.equal(calls[0].options.caption, '**album**');
    assert.equal(calls[0].options.silent, true);
    assert.equal(calls[0].options.scheduleDate, 1900000000);
    assert.equal(calls[0].options.replyTo, 8);
    assert.equal(String(calls[0].request.effect), '456');
    assert.equal(calls[0].request.invertMedia, true);
    assert.equal(typeof calls[0].options.parseMode.parse, 'function');
    await assert.rejects(driver.sendMediaAlbum(123, ['/tmp/only.jpg']), /2 到 10/);
  } finally {
    uploads._sendAlbum = original;
  }
});

test('reply keyboard phone and location sends re-read the bot request before disclosure', async () => {
  const { Api } = require('telegram');
  const bot = new Api.User({ id: 21, bot: true, accessHash: 1 });
  const buttons = [new Api.KeyboardButtonRequestPhone({ text: 'Phone' }), new Api.KeyboardButtonRequestGeoLocation({ text: 'Location' })];
  const message = { id: 55, replyMarkup: new Api.ReplyKeyboardMarkup({ rows: [new Api.KeyboardButtonRow({ buttons })] }), getSender: async () => bot };
  const calls = [];
  const client = {
    getMessages: async (peer, options) => { calls.push({ kind: 'read', peer, options }); return [message]; },
    getMe: async () => new Api.User({ id: 99, firstName: 'Alice', lastName: 'Owner', phone: '+15551234567' }),
    invoke: async request => { calls.push({ kind: 'invoke', request }); return { updates: [] }; },
  };
  const driver = driverWith(client);
  await driver.sendReplyKeyboardPhone(123, 55, 0, 0);
  await driver.sendReplyKeyboardLocation(123, 55, 0, 1, 37.5, -122.2);
  const contact = calls.find(call => call.kind === 'invoke' && call.request.media instanceof Api.InputMediaContact);
  const geo = calls.find(call => call.kind === 'invoke' && call.request.media instanceof Api.InputMediaGeoPoint);
  assert.ok(contact);
  assert.equal(contact.request.media.phoneNumber, '+15551234567');
  assert.equal(contact.request.peer.toString(), '123');
  assert.ok(geo);
  assert.equal(geo.request.media.geoPoint.lat, 37.5);
  assert.equal(geo.request.media.geoPoint.long, -122.2);

  const before = calls.length;
  message.replyMarkup.rows[0].buttons[0] = new Api.KeyboardButton({ text: 'ordinary' });
  await assert.rejects(driver.sendReplyKeyboardPhone(123, 55, 0, 0), /did not request/);
  assert.equal(calls.length, before + 1, 'only the message read happens before rejecting a changed button');
});

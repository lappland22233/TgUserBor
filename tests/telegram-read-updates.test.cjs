'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { mapChatRawUpdate } = require('../dist/bot/driver/update-mapping');

test('real Telegram outbox updates use marked peer IDs and reject invalid ranges', () => {
  const user = new Api.UpdateReadHistoryOutbox({ peer: new Api.PeerUser({userId:bigInt(7)}), maxId: 20, pts: 1, ptsCount: 1 });
  const group = new Api.UpdateReadHistoryOutbox({ peer: new Api.PeerChat({chatId:bigInt(42)}), maxId: 21, pts: 1, ptsCount: 1 });
  const channel = new Api.UpdateReadChannelOutbox({ channelId:bigInt(91), maxId: 22 });
  assert.deepEqual(mapChatRawUpdate(user), {kind:'read',chatId:7,maxId:20});
  assert.deepEqual(mapChatRawUpdate(group), {kind:'read',chatId:-42,maxId:21});
  assert.deepEqual(mapChatRawUpdate(channel), {kind:'read',chatId:-10091,maxId:22});
  assert.equal(mapChatRawUpdate({className:'UpdateReadHistoryOutbox',peer:user.peer,maxId:0}), undefined);
});
test('real Telegram typing updates preserve group and channel sender IDs', () => {
  const action = new Api.SendMessageTypingAction();
  const group = new Api.UpdateChatUserTyping({chatId:bigInt(42),fromId:new Api.PeerUser({userId:bigInt(7)}),action});
  const channel = new Api.UpdateChannelUserTyping({channelId:bigInt(91),fromId:new Api.PeerUser({userId:bigInt(7)}),action});
  assert.deepEqual(mapChatRawUpdate(group), {kind:'typing',chatId:-42,userId:7,action:'SendMessageTypingAction'});
  assert.deepEqual(mapChatRawUpdate(channel), {kind:'typing',chatId:-10091,userId:7,action:'SendMessageTypingAction'});
});
test('real Telegram presence updates preserve timestamp units and privacy', () => {
  const online = new Api.UpdateUserStatus({userId:bigInt(7),status:new Api.UserStatusOnline({expires:200})});
  const offline = new Api.UpdateUserStatus({userId:bigInt(7),status:new Api.UserStatusOffline({wasOnline:1700000000})});
  const recent = new Api.UpdateUserStatus({userId:bigInt(7),status:new Api.UserStatusRecently({})});
  assert.deepEqual(mapChatRawUpdate(online), {kind:'status',userId:7,online:true,lastSeen:undefined});
  assert.deepEqual(mapChatRawUpdate(offline), {kind:'status',userId:7,online:false,lastSeen:1700000000000});
  assert.deepEqual(mapChatRawUpdate(recent), {kind:'status',userId:7,online:false,lastSeen:undefined});
});
test('Telegram auto-delete updates map to the same marked peer ids as dialogs', () => {
  const peer = new Api.PeerChannel({channelId:bigInt(91)});
  const update = new Api.UpdatePeerHistoryTTL({peer, ttlPeriod:86400, pts:2, ptsCount:1});
  assert.deepEqual(mapChatRawUpdate(update), {kind:'historyTtl',chatId:-10091,period:86400});
  assert.deepEqual(mapChatRawUpdate({className:'UpdatePeerHistoryTTL',peer,ttlPeriod:0}), {kind:'historyTtl',chatId:-10091,period:0});
  assert.equal(mapChatRawUpdate({className:'UpdatePeerHistoryTTL',peer,ttlPeriod:31536001}), undefined);
});

test('Telegram peer wallpaper updates preserve marked user, group, and channel IDs', () => {
  const updates = [
    { peer: new Api.PeerUser({ userId: bigInt(7) }) },
    { peer: new Api.PeerChat({ chatId: bigInt(42) }) },
    { peer: new Api.PeerChannel({ channelId: bigInt(91) }) },
  ];
  assert.deepEqual(updates.map(update => mapChatRawUpdate({ className: 'UpdatePeerWallpaper', ...update })), [
    { kind: 'wallpaper', chatId: 7 },
    { kind: 'wallpaper', chatId: -42 },
    { kind: 'wallpaper', chatId: -10091 },
  ]);
  assert.equal(mapChatRawUpdate({ className: 'UpdatePeerWallpaper' }), undefined);
});

test('Telegram story and story-read updates preserve the same marked peer IDs as chat history', () => {
  const peer = new Api.PeerChannel({ channelId: bigInt(91) });
  assert.deepEqual(mapChatRawUpdate({ className: 'UpdateStory', peer, story: { id: 31 } }), {
    kind: 'stories', chatId: -10091, storyId: 31,
  });
  assert.deepEqual(mapChatRawUpdate({ className: 'UpdateReadStories', peer, maxId: 32 }), {
    kind: 'stories', chatId: -10091, maxReadId: 32,
  });
  assert.equal(mapChatRawUpdate({ className: 'UpdateStory', peer: undefined, story: { id: 31 } }), undefined);
});

test('Telegram story reaction and stealth updates map to account-scoped refresh events', () => {
  const peer = new Api.PeerUser({ userId: bigInt(77) });
  const reaction = new Api.UpdateSentStoryReaction({ peer, storyId: 33, reaction: new Api.ReactionEmoji({ emoticon: '❤️' }) });
  assert.deepEqual(mapChatRawUpdate(reaction), { kind: 'stories', chatId: 77, storyId: 33 });
  assert.deepEqual(mapChatRawUpdate({ className: 'UpdateStoriesStealthMode', stealthMode: {} }), { kind: 'storiesStealth' });
});

test('Telegram pinned forum topic updates preserve the channel peer ID', () => {
  const pinned = new Api.UpdateChannelPinnedTopic({ channelId: bigInt(91), topicId: 5, pinned: true });
  const order = new Api.UpdateChannelPinnedTopics({ channelId: bigInt(91), order: [5, 7] });
  assert.deepEqual(mapChatRawUpdate(pinned), { kind: 'forumTopics', chatId: -10091 });
  assert.deepEqual(mapChatRawUpdate(order), { kind: 'forumTopics', chatId: -10091 });
  assert.equal(mapChatRawUpdate({ className: 'UpdateChannelPinnedTopic', channelId: bigInt(0), topicId: 5 }), undefined);
});

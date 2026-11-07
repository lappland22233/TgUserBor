'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const http = require('node:http');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('story viewers are fetched only for the signed-in account and mapped with the Telegram cursor', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.client = { invoke: async request => {
    calls.push(request);
    const channel = new Api.Channel({ id: bigInt(55), accessHash: bigInt(7), title: 'Public channel', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true });
    return {
      count: 5, viewsCount: 3, reactionsCount: 1, forwardsCount: 2, nextOffset: 'opaque-next',
      users: [{ id: bigInt(77), firstName: 'Viewer', lastName: 'One', username: 'viewer1' }],
      chats: [channel],
      views: [new Api.StoryView({ userId: bigInt(77), date: 123, reaction: new Api.ReactionEmoji({ emoticon: '❤️' }) }),
        new Api.StoryViewPublicForward({ message: { id: 101, peerId: new Api.PeerChannel({ channelId: bigInt(55) }), date: 124, message: 'forwarded post' } }),
        new Api.StoryViewPublicRepost({ peerId: new Api.PeerChannel({ channelId: bigInt(55) }), story: { id: 12, date: 125, caption: 'reposted story' } })],
    };
  } };
  const page = await driver.getStoryViewers(42, 9, 'opaque-old', 100, 'forwards');
  assert.equal(calls[0].className, 'stories.GetStoryViewsList');
  assert.equal(calls[0].id, 9); assert.equal(calls[0].offset, 'opaque-old'); assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].forwardsFirst, true);
  assert.equal(page.viewsCount, 3); assert.equal(page.nextOffset, 'opaque-next');
  assert.deepEqual(page.viewers[0], { user: { id: 77, firstName: 'Viewer', lastName: 'One', username: 'viewer1', isBot: false, phone: undefined }, date: 123, reaction: '❤️' });
  assert.deepEqual(page.forwards, [
    { type: 'forward', title: 'Public channel', peerId: -10055, messageId: 101, date: 124, text: 'forwarded post' },
    { type: 'repost', title: 'Public channel', peerId: -10055, storyId: 12, date: 125, text: 'reposted story' },
  ]);
  await assert.rejects(driver.getStoryViewers(-100, 9), /Invalid story viewers request/);
  assert.equal(calls.length, 1);
});

test('story viewers route validates pagination and dispatches only the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params }); return { count: 1, viewers: [] };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/views`;
    assert.equal((await fetch(`${base}?chatId=42&storyId=9&limit=51`)).status, 400);
    const response = await fetch(`${base}?chatId=42&storyId=9&offset=opaque&limit=20&kind=forwards`);
    assert.equal(response.status, 200);
    assert.equal(calls[0].action, 'get_story_viewers');
    assert.deepEqual(calls[0].params, { chatId: 42, storyId: 9, offset: 'opaque', limit: 20, kind: 'forwards' });
    assert.equal((await fetch(`${base}?chatId=42&storyId=9&kind=unknown`)).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('peer story hidden state is read from the user and can be toggled through Telegram', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = id => BigInt(id);
  driver.client = {
    getEntity: async () => new Api.User({ id: bigInt(77), firstName: 'Peer', storiesHidden: true }),
    invoke: async request => {
      calls.push(request);
      return request.className === 'users.GetFullUser' ? { fullUser: { about: 'Bio' } } : true;
    },
  };
  driver.getUserPhotos = async () => [];
  driver.getPeerStories = async () => [];
  const profile = await driver.getPeerProfile(77);
  assert.equal(profile.storiesHidden, true);
  await driver.setPeerStoriesHidden(77, false);
  assert.equal(calls.at(-1).className, 'stories.TogglePeerStoriesHidden');
  assert.equal(calls.at(-1).peer.toString(), '77');
  assert.equal(calls.at(-1).hidden, false);
  await assert.rejects(driver.setPeerStoriesHidden(42, true), /Invalid peer stories visibility request/);
});

test('peer story visibility endpoint validates input and dispatches to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/hidden`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 0, hidden: true })).status, 400);
    assert.equal((await post({ chatId: 77, hidden: false })).status, 200);
    assert.deepEqual(calls, [{ action: 'set_peer_stories_hidden', payload: { chatId: 77, hidden: false } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram story lookup reads one story ID and maps its current metadata', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => { assert.equal(chatId, 77); return new Api.InputPeerUser({ userId: bigInt(77), accessHash: bigInt(88) }); };
  const item = new Api.StoryItem({ id: 12, date: 100, expireDate: 200, caption: 'Updated', media: new Api.MessageMediaUnsupported(), pinned: true });
  driver.client = { invoke: async request => { calls.push(request); return { stories: [item] }; } };
  assert.deepEqual(await driver.getStoryById(77, 12), {
    id: 12, date: 100, expireDate: 200, caption: 'Updated', isPinned: true, mediaType: 'unknown',
    sentReaction: undefined, viewsCount: 0, reactionsCount: 0, forwardsCount: 0,
  });
  assert.ok(calls[0] instanceof Api.stories.GetStoriesByID);
  assert.deepEqual(calls[0].id, [12]);
  assert.equal(await driver.getStoryById(77, 13), undefined);
  await assert.rejects(driver.getStoryById(0, 12), /Invalid Telegram story request/);
  assert.equal(calls.length, 2);
});

test('single-story HTTP lookup validates IDs and returns private account-scoped data', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => {
    calls.push(args); return { id: 12, caption: 'Updated' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/story`;
    assert.equal((await fetch(`${base}?chatId=0&storyId=12`)).status, 400);
    const response = await fetch(`${base}?chatId=77&storyId=12`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), { id: 12, caption: 'Updated' });
    assert.deepEqual(calls, [['get_story_by_id', { chatId: 77, storyId: 12 }]]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

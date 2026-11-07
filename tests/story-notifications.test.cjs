'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('story notification settings use Telegram peer notify settings without changing message mute values', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = id => new Api.InputPeerUser({ userId: BigInt(id), accessHash: BigInt(0) });
  driver.client = { invoke: async request => {
    calls.push(request);
    return request.className === 'account.GetNotifySettings' ? new Api.PeerNotifySettings({ storiesMuted: true }) : true;
  } };
  assert.equal(await driver.getPeerStoriesNotificationsMuted(77), true);
  await driver.setPeerStoriesNotificationsMuted(77, false);
  assert.equal(calls[0].className, 'account.GetNotifySettings');
  assert.equal(calls[0].peer.className, 'InputNotifyPeer');
  assert.equal(calls[0].peer.peer.userId.toString(), '77');
  assert.equal(calls[1].className, 'account.UpdateNotifySettings');
  assert.equal(calls[1].settings.storiesMuted, false);
  assert.equal(calls[1].settings.muteUntil, undefined);
  await assert.rejects(driver.setPeerStoriesNotificationsMuted(42, true), /Invalid story notification setting/);
  assert.equal(calls.length, 2);
});

test('story notification routes validate peers and only dispatch the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return action === 'get_story_notifications_muted' ? { muted: true } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/notifications`;
    assert.equal((await fetch(`${url}?chatId=0`)).status, 400);
    const get = await fetch(`${url}?chatId=77`);
    assert.equal(get.status, 200); assert.deepEqual(await get.json(), { muted: true });
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 77, muted: 'false' })).status, 400);
    assert.equal((await post({ chatId: 77, muted: false })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_story_notifications_muted', payload: { chatId: 77 } },
      { action: 'set_story_notifications_muted', payload: { chatId: 77, muted: false } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('story viewer reads and toggles reminders for the current peer only', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nasync function activateStoryStealth(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 3, currentProfileChatId: 77 };
  const button = { disabled: true, textContent: '', title: '' };
  const viewer = { session: null, notifications: button, status: { textContent: '' } };
  const calls = [];
  const context = vm.createContext({ state, storyViewer: viewer, encodeURIComponent,
    api: async (url, method, body) => { calls.push({ url, method, body }); return method === 'POST' ? {} : { muted: false }; },
  });
  vm.runInContext(`let profileRequestId = 9; let storyFeedEpoch = 0;\n${source.slice(start, end)}\nthis.load = loadStoryNotificationSetting; this.toggle = toggleStoryNotificationSetting;`, context);
  const session = { instId: 'a', chatId: 77, selectionVersion: 3, profileRequestId: 9, source: 'profile', isSelf: false, storyNotificationsPending: true };
  viewer.session = session;
  await context.load(session);
  assert.equal(button.textContent, '静音动态提醒'); assert.equal(button.disabled, false);
  await context.toggle();
  assert.equal(session.storyNotificationsMuted, true);
  assert.equal(button.textContent, '恢复动态提醒');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: '/api/instances/a/account/stories/notifications?chatId=77' },
    { url: '/api/instances/a/account/stories/notifications', method: 'POST', body: { chatId: 77, muted: true } },
  ]);
  assert.equal(viewer.status.textContent, '已静音此联系人的动态提醒。');
});

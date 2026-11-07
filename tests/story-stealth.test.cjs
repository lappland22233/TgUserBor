'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('story stealth status reads Telegram state and activation enables past and future hiding', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'stories.ActivateStealthMode') return { updates: [] };
    return { stealthMode: new Api.StoriesStealthMode({ activeUntilDate: 12345, cooldownUntilDate: 67890 }) };
  } };
  assert.deepEqual(await driver.getStoryStealthStatus(), { activeUntilDate: 12345, cooldownUntilDate: 67890 });
  assert.deepEqual(await driver.activateStoryStealth(), { activeUntilDate: 12345, cooldownUntilDate: 67890, activated: true });
  assert.equal(calls[0].className, 'stories.GetAllStories');
  assert.equal(calls[1].className, 'stories.ActivateStealthMode');
  assert.equal(calls[1].past, true);
  assert.equal(calls[1].future, true);
  assert.equal(calls[2].className, 'stories.GetAllStories');
});

test('story stealth activation still reports success when Telegram status refresh fails', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'stories.ActivateStealthMode') return { updates: [] };
    throw new Error('temporary status failure');
  } };
  assert.deepEqual(await driver.activateStoryStealth(), { activated: true });
  assert.equal(calls.length, 2);
});

test('story stealth endpoints read status and activate only the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async action => {
    calls.push(action);
    return action === 'get_story_stealth_status' ? { activeUntilDate: 123 } : { activated: true };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/stealth`;
    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { activeUntilDate: 123 });
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ future: false })).status, 400);
    const activated = await post({});
    assert.equal(activated.status, 200);
    assert.deepEqual(await activated.json(), { activated: true });
    assert.deepEqual(calls, ['get_story_stealth_status', 'activate_story_stealth']);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('story viewer loads stealth state and ignores activation after changing profiles', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nasync function setStoryPeerHidden(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'account-a', chatSelectionVersion: 5, currentProfileChatId: 77 };
  const stealthButton = { disabled: false, textContent: '', title: '' };
  const viewer = { session: null, stealth: stealthButton, status: { textContent: '' } };
  const calls = [];
  let resolveApi;
  const context = vm.createContext({ state, storyViewer: viewer, encodeURIComponent,
    api: (url, method, body) => {
      calls.push({ url, method, body });
      if (method === 'POST') return new Promise(resolve => { resolveApi = resolve; });
      return Promise.resolve({});
    },
  });
  vm.runInContext(`let profileRequestId = 9;\n${source.slice(start, end)}\nthis.load = loadStoryStealthStatus; this.activate = activateStoryStealth;`, context);
  const session = { instId: 'account-a', chatId: 77, selectionVersion: 5, profileRequestId: 9, isSelf: false };
  viewer.session = session;
  await context.load(session);
  assert.equal(stealthButton.disabled, false);
  assert.equal(session.stealthStatusPending, false);
  assert.equal(calls[0].url, '/api/instances/account-a/account/stories/stealth');

  const pending = context.activate();
  assert.equal(stealthButton.disabled, true);
  assert.equal(stealthButton.textContent, '正在启用…');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { url: '/api/instances/account-a/account/stories/stealth', method: 'POST', body: {} });
  state.currentProfileChatId = 99;
  resolveApi({ activated: true });
  await pending;
  assert.equal(stealthButton.textContent, '正在启用…');
  assert.equal(viewer.status.textContent, '');
});

test('hidden chat buttons and quick reply forms stay hidden despite flex layout styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/gui/web/style.css'), 'utf8');
  assert.match(css, /\.chat-side-btn\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.quick-reply-create-form\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram story links use the selected peer and story ID', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async request => { calls.push(request); return new Api.ExportedStoryLink({ link: 'https://t.me/example/s/9' }); } };
  assert.equal(await driver.exportStoryLink(42, 9), 'https://t.me/example/s/9');
  assert.ok(calls[0] instanceof Api.stories.ExportStoryLink);
  assert.equal(calls[0].peer, 42n);
  assert.equal(calls[0].id, 9);
  await assert.rejects(driver.exportStoryLink(0, 9), /Invalid story link request/);
  await assert.rejects(driver.exportStoryLink(42, 0), /Invalid story link request/);
  assert.equal(calls.length, 1);
});

test('story link route validates IDs and returns only the requested account link', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return { link: 'https://t.me/example/s/9' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/link`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 0, storyId: 9 })).status, 400);
    const response = await post({ chatId: 42, storyId: 9 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { link: 'https://t.me/example/s/9' });
    assert.deepEqual(calls, [{ action: 'export_story_link', payload: { chatId: 42, storyId: 9 } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('story viewer copies the Telegram link only while that story remains selected', async () => {
  const copied = [], calls = [];
  const story = { id: 9 };
  const session = { instId: 'a', chatId: 42, stories: [story], index: 0 };
  const viewer = { session, copyLink: { disabled: false }, status: { textContent: '' } };
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function copyStoryLink(');
  const end = source.indexOf('\nasync function loadPeerProfile(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ storyViewer: viewer, encodeURIComponent, navigator: { clipboard: { writeText: async link => copied.push(link) } },
    api: async (url, method, body) => { calls.push({ url, method, body }); return { link: 'https://t.me/example/s/9' }; } });
  vm.runInContext(`${source.slice(start, end)}\nthis.copy = copyStoryLink;`, context);
  await context.copy();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/api/instances/a/account/stories/link', method: 'POST', body: { chatId: 42, storyId: 9 } }]);
  assert.deepEqual(copied, ['https://t.me/example/s/9']);
  assert.equal(viewer.status.textContent, '动态链接已复制');
  assert.equal(viewer.copyLink.disabled, false);
});

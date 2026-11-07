'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('story replies use Telegram InputReplyToStory and the selected peer', async () => {
  const calls = [];
  const peer = new Api.InputPeerUser({ userId: bigInt(77), accessHash: bigInt(99) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async id => { assert.equal(id, 77n); return peer; },
    invoke: async request => { calls.push(request); return { updates: [] }; },
  };
  await driver.replyToStory(77, 12, 'Hello **story**', 'markdown');
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.messages.SendMessage);
  assert.equal(calls[0].peer, peer);
  assert.equal(calls[0].replyTo.className, 'InputReplyToStory');
  assert.equal(calls[0].replyTo.peer, peer);
  assert.equal(calls[0].replyTo.storyId, 12);
  assert.equal(calls[0].message, 'Hello story');
  assert.equal(calls[0].entities[0].className, 'MessageEntityBold');
  assert.equal(calls[0].noWebpage, true);
  assert.ok(calls[0].randomId);
  driver.selfId = 77;
  await assert.rejects(driver.replyToStory(77, 12, 'reply'), /Invalid story reply/);
  await assert.rejects(driver.replyToStory(88, 0, 'reply'), /Invalid story reply/);
  await assert.rejects(driver.replyToStory(88, 12, '   '), /Invalid story reply/);
  assert.equal(calls.length, 1);
});

test('story reply route validates text and dispatches the selected Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/reply`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 77, storyId: 0, text: 'Hi' })).status, 400);
    assert.equal((await post({ chatId: 77, storyId: 12, text: ' ' })).status, 400);
    assert.equal((await post({ chatId: 77, storyId: 12, text: 'Hi', parseMode: 'bad' })).status, 400);
    assert.equal((await post({ chatId: 77, storyId: 12, text: 'Hi', parseMode: 'markdown' })).status, 200);
    assert.deepEqual(calls, [{ action: 'reply_to_story', payload: { chatId: 77, storyId: 12, text: 'Hi', parseMode: 'markdown' } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('story reply UI sends to the current story and preserves later typed text', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function replyToStory() {');
  const end = source.indexOf('\nasync function loadPeerProfile(', start);
  assert.ok(start >= 0 && end > start);
  const input = { value: 'reply', disabled: false };
  const button = { disabled: false };
  const status = { textContent: '' };
  const session = { instId: 'a', chatId: 77, index: 0, stories: [{ id: 12 }], isSelf: false, replyPending: false };
  const viewer = { session, replyInput: input, replyButton: button, status };
  const calls = [];
  let resolveSend;
  const context = vm.createContext({ storyViewer: viewer, state: { clientParseMode: 'markdown' }, encodeURIComponent,
    api: (url, method, body) => { calls.push({ url, method, body }); return new Promise(resolve => { resolveSend = resolve; }); },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.reply = replyToStory;`, context);
  const pending = context.reply();
  assert.equal(button.disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    url: '/api/instances/a/account/stories/reply', method: 'POST',
    body: { chatId: 77, storyId: 12, text: 'reply', parseMode: 'markdown' },
  });
  input.value = 'newer text';
  resolveSend({ success: true });
  await pending;
  assert.equal(input.value, 'newer text');
  assert.equal(status.textContent, '回复已发送');
  assert.equal(button.disabled, false);
});

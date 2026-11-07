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

test('Telegram group and channel titles and descriptions use their native edit methods', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => chatId === -42
    ? new Api.InputPeerChat({ chatId: bigInt(42) })
    : new Api.InputPeerChannel({ channelId: bigInt(84), accessHash: bigInt(7) });
  driver.client = {
    getInputEntity: async peer => peer,
    invoke: async request => { calls.push(request); return true; },
  };

  await driver.setChatTitle(-42, '  Group name  ');
  assert.ok(calls[0] instanceof Api.messages.EditChatTitle);
  assert.equal(calls[0].title, 'Group name');
  assert.equal(calls[0].chatId.toString(), '42');
  await driver.setChatTitle(-10084, 'Channel name');
  assert.ok(calls[1] instanceof Api.channels.EditTitle);
  assert.equal(calls[1].title, 'Channel name');
  await driver.setChatDescription(-10084, 'Updated description');
  assert.ok(calls[2] instanceof Api.messages.EditChatAbout);
  assert.equal(calls[2].about, 'Updated description');
  await assert.rejects(driver.setChatTitle(42, 'No'), /Invalid Telegram chat title/);
  await assert.rejects(driver.setChatDescription(-42, 'x'.repeat(256)), /Invalid Telegram chat description/);
  assert.equal(calls.length, 3);
});

test('Telegram public usernames are availability-checked before changing channel visibility', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolveAdminInputChannel = async chatId => {
    assert.equal(chatId, -10042);
    return new Api.InputChannel({ channelId: bigInt(42), accessHash: bigInt(7) });
  };
  driver.client = { invoke: async request => { calls.push(request); return request instanceof Api.channels.CheckUsername ? true : true; } };
  await driver.setChatUsername(-10042, 'newgroup');
  assert.ok(calls[0] instanceof Api.channels.CheckUsername);
  assert.equal(calls[0].username, 'newgroup');
  assert.ok(calls[1] instanceof Api.channels.UpdateUsername);
  assert.equal(calls[1].username, 'newgroup');
  await driver.setChatUsername(-10042, '');
  assert.ok(calls[2] instanceof Api.channels.UpdateUsername);
  assert.equal(calls[2].username, '');
  await assert.rejects(driver.setChatUsername(-10042, 'bad'), /Invalid Telegram public username/);
  assert.equal(calls.length, 3);
});

test('group-info HTTP routes validate fields and dispatch to the selected Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => { calls.push(args); } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const post = (route, body) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('chat-title', { chatId: 42, title: 'Group' })).status, 400);
    assert.equal((await post('chat-title', { chatId: -42, title: '  ' })).status, 400);
    assert.equal((await post('chat-title', { chatId: -42, title: 'Group' })).status, 200);
    assert.equal((await post('chat-description', { chatId: -10042, description: 'A community' })).status, 200);
    assert.equal((await post('chat-username', { chatId: -10042, username: 'bad' })).status, 400);
    assert.equal((await post('chat-username', { chatId: -10042, username: 'newgroup' })).status, 200);
    assert.deepEqual(calls, [
      ['set_chat_title', { chatId: -42, title: 'Group' }],
      ['set_chat_description', { chatId: -10042, description: 'A community' }],
      ['set_chat_username', { chatId: -10042, username: 'newgroup' }],
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element {
  constructor() { this.children = []; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; }
}

test('group-info UI edits only changed fields and refreshes the selected dialog and profile', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let groupInfoTarget = null;');
  const end = source.indexOf('\nlet groupAdminRightsTarget = null;', start);
  assert.ok(start >= 0 && end > start);
  const ids = ['modal-group-info', 'group-info-title', 'group-info-username', 'group-info-username-row', 'group-info-description',
    'group-info-status', 'btn-save-group-info', 'profile-display-name', 'client-chat-title', 'client-chat-subtitle', 'profile-username', 'profile-val-bio'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const profile = { type: 'group', title: 'Old title', username: 'oldname', bio: 'Old about' };
  const dialog = { id: -42, title: 'Old title', username: 'oldname', type: 'supergroup' };
  const calls = [];
  const context = vm.createContext({
    state: { clientSelectedInstance: 'a', clientActiveChatId: -42, clientActiveDialog: dialog, clientDialogs: [dialog],
      chatSelectionVersion: 2, currentProfileChatId: -42, currentPeerProfile: profile },
    document: { getElementById: id => elements.get(id) || null },
    window: { chatWs: { isConnected: () => false } },
    encodeURIComponent, confirm: () => true, showToast: () => {}, renderClientDialogs: () => {},
    api: async (url, method, body) => { calls.push({ url, method, body }); return { success: true }; },
  });
  vm.runInContext(`${source.slice(start, end)}
    this.open = openGroupInfoModal; this.save = saveGroupInfo; this.close = closeGroupInfoModal;`, context);
  context.open();
  assert.equal(elements.get('modal-group-info').style.display, 'flex');
  assert.equal(elements.get('group-info-title').value, 'Old title');
  assert.equal(elements.get('group-info-username').value, 'oldname');
  assert.equal(elements.get('group-info-description').value, 'Old about');
  elements.get('group-info-title').value = 'New title';
  elements.get('group-info-username').value = 'newname';
  elements.get('group-info-description').value = 'New about';
  await context.save({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: '/api/instances/a/account/chat-title', method: 'POST', body: { chatId: -42, title: 'New title' } },
    { url: '/api/instances/a/account/chat-description', method: 'POST', body: { chatId: -42, description: 'New about' } },
    { url: '/api/instances/a/account/chat-username', method: 'POST', body: { chatId: -42, username: 'newname' } },
  ]);
  assert.equal(dialog.title, 'New title');
  assert.equal(profile.username, 'newname');
  assert.equal(profile.bio, 'New about');
  assert.equal(elements.get('client-chat-title').textContent, 'New title');
  assert.equal(elements.get('profile-val-bio').textContent, 'New about');
  assert.equal(elements.get('modal-group-info').style.display, 'none');
});

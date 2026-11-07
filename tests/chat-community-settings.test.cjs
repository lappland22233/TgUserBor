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

const keys = ['viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
  'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline', 'embedLinks',
  'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics'];
const allRights = Object.fromEntries(keys.map(key => [key, false]));

test('peer profiles expose default member restrictions and supergroup slow mode', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const peer = new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(7) });
  driver.resolvePeer = () => peer;
  driver.client = {
    getEntity: async () => ({ className: 'Channel', id: bigInt(42), title: 'Forum', broadcast: false, joinToSend: true, joinRequest: false }),
    invoke: async request => request instanceof Api.channels.GetFullChannel ? { fullChat: {
      about: 'About', participantsCount: 12, slowmodeSeconds: 30,
      defaultBannedRights: new Api.ChatBannedRights({ sendMessages: true, sendPhotos: true, inviteUsers: true, untilDate: 0 }),
      antispam: true, participantsHidden: true,
    } } : { stories: { stories: [] } },
  };
  driver.logger = { debug() {} };
  const profile = await driver.getPeerProfile(-10042);
  assert.equal(profile.bio, 'About');
  assert.equal(profile.slowmodeSeconds, 30);
  assert.equal(profile.defaultBannedRights.sendMessages, true);
  assert.equal(profile.defaultBannedRights.sendPhotos, true);
  assert.equal(profile.defaultBannedRights.inviteUsers, true);
  assert.equal(profile.defaultBannedRights.pinMessages, false);
  assert.equal(profile.joinToSend, true);
  assert.equal(profile.joinRequest, false);
  assert.equal(profile.antiSpam, true);
  assert.equal(profile.participantsHidden, true);
});

test('Telegram group permissions and slow mode use the matching MTProto methods', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = () => new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(7) });
  driver.resolveAdminInputChannel = async chatId => {
    assert.equal(chatId, -10042);
    return new Api.InputChannel({ channelId: bigInt(42), accessHash: bigInt(7) });
  };
  driver.client = { invoke: async request => { calls.push(request); return {}; } };
  const rights = { ...allRights, sendMessages: true, sendPhotos: true, manageTopics: true };
  await driver.setChatDefaultBannedRights(-10042, rights);
  assert.ok(calls[0] instanceof Api.messages.EditChatDefaultBannedRights);
  assert.equal(calls[0].bannedRights.sendMessages, true);
  assert.equal(calls[0].bannedRights.sendPhotos, true);
  assert.equal(calls[0].bannedRights.manageTopics, true);
  assert.equal(calls[0].bannedRights.inviteUsers, false);
  await driver.setChatSlowMode(-10042, 300);
  assert.ok(calls[1] instanceof Api.channels.ToggleSlowMode);
  assert.equal(calls[1].seconds, 300);
  await driver.setSupergroupSetting(-10042, 'joinToSend', true);
  assert.ok(calls[2] instanceof Api.channels.ToggleJoinToSend);
  assert.equal(calls[2].enabled, true);
  await driver.setSupergroupSetting(-10042, 'participantsHidden', false);
  assert.ok(calls[3] instanceof Api.channels.ToggleParticipantsHidden);
  await assert.rejects(driver.setChatDefaultBannedRights(-10042, { ...rights, unknownFlag: true }), /Invalid Telegram group permissions/);
  await assert.rejects(driver.setChatSlowMode(-10042, 15), /Invalid Telegram slow mode/);
  assert.equal(calls.length, 4);
});

test('group permission and slow-mode HTTP routes validate complete rights and target one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => calls.push(args) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const post = (route, body) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('chat-permissions', { chatId: -10042, rights: { sendMessages: true } })).status, 400);
    const rights = { ...allRights, sendMessages: true };
    assert.equal((await post('chat-permissions', { chatId: -10042, rights })).status, 200);
    assert.equal((await post('chat-slow-mode', { chatId: -10042, seconds: 15 })).status, 400);
    assert.equal((await post('chat-slow-mode', { chatId: -10042, seconds: 300 })).status, 200);
    assert.equal((await post('supergroup-setting', { chatId: -10042, setting: 'antiSpam', enabled: true })).status, 200);
    assert.equal((await post('supergroup-setting', { chatId: -10042, setting: 'not-a-setting', enabled: true })).status, 400);
    assert.deepEqual(calls, [
      ['set_chat_permissions', { chatId: -10042, rights }],
      ['set_chat_slow_mode', { chatId: -10042, seconds: 300 }],
      ['set_supergroup_setting', { chatId: -10042, setting: 'antiSpam', enabled: true }],
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element {
  constructor(key = '') { this.dataset = key ? { chatRight: key } : {}; this.checked = false; this.value = ''; this.hidden = false; this.disabled = false; this.style = {}; }
  appendChild() {}
  querySelectorAll() { return []; }
  remove() {}
}

test('group settings UI preserves peer restrictions, updates selected permissions and slow mode', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('const CHAT_DEFAULT_RIGHT_KEYS = [');
  const end = source.indexOf('\nlet groupAdminRightsTarget = null;', start);
  assert.ok(start >= 0 && end > start);
  const profile = { defaultBannedRights: { ...allRights, sendMessages: true }, slowmodeSeconds: 30,
    joinToSend: false, joinRequest: false, antiSpam: true, participantsHidden: false };
  const dialog = { id: -10042, type: 'supergroup' };
  const inputs = keys.map(key => new Element(key));
  const supergroupInputs = ['joinToSend', 'joinRequest', 'antiSpam', 'participantsHidden'].map(key => {
    const input = new Element(); input.dataset.supergroupSetting = key; return input;
  });
  const ids = ['modal-chat-permissions', 'chat-slow-mode-row', 'chat-slow-mode', 'chat-permissions-status', 'btn-save-chat-permissions'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  elements.get('chat-slow-mode').value = '30';
  const calls = [];
  const context = vm.createContext({
    state: { clientSelectedInstance: 'a', clientActiveChatId: -10042, clientActiveDialog: dialog, chatSelectionVersion: 4,
      currentProfileChatId: -10042, currentPeerProfile: profile },
    document: { getElementById: id => elements.get(id) || null, querySelectorAll: selector => selector === '[data-chat-right]' ? inputs : supergroupInputs },
    window: { chatWs: { isConnected: () => false } },
    encodeURIComponent, showToast: () => {},
    api: async (url, method, body) => { calls.push({ url, method, body }); return { success: true }; },
  });
  vm.runInContext(`${source.slice(start, end)}
    this.open = openChatPermissionsModal; this.save = saveChatPermissions; this.close = closeChatPermissionsModal;`, context);
  context.open();
  assert.equal(elements.get('modal-chat-permissions').style.display, 'flex');
  assert.equal(inputs.find(input => input.dataset.chatRight === 'sendMessages').checked, true);
  assert.equal(inputs.find(input => input.dataset.chatRight === 'inviteUsers').checked, false);
  inputs.find(input => input.dataset.chatRight === 'inviteUsers').checked = true;
  supergroupInputs.find(input => input.dataset.supergroupSetting === 'joinToSend').checked = true;
  elements.get('chat-slow-mode').value = '300';
  await context.save({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: '/api/instances/a/account/chat-permissions', method: 'POST', body: { chatId: -10042, rights: { ...allRights, sendMessages: true, inviteUsers: true } } },
    { url: '/api/instances/a/account/supergroup-setting', method: 'POST', body: { chatId: -10042, setting: 'joinToSend', enabled: true } },
    { url: '/api/instances/a/account/chat-slow-mode', method: 'POST', body: { chatId: -10042, seconds: 300 } },
  ]);
  assert.equal(profile.defaultBannedRights.inviteUsers, true);
  assert.equal(profile.joinToSend, true);
  assert.equal(profile.slowmodeSeconds, 300);
  assert.equal(elements.get('modal-chat-permissions').style.display, 'none');
});

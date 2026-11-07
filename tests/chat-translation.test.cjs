'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('per-chat translation setting reads Telegram full peer state and toggles its server preference', async () => {
  const calls = [];
  const peer = new Api.InputPeerUser({ userId: bigInt(7), accessHash: bigInt(70) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.users.GetFullUser) return { fullUser: { translationsDisabled: true } };
      return true;
    },
  };
  assert.deepEqual(await driver.getChatTranslationSettings(7), { enabled: false });
  assert.ok(calls[0] instanceof Api.users.GetFullUser);
  assert.ok(calls[0].id instanceof Api.InputUser);
  assert.deepEqual(await driver.setChatTranslationEnabled(7, true), { enabled: true });
  assert.ok(calls[1] instanceof Api.messages.TogglePeerTranslations);
  assert.equal(calls[1].peer, peer);
  assert.equal(calls[1].disabled, false);
  await assert.rejects(driver.setChatTranslationEnabled(0, true), /Invalid translation setting/);
});

test('batch message translation retains the requested message IDs', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return { result: [{ text: 'first' }, { text: 'second' }] };
  } };
  assert.deepEqual(await driver.translateMessages(7, [4, 5], 'ja'), [
    { messageId: 4, translatedText: 'first' }, { messageId: 5, translatedText: 'second' },
  ]);
  assert.ok(calls[0] instanceof Api.messages.TranslateText);
  assert.deepEqual(calls[0].id, [4, 5]);
  assert.equal(calls[0].toLang, 'ja');
  await assert.rejects(driver.translateMessages(7, Array.from({ length: 21 }, (_, index) => index + 1)), /Invalid batch/);
});

test('translation settings and bounded batch routes validate input and target the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_chat_translation_settings') return { enabled: false };
    if (action === 'set_chat_translation_enabled') return { enabled: payload.enabled };
    if (action === 'translate_messages') return payload.messageIds.map(messageId => ({ messageId, translatedText: `t${messageId}` }));
    return {};
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const settings = await fetch(`${base}/translation-settings?chatId=7`);
    assert.equal(settings.status, 200);
    assert.deepEqual(await settings.json(), { enabled: false });
    const toggle = enabled => fetch(`${base}/translation-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 7, enabled }) });
    assert.equal((await toggle('true')).status, 400);
    assert.equal((await toggle(true)).status, 200);
    const batch = data => fetch(`${base}/translate-batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await batch({ chatId: 7, messageIds: Array.from({ length: 21 }, (_, index) => index + 1) })).status, 400);
    const response = await batch({ chatId: 7, messageIds: [4, 5], targetLang: 'ja' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ messageId: 4, translatedText: 't4' }, { messageId: 5, translatedText: 't5' }]);
    assert.deepEqual(calls, [
      { action: 'get_chat_translation_settings', payload: { chatId: 7 } },
      { action: 'set_chat_translation_enabled', payload: { chatId: 7, enabled: true } },
      { action: 'translate_messages', payload: { chatId: 7, messageIds: [4, 5], targetLang: 'ja' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('chat translation control follows Telegram state and ignores a late response from another chat', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let clientTranslationSettingsRequest =');
  const end = source.indexOf('\nlet messageEffectsCache', start);
  if (start < 0 || end < 0) throw new Error('Cannot locate chat translation controls');
  class Button {
    constructor() { this.hidden = false; this.disabled = false; this.attrs = {}; this.listeners = {}; }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const button = new Button();
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 7, chatSelectionVersion: 1,
    clientActiveDialog: { id: 7, type: 'private' }, clientTranslationEnabled: null, clientTranslationLanguage: 'zh-hans', clientMessages: [] };
  const calls = [];
  const context = vm.createContext({ state, document: { getElementById: id => id === 'btn-chat-translation-toggle' ? button : null },
    window: { addEventListener() {} }, encodeURIComponent, Number, String, Boolean, Map, Set, Promise,
    api: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })), showToast() {}, renderClientMessages() {},
  });
  vm.runInContext(source.slice(start, end) + '\nthis.load = loadChatTranslationSettings; this.toggle = toggleChatTranslation; this.translate = applyAutomaticMessageTranslations;', context);
  const loading = context.load('a', state.clientActiveDialog, 1);
  calls[0].resolve({ enabled: false });
  await loading;
  assert.equal(button.textContent, '始终翻译');
  assert.equal(button.disabled, false);
  const toggle = context.toggle();
  assert.equal(calls[1].args[1], 'POST');
  assert.equal(calls[1].args[2].chatId, 7);
  assert.equal(calls[1].args[2].enabled, true);
  calls[1].resolve({ enabled: true });
  await toggle;
  assert.equal(button.textContent, '关闭自动翻译');
  assert.equal(state.clientTranslationEnabled, true);

  const message = { id: 42, outgoing: false, text: 'hello' };
  state.clientMessages = [message, { id: 43, outgoing: true, text: 'mine' }];
  const translating = context.translate();
  assert.deepEqual(Array.from(calls[2].args[2].messageIds), [42]);
  calls[2].resolve([{ messageId: 42, translatedText: '你好' }]);
  await translating;
  assert.equal(message.autoTranslatedText, '你好');

  const late = context.load('a', state.clientActiveDialog, 1);
  state.clientActiveChatId = 8;
  calls[3].resolve({ enabled: false });
  await late;
  assert.equal(state.clientTranslationEnabled, null);
});

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

test('Telegram chat theme catalog maps unique valid emoticons and message colors', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return new Api.account.Themes({ hash: bigInt(1), themes: [
      new Api.Theme({ id: bigInt(1), accessHash: bigInt(11), slug: 'blue', title: 'Blue', emoticon: '💙', settings: [
        new Api.ThemeSettings({ baseTheme: new Api.BaseThemeDay(), accentColor: 0x123456, messageColors: [0xabcdef] }),
      ] }),
      new Api.Theme({ id: bigInt(2), accessHash: bigInt(12), slug: 'blue-copy', title: 'Duplicate', emoticon: '💙' }),
      new Api.Theme({ id: bigInt(3), accessHash: bigInt(13), slug: 'invalid', title: 'Invalid', emoticon: 'two words' }),
    ] });
  } };
  assert.deepEqual(await driver.getTelegramChatThemes(), [{ emoticon: '💙', title: 'Blue', accentColor: 0xabcdef }]);
  assert.ok(calls[0] instanceof Api.account.GetChatThemes);
});

test('Telegram theme reads the current private peer and writes only catalog themes or reset', async () => {
  const peer = new Api.InputPeerUser({ userId: bigInt(7), accessHash: bigInt(70) });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.users.GetFullUser) return { fullUser: { themeEmoticon: '💙' } };
      if (request instanceof Api.account.GetChatThemes) return new Api.account.Themes({ hash: bigInt(1), themes: [
        new Api.Theme({ id: bigInt(1), accessHash: bigInt(11), slug: 'blue', title: 'Blue', emoticon: '💙' }),
      ] });
      return { updates: [] };
    },
  };
  assert.deepEqual(await driver.getTelegramChatTheme(7), { emoticon: '💙', wallpaper: null });
  assert.deepEqual(await driver.setTelegramChatTheme(7, '💙'), { emoticon: '💙' });
  assert.ok(calls.find(request => request instanceof Api.messages.SetChatTheme));
  assert.equal(calls.find(request => request instanceof Api.messages.SetChatTheme).emoticon, '💙');
  await assert.rejects(driver.setTelegramChatTheme(7, '🎈'), /unavailable/);
  await assert.rejects(driver.setTelegramChatTheme(0, ''), /Invalid Telegram chat theme/);

  const groupDriver = Object.create(TelegramDriver.prototype);
  groupDriver.client = { getInputEntity: async () => new Api.InputPeerChat({ chatId: bigInt(9) }), invoke: async () => ({}) };
  await assert.rejects(groupDriver.setTelegramChatTheme(-9, '💙'), /only available for private chats/);
});

test('chat theme routes validate the peer and emoticon before dispatch', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_telegram_chat_themes') return [{ emoticon: '💙', title: 'Blue', accentColor: 0xabcdef }];
    return { emoticon: payload?.emoticon ?? '💙' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const themes = await fetch(`${base}/chat-themes`);
    assert.equal(themes.status, 200);
    assert.deepEqual(await themes.json(), [{ emoticon: '💙', title: 'Blue', accentColor: 0xabcdef }]);
    assert.equal((await fetch(`${base}/chat-theme?chatId=0`)).status, 400);
    assert.equal((await fetch(`${base}/chat-theme?chatId=7`)).status, 200);
    const set = emoticon => fetch(`${base}/chat-theme`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 7, emoticon }) });
    assert.equal((await set('not an emoji')).status, 400);
    assert.equal((await set('💙')).status, 200);
    assert.equal((await set('')).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_telegram_chat_themes', payload: undefined },
      { action: 'get_telegram_chat_theme', payload: { chatId: 7 } },
      { action: 'set_telegram_chat_theme', payload: { chatId: 7, emoticon: '💙' } },
      { action: 'set_telegram_chat_theme', payload: { chatId: 7, emoticon: '' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Telegram theme picker applies the active peer color and discards responses after switching chats', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let telegramChatThemeCatalog =');
  const end = source.indexOf('\nfunction initChatMuteModal(', start);
  if (start < 0 || end < 0) throw new Error('Cannot locate Telegram chat theme controls');
  class Element {
    constructor() { this.children = []; this.styleValues = {}; this.attrs = {}; this.hidden = false; this.disabled = false; }
    replaceChildren(...items) { this.children = [...items]; }
    appendChild(item) { this.children.push(item); }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this.attrs[name] = value; }
  }
  const status = new Element(), options = new Element(), pane = new Element();
  pane.style = { setProperty: (name, value) => { pane.styleValues[name] = value; }, removeProperty: name => { delete pane.styleValues[name]; } };
  pane.classList = { add() {}, remove() {}, contains() { return false; } };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 7, chatSelectionVersion: 1,
    clientActiveDialog: { id: 7, type: 'private' }, clientTelegramChatTheme: null };
  const calls = [];
  const context = vm.createContext({ state, Number, String, Boolean, Array, Promise, Map, encodeURIComponent,
    document: { getElementById: id => id === 'telegram-chat-theme-status' ? status : id === 'telegram-chat-theme-options' ? options : null,
      querySelector: selector => selector === '.client-chat-pane' ? pane : null, createElement: () => new Element() },
    api: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
  });
  vm.runInContext(source.slice(start, end) + '\nthis.load = loadTelegramChatThemes; this.setTheme = setTelegramChatTheme;', context);
  const loading = context.load('a', state.clientActiveDialog, 1);
  assert.match(calls[0].args[0], /account\/chat-themes$/);
  assert.match(calls[1].args[0], /account\/chat-theme\?chatId=7$/);
  calls[0].resolve([{ emoticon: '💙', title: 'Blue', accentColor: 0xabcdef }]);
  calls[1].resolve({ emoticon: '💙' });
  await loading;
  assert.equal(state.clientTelegramChatTheme, '💙');
  assert.equal(pane.styleValues['--tg-peer-theme-out-bg'], '#abcdef');
  assert.equal(options.children.length, 2);
  const saving = context.setTheme('');
  assert.equal(calls[2].args[1], 'POST');
  assert.equal(calls[2].args[2].emoticon, '');
  calls[2].resolve({ emoticon: '' });
  await saving;
  assert.equal(state.clientTelegramChatTheme, '');
  assert.equal(pane.styleValues['--tg-peer-theme-out-bg'], undefined);

  const stale = context.load('a', state.clientActiveDialog, 1);
  state.clientActiveChatId = 8;
  calls[3].resolve({ emoticon: '🎉' });
  await stale;
  assert.equal(state.clientTelegramChatTheme, '');
});

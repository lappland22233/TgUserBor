'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function wallpaper(slug = 'blue') {
  return {
    className: 'WallPaper', id: bigInt(17), accessHash: bigInt(19), slug,
    pattern: true, dark: false,
    settings: { className: 'WallPaperSettings', backgroundColor: 0x112233, intensity: 40 },
    document: { className: 'Document', id: bigInt(27), accessHash: bigInt(29), fileReference: Buffer.from([1]),
      mimeType: 'image/jpeg', thumbs: [{ className: 'PhotoSize', type: 'm' }],
      attributes: [{ className: 'DocumentAttributeFilename', fileName: 'blue-paper.jpg' }] },
  };
}

test('Telegram wallpaper catalog maps safe slugs and settings, with a cached catalog for previews', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return { className: 'account.WallPapers', hash: bigInt(2), wallpapers: [
      wallpaper('blue'), wallpaper('blue'), wallpaper('../unsafe'), { className: 'WallPaperNoFile', id: bigInt(3) },
    ] };
  } };
  assert.deepEqual(await driver.getTelegramWallpapers(), [{
    slug: 'blue', title: 'blue-paper', pattern: true, dark: false, motion: false, mimeType: 'image/jpeg', backgroundColor: 0x112233,
    settings: { blur: false, motion: false, backgroundColors: [0x112233], intensity: 40 },
  }]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.account.GetWallPapers);
});

test('Telegram wallpaper downloads the full bounded static document into the account-isolated cache', async () => {
  const slug = `wallpaper-test-${Date.now()}`;
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 991;
  driver.config = { telegram: { sessionPath: path.join(os.tmpdir(), 'wallpaper-session') } };
  driver.logger = { warn() {} };
  driver.client = {
    invoke: async () => ({ className: 'account.WallPapers', wallpapers: [
      { ...wallpaper(slug), document: { ...wallpaper(slug).document, mimeType: 'image/jpeg', size: 14 } },
    ] }),
    downloadMedia: async (_document, options) => options.outputFile.write(Buffer.from('telegram-wallpaper')),
    downloadFile: async (_location, options) => options.outputFile.write(Buffer.from('thumbnail')),
  };
  let filePath, previewPath;
  try {
    previewPath = await driver.downloadTelegramWallpaperPreview(slug);
    const result = await driver.downloadTelegramWallpaper(slug);
    assert.equal(result.mimeType, 'image/jpeg');
    filePath = result.filePath;
    assert.notEqual(filePath, previewPath);
    assert.equal(await fsp.readFile(previewPath, 'utf8'), 'thumbnail');
    assert.equal(await fsp.readFile(filePath, 'utf8'), 'telegram-wallpaper');
  } finally {
    if (filePath) await fsp.rm(filePath, { force: true });
    if (previewPath) await fsp.rm(previewPath, { force: true });
  }
});

test('Telegram peer appearance includes its wallpaper and wallpaper changes validate the target and catalog entry', async () => {
  const peer = new Api.InputPeerUser({ userId: bigInt(7), accessHash: bigInt(70) });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.users.GetFullUser) return { fullUser: { themeEmoticon: '💙', wallpaper: wallpaper() } };
      if (request instanceof Api.account.GetWallPapers) return { className: 'account.WallPapers', hash: bigInt(1), wallpapers: [wallpaper()] };
      return { updates: [] };
    },
  };
  assert.deepEqual(await driver.getTelegramChatTheme(7), {
    emoticon: '💙', wallpaper: { slug: 'blue', pattern: true, dark: false, motion: false, mimeType: 'image/jpeg', backgroundColor: 0x112233,
      settings: { blur: false, motion: false, backgroundColors: [0x112233], intensity: 40 } },
  });
  assert.deepEqual(await driver.setTelegramChatWallpaper(7, 'blue', { forBoth: true, settings: { blur: true, motion: false, intensity: 68 } }), {
    slug: 'blue', settings: { blur: true, motion: false, backgroundColors: [0x112233], intensity: 68 },
  });
  const set = calls.find(request => request instanceof Api.messages.SetChatWallPaper);
  assert.ok(set);
  assert.equal(set.wallpaper.slug, 'blue');
  assert.equal(set.settings.blur, true);
  assert.equal(set.settings.intensity, 68);
  assert.equal(set.forBoth, true);
  assert.deepEqual(await driver.setTelegramChatWallpaper(7, ''), { slug: '' });
  assert.equal(calls.filter(request => request instanceof Api.messages.SetChatWallPaper)[1].revert, true);
  await assert.rejects(driver.setTelegramChatWallpaper(7, '../unsafe'), /Invalid Telegram chat wallpaper/);
  await assert.rejects(driver.setTelegramChatWallpaper(7, 'blue', { settings: { intensity: 101 } }), /Invalid Telegram chat wallpaper/);
  const groupDriver = Object.create(TelegramDriver.prototype);
  const groupCalls = [];
  groupDriver.client = {
    getInputEntity: async () => new Api.InputPeerChat({ chatId: bigInt(9) }),
    invoke: async request => {
      groupCalls.push(request);
      if (request instanceof Api.messages.GetFullChat) return { fullChat: { wallpaper: wallpaper() } };
      if (request instanceof Api.account.GetWallPapers) return { className: 'account.WallPapers', wallpapers: [wallpaper()] };
      return { updates: [] };
    },
  };
  assert.equal((await groupDriver.getTelegramChatTheme(-9)).wallpaper.slug, 'blue');
  assert.equal((await groupDriver.setTelegramChatWallpaper(-9, 'blue')).slug, 'blue');
  assert.ok(groupCalls.some(request => request instanceof Api.messages.GetFullChat));
  assert.ok(groupCalls.some(request => request instanceof Api.messages.SetChatWallPaper));
  const channelDriver = Object.create(TelegramDriver.prototype);
  channelDriver.client = { getInputEntity: async () => new Api.InputPeerChannel({ channelId: bigInt(9), accessHash: bigInt(90) }) };
  await assert.rejects(channelDriver.setTelegramChatWallpaper(-1009, 'blue', { forBoth: true }), /only available in private chats/);
});

test('Telegram chat wallpaper reads and updates supergroup/channel peers while rejecting shared application', async () => {
  const peer = new Api.InputPeerChannel({channelId: bigInt(456), accessHash: bigInt(77)});
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.channels.GetFullChannel) return {fullChat:{wallpaper:wallpaper()}};
      if (request instanceof Api.account.GetWallPapers) return {className:'account.WallPapers', wallpapers:[wallpaper()]};
      return {updates:[]};
    },
  };
  const appearance = await driver.getTelegramChatTheme(-100456);
  assert.equal(appearance.wallpaper.slug, 'blue');
  const updated = await driver.setTelegramChatWallpaper(-100456, 'blue');
  assert.equal(updated.slug, 'blue');
  await assert.rejects(driver.setTelegramChatWallpaper(-100456, 'blue', {forBoth:true}), /only available in private chats/);
  assert.ok(calls.some(request => request instanceof Api.channels.GetFullChannel));
  assert.ok(calls.some(request => request instanceof Api.messages.SetChatWallPaper));
});

test('wallpaper routes validate slugs and chat ids and serve preview bytes without browser caching', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wallpaper-test-'));
  const preview = path.join(folder, 'preview.jpg');
  fs.writeFileSync(preview, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_telegram_wallpapers') return [{ slug: 'blue', title: 'Blue', pattern: true }];
    if (action === 'get_telegram_wallpaper_preview') return { filePath: preview };
    if (action === 'get_telegram_wallpaper_file') return { filePath: preview, mimeType: 'image/jpeg' };
    return { slug: payload?.slug || '' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const list = await fetch(`${base}/wallpapers`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [{ slug: 'blue', title: 'Blue', pattern: true }]);
    assert.equal((await fetch(`${base}/wallpaper-preview?slug=../bad`)).status, 400);
    const image = await fetch(`${base}/wallpaper-preview?slug=blue`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.from(await image.arrayBuffer()).toString('hex'), 'ffd8ffd9');
    const file = await fetch(`${base}/wallpaper-file?slug=blue`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    const set = (slug, forBoth = false, settings = {}) => fetch(`${base}/chat-wallpaper`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 7, slug, forBoth, settings }) });
    assert.equal((await set('../bad')).status, 400);
    assert.equal((await set('blue')).status, 200);
    assert.equal((await set('blue', true, { blur: true, motion: false, intensity: 70 })).status, 200);
    assert.equal((await set('', true)).status, 400);
    assert.equal((await set('blue', false, { intensity: 101 })).status, 400);
    assert.equal((await set('')).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_telegram_wallpapers', payload: undefined },
      { action: 'get_telegram_wallpaper_preview', payload: { slug: 'blue' } },
      { action: 'get_telegram_wallpaper_file', payload: { slug: 'blue' } },
      { action: 'set_telegram_chat_wallpaper', payload: { chatId: 7, slug: 'blue', forBoth: false, settings: {} } },
      { action: 'set_telegram_chat_wallpaper', payload: { chatId: 7, slug: 'blue', forBoth: true, settings: { blur: true, motion: false, intensity: 70 } } },
      { action: 'set_telegram_chat_wallpaper', payload: { chatId: 7, slug: '', forBoth: false, settings: {} } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('wallpaper picker applies peer appearance and discards stale requests after switching chats', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let telegramChatThemeCatalog =');
  const end = source.indexOf('\nfunction applyChatTheme(', start);
  if (start < 0 || end < 0) throw new Error('Cannot locate Telegram wallpaper controls');
  class Element {
    constructor() {
      this.children = []; this.styleValues = {}; this.attrs = {}; this.disabled = false; this.classNames = new Set();
      this.style = { setProperty: (name, value) => { this.styleValues[name] = value; }, removeProperty: name => { delete this.styleValues[name]; } };
      this.classList = { add: name => this.classNames.add(name), remove: name => this.classNames.delete(name), contains: name => this.classNames.has(name) };
    }
    replaceChildren(...items) { this.children = [...items]; }
    appendChild(item) { this.children.push(item); }
    append(...items) { this.children.push(...items); }
    setAttribute(name, value) { this.attrs[name] = value; }
  }
  const status = new Element(), options = new Element(), pane = new Element(), forBoth = new Element();
  const blur = new Element(), motion = new Element(), intensity = new Element(), intensityValue = new Element();
  intensity.value = '65';
  forBoth.parentElement = new Element();
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 7, chatSelectionVersion: 1,
    clientActiveDialog: { id: 7, type: 'private' }, clientTelegramChatWallpaper: null };
  const calls = [];
  const context = vm.createContext({ state, Number, String, Boolean, Array, Promise, encodeURIComponent,
    document: { getElementById: id => id === 'telegram-chat-wallpaper-status' ? status : id === 'telegram-chat-wallpaper-options' ? options :
      id === 'telegram-chat-wallpaper-for-both' ? forBoth : id === 'telegram-chat-wallpaper-blur' ? blur : id === 'telegram-chat-wallpaper-motion' ? motion :
      id === 'telegram-chat-wallpaper-intensity' ? intensity : id === 'telegram-chat-wallpaper-intensity-value' ? intensityValue : null,
      querySelector: selector => selector === '.client-chat-pane' ? pane : null, createElement: () => new Element() },
    api: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
  });
  vm.runInContext(source.slice(start, end) + '\nthis.supportsWallpaper = supportsTelegramChatWallpaper; this.loadWallpapers = loadTelegramChatWallpapers; this.setWallpaper = setTelegramChatWallpaper; this.refreshWallpaper = refreshTelegramChatWallpaper; this.applyWallpaper = applyTelegramChatWallpaper; this.clearAppearance = clearTelegramChatAppearance;', context);
  assert.equal(context.supportsWallpaper({id:9, type:'supergroup'}), true);
  assert.equal(context.supportsWallpaper({id:9, type:'group'}), true);
  const load = context.loadWallpapers('a', state.clientActiveDialog, 1);
  assert.match(calls[0].args[0], /account\/wallpapers$/);
  calls[0].resolve([{ slug: 'blue', title: 'Blue', pattern: true, mimeType: 'image/jpeg', backgroundColor: 0x112233,
    settings: { blur: false, motion: false, backgroundColors: [0x112233], intensity: 40 } }, { slug: 'green', title: 'Green' }]);
  await load;
  assert.equal(options.children.length, 3);
  forBoth.checked = true;
  blur.checked = true;
  motion.checked = false;
  const set = context.setWallpaper('blue');
  assert.equal(calls[1].args[1], 'POST');
  assert.equal(calls[1].args[2].chatId, 7);
  assert.equal(calls[1].args[2].slug, 'blue');
  assert.equal(calls[1].args[2].forBoth, true);
  assert.equal(calls[1].args[2].settings.blur, true);
  assert.equal(calls[1].args[2].settings.intensity, 65);
  calls[1].resolve({ slug: 'blue' });
  await set;
  assert.equal(pane.classList.contains('telegram-wallpaper-active'), true);
  assert.equal(pane.styleValues['--tg-peer-wallpaper-bg'], '#112233');
  assert.match(pane.styleValues['--tg-peer-wallpaper-image'], /account\/wallpaper-file\?slug=blue/);
  assert.equal(state.clientTelegramChatWallpaper.slug, 'blue');
  assert.equal(forBoth.checked, false);
  const reset = context.setWallpaper('');
  assert.equal(calls[2].args[2].forBoth, false);
  calls[2].resolve({ slug: '' });
  await reset;
  assert.equal(pane.classList.contains('telegram-wallpaper-active'), false);
  state.clientTelegramChatTheme = '💙';
  state.clientTelegramChatWallpaper = { slug: 'green' };
  context.clearAppearance();
  assert.equal(state.clientTelegramChatTheme, null);
  assert.equal(state.clientTelegramChatWallpaper, null);
  assert.equal(pane.styleValues['--tg-peer-wallpaper-image'], undefined);

  context.applyWallpaper({ slug: 'motion', mimeType: 'video/mp4', motion: true, settings: { blur: true, motion: true } }, 'a');
  const layer = pane.children[pane.children.length - 1];
  assert.equal(layer.className, 'telegram-chat-wallpaper-layer');
  assert.equal(layer.children[0].className, 'telegram-chat-wallpaper-video');
  assert.equal(layer.children[0].muted, true);
  assert.equal(layer.children[0].loop, true);
  assert.match(layer.children[0].src, /account\/wallpaper-file\?slug=motion/);
  assert.equal(layer.style.filter, 'blur(8px)');

  state.clientSelectedInstance = 'b';
  const stale = context.loadWallpapers('b', state.clientActiveDialog, 1);
  assert.match(calls[3].args[0], /instances\/b\/account\/wallpapers$/);
  state.clientSelectedInstance = 'a';
  state.clientActiveChatId = 8;
  calls[3].resolve([{ slug: 'stale', title: 'Stale' }]);
  await stale;
  assert.equal(state.clientTelegramChatWallpaper, null);

  state.clientActiveDialog = { id: -9, type: 'group' };
  state.clientActiveChatId = -9;
  await context.loadWallpapers('a', state.clientActiveDialog, 1);
  assert.equal(calls.length, 4);
  forBoth.checked = true;
  const groupSet = context.setWallpaper('blue');
  assert.equal(calls[4].args[2].chatId, -9);
  assert.equal(calls[4].args[2].forBoth, false);
  calls[4].resolve({ slug: 'blue' });
  await groupSet;

  const currentWallpaper = { slug: 'green', mimeType: 'image/jpeg', backgroundColor: 0x334455, settings: { blur: false, motion: false, backgroundColors: [] } };
  const refresh = context.refreshWallpaper('a', -9);
  assert.match(calls[5].args[0], /account\/chat-theme\?chatId=-9$/);
  calls[5].resolve({ emoticon: '', wallpaper: currentWallpaper });
  await refresh;
  assert.equal(state.clientTelegramChatWallpaper.slug, 'green');
  assert.equal(pane.styleValues['--tg-peer-wallpaper-bg'], '#334455');
  const staleRefresh = context.refreshWallpaper('a', -9);
  state.clientActiveChatId = -10;
  state.chatSelectionVersion++;
  calls[6].resolve({ emoticon: '', wallpaper: { slug: 'stale' } });
  await staleRefresh;
  assert.equal(state.clientTelegramChatWallpaper.slug, 'green');
});

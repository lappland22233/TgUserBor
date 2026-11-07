'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const listeners = {};
  const documentListeners = {};
  const posts = [];
  const calls = [];
  const notices = [];
  const haptics = [];
  const observers = [];
  const hooks = {};
  const cameraTracks = [];
  const stored = new Map();
  const localStorage = {
    get length() { return stored.size; },
    key(index) { return Array.from(stored.keys())[index] ?? null; },
    getItem(key) { return stored.has(key) ? stored.get(key) : null; },
    setItem(key, value) { stored.set(String(key), String(value)); },
    removeItem(key) { stored.delete(String(key)); },
  };
  const body = { children: [], appendChild(node) { this.children.push(node); } };
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.hidden = false; this.disabled = false;
      this.style = {}; this.attributes = {}; this.textContent = ''; this.width = 420; this.height = 620;
      this.nodes = {};
    }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = nodes; for (const node of nodes) node.parentNode = this; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { (this.listeners ||= {})[type] = callback; }
    querySelector(selector) { return this.nodes[selector]; }
    play() { return Promise.resolve(); }
    getContext() {
      if (this.tag !== 'canvas') return null;
      return {
        drawImage: (...args) => { hooks.qrDraw = args; },
        getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      };
    }
    getBoundingClientRect() { return { width: 400, height: 500 }; }
  }
  const document = {
    body,
    head: { appendChild(node) { hooks.qrScript = node; hooks.qrScriptLoader?.(node); } },
    createElement(tag) {
      const node = new Node(tag);
      if (tag === 'div' && !body.children.length) {
        node.nodes = {
          '.mini-app-status': new Node('div'), '.mini-app-link': new Node('div'),
          '.mini-app-frame-area': new Node('div'), '[data-back]': new Node('button'),
          '[data-settings]': new Node('button'), '.mini-app-main-button': new Node('button'),
          '.mini-app-secondary-button': new Node('button'), '.mini-app-button-row': new Node('div'),
          '.mini-app-window': new Node('div'), '.mini-app-header': new Node('div'), '[data-close]': new Node('button'),
        };
      }
      if (tag === 'iframe') node.contentWindow = { postMessage: message => posts.push(JSON.parse(message)) };
      return node;
    },
  };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 10, chatSelectionVersion: 3 };
  const theme = { '--bg-app': '#ffffff', '--text-primary': '#222222', '--text-muted': '#777777', '--tg-link': '#168acd',
    '--color-primary': '#168acd', '--tg-out-text': '#ffffff', '--bg-card': 'rgba(241, 241, 241, 0.5)',
    '--bg-header': '#ffffff', '--text-secondary': '#666666', '--color-danger': '#cc3333' };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const context = {
    window: {
      addEventListener(type, callback) { listeners[type] = callback; }, removeEventListener(type) { delete listeners[type]; },
      requestAnimationFrame(callback) { hooks.qrFrame = callback; return 1; }, cancelAnimationFrame() {},
      BarcodeDetector: class {
        constructor(options) { hooks.qrFormats = options.formats; }
        async detect(video) { hooks.detectedVideo = video; return hooks.qrDetection?.(video) || []; }
      },
    },
    document: { ...document, documentElement: { dataset: { theme: 'light' } }, addEventListener(type, callback) { documentListeners[type] = callback; }, visibilityState: 'visible' }, state, location: { hostname: 'localhost' }, URL,
    getComputedStyle: () => ({ getPropertyValue: key => theme[key] || '' }),
    TextEncoder, MutationObserver: FakeMutationObserver, setTimeout: () => 1, clearTimeout() {},
    navigator: {
      vibrate: pattern => haptics.push(pattern),
      clipboard: undefined,
      permissions: { query: async () => ({ state: 'prompt' }) },
      mediaDevices: { getUserMedia: async constraints => {
        hooks.cameraConstraints = constraints;
        const track = { stopped: false, stop() { this.stopped = true; } };
        cameraTracks.push(track);
        return { getTracks: () => [track] };
      } },
      geolocation: { getCurrentPosition: (success, error, options) => { hooks.locationRequest = { success, error, options }; } },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/write-access')) {
        return options.method === 'POST'
          ? { ok: true, json: async () => ({}) }
          : { ok: true, json: async () => ({ allowed: hooks.writeAccessAllowed === true }) };
      }
      if (url.endsWith('/download-check')) return { ok: true, json: async () => ({ allowed: hooks.downloadAllowed !== false }) };
      if (url.endsWith('/phone')) return { ok: true, json: async () => ({ success: true }) };
      if (url.endsWith('/invoice/prepare')) return hooks.invoicePrepare
        ? hooks.invoicePrepare(url, options)
        : { ok: true, json: async () => ({ token: 'T'.repeat(32), stars: '25', title: '<Order>', description: 'One item' }) };
      if (url.endsWith('/invoice/confirm')) return { ok: true, json: async () => ({ status: hooks.invoiceStatus || 'paid' }) };
      if (url.endsWith('/invoice/cancel')) return { ok: true, json: async () => ({ success: true }) };
      if (url.endsWith('/method')) return hooks.method ? hooks.method(url, options) : { ok: true, json: async () => ({ result: '{"keys":["theme"]}' }) };
      if (url.endsWith('/send-data')) return { ok: true, json: async () => ({ success: true }) };
      return { ok: true, json: async () => ({ capability: 'opaque-key', url: 'https://bot.example/app', botId: '21', accountId: '99', simpleWebView: hooks.simpleWebView === true, buttonText: 'Quick order' }) };
    },
    showToast: message => notices.push(message),
    localStorage,
  };
  vm.runInNewContext(fs.readFileSync('src/gui/web/js/mini-app.js', 'utf8'), context);
  return { ...context, listeners, documentListeners, posts, calls, haptics, notices, hooks, state, localStorage, stored, observers, cameraTracks };
}

test('Mini App main and back button bridge is scoped to the live sandbox frame', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const backButton = overlay.nodes['[data-back]'];
  const mainButton = overlay.nodes['.mini-app-main-button'];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  frame.onload();
  assert.deepEqual(f.posts[0], { eventType: 'theme_changed', eventData: { color_scheme: 'light', theme_params: {
    bg_color: '#ffffff', text_color: '#222222', hint_color: '#777777', link_color: '#168acd', button_color: '#168acd',
    button_text_color: '#ffffff', secondary_bg_color: '#f8f8f8', header_bg_color: '#ffffff', accent_text_color: '#168acd',
    section_bg_color: '#f8f8f8', section_header_text_color: '#666666', subtitle_text_color: '#777777', destructive_text_color: '#cc3333',
  } } });

  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_setup_back_button', eventData: { is_visible: true },
  }) });
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_setup_main_button', eventData: { is_visible: true, is_active: true, text: '<Continue>', color: '#123456', text_color: '#ffffff' },
  }) });
  assert.equal(backButton.hidden, false);
  assert.equal(mainButton.hidden, false);
  assert.equal(mainButton.textContent, '<Continue>');
  assert.equal(mainButton.style.backgroundColor, '#123456');
  assert.equal(mainButton.style.color, '#ffffff');

  mainButton.onclick();
  backButton.onclick();
  assert.deepEqual(f.posts.slice(-2).map(message => message.eventType), ['main_button_pressed', 'back_button_pressed']);

  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_open_popup', eventData: { title: '<Notice>', message: 'Continue?', buttons: [
      { id: 'cancel', type: 'close', text: 'Cancel' }, { id: 'continue', type: 'destructive', text: '<Continue>' },
    ] },
  }) });
  const popup = overlay.children.at(-1);
  const dialog = popup.children[0];
  assert.equal(dialog.children[0].textContent, '<Notice>');
  assert.equal(dialog.children[1].textContent, 'Continue?');
  dialog.children[2].children[1].onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'popup_closed', eventData: { button_id: 'continue' } });

  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_open_tg_link', eventData: { path_full: '/example?start=hello' },
  }) });
  const telegramLink = overlay.nodes['.mini-app-link'].children[0];
  assert.equal(telegramLink.href, 'https://t.me/example?start=hello');
  assert.equal(telegramLink.textContent, '点击打开 Telegram 链接');
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_open_tg_link', eventData: { path_full: 'https://evil.example/' },
  }) });
  assert.equal(overlay.nodes['.mini-app-link'].children.length, 0);
  assert.equal(overlay.nodes['.mini-app-status'].textContent, '此链接不可用。');
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_trigger_haptic_feedback', eventData: { type: 'impact', impact_style: 'medium' },
  }) });
  assert.deepEqual(f.haptics, [16]);
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_invoke_custom_method', eventData: { req_id: 91, method: 'getStorage', params: { keys: ['theme'] } },
  }) });
  await new Promise(resolve => setImmediate(resolve));
  const customCall = f.calls.find(call => call.url.endsWith('/account/mini-app/method'));
  assert.equal(customCall.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(JSON.parse(customCall.options.body), { method: 'getStorage', paramsJson: '{"keys":["theme"]}' });
  assert.deepEqual(f.posts.at(-1), { eventType: 'custom_method_invoked', eventData: { req_id: 91, result: { keys: ['theme'] } } });

  let finish;
  f.hooks.method = () => new Promise(resolve => { finish = resolve; });
  const postsBeforeLateResponse = f.posts.length;
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_invoke_custom_method', eventData: { req_id: 92, method: 'getStorage', params: { keys: ['private'] } },
  }) });
  await new Promise(resolve => setImmediate(resolve));
  f.state.clientSelectedInstance = 'another-account';
  finish({ ok: true, json: async () => ({ result: '{"private":"value"}' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.posts.length, postsBeforeLateResponse);

  f.listeners.message({ source: frame.contentWindow, origin: 'https://bot.example', data: JSON.stringify({
    eventType: 'web_app_setup_main_button', eventData: { is_visible: false },
  }) });
  assert.equal(mainButton.hidden, false);
  f.state.clientSelectedInstance = 'another-account';
  mainButton.onclick();
  assert.equal(f.posts.length, 7);
  f.window.MiniApp.close();
});

test('Mini App openInvoice requires host confirmation and returns a paid status to the live frame', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_open_invoice', eventData: { slug: 'abc-123' },
  }) });
  await new Promise(resolve => setImmediate(resolve));
  const prepare = f.calls.find(call => call.url.endsWith('/invoice/prepare'));
  assert.equal(prepare.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(JSON.parse(prepare.options.body), { slug: 'abc-123' });
  assert.equal(f.calls.some(call => call.url.endsWith('/invoice/confirm')), false);
  let dialog = overlay.children.at(-1).children[0];
  assert.equal(dialog.children[0].textContent, '确认 Stars 付款？');
  assert.match(dialog.children[1].textContent, /<Order>/);
  assert.match(dialog.children[1].textContent, /25 Stars/);
  await dialog.children[2].children[1].onclick();
  const confirm = f.calls.find(call => call.url.endsWith('/invoice/confirm'));
  assert.deepEqual(JSON.parse(confirm.options.body), { token: 'T'.repeat(32) });
  assert.deepEqual(f.posts.at(-1), { eventType: 'invoice_closed', eventData: { slug: 'abc-123', status: 'paid' } });
  f.window.MiniApp.close();
});

test('Mini App openInvoice cancellation discards the pending token and invalid slugs fail without a request', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = slug => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_open_invoice', eventData: { slug },
  }) });
  send('bad/slug');
  assert.deepEqual(f.posts.at(-1), { eventType: 'invoice_closed', eventData: { slug: 'bad/slug', status: 'failed' } });
  assert.equal(f.calls.some(call => call.url.endsWith('/invoice/prepare')), false);
  send('abc-123');
  await new Promise(resolve => setImmediate(resolve));
  let dialog = overlay.children.at(-1).children[0];
  await dialog.children[2].children[0].onclick();
  const cancel = f.calls.find(call => call.url.endsWith('/invoice/cancel'));
  assert.deepEqual(JSON.parse(cancel.options.body), { token: 'T'.repeat(32) });
  assert.deepEqual(f.posts.at(-1), { eventType: 'invoice_closed', eventData: { slug: 'abc-123', status: 'cancelled' } });
  f.window.MiniApp.close();
});

test('bot menu Mini Apps use the current chat and Telegram verified URL', async () => {
  const f = fixture();
  await f.window.MiniApp.openBotMenu({ instId: 'a', chatId: 10, selectionVersion: 3 });
  const request = f.calls.find(call => call.url.endsWith('/account/mini-app/menu'));
  assert.deepEqual(JSON.parse(request.options.body), { chatId: 10 });
  const frame = f.document.body.children[0].nodes['.mini-app-frame-area'].children[0];
  assert.equal(frame.src, 'https://bot.example/app');
  f.window.MiniApp.close();
  const callsBeforeStale = f.calls.length;
  f.state.chatSelectionVersion++;
  await f.window.MiniApp.openBotMenu({ instId: 'a', chatId: 10, selectionVersion: 3 });
  assert.equal(f.calls.length, callsBeforeStale);
});

test('chat menu button is visible only for the current bot with a configured Mini App', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('let botMenuButtonRequest = 0;');
  const end = source.indexOf('\nlet clientDialogsRequest = 0;', start);
  assert.ok(start >= 0 && end > start);
  const button = { hidden: true, textContent: '', title: '', removeAttribute(name) { delete this[name]; } };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 21, chatSelectionVersion: 3 };
  const calls = [];
  const context = vm.createContext({ document: { getElementById: id => id === 'btn-chat-bot-menu' ? button : null }, state,
    api: async url => { calls.push(url); return { available: true, text: 'Shop' }; }, encodeURIComponent, String });
  vm.runInContext(`${source.slice(start, end)}\nthis.load = loadBotMenuButton;`, context);
  await context.load('a', { id: 21, type: 'bot' }, 3);
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Shop');
  assert.match(calls[0], /mini-app\/menu\?chatId=21/);
  await context.load('a', { id: 22, type: 'private' }, 4);
  assert.equal(button.hidden, true);
  state.clientActiveChatId = 21;
  state.chatSelectionVersion = 3;
  let finish;
  context.api = () => new Promise(resolve => { finish = resolve; });
  const pending = context.load('a', { id: 21, type: 'bot' }, 3);
  state.chatSelectionVersion = 4;
  finish({ available: true, text: 'Stale' });
  await pending;
  assert.equal(button.hidden, true);
  assert.notEqual(button.textContent, 'Stale');
});

test('Mini App device storage stays local and is isolated by Telegram account and bot', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = (eventType, eventData) => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType, eventData }) });
  send('web_app_device_storage_save_key', { req_id: 1, key: 'draft', value: 'hello' });
  assert.deepEqual(f.posts.at(-1), { eventType: 'device_storage_key_saved', eventData: { req_id: 1, key: 'draft' } });
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:a:99:21:draft'), 'hello');
  f.localStorage.setItem('tg-miniapp-device:v1:b:99:21:other', 'different instance');
  f.localStorage.setItem('tg-miniapp-device:v1:a:100:21:other-account', 'different account');
  f.localStorage.setItem('tg-miniapp-device:v1:a:99:22:other-bot', 'different bot');
  send('web_app_device_storage_get_key', { req_id: 2, key: 'draft' });
  assert.deepEqual(f.posts.at(-1), { eventType: 'device_storage_key_received', eventData: { req_id: 2, key: 'draft', value: 'hello' } });
  send('web_app_device_storage_get_keys', { req_id: 3 });
  assert.deepEqual(f.posts.at(-1), { eventType: 'device_storage_keys_received', eventData: { req_id: 3, keys: ['draft'] } });
  send('web_app_device_storage_save_key', { req_id: 4, key: 'too-large', value: 'x'.repeat(4097) });
  assert.deepEqual(f.posts.at(-1), { eventType: 'device_storage_failed', eventData: { req_id: 4, error: 'VALUE_INVALID' } });
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:a:99:21:too-large'), null);
  send('web_app_device_storage_remove_key', { req_id: 5, key: 'draft' });
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:a:99:21:draft'), null);
  send('web_app_device_storage_clear', { req_id: 6 });
  assert.equal(f.posts.at(-1).eventType, 'device_storage_cleared');
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:b:99:21:other'), 'different instance');
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:a:100:21:other-account'), 'different account');
  assert.equal(f.localStorage.getItem('tg-miniapp-device:v1:a:99:22:other-bot'), 'different bot');
  const postsBeforeSwitch = f.posts.length;
  f.state.clientSelectedInstance = 'b';
  send('web_app_device_storage_get_key', { req_id: 7, key: 'draft' });
  assert.equal(f.posts.length, postsBeforeSwitch);
  f.window.MiniApp.close();
});

test('Mini App settings and secondary buttons work, and user close can require confirmation', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = (eventType, eventData) => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType, eventData }) });
  send('web_app_setup_settings_button', { is_visible: true });
  send('web_app_setup_secondary_button', { is_visible: true, is_active: true, text: 'More', position: 'right', color: '#123456' });
  assert.equal(overlay.nodes['[data-settings]'].hidden, false);
  assert.equal(overlay.nodes['.mini-app-secondary-button'].hidden, false);
  assert.equal(overlay.nodes['.mini-app-secondary-button'].style.backgroundColor, '#123456');
  assert.equal(overlay.nodes['.mini-app-button-row'].className, 'mini-app-button-row secondary-right');
  overlay.nodes['[data-settings]'].onclick();
  overlay.nodes['.mini-app-secondary-button'].onclick();
  assert.deepEqual(f.posts.slice(-2).map(message => message.eventType), ['settings_button_pressed', 'secondary_button_pressed']);

  send('web_app_set_background_color', { color: '#abcdef' });
  send('web_app_set_bottom_bar_color', { color: '#fedcba' });
  send('web_app_set_header_color', { color_key: 'secondary_bg_color' });
  assert.equal(overlay.nodes['.mini-app-window'].style.backgroundColor, '#abcdef');
  assert.equal(overlay.nodes['.mini-app-button-row'].style.backgroundColor, '#fedcba');
  assert.equal(overlay.nodes['.mini-app-header'].style.backgroundColor, 'rgba(241, 241, 241, 0.5)');
  send('web_app_setup_closing_behavior', { need_confirmation: true });
  overlay.nodes['[data-close]'].onclick();
  let dialog = overlay.children.at(-1).children[0];
  assert.equal(dialog.attributes.role, 'alertdialog');
  dialog.children[2].children[0].onclick();
  assert.equal(overlay.hidden, false);
  overlay.nodes['[data-close]'].onclick();
  dialog = overlay.children.at(-1).children[0];
  dialog.children[2].children[1].onclick();
  assert.equal(overlay.hidden, true);
});

test('Mini App theme changes in the host are forwarded to the active frame', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  f.document.documentElement.dataset.theme = 'dark';
  f.observers[0].callback();
  assert.equal(f.posts.at(-1).eventType, 'theme_changed');
  assert.equal(f.posts.at(-1).eventData.color_scheme, 'dark');
  f.window.MiniApp.close();
  assert.equal(f.observers[0].disconnected, true);
  const before = f.posts.length;
  f.observers[0].callback();
  assert.equal(f.posts.length, before);
});

test('Mini App clipboard access requires a host click and returns only bounded text', async () => {
  const f = fixture();
  f.navigator.clipboard = { readText: async () => 'copied text' };
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const frame = f.document.body.children[0].nodes['.mini-app-frame-area'].children[0];
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_read_text_from_clipboard', eventData: { req_id: 'clipboard-1' },
  }) });
  assert.equal(f.posts.some(message => message.eventType === 'clipboard_text_received'), false);
  const button = f.document.body.children[0].nodes['.mini-app-link'].children[0];
  await button.onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'clipboard_text_received', eventData: { req_id: 'clipboard-1', data: 'copied text' } });
  f.navigator.clipboard.readText = async () => 'x'.repeat(16385);
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_read_text_from_clipboard', eventData: { req_id: 'clipboard-2' },
  }) });
  await f.document.body.children[0].nodes['.mini-app-link'].children[0].onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'clipboard_text_received', eventData: { req_id: 'clipboard-2' } });
  f.window.MiniApp.close();
});

test('Mini App write access asks the user before Telegram permission is changed', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = () => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType: 'web_app_request_write_access' }) });
  send();
  await new Promise(resolve => setImmediate(resolve));
  let dialog = overlay.children.at(-1).children[0];
  assert.equal(dialog.attributes.role, 'alertdialog');
  assert.equal(f.calls.filter(call => call.url.endsWith('/write-access') && call.options.method === 'POST').length, 0);
  dialog.children[2].children[0].onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'write_access_requested', eventData: { status: 'cancelled' } });

  send();
  await new Promise(resolve => setImmediate(resolve));
  dialog = overlay.children.at(-1).children[0];
  await dialog.children[2].children[1].onclick();
  const grant = f.calls.find(call => call.url.endsWith('/write-access') && call.options.method === 'POST');
  assert.equal(grant.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(f.posts.at(-1), { eventType: 'write_access_requested', eventData: { status: 'allowed' } });
  f.window.MiniApp.close();
});

test('Mini App location is disclosed only after explicit host and browser permission', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = eventType => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType }) });
  send('web_app_check_location');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_checked', eventData: { available: true, access_requested: false, access_granted: false } });

  send('web_app_request_location');
  let dialog = overlay.children.at(-1).children[0];
  assert.equal(dialog.attributes.role, 'alertdialog');
  assert.equal(f.hooks.locationRequest, undefined);
  dialog.children[2].children[0].onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_requested', eventData: { available: false } });

  send('web_app_request_location');
  dialog = overlay.children.at(-1).children[0];
  dialog.children[2].children[1].onclick();
  assert.equal(f.hooks.locationRequest.options.timeout, 15000);
  f.hooks.locationRequest.success({ coords: { latitude: 37.5, longitude: -122.2, altitude: 10, heading: 80, speed: 1.5, accuracy: 12, altitudeAccuracy: 5 } });
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_requested', eventData: {
    available: true, latitude: 37.5, longitude: -122.2, altitude: 10, course: 80, speed: 1.5,
    horizontal_accuracy: 12, vertical_accuracy: 5, course_accuracy: 0, speed_accuracy: 0,
  } });
  send('web_app_check_location');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_checked', eventData: {
    available: true, access_requested: true, access_granted: false,
  } });

  send('web_app_request_location');
  dialog = overlay.children.at(-1).children[0];
  dialog.children[2].children[2].onclick();
  assert.equal(f.hooks.locationRequest.options.timeout, 15000);
  f.hooks.locationRequest.success({ coords: { latitude: 37.5, longitude: -122.2, accuracy: 12 } });
  assert.equal(f.localStorage.getItem('tg-miniapp-location:v1:a:99:21:granted'), '1');
  send('web_app_check_location');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_checked', eventData: {
    available: true, access_requested: true, access_granted: true,
  } });

  send('web_app_request_location');
  assert.equal(overlay.children.length, 0);
  assert.equal(typeof f.hooks.locationRequest.success, 'function');
  f.hooks.locationRequest.success({ coords: { latitude: 1, longitude: 2 } });
  assert.equal(f.posts.at(-1).eventData.latitude, 1);
  f.window.MiniApp.close();
});

test('Mini App location settings can revoke the account and bot scoped persistent grant', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  f.localStorage.setItem('tg-miniapp-location:v1:a:99:21:requested', '1');
  f.localStorage.setItem('tg-miniapp-location:v1:a:99:21:granted', '1');
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  frame.onload();
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType: 'web_app_open_location_settings' }) });
  const dialog = overlay.children[0].children[0];
  assert.match(dialog.children[1].textContent, /已获持续定位授权/);
  assert.match(dialog.children[1].textContent, /浏览器管理/);
  dialog.children[2].children[0].onclick();
  assert.equal(f.localStorage.getItem('tg-miniapp-location:v1:a:99:21:granted'), null);
  assert.equal(f.localStorage.getItem('tg-miniapp-location:v1:a:99:21:requested'), '1');
  assert.deepEqual(f.posts.at(-1), { eventType: 'location_settings_opened', eventData: {} });
  f.window.MiniApp.close();
});

test('Mini App QR scanner requests the camera after a host click and returns QR text locally', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  frame.onload();
  const send = eventType => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType }) });
  send('web_app_open_scan_qr_popup');
  const root = overlay.children.at(-1);
  const dialog = root.children[0];
  assert.equal(dialog.attributes.role, 'dialog');
  assert.equal(dialog.children[1].textContent, '相机仅在本机用于识别 QR 码，画面不会上传。');
  assert.equal(f.cameraTracks.length, 0);
  assert.deepEqual(Array.from(f.hooks.qrFormats), ['qr_code']);

  const video = dialog.children[2];
  video.readyState = 2;
  f.hooks.qrDetection = () => [{ rawValue: 'https://example.test/pay?x=1' }];
  await dialog.children[3].children[1].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.hooks.cameraConstraints)), { video: { facingMode: { ideal: 'environment' } }, audio: false });
  assert.equal(f.cameraTracks[0].stopped, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.slice(-2), [
    { eventType: 'qr_text_received', eventData: { data: 'https://example.test/pay?x=1' } },
    { eventType: 'scan_qr_popup_closed', eventData: {} },
  ]);
  assert.equal(f.cameraTracks[0].stopped, true);
  assert.equal(root.parentNode, null);
  f.window.MiniApp.close();
});

test('Mini App QR scanner falls back to local decoding and stops camera on cancel', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  frame.onload();
  const send = eventType => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType }) });
  delete f.window.BarcodeDetector;
  f.hooks.qrScriptLoader = script => {
    f.window.jsQR = (pixels, width, height, options) => {
      f.hooks.jsQrInput = { length: pixels.length, width, height, options };
      return { data: 'https://example.test/from-local-decoder' };
    };
    script.onload();
  };
  send('web_app_open_scan_qr_popup');
  const dialog = overlay.children.at(-1).children[0];
  dialog.children[2].readyState = 2;
  dialog.children[2].videoWidth = 320;
  dialog.children[2].videoHeight = 240;
  await dialog.children[3].children[1].onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.hooks.qrScript.src, '/js/vendor/jsQR.js');
  assert.equal(f.hooks.jsQrInput.width, 320);
  assert.equal(f.hooks.jsQrInput.height, 240);
  assert.equal(f.hooks.jsQrInput.length, 320 * 240 * 4);
  assert.equal(f.hooks.jsQrInput.options.inversionAttempts, 'attemptBoth');
  assert.deepEqual(f.posts.slice(-2), [
    { eventType: 'qr_text_received', eventData: { data: 'https://example.test/from-local-decoder' } },
    { eventType: 'scan_qr_popup_closed', eventData: {} },
  ]);
  assert.equal(f.cameraTracks[0].stopped, true);

  f.hooks.qrScriptLoader = undefined;
  f.window.jsQR = () => null;
  send('web_app_open_scan_qr_popup');
  const cancelDialog = overlay.children.at(-1).children[0];
  await cancelDialog.children[3].children[1].onclick();
  cancelDialog.children[3].children[0].onclick();
  assert.equal(f.cameraTracks.at(-1).stopped, true);
  assert.equal(f.posts.at(-1).eventType, 'scan_qr_popup_closed');

  f.navigator.mediaDevices.getUserMedia = undefined;
  send('web_app_open_scan_qr_popup');
  assert.match(overlay.nodes['.mini-app-status'].textContent, /无法访问相机/);
  assert.equal(f.posts.at(-1).eventType, 'scan_qr_popup_closed');
  f.window.MiniApp.close();
});

test('Mini App phone request sends only a status after the user confirms sharing', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = () => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType: 'web_app_request_phone' }) });
  send();
  let dialog = overlay.children.at(-1).children[0];
  assert.match(dialog.children[1].textContent, /不会回传给网页/);
  assert.equal(f.calls.some(call => call.url.endsWith('/phone')), false);
  dialog.children[2].children[0].onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'phone_requested', eventData: { status: 'cancelled' } });

  send();
  dialog = overlay.children.at(-1).children[0];
  await dialog.children[2].children[1].onclick();
  const request = f.calls.find(call => call.url.endsWith('/phone'));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(f.posts.at(-1), { eventType: 'phone_requested', eventData: { status: 'sent' } });
  f.window.MiniApp.close();
});

test('Mini App file download is Telegram-checked and waits for a separate host confirmation click', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const send = eventData => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_request_file_download', eventData,
  }) });
  send({ file_name: 'guide.pdf', url: 'https://bot.example/guide.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  const check = f.calls.find(call => call.url.endsWith('/download-check'));
  assert.equal(check.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(JSON.parse(check.options.body), { fileName: 'guide.pdf', url: 'https://bot.example/guide.pdf' });
  assert.equal(f.posts.some(message => message.eventType === 'file_download_requested'), false);
  let dialog = overlay.children.at(-1).children[0];
  assert.match(dialog.children[1].textContent, /guide.pdf/);
  const download = dialog.children[2].children[1];
  assert.equal(download.href, 'https://bot.example/guide.pdf');
  assert.equal(download.target, '_blank');
  download.onclick();
  assert.deepEqual(f.posts.at(-1), { eventType: 'file_download_requested', eventData: { status: 'downloading' } });

  f.hooks.downloadAllowed = false;
  send({ file_name: 'blocked.pdf', url: 'https://bot.example/blocked.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.posts.at(-1), { eventType: 'file_download_requested', eventData: { status: 'cancelled' } });
  const callsBeforeUnsafe = f.calls.length;
  send({ file_name: 'bad.pdf', url: 'https://localhost/private.pdf' });
  assert.equal(f.calls.length, callsBeforeUnsafe);
  assert.deepEqual(f.posts.at(-1), { eventType: 'file_download_requested', eventData: { status: 'cancelled' } });
  f.window.MiniApp.close();
});

test('simple Web App data is displayed and sent only after a separate host confirmation', async () => {
  const f = fixture(); f.hooks.simpleWebView = true;
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_data_send', eventData: { data: 'order:42' },
  }) });
  assert.equal(f.calls.some(call => call.url.endsWith('/send-data')), false);
  let dialog = overlay.children.at(-1).children[0];
  assert.equal(dialog.attributes.role, 'alertdialog');
  assert.match(dialog.children[1].textContent, /order:42/);
  dialog.children[2].children[0].onclick();
  assert.equal(f.calls.some(call => call.url.endsWith('/send-data')), false);
  f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({
    eventType: 'web_app_data_send', eventData: { data: 'order:42' },
  }) });
  dialog = overlay.children.at(-1).children[0];
  await dialog.children[2].children[1].onclick();
  const send = f.calls.find(call => call.url.endsWith('/send-data'));
  assert.equal(send.options.headers['X-Mini-App-Key'], 'opaque-key');
  assert.deepEqual(JSON.parse(send.options.body), { data: 'order:42' });
  assert.equal(overlay.hidden, true);
  assert.equal(f.notices.at(-1), 'Mini App 数据已发送给机器人');
});

test('Mini App device sensors stream typed updates and stop cleanly', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const frame = f.document.body.children[0].nodes['.mini-app-frame-area'].children[0];
  const send = (eventType, eventData = {}) => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType, eventData }) });
  send('web_app_start_accelerometer', { refresh_rate: 40 });
  send('web_app_start_gyroscope', { refresh_rate: 60 });
  f.listeners.devicemotion({
    acceleration: { x: 1, y: 2, z: 3 }, rotationRate: { alpha: 4, beta: 5, gamma: 6 },
  });
  assert.ok(f.posts.some(message => message.eventType === 'accelerometer_started'));
  assert.ok(f.posts.some(message => message.eventType === 'gyroscope_started'));
  assert.ok(f.posts.some(message => message.eventType === 'accelerometer_changed' && message.eventData.x === 1));
  assert.ok(f.posts.some(message => message.eventType === 'gyroscope_changed' && message.eventData.z === 6));

  send('web_app_start_device_orientation', { refresh_rate: 30 });
  f.listeners.deviceorientation({ absolute: false, alpha: 10, beta: 20, gamma: 30 });
  assert.ok(f.posts.some(message => message.eventType === 'device_orientation_started'));
  assert.deepEqual(f.posts.find(message => message.eventType === 'device_orientation_changed').eventData,
    { absolute: false, alpha: 10, beta: 20, gamma: 30 });
  send('web_app_stop_accelerometer');
  send('web_app_stop_gyroscope');
  send('web_app_stop_device_orientation');
  assert.deepEqual(f.posts.slice(-3).map(message => message.eventType), [
    'accelerometer_stopped', 'gyroscope_stopped', 'device_orientation_stopped',
  ]);
  f.window.MiniApp.close();
  assert.equal(f.listeners.devicemotion, undefined);
  assert.equal(f.listeners.deviceorientation, undefined);
});

test('Mini App fullscreen, visibility, and unsupported API responses follow Telegram Web events', async () => {
  const f = fixture();
  await f.window.MiniApp.open({ instId: 'a', chatId: 10, selectionVersion: 3, messageId: 55 }, 0, 0);
  const overlay = f.document.body.children[0];
  const frame = overlay.nodes['.mini-app-frame-area'].children[0];
  const appWindow = overlay.nodes['.mini-app-window'];
  const send = (eventType, eventData = {}) => f.listeners.message({ source: frame.contentWindow, origin: 'null', data: JSON.stringify({ eventType, eventData }) });

  appWindow.requestFullscreen = async () => { f.document.fullscreenElement = appWindow; };
  f.document.exitFullscreen = async () => { f.document.fullscreenElement = null; };
  send('web_app_request_fullscreen');
  await new Promise(resolve => setImmediate(resolve));
  f.documentListeners.fullscreenchange();
  assert.deepEqual(f.posts.at(-1), { eventType: 'fullscreen_changed', eventData: { is_fullscreen: true } });
  send('web_app_exit_fullscreen');
  assert.deepEqual(f.posts.at(-1), { eventType: 'fullscreen_changed', eventData: { is_fullscreen: false } });
  f.document.visibilityState = 'hidden';
  f.documentListeners.visibilitychange();
  assert.deepEqual(f.posts.at(-1), { eventType: 'visibility_changed', eventData: { is_visible: false } });

  send('web_app_check_home_screen');
  assert.deepEqual(f.posts.at(-1), { eventType: 'home_screen_checked', eventData: { status: 'unsupported' } });
  send('web_app_add_to_home_screen');
  assert.deepEqual(f.posts.at(-1), { eventType: 'home_screen_failed', eventData: { error: 'UNSUPPORTED' } });
  send('web_app_biometry_get_info');
  assert.deepEqual(f.posts.at(-1), { eventType: 'biometry_info_received', eventData: {
    available: false, access_requested: false, access_granted: false, token_saved: false, device_id: '',
  } });
  send('web_app_secure_storage_get_key', { req_id: 'safe-key', key: 'token' });
  assert.deepEqual(f.posts.at(-1), { eventType: 'secure_storage_failed', eventData: { req_id: 'safe-key', error: 'UNSUPPORTED' } });
  send('web_app_open_scan_qr_popup');
  assert.equal(overlay.children.at(-1).children[0].children[0].textContent, '扫描 QR 码');
  assert.equal(f.posts.at(-1).eventType, 'secure_storage_failed');
  f.window.MiniApp.close();
});

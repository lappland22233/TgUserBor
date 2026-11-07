'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram contact picker returns account contacts with phone numbers', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    assert.ok(request instanceof Api.contacts.GetContacts);
    assert.equal(request.hash.toString(), '0');
    return { users: [
      new Api.User({ id: bigInt(9), firstName: 'Alice', phone: '+12345' }),
      new Api.User({ id: bigInt(10), firstName: 'Robot', bot: true }),
    ] };
  } };
  assert.deepEqual(await driver.getContacts(), [
    { id: 9, username: undefined, firstName: 'Alice', lastName: undefined, isBot: false, phone: '+12345' },
    { id: 10, username: undefined, firstName: 'Robot', lastName: undefined, isBot: true, phone: undefined },
  ]);
});

test('contacts endpoint reads only the requested Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async action => {
    calls.push({ id, action }); return [{ id: 9, firstName: 'Alice', phone: '+12345' }];
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/instances/a/account/contacts`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 9, firstName: 'Alice', phone: '+12345' }]);
    assert.deepEqual(calls, [{ id: 'a', action: 'get_contacts' }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function contactPickerHarness(api) {
  class Element {
    constructor() { this.children = []; this.style = {}; this.dataset = {}; this.handlers = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    querySelectorAll() { return []; }
    contains() { return false; }
    focus() { this.focused = true; }
    reset() { for (const element of Object.values(elements)) if (element instanceof Element) element.value = ''; }
  }
  const ids = [
    'chat-context-menu', 'modal-contact-share', 'form-contact-share', 'contact-share-first',
    'contact-share-last', 'contact-share-phone', 'btn-submit-contact-share', 'btn-load-share-contacts',
    'contact-share-picker', 'contact-share-search', 'contact-share-picker-status', 'contact-share-picker-list',
    'menu-share-contact', 'btn-close-contact-share', 'btn-cancel-contact-share',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements['chat-context-menu'].contains = () => false;
  const document = {
    getElementById: id => elements[id] || null,
    createElement: () => new Element(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 123, chatSelectionVersion: 1 };
  const context = vm.createContext({ document, state, api, encodeURIComponent, showToast() {}, updateChatMenuVisuals() {},
    localStorage: { setItem() {} }, window: { isSecureContext: true }, navigator: {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function initChatContextMenu() {');
  const end = source.indexOf('\n}\n\nfunction updateChatMenuVisuals()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end + 2)}\nthis.init = initChatContextMenu;`, context);
  context.init();
  return { elements, state };
}

test('contact picker filters Telegram contacts and fills the manual contact card fields', async () => {
  let requestUrl;
  const { elements } = contactPickerHarness(async url => {
    requestUrl = url;
    return [
      { id: 9, firstName: 'Alice', lastName: 'Example', phone: '+12345', isBot: false },
      { id: 10, firstName: 'No Phone', isBot: false },
      { id: 11, firstName: 'Bot', phone: '+555', isBot: true },
    ];
  });
  elements['menu-share-contact'].onclick();
  await elements['btn-load-share-contacts'].onclick();
  assert.equal(requestUrl, '/api/instances/a/account/contacts');
  assert.equal(elements['contact-share-picker-list'].children.length, 1);
  assert.equal(elements['contact-share-picker-list'].children[0].children[0].textContent, 'Alice Example');
  elements['contact-share-picker-list'].children[0].onclick();
  assert.equal(elements['contact-share-first'].value, 'Alice');
  assert.equal(elements['contact-share-last'].value, 'Example');
  assert.equal(elements['contact-share-phone'].value, '+12345');
  assert.equal(elements['contact-share-picker'].hidden, true);
});

test('late contact picker responses are discarded after the chat changes', async () => {
  let resolveContacts;
  const { elements, state } = contactPickerHarness(() => new Promise(resolve => { resolveContacts = resolve; }));
  elements['menu-share-contact'].onclick();
  const loading = elements['btn-load-share-contacts'].onclick();
  state.clientActiveChatId = 456;
  resolveContacts([{ id: 9, firstName: 'Alice', phone: '+12345', isBot: false }]);
  await loading;
  assert.equal(elements['contact-share-picker-list'].children.length, 0);
  assert.equal(elements['contact-share-first'].value, '');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Element {
  constructor() { this.children = []; this.handlers = {}; this.hidden = true; this.disabled = false; this.textContent = ''; this.value = ''; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'button' ? this.children.find(child => child.type === 'button') || null : null; }
  click() { this.handlers.click?.({ preventDefault() {}, stopPropagation() {} }); }
}

function fixture(api) {
  const menu = new Element();
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 123, chatSelectionVersion: 5 };
  const textarea = new Element();
  const toasts = [], reloads = [];
  let draftChanges = 0, dialogRenders = 0;
  const context = vm.createContext({ state,
    document: { getElementById: id => id === 'quick-reply-suggestions' ? menu : null, createElement: () => new Element() },
    api, encodeURIComponent, autoResizeTextarea() {}, notifyCurrentDraftChanged: () => draftChanges++, renderClientDialogs: () => dialogRenders++,
    showToast: value => toasts.push(value), loadClientMessages: (...args) => reloads.push(args),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let quickReplyShortcutCatalog = new Map();');
  const end = source.indexOf('\nasync function openQuickRepliesDialog()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.update = updateQuickReplySuggestions;`, context);
  return { context, state, textarea, menu, toasts, reloads, get draftChanges() { return draftChanges; }, get dialogRenders() { return dialogRenders; } };
}

test('slash suggestions filter Telegram quick replies and send the selected shortcut', async () => {
  const requests = [];
  const ui = fixture((url, method, body) => new Promise(resolve => requests.push({ url, method, body, resolve })));
  ui.textarea.value = '/he';
  const loading = ui.context.update(ui.textarea);
  assert.equal(requests[0].url, '/api/instances/a/account/quick-replies');
  requests[0].resolve([
    { shortcutId: 4, shortcut: 'hello', count: 2 },
    { shortcutId: 5, shortcut: 'bye', count: 1 },
  ]);
  await loading;
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.menu.children.length, 1);
  assert.equal(ui.menu.children[0].children[0].textContent, '/hello');
  assert.equal(ui.menu.children[0].children[1].textContent, '2 条消息');
  ui.menu.children[0].click();
  assert.equal(requests[1].url, '/api/instances/a/account/quick-reply/send');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].body)), { chatId: 123, shortcutId: 4 });
  requests[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.textarea.value, '');
  assert.equal(ui.menu.hidden, true);
  assert.deepEqual(ui.reloads, [[123, true]]);
  assert.equal(ui.draftChanges, 1);
  assert.equal(ui.dialogRenders, 1);
  assert.deepEqual(ui.toasts, ['快捷回复已发送']);
});

test('slash results are discarded after a chat switch and group chats never request them', async () => {
  let resolve;
  const pending = fixture(() => new Promise(done => { resolve = done; }));
  pending.textarea.value = '/';
  const loading = pending.context.update(pending.textarea);
  pending.state.clientActiveChatId = 44; pending.state.chatSelectionVersion++;
  resolve([{ shortcutId: 4, shortcut: 'hello', count: 1 }]);
  await loading;
  assert.equal(pending.menu.hidden, true);

  let calls = 0;
  const group = fixture(async () => { calls++; return []; });
  group.state.clientActiveChatId = -100123;
  group.textarea.value = '/hello';
  await group.context.update(group.textarea);
  assert.equal(calls, 0);
  assert.equal(group.menu.hidden, true);
});

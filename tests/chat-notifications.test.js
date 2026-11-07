'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/chat-notifications.js'), 'utf8');
function fixture(permission = 'granted') {
  const values = new Map(), created = [];
  class Notification {
    static permission = permission;
    static async requestPermission() { return Notification.permission; }
    constructor(title, options) { created.push({ title, options }); }
    close() {}
  }
  const window = { Notification, focus() {} };
  const document = { hidden: true, hasFocus: () => !document.hidden };
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  vm.runInNewContext(source, { window, document, localStorage, Notification });
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, clientDialogs: [{ id: 1, title: 'Chat', muted: false }] };
  const event = { instId: 'a', message: { id: 2, chatId: 1, text: 'hello' } };
  return { window, document, state, event, created };
}
test('browser notification requires user permission and is off by default', async () => {
  const f = fixture('denied');
  f.window.ChatNotifications.maybeNotify(f.event, f.state);
  assert.equal(f.created.length, 0);
  assert.equal(await f.window.ChatNotifications.setEnabled(true), false);
  f.window.ChatNotifications.maybeNotify(f.event, f.state);
  assert.equal(f.created.length, 0);
});
test('only new unmuted messages in background or another chat notify once', async () => {
  const f = fixture(); await f.window.ChatNotifications.setEnabled(true);
  f.window.ChatNotifications.maybeNotify(f.event, f.state);
  f.window.ChatNotifications.maybeNotify(f.event, f.state);
  assert.equal(f.created.length, 1);
  f.state.clientDialogs[0].muted = true;
  f.window.ChatNotifications.maybeNotify({ instId: 'a', message: { id: 3, chatId: 1 } }, f.state);
  f.window.ChatNotifications.maybeNotify({ instId: 'b', message: { id: 4, chatId: 1 } }, f.state);
  f.state.clientDialogs[0].muted = false; f.document.hidden = false;
  f.window.ChatNotifications.maybeNotify({ instId: 'a', message: { id: 5, chatId: 1 } }, f.state);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].options.body, 'hello');
});

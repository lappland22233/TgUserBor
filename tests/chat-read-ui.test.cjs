'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('function updateClientTotalUnreadBadge() {');
const end = source.indexOf('\nfunction renderClientDialogs()', start);
if (start < 0 || end < 0) throw new Error('Cannot locate dialog read helpers');

function setup(filter, dialog, folderApply = (_filter, dialogs) => dialogs) {
  const badgeTotal = { innerText: '1', style: { display: 'inline-block' } };
  let rowRemoved = false;
  let emptyState = null;
  const unreadBadge = { removed: false, remove() { this.removed = true; } };
  const row = {
    dataset: { chatId: String(dialog.id) },
    querySelector: selector => selector === '.dialog-badge' ? unreadBadge : null,
    remove() { rowRemoved = true; },
  };
  const container = {
    querySelectorAll(selector) { return selector === '.dialog-item' && !rowRemoved ? [row] : []; },
    querySelector(selector) {
      if (selector === '.dialog-item') return rowRemoved ? null : row;
      if (selector === '.empty-state') return emptyState;
      return null;
    },
    prepend(element) { emptyState = element; },
  };
  const document = {
    getElementById(id) { return id === 'client-dialogs-list' ? container : id === 'badge-unread-total' ? badgeTotal : null; },
    createElement() { return { className: '', textContent: '' }; },
  };
  const state = { clientDialogFilter: filter, clientDialogs: [dialog] };
  const context = vm.createContext({ state, document, window: { DialogFolders: { apply: folderApply } } });
  vm.runInContext(`${source.slice(start, end)}\nthis.updateClientDialogUnreadBadge = updateClientDialogUnreadBadge;`, context);
  return { context, badgeTotal, unreadBadge, rowRemoved: () => rowRemoved, emptyState: () => emptyState };
}

test('read acknowledgement removes rows from unread and exclude-read folders without rerendering others', () => {
  const unread = setup('unread', { id: 1, unreadCount: 0 });
  unread.context.updateClientDialogUnreadBadge(1);
  assert.equal(unread.rowRemoved(), true);
  assert.equal(unread.emptyState().textContent, '没有未读会话');
  assert.equal(unread.badgeTotal.style.display, 'none');

  const folder = setup('folder:4', { id: 2, unreadCount: 0 }, (_filter, dialogs) => []);
  folder.context.updateClientDialogUnreadBadge(2);
  assert.equal(folder.rowRemoved(), true);
  assert.equal(folder.emptyState().textContent, '未找到匹配的会话');

  const included = setup('folder:4', { id: 3, unreadCount: 0 }, (_filter, dialogs) => dialogs);
  included.context.updateClientDialogUnreadBadge(3);
  assert.equal(included.rowRemoved(), false, 'explicitly included peers remain in the custom folder');
  assert.equal(included.unreadBadge.removed, true);
});

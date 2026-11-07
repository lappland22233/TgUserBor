'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const currentStart = app.indexOf('function isCurrentMessagesRequest(');
const tagStart = app.indexOf('let savedMessageTagCatalog =', currentStart);
const helperEnd = app.indexOf('function restoreBotReplyKeyboardState(', tagStart);
const historyStart = app.indexOf('async function loadClientMessages(', helperEnd);
const historyEnd = app.indexOf('async function loadEarlierMessages(', historyStart);
if ([currentStart, tagStart, helperEnd, historyStart, historyEnd].some(value => value < 0)) throw new Error('Cannot locate Saved Messages tag UI');

class Element {
  constructor() { this.children = []; this.attributes = {}; this.hidden = false; this.style = {}; this.classList = { add() {}, remove() {} }; this.value = ''; this.textContent = ''; this.innerHTML = ''; }
  replaceChildren(...items) { this.children = [...items]; }
  appendChild(item) { this.children.push(item); return item; }
  append(...items) { this.children.push(...items); }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function harness(isSelf = true) {
  const ids = ['saved-message-tags-bar', 'saved-message-tags-scroll', 'saved-message-tag-editor-status', 'client-messages-container'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 77, clientActiveDialog: { id: 77, isSelf }, clientDialogs: [], clientMessages: [], clientHistoryOffsetDate: null, clientSavedReactionFilter: null, chatSelectionVersion: 1 };
  const calls = [];
  const document = { getElementById: id => nodes[id] || null, createElement: () => new Element() };
  const context = vm.createContext({ state, document, window: { chatWs: null, BotKeyboard: null }, URLSearchParams, encodeURIComponent,
    Promise, Date, Math, Number, String, Array, Map, Boolean, JSON,
    api: (url, method, body) => {
      calls.push({ url, method, body });
      if (url.includes('/saved-message-tags')) return Promise.resolve({ tags: [], defaults: [{ type: 'emoji', value: '📚' }] });
      if (url.includes('/account/messages')) return Promise.resolve([{ id: 20, text: 'tagged' }]);
      return Promise.resolve({ success: true });
    },
    updateClientHistoryBanner() {}, renderClientMessages() {}, showToast() {},
  });
  const support = `let clientMessagesRequest = 0; let isLoadingEarlierMessages = false; let hasReachedEarliestMessage = false;\n${app.slice(currentStart, tagStart)}`;
  vm.runInContext(support + app.slice(tagStart, helperEnd) + app.slice(historyStart, historyEnd) + '\nthis.loadTags = loadSavedMessageTags; this.selectTag = renderSavedMessageTagBar;', context);
  return { context, nodes, calls, state };
}

test('Saved Messages chips fetch the Telegram catalog and filter the account history by savedReaction', async () => {
  const h = harness();
  await h.context.loadTags('a', h.state.clientActiveDialog, 1);
  const chips = h.nodes['saved-message-tags-scroll'].children;
  assert.equal(h.nodes['saved-message-tags-bar'].hidden, false);
  assert.equal(chips.length, 2);
  chips[1].onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.clientSavedReactionFilter, { type: 'emoji', value: '📚' });
  const history = h.calls.find(call => call.url.includes('/account/messages'));
  assert.ok(history);
  const url = new URL(history.url, 'http://localhost');
  assert.deepEqual(JSON.parse(url.searchParams.get('savedReaction')), { type: 'emoji', value: '📚' });
});

test('Saved Messages tag controls stay hidden for chats that are not the account owner', async () => {
  const h = harness(false);
  await h.context.loadTags('a', h.state.clientActiveDialog, 1);
  assert.equal(h.nodes['saved-message-tags-bar'].hidden, true);
  assert.equal(h.calls.length, 0);
});

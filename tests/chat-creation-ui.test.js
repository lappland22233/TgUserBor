'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('state.groupMembers = [];');
const end = source.indexOf('// ==========================================\n// Jump to Date Calendar Controller', start);
if (start < 0 || end < 0) throw new Error('Cannot locate create chat controllers');

class Element {
  constructor() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.textContent = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  focus() {}
}

function setup() {
  const ids = ['modal-create-chat', 'create-chat-type', 'create-chat-name', 'create-chat-about', 'create-chat-forum',
    'create-chat-member-search', 'create-chat-member-status', 'create-chat-member-list', 'create-chat-status', 'btn-submit-create-chat',
    'create-chat-members-wrap', 'create-chat-about-wrap', 'create-chat-forum-wrap'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const requests = [], selected = [], rendered = [];
  const state = { clientSelectedInstance: 'a', clientDialogs: [] };
  const context = vm.createContext({
    state, window: {}, document: { getElementById: id => elements.get(id) || null, createElement: () => new Element() },
    api: (url, method = 'GET', body) => new Promise(resolve => requests.push({ url, method, body, resolve })),
    showToast: message => selected.push(message), renderClientDialogs: () => rendered.push(true), selectClientChat: dialog => selected.push(dialog),
  });
  vm.runInContext(source.slice(start, end) + '\nthis.open = openCreateChatModal; this.search = searchCreateChatCandidates; this.create = createTelegramChat;', context);
  return { context, elements, requests, selected, rendered, state };
}

test('new group flow searches Telegram users, requires a member and opens the created chat', async () => {
  const h = setup();
  h.context.open();
  h.elements.get('create-chat-name').value = 'Study group';
  const search = h.context.search('alice');
  assert.match(h.requests[0].url, /search-dialogs\?query=alice/);
  h.requests[0].resolve([{ id: 20, type: 'private', title: 'Alice Example', username: 'alice' }]);
  await search;
  const checkbox = h.elements.get('create-chat-member-list').children[0].children[0];
  checkbox.checked = true;
  checkbox.onchange();
  const submit = h.context.create({ preventDefault() {} });
  assert.equal(h.requests[1].url, '/api/instances/a/account/create-chat');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].body)), {
    type: 'group', title: 'Study group', about: '', userIds: [20], forum: false,
  });
  h.requests[1].resolve({ id: -42, type: 'group', title: 'Study group', unreadCount: 0 });
  await submit;
  assert.equal(JSON.stringify(h.state.clientDialogs.map(dialog => dialog.id)), '[-42]');
  assert.equal(h.selected[0].id, -42);
  assert.equal(h.elements.get('modal-create-chat').style.display, 'none');
  assert.equal(h.rendered.length, 1);
});

test('late create-chat searches do not restore candidates after switching Telegram accounts', async () => {
  const h = setup();
  h.context.open();
  const search = h.context.search('bob');
  h.state.clientSelectedInstance = 'b';
  h.requests[0].resolve([{ id: 30, type: 'private', title: 'Bob' }]);
  await search;
  assert.equal(h.elements.get('create-chat-member-list').children.length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/gui/web/app.js', 'utf8');

test('To-do checklist rendering escapes task text and follows Telegram completion/add permissions', () => {
  const start = source.indexOf('function renderTodoChecklist(');
  const end = source.indexOf('\nfunction renderPaidMediaItems(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    state: {clientSelectedInstance:'a'}, encodeURIComponent,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatMessageContent: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    inlineJsArg: value => JSON.stringify(String(value)),
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.render = renderTodoChecklist;`, context);
  const html = context.render({ todoTitle: 'Trip', todoItems: [{ id: 1, title: '<img src=x>' }, { id: 2, title: 'Walk' }],
    todoCompletions: [{ id: 2, completedBy: 42 }], todoOthersCanAppend: true, todoOthersCanComplete: true },
  { id: 9, outgoing: false }, 10);
  assert.doesNotMatch(html, /todo-task-title"><img/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /account\/avatar\?chatId=42/);
  assert.match(html, /todo-task-completer-avatar/);
  assert.match(html, /toggleTelegramTodoTask\("10", "9", 1, true\)/);
  assert.match(html, /＋ 添加任务/);
  const readonly = context.render({ todoItems: [{ id: 1, title: 'Task' }] }, { id: 9, outgoing: false, fwdFrom: {} }, 10);
  assert.match(readonly, /disabled/);
  assert.doesNotMatch(readonly, /todo-task-append/);
  const nonUserCompletion = context.render({ todoItems:[{id:1,title:'Task'}], todoCompletions:[{id:1,completedBy:-100123}] }, {id:10,outgoing:false}, 10);
  assert.doesNotMatch(nonUserCompletion, /todo-task-completer-avatar/);
});

function actionHarness({ prompts = [], confirmations = [], api = async () => ({}) } = {}) {
  const start = source.indexOf('async function createTelegramTodoList(');
  const end = source.indexOf('\nfunction getMessageAlbumGroupId(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 1,
    clientDialogs: [{ id: 42, type: 'supergroup' }] };
  const calls = [], loads = [], toasts = [];
  let promptIndex = 0, confirmIndex = 0;
  const context = vm.createContext({ state, encodeURIComponent, pendingTodoToggles: new Set(),
    window: { prompt: () => prompts[promptIndex++], confirm: () => Boolean(confirmations[confirmIndex++]) },
    api: async (url, method, body) => { calls.push({ url, method, body }); return api(url, method, body); },
    loadClientMessages: (...args) => loads.push(args), showToast: (...args) => toasts.push(args),
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.create = createTelegramTodoList; this.toggle = toggleTelegramTodoTask; this.append = appendTelegramTodoTask;`, context);
  return { context, state, calls, loads, toasts };
}

test('creating a Telegram checklist sends bounded tasks and explicit member permissions', async () => {
  const h = actionHarness({ prompts: ['Trip', 'Book train\nPack bag'], confirmations: [true, false] });
  await h.context.create();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), {
    chatId: 42, title: 'Trip', tasks: ['Book train', 'Pack bag'], othersCanComplete: true, othersCanAppend: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(h.loads[0])), [42, true]);
});

test('To-do task completion and append actions stay bound to the selected chat', async () => {
  let resolve;
  const h = actionHarness({ prompts: ['Ask everyone\nBring snacks'], api: () => new Promise(done => { resolve = done; }) });
  const pending = h.context.toggle(42, 9, 1, true);
  assert.equal(h.calls[0].url, '/api/instances/a/account/todo/toggle');
  h.state.clientActiveChatId = 43;
  resolve({});
  await pending;
  assert.equal(h.loads.length, 0);
  h.state.clientActiveChatId = 42;
  h.state.chatSelectionVersion++;
  const append = h.context.append(42, 9);
  assert.equal(h.calls[1].url, '/api/instances/a/account/todo/append');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].body)), { chatId: 42, messageId: 9, tasks: ['Ask everyone', 'Bring snacks'] });
  resolve({});
  await append;
  assert.equal(h.loads.length, 1);
});

test('editing a sent To-do list keeps task IDs through reordering and adds new IDs server-side', async () => {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.checked = false; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { if (node.parentElement) node.remove(); node.parentElement = this; this.children.push(node); return node; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(name, handler) { (this.listeners ||= {})[name] = handler; }
    get lastElementChild() { return this.children.at(-1) || null; }
    get previousElementSibling() { const i = this.parentElement?.children.indexOf(this) ?? -1; return i > 0 ? this.parentElement.children[i - 1] : null; }
    get nextElementSibling() { const i = this.parentElement?.children.indexOf(this) ?? -1; return i >= 0 ? this.parentElement.children[i + 1] || null : null; }
    insertBefore(node, reference) {
      if (node.parentElement) node.remove();
      const index = this.children.indexOf(reference);
      node.parentElement = this;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
    }
    remove() { if (!this.parentElement) return; const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; }
    focus() {}
    querySelector(selector) {
      const attr = /^\[aria-label="(.+)"\]$/.exec(selector);
      const matches = node => selector === 'input' ? node.tagName === 'input' : attr ? node.attributes['aria-label'] === attr[1] : false;
      if (matches(this)) return this;
      for (const child of this.children) { const result = child.querySelector(selector); if (result) return result; }
      return null;
    }
  }
  const body = new Node('body');
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 3,
    clientMessages: [{ id: 9, outgoing: true, media: { type: 'todo', todoTitle: 'Trip', todoItems: [{ id: 4, title: 'Pack' }, { id: 7, title: 'Tickets' }], todoOthersCanComplete: true, todoOthersCanAppend: false } }] };
  const calls = [], loads = [];
  const context = vm.createContext({ state, encodeURIComponent, document: { body, createElement: tag => new Node(tag), createTextNode: text => Object.assign(new Node('#text'), { textContent: text }) },
    api: async (url, method, payload) => { calls.push({ url, method, payload }); return {}; },
    loadClientMessages: (...args) => loads.push(args),
  });
  const start = source.indexOf('function editTelegramTodoList(');
  const end = source.indexOf('\nfunction getMessageAlbumGroupId(', start);
  vm.runInContext(`${source.slice(start, end)}\nthis.edit = editTelegramTodoList;`, context);
  context.edit(42, 9);
  const overlay = body.children[0], dialog = overlay.children[0];
  const titleLabel = dialog.children[1], titleInput = titleLabel.children[0];
  const list = dialog.children.find(child => child.className === 'todo-editor-items');
  titleInput.value = 'Updated trip';
  list.children[0].children[2].onclick();
  assert.equal(list.children[0].dataset.taskId, '7', 'reorder keeps task IDs attached to their content');
  const removeTask = list.children.find(row => row.dataset.taskId === '4');
  removeTask.children[3].onclick();
  const add = dialog.children.find(child => child.textContent === '＋ 添加任务');
  add.onclick();
  list.children[0].children[0].value = 'Tickets updated';
  list.lastElementChild.children[0].value = 'Check weather';
  const permissions = dialog.children.find(child => child.className === 'todo-editor-permissions');
  permissions.children[0].children[0].checked = false;
  permissions.children[1].children[0].checked = true;
  const actions = dialog.children.at(-1);
  await actions.children[1].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), {
    chatId: 42, messageId: 9, title: 'Updated trip',
    tasks: [{ id: 7, title: 'Tickets updated' }, { title: 'Check weather' }],
    othersCanComplete: false, othersCanAppend: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(loads[0])), [42, true]);
  assert.equal(body.children.length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const { handleApiRoute } = require('../dist/gui/api');

test('message report routes validate inputs and keep each Telegram step on one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params });
    return action === 'start_message_report' ? { status: 'choose', title: '原因', options: [{ token: 'A'.repeat(32), text: '垃圾' }] } : { status: 'reported' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/message-report`;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(base, { chatId: 1, messageId: 0 })).status, 400);
    const start = await post(base, { chatId: -10042, messageId: 9 });
    assert.deepEqual(await start.json(), { status: 'choose', title: '原因', options: [{ token: 'A'.repeat(32), text: '垃圾' }] });
    assert.equal((await post(`${base}/continue`, { token: 'bad' })).status, 400);
    const finish = await post(`${base}/continue`, { token: 'A'.repeat(32), comment: '' });
    assert.deepEqual(await finish.json(), { status: 'reported' });
    assert.deepEqual(calls, [
      { action: 'start_message_report', params: { chatId: -10042, messageId: 9 } },
      { action: 'continue_message_report', params: { token: 'A'.repeat(32), comment: '' } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('report dialog follows Telegram choices and comments in an account-scoped in-app modal', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function reportTelegramMessage(');
  const end = source.indexOf('\n// A staged file remains visible', start);
  const code = source.slice(start, end);
  const elements = new Map();
  const makeElement = id => {
    const element = { id, style: {}, hidden: false, disabled: false, value: '', textContent: '', children: [], listeners: {}, classList: {
      add() {}, remove() {},
    }, addEventListener(name, callback) { this.listeners[name] = callback; },
    removeEventListener(name) { delete this.listeners[name]; }, appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }, querySelector() { return this.children[0] || null; },
    querySelectorAll() { return this.children; }, focus() {}, };
    return element;
  };
  for (const id of ['modal-message-report', 'message-report-title', 'message-report-description', 'message-report-choices',
    'message-report-comment-row', 'message-report-comment-label', 'message-report-comment', 'message-report-status',
    'btn-message-report-submit', 'btn-message-report-cancel', 'btn-message-report-close']) elements.set(id, makeElement(id));
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 2, chatSelectionVersion: 3 };
  const calls = [], notices = [];
  const context = vm.createContext({ state, encodeURIComponent, document: {
    getElementById: id => elements.get(id) || null, createElement: () => makeElement('option'),
    addEventListener() {}, removeEventListener() {},
  },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      return calls.length === 1
        ? { status: 'choose', title: '请选择', options: [{ token: 'B'.repeat(32), text: '垃圾' }, { token: 'C'.repeat(32), text: '仿冒' }] }
        : calls.length === 2 ? { status: 'comment', token: 'D'.repeat(32), optional: false } : { status: 'reported' };
    }, showToast: (message, kind) => notices.push({ message, kind }) });
  vm.runInContext(`${code}\nthis.reportTelegramMessage = reportTelegramMessage;`, context);
  await context.reportTelegramMessage({ instId: 'a', chatId: 2, id: 5, selectionVersion: 3 });
  assert.equal(elements.get('modal-message-report').style.display, 'flex');
  await elements.get('message-report-choices').children[1].onclick();
  elements.get('message-report-comment').value = '可疑链接';
  await elements.get('btn-message-report-submit').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(call => call.body))), [
    { chatId: 2, messageId: 5 }, { token: 'C'.repeat(32) }, { token: 'D'.repeat(32), comment: '可疑链接' },
  ]);
  assert.match(notices.at(-1).message, /已提交/);
  assert.equal(elements.get('modal-message-report').style.display, 'none');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram To-do HTTP routes validate list bounds and dispatch scoped account actions', async () => {
  const calls = [];
  const manager = { getInstance: () => ({ accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'send_todo_list' ? { messageId: 88 } : undefined;
  } }) };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/todo`;
    const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('create', { chatId: 1, title: 'Trip', tasks: [] })).status, 400);
    assert.equal((await post('create', { chatId: 1, title: 'Trip', tasks: Array(11).fill('x') })).status, 400);
    assert.equal((await post('create', { chatId: 1, title: 'Trip', tasks: ['ok', 'x'.repeat(256)] })).status, 400);
    const created = await post('create', { chatId: 1, title: 'Trip', tasks: ['Book a train'], othersCanComplete: true, othersCanAppend: false });
    assert.deepEqual(await created.json(), { messageId: 88 });
    assert.equal((await post('toggle', { chatId: 1, messageId: 8, taskId: 1, completed: 'yes' })).status, 400);
    assert.equal((await post('toggle', { chatId: 1, messageId: 8, taskId: 1, completed: true })).status, 200);
    assert.equal((await post('append', { chatId: 1, messageId: 8, tasks: ['Pack'] })).status, 200);
    assert.equal((await post('edit', { chatId: 1, messageId: 8, title: 'Trip', tasks: [{ id: 1, title: 'A' }, { id: 1, title: 'B' }] })).status, 400);
    assert.equal((await post('edit', { chatId: 1, messageId: 8, title: 'Trip', tasks: [{ id: 1, title: 'A' }, { title: 'B' }], othersCanComplete: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'send_todo_list', payload: { chatId: 1, title: 'Trip', tasks: ['Book a train'], othersCanComplete: true, othersCanAppend: false } },
      { action: 'toggle_todo_task', payload: { chatId: 1, messageId: 8, taskId: 1, completed: true } },
      { action: 'append_todo_tasks', payload: { chatId: 1, messageId: 8, tasks: ['Pack'] } },
      { action: 'edit_todo_list', payload: { chatId: 1, messageId: 8, title: 'Trip', tasks: [{ id: 1, title: 'A' }, { title: 'B' }], othersCanComplete: true, othersCanAppend: undefined } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

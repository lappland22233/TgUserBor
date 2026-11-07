'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { Api: ModernApi } = require('teleproto');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

const text = value => new ModernApi.TextWithEntities({ text: value, entities: [] });
const todoMedia = ({ othersCanAppend = false, othersCanComplete = false, ids = [1, 2], completions = [] } = {}) =>
  new ModernApi.MessageMediaToDo({ todo: new ModernApi.TodoList({ othersCanAppend, othersCanComplete, title: text('Trip'),
    list: ids.map(id => new ModernApi.TodoItem({ id, title: text(`Task ${id}`) })) }), completions });

function makeDriver() {
  return Object.create(TelegramDriver.prototype);
}

test('Telegram To-do media maps list permissions, task text, and completion peers', async () => {
  const sender = new Api.User({ id: bigInt(42), firstName: 'Alice' });
  const message = new Api.Message({ id: 8, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: '' });
  message.media = todoMedia({ othersCanAppend: true, othersCanComplete: true,
    completions: [new ModernApi.TodoCompletion({ id: 1, completedBy: new ModernApi.PeerUser({ userId: bigInt(42) }), date: 100 })] });
  message.getChat = async () => sender;
  message.getSender = async () => sender;
  const mapped = await makeDriver().mapMessage(message);
  assert.deepEqual(mapped.media, {
    type: 'todo', todoTitle: 'Trip', todoTitleEntities: [], todoOthersCanAppend: true, todoOthersCanComplete: true,
    todoItems: [{ id: 1, title: 'Task 1', entities: [] }, { id: 2, title: 'Task 2', entities: [] }],
    todoCompletions: [{ id: 1, completedBy: 42, date: 100 }],
  });
  message.action = new ModernApi.MessageActionTodoCompletions({ completed: [1], incompleted: [2] });
  const update = await makeDriver().mapMessage(message);
  assert.match(update.service.text, /更新了 2 项待办任务/);
  message.action = new ModernApi.MessageActionTodoAppendTasks({ list: [] });
  assert.match((await makeDriver().mapMessage(message)).service.text, /添加了任务/);
});

test('creating a Telegram To-do list sends one native InputMediaTodo message', async () => {
  const calls = [];
  const driver = makeDriver();
  driver.storyAlbumPeer = async id => { assert.equal(id, 42); return new ModernApi.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) }); };
  driver.client = {
    invoke: async request => { calls.push(request); return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 99, randomId: bigInt(1) })], users: [], chats: [], date: 1, seq: 1 }); },
    _getResponseMessage: async () => undefined,
  };
  assert.equal(await driver.sendTodoList(42, 'Trip', ['Book a train', 'Pack a bag'], { othersCanComplete: true, othersCanAppend: false }), 99);
  const request = calls[0];
  assert.ok(request instanceof Api.messages.SendMedia);
  assert.equal(request.media.className, 'InputMediaTodo');
  assert.equal(request.media.todo.title.text, 'Trip');
  assert.equal(request.media.todo.othersCanComplete, true);
  assert.equal(request.media.todo.othersCanAppend, false);
  assert.deepEqual(request.media.todo.list.map(item => [item.id, item.title.text]), [[1, 'Book a train'], [2, 'Pack a bag']]);
  await assert.rejects(driver.sendTodoList(42, 'Trip', []), /Invalid Telegram to-do list/);
  await assert.rejects(driver.sendTodoList(42, 'Trip', Array(11).fill('x')), /Invalid Telegram to-do list/);
});

test('Telegram To-do task toggles and appends revalidate the original list and rights', async () => {
  const calls = [];
  const driver = makeDriver();
  driver.storyAlbumPeer = async () => new ModernApi.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) });
  const message = { out: false, media: todoMedia({ othersCanAppend: true, othersCanComplete: true, ids: [1, 4] }) };
  driver.client = { getMessages: async (_peer, options) => { assert.deepEqual(options.ids, [7]); return [message]; }, invoke: async request => { calls.push(request); } };
  await driver.toggleTodoTask(42, 7, 4, true);
  assert.ok(calls[0] instanceof ModernApi.messages.ToggleTodoCompleted);
  assert.deepEqual(calls[0].completed, [4]);
  assert.deepEqual(calls[0].incompleted, []);
  await driver.appendTodoTasks(42, 7, ['One more']);
  assert.ok(calls[1] instanceof ModernApi.messages.AppendTodoList);
  assert.deepEqual(calls[1].list.map(item => [item.id, item.title.text]), [[5, 'One more']]);
  await assert.rejects(driver.toggleTodoTask(42, 7, 9, true), /not found/);
  await assert.rejects(driver.appendTodoTasks(42, 7, Array(10).fill('x')), /up to 10 tasks/);
  message.out = false;
  message.media = todoMedia();
  await assert.rejects(driver.toggleTodoTask(42, 7, 1, true), /read-only/);
});

test('editing a Telegram To-do list preserves stable task IDs while changing order and permissions', async () => {
  const calls = [];
  const driver = makeDriver();
  driver.storyAlbumPeer = async () => new ModernApi.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) });
  driver.client = { getMessages: async () => [{ out: true, media: todoMedia({ ids: [1, 4], othersCanComplete: true }) }],
    invoke: async request => { calls.push(request); } };
  await driver.editTodoList(42, 7, 'Updated trip', [{ id: 4, title: 'Pack bag' }, { id: 1, title: 'Buy tickets' }, { title: 'Check weather' }],
    { othersCanComplete: false, othersCanAppend: true });
  const request = calls[0];
  assert.ok(request instanceof Api.messages.EditMessage);
  assert.equal(request.media.className, 'InputMediaTodo');
  assert.equal(request.media.todo.title.text, 'Updated trip');
  assert.equal(request.media.todo.othersCanComplete, false);
  assert.equal(request.media.todo.othersCanAppend, true);
  assert.deepEqual(request.media.todo.list.map(item => [item.id, item.title.text]), [[4, 'Pack bag'], [1, 'Buy tickets'], [5, 'Check weather']]);
  await assert.rejects(driver.editTodoList(42, 7, 'Updated', [{ id: 999, title: 'Stale' }]), /stale or duplicated/);
  assert.equal(calls.length, 1);
});

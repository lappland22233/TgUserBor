const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChatWSGateway } = require('../dist/gui/ws-chat.js');

function makeGateway(accounts) {
  const manager = new EventEmitter();
  manager.getInstance = (id) => accounts[id];
  return new ChatWSGateway(manager, {});
}

test('dialog and message reads use the selected account and do not return stale snapshots', async () => {
  const data = {
    a: { dialogs: [{ id: 1, unread: 1 }], messages: [{ id: 2, text: 'old' }] },
    b: { dialogs: [{ id: 1, unread: 7 }], messages: [{ id: 2, text: 'other account' }] },
  };
  const calls = [];
  const accounts = Object.fromEntries(Object.keys(data).map((id) => [id, {
    async accountAction(action, params) {
      calls.push({ id, action, params });
      return structuredClone(action === 'get_dialogs' ? data[id].dialogs : data[id].messages);
    },
  }]));
  const gateway = makeGateway(accounts);

  assert.deepEqual(await gateway.handleRpcAction('get_dialogs', { instId: 'a' }), data.a.dialogs);
  assert.deepEqual(await gateway.handleRpcAction('get_messages', { instId: 'a', chatId: 1 }), data.a.messages);
  data.a.dialogs[0].unread = 0;
  data.a.messages[0].text = 'edited';
  assert.deepEqual(await gateway.handleRpcAction('get_dialogs', { instId: 'a' }), data.a.dialogs);
  assert.deepEqual(await gateway.handleRpcAction('get_messages', { instId: 'a', chatId: 1 }), data.a.messages);
  assert.deepEqual(await gateway.handleRpcAction('get_messages', { instId: 'b', chatId: 1 }), data.b.messages);
  assert.equal(calls.length, 5);
});

test('history requests preserve pagination, query and media-filter search parameters', async () => {
  let received;
  const gateway = makeGateway({ a: { async accountAction(action, params) { received = { action, params }; return []; } } });
  await gateway.handleRpcAction('get_messages', { instId: 'a', chatId: 42, limit: 20, offsetId: 123, offsetDate: 1700000000, search: 'hello', searchFilter: 'videos' });
  assert.deepEqual(received, {
    action: 'get_messages',
    params: { chatId: 42, limit: 20, offsetId: 123, offsetDate: 1700000000, search: 'hello', searchFilter: 'videos' },
  });
  await assert.rejects(gateway.handleRpcAction('get_messages', { instId: 'a', chatId: 42, searchFilter: 'arbitrary' }), /Invalid message search filter/);
  await assert.rejects(gateway.handleRpcAction('get_messages', { instId: 'missing', chatId: 42 }), /not found/);
});

test('banned-member WebSocket actions validate and dispatch to the requested account', async () => {
  const calls = [];
  const gateway = makeGateway({
    a: { async accountAction(action, params) { calls.push({ action, params }); return { count: 0, participants: [] }; } },
    b: { async accountAction(action, params) { calls.push({ account: 'b', action, params }); return true; } },
  });
  assert.deepEqual(await gateway.handleRpcAction('get_banned_participants', {
    instId: 'a', chatId: -42, offset: 50, limit: 25, query: 'Ada',
  }), { count: 0, participants: [] });
  assert.equal(await gateway.handleRpcAction('unban_user', { instId: 'b', chatId: -84, userId: 10 }), true);
  assert.deepEqual(calls, [
    { action: 'get_banned_participants', params: { chatId: -42, offset: 50, limit: 25, query: 'Ada' } },
    { account: 'b', action: 'unban_user', params: { chatId: -84, userId: 10 } },
  ]);
  await assert.rejects(gateway.handleRpcAction('get_banned_participants', { instId: 'a', chatId: 42 }), /Invalid banned participant/);
  await assert.rejects(gateway.handleRpcAction('unban_user', { instId: 'a', chatId: -42, userId: 0 }), /Invalid unban target/);
});

test('group member invitation WebSocket RPC validates and targets the selected account', async () => {
  const calls = [];
  const gateway = makeGateway({ a: { async accountAction(action, params) { calls.push({ action, params }); return true; } } });
  assert.equal(await gateway.handleRpcAction('invite_user', { instId: 'a', chatId: -42, userId: 10 }), true);
  assert.deepEqual(calls, [{ action: 'invite_user', params: { chatId: -42, userId: 10 } }]);
  await assert.rejects(gateway.handleRpcAction('invite_user', { instId: 'a', chatId: 42, userId: 10 }), /Invalid Telegram member invitation/);
  await assert.rejects(gateway.handleRpcAction('invite_user', { instId: 'a', chatId: -42, userId: 0 }), /Invalid Telegram member invitation/);
});

test('group invite-link WebSocket actions validate and dispatch pages, creation and revocation', async () => {
  const calls = [];
  const gateway = makeGateway({ a: { async accountAction(action, params) { calls.push({ action, params }); return { links: [] }; } } });
  const cursor = { date: 100, link: 'https://t.me/+Cursor_1' };
  await gateway.handleRpcAction('get_chat_invite_links', { instId: 'a', chatId: -42, cursor, limit: 25 });
  await gateway.handleRpcAction('create_chat_invite_link', {
    instId: 'a', chatId: -42, title: 'Launch', expireDate: Math.floor(Date.now() / 1000) + 86400,
    usageLimit: 5, requestNeeded: true,
  });
  await gateway.handleRpcAction('revoke_chat_invite_link', { instId: 'a', chatId: -42, link: 'https://t.me/+Abc_1' });
  await gateway.handleRpcAction('edit_chat_invite_link', { instId: 'a', chatId: -42, link: 'https://t.me/+Abc_1', title: 'Main' });
  assert.deepEqual(calls[0], { action: 'get_chat_invite_links', params: { chatId: -42, cursor, limit: 25 } });
  assert.equal(calls[1].action, 'create_chat_invite_link');
  assert.equal(calls[1].params.requestNeeded, true);
  assert.equal(calls[1].params.usageLimit, 5);
  assert.deepEqual(calls[2], { action: 'revoke_chat_invite_link', params: { chatId: -42, link: 'https://t.me/+Abc_1' } });
  assert.deepEqual(calls[3], { action: 'edit_chat_invite_link', params: { chatId: -42, link: 'https://t.me/+Abc_1', title: 'Main' } });
  await assert.rejects(gateway.handleRpcAction('get_chat_invite_links', { instId: 'a', chatId: -42, cursor: 'malformed' }), /Invalid Telegram invite link query/);
  await assert.rejects(gateway.handleRpcAction('create_chat_invite_link', { instId: 'a', chatId: -42, requestNeeded: 'yes' }), /Invalid Telegram invite link options/);
  await assert.rejects(gateway.handleRpcAction('revoke_chat_invite_link', { instId: 'a', chatId: -42, link: 'https://evil.example/invite' }), /Invalid Telegram invite link/);
  await assert.rejects(gateway.handleRpcAction('edit_chat_invite_link', { instId: 'a', chatId: -42, link: 'https://t.me/+Abc_1', title: 'x'.repeat(33) }), /Invalid Telegram invite link title/);
});

test('group title and description WebSocket actions validate and target the selected group', async () => {
  const calls = [];
  const gateway = makeGateway({ a: { async accountAction(action, params) { calls.push({ action, params }); return true; } } });
  assert.equal(await gateway.handleRpcAction('set_chat_title', { instId: 'a', chatId: -42, title: 'New name' }), true);
  assert.equal(await gateway.handleRpcAction('set_chat_description', { instId: 'a', chatId: -42, description: '' }), true);
  assert.equal(await gateway.handleRpcAction('set_chat_username', { instId: 'a', chatId: -42, username: 'publicname' }), true);
  assert.deepEqual(calls, [
    { action: 'set_chat_title', params: { chatId: -42, title: 'New name' } },
    { action: 'set_chat_description', params: { chatId: -42, description: '' } },
    { action: 'set_chat_username', params: { chatId: -42, username: 'publicname' } },
  ]);
  await assert.rejects(gateway.handleRpcAction('set_chat_title', { instId: 'a', chatId: 42, title: 'No' }), /Invalid Telegram chat title/);
  await assert.rejects(gateway.handleRpcAction('set_chat_description', { instId: 'a', chatId: -42, description: 'x'.repeat(256) }), /Invalid Telegram chat description/);
  await assert.rejects(gateway.handleRpcAction('set_chat_username', { instId: 'a', chatId: -42, username: 'bad' }), /Invalid Telegram public username/);
});

test('group default permissions and slow mode WebSocket actions validate complete updates', async () => {
  const calls = [];
  const gateway = makeGateway({ a: { async accountAction(action, params) { calls.push({ action, params }); return true; } } });
  const keys = ['viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
    'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline', 'embedLinks',
    'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics'];
  const rights = Object.fromEntries(keys.map(key => [key, false]));
  rights.sendMessages = true;
  await gateway.handleRpcAction('set_chat_permissions', { instId: 'a', chatId: -42, rights });
  await gateway.handleRpcAction('set_chat_slow_mode', { instId: 'a', chatId: -42, seconds: 60 });
  await gateway.handleRpcAction('set_supergroup_setting', { instId: 'a', chatId: -42, setting: 'participantsHidden', enabled: true });
  assert.deepEqual(calls, [
    { action: 'set_chat_permissions', params: { chatId: -42, rights } },
    { action: 'set_chat_slow_mode', params: { chatId: -42, seconds: 60 } },
    { action: 'set_supergroup_setting', params: { chatId: -42, setting: 'participantsHidden', enabled: true } },
  ]);
  await assert.rejects(gateway.handleRpcAction('set_chat_permissions', { instId: 'a', chatId: -42, rights: { sendMessages: true } }), /Invalid Telegram group permissions/);
  await assert.rejects(gateway.handleRpcAction('set_chat_slow_mode', { instId: 'a', chatId: -42, seconds: 5 }), /Invalid Telegram slow mode/);
  await assert.rejects(gateway.handleRpcAction('set_supergroup_setting', { instId: 'a', chatId: -42, setting: 'bad', enabled: true }), /Invalid Telegram supergroup setting/);
});

test('dialog page cursor and page size are forwarded to the selected account', async () => {
  let received;
  const gateway = makeGateway({ a: { async accountAction(action, params) { received = { action, params }; return []; } } });
  const offset = { peer: -10042, id: 123, date: 1700000000000 };
  await gateway.handleRpcAction('get_dialogs', { instId: 'a', limit: 50, offset, folderId: 1 });
  assert.deepEqual(received, { action: 'get_dialogs', params: { limit: 50, offset, folderId: 1 } });
});

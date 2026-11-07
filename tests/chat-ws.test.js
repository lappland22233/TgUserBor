'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/chat-ws.js'), 'utf8');

function createHarness() {
  const sockets = [];
  const timers = new Map();
  let nextTimer = 0;
  const renders = { messages: 0, dialogs: 0, refreshDialogs: 0, refreshMessages: 0 };
  const storyRefresh = [];
  const storyViewerRefresh = [];
  const stealthRefresh = [];
  const historyTtlRefresh = [];
  const wallpaperRefresh = [];
  const forumMessages = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    open() { this.readyState = 1; this.onopen?.(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const state = {
    clientSelectedInstance: 'account-a',
    clientActiveChatId: '42',
    clientMessages: [{ id: 1, chatId: '42', text: 'original', outgoing: true, read: false }],
    clientDialogs: [{ id: '42', lastMessage: 'original', unreadCount: 0 }],
  };
  const context = vm.createContext({
    WebSocket: FakeWebSocket,
    location: { protocol: 'https:', host: 'example.test' },
    state,
    document: { getElementById: () => null },
    renderClientMessages: () => { renders.messages++; },
    renderClientDialogs: () => { renders.dialogs++; },
    loadClientDialogs: () => { renders.refreshDialogs++; },
    loadClientMessages: () => { renders.refreshMessages++; },
    window: {
      loadClientStoriesFeed: (...args) => storyRefresh.push(['feed', ...args]),
      loadStoryArchive: (...args) => storyRefresh.push(['archive', ...args]),
      refreshStoryViewerForUpdate: (...args) => storyViewerRefresh.push(args),
      refreshStoryStealthStatus: (...args) => stealthRefresh.push(args),
      applyPeerHistoryTtlUpdate: (...args) => historyTtlRefresh.push(args),
      refreshTelegramChatWallpaper: (...args) => wallpaperRefresh.push(args),
      ForumTopics: { refreshTopics: () => storyRefresh.push(['forum']), handleMessage: message => forumMessages.push(message) },
    },
    escapeHtml: String,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(`${source}\nglobalThis.TestChatWSManager = ChatWSManager;`, context);
  const manager = new context.TestChatWSManager();
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) { timers.delete(id); timer.fn(); }
    }
  };
  return { manager, state, sockets, renders, storyRefresh, storyViewerRefresh, stealthRefresh, historyTtlRefresh, wallpaperRefresh, forumMessages, runTimers, document: context.document };
}

test('background messages stay unread until the user returns to the active chat', async () => {
  const { manager, state, document } = createHarness();
  document.hidden = true;
  let calls = [];
  manager.isConnected = () => true;
  manager.sendRpc = async (action, params) => { calls.push({ action, params }); };
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  assert.equal(state.clientDialogs[0].unreadCount, 1);
  assert.equal(calls.length, 0);
  document.hidden = false;
  document.getElementById = id => id === 'view-client' ? { classList: { contains: () => true } } : null;
  await manager.markVisibleChatRead();
  assert.equal(calls[0].action, 'mark_as_read');
  assert.equal(calls[0].params.maxId, 2);
  assert.equal(state.clientDialogs[0].unreadCount, 0);
});

test('Story and read-story updates refresh only the selected account story views', () => {
  const { manager, state, storyRefresh, storyViewerRefresh, stealthRefresh } = createHarness();
  state.currentProfileIsSelf = true;
  state.currentProfileChatId = 42;
  manager.handleStreamEvent({ type: 'stories_updated', instId: 'account-b', chatId: 42, storyId: 9 });
  assert.deepEqual(storyRefresh, []);
  manager.handleStreamEvent({ type: 'stories_updated', instId: 'account-a', chatId: 42, storyId: 9 });
  assert.deepEqual(storyRefresh, [['feed', true, true], ['archive', true]]);
  assert.deepEqual(storyViewerRefresh, [['account-a', 42, 9]]);
  storyRefresh.length = 0;
  manager.handleStreamEvent({ type: 'stories_updated', instId: 'account-a', chatId: 42, maxReadId: 9 });
  assert.deepEqual(storyRefresh, [['feed', true, true]]);
  assert.equal(storyViewerRefresh.length, 1);
  manager.handleStreamEvent({ type: 'stories_stealth_updated', instId: 'account-b' });
  assert.deepEqual(stealthRefresh, []);
  manager.handleStreamEvent({ type: 'stories_stealth_updated', instId: 'account-a' });
  assert.deepEqual(stealthRefresh, [['account-a']]);
});

test('pinned forum topic events refresh only the active forum topic list', () => {
  const { manager, state, storyRefresh } = createHarness();
  manager.handleStreamEvent({ type: 'forum_topics_updated', instId: 'account-a', chatId: -10091 });
  assert.deepEqual(storyRefresh, []);
  state.clientActiveChatId = '-10091';
  manager.handleStreamEvent({ type: 'forum_topics_updated', instId: 'account-b', chatId: -10091 });
  assert.deepEqual(storyRefresh, []);
  manager.handleStreamEvent({ type: 'forum_topics_updated', instId: 'account-a', chatId: -10091 });
  assert.deepEqual(storyRefresh, [['forum']]);
});

test('auto-delete updates synchronize the selected dialog and open profile, including snapshots', () => {
  const { manager, state, renders, historyTtlRefresh } = createHarness();
  manager.handleStreamEvent({ type: 'chat_history_ttl_updated', instId: 'account-b', chatId: 42, period: 86400 });
  assert.equal(state.clientDialogs[0].ttlPeriod, undefined);
  assert.deepEqual(historyTtlRefresh, []);
  const snapshot = manager.beginDialogSnapshot('account-a');
  manager.handleStreamEvent({ type: 'chat_history_ttl_updated', instId: 'account-a', chatId: 42, period: 604800 });
  assert.equal(state.clientDialogs[0].ttlPeriod, 604800);
  assert.deepEqual(historyTtlRefresh, [[42, 604800]]);
  const dialogs = manager.finishDialogSnapshot(snapshot, [{ id: '42', ttlPeriod: 0, unreadCount: 0 }]);
  assert.equal(dialogs[0].ttlPeriod, 604800);
  assert.equal(renders.dialogs, 1);
  manager.handleStreamEvent({ type: 'chat_history_ttl_updated', instId: 'account-a', chatId: 42, period: 31536001 });
  assert.equal(state.clientDialogs[0].ttlPeriod, 604800);
  assert.equal(historyTtlRefresh.length, 1);
});

test('Telegram wallpaper updates refresh only the matching selected account and chat', () => {
  const { manager, state, wallpaperRefresh } = createHarness();
  manager.handleStreamEvent({ type: 'peer_wallpaper_updated', instId: 'account-b', chatId: 42 });
  manager.handleStreamEvent({ type: 'peer_wallpaper_updated', instId: 'account-a', chatId: -42 });
  assert.deepEqual(wallpaperRefresh, []);
  manager.handleStreamEvent({ type: 'peer_wallpaper_updated', instId: 'account-a', chatId: 42 });
  assert.deepEqual(wallpaperRefresh, [['account-a', 42]]);
  state.clientActiveChatId = '43';
  manager.handleStreamEvent({ type: 'peer_wallpaper_updated', instId: 'account-a', chatId: 42 });
  assert.deepEqual(wallpaperRefresh, [['account-a', 42]]);
});

test('live forum messages reach only the selected forum topic view', () => {
  const { manager, state, forumMessages } = createHarness();
  state.clientDialogs[0].isForum = true;
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-b', message: { id: 2, chatId: '42', topicId: 9 } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '99', topicId: 9 } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 3, chatId: '42', topicId: 9 } });
  assert.deepEqual(forumMessages, [{ id: 3, chatId: '42', topicId: 9 }]);
});

test('forum activity does not acknowledge unrelated topic messages', async () => {
  const { manager, state, document } = createHarness();
  state.clientDialogs[0].isForum = true;
  state.clientDialogs[0].unreadCount = 3;
  state.clientDialogs[0].lastMessageId = 2;
  state.clientMessages = [{id:2,chatId:'42'}];
  document.hidden = false;
  document.getElementById = id => id === 'view-client' ? { classList: { contains: () => true } } : null;
  const calls=[];
  manager.isConnected = () => true;
  manager.sendRpc = async (action, params) => { calls.push({action,params}); };
  await manager.markVisibleChatRead();
  manager.handleStreamEvent({type:'new_message',instId:'account-a',message:{id:3,chatId:'42',text:'another topic'}});
  await Promise.resolve();
  assert.equal(calls.length,0);
  assert.equal(state.clientDialogs[0].unreadCount,4);
});

test('a failed foreground read acknowledgement preserves unread state', async () => {
  const { manager, state } = createHarness();
  manager.isConnected = () => true;
  manager.sendRpc = () => Promise.reject(new Error('offline'));
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.clientDialogs[0].unreadCount, 1);
});

test('an older read acknowledgement cannot clear a newer unread message', async () => {
  const { manager, state } = createHarness();
  const requests = [];
  manager.isConnected = () => true;
  manager.sendRpc = () => new Promise(resolve => requests.push(resolve));
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'first' } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 3, chatId: '42', text: 'second' } });
  requests[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.clientDialogs[0].unreadCount, 2);
  requests[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.clientDialogs[0].unreadCount, 0);
});

test('events from another account do not mutate the selected account', () => {
  const { manager, state, renders } = createHarness();
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-b', message: { id: 2, chatId: '42', text: 'foreign' } });
  manager.handleStreamEvent({ type: 'message_edited', instId: 'account-b', message: { id: 1, chatId: '42', text: 'foreign edit' } });
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-b', chatId: '42', messageIds: [1] });
  assert.equal(state.clientMessages.length, 1);
  assert.equal(state.clientMessages[0].text, 'original');
  assert.equal(state.clientDialogs[0].lastMessage, 'original');
  assert.equal(state.clientDialogs[0].unreadCount, 0);
  assert.equal(renders.messages, 0);
  assert.equal(renders.dialogs, 0);
});

test('typing cancellation and privacy-restricted presence clear stale state', () => {
  const { manager, state, document, runTimers } = createHarness();
  const subtitle = {innerHTML:'', innerText:''};
  document.getElementById = id => id === 'client-chat-subtitle' ? subtitle : null;
  manager.handleStreamEvent({type:'chat_typing', instId:'account-a', chatId:'42', userId:2, action:'SendMessageTypingAction'});
  assert.match(subtitle.innerHTML, /正在输入/);
  manager.handleStreamEvent({type:'chat_typing', instId:'account-a', chatId:'42', userId:2, action:'SendMessageCancelAction'});
  assert.equal(state.typingTimer, null);
  manager.handleStreamEvent({type:'user_status', instId:'account-a', userId:'42', online:false});
  assert.equal(subtitle.innerText, '最近上线时间不可见');
  runTimers(4500);
  assert.equal(subtitle.innerText, '最近上线时间不可见');
});

test('live messages update unread counts without entering an open historical view', () => {
  const { manager, state, renders } = createHarness();
  state.clientHistoryOffsetDate = 1700000000;
  let readCalls = 0;
  manager.isConnected = () => true;
  manager.sendRpc = () => { readCalls++; return Promise.resolve(); };
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  assert.equal(state.clientMessages.length, 1);
  assert.equal(state.clientDialogs[0].lastMessage, 'new');
  assert.equal(state.clientDialogs[0].unreadCount, 1);
  assert.equal(renders.messages, 0);
  assert.equal(readCalls, 0);
});

test('a Telegram edit updates the active message and duplicate deliveries are ignored', () => {
  const { manager, state } = createHarness();
  manager.handleStreamEvent({ type: 'message_edited', instId: 'account-a', message: { id: 1, chatId: '42', text: 'edited' } });
  assert.equal(state.clientMessages[0].text, 'edited');
  const event = { type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } };
  manager.handleStreamEvent(event);
  manager.handleStreamEvent(event);
  assert.equal(state.clientMessages.filter((message) => message.id === 2).length, 1);
});

test('a read receipt in a different conversation does not mark active messages as read', () => {
  const { manager, state } = createHarness();
  manager.handleStreamEvent({ type: 'message_read', instId: 'account-a', chatId: '99', maxId: 1 });
  assert.equal(state.clientMessages[0].read, false);
  manager.handleStreamEvent({ type: 'message_read', instId: 'account-a', chatId: '42', maxId: 1 });
  assert.equal(state.clientMessages[0].read, true);
});

test('unscoped deletions refresh instead of deleting an overlapping message ID', () => {
  const { manager, state, renders, runTimers } = createHarness();
  state.chatSelectionVersion = 1;
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-a', chatId: 0, messageIds: [1] });
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-a', chatId: 0, messageIds: [1] });
  assert.equal(state.clientMessages.length, 1);
  assert.equal(renders.refreshMessages, 0);
  runTimers(250);
  assert.equal(renders.refreshDialogs, 1);
  assert.equal(renders.refreshMessages, 1);
});

test('an unscoped deletion never refreshes a chat after account or selection switches', () => {
  const { manager, state, renders, runTimers } = createHarness();
  state.chatSelectionVersion = 1;
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-a', messageIds: [1] });
  state.clientSelectedInstance = 'account-b';
  state.chatSelectionVersion++;
  runTimers(250);
  assert.equal(renders.refreshDialogs, 0);
  assert.equal(renders.refreshMessages, 0);
});

test('outbox receipts update the matching dialog and survive a stale snapshot', () => {
  const { manager, state } = createHarness();
  state.clientActiveChatId = '99';
  const snapshot = manager.beginDialogSnapshot('account-a');
  manager.handleStreamEvent({ type:'message_read', instId:'account-a', chatId:'42', maxId:12 });
  assert.equal(state.clientDialogs[0].readOutboxMaxId, 12);
  manager.handleStreamEvent({ type:'message_read', instId:'account-a', chatId:'42', maxId:8 });
  const result = manager.finishDialogSnapshot(snapshot, [{id:'42', readOutboxMaxId:3}]);
  assert.equal(result[0].readOutboxMaxId, 12);
  manager.handleStreamEvent({ type:'message_read', instId:'account-b', chatId:'42', maxId:99 });
  assert.equal(state.clientDialogs[0].readOutboxMaxId, 12);
});

test('reconnecting one channel retains the healthy channel', () => {
  const { manager, sockets, runTimers } = createHarness();
  manager.connect();
  assert.equal(sockets.length, 2);
  const [stream, rpc] = sockets;
  stream.open(); rpc.open();
  stream.close();
  runTimers(3000);
  assert.equal(sockets.length, 3);
  assert.match(sockets[2].url, /chat-stream$/);
  assert.equal(rpc.readyState, 1);
  manager.disconnect();
});

test('pending RPC requests reject promptly when the RPC connection closes', async () => {
  const { manager, sockets } = createHarness();
  manager.connect();
  sockets[0].open(); sockets[1].open();
  const result = manager.sendRpc('get_dialogs', { instId: 'account-a' });
  const rejected = assert.rejects(result, /connection|closed/i);
  sockets[1].close();
  await rejected;
  manager.disconnect();
});

test('outgoing messages in another chat do not increase unread counts', () => {
  const { manager, state } = createHarness();
  state.clientActiveChatId = '99';
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'mine', outgoing: true } });
  assert.equal(state.clientDialogs[0].unreadCount, 0);
});

test('history snapshots replay matching new, edit and delete events in order', () => {
  const { manager } = createHarness();
  const snapshot = manager.beginMessageSnapshot('account-a', '42');
  manager.handleStreamEvent({ type: 'message_edited', instId: 'account-a', message: { id: 1, chatId: '42', text: 'edited' } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-b', message: { id: 3, chatId: '42', text: 'foreign' } });
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-a', chatId: '42', messageIds: [1] });
  const result = manager.finishMessageSnapshot(snapshot, [{ id: 1, text: 'old' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
  assert.equal(manager.messageSnapshots.size, 0);
});

test('history pagination replays edits without appending unrelated new messages', () => {
  const { manager } = createHarness();
  const snapshot = manager.beginMessageSnapshot('account-a', '42');
  manager.handleStreamEvent({ type: 'message_edited', instId: 'account-a', message: { id: 1, chatId: '42', text: 'edited' } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  const result = manager.finishMessageSnapshot(snapshot, [{ id: 1, text: 'old' }], false);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'edited');
  assert.equal(manager.messageSnapshots.size, 0);
});

test('stream reconnection refreshes the selected account and story feed only when both channels are open', () => {
  const { manager, sockets, renders, storyRefresh, runTimers } = createHarness();
  manager.connect();
  sockets[0].open(); sockets[1].open();
  assert.equal(renders.refreshDialogs, 0);
  sockets[0].close();
  runTimers(3000);
  assert.equal(renders.refreshDialogs, 0);
  sockets[2].open();
  assert.equal(renders.refreshDialogs, 1);
  assert.equal(renders.refreshMessages, 1);
  assert.deepEqual(storyRefresh, [['feed', true, true]]);
  manager.disconnect();
});

test('dialog snapshots preserve in-flight updates without counting a message twice', () => {
  const { manager, state } = createHarness();
  state.clientActiveChatId = '99';
  const snapshot = manager.beginDialogSnapshot('account-a');
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 5, chatId: '42', text: 'new', date: 5000 } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 5, chatId: '42', text: 'new', date: 5000 } });
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-b', message: { id: 6, chatId: '42', text: 'foreign' } });
  const alreadyUpdated = manager.finishDialogSnapshot(snapshot, [{ id: '42', lastMessageId: 5, lastMessage: 'new', unreadCount: 1 }]);
  assert.equal(alreadyUpdated[0].unreadCount, 1);
  assert.equal(alreadyUpdated[0].lastMessage, 'new');
  assert.equal(manager.dialogSnapshots.size, 0);
});

test('dialog snapshot replays newer messages and local read in their original order', () => {
  const { manager, state } = createHarness();
  state.clientActiveChatId = '99';
  const snapshot = manager.beginDialogSnapshot('account-a');
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 5, chatId: '42', text: 'new' } });
  manager.recordDialogRead('account-a', '42');
  const dialogs = manager.finishDialogSnapshot(snapshot, [{ id: '42', lastMessageId: 1, lastMessage: 'old', unreadCount: 2 }]);
  assert.equal(dialogs[0].lastMessageId, 5);
  assert.equal(dialogs[0].lastMessage, 'new');
  assert.equal(dialogs[0].unreadCount, 0);
});

test('dialog update preserves pinned dialogs and refreshes deleted last messages', () => {
  const { manager, state, runTimers, renders } = createHarness();
  state.clientActiveChatId = '99';
  state.clientDialogs = [{ id: '1', pinned: true, lastMessageId: 1 }, { id: '42', lastMessageId: 1, unreadCount: 0 }];
  manager.handleStreamEvent({ type: 'new_message', instId: 'account-a', message: { id: 2, chatId: '42', text: 'new' } });
  assert.equal(state.clientDialogs[0].id, '1');
  manager.handleStreamEvent({ type: 'message_delete', instId: 'account-a', chatId: '42', messageIds: [2] });
  runTimers(250);
  assert.equal(renders.refreshDialogs, 1);
});

test('dialog snapshots release failed or discarded requests', () => {
  const { manager } = createHarness();
  const snapshot = manager.beginDialogSnapshot('account-a');
  manager.finishDialogSnapshot(snapshot);
  assert.equal(manager.dialogSnapshots.size, 0);
});

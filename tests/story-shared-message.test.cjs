'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');

function part(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Cannot locate ${from}`);
  return source.slice(start, end);
}

test('shared-story cards validate IDs and open through an explicit user click', () => {
  const context = vm.createContext({ inlineJsArg: value => JSON.stringify(value) });
  vm.runInContext(part('function renderSharedStoryMedia(', '\nfunction renderTodoChecklist') + '\nthis.render = renderSharedStoryMedia;', context);
  const html = context.render({ storyChatId: -100123, storyId: 17, storyIsSelf: true });
  assert.match(html, /openSharedTelegramStory\(-100123, 17, true\)/);
  assert.match(html, /点击查看已分享的动态/);
  assert.doesNotMatch(context.render({ storyChatId: 0, storyId: 17 }), /onclick=/);
});

test('opening a shared story rereads Telegram on its owner peer and binds the request to the source chat', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -1009, chatSelectionVersion: 5 };
  const requests = [], opened = [], toasts = [];
  const context = vm.createContext({ state, sharedStoryRequestId: 0, encodeURIComponent,
    api: async url => { requests.push(url); return { id: 17, caption: 'story' }; },
    openStoryViewer: (...args) => opened.push(args), showToast: (...args) => toasts.push(args),
  });
  vm.runInContext(part('async function openSharedTelegramStory(', '\nfunction openStoryViewer') + '\nthis.open = openSharedTelegramStory;', context);
  await context.open(-100123, 17, false);
  assert.deepEqual(requests, ['/api/instances/a/account/story?chatId=-100123&storyId=17']);
  assert.deepEqual(JSON.parse(JSON.stringify(opened[0])), [-100123, [{ id: 17, caption: 'story' }], 0,
    { source: 'message', originChatId: -1009, isSelf: false, storiesHidden: false }]);
  assert.equal(toasts.length, 0);
});

test('a late shared-story response cannot open after the source conversation changes', async () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -1009, chatSelectionVersion: 5 };
  let resolve;
  const opened = [], toasts = [];
  const context = vm.createContext({ state, sharedStoryRequestId: 0, encodeURIComponent, api: () => new Promise(r => { resolve = r; }),
    openStoryViewer: (...args) => opened.push(args), showToast: (...args) => toasts.push(args),
  });
  vm.runInContext(part('async function openSharedTelegramStory(', '\nfunction openStoryViewer') + '\nthis.open = openSharedTelegramStory;', context);
  const pending = context.open(77, 17, false);
  state.clientActiveChatId = -10010;
  state.chatSelectionVersion++;
  resolve({ id: 17 });
  await pending;
  assert.equal(opened.length, 0);
  assert.equal(toasts.length, 0);
});

test('message-launched story viewers remain current only while their source chat is selected', () => {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -1009, chatSelectionVersion: 5, currentProfileChatId: 42 };
  const context = vm.createContext({ state, storyFeedEpoch: 2, profileRequestId: 10 });
  vm.runInContext(part('function storyPeerTargetIsCurrent(', '\nasync function refreshStoryViewerForUpdate') + '\nthis.isCurrent = storyPeerTargetIsCurrent;', context);
  const session = { instId: 'a', selectionVersion: 5, source: 'message', originChatId: -1009, chatId: 77, profileRequestId: -1 };
  assert.equal(context.isCurrent(session), true);
  state.currentProfileChatId = 88;
  assert.equal(context.isCurrent(session), true);
  state.clientActiveChatId = -10010;
  assert.equal(context.isCurrent(session), false);
});

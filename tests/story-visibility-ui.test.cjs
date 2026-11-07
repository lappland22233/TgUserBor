'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('story hide action targets the open profile and ignores a response after switching profiles', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function storyPeerTargetIsCurrent(');
  const end = source.indexOf('\nfunction openStoryViewer(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'account-a', chatSelectionVersion: 5, currentProfileChatId: 77, currentProfileStoriesHidden: false };
  const hideButton = { disabled: false, textContent: '' };
  const viewer = { session: null, hideStories: hideButton, status: { textContent: '' } };
  const calls = [], reloads = [], toasts = [];
  let resolveApi;
  const context = vm.createContext({ state, storyViewer: viewer,
    api: (url, method, body) => { calls.push({ url, method, body }); return new Promise(resolve => { resolveApi = resolve; }); },
    loadPeerStories: chatId => reloads.push(chatId), showToast: message => toasts.push(message), encodeURIComponent,
  });
  vm.runInContext(`let profileRequestId = 9;\n${source.slice(start, end)}\nthis.save = setStoryPeerHidden;`, context);
  const session = { instId: 'account-a', chatId: 77, selectionVersion: 5, profileRequestId: 9, isSelf: false, storiesHidden: false };
  viewer.session = session;
  const pending = context.save(session, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: '/api/instances/account-a/account/stories/hidden', method: 'POST', body: { chatId: 77, hidden: true },
  }]);
  resolveApi({ success: true });
  await pending;
  assert.equal(state.currentProfileStoriesHidden, true);
  assert.equal(session.storiesHidden, true);
  assert.equal(hideButton.textContent, '取消隐藏动态');
  assert.deepEqual(reloads, [77]);
  assert.deepEqual(toasts, ['已隐藏此用户的动态']);

  state.currentProfileStoriesHidden = false;
  session.storiesHidden = false;
  let resolveStale;
  context.api = () => new Promise(resolve => { resolveStale = resolve; });
  const stale = context.save(session, true);
  vm.runInContext('profileRequestId = 10', context);
  resolveStale({ success: true });
  await stale;
  assert.equal(state.currentProfileStoriesHidden, false);
  assert.equal(reloads.length, 1);
});

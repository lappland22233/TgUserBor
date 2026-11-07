'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('story viewer moves between loaded feed peers at story boundaries and rejects stale accounts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function canNavigateStoryFeedPeer(');
  const end = source.indexOf('\nfunction layoutStoryMediaAreas(', start);
  assert.ok(start >= 0 && end > start);
  const peers = [
    { id: 9, isSelf: false, isHidden: false, stories: [{ id: 1 }] },
    { id: 10, isSelf: true, isHidden: false, stories: [{ id: 2 }, { id: 3 }] },
    { id: 12, isSelf: false, isHidden: true, stories: [{ id: 4 }] },
    { id: 13, isSelf: false, isHidden: false, stories: [] },
  ];
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 4 };
  const viewer = { session: { instId: 'a', chatId: 10, selectionVersion: 4, feedEpoch: 2, source: 'feed', index: 1, stories: peers[1].stories } };
  const opened = [];
  const context = vm.createContext({
    state, storyViewer: viewer, storyFeedPeers: peers, storyFeedEpoch: 2, opened,
    storyPeerTargetIsCurrent: session => session?.instId === state.clientSelectedInstance && session.selectionVersion === state.chatSelectionVersion && session.feedEpoch === 2,
    openStoryViewer: (chatId, stories, index, options) => {
      opened.push({ chatId, storyIds: stories.map(story => story.id), index, options });
      viewer.session = { ...viewer.session, chatId, stories, index, ...options };
    },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.can = canNavigateStoryFeedPeer; this.navigate = navigateStoryFeedPeer; this.show = showStoryAt;`, context);

  assert.equal(context.can(viewer.session, -1), true);
  assert.equal(context.can(viewer.session, 1), true);
  assert.equal(context.navigate(1), true);
  assert.deepEqual(JSON.parse(JSON.stringify(opened[0])), {
    chatId: 12, storyIds: [4], index: 0, options: { source: 'feed', isSelf: false, storiesHidden: true },
  });
  assert.equal(context.navigate(-1), true);
  assert.equal(opened[1].chatId, 10);
  assert.equal(opened[1].index, 1);

  const boundarySession = { ...viewer.session, chatId: 10, source: 'feed', index: 0, stories: peers[1].stories };
  viewer.session = boundarySession;
  context.show(-1);
  assert.equal(opened[2].chatId, 9);
  assert.equal(opened[2].index, 0);

  state.clientSelectedInstance = 'b';
  assert.equal(context.can(viewer.session, 1), false);
  assert.equal(context.navigate(1), false);
  assert.equal(opened.length, 3);
});

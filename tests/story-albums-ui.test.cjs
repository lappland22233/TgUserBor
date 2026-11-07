'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('story archive loads albums, filters their stories, and updates selected membership', async () => {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.value = ''; this.checked = false; this.disabled = false;
      this.hidden = false; this.textContent = ''; this.className = ''; this.attributes = {}; this.handlers = {};
      const classes = new Set();
      this.classList = { toggle: (name, force) => force ? classes.add(name) : classes.delete(name), add: name => classes.add(name) };
    }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
  }
  const ids = [
    'profile-stories-archive-container', 'profile-stories-archive-status', 'btn-profile-stories-archive-more',
    'profile-story-album-filter', 'profile-story-album-target', 'profile-story-album-status',
    'profile-story-album-cover',
    'btn-rename-story-album', 'btn-delete-story-album', 'btn-move-story-album-up', 'btn-move-story-album-down', 'btn-add-stories-to-album',
    'btn-remove-stories-from-album', 'btn-create-story-album',
  ];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const story = { id: 9, date: 100, expireDate: 200, caption: '旅程' };
  const requests = [];
  const session = {
    instId: 'a', chatId: 42, selectionVersion: 3, profileRequestId: 8, cursor: 0, stories: [], count: 0, loading: false,
    albums: [], selectedAlbumId: null, albumCursor: 0, albumRequest: 0, selectedStoryIds: new Set(),
  };
  const state = { clientSelectedInstance: 'a', currentProfileIsSelf: true, currentProfileChatId: 42, chatSelectionVersion: 3 };
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element(), createTextNode: text => { const node = new Element(); node.textContent = text; return node; } };
  const context = vm.createContext({ state, document, storyArchiveState: session, URLSearchParams, encodeURIComponent, Date,
    storyArchiveIsCurrent: candidate => candidate === session && state.currentProfileIsSelf && state.clientSelectedInstance === 'a',
    openStoryViewer() {},
    api: async (url, method, body) => {
      requests.push({ url, method, body });
      if (url.includes('/albums/stories?')) return { stories: [story], count: 1 };
      if (url.endsWith('/stories/albums/order') || url.endsWith('/stories/albums/stories/order')) return { success: true };
      if (url.includes('/account/stories/albums?')) return [{ id: 6, title: '旧相册' }, { id: 7, title: '精选', coverType: 'photo' }];
      if (url.endsWith('/stories/albums/edit')) return { success: true };
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function loadStoryArchive(');
  const end = source.indexOf('\nasync function editArchivedStoryPrivacySettings(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.loadAlbums = loadStoryAlbums; this.selectAlbum = selectStoryAlbumFilter; this.renderCards = renderStoryArchiveCards; this.updateMembers = updateArchivedStoryAlbumMembers; this.moveAlbum = moveArchivedStoryAlbum; this.moveStory = moveArchivedStoryWithinAlbum;`, context);

  await context.loadAlbums(session);
  assert.equal(nodes.get('profile-story-album-filter').children[2].textContent, '精选');
  nodes.get('profile-story-album-target').value = '7';
  await context.moveAlbum(-1);
  assert.equal(nodes.get('profile-story-album-cover').hidden, false);
  assert.match(nodes.get('profile-story-album-cover').src, /story-album-cover\?chatId=42&albumId=7/);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(request => request.url.endsWith('/stories/albums/order')).body.albumIds)), [7, 6]);
  nodes.get('profile-story-album-filter').value = '7';
  await context.selectAlbum();
  assert.equal(requests.some(request => request.url.includes('/albums/stories?') && request.url.includes('albumId=7')), true);
  assert.equal(session.stories[0].id, 9);
  const visit = (node, result = []) => { result.push(node); for (const child of node.children) visit(child, result); return result; };
  const checkbox = visit(nodes.get('profile-stories-archive-container')).find(node => node.type === 'checkbox');
  assert.ok(checkbox);
  checkbox.checked = true;
  checkbox.handlers.change();
  nodes.get('profile-story-album-target').value = '7';
  assert.equal(nodes.get('btn-add-stories-to-album').disabled, false);
  await context.moveStory(9, -1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(request => request.url.endsWith('/stories/albums/stories/order')).body)), {
    chatId: 42, albumId: 7, storyId: 9, delta: -1,
  });
  await context.updateMembers('add');
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(request => request.url.endsWith('/stories/albums/edit')).body)), {
    chatId: 42, albumId: 7, update: { addStoryIds: [9] },
  });
  assert.equal(session.selectedStoryIds.size, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = app.indexOf('let profileRequestId = 0;');
const end = app.indexOf('// Group & Channel Members Controller', start);
if (start < 0 || end < 0) throw new Error('Profile functions not found');

function harness() {
  const requests = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, innerText: '', textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, firstElementChild: { textContent: '' }, appendChild() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {} });
    return elements.get(id);
  };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, currentProfileChatId: 1, chatSelectionVersion: 1, clientDialogs: [], profilePhotos: [], currentPhotoIndex: 0, sharedMediaList: [], sharedMediaTab: 'photos' };
  const context = vm.createContext({ state, document: { getElementById: element, querySelectorAll: () => [], createElement: () => element('created') },
    api: url => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); requests.push({ url, resolve, reject }); return promise; },
    escapeHtml: String, formatDurationSec: String, formatBytes: String, showToast() {}, openLightbox() {}, scrollToMessage() {}, Date, setTimeout, clearTimeout });
  vm.runInContext(app.slice(start, end) + '\nthis.loadPeerProfile = loadPeerProfile; this.loadUserPhotos = loadUserPhotos; this.loadPeerStories = loadPeerStories; this.loadSharedMedia = loadSharedMedia; this.updateHeroPhotoDisplay = updateHeroPhotoDisplay;', context);
  return { state, requests, context, element };
}

test('older profile results cannot overwrite a newer profile', async () => {
  const h = harness();
  const first = h.context.loadPeerProfile(1);
  const second = h.context.loadPeerProfile(2);
  h.requests[1].resolve({ id: 2, title: 'Second' });
  await second;
  h.requests[0].resolve({ id: 1, title: 'First' });
  await first;
  assert.equal(h.element('profile-display-name').innerText, 'Second');
  assert.equal(h.state.currentProfileChatId, 2);
});

test('a group profile displays the adapter member count and group status', async () => {
  const h = harness();
  const profile = h.context.loadPeerProfile(1);
  h.requests[0].resolve({ id: 1, title: 'Group', type: 'group', memberCount: 23 });
  await profile;
  assert.equal(h.element('profile-val-members').innerText, '23 位成员');
  assert.equal(h.element('profile-status-badge').innerText, '群组');
  assert.equal(h.element('tab-btn-members').innerText, '成员 (23)');
});

test('switching away and back does not revive stale profile or stories requests', async () => {
  const h = harness();
  const profile = h.context.loadPeerProfile(1);
  h.state.clientSelectedInstance = 'b'; h.state.chatSelectionVersion++;
  h.state.clientSelectedInstance = 'a'; h.state.chatSelectionVersion++;
  h.requests[0].resolve({ id: 1, title: 'Stale' });
  await profile;
  assert.notEqual(h.element('profile-display-name').innerText, 'Stale');
  const stories = h.context.loadPeerStories(1);
  h.state.chatSelectionVersion += 2;
  h.requests[1].resolve([{ caption: 'stale' }]);
  await stories;
  assert.notEqual(h.element('profile-stories-count').innerText, '1');
});

test('a stale photo response or image callback cannot modify current photo state', async () => {
  const h = harness();
  const photos = h.context.loadUserPhotos(1);
  h.state.chatSelectionVersion += 2;
  h.requests[0].resolve([{ id: 7 }]);
  await photos;
  assert.equal(h.state.profilePhotos.length, 0);
  h.state.profilePhotos = [{ id: 8 }];
  h.context.updateHeroPhotoDisplay(1);
  const image = h.element('profile-hero-img');
  const staleOnload = image.onload;
  h.state.chatSelectionVersion++;
  staleOnload();
  assert.notEqual(image.style.display, 'block');
});

test('newest shared media tab wins and selection changes invalidate old results', async () => {
  const h = harness();
  const first = h.context.loadSharedMedia('photos');
  const second = h.context.loadSharedMedia('files');
  h.requests[1].resolve([]); await second;
  h.requests[0].resolve([{ id: 42 }]); await first;
  assert.equal(h.state.sharedMediaTab, 'files');
  assert.equal(h.state.sharedMediaList.length, 0);
  const third = h.context.loadSharedMedia('photos');
  h.state.chatSelectionVersion += 2;
  h.requests[2].resolve([{ id: 55 }]); await third;
  assert.equal(h.state.sharedMediaList.length, 0);
});

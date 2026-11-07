'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('story caption edits leave media and visibility unchanged in the Telegram edit request', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = id => BigInt(id);
  driver.client = { invoke: async request => calls.push(request) };
  await driver.editStoryCaption(42, 9, 'New caption');
  assert.equal(calls[0].className, 'stories.EditStory');
  assert.equal(calls[0].peer.toString(), '42');
  assert.equal(calls[0].id, 9);
  assert.equal(calls[0].caption, 'New caption');
  assert.equal(calls[0].media, undefined);
  assert.equal(calls[0].privacyRules, undefined);
  await assert.rejects(driver.editStoryCaption(77, 9, 'invalid owner'), /Invalid story caption edit request/);
  await assert.rejects(driver.editStoryCaption(42, 9, 'x'.repeat(2049)), /Invalid story caption edit request/);
  assert.equal(calls.length, 1);
});

test('story caption endpoint validates the edit and targets the account worker', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => calls.push({ action, payload }) } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/edit`;
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chatId: 42, storyId: 9, caption: 'x'.repeat(2049) })).status, 400);
    assert.equal((await post({ chatId: 42, storyId: 9, caption: 'caption' })).status, 200);
    assert.deepEqual(calls, [{ action: 'edit_story_caption', payload: { chatId: 42, storyId: 9, caption: 'caption' } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('archive caption editor updates only its current story and retains typed text after failure', async () => {
  class Element {
    constructor() { this.children = []; this.disabled = false; this.value = ''; this.textContent = ''; this.className = ''; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); }
    setAttribute() {}
    focus() {}
    querySelector() { return null; }
  }
  const status = new Element(), renders = [], requests = [];
  let resolveApi;
  const state = { clientSelectedInstance: 'a', currentProfileIsSelf: true, currentProfileChatId: 42, chatSelectionVersion: 3 };
  const session = { instId: 'a', chatId: 42, selectionVersion: 3, profileRequestId: 8, stories: [] };
  const document = { createElement: () => new Element(), getElementById: id => id === 'profile-stories-archive-status' ? status : null };
  const context = vm.createContext({ state, document, encodeURIComponent,
    api: (url, method, body) => { requests.push({ url, method, body }); return new Promise((resolve, reject) => { resolveApi = { resolve, reject }; }); },
    storyArchiveState: session,
    storyArchiveIsCurrent: candidate => candidate === session && state.clientSelectedInstance === 'a' && state.currentProfileIsSelf,
    renderStoryArchiveCards: candidate => renders.push(candidate),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function editArchivedStoryCaption(');
  const end = source.indexOf('\nasync function toggleArchivedStoryViewers(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.edit = editArchivedStoryCaption;`, context);
  const card = new Element(), story = { id: 9, caption: 'old' };
  const openEditor = context.edit(session, story, card);
  const editor = card.children[0];
  const [input, save] = editor.children;
  input.value = 'new caption';
  const saving = save.onclick();
  assert.equal(requests[0].url, '/api/instances/a/account/stories/edit');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), { chatId: 42, storyId: 9, caption: 'new caption' });
  resolveApi.resolve({ success: true });
  await Promise.all([openEditor, saving]);
  assert.equal(story.caption, 'new caption');
  assert.equal(status.textContent, '动态说明已更新。');
  assert.equal(renders.length, 1);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('story archive separates viewer, reaction and public forward details with stale pagination isolation', async () => {
  class Element {
    constructor() { this.children = []; this.className = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.isConnected = false; this.attributes = {}; }
    append(...children) { for (const child of children) this.appendChild(child); }
    appendChild(child) { this.children.push(child); child.isConnected = true; return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelector() { return null; }
    remove() { this.isConnected = false; }
    get childElementCount() { return this.children.length; }
  }
  const calls = [], card = new Element();
  const session = { instId: 'a', chatId: 42, selectionVersion: 3, profileRequestId: 8 };
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function toggleArchivedStoryViewers(');
  const end = source.indexOf('\nasync function toggleArchivedStoryPinned(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    document: { createElement: () => new Element() }, URLSearchParams, encodeURIComponent,
    storyArchiveIsCurrent: candidate => candidate === session,
    api: async url => {
      calls.push(url);
      return { count: 2, viewsCount: 1, reactionsCount: 1, forwardsCount: 1, nextOffset: '',
        viewers: [{ user: { id: 77, firstName: 'Viewer' }, date: 123, reaction: '❤️' }],
        forwards: [{ type: 'forward', title: 'Public channel', messageId: 100, date: 124, text: 'public message' }] };
    },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.open = toggleArchivedStoryViewers;`, context);
  await context.open(session, { id: 9 }, card, { setAttribute() {} });
  const panel = card.children[0];
  const filters = panel.children[1];
  assert.match(calls[0], /kind=viewers/);
  await filters.children[2].onclick();
  assert.match(calls[1], /kind=forwards/);
  assert.equal(panel.children[2].children[0].children[0].textContent, 'Public channel');
  assert.match(panel.children[2].children[0].children[1].textContent, /public message · 消息 100/);
  assert.equal(filters.children[2].attributes['aria-pressed'], 'true');
});

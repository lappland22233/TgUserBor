'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.style = {}; this.handlers = {}; this.children = []; this.attributes = {}; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
}

test('story media areas align to contained media and only open safe URLs after activation', () => {
  const opened = [], reactions = [];
  const elements = [];
  const media = { naturalWidth: 200, naturalHeight: 100 };
  const viewerMedia = { getBoundingClientRect: () => ({ width: 200, height: 400 }) };
  const session = { allowReaction: true };
  const context = vm.createContext({
    storyViewer: { media: viewerMedia }, URL,
    window: { open: (...args) => opened.push(args) },
    document: { createElement: tag => { const item = new Element(tag); elements.push(item); return item; } },
    storyViewerIsCurrent: () => true,
    reactToStory: emoji => reactions.push(emoji),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function layoutStoryMediaAreas(');
  const end = source.indexOf('\nasync function reactToStory(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.layout = layoutStoryMediaAreas; this.activate = activateStoryMediaArea;`, context);

  const layer = { style: {}, children: [], replaceChildren(...items) { this.children = items; }, appendChild(item) { this.children.push(item); } };
  const areas = [
    { type: 'url', x: 50, y: 50, w: 20, h: 20, rotation: 0, url: 'https://example.com/story' },
    { type: 'reaction', x: 20, y: 20, w: 10, h: 10, rotation: 0, emoji: '💯' },
    { type: 'url', x: 80, y: 80, w: 10, h: 10, rotation: 0, url: 'javascript:alert(1)' },
  ];
  context.layout(session, 1, media, layer, areas);
  assert.equal(layer.style.left, '0px');
  assert.equal(layer.style.top, '150px');
  assert.equal(layer.style.width, '200px');
  assert.equal(layer.style.height, '100px');
  assert.equal(layer.children.length, 3);
  layer.children[0].handlers.click();
  layer.children[1].handlers.click();
  layer.children[2].handlers.click();
  assert.deepEqual(opened, [['https://example.com/story', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(reactions, ['💯']);
});

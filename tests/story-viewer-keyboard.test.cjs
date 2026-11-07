'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName;
    this.children = [];
    this.hidden = false;
    this.handlers = new Map();
  }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  dispatch(type, event) { this.handlers.get(type)?.(event); }
  closest() { return this.interactive ? this : null; }
  getBoundingClientRect() { return { left: 0, width: 300 }; }
}

test('story viewer arrow keys navigate only outside text editing and keep Escape available', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function ensureStoryViewer() {');
  const end = source.indexOf('\nfunction closeStoryViewer()', start);
  assert.ok(start >= 0 && end > start);

  const input = new Element('INPUT');
  const controls = new Map([
    ['[data-story-close]', new Element('BUTTON')],
    ['[data-story-prev]', new Element('BUTTON')],
    ['[data-story-next]', new Element('BUTTON')],
    ['[data-story-stealth]', new Element('BUTTON')],
    ['[data-story-notifications]', new Element('BUTTON')],
    ['[data-story-hide]', new Element('BUTTON')],
    ['[data-story-pin]', new Element('BUTTON')],
    ['[data-story-copy-link]', new Element('BUTTON')],
    ['[data-story-reply]', new Element()],
    ['[data-story-reply] input', input],
    ['[data-story-reply] button', new Element('BUTTON')],
    ['.story-viewer-position', new Element('SPAN')],
    ['.story-viewer-media', new Element()],
    ['.story-viewer-caption', new Element('P')],
    ['.story-viewer-status', new Element('DIV')],
  ]);
  const overlay = new Element();
  overlay.querySelector = selector => controls.get(selector);
  overlay.querySelectorAll = () => [];
  const listeners = new Map();
  const opened = [];
  let closed = 0;
  let activeViewer = null;
  const context = vm.createContext({
    document: { createElement: () => overlay, body: { appendChild: item => opened.push(item) } },
    window: { addEventListener: (name, handler) => listeners.set(name, handler) },
    showStoryAt: index => { opened.push(index); if (activeViewer?.session) activeViewer.session.index = index; },
    closeStoryViewer: () => { closed++; },
  });
  vm.runInContext(`let storyViewer = null;\n${source.slice(start, end)}\nthis.ensure = ensureStoryViewer; this.viewer = () => storyViewer;`, context);

  context.ensure();
  const viewer = context.viewer();
  activeViewer = viewer;
  viewer.session = { index: 1, stories: [{}, {}, {}, {}, {}] };
  overlay.hidden = false;
  const keydown = listeners.get('keydown');
  const makeEvent = (key, target, modifiers = {}) => ({ key, target, ...modifiers, prevented: false,
    preventDefault() { this.prevented = true; } });

  const inputArrow = makeEvent('ArrowLeft', input);
  keydown(inputArrow);
  assert.deepEqual(opened, [overlay]);
  assert.equal(inputArrow.prevented, false);

  const viewerArrow = makeEvent('ArrowRight', overlay);
  keydown(viewerArrow);
  assert.deepEqual(opened, [overlay, 2]);
  assert.equal(viewerArrow.prevented, true);

  keydown(makeEvent('ArrowLeft', overlay, { ctrlKey: true }));
  assert.deepEqual(opened, [overlay, 2]);

  const media = viewer.media;
  const down = (x, y = 50, target = media) => media.dispatch('pointerdown', { target, clientX: x, clientY: y, pointerId: 4, isPrimary: true, button: 0 });
  const up = (x, y = 50, target = media) => {
    const event = makeEvent('pointerup', target);
    Object.assign(event, { clientX: x, clientY: y, pointerId: 4 });
    media.dispatch('pointerup', event);
    return event;
  };
  down(220); const swipe = up(140);
  assert.deepEqual(opened, [overlay, 2, 3]);
  assert.equal(swipe.prevented, true);
  down(30); up(34);
  assert.deepEqual(opened, [overlay, 2, 3, 2]);
  const button = new Element('BUTTON'); button.interactive = true;
  down(220, 50, button); up(140, 50, button);
  assert.deepEqual(opened, [overlay, 2, 3, 2]);

  keydown(makeEvent('Escape', input));
  assert.equal(closed, 1);
});

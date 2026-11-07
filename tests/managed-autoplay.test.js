'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('function initManagedAutoplay()');
const end = source.indexOf('// Telegram / Twemoji Vector SVG Emojis', start);
if (start < 0 || end < 0) throw new Error('Cannot locate autoplay manager');

test('only one visible autoplay video streams; scrolling away or selecting another stops it', () => {
  let intersection, mutation;
  class IntersectionObserver {
    constructor(cb) { this.callback = cb; intersection = this; }
    observe() {} unobserve() {}
  }
  class MutationObserver {
    constructor(cb) { this.callback = cb; mutation = this; }
    observe() {}
  }
  const makeVideo = url => ({
    nodeType: 1, isConnected: true, src: '', dataset: { networkAutoplay: url }, events: {}, plays: 0, pauses: 0, loads: 0,
    matches: () => true, querySelectorAll: () => [],
    addEventListener(type, callback) { this.events[type] = callback; },
    play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; },
    removeAttribute(name) { if (name === 'src') this.src = ''; }, load() { this.loads++; },
  });
  const one = makeVideo('/one'), two = makeVideo('/two');
  const body = { nodeType: 1, matches: () => false, querySelectorAll: () => [one, two] };
  const window = { IntersectionObserver };
  const context = vm.createContext({ document: { body }, window, IntersectionObserver, MutationObserver, Set, Promise });
  vm.runInContext(source.slice(start, end) + '\ninitManagedAutoplay();', context);
  intersection.callback([{ target: one, isIntersecting: true }, { target: two, isIntersecting: true }]);
  assert.equal(one.src, '/one'); assert.equal(one.plays, 1); assert.equal(two.src, '');
  two.events.pointerdown();
  assert.equal(one.src, ''); assert.equal(one.pauses, 1); assert.equal(two.src, '/two');
  two.isConnected = false;
  mutation.callback([{ addedNodes: [], removedNodes: [two] }]);
  assert.equal(two.src, ''); assert.equal(two.pauses, 1); assert.equal(one.src, '/one');
  intersection.callback([{ target: one, isIntersecting: false }]);
  assert.equal(one.src, ''); assert.equal(one.pauses, 2);
});

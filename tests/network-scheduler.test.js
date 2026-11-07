'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('class NetworkScheduler {');
const end = source.indexOf('\n// Two image requests can progress', start);
const apiStart = source.indexOf('async function api(');
const apiEnd = source.indexOf('\n// SSE Connection', apiStart);
if ([start, end, apiStart, apiEnd].some(index => index < 0)) throw new Error('Cannot locate network scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(extra = {}) {
  const context = vm.createContext({ WeakMap, Promise, ...extra });
  vm.runInContext(source.slice(start, end) + '\nthis.NetworkScheduler = NetworkScheduler;', context);
  return context;
}
function image() {
  const listeners = {};
  return {
    isConnected: true, src: '', loading: 'lazy',
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    emit(type) { listeners[type]?.(); },
  };
}

test('two visible images load in parallel while an interactive request keeps the third slot', async () => {
  const { NetworkScheduler } = harness();
  const scheduler = new NetworkScheduler(3, 2);
  const first = image(), second = image(), third = image();
  const a = scheduler.loadVisibleImage(first, '/first');
  const b = scheduler.loadVisibleImage(second, '/second');
  const c = scheduler.loadVisibleImage(third, '/third');
  assert.equal(first.src, '/first');
  assert.equal(first.loading, 'eager');
  assert.equal(second.src, '/second');
  assert.equal(second.loading, 'eager');
  assert.equal(third.src, '');
  const apiBody = deferred();
  let apiStarted = false;
  const api = scheduler.enqueue(async () => { apiStarted = true; return apiBody.promise; }, 0);
  await tick();
  assert.equal(apiStarted, true);
  assert.equal(third.src, '');
  apiBody.resolve('api');
  assert.equal(await api, 'api');
  await tick();
  assert.equal(third.src, '');
  first.emit('load'); await a; await tick();
  assert.equal(third.src, '/third');
  second.emit('load'); await b;
  third.emit('load'); await c;
});

test('detached images are cancelled and queued stale images are skipped', async () => {
  const { NetworkScheduler } = harness();
  const scheduler = new NetworkScheduler(2, 1);
  const first = image(), stale = image();
  const a = scheduler.loadVisibleImage(first, '/first');
  const b = scheduler.loadVisibleImage(stale, '/stale');
  stale.isConnected = false;
  first.isConnected = false; scheduler.cancelVisibleImage(first);
  assert.equal(await a, false);
  assert.equal(await b, false);
  assert.equal(first.src, ''); assert.equal(stale.src, '');
});

test('API keeps its slot until the response body is consumed', async () => {
  const body = deferred(); let bodyStarted = false;
  const context = harness({ fetch: async () => ({ ok: true, json: () => { bodyStarted = true; return body.promise; } }) });
  context.scheduler = new context.NetworkScheduler(1, 1);
  vm.runInContext(source.slice(apiStart, apiEnd) + '\nthis.api = api;', context);
  const request = context.api('/api/status');
  await tick(); assert.equal(bodyStarted, true);
  let nextStarted = false;
  const next = context.scheduler.enqueue(async () => { nextStarted = true; });
  await tick(); assert.equal(nextStarted, false);
  body.resolve({ ok: true });
  await request; await next;
  assert.equal(nextStarted, true);
});

test('video posters share the media queue and release their object URL on removal', async () => {
  const body = deferred(); const revoked = [];
  const context = harness({
    AbortController,
    URL: { createObjectURL: () => 'blob:poster', revokeObjectURL: url => revoked.push(url) },
    fetch: async () => ({ ok: true, blob: () => body.promise }),
  });
  const scheduler = new context.NetworkScheduler(2, 1);
  const video = { isConnected: true, poster: '' };
  const poster = scheduler.loadVisiblePoster(video, '/poster');
  const img = image();
  const queued = scheduler.loadVisibleImage(img, '/photo');
  assert.equal(img.src, '');
  body.resolve({}); await poster; await tick();
  assert.equal(video.poster, 'blob:poster');
  assert.equal(img.src, '/photo');
  video.isConnected = false; scheduler.cancelVisibleImage(video);
  assert.deepEqual(revoked, ['blob:poster']);
  img.emit('load'); await queued;
});

test('a queued sticker hidden before its turn waits until it is visible again', async () => {
  let observer;
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {} unobserve() {}
  }
  class MutationObserver { constructor() {} observe() {} }
  const sticker = image();
  sticker.dataset = { networkSrc: '/sticker', networkSticker: '1' };
  sticker.nodeType = 1; sticker.matches = () => true; sticker.querySelectorAll = () => [];
  sticker.getClientRects = () => sticker.visible ? [1] : [];
  sticker.visible = true;
  const body = { nodeType: 1, matches: () => false, querySelectorAll: () => [sticker] };
  const context = harness({ document: { body }, window: { IntersectionObserver }, IntersectionObserver, MutationObserver });
  context.scheduler = new context.NetworkScheduler(2, 1);
  const managedStart = source.indexOf('function initManagedImages()');
  const managedEnd = source.indexOf('// Autoplay media', managedStart);
  vm.runInContext(source.slice(managedStart, managedEnd) + '\ninitManagedImages();', context);
  const first = image(); const blocking = context.scheduler.loadVisibleImage(first, '/first');
  observer.callback([{ target: sticker, isIntersecting: true }]);
  sticker.visible = false;
  observer.callback([{ target: sticker, isIntersecting: false }]);
  first.emit('load'); await blocking; await tick();
  assert.equal(sticker.src, '');
  assert.equal(sticker.dataset.networkSrc, '/sticker');
  sticker.visible = true;
  observer.callback([{ target: sticker, isIntersecting: true }]);
  await tick(); assert.equal(sticker.src, '/sticker');
  sticker.emit('load'); await tick();
});

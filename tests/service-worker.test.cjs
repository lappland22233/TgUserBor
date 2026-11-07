'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const handlers = {}, stores = new Map(), requests = [];
  const requestUrl = request => typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
  const cache = {
    async put(request, response) { stores.get('tguserbot-shell-v1').set(requestUrl(request), response.clone()); },
    async match(request) { return stores.get('tguserbot-shell-v1').get(requestUrl(request))?.clone(); },
  };
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, new Map()); return cache; },
    async match(request) {
      const key = requestUrl(request);
      for (const store of stores.values()) if (store.has(key)) return store.get(key).clone();
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  let offline = false;
  const fetch = async request => {
    const url = new URL(requestUrl(request));
    requests.push(url.href);
    if (offline) throw new Error('offline');
    if (url.pathname === '/') return new Response('<link href="style.css?v=58"><script src="app.js?v=64"></script><script src="/api/status.js"></script><script src="https://cdn.example/ext.js"></script>');
    return new Response(`asset:${url.pathname}`);
  };
  const self = { registration: { scope: 'http://localhost:3000/' }, clients: { claim: async () => {} }, skipWaiting: async () => {},
    addEventListener: (type, handler) => { handlers[type] = handler; } };
  vm.runInNewContext(fs.readFileSync('src/gui/web/service-worker.js', 'utf8'), { self, caches, fetch, URL, Response, Promise, Set });
  return { handlers, stores, requests, setOffline: value => { offline = value; } };
}

test('service worker precaches same-origin shell assets, deletes old caches, and claims clients', async () => {
  const h = harness();
  let installation;
  h.handlers.install({ waitUntil: promise => { installation = promise; } });
  await installation;
  assert.deepEqual([...h.stores.get('tguserbot-shell-v1').keys()], [
    'http://localhost:3000/', 'http://localhost:3000/style.css?v=58', 'http://localhost:3000/app.js?v=64',
  ]);
  assert.equal(h.requests.some(url => url.includes('/api/')), false);
  assert.equal(h.requests.some(url => url.includes('cdn.example')), false);
  let claimed = false;
  h.handlers.activate({ waitUntil: promise => { installation = promise; } });
  await installation;
  assert.equal(h.stores.has('tguserbot-shell-v1'), true);
});

test('service worker serves cached static shell offline and never intercepts API or cross-origin data', async () => {
  const h = harness();
  let work;
  h.handlers.install({ waitUntil: promise => { work = promise; } });
  await work;
  h.setOffline(true);
  let response;
  h.handlers.fetch({ request: { method: 'GET', url: 'http://localhost:3000/app.js?v=64', mode: 'cors' }, respondWith: promise => { response = promise; } });
  assert.equal(await (await response).text(), 'asset:/app.js');
  let intercepted = false;
  h.handlers.fetch({ request: { method: 'GET', url: 'http://localhost:3000/api/status', mode: 'cors' }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
  h.handlers.fetch({ request: { method: 'GET', url: 'https://cdn.example/app.js', mode: 'cors' }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});

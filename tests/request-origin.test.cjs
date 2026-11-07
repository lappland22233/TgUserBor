'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { isAllowedRequestOrigin } = require('../dist/gui/request-origin.js');
const { GUIServer } = require('../dist/gui/server.js');

function request(headers = {}, encrypted = false) {
  return { headers: { host: 'localhost:3000', ...headers }, socket: { encrypted } };
}

test('origin check accepts same-origin and local non-browser clients, rejects cross-origin and opaque origins', () => {
  assert.equal(isAllowedRequestOrigin(request({ origin: 'http://localhost:3000' })), true);
  assert.equal(isAllowedRequestOrigin(request()), true);
  for (const origin of ['https://localhost:3000', 'http://localhost:3001', 'http://evil.example', 'null', 'http://localhost:3000/path']) {
    assert.equal(isAllowedRequestOrigin(request({ origin })), false, origin);
  }
  assert.equal(isAllowedRequestOrigin(request({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isAllowedRequestOrigin(request({ origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' })), false);
});

test('forwarded host and scheme are used only with an explicitly trusted proxy', () => {
  const req = request({ host: '127.0.0.1:3000', origin: 'https://chat.example', 'x-forwarded-host': 'chat.example', 'x-forwarded-proto': 'https' });
  assert.equal(isAllowedRequestOrigin(req), false);
  assert.equal(isAllowedRequestOrigin(req, true), true);
  assert.equal(isAllowedRequestOrigin(request({ origin: 'https://localhost:3000' }, true)), true);
});

function httpStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/cache/stats', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsStatus(port, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat-rpc`, { origin });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
    ws.on('error', reject);
  });
}

test('HTTP API and WebSocket reject foreign browser origins', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-origin-'));
  const server = new GUIServer({ baseDir });
  t.after(async () => { await server.stop(); fs.rmSync(baseDir, { recursive: true, force: true }); });
  await server.start(0, '127.0.0.1');
  const port = server.server.address().port;
  const same = `http://127.0.0.1:${port}`;
  assert.equal(await httpStatus(port, { origin: 'http://evil.example' }), 403);
  assert.equal(await httpStatus(port, { origin: same }), 200);
  assert.equal(await httpStatus(port, {}), 200);
  assert.equal(await wsStatus(port, 'http://evil.example'), 403);
  assert.equal(await wsStatus(port, same), 'open');
});

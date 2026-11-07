'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { handleApiRoute } = require('../dist/gui/api');

test('saved GIF preview validates document IDs and streams byte ranges', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tguser-gif-'));
  const filePath = path.join(dir, 'preview.mp4'); fs.writeFileSync(filePath, '0123456789');
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params }); return { filePath, mimeType: params.mimeType };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/gif-preview`;
    const invalid = await fetch(`${base}?docId=x&accessHash=88`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}?docId=77&accessHash=88&mimeType=video/webm`, { headers: { range: 'bytes=2-4' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'video/webm');
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await response.text(), '234');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'get_gif_preview');
    assert.equal(calls[0].params.docId, '77');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { GUIServer } = require('../dist/gui/server.js');

function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GUI bundles preserve all classic scripts and support compression and cache validation', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-bundles-'));
  const webDir = path.resolve('src/gui/web');
  const server = new GUIServer({ baseDir, webDir });
  t.after(async () => { await server.stop(); fs.rmSync(baseDir, { recursive: true, force: true }); });
  await server.start(0, '127.0.0.1');
  const port = server.server.address().port;
  const html = await request(port, '/');
  assert.match(html.body.toString(), /href="bundle\.css"/);
  assert.match(html.body.toString(), /src="bundle\.js"/);
  const plain = await request(port, '/bundle.js');
  const zipped = await request(port, '/bundle.js', { 'accept-encoding': 'gzip' });
  assert.equal(plain.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.deepEqual(zlib.gunzipSync(zipped.body), plain.body);
  assert.ok(zipped.body.length < plain.body.length / 2);
  const files = ['js/theme.js', 'js/plugin-config-form.js', 'js/settings.js', 'js/profile-panel.js', 'js/dialog-folders.js', 'js/chat-notifications.js', 'js/cloud-drafts.js', 'js/visual-viewport.js', 'js/mini-app.js', 'js/bot-keyboard.js', 'js/chat-ws.js', 'js/comments.js', 'js/pinned-messages.js', 'js/forum-topics.js', 'app.js', 'js/global-message-search.js'];
  const expected = "'use strict';\n" + files.map(file => fs.readFileSync(path.join(webDir, file), 'utf8')).join('\n;\n');
  assert.equal(plain.body.toString(), expected);
  const notModified = await request(port, '/bundle.js', { 'if-none-match': plain.headers.etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  const noGzip = await request(port, '/bundle.css', { 'accept-encoding': 'gzip;q=0, *;q=1' });
  assert.equal(noGzip.headers['content-encoding'], undefined);
  const head = await request(port, '/bundle.css', { 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'gzip');
});

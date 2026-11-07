'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { withTemporaryUpload } = require('../dist/manager/media-upload');
const { handleApiRoute, parseJsonBody } = require('../dist/gui/api');

test('temporary uploads stay within a private directory and are removed after success and failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  try {
    await withTemporaryUpload(root, '../../outside.txt', Buffer.from('hello').toString('base64'), async file => {
      assert.equal(path.basename(file), 'outside.txt');
      assert.equal(path.dirname(path.dirname(file)), root);
      assert.equal(await fs.readFile(file, 'utf8'), 'hello');
    });
    assert.deepEqual(await fs.readdir(root), []);
    await assert.rejects(withTemporaryUpload(root, '..\\..\\outside.txt', 'aGVsbG8=', async file => {
      assert.equal(path.basename(file), 'outside.txt');
      throw new Error('upload failed');
    }), /upload failed/);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JSON body limits count bytes and reject oversize streams', async () => {
  const req = new PassThrough();
  const result = parseJsonBody(req, 8);
  req.write(Buffer.from('{"x":"'));
  req.end(Buffer.from('汉"}'));
  await assert.rejects(result, /Payload too large/);
});

test('media API accepts files over the default JSON limit and forwards options', async () => {
  const actions = [];
  const manager = { getInstance: () => ({ accountAction: async (name, payload) => { actions.push({ name, payload }); return { messageId: 42 }; } }) };
  const server = http.createServer((req, res) => { handleApiRoute(req, res, manager, '').catch(err => { res.statusCode = 500; res.end(err.message); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/demo/account`;
    const body = { chatId: 123, fileName: 'video.mp4', fileBase64: Buffer.alloc(900_000, 1).toString('base64'), mediaType: 'video', videoNote: true, schedule: 1900000000, parseMode: 'html', silent: true };
    const response = await fetch(`${base}/send-media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(actions[0].name, 'send_media');
    assert.equal(actions[0].payload.schedule, body.schedule);
    assert.equal(actions[0].payload.parseMode, 'html');
    assert.equal(actions[0].payload.silent, true);
    assert.equal(actions[0].payload.videoNote, true);
    const invalid = await fetch(`${base}/send-media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, fileBase64: 'YQ==', schedule: 'invalid' }) });
    assert.equal(invalid.status, 400);
    assert.equal(actions.length, 1);
    const deletion = await fetch(`${base}/delete-messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 123, messageIds: [1], revoke: false }) });
    assert.equal(deletion.status, 200);
    assert.equal(actions[1].payload.revoke, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

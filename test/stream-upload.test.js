'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable, PassThrough } = require('node:stream');
const project = process.cwd();
const root = fssync.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
process.chdir(root);
const { receiveStreamUpload, receiveStreamAlbumUpload, isStreamUploadPath, cleanupStreamUpload, cleanupStreamUploadIfOwnerExited, markStreamUploadOwner, STREAM_UPLOAD_ROOT } = require(path.join(project, 'dist/manager/media-upload'));
const { handleApiRoute } = require(path.join(project, 'dist/gui/api'));
process.on('exit', () => fssync.rmSync(root, { recursive: true, force: true }));

function frame(metadata, body) {
  const json = Buffer.from(JSON.stringify(metadata));
  const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, Buffer.from(body)]);
}
function albumFrame(metadata, files) {
  const json = Buffer.from(JSON.stringify(metadata));
  const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  return Buffer.concat([size, json, ...files.map(file => Buffer.from(file))]);
}
async function list() { return fs.readdir(STREAM_UPLOAD_ROOT).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)); }

async function runServer(handler, fn) {
  const server = http.createServer((req, res) => { handler(req, res).catch(e => { if (!res.destroyed) { res.statusCode = 500; res.end(e.message); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('stream parser accepts fragmented header, sanitizes filename, and confines cleanup', async () => {
  const data = frame({ fileName: '../../evil.txt' }, 'hello');
  const staged = await receiveStreamUpload(Readable.from([data.subarray(0, 2), data.subarray(2, 9), data.subarray(9)]));
  assert.equal(path.basename(staged.path), 'evil.txt');
  assert.equal(await fs.readFile(staged.path, 'utf8'), 'hello');
  assert.equal(isStreamUploadPath(staged.path), true);
  assert.equal(isStreamUploadPath(path.join(STREAM_UPLOAD_ROOT, 'upload-bogus', 'file')), false);
  assert.equal(isStreamUploadPath(path.join(path.dirname(staged.path), '.upload-owner')), false);
  await assert.rejects(cleanupStreamUpload(path.join(root, 'outside')), /Invalid staged upload/);
  await cleanupStreamUpload(staged.path);
  assert.deepEqual(await list(), []);
});

test('album stream parser writes each bounded file and removes the whole staged album', async () => {
  const fileA = Buffer.from('first image');
  const fileB = Buffer.from('second video');
  const request = albumFrame({ files: [
    { fileName: '../../one.jpg', mimeType: 'image/jpeg', size: fileA.length },
    { fileName: 'one.jpg', mimeType: 'image/jpeg', size: fileB.length },
  ] }, [fileA, fileB]);
  const staged = await receiveStreamAlbumUpload(Readable.from([
    request.subarray(0, 2), request.subarray(2, 25), request.subarray(25, 60), request.subarray(60),
  ]));
  assert.equal(staged.paths.length, 2);
  assert.equal(path.basename(staged.paths[0]), 'one.jpg');
  assert.equal(path.basename(staged.paths[1]), 'one (2).jpg');
  assert.deepEqual(await Promise.all(staged.paths.map(file => fs.readFile(file))), [fileA, fileB]);
  assert.ok(staged.paths.every(isStreamUploadPath));
  await cleanupStreamUpload(staged.paths[0]);
  assert.deepEqual(await list(), []);
  await assert.rejects(receiveStreamAlbumUpload(Readable.from([albumFrame({ files: [
    { fileName: 'a.jpg', mimeType: 'image/jpeg', size: 9 },
    { fileName: 'b.jpg', mimeType: 'image/jpeg', size: 9 },
  ] }, [Buffer.from('too short')])])), /Missing album file data/);
  assert.deepEqual(await list(), []);
});


test('cleanup never removes a long-running upload while receiving its bytes', async () => {
  const input = new PassThrough();
  const pending = receiveStreamUpload(input);
  input.write(frame({ fileName: 'slow.txt' }, 'first'));
  let directory;
  for (let i = 0; i < 100; i++) {
    const entries = await list();
    if (entries.length && fssync.existsSync(path.join(STREAM_UPLOAD_ROOT, entries[0], '.upload-owner'))) {
      directory = path.join(STREAM_UPLOAD_ROOT, entries[0]);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(directory, 'receiver must mark its ownership before writing');
  const originalNow = Date.now;
  try {
    const old = new Date(originalNow() - 25 * 60 * 60_000);
    await fs.utimes(directory, old, old);
    Date.now = () => originalNow() + 25 * 60 * 60_000;
    const second = await receiveStreamUpload(Readable.from([frame({ fileName: 'other.txt' }, 'other')]));
    assert.equal(await fs.readFile(path.join(directory, 'slow.txt'), 'utf8'), 'first');
    await cleanupStreamUpload(second.path);
  } finally {
    Date.now = originalNow;
    input.end(' second');
    const staged = await pending;
    assert.equal(await fs.readFile(staged.path, 'utf8'), 'first second');
    await cleanupStreamUpload(staged.path);
  }
});

test('orphan cleanup preserves files while the owner is alive and deletes after exit', async () => {
  const alive = await receiveStreamUpload(Readable.from([frame({ fileName: 'alive' }, 'a')]));
  await markStreamUploadOwner(alive.path, process.pid);
  assert.equal(await cleanupStreamUploadIfOwnerExited(alive.path), false);
  assert.equal(await fs.readFile(alive.path, 'utf8'), 'a');
  await cleanupStreamUpload(alive.path);
  const dead = await receiveStreamUpload(Readable.from([frame({ fileName: 'dead' }, 'b')]));
  await markStreamUploadOwner(dead.path, 2147483647);
  assert.equal(await cleanupStreamUploadIfOwnerExited(dead.path), true);
  assert.deepEqual(await list(), []);
});

test('oversized stream returns 413 without destroying the socket and cleans partial upload', async () => {
  await runServer(async (req, res) => {
    try { await receiveStreamUpload(req, STREAM_UPLOAD_ROOT, 5); res.end('unexpected'); }
    catch (e) { res.statusCode = e.message === 'Payload too large' ? 413 : 400; res.end(e.message); }
  }, async base => {
    const response = await fetch(base, { method: 'POST', body: frame({ fileName: 'a.txt' }, 'too large') });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /Payload too large/);
  });
  assert.deepEqual(await list(), []);
});

test('real upload route streams bytes, passes scheduling and cleans after success or failed dispatch', async () => {
  let mode = 'success';
  let calls = 0;
  const instance = { getInfo: () => ({ pid: process.pid }), accountAction: async (name, payload) => {
    calls++;
    assert.equal(name, 'send_media_stream');
    assert.equal(await fs.readFile(payload.uploadPath, 'utf8'), 'hello world');
    if (payload.schedule != null) assert.equal(payload.schedule, 1900000000);
    if (payload.silent != null) assert.equal(payload.silent, true);
    if (payload.effectId != null) assert.equal(payload.effectId, '123');
    if (payload.invertMedia != null) assert.equal(payload.invertMedia, true);
    if (payload.paidStars != null) assert.equal(payload.paidStars, 25);
    if (payload.scheduleRepeatPeriod != null) assert.equal(payload.scheduleRepeatPeriod, 604800);
    if (mode === 'not-dispatched') throw Object.assign(new Error('offline'), { code: 'ACTION_NOT_DISPATCHED' });
    if (mode === 'timeout') throw new Error('响应超时');
    return { messageId: 5 };
  } };
  await runServer((req, res) => handleApiRoute(req, res, { getInstance: () => instance }, ''), async base => {
    const send = metadata => fetch(`${base}/api/instances/a/account/send-media`, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' }, body: frame(metadata, 'hello world') });
    const metadata = { chatId: 5, fileName: '..\\..\\x.jpg', mediaType: 'photo', schedule: 1900000000, silent: true, effectId: '123', paidStars: 25, invertMedia: true };
    assert.equal((await send(metadata)).status, 200);
    assert.deepEqual(await list(), []);
    const repeatMetadata = { ...metadata, paidStars: undefined, scheduleRepeatPeriod: 604800 };
    assert.equal((await send(repeatMetadata)).status, 200);
    assert.deepEqual(await list(), []);
    const videoNoteMetadata = { chatId: 5, fileName: 'note.mp4', mediaType: 'video', videoNote: true };
    assert.equal((await send(videoNoteMetadata)).status, 200);
    assert.deepEqual(await list(), []);
    assert.equal((await send({ ...videoNoteMetadata, mediaType: 'photo' })).status, 400);
    assert.equal((await send({ ...videoNoteMetadata, scheduleRepeatPeriod: 604800 })).status, 400);
    mode = 'not-dispatched';
    assert.equal((await send(repeatMetadata)).status, 500);
    assert.deepEqual(await list(), []);
    assert.equal((await send({ ...metadata, schedule: -1 })).status, 400);
    assert.equal((await send({ ...metadata, effectId: '0' })).status, 400);
    assert.equal((await send({ ...metadata, invertMedia: 'true' })).status, 400);
    assert.deepEqual(await list(), []);
    mode = 'timeout';
    assert.equal((await send(metadata)).status, 500);
    const waiting = await list();
    assert.equal(waiting.length, 1, 'in-flight files must not be removed while the worker can still use them');
    await cleanupStreamUpload(path.join(STREAM_UPLOAD_ROOT, waiting[0], 'x.jpg'));
    assert.equal(calls, 5);
  });
});

test('album upload route preserves caption, reply, schedule and silent settings and cleans staged files', async () => {
  let calls = 0;
  const instance = { getInfo: () => ({ pid: process.pid }), accountAction: async (action, payload) => {
    calls++;
    assert.equal(action, 'send_media_album_stream');
    assert.equal(payload.replyTo, 8);
    assert.equal(payload.schedule, 1900000000);
    assert.equal(payload.silent, true);
    assert.equal(payload.caption, 'album caption');
    assert.equal(payload.effectId, '456');
    assert.equal(payload.paidStars, 12);
    assert.equal(payload.invertMedia, true);
    assert.deepEqual(await Promise.all(payload.uploadPaths.map(file => fs.readFile(file, 'utf8'))), ['image one', 'image two']);
    return { messageId: 51 };
  } };
  await runServer((req, res) => handleApiRoute(req, res, { getInstance: () => instance }, ''), async base => {
    const files = [Buffer.from('image one'), Buffer.from('image two')];
    const metadata = { chatId: 7, caption: 'album caption', replyTo: 8, schedule: 1900000000, silent: true, effectId: '456', paidStars: 12, invertMedia: true, files: [
      { fileName: 'one.jpg', mimeType: 'image/jpeg', size: files[0].length },
      { fileName: 'two.png', mimeType: 'image/png', size: files[1].length },
    ] };
    const send = data => fetch(`${base}/api/instances/a/account/send-media-album`, {
      method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-album-stream' }, body: albumFrame(data, files),
    });
    const response = await send(metadata);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, messageId: 51 });
    assert.deepEqual(await list(), []);
    assert.equal((await send({ ...metadata, files: metadata.files.slice(0, 1) })).status, 400);
    assert.equal((await send({ ...metadata, scheduleRepeatPeriod: 86400 })).status, 400);
    assert.equal((await send({ ...metadata, invertMedia: 'true' })).status, 400);
    assert.deepEqual(await list(), []);
    assert.equal(calls, 1);
  });
});

test('aborted request removes partially received files and never sends them', async () => {
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  let calls = 0;
  const instance = { getInfo: () => ({ pid: process.pid }), accountAction: async () => { calls++; } };
  await runServer(async (req, res) => {
    try { await handleApiRoute(req, res, { getInstance: () => instance }, ''); }
    finally { resolveFinished(); }
  }, async base => {
    await new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/instances/a/account/send-media`, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream', 'content-length': '1000000' } });
      req.on('error', () => resolve());
      req.write(frame({ chatId: 5, fileName: 'x.jpg', mediaType: 'photo' }, 'partial'), () => setTimeout(() => req.destroy(), 30));
      setTimeout(() => reject(new Error('abort timeout')), 2000).unref();
    });
    await finished;
  });
  assert.equal(calls, 0);
  assert.deepEqual(await list(), []);
});

test('media comments keep the channel post id and reject conflicting reply targets', async () => {
  const calls = [];
  const instance = { getInfo: () => ({ pid: process.pid }), accountAction: async (action, payload) => {
    calls.push({ action, payload });
    assert.equal(await fs.readFile(payload.uploadPath, 'utf8'), 'image');
    return { messageId: 42 };
  } };
  await runServer((req, res) => handleApiRoute(req, res, { getInstance: () => instance }, ''), async base => {
    const send = metadata => fetch(`${base}/api/instances/a/account/send-media`, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' }, body: frame(metadata, 'image') });
    const metadata = { chatId: -100123, commentTo: 9, fileName: 'a.jpg', mediaType: 'photo', caption: 'hello', parseMode: 'plain' };
    assert.equal((await send(metadata)).status, 200);
    assert.equal(calls[0].action, 'send_media_stream');
    assert.equal(calls[0].payload.chatId, -100123);
    assert.equal(calls[0].payload.commentTo, 9);
    assert.equal(calls[0].payload.caption, 'hello');
    assert.equal((await send({ ...metadata, replyTo: 8 })).status, 400);
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(await list(), []);
});

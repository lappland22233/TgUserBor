'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { downloadMediaToCache, mediaCacheNamespace, withAwaitedFileWriter } = require('../dist/bot/driver/media-cache');
const { handleApiRoute } = require('../dist/gui/api');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('media namespace isolates both instances and accounts', () => {
  assert.notEqual(mediaCacheNamespace('/tmp/session-a', 1), mediaCacheNamespace('/tmp/session-b', 1));
  assert.notEqual(mediaCacheNamespace('/tmp/session-a', 1), mediaCacheNamespace('/tmp/session-a', 2));
  assert.equal(mediaCacheNamespace('/tmp/session-a', 1), mediaCacheNamespace('/tmp/session-a', 1));
});

test('concurrent media requests never observe partial downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-cache-'));
  try {
    const target = path.join(root, 'video.mp4');
    const started = deferred(), release = deferred();
    let downloads = 0;
    const download = file => withAwaitedFileWriter(file, async writer => {
      downloads++;
      await writer.write(Buffer.from('first'));
      started.resolve();
      await release.promise;
      await writer.write(Buffer.from('second'));
    });
    const a = downloadMediaToCache(target, download);
    await started.promise;
    const b = downloadMediaToCache(target, download);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    release.resolve();
    assert.equal(await a, true);
    assert.equal(await b, true);
    assert.equal(downloads, 1);
    assert.equal(await fs.readFile(target, 'utf8'), 'firstsecond');
    assert.deepEqual(await fs.readdir(root), ['video.mp4']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed downloads leave no partial cache and can be retried', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-cache-'));
  const target = path.join(root, 'photo');
  try {
    await assert.rejects(downloadMediaToCache(target, async temporary => {
      await fs.writeFile(temporary, 'partial');
      throw new Error('network down');
    }), /network down/);
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal(await downloadMediaToCache(target, file => fs.writeFile(file, 'complete')), true);
    assert.equal(await fs.readFile(target, 'utf8'), 'complete');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('driver keeps same message and avatar separate across Telegram accounts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-driver-media-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    const make = (selfId, data) => {
      const driver = Object.create(TelegramDriver.prototype);
      driver.selfId = selfId;
      driver.config = { telegram: { sessionPath: '/tmp/example.session' } };
      driver.logger = { debug() {} };
      driver.client = {
        getMessages: async () => [{ media: { className: 'MockMedia' } }],
        downloadMedia: async (_, { outputFile }) => outputFile.write(Buffer.from(data)),
        getEntity: async () => ({}),
        downloadProfilePhoto: async (_, { outputFile }) => outputFile.write(Buffer.from(data)),
      };
      return driver;
    };
    const a = make(1, 'account-a'), b = make(2, 'account-b');
    const first = await a.downloadMediaFile(5, 10), second = await b.downloadMediaFile(5, 10);
    assert.notEqual(first.filePath, second.filePath);
    assert.equal(await fs.readFile(first.filePath, 'utf8'), 'account-a');
    assert.equal(await fs.readFile(second.filePath, 'utf8'), 'account-b');
    const avatarA = await a.downloadProfilePhoto(5), avatarB = await b.downloadProfilePhoto(5);
    assert.notEqual(avatarA, avatarB);
    assert.equal(await fs.readFile(avatarA, 'utf8'), 'account-a');
    assert.equal(await fs.readFile(avatarB, 'utf8'), 'account-b');
  } finally { process.chdir(previous); await fs.rm(root, { recursive: true, force: true }); }
});

test('HTTP media handles browser byte ranges and safe Unicode downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-media-http-'));
  const file = path.join(root, 'media');
  await fs.writeFile(file, '0123456789');
  const manager = { getInstance: () => ({ accountAction: async () => ({ filePath: file, mimeType: 'video/mp4', fileName: '音乐 (测试).mp4' }) }) };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(() => res.destroy()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/demo/account/media?chatId=1&messageId=2&download=1`;
    for (const [range, status, body, contentRange] of [
      ['bytes=2-4', 206, '234', 'bytes 2-4/10'],
      ['bytes=7-', 206, '789', 'bytes 7-9/10'],
      ['bytes=-3', 206, '789', 'bytes 7-9/10'],
      ['bytes=8-100', 206, '89', 'bytes 8-9/10'],
      ['bytes=10-', 416, '', 'bytes */10'],
      ['bytes=-0', 416, '', 'bytes */10'],
      ['bytes=0-1,3-4', 200, '0123456789', null],
    ]) {
      const response = await fetch(url, { headers: { range } });
      assert.equal(response.status, status, range);
      assert.equal(await response.text(), body, range);
      assert.equal(response.headers.get('content-range'), contentRange, range);
      if (status !== 416) {
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E9%9F%B3/);
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('actual GramJS cached photo download flushes before the cache is published', async () => {
  const { Api } = require('telegram');
  const bigInt = require('big-integer');
  const { downloadMedia } = require('telegram/client/downloads');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-gramjs-media-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    const photo = new Api.Photo({ id: bigInt(3), accessHash: bigInt(4), fileReference: Buffer.alloc(0), date: 1, sizes: [new Api.PhotoCachedSize({ type: 's', bytes: Buffer.from('real-gramjs') })], dcId: 1 });
    const driver = Object.create(TelegramDriver.prototype);
    driver.selfId = 1;
    driver.config = { telegram: { sessionPath: '/tmp/example.session' } };
    driver.logger = { debug() {} };
    const client = driver.client = {
      getMessages: async () => [{ media: photo }],
      downloadMedia: (media, options) => downloadMedia(client, media, options.outputFile, options.thumb),
    };
    const result = await driver.downloadMediaFile(5, 42);
    assert.equal(await fs.readFile(result.filePath, 'utf8'), 'real-gramjs');
    assert.deepEqual((await fs.readdir(path.dirname(result.filePath))).filter(name => name.includes('.part')), []);
  } finally { process.chdir(previous); await fs.rm(root, { recursive: true, force: true }); }
});

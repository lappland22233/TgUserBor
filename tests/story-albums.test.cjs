'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { BinaryReader } = require('telegram/extensions/BinaryReader');
const { Api: ModernApi } = require('teleproto');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function makeDriver() {
  const calls = [];
  const coverPhoto = new ModernApi.Photo({ id: bigInt(99), accessHash: bigInt(100), fileReference: Buffer.alloc(0), date: 1,
    sizes: [new ModernApi.PhotoSize({ type: 'm', w: 64, h: 64, size: 256 })], dcId: 2 });
  const album = new ModernApi.StoryAlbum({ albumId: 7, title: '精选动态', iconPhoto: coverPhoto });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = () => 'me';
  driver.client = {
    getInputEntity: async () => new Api.InputPeerSelf(),
    invoke: async request => {
      calls.push(request);
      if (request.className === 'stories.GetAlbums') return new ModernApi.stories.Albums({ hash: bigInt(1), albums: [album] });
      if (request.className === 'stories.GetAlbumStories') return { count: 21, stories: [], chats: [], users: [] };
      if (request.className === 'stories.CreateAlbum') return new ModernApi.StoryAlbum({ albumId: 8, title: request.title });
      if (request.className === 'stories.UpdateAlbum') return new ModernApi.StoryAlbum({ albumId: request.albumId, title: request.title || album.title });
      return true;
    },
  };
  return { driver, calls };
}

test('story album methods use the current GramJS session with the modern Telegram TL schema', async () => {
  const decoded = new BinaryReader(new ModernApi.stories.Albums({ hash: bigInt(1),
    albums: [new ModernApi.StoryAlbum({ albumId: 5, title: '解码验证' })] }).getBytes()).tgReadObject();
  assert.equal(decoded.className, 'stories.Albums');
  assert.equal(decoded.albums[0].title, '解码验证');
  const { driver, calls } = makeDriver();
  assert.deepEqual(await driver.getStoryAlbums(42), [{ id: 7, title: '精选动态', coverType: 'photo' }]);
  assert.deepEqual(await driver.getStoryAlbumStories(42, 7, 20, 20), { stories: [], count: 21, nextOffset: 20 });
  assert.deepEqual(await driver.createStoryAlbum(42, '  纪念  ', [9, 10]), { id: 8, title: '纪念' });
  assert.deepEqual(await driver.updateStoryAlbum(42, 7, { title: '精选' }), { id: 7, title: '精选' });
  await driver.updateStoryAlbum(42, 7, { addStoryIds: [11, 12] });
  await driver.updateStoryAlbum(42, 7, { removeStoryIds: [11] });
  await driver.deleteStoryAlbum(42, 7);
  assert.deepEqual(calls.filter(call => call.className === 'stories.GetAlbumStories')[0].getBytes().length > 0, true);
  const create = calls.find(call => call.className === 'stories.CreateAlbum');
  assert.equal(create.peer.className, 'InputPeerSelf');
  assert.equal(create.title, '纪念');
  assert.deepEqual(create.stories, [9, 10]);
  const updates = calls.filter(call => call.className === 'stories.UpdateAlbum');
  assert.deepEqual(updates.map(call => [call.title, call.addStories, call.deleteStories]), [
    ['精选', undefined, undefined], [undefined, [11, 12], undefined], [undefined, undefined, [11]],
  ]);
  assert.ok(calls.some(call => call instanceof ModernApi.stories.GetAlbums));
  assert.ok(calls.some(call => call instanceof ModernApi.stories.DeleteAlbum));
  await assert.rejects(driver.createStoryAlbum(77, '错误'), /current account/);
  await assert.rejects(driver.updateStoryAlbum(42, 99, { title: '不存在' }), /Invalid Telegram story album update/);
  await assert.rejects(driver.updateStoryAlbum(42, 7, { addStoryIds: [11], removeStoryIds: [11] }), /same request/);
  await assert.rejects(driver.getStoryAlbumStories(42, 99), /not found/);
});

test('story album cover downloads only the cover thumbnail through a Telegram file location', async () => {
  const { driver } = makeDriver();
  const sessionPath = path.join(os.tmpdir(), `story-album-cover-${randomUUID()}`);
  driver.config = { telegram: { sessionPath } };
  const downloaded = [];
  driver.client.downloadFile = async (location, options) => {
    downloaded.push({ location, dcId: options.dcId });
    await options.outputFile.write(Buffer.from('cover-image'));
  };
  let filePath;
  try {
    const cover = await driver.downloadStoryAlbumCover(42, 7);
    assert.equal(cover.mimeType, 'image/jpeg');
    filePath = cover.filePath;
    assert.match(filePath, /story-album-covers/);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'cover-image');
    assert.equal(downloaded[0].location.className, 'InputPhotoFileLocation');
    assert.equal(downloaded[0].location.thumbSize, 'm');
    assert.equal(downloaded[0].dcId, 2);
  } finally {
    if (filePath) await fs.rm(filePath, { force: true });
  }
});

test('video story album covers expose and download the Telegram document thumbnail', async () => {
  const thumb = new ModernApi.PhotoSize({ type: 'm', w: 64, h: 64, size: 256 });
  const video = new ModernApi.Document({ id: bigInt(199), accessHash: bigInt(200), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'video/mp4', size: bigInt(1000), thumbs: [thumb], dcId: 3, attributes: [] });
  const album = new ModernApi.StoryAlbum({ albumId: 9, title: '视频相册', iconVideo: video });
  const sessionPath = path.join(os.tmpdir(), `story-album-video-cover-${randomUUID()}`);
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = () => 'me';
  driver.config = { telegram: { sessionPath } };
  driver.client = {
    getInputEntity: async () => new Api.InputPeerSelf(),
    invoke: async request => request.className === 'stories.GetAlbums'
      ? new ModernApi.stories.Albums({ hash: bigInt(1), albums: [album] }) : true,
    downloadFile: async (location, options) => {
      assert.equal(location.className, 'InputDocumentFileLocation');
      assert.equal(location.thumbSize, 'm');
      assert.equal(options.dcId, 3);
      await options.outputFile.write(Buffer.from('video-cover'));
    },
  };
  let filePath;
  try {
    assert.deepEqual(await driver.getStoryAlbums(42), [{ id: 9, title: '视频相册', coverType: 'video' }]);
    const result = await driver.downloadStoryAlbumCover(42, 9);
    filePath = result.filePath;
    assert.equal(await fs.readFile(filePath, 'utf8'), 'video-cover');
  } finally {
    if (filePath) await fs.rm(filePath, { force: true });
  }
});

test('story album and member ordering require the complete Telegram sequence', async () => {
  const calls = [];
  const album = new ModernApi.StoryAlbum({ albumId: 7, title: '精选动态' });
  const items = [1, 2, 3].map(id => new Api.StoryItem({ id, date: 100, expireDate: 200, media: new Api.MessageMediaEmpty() }));
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = () => 'me';
  driver.client = {
    getInputEntity: async () => new Api.InputPeerSelf(),
    invoke: async request => {
      calls.push(request);
      if (request.className === 'stories.GetAlbums') return new ModernApi.stories.Albums({ hash: bigInt(1), albums: [album] });
      if (request.className === 'stories.GetAlbumStories') return { count: 3, stories: items.slice(request.offset, request.offset + request.limit) };
      return true;
    },
  };
  await driver.reorderStoryAlbums(42, [7]);
  assert.ok(calls.some(call => call instanceof ModernApi.stories.ReorderAlbums && call.order[0] === 7));
  await assert.rejects(driver.reorderStoryAlbums(42, [8]), /incomplete or stale/);
  await driver.moveStoryAlbumStory(42, 7, 2, -1);
  const move = calls.find(call => call instanceof ModernApi.stories.UpdateAlbum && Array.isArray(call.order));
  assert.deepEqual(move.order, [2, 1, 3]);
  await driver.moveStoryAlbumStory(42, 7, 1, 1);
  const latest = calls.filter(call => call instanceof ModernApi.stories.UpdateAlbum && Array.isArray(call.order)).at(-1);
  assert.deepEqual(latest.order, [2, 1, 3]);
  driver.client.invoke = async request => request.className === 'stories.GetAlbums'
    ? new ModernApi.stories.Albums({ hash: bigInt(1), albums: [album] })
    : { count: 3, stories: items.slice(0, 2) };
  await assert.rejects(driver.moveStoryAlbumStory(42, 7, 2, 1), /incomplete/);
});

test('story albums and their stories can be viewed for other peers while album writes stay owner-only', async () => {
  const peer = new Api.InputPeerUser({ userId: bigInt(7), accessHash: bigInt(70) });
  const album = new ModernApi.StoryAlbum({ albumId: 4, title: '旅行' });
  const calls = [];
  const story = new Api.StoryItem({ id: 90, date: 100, expireDate: 200, caption: '海边', media: new Api.MessageMediaEmpty() });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 42;
  driver.resolvePeer = () => 7;
  driver.client = {
    getInputEntity: async () => peer,
    invoke: async request => {
      calls.push(request);
      if (request.className === 'stories.GetAlbums') return new ModernApi.stories.Albums({ hash: bigInt(1), albums: [album] });
      if (request.className === 'stories.GetAlbumStories') return { count: 1, stories: [story] };
      return true;
    },
  };
  assert.deepEqual(await driver.getStoryAlbums(7), [{ id: 4, title: '旅行' }]);
  assert.deepEqual(await driver.getStoryAlbumStories(7, 4), {
    stories: [{ id: 90, date: 100, expireDate: 200, caption: '海边', isPinned: false,
      mediaType: 'unknown', sentReaction: undefined, viewsCount: 0, reactionsCount: 0, forwardsCount: 0 }], count: 1, nextOffset: undefined,
  });
  assert.equal(calls[0].peer.className, 'InputPeerUser');
  await assert.rejects(driver.createStoryAlbum(7, '不可写入'), /current account/);
  await assert.rejects(driver.reorderStoryAlbums(7, [4]), /current account/);
});

test('story album routes validate pagination, membership edits, and current-account targets', async () => {
  const calls = [];
  const coverPath = path.join(os.tmpdir(), `story-album-route-${randomUUID()}.jpg`);
  await fs.writeFile(coverPath, Buffer.from('album-cover'));
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_story_albums') return [{ id: 7, title: '精选动态' }];
    if (action === 'get_story_album_stories') return { stories: [], count: 0 };
    if (action === 'get_story_album_cover') return { filePath: coverPath, mimeType: 'image/jpeg' };
    return { id: 8, title: '精选' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stories/albums`;
    const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${base}?chatId=0`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}?chatId=42`)).json(), [{ id: 7, title: '精选动态' }]);
    assert.deepEqual(await (await fetch(`${base}?chatId=-10042`)).json(), [{ id: 7, title: '精选动态' }]);
    const coverUrl = base.replace('/stories/albums', '/story-album-cover');
    assert.equal((await fetch(`${coverUrl}?chatId=42&albumId=0`)).status, 400);
    const coverResponse = await fetch(`${coverUrl}?chatId=42&albumId=7`);
    assert.equal(coverResponse.headers.get('content-type'), 'image/jpeg');
    assert.equal(coverResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(await coverResponse.text(), 'album-cover');
    assert.equal((await fetch(`${base}/stories?chatId=42&albumId=7&offset=-1`)).status, 400);
    assert.deepEqual(await (await fetch(`${base}/stories?chatId=42&albumId=7&offset=0&limit=20`)).json(), { stories: [], count: 0 });
    assert.equal((await post(base, { chatId: 42, title: '相册', storyIds: [9, 9] })).status, 400);
    assert.deepEqual(await (await post(base, { chatId: 42, title: '回忆', storyIds: [9, 10] })).json(), { id: 8, title: '精选' });
    assert.equal((await post(`${base}/edit`, { chatId: 42, albumId: 7, update: {} })).status, 400);
    assert.equal((await post(`${base}/edit`, { chatId: 42, albumId: 7, update: { addStoryIds: [9], removeStoryIds: [9] } })).status, 400);
    assert.deepEqual(await (await post(`${base}/edit`, { chatId: 42, albumId: 7, update: { title: '精选' } })).json(), { id: 8, title: '精选' });
    assert.equal((await post(`${base}/order`, { chatId: 42, albumIds: [7, 7] })).status, 400);
    assert.deepEqual(await (await post(`${base}/order`, { chatId: 42, albumIds: [7, 8] })).json(), { success: true });
    assert.equal((await post(`${base}/stories/order`, { chatId: 42, albumId: 7, storyId: 9, delta: 0 })).status, 400);
    assert.deepEqual(await (await post(`${base}/stories/order`, { chatId: 42, albumId: 7, storyId: 9, delta: -1 })).json(), { success: true });
    assert.equal((await post(base, { chatId: 42, albumId: 7 }, 'DELETE')).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_story_albums', payload: { chatId: 42 } },
      { action: 'get_story_albums', payload: { chatId: -10042 } },
      { action: 'get_story_album_cover', payload: { chatId: 42, albumId: 7 } },
      { action: 'get_story_album_stories', payload: { chatId: 42, albumId: 7, offset: 0, limit: 20 } },
      { action: 'create_story_album', payload: { chatId: 42, title: '回忆', storyIds: [9, 10] } },
      { action: 'update_story_album', payload: { chatId: 42, albumId: 7, update: { title: '精选' } } },
      { action: 'reorder_story_albums', payload: { chatId: 42, albumIds: [7, 8] } },
      { action: 'move_story_album_story', payload: { chatId: 42, albumId: 7, storyId: 9, delta: -1 } },
      { action: 'delete_story_album', payload: { chatId: 42, albumId: 7 } },
    ]);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(coverPath, { force: true });
  }
});

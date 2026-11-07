'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('group photo uploads use the correct Telegram edit method for groups and channels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-group-photo-'));
  const filePath = path.join(directory, 'photo.png');
  fs.writeFileSync(filePath, Buffer.from('image-bytes'));
  try {
    const calls = [];
    const driver = Object.create(TelegramDriver.prototype);
    driver.resolvePeer = chatId => chatId === -42
      ? new Api.InputPeerChat({ chatId: bigInt(42) })
      : new Api.InputPeerChannel({ channelId: bigInt(84), accessHash: bigInt(7) });
    driver.client = {
      uploadFile: async () => new Api.InputFile({ id: bigInt(1), parts: 1, name: 'photo.png', md5Checksum: '' }),
      getInputEntity: async peer => peer,
      invoke: async request => { calls.push(request); return {}; },
    };
    await driver.setChatPhoto(-42, filePath, 'photo.png');
    assert.ok(calls[0] instanceof Api.messages.EditChatPhoto);
    assert.equal(calls[0].chatId.toString(), '42');
    assert.equal(calls[0].photo.className, 'InputChatUploadedPhoto');
    await driver.setChatPhoto(-10084, filePath, 'photo.png');
    assert.ok(calls[1] instanceof Api.channels.EditPhoto);
    await assert.rejects(driver.setChatPhoto(42, filePath, 'photo.png'), /Invalid Telegram group photo/);
    assert.equal(calls.length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('group photo HTTP upload validates image metadata and cleans the staged stream', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? {
    getInfo: () => ({ pid: process.pid }),
    accountAction: async (...args) => { calls.push(args); assert.equal(fs.existsSync(args[1].uploadPath), true); },
  } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/chat-photo`;
    const send = metadata => {
      const json = Buffer.from(JSON.stringify(metadata));
      const header = Buffer.alloc(4); header.writeUInt32BE(json.length);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
        body: Buffer.concat([header, json, Buffer.from('image')]) });
    };
    assert.equal((await send({ chatId: -42, fileName: 'group.png', mimeType: 'image/png' })).status, 200);
    assert.equal((await send({ chatId: -42, fileName: 'group.svg', mimeType: 'image/svg+xml' })).status, 400);
    assert.equal((await send({ chatId: 42, fileName: 'group.png', mimeType: 'image/png' })).status, 400);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(calls[0][1].uploadPath), false);
    assert.deepEqual(calls[0][0], 'set_chat_photo');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element { constructor() { this.style = {}; this.textContent = ''; this.value = ''; this.files = []; } }

test('group photo UI uploads only for the active profile and refreshes its avatar', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function uploadGroupPhoto(event) {');
  const end = source.indexOf('\nfunction isCurrentGroupInfoTarget(', start);
  assert.ok(start >= 0 && end > start);
  const ids = ['group-photo-status', 'profile-hero-img', 'client-chat-avatar-img'];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const profile = { type: 'supergroup', hasPhoto: false };
  const file = { size: 50, type: 'image/png', name: 'photo.png' };
  const input = new Element(); input.files = [file]; input.value = 'chosen';
  const uploads = [], refreshed = [];
  const context = vm.createContext({
    state: { clientSelectedInstance: 'a', clientActiveChatId: -10042, chatSelectionVersion: 5,
      currentProfileChatId: -10042, currentPeerProfile: profile, clientActiveDialog: { id: -10042 } },
    document: { getElementById: id => id === 'group-photo-file' ? input : elements.get(id) || null },
    encodeURIComponent, Date, Number, String, Boolean,
    sendMediaStream: async (...args) => { uploads.push(args); args[3]('upload', 100); },
    scheduler: { loadImage: async (element, url) => { refreshed.push(url); element.src = url; return true; } },
    loadUserPhotos: async () => {}, showToast() {},
  });
  vm.runInContext(`${source.slice(start, end)} this.upload = uploadGroupPhoto;`, context);
  await context.upload({ target: input });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][0], '/api/instances/a/account/chat-photo');
  assert.deepEqual(JSON.parse(JSON.stringify(uploads[0][2])), { chatId: -10042, fileName: 'photo.png', mimeType: 'image/png' });
  assert.equal(profile.hasPhoto, true);
  assert.match(elements.get('profile-hero-img').src, /isBig=1&v=/);
  assert.equal(refreshed.length, 1);
  assert.equal(input.value, '');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('editing Telegram media rechecks ownership and replaces only the selected message media and caption', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-media-edit-'));
  const filePath = path.join(tempDir, 'replacement.png');
  fs.writeFileSync(filePath, Buffer.from('file-bytes'));
  const peer = 77n;
  const calls = [];
  const uploaded = new Api.InputFile({ id: bigInt(123), parts: 1, name: 'replacement.png', md5Checksum: '' });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getMessages: async (requestedPeer, options) => {
      assert.equal(requestedPeer, peer); assert.deepEqual(options.ids, [55]);
      return [{ id: 55, out: true, media: { className: 'MessageMediaDocument' } }];
    },
    uploadFile: async options => { assert.equal(options.workers, 1); return uploaded; },
    invoke: async request => { calls.push(request); return { updates: [] }; },
  };
  try {
    await driver.replaceMessageMedia(77, 55, filePath, 'replacement.png', 'image/png', '**new caption**', 'markdown');
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Api.messages.EditMessage);
    assert.equal(calls[0].id, 55);
    assert.equal(calls[0].media.className, 'InputMediaUploadedPhoto');
    assert.equal(calls[0].media.file, uploaded);
    assert.equal(calls[0].message, 'new caption');
    assert.equal(calls[0].entities[0].className, 'MessageEntityBold');

    driver.client.getMessages = async () => [{ id: 55, out: false, media: { className: 'MessageMediaPhoto' } }];
    await assert.rejects(driver.replaceMessageMedia(77, 55, filePath, 'replacement.png', 'image/png'), /不支持替换/);
    driver.client.getMessages = async () => [{ id: 55, out: true, media: { className: 'MessageMediaPoll' } }];
    await assert.rejects(driver.replaceMessageMedia(77, 55, filePath, 'replacement.png', 'image/png'), /不支持替换/);
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test('message media replacement streams an attachment, validates metadata and cleans the staged file', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? {
    getInfo: () => ({ pid: process.pid }),
    accountAction: async (action, payload) => calls.push({ action, payload, existsDuringSend: fs.existsSync(payload.uploadPath) }),
  } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/message/media/replace`;
    const send = metadata => {
      const encoded = Buffer.from(JSON.stringify(metadata));
      const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
      return fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
        body: Buffer.concat([length, encoded, Buffer.from('replacement-bytes')]) });
    };
    assert.equal((await send({ chatId: 0, messageId: 55, fileName: 'new.jpg', mimeType: 'image/jpeg' })).status, 400);
    assert.equal((await send({ chatId: 77, messageId: 0, fileName: 'new.jpg', mimeType: 'image/jpeg' })).status, 400);
    const response = await send({ chatId: 77, messageId: 55, fileName: 'new.jpg', mimeType: 'image/jpeg', caption: 'edited', parseMode: 'markdown' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'replace_message_media');
    assert.deepEqual({ chatId: calls[0].payload.chatId, messageId: calls[0].payload.messageId,
      fileName: calls[0].payload.fileName, mimeType: calls[0].payload.mimeType, caption: calls[0].payload.caption,
      parseMode: calls[0].payload.parseMode, existsDuringSend: calls[0].existsDuringSend }, {
      chatId: 77, messageId: 55, fileName: 'new.jpg', mimeType: 'image/jpeg', caption: 'edited',
      parseMode: 'markdown', existsDuringSend: true,
    });
    assert.equal(fs.existsSync(calls[0].payload.uploadPath), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('message menu offers media replacement only for editable outgoing media', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  assert.match(source, /menu-action-replace-media/);
  assert.match(source, /\['photo', 'video', 'audio', 'voice', 'document', 'animation'\]\.includes\(mediaType\)/);
  assert.match(source, /target\.chatId, messageId: target\.id, fileName: file\.name/);
});

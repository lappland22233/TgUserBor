'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram notification exceptions map scoped peers and returned mute settings', async () => {
  const user = new Api.User({ id: bigInt(42), firstName: 'Alice', lastName: 'Example', username: 'alice' });
  const channel = new Api.Channel({ id: bigInt(456), title: 'News', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true });
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async value => {
    request = value;
    return new Api.Updates({
      updates: [
        new Api.UpdateNotifySettings({
          peer: new Api.NotifyPeer({ peer: new Api.PeerUser({ userId: bigInt(42) }) }),
          notifySettings: new Api.PeerNotifySettings({ muteUntil: 2147483647, showPreviews: false, silent: true,
            storiesMuted: true, storiesHideSender: true, storiesOtherSound: new Api.NotificationSoundRingtone({ id: bigInt(88) }) }),
        }),
        new Api.UpdateNotifySettings({
          peer: new Api.NotifyPeer({ peer: new Api.PeerChannel({ channelId: bigInt(456) }) }),
          notifySettings: new Api.PeerNotifySettings({ muteUntil: 0, showPreviews: true, silent: false }),
        }),
      ], users: [user], chats: [channel], date: 1, seq: 1,
    });
  } };
  const exceptions = await driver.getAccountNotificationExceptions('groups');
  assert.equal(request.peer.className, 'InputNotifyChats');
  assert.equal(request.compareSound, true);
  assert.equal(request.compareStories, true);
  assert.deepEqual(exceptions.map(({ chatId, title, type, muted, showPreviews, silent }) => ({ chatId, title, type, muted, showPreviews, silent })), [
    { chatId: 42, title: 'Alice Example', type: 'private', muted: true, showPreviews: false, silent: true },
    { chatId: -100456, title: 'News', type: 'channel', muted: false, showPreviews: true, silent: false },
  ]);
  assert.equal(exceptions[0].storiesMuted, true);
  assert.equal(exceptions[0].storiesHideSender, true);
  assert.equal(exceptions[0].storiesSoundId, '88');
});

test('Telegram default notifications map private, group and channel categories', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.peer instanceof Api.InputNotifyUsers) return new Api.PeerNotifySettings({ muteUntil: 0, showPreviews: true, silent: false,
      storiesMuted: true, storiesHideSender: true, storiesOtherSound: new Api.NotificationSoundRingtone({ id: bigInt(88) }) });
    if (request.peer instanceof Api.InputNotifyChats) return new Api.PeerNotifySettings({ muteUntil: 2147483647, showPreviews: false, silent: true });
    return new Api.PeerNotifySettings({ muteUntil: 0, showPreviews: false, silent: false });
  } };
  const result = await driver.getAccountNotificationSettings();
  assert.deepEqual(result.map(({ key, title, showPreviews, silent }) => ({ key, title, showPreviews, silent })), [
    { key: 'private', title: '私聊', showPreviews: true, silent: false },
    { key: 'groups', title: '群组', showPreviews: false, silent: true },
    { key: 'channels', title: '频道', showPreviews: false, silent: false },
  ]);
  assert.equal(result[0].muted, false);
  assert.equal(result[1].muted, true);
  assert.equal(result[0].storiesMuted, true);
  assert.equal(result[0].storiesHideSender, true);
  assert.equal(result[0].storiesSoundId, '88');
  assert.deepEqual(calls.map(call => call.peer.className), ['InputNotifyUsers', 'InputNotifyChats', 'InputNotifyBroadcasts']);
});

test('Telegram notification sounds expose defaults and saved ringtones', async () => {
  const ringtone = new Api.Document({ id: bigInt(77), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'audio/ogg', size: bigInt(2048), dcId: 2, attributes: [new Api.DocumentAttributeFilename({ fileName: 'Soft bell.ogg' })] });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    assert.ok(request instanceof Api.account.GetSavedRingtones);
    return new Api.account.SavedRingtones({ hash: bigInt(1), ringtones: [ringtone] });
  } };
  assert.deepEqual(await driver.getAccountNotificationSounds(), [
    { id: 'default', title: '默认提示音' }, { id: 'none', title: '无提示音' }, { id: '77', title: 'Soft bell' },
  ]);
  await assert.rejects(driver.downloadAccountNotificationSound('0'), /Invalid Telegram notification sound/);
});

test('saved Telegram notification sound preview downloads into an account-isolated cache', async () => {
  const soundId = '7788990011';
  const document = new Api.Document({ id: bigInt(soundId), accessHash: bigInt(-55), fileReference: Buffer.from([1, 2, 3]),
    date: 1, mimeType: 'audio/ogg', size: bigInt(8), dcId: 2, attributes: [] });
  let location;
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 9912345;
  driver.config = { telegram: { sessionPath: '/tmp/test-notification-sounds.session' } };
  driver.client = {
    invoke: async request => {
      assert.ok(request instanceof Api.account.GetSavedRingtones);
      return new Api.account.SavedRingtones({ hash: bigInt(1), ringtones: [document] });
    },
    downloadFile: async (fileLocation, { outputFile }) => {
      location = fileLocation;
      await outputFile.write(Buffer.from('OggS1234'));
    },
  };
  const preview = await driver.downloadAccountNotificationSound(soundId);
  try {
    assert.equal(preview.mimeType, 'audio/ogg');
    assert.ok(location instanceof Api.InputDocumentFileLocation);
    assert.equal(String(location.id), soundId);
    assert.equal(String(location.accessHash), '-55');
    assert.equal(fs.readFileSync(preview.filePath, 'utf8'), 'OggS1234');
    assert.match(path.dirname(preview.filePath), /cache[\\/]ringtones$/);
  } finally { if (preview?.filePath) fs.rmSync(preview.filePath, { force: true }); }
});

test('Telegram notification sounds upload as ringtones and can be removed from the saved list', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tg-ringtone-'));
  const filePath = path.join(root, 'bell.ogg'); fs.writeFileSync(filePath, Buffer.from('OggS1234'));
  const document = new Api.Document({ id: bigInt(771), accessHash: bigInt(-88), fileReference: Buffer.from('ref'), date: 1,
    mimeType: 'audio/ogg', size: bigInt(8), dcId: 2, attributes: [] });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    uploadFile: async ({ file }) => { assert.equal(file.name, 'bell.ogg'); return { className: 'InputFile' }; },
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.account.UploadRingtone) return document;
      if (request instanceof Api.account.GetSavedRingtones) return new Api.account.SavedRingtones({ hash: bigInt(1), ringtones: [document] });
      if (request instanceof Api.account.SaveRingtone) return new Api.account.SavedRingtone();
      throw new Error(`Unexpected ${request.className}`);
    },
  };
  try {
    await driver.uploadAccountNotificationSound(filePath, '../bell.ogg', 'audio/ogg');
    await driver.removeAccountNotificationSound('771');
    assert.ok(calls[0] instanceof Api.account.UploadRingtone);
    assert.equal(calls[0].fileName, 'bell.ogg');
    assert.equal(calls[0].mimeType, 'audio/ogg');
    assert.ok(calls[1] instanceof Api.account.GetSavedRingtones);
    assert.ok(calls[2] instanceof Api.account.SaveRingtone);
    assert.equal(calls[2].unsave, true);
    assert.equal(String(calls[2].id.id), '771');
    await assert.rejects(driver.uploadAccountNotificationSound(filePath, 'bell.ogg', 'application/octet-stream'), /Invalid Telegram notification sound upload/);
    await assert.rejects(driver.removeAccountNotificationSound('0'), /Invalid Telegram notification sound/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Telegram notification updates preserve future mute deadlines and send only requested fields', async () => {
  const calls = [];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return request instanceof Api.account.GetNotifySettings
      ? new Api.PeerNotifySettings({ muteUntil: deadline, showPreviews: true, silent: false }) : true;
  } };
  await driver.setAccountNotificationSettings('private', { muted: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof Api.account.GetNotifySettings);
  assert.ok(calls[1] instanceof Api.account.UpdateNotifySettings);
  assert.equal(calls[1].peer.className, 'InputNotifyUsers');
  assert.equal(calls[1].settings.muteUntil, deadline);
  assert.equal(calls[1].settings.showPreviews, undefined);
  calls.length = 0;
  await driver.setAccountNotificationSettings('groups', { showPreviews: false, silent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].peer.className, 'InputNotifyChats');
  assert.equal(calls[0].settings.showPreviews, false);
  assert.equal(calls[0].settings.silent, true);
  calls.length = 0;
  await driver.setAccountNotificationSettings('channels', { soundId: 'none' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.sound.className, 'NotificationSoundNone');
  await driver.setAccountNotificationSettings('channels', { soundId: '0' }).then(
    () => assert.fail('zero sound IDs must be rejected'), error => assert.match(error.message, /Invalid Telegram notification sound/));
  calls.length = 0;
  await driver.setAccountNotificationSettings('groups', { storiesMuted: true, storiesHideSender: true, storiesSoundId: 'none' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.storiesMuted, true);
  assert.equal(calls[0].settings.storiesHideSender, true);
  assert.equal(calls[0].settings.storiesSound.className, 'NotificationSoundNone');
  calls.length = 0;
  await driver.setAccountNotificationSettings('private', { muteUntil: 123456 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.muteUntil, 123456);
  await assert.rejects(driver.setAccountNotificationSettings('private', { muted: true, muteUntil: 123456 }), /Invalid/);
  await assert.rejects(driver.setAccountNotificationSettings('unknown', { muted: true }), /Unsupported/);
  await assert.rejects(driver.setAccountNotificationSettings('private', { muted: 'yes' }), /Invalid/);
});

test('per-chat notification exceptions resolve Telegram peers and write only selected fields', async () => {
  const calls = [];
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const inputPeer = new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(99) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 7;
  driver.client = {
    getInputEntity: async peer => { assert.ok(peer === 42n || peer === -100456n); return inputPeer; },
    invoke: async request => {
      calls.push(request);
      return request instanceof Api.account.GetNotifySettings
        ? new Api.PeerNotifySettings({ muteUntil: deadline, showPreviews: true, silent: false }) : true;
    },
  };
  await driver.setAccountNotificationException(42, { muted: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof Api.account.GetNotifySettings);
  assert.ok(calls[0].peer instanceof Api.InputNotifyPeer);
  assert.equal(calls[0].peer.peer, inputPeer);
  assert.equal(calls[1].peer.peer, inputPeer);
  assert.equal(calls[1].settings.muteUntil, deadline);
  assert.equal(calls[1].settings.showPreviews, undefined);
  calls.length = 0;
  await driver.setAccountNotificationException(-100456, { showPreviews: false, silent: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.account.UpdateNotifySettings);
  assert.equal(calls[0].peer.peer, inputPeer);
  assert.equal(calls[0].settings.showPreviews, false);
  assert.equal(calls[0].settings.silent, true);
  calls.length = 0;
  await driver.setAccountNotificationException(42, { soundId: '77' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.sound.className, 'NotificationSoundRingtone');
  assert.equal(String(calls[0].settings.sound.id), '77');
  calls.length = 0;
  await driver.setAccountNotificationException(42, { storiesMuted: true, storiesHideSender: true, storiesSoundId: 'none' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.storiesMuted, true);
  assert.equal(calls[0].settings.storiesHideSender, true);
  assert.equal(calls[0].settings.storiesSound.className, 'NotificationSoundNone');
  calls.length = 0;
  await driver.setAccountNotificationException(42, { muteUntil: 123456 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.muteUntil, 123456);
  await assert.rejects(driver.setAccountNotificationException(7, { muted: true }), /Invalid Telegram notification exception/);
  await assert.rejects(driver.setAccountNotificationException(42, { muted: 'yes' }), /Invalid Telegram notification exception/);
  assert.equal(calls.length, 1);
});

test('Telegram notification routes validate categories and dispatch only the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_account_notification_settings' ? [{ key: 'private', muted: false }] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-settings`;
    assert.equal((await fetch(url)).status, 200);
    const soundsUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-sounds`;
    assert.equal((await fetch(soundsUrl)).status, 200);
    const previewUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-sound-preview`;
    assert.equal((await fetch(`${previewUrl}?soundId=0`)).status, 400);
    assert.equal((await fetch(`${previewUrl}?soundId=77`)).status, 404);
    const exceptionUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-exceptions`;
    assert.equal((await fetch(`${exceptionUrl}?key=private`)).status, 200);
    assert.equal((await fetch(`${exceptionUrl}?key=unknown`)).status, 400);
    const postException = body => fetch(exceptionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await postException({ key: 'private', chatId: 42, muted: 'yes' })).status, 400);
    assert.equal((await postException({ key: 'private', chatId: 42, soundId: 'invalid' })).status, 400);
    assert.equal((await postException({ key: 'private', chatId: 42, showPreviews: false })).status, 200);
    assert.equal((await postException({ key: 'private', chatId: 42, soundId: 'none' })).status, 200);
    assert.equal((await postException({ key: 'private', chatId: 42, storiesMuted: true, storiesHideSender: true, storiesSoundId: 'none' })).status, 200);
    const muteUntil = Math.floor(Date.now() / 1000) + 3600;
    assert.equal((await postException({ key: 'private', chatId: 42, muteUntil })).status, 200);
    assert.equal((await postException({ key: 'private', chatId: 42, muteUntil: -1 })).status, 400);
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ key: 'all', muted: true })).status, 400);
    assert.equal((await post({ key: 'private', muted: 'yes' })).status, 400);
    assert.equal((await post({ key: 'private', soundId: '9223372036854775808' })).status, 400);
    assert.equal((await post({ key: 'private', soundId: '77' })).status, 200);
    assert.equal((await post({ key: 'private', storiesMuted: true, storiesHideSender: false, storiesSoundId: 'none' })).status, 200);
    const categoryMuteUntil = Math.floor(Date.now() / 1000) + 28800;
    assert.equal((await post({ key: 'private', muteUntil: categoryMuteUntil })).status, 200);
    assert.equal((await post({ key: 'private', muted: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_account_notification_settings', payload: undefined },
      { action: 'get_account_notification_sounds', payload: undefined },
      { action: 'get_account_notification_sound_preview', payload: { soundId: '77' } },
      { action: 'get_account_notification_exceptions', payload: { key: 'private' } },
      { action: 'set_account_notification_exception', payload: { chatId: 42, showPreviews: false } },
      { action: 'set_account_notification_exception', payload: { chatId: 42, soundId: 'none' } },
      { action: 'set_account_notification_exception', payload: { chatId: 42, storiesMuted: true, storiesHideSender: true, storiesSoundId: 'none' } },
      { action: 'set_account_notification_exception', payload: { chatId: 42, muteUntil } },
      { action: 'set_account_notification_settings', payload: { key: 'private', soundId: '77' } },
      { action: 'set_account_notification_settings', payload: { key: 'private', storiesMuted: true, storiesHideSender: false, storiesSoundId: 'none' } },
      { action: 'set_account_notification_settings', payload: { key: 'private', muteUntil: categoryMuteUntil } },
      { action: 'set_account_notification_settings', payload: { key: 'private', muted: true } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('notification sound upload streams bounded audio and removal targets only saved Telegram sounds', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? {
    getInfo: () => ({ pid: process.pid }),
    accountAction: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'upload_account_notification_sound') assert.equal(fs.readFileSync(payload.uploadPath, 'utf8'), 'OggS1234');
    },
  } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const streamBody = (fileName, mimeType, bytes) => {
    const metadata = Buffer.from(JSON.stringify({ fileName, mimeType }));
    const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
    return Buffer.concat([length, metadata, bytes]);
  };
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-sounds`;
    const upload = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
      body: streamBody('bell.ogg', 'audio/ogg', Buffer.from('OggS1234')) });
    assert.equal(upload.status, 200);
    assert.equal(calls[0].action, 'upload_account_notification_sound');
    assert.equal(calls[0].payload.fileName, 'bell.ogg');
    assert.equal(fs.existsSync(calls[0].payload.uploadPath), false);
    const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
      body: streamBody('bell.ogg', 'application/octet-stream', Buffer.from('OggS1234')) });
    assert.equal(invalid.status, 400);
    const tooLarge = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/vnd.tguserbot.media-stream' },
      body: streamBody('large.ogg', 'audio/ogg', Buffer.alloc(5 * 1024 * 1024 + 1)) });
    assert.equal(tooLarge.status, 413);
    const removeUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/notification-sounds/remove`;
    assert.equal((await fetch(removeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ soundId: '771' }) })).status, 200);
    assert.equal((await fetch(removeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ soundId: '0' }) })).status, 400);
    assert.equal(calls[1].action, 'remove_account_notification_sound');
    assert.deepEqual(calls[1].payload, { soundId: '771' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function paidMessage(chatId = 42, messageId = 9) {
  return new Api.Message({ id: messageId, peerId: new Api.PeerUser({ userId: bigInt(chatId) }), date: 1,
    message: 'Locked content', media: new Api.MessageMediaPaidMedia({ starsAmount: bigInt(17),
      extendedMedia: [new Api.MessageExtendedMediaPreview({ w: 320, h: 240 })] }) });
}

test('paid-media Stars checkout is a short-lived one-use Telegram payment form bound to one message', async () => {
  const message = paidMessage();
  const inputPeer = new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) });
  const invoice = new Api.Invoice({ currency: 'XTR', prices: [new Api.LabeledPrice({ label: 'Media', amount: bigInt(17) })] });
  const form = new Api.payments.PaymentFormStars({ formId: bigInt(13), botId: bigInt(55), title: 'Paid media',
    description: 'Unlock message', invoice, users: [] });
  const paymentResult = Object.create(Api.payments.PaymentResult.prototype);
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.pendingPaidMediaPayments = new Map();
  driver.resolvePeer = id => { assert.equal(id, 42); return 42n; };
  driver.client = {
    getMessages: async (peer, options) => { assert.equal(peer, 42n); assert.deepEqual(options, { ids: [9] }); return [message]; },
    getInputEntity: async peer => { assert.equal(peer, 42n); return inputPeer; },
    invoke: async request => { calls.push(request); return request instanceof Api.payments.GetPaymentForm ? form : paymentResult; },
  };
  const prepared = await driver.prepareChatPaidMediaPayment(42, 9);
  assert.deepEqual({ stars: prepared.stars, itemCount: prepared.itemCount, title: prepared.title },
    { stars: '17', itemCount: 1, title: 'Paid media' });
  assert.match(prepared.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(calls[0] instanceof Api.payments.GetPaymentForm);
  assert.ok(calls[0].invoice instanceof Api.InputInvoiceMessage);
  assert.equal(calls[0].invoice.msgId, 9);
  await assert.rejects(driver.confirmChatPaidMediaPayment(prepared.token, 42, 10), /expired or does not match/);
  assert.deepEqual(await driver.confirmChatPaidMediaPayment(prepared.token, 42, 9), { stars: '17' });
  assert.ok(calls[1] instanceof Api.payments.SendStarsForm);
  assert.equal(calls[1].formId.toString(), '13');
  await assert.rejects(driver.confirmChatPaidMediaPayment(prepared.token, 42, 9), /expired or does not match/);
  await assert.rejects(driver.prepareChatPaidMediaPayment(42, 0), /Invalid paid media target/);
  assert.equal(calls.length, 2);
});

test('paid-media download selects only an unlocked extended media item', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-paid-media-'));
  try {
    const document = new Api.Document({ id: bigInt(91), accessHash: bigInt(92), fileReference: Buffer.alloc(0), date: 1,
      mimeType: 'image/jpeg', size: bigInt(5), dcId: 2, attributes: [] });
    const message = new Api.Message({ id: 9, peerId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: '',
      media: new Api.MessageMediaPaidMedia({ starsAmount: bigInt(17), extendedMedia: [
        new Api.MessageExtendedMedia({ media: new Api.MessageMediaDocument({ document }) }),
      ] }) });
    const output = path.join(root, 'paid.jpg');
    const driver = Object.create(TelegramDriver.prototype);
    driver.logger = { debug() {} };
    driver.client = { getMessages: async () => [message], downloadMedia: async (media, options) => {
      assert.equal(media.document.id.toString(), '91');
      options.outputFile.write(Buffer.from('paid!'));
    } };
    const result = await driver.downloadMediaFile(42, 9, false, output, 0);
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(await fs.readFile(output, 'utf8'), 'paid!');
    assert.equal(await driver.downloadMediaFile(42, 9, false, path.join(root, 'locked.jpg'), 1), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('paid-media payment routes validate the message and dispatch only to its selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'prepare_chat_paid_media'
      ? { token: 'x'.repeat(32), stars: '17', itemCount: 2, title: 'Unlock', description: 'Private media' }
      : { stars: '17' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/paid-media`;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(`${base}/prepare`, { chatId: 0, messageId: 9 })).status, 400);
    const prepared = await post(`${base}/prepare`, { chatId: -10042, messageId: 9 });
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), { token: 'x'.repeat(32), stars: '17', itemCount: 2, title: 'Unlock', description: 'Private media' });
    assert.equal((await post(`${base}/confirm`, { chatId: -10042, messageId: 9, token: 'short' })).status, 400);
    const confirmed = await post(`${base}/confirm`, { chatId: -10042, messageId: 9, token: 'x'.repeat(32) });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { stars: '17' });
    assert.deepEqual(calls, [
      { action: 'prepare_chat_paid_media', payload: { chatId: -10042, messageId: 9 } },
      { action: 'confirm_chat_paid_media', payload: { chatId: -10042, messageId: 9, token: 'x'.repeat(32) } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('paid-media publishing wraps uploaded album items in one SendMedia request after Telegram permission check', async () => {
  const uploads = require('telegram/client/uploads');
  const originalSendAlbum = uploads._sendAlbum;
  const peer = new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(1) });
  const channel = new Api.Channel({ id: bigInt(42), title: 'Broadcast', photo: new Api.ChatPhotoEmpty(), date: 1,
    accessHash: bigInt(1), broadcast: true });
  const fullChat = Object.create(Api.ChannelFull.prototype);
  fullChat.paidMediaAllowed = true;
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => { assert.equal(id, -10042); return -10042n; };
  driver.client = {
    getEntity: async () => channel,
    getInputEntity: async () => peer,
    invoke: async request => { calls.push(request); if (request instanceof Api.channels.GetFullChannel) return { fullChat }; return {}; },
  };
  uploads._sendAlbum = async (client, inputPeer, options) => {
    const image = new Api.InputMediaPhoto({ id: new Api.InputPhoto({ id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0) }) });
    const videoFile = new Api.InputFile({ id: bigInt(3), parts: 1, name: 'video.mp4', md5Checksum: '' });
    const video = new Api.InputMediaUploadedDocument({ file: videoFile, mimeType: 'video/mp4', attributes: [new Api.DocumentAttributeVideo({ duration: 2, w: 320, h: 240 })] });
    await client.invoke(new Api.messages.SendMultiMedia({ peer: inputPeer, silent: options.silent, scheduleDate: options.scheduleDate,
      multiMedia: [new Api.InputSingleMedia({ media: image, randomId: bigInt(5), message: options.caption }),
        new Api.InputSingleMedia({ media: video, randomId: bigInt(6), message: '' })] }));
    return [{ id: 99 }];
  };
  try {
    const sentId = await driver.sendMediaAlbum(-10042, ['/tmp/photo.jpg', '/tmp/video.mp4'], {
      paidStars: 20, caption: 'Exclusive', silent: true, schedule: 1700000000, invertMedia: true,
    });
    assert.equal(sentId, 99);
    const request = calls.find(item => item instanceof Api.messages.SendMedia);
    assert.ok(request);
    assert.ok(request.media instanceof Api.InputMediaPaidMedia);
    assert.equal(request.media.starsAmount.toString(), '20');
    assert.equal(request.media.extendedMedia.length, 2);
    assert.equal(request.message, 'Exclusive');
    assert.equal(request.invertMedia, true);
    assert.equal(request.silent, true);
    assert.equal(request.scheduleDate, 1700000000);
    assert.equal(calls.filter(item => item instanceof Api.channels.GetFullChannel).length, 1);
    await assert.rejects(driver.sendMediaAlbum(-10042, ['/tmp/readme.txt'], { paidStars: 20 }), /照片和视频/);
  } finally { uploads._sendAlbum = originalSendAlbum; }
});

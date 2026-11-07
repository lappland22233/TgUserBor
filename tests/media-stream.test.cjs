'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { iterDownload } = require('telegram/client/downloads');
const { getMediaStreamInfo, getMediaStreamChunk, MEDIA_STREAM_CHUNK_BYTES } = require('../dist/bot/driver/media-stream');
const { handleApiRoute } = require('../dist/gui/api');

const content = Buffer.from(Array.from({ length: 1_000_000 }, (_, i) => i % 251));
function actualIteratorClient() {
  const doc = new Api.Document({ id: bigInt(321), accessHash: bigInt(2), fileReference: Buffer.from('ref'), date: 1,
    mimeType: 'video/mp4', size: bigInt(content.length), dcId: 2, attributes: [] });
  const media = new Api.MessageMediaDocument({ document: doc });
  const sender = { dcId: 2 };
  const client = { _log: { info() {}, debug() {}, warn() {} }, getSender: async () => sender,
    getMessages: async () => [{ media }],
    invokeWithSender: async request => ({ bytes: content.subarray(request.offset.toJSNumber(), request.offset.toJSNumber() + request.limit) }),
  };
  client.iterDownload = params => iterDownload(client, params);
  return client;
}

test('real GramJS iterator returns exact bounded bytes at unaligned offsets and EOF', async () => {
  const client = actualIteratorClient();
  const info = await getMediaStreamInfo(client, 5, 10, 123);
  assert.equal(info.size, content.length);
  for (const offset of [0, 1, 4095, 4096, 262143, 524287, 524288, 999999]) {
    const length = Math.min(MEDIA_STREAM_CHUNK_BYTES, content.length - offset);
    assert.deepEqual(await getMediaStreamChunk(client, 5, 10, 123, info, offset, length), content.subarray(offset, offset + length));
  }
  await assert.rejects(getMediaStreamChunk(client, 5, 10, 124, info, 0, 10), /Invalid/);
  await assert.rejects(getMediaStreamChunk(client, 5, 10, 123, { ...info, documentId: 'other' }, 0, 10), /changed/);
  await assert.rejects(getMediaStreamChunk(client, 5, 10, 123, info, 0, MEDIA_STREAM_CHUNK_BYTES + 1), /Invalid/);
});

test('paid-media video streams keep the unlocked item index bound to the Telegram document', async () => {
  const doc = new Api.Document({ id: bigInt(654), accessHash: bigInt(2), fileReference: Buffer.from('paid'), date: 1,
    mimeType: 'video/mp4', size: bigInt(content.length), dcId: 2, attributes: [] });
  const media = new Api.MessageMediaDocument({ document: doc });
  const container = new Api.MessageMediaPaidMedia({ starsAmount: bigInt(10), extendedMedia: [
    new Api.MessageExtendedMediaPreview({ w: 320, h: 240 }), new Api.MessageExtendedMedia({ media }),
  ] });
  const client = { _log: { info() {}, debug() {}, warn() {} }, getSender: async () => ({ dcId: 2 }),
    getMessages: async () => [{ media: container }],
    invokeWithSender: async request => ({ bytes: content.subarray(request.offset.toJSNumber(), request.offset.toJSNumber() + request.limit) }) };
  client.iterDownload = params => iterDownload(client, params);
  const info = await getMediaStreamInfo(client, 5, 10, 123, 1);
  assert.equal(info.documentId, '654');
  assert.equal(info.mediaIndex, 1);
  assert.deepEqual(await getMediaStreamChunk(client, 5, 10, 123, info, 7, 100), content.subarray(7, 107));
  assert.equal(await getMediaStreamInfo(client, 5, 10, 123, 0), undefined);
});

test('HTTP playable media uses exact ranges and returns 416 without downloading a full file', async () => {
  const info = { accountId: 1, documentId: '321', size: content.length, mimeType: 'video/mp4' };
  const calls = [];
  const inst = { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_media_stream_info') return info;
    if (action === 'get_media_stream_chunk') return { base64: content.subarray(payload.offset, payload.offset + payload.length).toString('base64') };
    throw new Error(`Unexpected action ${action}`);
  }};
  const server = http.createServer((req, res) => { handleApiRoute(req, res, { getInstance: () => inst }, '').catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/media?chatId=1&messageId=2`;
    for (const [header, start, end] of [['bytes=123-456', 123, 456], ['bytes=-9', content.length-9, content.length-1], ['bytes=999999-', 999999, 999999]]) {
      const response = await fetch(url, { headers: { Range: header } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${content.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(start, end + 1));
    }
    const before = calls.filter(call => call.action === 'get_media_stream_chunk').length;
    const bad = await fetch(url, { headers: { Range: `bytes=${content.length}-` } });
    assert.equal(bad.status, 416);
    assert.equal(calls.filter(call => call.action === 'get_media_stream_chunk').length, before);
    assert.ok(calls.every(call => call.action !== 'get_message_media'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('media index is forwarded to Telegram and malformed paid-media indices are rejected', async () => {
  const info = { accountId: 1, documentId: '321', size: content.length, mimeType: 'video/mp4', mediaIndex: 1 };
  const calls = [];
  const inst = { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_media_stream_info') return info;
    if (action === 'get_media_stream_chunk') return { base64: Buffer.alloc(payload.length, 7).toString('base64') };
  } };
  const server = http.createServer((req, res) => { handleApiRoute(req, res, { getInstance: () => inst }, '').catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/media?chatId=1&messageId=2`;
    const bad = await fetch(`${base}&mediaIndex=10`);
    assert.equal(bad.status, 400);
    const response = await fetch(`${base}&mediaIndex=1`, { headers: { Range: 'bytes=0-0' } });
    assert.equal(response.status, 206);
    assert.deepEqual(calls[0], { action: 'get_media_stream_info', payload: { chatId: 1, messageId: 2, mediaIndex: 1 } });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('client disconnect stops subsequent bounded pulls', async () => {
  const info = { accountId: 1, documentId: '321', size: 64 * 1024 * 1024, mimeType: 'video/mp4' };
  let chunks = 0;
  const inst = { accountAction: async (action, payload) => {
    if (action === 'get_media_stream_info') return info;
    chunks++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { base64: Buffer.alloc(payload.length).toString('base64') };
  }};
  const server = http.createServer((req, res) => { handleApiRoute(req, res, { getInstance: () => inst }, '').catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/media?chatId=1&messageId=2`;
    const response = await fetch(url);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(chunks < 10, `unexpected ${chunks} chunks after cancellation`);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function voiceMessage() {
  const document = new Api.Document({
    id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'audio/ogg', size: bigInt(12), dcId: 1,
    attributes: [new Api.DocumentAttributeAudio({ duration: 2, voice: true })],
  });
  return { media: new Api.MessageMediaDocument({ document }) };
}

test('Telegram voice transcription checks the message type and returns native transcript metadata', async () => {
  const calls = [];
  let message = voiceMessage();
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = {
    getMessages: async () => [message],
    invoke: async request => {
      calls.push(request);
      if (request.className === 'messages.TranscribeAudio') return {
        transcriptionId: bigInt(55), text: 'recognized words', pending: false, trialRemainsNum: 3,
      };
      return true;
    },
  };
  assert.deepEqual(await driver.transcribeVoiceMessage(-100123, 9), {
    transcriptionId: '55', text: 'recognized words', pending: false, trialRemainsNum: 3, trialRemainsUntilDate: undefined,
  });
  assert.equal(calls[0].className, 'messages.TranscribeAudio');
  assert.equal(calls[0].peer.toString(), '-100123');
  assert.equal(calls[0].msgId, 9);
  await driver.rateVoiceTranscription(-100123, 9, '55', true);
  assert.equal(calls[1].className, 'messages.RateTranscribedAudio');
  assert.equal(calls[1].transcriptionId.toString(), '55');
  assert.equal(calls[1].good, true);
  message = { media: new Api.MessageMediaDocument({ document: new Api.Document({
    id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'audio/mpeg', size: bigInt(12), dcId: 1,
    attributes: [new Api.DocumentAttributeAudio({ duration: 2, voice: false })],
  }) }) };
  await assert.rejects(driver.transcribeVoiceMessage(-100123, 9), /仅支持 Telegram 语音消息转文字/);
  assert.equal(calls.length, 2);
});

test('transcription and rating endpoints validate IDs and dispatch to the selected Telegram account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload }); return action === 'transcribe_voice_message' ? { transcriptionId: '55', text: 'words', pending: false } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/transcribe`;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(base, { chatId: 1, messageId: 0 })).status, 400);
    const response = await post(base, { chatId: -100123, messageId: 9 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transcriptionId: '55', text: 'words', pending: false });
    assert.equal((await post(`${base}/rate`, { chatId: -100123, messageId: 9, transcriptionId: 'bad', good: true })).status, 400);
    assert.equal((await post(`${base}/rate`, { chatId: -100123, messageId: 9, transcriptionId: '55', good: false })).status, 200);
    assert.deepEqual(calls, [
      { action: 'transcribe_voice_message', payload: { chatId: -100123, messageId: 9 } },
      { action: 'rate_voice_transcription', payload: { chatId: -100123, messageId: 9, transcriptionId: '55', good: false } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('voice transcript is inserted as text and feedback targets the original message', async () => {
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.handlers = {}; this.isConnected = true; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
    querySelectorAll() { return this.buttons || []; }
  }
  const container = new Element(), button = new Element(), status = new Element(), text = new Element(), rating = new Element();
  const good = new Element(), bad = new Element();
  container.nodes = { '[data-transcribe-action]': button, '[data-transcription-status]': status,
    '[data-transcription-text]': text, '[data-transcription-rating]': rating };
  rating.nodes = { '[data-transcription-good]': good, '[data-transcription-bad]': bad };
  rating.buttons = [good, bad];
  const document = { getElementById: id => id === 'voice-transcription-9' ? container : null };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 4 };
  const pending = [], toasts = [];
  const context = vm.createContext({ state, document, encodeURIComponent,
    api: (url, method, body) => new Promise(resolve => pending.push({ url, method, body, resolve })),
    showToast: message => toasts.push(message),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function voiceTranscriptionTargetIsCurrent(');
  const end = source.indexOf('\nfunction handleSendAttachment(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.transcribe = transcribeVoiceMessage;`, context);
  const transcription = context.transcribe(-100123, 9);
  assert.equal(pending[0].url, '/api/instances/a/account/transcribe');
  pending[0].resolve({ transcriptionId: '55', text: '<literal transcript>', pending: false });
  await transcription;
  assert.equal(text.textContent, '<literal transcript>');
  assert.equal(text.hidden, false);
  assert.equal(rating.hidden, false);
  good.onclick();
  assert.equal(pending[1].url, '/api/instances/a/account/transcribe/rate');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[1].body)), { chatId: -100123, messageId: 9, transcriptionId: '55', good: true });
  pending[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rating.textContent, '感谢反馈');
  assert.deepEqual(toasts, []);
});

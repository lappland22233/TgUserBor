'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const code = source.slice(source.indexOf('async function sendClientMessage('), source.indexOf('\nfunction setReplyingMessage(', source.indexOf('async function sendClientMessage(')));

function harness() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 1, clientMessages: [], clientDrafts: {}, clientParseMode: 'plain', chatSelectionVersion: 1 };
  const input = { value: 'hello' };
  const calls = [];
  const refreshes = [];
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const context = vm.createContext({ state, window: {}, pendingMediaSends: new WeakSet(), document: { getElementById: id => id === 'client-message-textarea' ? input : null },
    clientDraftKey: (chat, inst = state.clientSelectedInstance) => JSON.stringify([inst, String(chat)]),
    api: (url, method, body) => { calls.push({ url, method, body }); return promise; },
    sendMediaStream: (url, file, body) => { calls.push({ url, file, body }); return promise; },
    sendMediaAlbumStream: (url, files, body) => { calls.push({ url, files, body }); return promise; },
    autoResizeTextarea() {}, renderClientMessages() {}, renderClientDialogs() {}, cancelReplyBanner() { state.clientReplyingTo = null; }, cancelEditBanner() { state.clientEditingMessageId = null; },
    clearStagedAttachment() { state.clientStagedFile = null; }, loadClientMessages: chat => { refreshes.push(chat); }, showToast() {},
  });
  vm.runInContext(code + '\nthis.sendClientMessage = sendClientMessage;', context);
  return { state, input, calls, refreshes, resolve, reject, send: context.sendClientMessage };
}

test('attachment is sent to the original chat even if file reading completes after a switch', async () => {
  const h = harness();
  const file = { type: 'image/png', name: 'a.png' };
  h.state.clientStagedFile = file;
  h.state.clientDrafts[JSON.stringify(['a', '1'])] = 'hello';
  const complete = h.send();
  h.state.clientSelectedInstance = 'b';
  h.state.clientActiveChatId = 2;
  h.state.chatSelectionVersion++;
  h.state.clientStagedFile = { type: 'image/png', name: 'new.png' };
  h.input.value = 'new draft';
  assert.equal(h.calls[0].url, '/api/instances/a/account/send-media');
  assert.equal(h.calls[0].body.chatId, 1);
  assert.equal(h.calls[0].body.parseMode, 'plain');
  h.resolve({});
  await complete;
  assert.equal(h.input.value, 'new draft');
  assert.equal(h.state.clientStagedFile.name, 'new.png');
  assert.equal(h.refreshes.length, 0);
});

test('message result after switching chat does not alter or refresh the new chat', async () => {
  const h = harness();
  const pending = h.send();
  assert.equal(h.calls[0].body.options.parseMode, 'plain');
  h.state.clientActiveChatId = 2;
  h.state.chatSelectionVersion++;
  h.state.clientMessages = [{ id: 99, text: 'new chat' }];
  h.input.value = 'new draft';
  h.resolve({ id: 42 });
  await pending;
  assert.equal(h.state.clientMessages[0].id, 99);
  assert.equal(h.input.value, 'new draft');
  assert.equal(h.refreshes.length, 0);
});

test('selected Telegram message effect is sent once with text and cleared only after success', async () => {
  const h = harness();
  h.state.clientMessageEffectId = '123';
  const pending = h.send();
  assert.equal(h.calls[0].body.options.effectId, '123');
  h.resolve({ id: 42 });
  await pending;
  assert.equal(h.state.clientMessageEffectId, null);
});

test('selected Telegram message effect and caption position are attached to a single media send', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'image/png', name: 'photo.png' };
  h.state.clientMessageEffectId = '456';
  h.state.clientCaptionAboveMedia = true;
  const pending = h.send();
  assert.equal(h.calls[0].body.effectId, '456');
  assert.equal(h.calls[0].body.invertMedia, true);
  h.reject(new Error('upload failed'));
  await pending;
  assert.equal(h.state.clientMessageEffectId, '456');
});

test('selected Telegram message effect is attached to a media album and cleared after success', async () => {
  const h = harness();
  const files = [{ type: 'image/png', name: 'one.png', size: 10 }, { type: 'video/mp4', name: 'two.mp4', size: 20 }];
  h.state.clientStagedFile = files[0];
  h.state.clientStagedFiles = files;
  h.state.clientMessageEffectId = '789';
  h.state.clientCaptionAboveMedia = true;
  const pending = h.send();
  assert.equal(h.calls[0].body.effectId, '789');
  assert.equal(h.calls[0].body.invertMedia, true);
  h.resolve({});
  await pending;
  assert.equal(h.state.clientMessageEffectId, null);
});

test('edit completion preserves text typed while the request was pending', async () => {
  const h = harness();
  h.state.clientEditingMessageId = 5;
  const pending = h.send();
  assert.equal(h.calls[0].body.options.parseMode, 'plain');
  h.input.value = 'next message';
  h.resolve({});
  await pending;
  assert.equal(h.input.value, 'next message');
  assert.deepEqual(h.refreshes, [1]);
});

test('attachment completion does not clear newer text or a replacement attachment', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'image/png', name: 'old.png' };
  const complete = h.send();
  h.input.value = 'new draft';
  h.state.clientDrafts[JSON.stringify(['a', '1'])] = 'new draft';
  h.state.clientStagedFile = { type: 'image/png', name: 'new.png' };
  h.resolve({});
  await complete;
  assert.equal(h.input.value, 'new draft');
  assert.equal(h.state.clientStagedFile.name, 'new.png');
  assert.equal(h.state.clientDrafts[JSON.stringify(['a', '1'])], 'new draft');
});

test('returning to the same chat does not let an older upload erase the new composer', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'image/png', name: 'old.png' };
  h.state.clientDrafts[JSON.stringify(['a', '1'])] = 'hello';
  const complete = h.send();
  h.state.chatSelectionVersion += 2;
  h.state.clientStagedFile = { type: 'image/png', name: 'new.png' };
  h.resolve({});
  await complete;
  assert.equal(h.input.value, 'hello');
  assert.equal(h.state.clientStagedFile.name, 'new.png');
  assert.equal(h.state.clientDrafts[JSON.stringify(['a', '1'])], 'hello');
  assert.equal(h.refreshes.length, 0);
});

test('oversized attachment is rejected before file reading', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'image/png', name: 'large.png', size: 2 * 1024 * 1024 * 1024 + 1 };
  await h.send();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.clientStagedFile.name, 'large.png');
});

test('attachment carries the silent setting and ignores repeated sends until upload settles', async () => {
  const h = harness();
  h.state.clientSilent = true;
  h.state.clientStagedFile = { type: 'image/png', name: 'a.png' };
  const upload = h.send();
  await h.send();
  await h.send();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.silent, true);
  h.resolve({});
  await upload;
});

test('single staged video can be sent as a Telegram round-video note', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'video/mp4', name: 'note.mp4' };
  h.state.clientVideoNote = true;
  const upload = h.send();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.mediaType, 'video');
  assert.equal(h.calls[0].body.videoNote, true);
  h.resolve({ success: true });
  await upload;

  const repeated = harness();
  repeated.state.clientStagedFile = { type: 'video/mp4', name: 'note.mp4' };
  repeated.state.clientVideoNote = true;
  await repeated.send(1900000000, 86400);
  assert.equal(repeated.calls.length, 0);
});

test('attachment can be retried after an upload failure', async () => {
  const h = harness();
  h.state.clientStagedFile = { type: 'image/png', name: 'a.png' };
  const upload = h.send();
  h.reject(new Error('network failed'));
  await upload;
  await h.send();
  assert.equal(h.calls.length, 2);
});

test('selected photos and videos are sent once through the album upload path with chat options', async () => {
  const h = harness();
  h.state.clientSilent = true;
  const files = [
    { type: 'image/jpeg', name: 'a.jpg', size: 10 },
    { type: 'video/mp4', name: 'b.mp4', size: 20 },
  ];
  h.state.clientStagedFile = files[0];
  h.state.clientStagedFiles = files;
  const upload = h.send(1900000000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/instances/a/account/send-media-album');
  assert.deepEqual(h.calls[0].files, files);
  assert.equal(h.calls[0].body.chatId, 1);
  assert.equal(h.calls[0].body.silent, true);
  assert.equal(h.calls[0].body.schedule, 1900000000);
  h.resolve({ success: true });
  await upload;
});

test('repeating text and single-media schedules carry Telegram repeat periods', async () => {
  const text = harness();
  const textSend = text.send(1900000000, 604800);
  assert.equal(text.calls[0].body.options.schedule, 1900000000);
  assert.equal(text.calls[0].body.options.scheduleRepeatPeriod, 604800);
  text.resolve({ id: 42 });
  await textSend;

  const media = harness();
  media.state.clientStagedFile = { type: 'image/png', name: 'photo.png' };
  const mediaSend = media.send(1900000000, 2592000);
  assert.equal(media.calls[0].body.schedule, 1900000000);
  assert.equal(media.calls[0].body.scheduleRepeatPeriod, 2592000);
  media.resolve({ success: true });
  await mediaSend;
});

test('repeating scheduled albums are rejected before upload', async () => {
  const h = harness();
  const files = [{ type: 'image/png', name: 'one.png', size: 10 }, { type: 'image/png', name: 'two.png', size: 10 }];
  h.state.clientStagedFile = files[0];
  h.state.clientStagedFiles = files;
  await h.send(1900000000, 86400);
  assert.equal(h.calls.length, 0);
});

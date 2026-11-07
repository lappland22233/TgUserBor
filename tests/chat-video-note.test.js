'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { File } = require('node:buffer');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('let videoNoteRecording = null;');
const end = source.indexOf('let currentActiveVoiceAudio = null;', start);
if (start < 0 || end < 0) throw new Error('Cannot locate video-note recorder');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 10, chatSelectionVersion: 2, clientReplyingTo: { id: 77 } };
  const requests = [], recorders = [], staged = [], toasts = [];
  const gum = [];
  const bar = { hidden: true };
  const preview = { srcObject: null, play() { return Promise.resolve(); }, pause() {} };
  const timer = { textContent: '' };
  const option = { checked: false };
  const navigator = { mediaDevices: { getUserMedia: constraints => { const pending = deferred(); requests.push(constraints); gum.push(pending); return pending.promise; } } };
  class MediaRecorder {
    static isTypeSupported(type) { return type === 'video/webm;codecs=vp8,opus'; }
    constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'video/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    data() { this.ondataavailable({ data: new Blob(['round video'], { type: this.mimeType }) }); }
  }
  const document = { getElementById(id) {
    return ({ 'chat-video-recording-bar': bar, 'chat-video-recording-preview': preview,
      'video-rec-timer': timer, 'chat-video-note': option })[id] || null;
  } };
  const context = vm.createContext({ state, navigator, MediaRecorder, File, Blob, document, Date, voiceRecording: null, voicePermissionPending: false, setInterval: () => 9,
    clearInterval() {}, showToast: message => toasts.push(message),
    stageAttachmentFile(file) { staged.push(file); state.clientStagedFile = file; state.clientStagedFiles = [file]; state.clientVideoNote = false; },
    updatePaidMediaComposerControl() {},
  });
  vm.runInContext(source.slice(start, end) + '\nthis.startVideoNoteRecording = startVideoNoteRecording; this.stopVideoNoteRecording = stopVideoNoteRecording;', context);
  const stream = () => {
    const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; } }, { kind: 'video', stopped: false, stop() { this.stopped = true; } }];
    return { tracks, getTracks: () => tracks };
  };
  return { state, context, requests, recorders, staged, toasts, gum, bar, preview, timer, option, stream };
}

test('video-note capture requests camera and microphone, then stages a Telegram round-video attachment', async () => {
  const h = harness();
  const starting = h.context.startVideoNoteRecording();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].video.facingMode, 'user');
  assert.ok(h.requests[0].audio);
  const media = h.stream(); h.gum[0].resolve(media); await starting;
  assert.equal(h.bar.hidden, false);
  assert.equal(h.preview.srcObject, media);
  h.recorders[0].data();
  await h.context.stopVideoNoteRecording(true);
  assert.equal(media.tracks.every(track => track.stopped), true);
  assert.equal(h.preview.srcObject, null);
  assert.equal(h.staged.length, 1);
  assert.equal(h.staged[0].type, 'video/webm');
  assert.equal(h.staged[0].name.endsWith('.webm'), true);
  assert.equal(h.state.clientVideoNote, true);
  assert.equal(h.option.checked, true);
});

test('canceling a video note discards it and releases camera tracks', async () => {
  const h = harness();
  const starting = h.context.startVideoNoteRecording(); const media = h.stream();
  h.gum[0].resolve(media); await starting; h.recorders[0].data();
  await h.context.stopVideoNoteRecording(false);
  assert.equal(media.tracks.every(track => track.stopped), true);
  assert.equal(h.staged.length, 0);
  assert.equal(h.bar.hidden, true);
});

test('late camera permission after the conversation changes is discarded', async () => {
  const h = harness(); const starting = h.context.startVideoNoteRecording();
  h.state.clientActiveChatId = 11; h.state.chatSelectionVersion++;
  await h.context.stopVideoNoteRecording(false);
  const media = h.stream(); h.gum[0].resolve(media); await starting;
  assert.equal(media.tracks.every(track => track.stopped), true);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.staged.length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = source.indexOf('let voiceRecording = null;');
const end = source.indexOf('let currentActiveVoiceAudio = null;', start);
if (start < 0 || end < 0) throw new Error('Cannot locate voice recorder');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; }
function harness() {
  const state = { clientSelectedInstance:'a', clientActiveChatId:1, chatSelectionVersion:1, clientMessages:[], clientSilent:true, clientReplyingTo:{id:77} };
  const gum = [], recorders = [], uploads = [], toasts = [], refreshes = [];
  const bar = {style:{}}, timer = {};
  const navigator = {mediaDevices:{getUserMedia: () => { const d = deferred(); gum.push(d); return d.promise; }}};
  class MediaRecorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop(); }
    data() { this.ondataavailable({data:new Blob(['voice'],{type:this.mimeType})}); }
  }
  const document = { getElementById: id => id === 'chat-voice-recording-bar' ? bar : id === 'voice-rec-timer' ? timer : null };
  const context = vm.createContext({state, navigator, MediaRecorder, document, Blob, encodeURIComponent, Date,
    setInterval: () => 1, clearInterval: () => {}, renderClientMessages() {},
    showToast: (message) => toasts.push(message), loadClientMessages: async (id) => refreshes.push(id),
    sendMediaStream: (url, file, metadata) => { const d = deferred(); uploads.push({url,file,metadata,...d}); return d.promise; },
  });
  vm.runInContext(source.slice(start,end) + '\nthis.startVoiceRecording = startVoiceRecording; this.stopVoiceRecording = stopVoiceRecording;', context);
  const stream = () => { const track = {stopped:false, stop() {this.stopped=true;}}; return {track, getTracks: () => [track]}; };
  return { state, context, gum, recorders, uploads, toasts, refreshes, stream, bar };
}
test('late microphone permission after switching conversation closes the acquired stream', async () => {
  const h = harness(); const pending = h.context.startVoiceRecording();
  h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++;
  await h.context.stopVoiceRecording(false);
  const stream = h.stream(); h.gum[0].resolve(stream); await pending;
  assert.equal(stream.track.stopped, true); assert.equal(h.recorders.length, 0); assert.equal(h.uploads.length, 0);
});
test('permission requests are serialized, and stale results cannot start a new recording', async () => {
  const h = harness(); const first = h.context.startVoiceRecording(); h.context.startVoiceRecording();
  assert.equal(h.gum.length, 1);
  await h.context.stopVoiceRecording(false);
  const second = h.context.startVoiceRecording();
  const old = h.stream(), current = h.stream();
  h.gum[0].resolve(old); await first;
  h.gum[1].resolve(current); await second;
  assert.equal(old.track.stopped, true); assert.equal(current.track.stopped, false); assert.equal(h.recorders.length, 1);
  await h.context.stopVoiceRecording(false); assert.equal(current.track.stopped, true);
});
test('voice is sent to its original conversation with actual audio type and cannot overwrite a later one', async () => {
  const h = harness(); const start = h.context.startVoiceRecording(); const stream = h.stream();
  h.gum[0].resolve(stream); await start; h.recorders[0].data();
  const pending = h.context.stopVoiceRecording(true);
  assert.equal(h.uploads.length, 1);
  assert.match(h.uploads[0].url, /\/instances\/a\/account\/send-media$/);
  assert.equal(h.uploads[0].metadata.chatId, 1); assert.equal(h.uploads[0].metadata.mediaType, 'voice');
  assert.equal(h.uploads[0].metadata.fileName, 'voice.webm'); assert.equal(h.uploads[0].metadata.replyTo, 77);
  assert.equal(h.uploads[0].metadata.silent, true); assert.match(h.uploads[0].file.type, /^audio\/webm/);
  h.state.clientSelectedInstance = 'b'; h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++;
  h.state.clientMessages = [{id:22}]; h.uploads[0].resolve({}); await pending;
  assert.equal(stream.track.stopped, true); assert.equal(h.state.clientMessages.length, 1); assert.equal(h.refreshes.length, 0);
});
test('failed voice send leaves retry guidance and marks only the original pending message', async () => {
  const h = harness(); const start = h.context.startVoiceRecording(); h.gum[0].resolve(h.stream()); await start;
  h.recorders[0].data(); const pending = h.context.stopVoiceRecording(true);
  h.uploads[0].reject(new Error('offline')); await pending;
  assert.equal(h.state.clientMessages[0].status, 'failed'); assert.match(h.toasts.at(-1), /检查原会话后重试/);
});
test('a recording whose conversation changed before send is discarded', async () => {
  const h = harness(); const start = h.context.startVoiceRecording(); const stream = h.stream();
  h.gum[0].resolve(stream); await start; h.recorders[0].data();
  h.state.clientActiveChatId = 2; h.state.chatSelectionVersion++;
  await h.context.stopVoiceRecording(true);
  assert.equal(stream.track.stopped, true); assert.equal(h.uploads.length, 0);
});
test('recorder failure releases the microphone and allows retry', async () => {
  const h = harness(); const start = h.context.startVoiceRecording(); const stream = h.stream();
  h.gum[0].resolve(stream); await start;
  h.recorders[0].onerror(new Error('device disconnected'));
  assert.equal(stream.track.stopped, true); assert.match(h.toasts.at(-1), /录音失败/);
  const again = h.context.startVoiceRecording(); assert.equal(h.gum.length, 2);
  h.gum[1].resolve(h.stream()); await again; await h.context.stopVoiceRecording(false);
});

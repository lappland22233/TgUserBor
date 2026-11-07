'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
function extract(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error(`Cannot locate ${startText}`);
  return source.slice(start, end);
}
function fixture(method, section) {
  const state = {clientSelectedInstance: 'a', clientActiveChatId: 10, chatSelectionVersion: 1,
    clientReplyingTo: {id: 7}, clientParseMode:'plain', clientSilent:true,
    pendingPasteFile: {fileName:'paste.png',size:3,file:{name:'paste.png',size:3}}};
  const calls = [], effects = [];
  let resolve;
  const caption = {value:'Caption'}, button = {disabled:false};
  const context = vm.createContext({state, document: { getElementById: id => id === 'paste-image-caption' ? caption : button },
    api: (url, verb, body) => {calls.push({url,verb,body}); return new Promise(r => {resolve=r;});},
    sendMediaStream: (url, file, body) => {calls.push({url,file,body}); return new Promise(r => {resolve=r;});},
    pendingMediaSends: new WeakSet(),
    showToast(){}, cancelReplyBanner: () => effects.push('reply'), closePasteImageModal: () => effects.push('paste'),
    loadClientMessages: async (...args) => effects.push(args),
  });
  vm.runInContext(section + `\nthis.execute = ${method};`, context);
  return {state, calls, effects, context, resolve: () => resolve({})};
}
for (const [method, end] of [
  ['sendSticker', '\n/* ==========================================================================' ],
  ['sendGif', '\nwindow.chatWs = new ChatWSManager()'],
]) {
  test(`${method} does not clear reply or refresh a different account/chat`, async () => {
    const f = fixture(method, extract(`async function ${method}(`, end));
    const pending = f.context.execute({id:'100',accessHash:'200',fileReference:'AA'});
    assert.equal(f.calls[0].body.chatId, 10);
    f.state.clientSelectedInstance = 'b'; f.state.clientActiveChatId = 99; f.state.chatSelectionVersion++;
    f.resolve(); await pending;
    assert.equal(f.effects.length, 0);
  });
}
test('pasted image sends as photo with selected formatting and does not close another chat', async () => {
  const f = fixture('sendPastedImage', extract('async function sendPastedImage()', '\n/* ==========================================================================\n   Sticker Pack'));
  const pending = f.context.execute();
  assert.equal(f.calls[0].body.mediaType, 'photo');
  assert.equal(f.calls[0].file, f.state.pendingPasteFile.file);
  assert.equal(f.calls[0].body.chatId, 10);
  assert.equal(f.calls[0].body.parseMode, 'plain');
  assert.equal(f.calls[0].body.silent, true);
  f.state.clientActiveChatId = 99; f.state.chatSelectionVersion++;
  f.resolve(); await pending;
  assert.equal(f.effects.length, 0);
});
test('pasted image completion keeps a replacement image and reply', async () => {
  const f = fixture('sendPastedImage', extract('async function sendPastedImage()', '\n/* ==========================================================================\n   Sticker Pack'));
  const pending = f.context.execute();
  f.state.pendingPasteFile = {fileName:'later.png'};
  f.state.clientReplyingTo = {id:9};
  f.resolve(); await pending;
  assert.equal(f.effects.includes('paste'), false);
  assert.equal(f.effects.includes('reply'), false);
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0][0], 10);
});
test('pasted image previews use and release object URLs; cancelling aborts an in-flight upload', () => {
  const state = {pendingPasteFile: null};
  const activeMediaUploads = new WeakMap(), revoked = [];
  const elements = {
    'modal-paste-image': {style:{}}, 'paste-image-preview': {src:''}, 'paste-image-info': {},
    'paste-image-caption': {value:'',focus(){}}, 'client-message-textarea': {value:'caption'},
  };
  const context = vm.createContext({state, activeMediaUploads, document:{getElementById:id=>elements[id]},
    URL:{createObjectURL:()=> 'blob:preview', revokeObjectURL: url=>revoked.push(url)},
    setTimeout(){}, Date, showToast(){}});
  vm.runInContext(extract('function openPasteImageModal(', '\nasync function sendPastedImage()') + '\nthis.open = openPasteImageModal; this.close = closePasteImageModal;', context);
  const file = {name:'x.png',size:6,type:'image/png'};
  context.open(file);
  assert.equal(state.pendingPasteFile.file, file);
  assert.equal(elements['paste-image-preview'].src, 'blob:preview');
  let aborted = false;
  activeMediaUploads.set(file, {phase:'upload',xhr:{abort(){aborted = true;}}});
  context.close();
  assert.equal(aborted, true);
  assert.deepEqual(revoked, ['blob:preview']);
  assert.equal(state.pendingPasteFile, null);
});

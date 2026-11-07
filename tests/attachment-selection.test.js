'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const code = section('function handleSendAttachment(', '\n// Lightbox Modal') +
  section('function stageAttachmentFile(', '\nfunction clearStagedAttachment(') +
  section('function initChatDragAndDrop(', '\n/**\n * Initializes Miuix');
function harness(chatId) {
  const state = { clientActiveChatId: chatId };
  const messages = [];
  const callbacks = {};
  const fileInput = { files: [], value: 'old' };
  const elements = {
    'btn-chat-attach': {}, 'chat-file-input': fileInput, 'btn-cancel-attachment': {},
    'client-input-bar': { classList: { add() {}, remove() {} }, addEventListener: (type, fn) => { callbacks[type] = fn; } },
    'chat-attachment-strip': { style: {} }, 'attachment-chip-name': {}, 'attachment-chip-size': {},
    'client-message-textarea': { focus() {} },
  };
  const context = vm.createContext({ state, document: { getElementById: id => elements[id] || null },
    formatBytes: () => '1 MB', showToast: (...args) => messages.push(args), cancelStagedAttachment() {} });
  vm.runInContext(code + '\nthis.init = initChatDragAndDrop;', context);
  context.init();
  return { state, fileInput, callbacks, messages, elements };
}

test('file picker stages an attachment instead of sending it immediately', () => {
  const h = harness(12);
  const file = { name: 'photo.jpg', size: 1234, type: 'image/jpeg' };
  h.fileInput.files = [file];
  h.fileInput.onchange();
  assert.equal(h.state.clientStagedFile, file);
  assert.equal(h.elements['attachment-chip-name'].textContent, 'photo.jpg');
  assert.equal(h.fileInput.value, '');
});

test('file picker stages up to ten photos and videos together for album sending', () => {
  const h = harness(12);
  const files = [
    { name: 'one.jpg', size: 1234, type: 'image/jpeg' },
    { name: 'two.mp4', size: 2345, type: 'video/mp4' },
  ];
  h.fileInput.files = files;
  h.fileInput.onchange();
  assert.equal(h.state.clientStagedFile, files[0]);
  assert.deepEqual(Array.from(h.state.clientStagedFiles), files);
  assert.equal(h.elements['attachment-chip-name'].textContent, '2 张照片或视频');
});

test('file picker rejects mixed document and photo selection instead of silently dropping files', () => {
  const h = harness(12);
  h.fileInput.files = [
    { name: 'one.jpg', size: 1234, type: 'image/jpeg' },
    { name: 'notes.pdf', size: 2345, type: 'application/pdf' },
  ];
  h.fileInput.onchange();
  assert.equal(h.state.clientStagedFile, undefined);
  assert.equal(h.messages.length, 1);
});

test('file picker and drag-drop require an active chat before staging', () => {
  const h = harness(null);
  const file = { name: 'photo.jpg', size: 1234 };
  h.fileInput.files = [file];
  h.fileInput.onchange();
  h.callbacks.drop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file] } });
  assert.equal(h.state.clientStagedFile, undefined);
  assert.equal(h.messages.length, 2);
  assert.equal(h.fileInput.value, '');
});

test('drag-drop stages the selected file for the current composer', () => {
  const h = harness(12);
  const file = { name: 'doc.pdf', size: 1234 };
  h.callbacks.drop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file] } });
  assert.equal(h.state.clientStagedFile, file);
});

test('clicking a dice button child leaves the picker open until an outside click', () => {
  let documentClick;
  const buttonChild = {};
  const diceOption = { focus() {} };
  const diceButton = {
    setAttribute() {},
    focus() {},
    contains(target) { return target === buttonChild; },
  };
  const dicePicker = {
    hidden: true,
    querySelector() { return diceOption; },
    querySelectorAll() { return []; },
    contains() { return false; },
    addEventListener() {},
  };
  const elements = {
    'btn-chat-attach': {}, 'chat-file-input': { files: [], value: '' },
    'btn-cancel-attachment': {}, 'client-input-bar': { addEventListener() {} },
    'chat-attachment-strip': { style: {} }, 'attachment-chip-name': {}, 'attachment-chip-size': {},
    'client-message-textarea': { focus() {} }, 'btn-chat-dice': diceButton, 'chat-dice-picker': dicePicker,
  };
  const context = vm.createContext({
    state: { clientActiveChatId: 12 },
    document: {
      getElementById: id => elements[id] || null,
      addEventListener: (type, handler) => { if (type === 'click') documentClick = handler; },
    },
    formatBytes: () => '1 MB', showToast() {}, cancelStagedAttachment() {},
  });
  vm.runInContext(code + '\nthis.init = initChatDragAndDrop;', context);
  context.init();

  diceButton.onclick();
  documentClick({ target: buttonChild });
  assert.equal(dicePicker.hidden, false);
  documentClick({ target: {} });
  assert.equal(dicePicker.hidden, true);
});

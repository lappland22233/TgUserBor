'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/js/visual-viewport.js', 'utf8');
function fixture() {
  const listeners = {};
  const props = new Map();
  const root = { clientHeight: 844, dataset: {}, style: {setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key)} };
  const viewport = { height: 844, offsetTop: 0, scale: 1, addEventListener: (type, fn) => {listeners[`viewport:${type}`] = fn;} };
  const active = {matches: () => true, closest: () => ({})};
  const document = {documentElement: root, activeElement: active, addEventListener: (type, fn) => {listeners[`document:${type}`] = fn;}};
  const window = {visualViewport: viewport, innerHeight: 844, innerWidth: 390, addEventListener: (type, fn) => {listeners[`window:${type}`] = fn;}};
  vm.runInNewContext(source, {window, document, requestAnimationFrame: callback => callback()});
  return {listeners, props, root, viewport, document, window};
}
test('a focused chat input uses the visual bottom and restores the layout when the keyboard closes', () => {
  const f = fixture();
  f.viewport.height = 400; f.viewport.offsetTop = 20; f.listeners['viewport:resize']();
  assert.equal(f.props.get('--chat-visible-height'), '420px');
  assert.equal(f.root.dataset.chatKeyboard, 'open');
  f.viewport.height = 844; f.viewport.offsetTop = 0; f.listeners['viewport:resize']();
  assert.equal(f.props.has('--chat-visible-height'), false);
  assert.equal(f.root.dataset.chatKeyboard, undefined);
});
test('pinch zoom and inputs outside the chat do not resize the application', () => {
  const f = fixture();
  f.viewport.height = 400; f.viewport.scale = 1.5; f.listeners['viewport:resize']();
  assert.equal(f.props.has('--chat-visible-height'), false);
  f.viewport.scale = 1; f.document.activeElement.closest = () => null; f.listeners['document:focusin']();
  assert.equal(f.props.has('--chat-visible-height'), false);
});

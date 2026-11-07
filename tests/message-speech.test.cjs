'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createSpeechHarness() {
  const spoken = [];
  let cancelCount = 0;
  const label = { textContent: '' };
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    speak(utterance) { spoken.push(utterance); },
    cancel() { cancelCount++; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let messageSpeechTargetKey = null;');
  const end = source.indexOf('let activeContextMsg = null;', start) + 'let activeContextMsg = null;'.length;
  assert.notEqual(start, -1, 'speech helper should exist in the client');
  assert.ok(end > start, 'speech helper section should end at the context menu state');
  const context = {
    window: { speechSynthesis },
    navigator: { language: 'zh-CN' },
    SpeechSynthesisUtterance: FakeUtterance,
    document: { getElementById(id) { return id === 'menu-action-read-aloud-text' ? label : null; } },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.speechTest = { toggleMessageSpeech, isMessageSpeechActive, setTarget(target) { activeContextMsg = target; }, getRunId() { return messageSpeechRunId; } };`, context);
  return { speech: context.speechTest, spoken, label, set cancelCount(value) { cancelCount = value; }, get cancelCount() { return cancelCount; }, speechSynthesis };
}

test('message speech is local, language-aware, chunked, and can be stopped', () => {
  const harness = createSpeechHarness();
  const target = { instId: 'account-a', chatId: 42, id: 101 };
  harness.speech.setTarget(target);

  const started = harness.speech.toggleMessageSpeech('你好，这是本地朗读。', target);
  assert.equal(started.stopped, false);
  assert.equal(started.chunks, 1);
  assert.equal(harness.spoken[0].text, '你好，这是本地朗读。');
  assert.equal(harness.spoken[0].lang, 'zh-CN');
  assert.equal(harness.speech.isMessageSpeechActive(target), true);
  assert.equal(harness.label.textContent, '停止朗读');

  const stopped = harness.speech.toggleMessageSpeech('你好，这是本地朗读。', target);
  assert.equal(stopped.stopped, true);
  assert.equal(harness.speech.isMessageSpeechActive(target), false);
  assert.equal(harness.cancelCount, 2);
  assert.equal(harness.label.textContent, '朗读消息');

  const longText = `${'这是一段用于测试消息朗读分段的文字。'.repeat(30)}`;
  const chunked = harness.speech.toggleMessageSpeech(longText, target);
  assert.ok(chunked.chunks > 1);
  assert.equal(harness.spoken.slice(1).map(item => item.text).join(''), longText);
  harness.spoken.at(-1).onend();
  assert.equal(harness.speech.isMessageSpeechActive(target), false);
});

test('starting another message cancels the old speech run without stale callbacks clearing it', () => {
  const harness = createSpeechHarness();
  const first = { instId: 'account-a', chatId: 42, id: 101 };
  const second = { instId: 'account-b', chatId: -10042, id: 8 };
  harness.speech.toggleMessageSpeech('first message', first);
  const staleOnEnd = harness.spoken[0].onend;
  harness.speech.toggleMessageSpeech('second message', second);
  staleOnEnd();
  assert.equal(harness.speech.isMessageSpeechActive(first), false);
  assert.equal(harness.speech.isMessageSpeechActive(second), true);
  assert.equal(harness.spoken[1].text, 'second message');
});

test('message context menu exposes speech only for supported browsers and text messages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/gui/web/index.html'), 'utf8');
  assert.match(html, /id="menu-action-read-aloud"/);
  assert.match(source, /btnReadAloud\.style\.display = text && window\.speechSynthesis && typeof SpeechSynthesisUtterance === 'function' \? 'flex' : 'none'/);
  assert.match(source, /document\.getElementById\('menu-action-read-aloud'\)\?\.addEventListener\('click'/);
  assert.match(source, /toggleMessageSpeech\(target\.text, target\)/);
});

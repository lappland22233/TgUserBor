'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
const start = source.indexOf("document.getElementById('menu-action-translate')?.addEventListener('click', async () => {");
const end = source.indexOf("  document.getElementById('menu-action-pin')", start);
if (start < 0 || end < 0) throw new Error('Cannot find message translation handler');
const handlerSource = source.slice(start, end);

function fixture(api) {
  let click;
  let insertedHtml = null;
  const translation = { set innerHTML(value) { insertedHtml = value; } };
  const bubble = { querySelector: selector => selector === '.msg-translated-wrap' ? translation : null };
  const wrap = { isConnected: true, querySelector: selector => selector === '.chat-bubble' ? bubble : null };
  const state = { clientSelectedInstance: 'account-a', clientActiveChatId: -100123, chatSelectionVersion: 4 };
  const activeContextMsg = { id: 55, text: 'original', wrap, instId: 'account-a', chatId: -100123, selectionVersion: 4 };
  const context = vm.createContext({
    state,
    activeContextMsg,
    document: { getElementById: id => id === 'menu-action-translate' ? { addEventListener: (_event, callback) => { click = callback; } } : null },
    hideMenu() {},
    showToast() {},
    api,
    escapeHtml: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatMessageContent: (text, entities) => {
      if (entities?.some(entity => entity.type === 'MessageEntityBold')) return `<strong>${String(text)}</strong>`;
      return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    },
  });
  vm.runInContext(handlerSource, context);
  return { click: () => click(), state, insertedHtml: () => insertedHtml };
}

test('translation sends only peer/message IDs and inserts Telegram result as escaped text', async () => {
  const calls = [];
  const ui = fixture(async (url, method, body) => {
    calls.push({ url, method, body });
    return { translatedText: '<script>literal</script>' };
  });
  await ui.click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: '/api/instances/account-a/account/translate', method: 'POST',
    body: { chatId: -100123, messageId: 55, targetLang: 'zh-hans' },
  }]);
  assert.match(ui.insertedHtml(), /&lt;script&gt;literal&lt;\/script&gt;/);
});

test('translation uses the selected Telegram target language', async () => {
  const calls = [];
  const ui = fixture(async (_url, _method, body) => { calls.push(body); return { translatedText: 'こんにちは' }; });
  ui.state.clientTranslationLanguage = 'ja';
  await ui.click();
  assert.equal(calls[0].targetLang, 'ja');
  assert.match(ui.insertedHtml(), /Telegram 翻译 · 日本語/);
});

test('translation renders Telegram formatting entities in the translated text', async () => {
  const ui = fixture(async () => ({ translatedText: '重要', entities: [{ type: 'MessageEntityBold', offset: 0, length: 2 }] }));
  await ui.click();
  assert.match(ui.insertedHtml(), /<strong>重要<\/strong>/);
});

test('a translation response after switching chats cannot be inserted into the new view', async () => {
  let resolve;
  const ui = fixture(() => new Promise(done => { resolve = done; }));
  const pending = ui.click();
  ui.state.clientActiveChatId = 42;
  ui.state.chatSelectionVersion++;
  resolve({ translatedText: 'old result' });
  await pending;
  assert.equal(ui.insertedHtml(), null);
});

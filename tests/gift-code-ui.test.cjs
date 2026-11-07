'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Field {
  constructor(value = '') { this.value = value; this.hidden = false; this.disabled = false; this.textContent = ''; }
}

function settingsHarness({ approve = false } = {}) {
  const source = fs.readFileSync('src/gui/web/js/settings.js', 'utf8');
  const start = source.indexOf('  function normalizeGiftCodeInput(');
  const end = source.indexOf('\n  async function loadAccountStarGifts(', start);
  assert.ok(start >= 0 && end > start);
  const fields = {
    '#setting-gift-code-input': new Field('https://t.me/giftcode/Gift_code-123'),
    '#btn-check-gift-code': new Field(), '#btn-apply-gift-code': new Field(), '#setting-gift-code-status': new Field(),
  };
  const state = { clientSelectedInstance: 'a' };
  const calls = [], confirms = [], toasts = [];
  const context = vm.createContext({ state, URL, encodeURIComponent, Date,
    window: { confirm: message => { confirms.push(message); return approve; }, showToast: (...args) => toasts.push(args) },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url.endsWith('/check')) return { slug: 'Gift_code-123', months: 6, date: 1700000000, viaGiveaway: true, recipientMatches: true };
      return { applied: true, months: 6 };
    },
  });
  vm.runInContext(`let giftCodePreviewRequest = 0; let giftCodePreview = null;\n${source.slice(start, end)}\nthis.check = checkAccountGiftCode; this.apply = applyAccountGiftCode;`, context);
  const container = { querySelector: selector => fields[selector] || null };
  return { context, container, fields, state, calls, confirms, toasts };
}

test('Premium gift link UI previews canonical links and activates only after confirmation', async () => {
  const h = settingsHarness();
  await h.context.check(h.container);
  assert.match(h.fields['#setting-gift-code-status'].textContent, /6 个月 Telegram Premium/);
  assert.equal(h.fields['#btn-apply-gift-code'].hidden, false);
  await h.context.apply(h.container);
  assert.equal(h.calls.filter(call => call.url.endsWith('/apply')).length, 0);
  assert.match(h.confirms[0], /6 个月/);
  h.context.window.confirm = () => true;
  await h.context.apply(h.container);
  assert.equal(h.calls.filter(call => call.url.endsWith('/apply')).length, 1);
  assert.match(h.fields['#setting-gift-code-status'].textContent, /已激活 6 个月/);
});

test('gift code UI hides activation for used, misaddressed, or stale account previews', async () => {
  const h = settingsHarness();
  h.fields['#setting-gift-code-input'].value = 'bad url';
  await h.context.check(h.container);
  assert.match(h.fields['#setting-gift-code-status'].textContent, /请输入有效/);
  assert.equal(h.calls.length, 0);
  h.fields['#setting-gift-code-input'].value = 'Gift_code-123';
  h.context.api = async () => ({ slug: 'Gift_code-123', months: 12, date: 1, usedDate: 2, viaGiveaway: false, recipientMatches: false });
  await h.context.check(h.container);
  assert.match(h.fields['#setting-gift-code-status'].textContent, /已于 .* 使用/);
  assert.equal(h.fields['#btn-apply-gift-code'].hidden, true);
});

test('chat gift link activation is bound to the selected account and chat', async () => {
  const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
  const start = source.indexOf('async function openTelegramGiftCode(');
  const end = source.indexOf('\nfunction renderClientMessages(', start);
  assert.ok(start >= 0 && end > start);
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 10 };
  const calls = [], prompts = [];
  let accountSwitch = false;
  const context = vm.createContext({ state, encodeURIComponent, Date,
    window: { confirm: prompt => { prompts.push(prompt); return true; } },
    api: async url => {
      calls.push(url);
      if (url.endsWith('/check')) {
        if (accountSwitch) state.clientSelectedInstance = 'b';
        return { months: 3, date: 1, viaGiveaway: false, recipientMatches: true };
      }
      return { applied: true, months: 3 };
    }, showToast() {},
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.open = openTelegramGiftCode;`, context);
  await context.open('Gift_code-123', 'a', 10);
  assert.equal(calls.length, 2);
  assert.match(prompts[0], /3 个月/);
  state.clientSelectedInstance = 'a';
  accountSwitch = true;
  calls.length = 0;
  await context.open('Gift_code-123', 'a', 10);
  assert.equal(calls.length, 1, 'a result for an old account must never apply');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.disabled = false; this.textContent = ''; this.href = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
}

function harness({ approve = false, confirmationResult = { stars: '100' } } = {}) {
  const source = fs.readFileSync('src/gui/web/js/settings.js', 'utf8');
  const start = source.indexOf('  async function loadAccountStarsTopupOptions(');
  const end = source.indexOf('\n  async function loadAccountStarsSubscriptions(', start);
  assert.ok(start >= 0 && end > start);
  const fields = {
    '#setting-stars-topup-status': new Element('div'),
    '#setting-stars-topup-options': new Element('div'),
    '#setting-stars-topup-verification': new Element('a'),
  };
  const calls = [], confirmations = [];
  const state = { clientSelectedInstance: 'a' };
  const context = vm.createContext({ state, URL, Intl, encodeURIComponent,
    document: { createElement: tag => new Element(tag) },
    window: { confirm: prompt => { confirmations.push(prompt); return approve; } },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url.endsWith('/account/stars-topup-options')) return [
        { id: 'i'.repeat(32), stars: '100', currency: 'USD', amount: '199', extended: false },
      ];
      if (url.endsWith('/prepare')) return { token: 't'.repeat(32), stars: '100', currency: 'USD', amount: '199', title: 'Top up', description: 'Telegram checkout' };
      return confirmationResult;
    },
    loadAccountStars: async (...args) => calls.push({ refreshedStars: args }),
    starsTopupRequest: 0, loadedStarsTopupInstance: null, starsRequest: 0, loadedStarsInstance: null,
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadOptions = loadAccountStarsTopupOptions;`, context);
  return { context, fields, calls, confirmations, state };
}

test('Stars top-up UI shows the Telegram price and submits only after explicit confirmation', async () => {
  const h = harness();
  const container = { querySelector: selector => h.fields[selector] || null };
  await h.context.loadOptions(container);
  assert.equal(h.fields['#setting-stars-topup-options'].children.length, 1);
  const row = h.fields['#setting-stars-topup-options'].children[0];
  assert.match(row.children[0].children[0].textContent, /100 Stars/);
  assert.match(row.children[0].children[1].textContent, /1\.99/);
  await row.children[1].onclick();
  assert.equal(h.calls.filter(call => call.url?.endsWith('/confirm')).length, 0);
  assert.match(h.confirmations[0], /100 Stars/);
  assert.match(h.confirmations[0], /1\.99/);
  h.context.window.confirm = () => true;
  await row.children[1].onclick();
  assert.equal(h.calls.filter(call => call.url?.endsWith('/confirm')).length, 1);
  assert.ok(h.calls.some(call => call.refreshedStars));
  assert.match(h.fields['#setting-stars-topup-status'].textContent, /已确认购买 100 Stars/);
});

test('Stars top-up UI exposes verification links only as user-clicked HTTPS links', async () => {
  const h = harness({ approve: true, confirmationResult: { stars: '100', verificationUrl: 'https://payments.example/verify' } });
  const container = { querySelector: selector => h.fields[selector] || null };
  await h.context.loadOptions(container);
  await h.fields['#setting-stars-topup-options'].children[0].children[1].onclick();
  const link = h.fields['#setting-stars-topup-verification'];
  assert.equal(link.hidden, false);
  assert.equal(link.href, 'https://payments.example/verify');
  h.context.api = async (url, method, body) => url.endsWith('/account/stars-topup-options')
    ? [{ id: 'i'.repeat(32), stars: '100', currency: 'USD', amount: '199' }]
    : url.endsWith('/prepare') ? { token: 't'.repeat(32), stars: '100', currency: 'USD', amount: '199' }
      : { stars: '100', verificationUrl: 'javascript:alert(1)' };
  h.context.loadedStarsTopupInstance = null;
  h.context.window.confirm = () => true;
  await h.context.loadOptions(container, true);
  await h.fields['#setting-stars-topup-options'].children[0].children[1].onclick();
  assert.equal(link.href, 'https://payments.example/verify');
  assert.match(h.fields['#setting-stars-topup-status'].textContent, /不安全的验证地址/);
});

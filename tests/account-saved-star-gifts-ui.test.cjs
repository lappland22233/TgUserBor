'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; this.className = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
}

test('saved Star Gift UI confirms conversion, refreshes balance, and toggles profile visibility', async () => {
  const source = fs.readFileSync('src/gui/web/js/settings.js', 'utf8');
  const start = source.indexOf('  async function loadAccountSavedStarGifts(');
  const end = source.indexOf('\n  async function loadAccountNotificationSettings(', start);
  assert.ok(start >= 0 && end > start);
  const fields = {
    '#setting-saved-star-gifts-status': new Element('div'),
    '#setting-saved-star-gifts-list': new Element('div'),
    '#btn-refresh-saved-star-gifts': new Element('button'),
    '#btn-more-saved-star-gifts': new Element('button'),
  };
  const state = { clientSelectedInstance: 'a' };
  const calls = [], confirms = [];
  let approve = false;
  let generation = 0;
  let includeUpgrade = false;
  const context = vm.createContext({ state, Date, Intl, encodeURIComponent,
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { confirm: prompt => { confirms.push(prompt); return approve; } },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url.endsWith('/account/saved-star-gifts?offset=&limit=20')) {
        generation++;
        return { count: 1, nextOffset: '', gifts: [{ id: String(generation).padEnd(32, 'i'), title: 'Gift', emoji: '🎁', date: 1700000000,
          saved: generation === 1, unique: false, refunded: false, convertStars: '10', upgradeStars: includeUpgrade ? '25' : undefined,
          canUpgrade: includeUpgrade, message: '' }] };
      }
      if (url.endsWith('/upgrade/prepare')) return { token: 'u'.repeat(32), stars: '25' };
      if (url.endsWith('/upgrade/confirm')) return { upgraded: true, stars: '25' };
      if (url.endsWith('/convert')) return { converted: true, stars: '10' };
      return { saved: false };
    },
    loadAccountStars: async (...args) => calls.push({ refreshedStars: args }),
    savedStarGiftsRequest: 0, loadedSavedStarGiftsInstance: null, savedStarGiftsNextOffset: '',
    starsRequest: 0, loadedStarsInstance: null, starsNextOffset: '',
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadSaved = loadAccountSavedStarGifts;`, context);
  const container = { querySelector: selector => fields[selector] || null };
  await context.loadSaved(container);
  let row = fields['#setting-saved-star-gifts-list'].children[0];
  const actions = row.children[1];
  const convert = actions.children[1];
  await convert.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/convert')).length, 0);
  assert.match(confirms[0], /兑换为 10 Stars/);
  approve = true;
  await convert.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/convert')).length, 1);
  assert.ok(calls.some(call => call.refreshedStars));
  assert.match(fields['#setting-saved-star-gifts-status'].textContent, /兑换为 10 Stars/);
  row = fields['#setting-saved-star-gifts-list'].children[0];
  await row.children[1].children[0].onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/save')).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.url?.endsWith('/save')))), {
    url: '/api/instances/a/account/saved-star-gifts/save', method: 'POST',
    body: { id: String(generation - 1).padEnd(32, 'i'), saved: true },
  });
});

test('Star Gift upgrade UI checks the final Stars amount and waits for explicit confirmation', async () => {
  const source = fs.readFileSync('src/gui/web/js/settings.js', 'utf8');
  const start = source.indexOf('  async function loadAccountSavedStarGifts(');
  const end = source.indexOf('\n  async function loadAccountNotificationSettings(', start);
  const fields = {
    '#setting-saved-star-gifts-status': new Element('div'),
    '#setting-saved-star-gifts-list': new Element('div'),
    '#btn-refresh-saved-star-gifts': new Element('button'),
    '#btn-more-saved-star-gifts': new Element('button'),
  };
  const state = { clientSelectedInstance: 'a' }, calls = [], confirms = [];
  let approve = false;
  const context = vm.createContext({ state, Date, Intl, encodeURIComponent,
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { confirm: prompt => { confirms.push(prompt); return approve; } },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url.endsWith('/account/saved-star-gifts?offset=&limit=20')) return { count: 1, nextOffset: '', gifts: [{ id: 'i'.repeat(32), title: 'Gift', emoji: '🎁', date: 1700000000,
        saved: true, unique: false, refunded: false, convertStars: '10', upgradeStars: '25', canUpgrade: true, message: '' }] };
      if (url.endsWith('/upgrade/prepare')) return { token: 'u'.repeat(32), stars: '25' };
      if (url.endsWith('/upgrade/confirm')) return { upgraded: true, stars: '25' };
      return {};
    },
    loadAccountStars: async (...args) => calls.push({ refreshedStars: args }),
    savedStarGiftsRequest: 0, loadedSavedStarGiftsInstance: null, savedStarGiftsNextOffset: '',
    starsRequest: 0, loadedStarsInstance: null, starsNextOffset: '',
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadSaved = loadAccountSavedStarGifts;`, context);
  const container = { querySelector: selector => fields[selector] || null };
  await context.loadSaved(container);
  const actions = fields['#setting-saved-star-gifts-list'].children[0].children[1];
  const upgrade = actions.children[3];
  assert.match(upgrade.textContent, /25 Stars/);
  await upgrade.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/upgrade/confirm')).length, 0);
  assert.match(confirms[0], /支付 25 Stars/);
  approve = true;
  await upgrade.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/upgrade/confirm')).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.url?.endsWith('/upgrade/confirm')))), {
    url: '/api/instances/a/account/saved-star-gifts/upgrade/confirm', method: 'POST',
    body: { token: 'u'.repeat(32), keepOriginalDetails: true },
  });
  assert.ok(calls.some(call => call.refreshedStars));
  assert.match(fields['#setting-saved-star-gifts-status'].textContent, /礼物已升级/);
});

test('Star Gift transfer UI is bound to the current private recipient and waits for confirmation', async () => {
  const source = fs.readFileSync('src/gui/web/js/settings.js', 'utf8');
  const start = source.indexOf('  async function loadAccountSavedStarGifts(');
  const end = source.indexOf('\n  async function loadAccountNotificationSettings(', start);
  const fields = {
    '#setting-saved-star-gifts-status': new Element('div'), '#setting-saved-star-gifts-list': new Element('div'),
    '#btn-refresh-saved-star-gifts': new Element('button'), '#btn-more-saved-star-gifts': new Element('button'),
  };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, chatSelectionVersion: 3,
    clientDialogs: [{ id: 42, type: 'private', title: 'Ada' }] };
  const calls = [], confirms = [];
  let approve = false;
  const context = vm.createContext({ state, Date, Intl, encodeURIComponent,
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { confirm: prompt => { confirms.push(prompt); return approve; }, showToast: () => {} },
    api: async (url, method, body) => {
      calls.push({ url, method, body });
      if (url.includes('/account/saved-star-gifts?')) return { count: 1, nextOffset: '', gifts: [{ id: 'i'.repeat(32), title: 'Gift', emoji: '🎁', date: 1700000000,
        saved: true, unique: false, refunded: false, convertStars: '0', canUpgrade: false, canTransfer: true, transferStars: '15', message: '' }] };
      if (url.endsWith('/transfer/prepare')) return { token: 'v'.repeat(32), stars: '15' };
      if (url.endsWith('/transfer/confirm')) return { transferred: true, stars: '15' };
      return {};
    },
    loadAccountStars: async (...args) => calls.push({ refreshedStars: args }),
    savedStarGiftsRequest: 0, loadedSavedStarGiftsInstance: null, savedStarGiftsNextOffset: '',
    starsRequest: 0, loadedStarsInstance: null, starsNextOffset: '',
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadSaved = loadAccountSavedStarGifts;`, context);
  const container = { querySelector: selector => fields[selector] || null };
  await context.loadSaved(container);
  let transfer = fields['#setting-saved-star-gifts-list'].children[0].children[1].children[1];
  await transfer.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/transfer/confirm')).length, 0);
  assert.match(confirms[0], /Ada/);
  assert.match(confirms[0], /15 Stars/);
  approve = true;
  await transfer.onclick();
  assert.equal(calls.filter(call => call.url?.endsWith('/transfer/confirm')).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.url?.endsWith('/transfer/confirm')))), {
    url: '/api/instances/a/account/saved-star-gifts/transfer/confirm', method: 'POST',
    body: { token: 'v'.repeat(32), chatId: 42 },
  });
  assert.ok(calls.some(call => call.refreshedStars));
  assert.match(fields['#setting-saved-star-gifts-status'].textContent, /已转让给 Ada/);
});

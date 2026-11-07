'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this._text = ''; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text; }
  setAttribute() {}
}

test('Star Gift UI asks for confirmation with recipient and total Stars before sending', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/js/settings.js'), 'utf8');
  const start = source.indexOf('  async function loadAccountStarGifts(');
  const end = source.indexOf('\n  async function loadAccountNotificationSettings(', start);
  assert.ok(start >= 0 && end > start);
  const list = new Element('div'), status = new Element('div'), refresh = new Element('button');
  const container = { querySelector: selector => ({
    '#setting-star-gifts-list': list,
    '#setting-star-gifts-status': status,
    '#btn-refresh-star-gifts': refresh,
  })[selector] || null };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: 42, clientDialogs: [{ id: 42, type: 'private', title: 'Ada' }] };
  const calls = [], confirmations = [], toasts = [];
  let approve = false;
  const context = vm.createContext({
    state, encodeURIComponent,
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { confirm: prompt => { confirmations.push(prompt); return approve; }, showToast: (...args) => toasts.push(args) },
    api: async (url, method, body) => {
      calls.push({ url, method, ...(body ? { body } : {}) });
      if (!method) return [{ id: '99', stars: '15', upgradeStars: '7', sticker: { emoji: '🎁', id: '500', accessHash: '88', fileReference: 'AQ==' } }];
      if (url.endsWith('/prepare')) return { token: 'p'.repeat(32), stars: '22' };
      return { stars: '22' };
    },
    loadAccountStars: (...args) => calls.push({ refreshStars: args }),
    starGiftsRequest: 0, loadedStarGiftsInstance: null,
    showToast: (...args) => toasts.push(args),
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.loadGifts = loadAccountStarGifts;`, context);
  await context.loadGifts(container);
  const actions = list.children[0].children[3];
  const hideName = actions.children[0].children[0];
  const includeUpgrade = actions.children[1].children[0];
  const send = actions.children[2];
  hideName.checked = true;
  includeUpgrade.checked = true;
  await send.onclick();
  assert.equal(calls.filter(call => call.url.endsWith('/confirm')).length, 0, 'cancelled confirmation must not request a charge');
  approve = true;
  await send.onclick();
  assert.match(confirmations[1], /Ada/);
  assert.match(confirmations[1], /22 Stars/);
  assert.match(confirmations[1], /隐藏你的姓名/);
  assert.match(confirmations[1], /不能撤回/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.url.endsWith('/confirm')))), {
    url: '/api/instances/a/account/star-gifts/confirm', method: 'POST',
    body: { chatId: '42', giftId: '99', token: 'p'.repeat(32) },
  });
  assert.match(status.textContent, /扣除 22 Stars/);
});

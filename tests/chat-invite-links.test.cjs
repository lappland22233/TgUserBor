'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram invite links map exported pages, cursor and create/revoke requests', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => {
    assert.equal(chatId, -42);
    return new Api.InputPeerChannel({ channelId: bigInt(42), accessHash: bigInt(77) });
  };
  const exported = (link, date, values = {}) => new Api.ChatInviteExported({
    link, adminId: new Api.InputUserSelf(), date, ...values,
  });
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.messages.GetExportedChatInvites) {
      return { count: 2, invites: [
        exported('https://t.me/+First_1', 200, { title: 'Main', usage: 3, usageLimit: 10, requestNeeded: true }),
        exported('https://t.me/joinchat/Second-2', 100, { permanent: true }),
      ] };
    }
    if (request instanceof Api.messages.ExportChatInvite) {
      return exported('https://t.me/+Created_3', 300, { title: request.title, expireDate: request.expireDate, usageLimit: request.usageLimit, requestNeeded: request.requestNeeded });
    }
    if (request instanceof Api.messages.EditExportedChatInvite && !request.revoked) {
      return exported(request.link, 300, { title: request.title || 'Updated' });
    }
    return {};
  } };

  const page = await driver.getChatInviteLinks(-42, undefined, 2);
  assert.equal(page.count, 2);
  assert.deepEqual(page.links, [
    { link: 'https://t.me/+First_1', title: 'Main', date: 200, usageLimit: 10, usage: 3, requestNeeded: true, revoked: false },
    { link: 'https://t.me/joinchat/Second-2', date: 100, usage: 0, requestNeeded: false, revoked: false },
  ]);
  assert.deepEqual(page.nextCursor, { date: 100, link: 'https://t.me/joinchat/Second-2' });
  assert.equal(calls[0].adminId.className, 'InputUserSelf');
  assert.equal(calls[0].revoked, false);
  assert.equal(calls[0].limit, 2);

  await driver.getChatInviteLinks(-42, page.nextCursor, 10);
  assert.equal(calls[1].offsetDate, 100);
  assert.equal(calls[1].offsetLink, 'https://t.me/joinchat/Second-2');
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const created = await driver.createChatInviteLink(-42, { title: ' Launch ', expireDate: expiry, usageLimit: 5, requestNeeded: true });
  assert.equal(created.link, 'https://t.me/+Created_3');
  assert.equal(calls[2].title, 'Launch');
  assert.equal(calls[2].expireDate, expiry);
  assert.equal(calls[2].usageLimit, 5);
  assert.equal(calls[2].requestNeeded, true);
  const edited = await driver.editChatInviteLink(-42, 'https://t.me/+Created_3', 'Updated');
  assert.equal(edited.title, 'Updated');
  assert.equal(calls[3].title, 'Updated');
  await driver.revokeChatInviteLink(-42, 'https://t.me/+Created_3');
  assert.equal(calls[4].revoked, true);
  await assert.rejects(driver.revokeChatInviteLink(-42, 'https://evil.example/+Created_3'), /Invalid Telegram invite link/);
  await assert.rejects(driver.createChatInviteLink(-42, { usageLimit: 0 }), /Invalid Telegram invite link options/);
  await assert.rejects(driver.getChatInviteLinks(-42, { date: 10, link: 'https://evil.example/invite' }), /Invalid Telegram invite link query/);
  assert.equal(calls.length, 5);
});

test('invite-link HTTP routes validate cursors and options and dispatch only to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (...args) => {
    calls.push(args);
    if (args[0] === 'get_chat_invite_links') return { count: 1, links: [{ link: 'https://t.me/+A_1' }] };
    if (args[0] === 'create_chat_invite_link') return { link: 'https://t.me/+B_2' };
    if (args[0] === 'edit_chat_invite_link') return { link: args[1].link, title: args[1].title };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/invite-links`;
    assert.equal((await fetch(`${base}?chatId=0`)).status, 400);
    const page = await fetch(`${base}?chatId=-42&date=100&link=${encodeURIComponent('https://t.me/+Cursor_1')}&limit=25`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await page.json(), { count: 1, links: [{ link: 'https://t.me/+A_1' }] });
    const post = body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'create', chatId: -42, usageLimit: 0, requestNeeded: true })).status, 400);
    assert.equal((await post({ action: 'create', chatId: -42, title: 'Launch', expireDate: Math.floor(Date.now() / 1000) + 86400, usageLimit: 5, requestNeeded: true })).status, 200);
    assert.equal((await post({ action: 'edit', chatId: -42, link: 'https://t.me/+A_1', title: 'Renamed' })).status, 200);
    assert.equal((await post({ action: 'revoke', chatId: -42, link: 'https://evil.example/invite' })).status, 400);
    assert.equal((await post({ action: 'revoke', chatId: -42, link: 'https://t.me/+A_1' })).status, 200);
    assert.deepEqual(calls, [
      ['get_chat_invite_links', { chatId: -42, cursor: { date: 100, link: 'https://t.me/+Cursor_1' }, limit: 25 }],
      ['create_chat_invite_link', { chatId: -42, title: 'Launch', expireDate: calls[1]?.[1]?.expireDate, usageLimit: 5, requestNeeded: true }],
      ['edit_chat_invite_link', { chatId: -42, link: 'https://t.me/+A_1', title: 'Renamed' }],
      ['revoke_chat_invite_link', { chatId: -42, link: 'https://t.me/+A_1' }],
    ]);
    assert.ok(calls[1][1].expireDate > Math.floor(Date.now() / 1000));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

class Element {
  constructor(tagName = 'DIV') { this.tagName = tagName; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.isConnected = true; this.value = ''; this.checked = false; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  remove() { this.isConnected = false; }
}

test('invite-link UI is account-bound, safely renders links, creates links and confirms revocation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function closeInviteLinksModal() {');
  const end = source.indexOf('\nfunction invalidateGroupMembers()', start);
  assert.ok(start >= 0 && end > start);
  const ids = [
    'modal-invite-links', 'invite-links-list', 'invite-links-status', 'btn-more-invite-links', 'invite-link-title',
    'invite-link-expiry', 'invite-link-limit', 'invite-link-request-needed', 'btn-create-invite-link',
  ];
  const elements = new Map(ids.map(id => [id, new Element()]));
  elements.get('invite-link-expiry').value = '0';
  const calls = [];
  const copied = [];
  let confirms = 0;
  const context = vm.createContext({
    state: { clientSelectedInstance: 'a', clientActiveChatId: -42, chatSelectionVersion: 3 },
    document: { getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) },
    window: { chatWs: { isConnected: () => false }, prompt: () => 'Renamed' },
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    URLSearchParams, encodeURIComponent, confirm: () => { confirms++; return true; },
    api: async (url, method = 'GET', body) => {
      calls.push({ url, method, body });
      if (method === 'POST') return body.action === 'edit' ? { link: body.link, title: body.title } : { link: 'https://t.me/+New_1' };
      return { count: 1, links: [{ link: 'https://t.me/+Safe_1', title: '<img src=x>', date: 100, usage: 2, usageLimit: 10, requestNeeded: true }] };
    },
  });
  vm.runInContext(`let groupMembersContext = { instId: 'a', chatId: -42, selectionVersion: 3 };
    let inviteLinkSession = null;
    function isCurrentGroupMembersContext(target) { return Boolean(target && target === groupMembersContext && state.clientSelectedInstance === target.instId && String(state.clientActiveChatId) === String(target.chatId) && state.chatSelectionVersion === target.selectionVersion); }
    ${source.slice(start, end)}
    this.open = openInviteLinksModal; this.load = loadInviteLinks; this.create = createInviteLink; this.revoke = revokeInviteLink; this.editTitle = editInviteLinkTitle; this.close = closeInviteLinksModal;
    this.getSession = () => inviteLinkSession;`, context);

  context.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('modal-invite-links').style.display, 'flex');
  assert.equal(calls[0].url, '/api/instances/a/account/invite-links?chatId=-42&limit=50');
  const card = elements.get('invite-links-list').children[0];
  assert.equal(card.children[0].children[0].textContent, '<img src=x>');
  assert.equal(card.children[0].children[1].href, 'https://t.me/+Safe_1');
  assert.equal(card.children[0].children[1].textContent, 'https://t.me/+Safe_1');
  const [copy, rename, revoke] = card.children[1].children;
  await copy.onclick();
  assert.deepEqual(copied, ['https://t.me/+Safe_1']);
  await context.editTitle(context.getSession(), 'https://t.me/+Safe_1', '<img src=x>', card.children[0].children[0]);
  assert.equal(card.children[0].children[0].textContent, 'Renamed');
  await context.revoke(context.getSession(), 'https://t.me/+Safe_1', '<img src=x>', card, revoke);
  assert.equal(confirms, 1);
  assert.equal(card.isConnected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
    url: '/api/instances/a/account/invite-links', method: 'POST',
    body: { action: 'edit', chatId: -42, link: 'https://t.me/+Safe_1', title: 'Renamed' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), {
    url: '/api/instances/a/account/invite-links', method: 'POST',
    body: { action: 'revoke', chatId: -42, link: 'https://t.me/+Safe_1' },
  });

  elements.get('invite-link-title').value = 'Test Link';
  elements.get('invite-link-expiry').value = '86400';
  elements.get('invite-link-limit').value = '5';
  elements.get('invite-link-request-needed').checked = true;
  await context.create();
  const createCall = calls.find(call => call.method === 'POST' && call.body.action === 'create');
  assert.ok(createCall);
  assert.equal(createCall.body.title, 'Test Link');
  assert.ok(createCall.body.expireDate > Math.floor(Date.now() / 1000));
  assert.equal(createCall.body.usageLimit, 5);
  assert.equal(createCall.body.requestNeeded, true);
  context.close();
});

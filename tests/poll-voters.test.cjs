'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('public poll voter pages map Telegram users and preserve opaque option/cursor values', async () => {
  const calls = [];
  let publicVoters = true;
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = chatId => BigInt(chatId);
  driver.client = {
    getMessages: async () => [{ media: { poll: { publicVoters, answers: [{ option: Buffer.from([0, 255, 7]) }] } } }],
    invoke: async request => {
      calls.push(request);
      return new Api.messages.VotesList({
        count: 3, nextOffset: 'next+/=cursor',
        votes: [new Api.MessagePeerVote({ peer: new Api.PeerUser({ userId: bigInt(77) }), date: 123 })],
        users: [new Api.User({ id: bigInt(77), firstName: 'Ari', lastName: 'Lee', username: 'ari' })],
      });
    },
  };
  const page = await driver.getPollVotes(-100123, 55, 0, 'previous-cursor', 75);
  assert.equal(calls[0].className, 'messages.GetPollVotes');
  assert.deepEqual(calls[0].option, Buffer.from([0, 255, 7]));
  assert.equal(calls[0].offset, 'previous-cursor');
  assert.equal(calls[0].limit, 75);
  assert.equal(page.count, 3);
  assert.equal(page.nextOffset, 'next+/=cursor');
  assert.deepEqual(page.voters[0], {
    user: { id: 77, username: 'ari', firstName: 'Ari', lastName: 'Lee', isBot: false, phone: undefined }, date: 123,
  });
  publicVoters = false;
  await assert.rejects(driver.getPollVotes(-100123, 55, 0), /此投票未公开投票者/);
  assert.equal(calls.length, 1);
});

test('poll voter endpoint validates the query and dispatches to the requested account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params }); return { count: 1, voters: [] };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/poll-votes`;
    assert.equal((await fetch(`${base}?chatId=1&messageId=9&optionIndex=0&limit=101`)).status, 400);
    const response = await fetch(`${base}?chatId=-100123&messageId=55&optionIndex=1&offset=opaque%2Bcursor&limit=25`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1, voters: [] });
    assert.deepEqual(calls, [{ action: 'get_poll_votes', params: {
      chatId: -100123, messageId: 55, optionIndex: 1, offset: 'opaque+cursor', limit: 25,
    } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('poll results expose a voter-list action only for visible public results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('function renderPollCardHtml(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    inlineJsArg: value => JSON.stringify(value),
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  vm.runInContext(`${source.slice(start, end + 2)}\nthis.render = renderPollCardHtml;`, context);
  const publicResults = context.render({ publicVoters: true, closed: true, options: [{ text: '<choice>', voters: 2 }] }, 55, -100123);
  assert.match(publicResults, /class="poll-voters-link"/);
  assert.match(publicResults, /showPollVoters\(-100123, 55, 0/);
  assert.match(publicResults, /&lt;choice&gt;/);
  const anonymousResults = context.render({ publicVoters: false, closed: true, options: [{ text: 'choice', voters: 2 }] }, 55, -100123);
  assert.doesNotMatch(anonymousResults, /poll-voters-link/);
  const hiddenResults = context.render({ publicVoters: true, closed: false, options: [{ text: 'choice', voters: 2 }] }, 55, -100123);
  assert.doesNotMatch(hiddenResults, /poll-voters-link/);
  const ownOpenPoll = context.render({ publicVoters: false, closed: false, options: [{ text: 'choice', voters: 0 }] }, 56, -100123, true);
  assert.match(ownOpenPoll, /closeTelegramPoll\(-100123, 56\)/);
  const otherOpenPoll = context.render({ publicVoters: false, closed: false, options: [{ text: 'choice', voters: 0 }] }, 56, -100123, false);
  assert.doesNotMatch(otherOpenPoll, /停止投票/);
  const adminOpenPoll = context.render({ publicVoters: false, closed: false, canClose: true, options: [{ text: 'choice', voters: 0 }] }, 57, -100123, false);
  assert.match(adminOpenPoll, /closeTelegramPoll\(-100123, 57\)/);
});

test('poll voter dialog paginates Telegram cursors and discards responses after chat changes', async () => {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.handlers = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return this.nodes?.[selector] || null; }
  }
  const modal = new Element();
  const title = new Element(), list = new Element(), status = new Element(), more = new Element(), close = new Element();
  modal.nodes = { '[data-poll-voters-title]': title, '[data-poll-voters-list]': list,
    '[data-poll-voters-status]': status, '[data-poll-voters-more]': more, '[data-poll-voters-close]': close };
  const nodes = new Map([['poll-voters-modal', modal]]);
  const document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element() };
  const state = { clientSelectedInstance: 'a', clientActiveChatId: -100123, chatSelectionVersion: 4,
    clientMessages: [{ id: 55, media: { publicVoters: true, options: [{ text: 'Choice' }] } }] };
  const requests = [];
  const context = vm.createContext({ state, document, window: {}, URLSearchParams, encodeURIComponent,
    api: url => new Promise(resolve => requests.push({ url, resolve })),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('let pollVotersDialogState = null;');
  const end = source.indexOf('\nfunction renderPollCardHtml(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.show = showPollVoters;`, context);
  const opening = context.show(-100123, 55, 0, 'Choice');
  assert.equal(modal.hidden, false);
  assert.match(requests[0].url, /account\/poll-votes\?chatId=-100123&messageId=55&optionIndex=0&limit=50$/);
  requests[0].resolve({ count: 2, nextOffset: 'opaque+/cursor', voters: [{
    user: { id: 77, firstName: '<Ari>', username: 'ari' }, date: 123,
  }] });
  await opening;
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].children[0].textContent, '<Ari>');
  assert.equal(more.hidden, false);
  more.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(requests[1].url, /offset=opaque%2B%2Fcursor/);
  requests[1].resolve({ count: 2, voters: [{ user: { id: 78, firstName: 'Bea' }, date: 124 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.children.length, 2);
  assert.equal(more.hidden, true);

  const nextOpen = context.show(-100123, 55, 0, 'Choice');
  state.clientActiveChatId = 42;
  state.chatSelectionVersion++;
  requests[2].resolve({ count: 1, voters: [{ user: { id: 99, firstName: 'Stale' }, date: 125 }] });
  await nextOpen;
  assert.equal(modal.hidden, true);
  assert.equal(list.children.length, 0);
});

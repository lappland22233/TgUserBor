'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const http = require('node:http');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function fixture() {
  const calls = [];
  const channel = new Api.InputChannel({ channelId: bigInt(1234567890), accessHash: bigInt(5) });
  const user = new Api.InputUser({ userId: bigInt(77), accessHash: bigInt(8) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async peer => BigInt(peer.toString()) < 0n ? channel : user,
    invoke: async request => {
      calls.push(request);
      if (request.className === 'messages.GetChatInviteImporters') return {
        count: 1,
        importers: [{ userId: bigInt(77), date: 123, about: 'I would like to join', requested: true }],
        users: [{ id: bigInt(77), firstName: 'Alice', username: 'alice' }],
      };
      return {};
    },
  };
  return { driver, calls };
}

test('join request pages use Telegram cursors and decisions call HideChatJoinRequest', async () => {
  const { driver, calls } = fixture();
  const page = await driver.getJoinRequests(-1001234567890, { date: 100, userId: 77 }, 1, 'alice');
  assert.equal(calls[0].className, 'messages.GetChatInviteImporters');
  assert.equal(calls[0].requested, true); assert.equal(calls[0].offsetDate, 100); assert.equal(calls[0].limit, 1); assert.equal(calls[0].q, 'alice');
  assert.deepEqual(page.requests[0], {
    user: { id: 77, username: 'alice', firstName: 'Alice', lastName: undefined, isBot: false, phone: undefined },
    date: 123, about: 'I would like to join',
  });
  assert.deepEqual(page.nextCursor, { date: 123, userId: 77 });
  await driver.decideJoinRequest(-1001234567890, 77, true);
  await driver.decideJoinRequest(-1001234567890, 77, false);
  await driver.decideAllJoinRequests(-1001234567890, true);
  await driver.decideAllJoinRequests(-1001234567890, false);
  assert.equal(calls[1].className, 'messages.HideChatJoinRequest');
  assert.equal(calls[1].approved, true); assert.equal(calls[2].approved, false);
  assert.equal(calls[3].className, 'messages.HideAllChatJoinRequests');
  assert.equal(calls[3].approved, true); assert.equal(calls[4].approved, false);
  await assert.rejects(driver.decideJoinRequest(123, 77, true), /Invalid join request decision/);
});

test('join request HTTP routes validate cursors and preserve approve/reject decisions', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, params) => {
    calls.push({ action, params }); return action === 'get_join_requests' ? { count: 0, requests: [] } : {};
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/join-requests`;
    assert.equal((await fetch(`${base}?chatId=-100123&date=100`)).status, 400);
    assert.equal((await fetch(`${base}?chatId=-100123&date=100&userId=77&limit=20&query=alice`)).status, 200);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, userId: 77, approved: true }) })).status, 200);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, userId: 77, approved: 'yes' }) })).status, 400);
    assert.equal((await fetch(`${base}/all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: -100123, approved: false }) })).status, 200);
    assert.deepEqual(calls.map(call => call.action), ['get_join_requests', 'decide_join_request', 'decide_all_join_requests']);
    assert.deepEqual(calls[0].params.cursor, { date: 100, userId: 77 });
    assert.equal(calls[1].params.approved, true);
    assert.equal(calls[2].params.approved, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

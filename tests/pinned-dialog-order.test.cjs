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

test('pinned dialog order uses Telegram peer dialogs and refuses partial lists', async () => {
  const requests = [], inputPeers = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => BigInt(id);
  driver.client = {
    invoke: async request => {
      requests.push(request);
      if (request.className === 'messages.GetPinnedDialogs') return { dialogs: [
        new Api.Dialog({ peer: new Api.PeerUser({ userId: bigInt(11) }), topMessage: 1, pinned: true }),
        new Api.Dialog({ peer: new Api.PeerUser({ userId: bigInt(22) }), topMessage: 2, pinned: true }),
      ] };
      return true;
    },
    getInputEntity: async id => {
      inputPeers.push(String(id));
      const userId = bigInt(String(id));
      return new Api.InputPeerUser({ userId, accessHash: bigInt(1000 + Number(id)) });
    },
  };
  assert.deepEqual(await driver.getPinnedDialogIds(0), [11, 22]);
  requests.length = 0;
  await assert.rejects(driver.reorderPinnedDialogs([22], 0), /置顶会话列表已变化/);
  assert.equal(requests.length, 1);
  requests.length = 0;
  await driver.reorderPinnedDialogs([22, 11], 0);
  assert.equal(requests[0].className, 'messages.GetPinnedDialogs');
  assert.equal(requests[1].className, 'messages.ReorderPinnedDialogs');
  assert.deepEqual(inputPeers, ['22', '11']);
  assert.equal(requests[1].folderId, 0);
  assert.deepEqual(requests[1].order.map(peer => peer.peer.userId.toString()), ['22', '11']);
  await assert.rejects(driver.reorderPinnedDialogs([11, 11], 0), /Invalid pinned dialog order/);
});

test('pinned dialog routes validate and dispatch a complete ordering', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_pinned_dialogs' ? [11, 22] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/pinned-dialogs`;
    assert.equal((await fetch(`${base}?folderId=2`)).status, 400);
    const list = await fetch(`${base}?folderId=1`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [11, 22]);
    assert.equal((await fetch(`${base}/order`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 1, order: [11, 11] }) })).status, 400);
    const response = await fetch(`${base}/order`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 1, order: [22, 11] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      { action: 'get_pinned_dialogs', payload: { folderId: 1 } },
      { action: 'reorder_pinned_dialogs', payload: { folderId: 1, order: [22, 11] } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('pin reorder swaps adjacent dialogs and ignores late account or selection results', async () => {
  const state = { clientSelectedInstance: 'a', chatSelectionVersion: 4 };
  const requests = [], toasts = [], reloads = [];
  const context = vm.createContext({ state,
    api: (url, method, body) => new Promise(resolve => requests.push({ url, method, body, resolve })),
    showToast: message => toasts.push(message), loadClientDialogs: () => reloads.push(true), encodeURIComponent,
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/gui/web/app.js'), 'utf8');
  const start = source.indexOf('async function movePinnedDialog(');
  const end = source.indexOf('\nfunction isDialogMuted(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nthis.move = movePinnedDialog;`, context);
  const moving = context.move(22, -1, 1, 'a', 4);
  assert.match(requests[0].url, /pinned-dialogs\?folderId=1$/);
  requests[0].resolve([11, 22, 33]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(requests[1].body.order), [22, 11, 33]);
  assert.equal(requests[1].body.folderId, 1);
  requests[1].resolve({ success: true });
  await moving;
  assert.equal(reloads.length, 1);
  assert.deepEqual(toasts, ['置顶顺序已更新']);

  const stale = context.move(22, 1, 0, 'a', 4);
  state.clientSelectedInstance = 'b';
  requests[2].resolve([11, 22]);
  await stale;
  assert.equal(requests.length, 3);
  assert.equal(reloads.length, 1);
  assert.deepEqual(toasts, ['置顶顺序已更新']);
});

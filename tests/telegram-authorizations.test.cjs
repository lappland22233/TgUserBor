'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram authorizations expose device metadata but not the current session hash', async () => {
  const requests = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    requests.push(request);
    return { authorizationTtlDays: 180, authorizations: [
      new Api.Authorization({ current: true, hash: bigInt(111), deviceModel: 'Web', platform: 'Linux',
        systemVersion: '6', apiId: 1, appName: 'TGuserBOT', appVersion: '1', dateCreated: 10, dateActive: 20, ip: '127.0.0.1', country: 'Local', region: '' }),
      new Api.Authorization({ current: false, hash: bigInt(222), deviceModel: 'Phone', platform: 'Android',
        systemVersion: '15', apiId: 1, appName: 'Telegram Android', appVersion: '11', dateCreated: 11, dateActive: 21, ip: '192.0.2.1', country: 'Example', region: 'Region' }),
    ] };
  } };
  const result = await driver.getTelegramAuthorizations();
  assert.equal(requests[0].className, 'account.GetAuthorizations');
  assert.equal(result.authorizationTtlDays, 180);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].current, true);
  assert.equal(result.sessions[0].hash, undefined);
  assert.equal(result.sessions[0].deviceModel, 'Web');
  assert.equal(result.sessions[1].hash, '222');
  assert.equal(result.sessions[1].country, 'Example');
});

test('session revocation uses Telegram authorization methods and validates hashes', async () => {
  const requests = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { requests.push(request); return true; } };
  await driver.revokeTelegramAuthorization('922337203685477580');
  await driver.revokeOtherTelegramAuthorizations();
  assert.equal(requests[0].className, 'account.ResetAuthorization');
  assert.equal(requests[0].hash.toString(), '922337203685477580');
  assert.equal(requests[1].className, 'auth.ResetAuthorizations');
  await driver.revokeTelegramAuthorization('-22');
  assert.equal(requests[2].hash.toString(), '-22');
  await assert.rejects(driver.revokeTelegramAuthorization('999999999999999999999999'), /Invalid Telegram authorization hash/);
});

test('authorization routes reject invalid hashes and dispatch per-account revocations', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_telegram_authorizations') return { authorizationTtlDays: 30, sessions: [] };
    return undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const listing = await fetch(`${base}/authorizations`);
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), { authorizationTtlDays: 30, sessions: [] });
    assert.equal((await fetch(`${base}/authorization/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: 'not-a-hash' }) })).status, 400);
    assert.equal((await fetch(`${base}/authorization/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: '222' }) })).status, 200);
    assert.equal((await fetch(`${base}/authorizations/revoke-others`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_telegram_authorizations', payload: undefined },
      { action: 'revoke_telegram_authorization', payload: { hash: '222' } },
      { action: 'revoke_other_telegram_authorizations', payload: undefined },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

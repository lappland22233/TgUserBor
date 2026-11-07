'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('global privacy settings expose current Telegram booleans without account metadata', async () => {
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async value => {
    request = value;
    return new Api.GlobalPrivacySettings({
      archiveAndMuteNewNoncontactPeers: true, keepArchivedUnmuted: false, keepArchivedFolders: true,
      hideReadMarks: true, newNoncontactPeersRequirePremium: false,
    });
  } };
  const settings = await driver.getAccountGlobalPrivacySettings();
  assert.ok(request instanceof Api.account.GetGlobalPrivacySettings);
  assert.deepEqual(settings.map(({ key, value }) => [key, value]), [
    ['archiveNewNoncontacts', true], ['keepArchivedUnmuted', false], ['keepArchivedFolders', true],
    ['hideReadMarks', true], ['requirePremiumForNewNoncontacts', false],
  ]);
  assert.equal(settings[0].title, '自动归档陌生人');
});

test('changing one global privacy option preserves the other values returned by Telegram', async () => {
  const calls = [];
  const current = new Api.GlobalPrivacySettings({
    archiveAndMuteNewNoncontactPeers: true, keepArchivedUnmuted: false, keepArchivedFolders: true,
    hideReadMarks: false, newNoncontactPeersRequirePremium: true,
  });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetGlobalPrivacySettings) return current;
    return true;
  } };
  await driver.setAccountGlobalPrivacySetting('hideReadMarks', true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof Api.account.GetGlobalPrivacySettings);
  assert.ok(calls[1] instanceof Api.account.SetGlobalPrivacySettings);
  assert.deepEqual([
    calls[1].settings.archiveAndMuteNewNoncontactPeers, calls[1].settings.keepArchivedUnmuted,
    calls[1].settings.keepArchivedFolders, calls[1].settings.hideReadMarks,
    calls[1].settings.newNoncontactPeersRequirePremium,
  ], [true, false, true, true, true]);
  await assert.rejects(driver.setAccountGlobalPrivacySetting('unknown', true), /Invalid Telegram global privacy setting/);
  await assert.rejects(driver.setAccountGlobalPrivacySetting('hideReadMarks', 'yes'), /Invalid Telegram global privacy setting/);
  assert.equal(calls.length, 2);
});

test('global privacy routes validate values and dispatch only to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_account_global_privacy_settings' ? [{ key: 'hideReadMarks', value: false }] : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/instances/a/account/global-privacy-settings`;
    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), [{ key: 'hideReadMarks', value: false }]);
    const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ key: 'bad', value: true })).status, 400);
    assert.equal((await post({ key: 'hideReadMarks', value: 'true' })).status, 400);
    assert.equal((await post({ key: 'hideReadMarks', value: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_account_global_privacy_settings', payload: undefined },
      { action: 'set_account_global_privacy_setting', payload: { key: 'hideReadMarks', value: true } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

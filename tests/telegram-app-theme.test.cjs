'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function theme(slug, values = {}) {
  return { className: 'Theme', id: bigInt(1), accessHash: bigInt(2), slug, title: values.title || slug,
    emoticon: values.emoticon || '', settings: [{ className: 'ThemeSettings',
      baseTheme: { className: values.dark ? 'BaseThemeNight' : 'BaseThemeDay' },
      accentColor: values.accentColor ?? 0x123456, messageColors: values.messageColors || [0xabcdef] }] };
}

test('Telegram app theme catalog maps safe slugs and color metadata and caches the server page', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    return { className: 'account.Themes', hash: bigInt(2), themes: [
      theme('blue', { title: 'Blue', emoticon: '🌊', dark: true, messageColors: [0x112233, -1, 0x445566] }),
      theme('blue'), theme('../unsafe'),
    ] };
  } };
  assert.deepEqual(await driver.getTelegramAppThemes(), [
    { slug: 'blue', title: 'Blue', emoticon: '🌊', dark: true, accentColor: 0x123456, messageColors: [0x112233, 0x445566] },
  ]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.account.GetThemes);
  assert.equal(calls[0].format, 'android');
});

test('installing Telegram app themes accepts only a current catalog slug', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetThemes) return { className: 'account.Themes', hash: bigInt(1), themes: [theme('blue')] };
    return true;
  } };
  assert.deepEqual(await driver.installTelegramAppTheme('blue', true), { slug: 'blue', dark: true });
  const installed = calls.find(request => request instanceof Api.account.InstallTheme);
  assert.ok(installed);
  assert.equal(installed.theme.slug, 'blue');
  assert.equal(installed.dark, true);
  assert.equal(installed.format, 'android');
  await assert.rejects(driver.installTelegramAppTheme('missing', false), /unavailable/);
  await assert.rejects(driver.installTelegramAppTheme('../bad', true), /Invalid Telegram theme/);
});

test('Telegram app theme routes are account-scoped and validate install input', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_telegram_app_themes' ? [{ slug: 'blue', title: 'Blue' }] : { slug: payload.slug, dark: payload.dark };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const list = await fetch(`${base}/app-themes`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [{ slug: 'blue', title: 'Blue' }]);
    const install = body => fetch(`${base}/app-theme`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await install({ slug: '../bad', dark: true })).status, 400);
    assert.equal((await install({ slug: 'blue', dark: 'yes' })).status, 400);
    assert.equal((await install({ slug: 'blue', dark: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_telegram_app_themes', payload: undefined },
      { action: 'install_telegram_app_theme', payload: { slug: 'blue', dark: true } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

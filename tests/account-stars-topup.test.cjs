'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

const option = () => new Api.StarsTopupOption({ stars: bigInt(100), storeProduct: 'stars_100', currency: 'USD', amount: bigInt(199), extended: false });
const paymentForm = () => new Api.payments.PaymentFormStars({ formId: bigInt(88), botId: bigInt(77), title: 'Telegram Stars', description: 'Top up your balance',
  invoice: new Api.Invoice({ currency: 'XTR', prices: [new Api.LabeledPrice({ label: '100 Stars', amount: bigInt(100) })] }), users: [] });

test('Stars top-up uses a fresh Telegram option and a one-use confirmed Stars payment form', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.starsTopupOptions = new Map();
  driver.pendingStarsTopups = new Map();
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.GetStarsTopupOptions) return [option()];
    if (request instanceof Api.payments.GetPaymentForm) return paymentForm();
    return Object.create(Api.payments.PaymentResult.prototype);
  } };
  const options = await driver.getAccountStarsTopupOptions();
  assert.equal(options.length, 1);
  assert.match(options[0].id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual({ stars: options[0].stars, currency: options[0].currency, amount: options[0].amount, extended: options[0].extended },
    { stars: '100', currency: 'USD', amount: '199', extended: false });
  const prepared = await driver.prepareAccountStarsTopup(options[0].id);
  assert.match(prepared.token, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual({ stars: prepared.stars, currency: prepared.currency, amount: prepared.amount, title: prepared.title },
    { stars: '100', currency: 'USD', amount: '199', title: 'Telegram Stars' });
  const topupRequest = calls.find(request => request instanceof Api.payments.GetPaymentForm);
  assert.ok(topupRequest.invoice instanceof Api.InputInvoiceStars);
  assert.ok(topupRequest.invoice.purpose instanceof Api.InputStorePaymentStarsTopup);
  assert.equal(topupRequest.invoice.purpose.stars.toString(), '100');
  assert.equal(topupRequest.invoice.purpose.currency, 'USD');
  assert.equal(topupRequest.invoice.purpose.amount.toString(), '199');
  assert.deepEqual(await driver.confirmAccountStarsTopup(prepared.token), { stars: '100' });
  const send = calls.at(-1);
  assert.ok(send instanceof Api.payments.SendStarsForm);
  assert.equal(send.formId.toString(), '88');
  assert.ok(send.invoice instanceof Api.InputInvoiceStars);
  await assert.rejects(driver.confirmAccountStarsTopup(prepared.token), /expired/);
  await assert.rejects(driver.prepareAccountStarsTopup(options[0].id), /expired/);
});

test('Stars top-up rejects changed options, mismatched invoice totals, and unsafe verification URLs', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.starsTopupOptions = new Map();
  driver.pendingStarsTopups = new Map();
  let remoteOption = option();
  let result = Object.create(Api.payments.PaymentVerificationNeeded.prototype);
  result.url = 'https://pay.example/verify';
  driver.client = { invoke: async request => {
    if (request instanceof Api.payments.GetStarsTopupOptions) return [remoteOption];
    if (request instanceof Api.payments.GetPaymentForm) return paymentForm();
    return result;
  } };
  const entry = { stars: '100', currency: 'USD', amount: '199', storeProduct: 'stars_100', extended: false, expiresAt: Date.now() + 60_000 };
  driver.starsTopupOptions.set('x'.repeat(32), entry);
  remoteOption = new Api.StarsTopupOption({ stars: bigInt(200), storeProduct: 'stars_200', currency: 'USD', amount: bigInt(299), extended: false });
  await assert.rejects(driver.prepareAccountStarsTopup('x'.repeat(32)), /price changed/);
  remoteOption = option();
  driver.starsTopupOptions.set('y'.repeat(32), { ...entry, expiresAt: Date.now() + 60_000 });
  const invoiceForm = paymentForm();
  invoiceForm.invoice.prices[0].amount = bigInt(99);
  driver.client.invoke = async request => request instanceof Api.payments.GetStarsTopupOptions ? [option()] : invoiceForm;
  driver.starsTopupOptions.set('z'.repeat(32), { ...entry, expiresAt: Date.now() + 60_000 });
  await assert.rejects(driver.prepareAccountStarsTopup('z'.repeat(32)), /amount changed/);
  driver.client.invoke = async request => {
    if (request instanceof Api.payments.GetStarsTopupOptions) return [option()];
    if (request instanceof Api.payments.GetPaymentForm) return paymentForm();
    return result;
  };
  driver.starsTopupOptions.set('w'.repeat(32), { ...entry, expiresAt: Date.now() + 60_000 });
  const prepared = await driver.prepareAccountStarsTopup('w'.repeat(32));
  assert.deepEqual(await driver.confirmAccountStarsTopup(prepared.token), { stars: '100', verificationUrl: 'https://pay.example/verify' });
  result.url = 'javascript:alert(1)';
  driver.starsTopupOptions.set('v'.repeat(32), { ...entry, expiresAt: Date.now() + 60_000 });
  const unsafePrepared = await driver.prepareAccountStarsTopup('v'.repeat(32));
  await assert.rejects(driver.confirmAccountStarsTopup(unsafePrepared.token), /unsafe payment verification URL/);
});

test('Stars top-up HTTP routes keep option IDs and one-time tokens scoped to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_account_stars_topup_options') return [{ id: 'i'.repeat(32), stars: '100', currency: 'USD', amount: '199', extended: false }];
    if (action === 'prepare_account_stars_topup') return { token: 't'.repeat(32), stars: '100', currency: 'USD', amount: '199', title: 'Top up', description: 'Confirm' };
    return { stars: '100', verificationUrl: 'https://payments.example/verify' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stars-topup`;
  const post = (route, body) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const options = await fetch(`${base}-options`);
    assert.equal(options.status, 200);
    assert.deepEqual(await options.json(), [{ id: 'i'.repeat(32), stars: '100', currency: 'USD', amount: '199', extended: false }]);
    assert.equal((await post('prepare', { optionId: 'short' })).status, 400);
    const prepared = await post('prepare', { optionId: 'i'.repeat(32) });
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), { token: 't'.repeat(32), stars: '100', currency: 'USD', amount: '199', title: 'Top up', description: 'Confirm' });
    assert.equal((await post('confirm', { token: 'short' })).status, 400);
    const confirmed = await post('confirm', { token: 't'.repeat(32) });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { stars: '100', verificationUrl: 'https://payments.example/verify' });
    assert.deepEqual(calls, [
      { action: 'get_account_stars_topup_options', payload: undefined },
      { action: 'prepare_account_stars_topup', payload: { optionId: 'i'.repeat(32) } },
      { action: 'confirm_account_stars_topup', payload: { token: 't'.repeat(32) } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

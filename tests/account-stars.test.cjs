'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('Telegram Stars balance and transaction history preserve opaque pagination', async () => {
  const status = new Api.payments.StarsStatus({
    balance: new Api.StarsAmount({ amount: bigInt(1234), nanos: 0 }),
    history: [new Api.StarsTransaction({ id: 'opaque-tx', stars: new Api.StarsAmount({ amount: bigInt(25), nanos: 0 }),
      date: 1700000000, peer: new Api.StarsTransactionPeerAppStore(), title: 'Gift', description: 'A gift' })],
    nextOffset: 'next cursor', chats: [], users: [],
  });
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async value => { request = value; return status; } };
  const result = await driver.getAccountStars('opaque cursor', 25);
  assert.ok(request instanceof Api.payments.GetStarsTransactions);
  assert.ok(request.peer instanceof Api.InputPeerSelf);
  assert.equal(request.offset, 'opaque cursor');
  assert.equal(request.limit, 25);
  assert.deepEqual(result, {
    balance: { amount: '1234', nanos: 0 },
    transactions: [{ id: 'opaque-tx', stars: { amount: '25', nanos: 0 }, date: 1700000000,
      title: 'Gift', description: 'A gift', kind: 'StarsTransactionPeerAppStore', status: 'complete' }],
    nextOffset: 'next cursor',
  });
  await assert.rejects(driver.getAccountStars('x'.repeat(513), 20), /Invalid Telegram Stars pagination/);
  await assert.rejects(driver.getAccountStars('', 101), /Invalid Telegram Stars pagination/);
});

test('Telegram Star Gifts catalog maps price, availability and sticker cache identifiers', async () => {
  const sticker = new Api.Document({ id: bigInt(500), accessHash: bigInt(-88), fileReference: Buffer.from([1, 2]), date: 1,
    mimeType: 'image/webp', size: bigInt(1024), dcId: 2,
    attributes: [new Api.DocumentAttributeSticker({ alt: '🎁', stickerset: new Api.InputStickerSetEmpty() })] });
  const gift = new Api.StarGift({ id: bigInt(99), sticker, stars: bigInt(15), convertStars: bigInt(5), limited: true,
    soldOut: false, availabilityRemains: 7, availabilityTotal: 100 });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    assert.ok(request instanceof Api.payments.GetStarGifts);
    return new Api.payments.StarGifts({ hash: 1, gifts: [gift] });
  } };
  assert.deepEqual(await driver.getAccountStarGifts(), [{
    id: '99', sticker: { id: '500', accessHash: '-88', fileReference: 'AQI=', emoji: '🎁' },
    stars: '15', convertStars: '5', upgradeStars: undefined, limited: true, soldOut: false,
    availabilityRemains: 7, availabilityTotal: 100,
  }]);
});

test('sending a Telegram Star Gift confirms the current catalog item through the Stars payment form', async () => {
  const sticker = new Api.Document({ id: bigInt(500), accessHash: bigInt(88), fileReference: Buffer.from([1]), date: 1,
    mimeType: 'image/webp', size: bigInt(100), dcId: 2,
    attributes: [new Api.DocumentAttributeSticker({ alt: '🎁', stickerset: new Api.InputStickerSetEmpty() })] });
  const gift = new Api.StarGift({ id: bigInt(99), sticker, stars: bigInt(15), convertStars: bigInt(5), upgradeStars: bigInt(7) });
  const inputInvoice = new Api.InputInvoiceStarGift({ peer: new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) }), giftId: bigInt(99), hideName: true, includeUpgrade: true });
  const invoice = new Api.Invoice({ currency: 'XTR', prices: [new Api.LabeledPrice({ label: 'Gift', amount: bigInt(15) }), new Api.LabeledPrice({ label: 'Upgrade', amount: bigInt(7) })] });
  const form = new Api.payments.PaymentFormStarGift({ formId: bigInt(123), invoice });
  const paymentResult = Object.create(Api.payments.PaymentResult.prototype);
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.pendingStarGiftPayments = new Map();
  driver.resolvePeer = id => { assert.equal(id, 42); return inputInvoice.peer; };
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.GetStarGifts) return new Api.payments.StarGifts({ hash: 1, gifts: [gift] });
    if (request instanceof Api.payments.GetPaymentForm) return form;
    return paymentResult;
  } };
  const prepared = await driver.prepareAccountStarGiftPayment(42, '99', { hideName: true, includeUpgrade: true });
  assert.equal(prepared.stars, '22');
  assert.match(prepared.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(calls[0] instanceof Api.payments.GetStarGifts);
  assert.ok(calls[1] instanceof Api.payments.GetPaymentForm);
  assert.equal(calls[1].invoice.giftId.toString(), '99');
  assert.equal(calls[1].invoice.hideName, true);
  assert.equal(calls[1].invoice.includeUpgrade, true);
  assert.deepEqual(await driver.confirmAccountStarGiftPayment(prepared.token, 42, '99'), { stars: '22' });
  assert.ok(calls[2] instanceof Api.payments.SendStarsForm);
  assert.equal(calls[2].formId.toString(), '123');
  assert.ok(calls[2].invoice instanceof Api.InputInvoiceStarGift);
  assert.equal(calls[2].invoice.giftId.toString(), '99');
  await assert.rejects(driver.confirmAccountStarGiftPayment(prepared.token, 42, '99'), /expired or does not match/);
  await assert.rejects(driver.prepareAccountStarGiftPayment(-10042, '99'), /Invalid Star Gift request/);
  assert.equal(calls.length, 3);
});

test('Star Gift sending rechecks Telegram availability and upgrade eligibility', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.pendingStarGiftPayments = new Map();
  const sticker = new Api.Document({ id: bigInt(500), accessHash: bigInt(88), fileReference: Buffer.from([1]), date: 1,
    mimeType: 'image/webp', size: bigInt(100), dcId: 2, attributes: [] });
  driver.client = { invoke: async request => new Api.payments.StarGifts({ hash: 1, gifts: [
    new Api.StarGift({ id: bigInt(99), sticker, stars: bigInt(15), convertStars: bigInt(5), soldOut: true }),
  ] }) };
  await assert.rejects(driver.prepareAccountStarGiftPayment(42, '99'), /已售罄/);
  await assert.rejects(driver.prepareAccountStarGiftPayment(42, 'not-an-id'), /Invalid Star Gift request/);
});

test('Telegram Stars subscriptions map cursor state and require explicit cancellation choices', async () => {
  const subscription = new Api.StarsSubscription({ id: 'sub opaque', peer: new Api.PeerUser({ userId: bigInt(10) }),
    untilDate: 1700000000, pricing: new Api.StarsSubscriptionPricing({ period: 2592000, amount: bigInt(250) }),
    canceled: false, canRefulfill: true, missingBalance: false, title: 'Premium' });
  const response = new Api.payments.StarsStatus({ balance: new Api.StarsAmount({ amount: bigInt(1000), nanos: 0 }),
    subscriptions: [subscription], subscriptionsNextOffset: 'cursor-2', chats: [], users: [] });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => { calls.push(request); return request instanceof Api.payments.GetStarsSubscriptions ? response : true; } };
  assert.deepEqual(await driver.getAccountStarsSubscriptions('cursor-1'), {
    subscriptions: [{ id: 'sub opaque', title: 'Premium', canceled: false, canRefulfill: true, missingBalance: false,
      untilDate: 1700000000, amount: '250', period: 2592000 }], nextOffset: 'cursor-2',
  });
  assert.ok(calls[0] instanceof Api.payments.GetStarsSubscriptions);
  assert.equal(calls[0].offset, 'cursor-1');
  await driver.setAccountStarsSubscriptionCanceled('sub opaque', true);
  assert.ok(calls[1] instanceof Api.payments.ChangeStarsSubscription);
  assert.equal(calls[1].subscriptionId, 'sub opaque');
  assert.equal(calls[1].canceled, true);
  assert.equal(calls[1].peer.className, 'InputPeerSelf');
  await assert.rejects(driver.setAccountStarsSubscriptionCanceled('', true), /Invalid Telegram Stars subscription/);
});

test('Telegram Stars history route validates pagination and targets one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_account_star_gifts') return [{ id: 'gift-1' }];
    if (action === 'prepare_account_star_gift') return { token: 't'.repeat(32), stars: '22' };
    if (action === 'confirm_account_star_gift') return { stars: '22' };
    if (action === 'get_account_stars_subscriptions') return { subscriptions: [{ id: 'sub-1' }], nextOffset: '' };
    return { balance: { amount: '10', nanos: 0 }, transactions: [], nextOffset: '' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stars`;
    assert.equal((await fetch(`${base}?limit=101`)).status, 400);
    assert.equal((await fetch(`${base}?offset=${'x'.repeat(513)}`)).status, 400);
    const response = await fetch(`${base}?offset=${encodeURIComponent('cursor & opaque')}&limit=30`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { balance: { amount: '10', nanos: 0 }, transactions: [], nextOffset: '' });
    const gifts = await fetch(`http://127.0.0.1:${server.address().port}/api/instances/a/account/star-gifts`);
    assert.equal(gifts.status, 200);
    assert.deepEqual(await gifts.json(), [{ id: 'gift-1' }]);
    const prepareGiftUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/star-gifts/prepare`;
    const prepareGift = body => fetch(prepareGiftUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await prepareGift({ chatId: -100, giftId: '99' })).status, 400);
    assert.equal((await prepareGift({ chatId: 42, giftId: '99', hideName: 'yes' })).status, 400);
    const prepared = await prepareGift({ chatId: 42, giftId: '99', hideName: true, includeUpgrade: true });
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), { token: 't'.repeat(32), stars: '22' });
    const confirmGiftUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/star-gifts/confirm`;
    const confirmGift = body => fetch(confirmGiftUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await confirmGift({ chatId: 42, giftId: '99', token: 'short' })).status, 400);
    const giftSent = await confirmGift({ chatId: 42, giftId: '99', token: 't'.repeat(32) });
    assert.equal(giftSent.status, 200);
    assert.deepEqual(await giftSent.json(), { stars: '22' });
    const subscriptionsUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/stars-subscriptions`;
    assert.equal((await fetch(`${subscriptionsUrl}?offset=${'x'.repeat(513)}`)).status, 400);
    const subscriptions = await fetch(subscriptionsUrl);
    assert.equal(subscriptions.status, 200);
    assert.deepEqual(await subscriptions.json(), { subscriptions: [{ id: 'sub-1' }], nextOffset: '' });
    const update = body => fetch(subscriptionsUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await update({ subscriptionId: 'sub-1', canceled: 'yes' })).status, 400);
    assert.equal((await update({ subscriptionId: 'sub-1', canceled: true })).status, 200);
    assert.deepEqual(calls, [
      { action: 'get_account_stars', payload: { offset: 'cursor & opaque', limit: 30 } },
      { action: 'get_account_star_gifts', payload: undefined },
      { action: 'prepare_account_star_gift', payload: { chatId: 42, giftId: '99', hideName: true, includeUpgrade: true } },
      { action: 'confirm_account_star_gift', payload: { chatId: 42, giftId: '99', token: 't'.repeat(32) } },
      { action: 'get_account_stars_subscriptions', payload: { offset: '' } },
      { action: 'set_account_stars_subscription_canceled', payload: { subscriptionId: 'sub-1', canceled: true } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('sticker preview routes accept signed Telegram access hashes and reject malformed locations', async () => {
  const calls = [];
  const manager = { getInstance: () => ({ accountAction: async (action, payload) => { calls.push({ action, payload }); return undefined; } }) };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/sticker-thumb`;
    assert.equal((await fetch(`${base}?docId=0&accessHash=-88`)).status, 400);
    assert.equal((await fetch(`${base}?docId=500&accessHash=9223372036854775808`)).status, 400);
    const url = new URL(base);
    url.searchParams.set('docId', '500'); url.searchParams.set('accessHash', '-88'); url.searchParams.set('fileRef', 'AQI=');
    assert.equal((await fetch(url)).status, 404);
    assert.deepEqual(calls, [{ action: 'get_sticker_thumb', payload: { docId: '500', accessHash: '-88', fileReference: 'AQI=' } }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

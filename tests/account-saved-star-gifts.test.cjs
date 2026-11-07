'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

function makeGift({ msgId = 7, unique = false, unsaved = false, refunded = false, convertStars = 10,
  canUpgrade = false, upgradeStars = 20, transferStars, canExportAt } = {}) {
  const gift = unique
    ? new Api.StarGiftUnique({ id: bigInt(900), title: 'Unique Gift', slug: 'unique-gift', num: 1, attributes: [], availabilityIssued: 1, availabilityTotal: 100 })
    : new Api.StarGift({ id: bigInt(99), sticker: new Api.Document({ id: bigInt(500), accessHash: bigInt(88), fileReference: Buffer.from([1]),
      date: 1, mimeType: 'image/webp', size: bigInt(100), dcId: 2,
      attributes: [new Api.DocumentAttributeSticker({ alt: '🎁', stickerset: new Api.InputStickerSetEmpty() })] }),
      stars: bigInt(15), convertStars: bigInt(convertStars) });
  return new Api.SavedStarGift({ date: 1700000000, gift, msgId, unsaved, refunded, convertStars: bigInt(convertStars),
    canUpgrade, upgradeStars: canUpgrade ? bigInt(upgradeStars) : undefined,
    transferStars: transferStars == null ? undefined : bigInt(transferStars), canExportAt, message: undefined });
}

test('saved Telegram Star Gifts map private action IDs, visibility state, and pagination', async () => {
  const requestGift = makeGift({ msgId: 7 });
  const uniqueGift = makeGift({ msgId: 8, unique: true, convertStars: 0 });
  let request;
  const driver = Object.create(TelegramDriver.prototype);
  driver.savedStarGiftItems = new Map();
  driver.client = { invoke: async value => {
    request = value;
    return new Api.payments.SavedStarGifts({ count: 42, gifts: [requestGift, uniqueGift], nextOffset: 'next-cursor',
      chatNotificationsEnabled: true, chats: [], users: [] });
  } };
  const result = await driver.getAccountSavedStarGifts('cursor', 10);
  assert.ok(request instanceof Api.payments.GetSavedStarGifts);
  assert.ok(request.peer instanceof Api.InputPeerSelf);
  assert.equal(request.offset, 'cursor');
  assert.equal(request.limit, 10);
  assert.equal(result.count, 42);
  assert.equal(result.nextOffset, 'next-cursor');
  assert.equal(result.chatNotificationsEnabled, true);
  assert.equal(result.gifts.length, 2);
  assert.match(result.gifts[0].id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual({ title: result.gifts[0].title, emoji: result.gifts[0].emoji, saved: result.gifts[0].saved,
    unique: result.gifts[0].unique, convertStars: result.gifts[0].convertStars },
  { title: '🎁', emoji: '🎁', saved: true, unique: false, convertStars: '10' });
  assert.deepEqual({ title: result.gifts[1].title, unique: result.gifts[1].unique }, { title: 'Unique Gift', unique: true });
  await assert.rejects(driver.getAccountSavedStarGifts('x'.repeat(513), 20), /Invalid saved Telegram Star Gifts pagination/);
});

test('saved Star Gift writes re-read Telegram state and restrict conversion to convertible regular gifts', async () => {
  const savedGift = makeGift({ msgId: 7 });
  const uniqueGift = makeGift({ msgId: 8, unique: true, convertStars: 0 });
  const refundedGift = makeGift({ msgId: 9, refunded: true });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.savedStarGiftItems = new Map();
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.GetSavedStarGifts) {
      return new Api.payments.SavedStarGifts({ count: 3, gifts: [savedGift, uniqueGift, refundedGift], nextOffset: '', chats: [], users: [] });
    }
    if (request instanceof Api.payments.GetSavedStarGift) {
      const gift = request.stargift[0].msgId === 8 ? uniqueGift : request.stargift[0].msgId === 9 ? refundedGift : savedGift;
      return new Api.payments.SavedStarGifts({ count: 1, gifts: [gift], nextOffset: '', chats: [], users: [] });
    }
    return true;
  } };
  const listed = await driver.getAccountSavedStarGifts();
  const inputId = listed.gifts[0].id;
  assert.deepEqual(await driver.setAccountStarGiftSaved(inputId, false), { saved: false });
  const saveRequest = calls.at(-1);
  assert.ok(saveRequest instanceof Api.payments.SaveStarGift);
  assert.equal(saveRequest.unsave, true);
  assert.ok(saveRequest.stargift instanceof Api.InputSavedStarGiftUser);
  assert.equal(saveRequest.stargift.msgId, 7);
  const refreshed = await driver.getAccountSavedStarGifts();
  assert.deepEqual(await driver.convertAccountStarGift(refreshed.gifts[0].id), { converted: true, stars: '10' });
  const convertRequest = calls.at(-1);
  assert.ok(convertRequest instanceof Api.payments.ConvertStarGift);
  assert.equal(convertRequest.stargift.msgId, 7);
  const finalPage = await driver.getAccountSavedStarGifts();
  await assert.rejects(driver.convertAccountStarGift(finalPage.gifts[1].id), /cannot be converted/);
  await assert.rejects(driver.convertAccountStarGift(finalPage.gifts[2].id), /Refunded Telegram gifts cannot be converted/);
  const refundedPage = await driver.getAccountSavedStarGifts();
  await assert.rejects(driver.setAccountStarGiftSaved(refundedPage.gifts[2].id, false), /Refunded Telegram gifts cannot be changed/);
  await assert.rejects(driver.setAccountStarGiftSaved(finalPage.gifts[0].id, 'yes'), /Invalid saved Telegram Star Gift state/);
});

test('Star Gift upgrades show the current Telegram price and recheck eligibility at confirmation', async () => {
  let gift = makeGift({ msgId: 20, canUpgrade: true, upgradeStars: 25 });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.savedStarGiftItems = new Map();
  driver.pendingStarGiftUpgrades = new Map();
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.GetSavedStarGifts || request instanceof Api.payments.GetSavedStarGift) {
      return new Api.payments.SavedStarGifts({ count: 1, gifts: [gift], nextOffset: '', chats: [], users: [] });
    }
    return Object.create(Api.Updates.prototype);
  } };
  const page = await driver.getAccountSavedStarGifts();
  assert.equal(page.gifts[0].canUpgrade, true);
  assert.equal(page.gifts[0].upgradeStars, '25');
  const prepared = await driver.prepareAccountStarGiftUpgrade(page.gifts[0].id);
  assert.equal(prepared.stars, '25');
  assert.match(prepared.token, /^[A-Za-z0-9_-]{32}$/);
  const result = await driver.confirmAccountStarGiftUpgrade(prepared.token, true);
  assert.deepEqual(result, { upgraded: true, stars: '25' });
  const upgrade = calls.at(-1);
  assert.ok(upgrade instanceof Api.payments.UpgradeStarGift);
  assert.ok(upgrade.stargift instanceof Api.InputSavedStarGiftUser);
  assert.equal(upgrade.stargift.msgId, 20);
  assert.equal(upgrade.keepOriginalDetails, true);
  await assert.rejects(driver.confirmAccountStarGiftUpgrade(prepared.token, true), /expired/);

  const changedPage = await driver.getAccountSavedStarGifts();
  const changedPayment = await driver.prepareAccountStarGiftUpgrade(changedPage.gifts[0].id);
  gift = makeGift({ msgId: 20, canUpgrade: true, upgradeStars: 30 });
  await assert.rejects(driver.confirmAccountStarGiftUpgrade(changedPayment.token, false), /price or eligibility changed/);
});

test('Star Gift transfers recheck current fees, wait for confirmation, and bind the destination user', async () => {
  let gift = makeGift({ msgId: 30, transferStars: 15 });
  const calls = [];
  const target = new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(99) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.savedStarGiftItems = new Map();
  driver.pendingStarGiftTransfers = new Map();
  driver.selfId = 10;
  driver.client = { getInputEntity: async peer => {
    assert.equal(String(peer), '42');
    return target;
  }, invoke: async request => {
    calls.push(request);
    if (request instanceof Api.payments.GetSavedStarGifts || request instanceof Api.payments.GetSavedStarGift) {
      return new Api.payments.SavedStarGifts({ count: 1, gifts: [gift], nextOffset: '', chats: [], users: [] });
    }
    return Object.create(Api.Updates.prototype);
  } };
  const listed = await driver.getAccountSavedStarGifts();
  assert.equal(listed.gifts[0].canTransfer, true);
  assert.equal(listed.gifts[0].transferStars, '15');
  const prepared = await driver.prepareAccountStarGiftTransfer(listed.gifts[0].id, 42);
  assert.equal(prepared.stars, '15');
  assert.match(prepared.token, /^[A-Za-z0-9_-]{32}$/);
  await assert.rejects(driver.confirmAccountStarGiftTransfer(prepared.token, 43), /expired or does not match/);
  const transferred = await driver.confirmAccountStarGiftTransfer(prepared.token, 42);
  assert.deepEqual(transferred, { transferred: true, stars: '15' });
  const request = calls.at(-1);
  assert.ok(request instanceof Api.payments.TransferStarGift);
  assert.equal(request.stargift.msgId, 30);
  assert.equal(request.toId, target);

  const nextPage = await driver.getAccountSavedStarGifts();
  const pending = await driver.prepareAccountStarGiftTransfer(nextPage.gifts[0].id, 42);
  gift = makeGift({ msgId: 30, transferStars: 20 });
  await assert.rejects(driver.confirmAccountStarGiftTransfer(pending.token, 42), /price or eligibility changed/);
});

test('saved Star Gift HTTP routes validate cursors and keep mutations scoped to one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_account_saved_star_gifts') return { count: 1, gifts: [{ id: 'i'.repeat(32), title: 'Gift', emoji: '🎁', date: 1700000000,
      saved: true, unique: false, refunded: false, convertStars: '10', upgradeStars: '25', canUpgrade: true,
      transferStars: '15', canTransfer: true, message: '' }], nextOffset: '', chatNotificationsEnabled: true };
    if (action === 'set_account_star_gift_saved') return { saved: payload.saved };
    if (action === 'prepare_account_star_gift_upgrade') return { token: 'u'.repeat(32), stars: '25' };
    if (action === 'confirm_account_star_gift_upgrade') return { upgraded: true, stars: '25' };
    if (action === 'prepare_account_star_gift_transfer') return { token: 'v'.repeat(32), stars: '15' };
    if (action === 'confirm_account_star_gift_transfer') return { transferred: true, stars: '15' };
    return { converted: true, stars: '10' };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}/api/instances/a/account/saved-star-gifts`;
  const post = (path, body) => fetch(`${root}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${root}?offset=${'x'.repeat(513)}`)).status, 400);
    const page = await fetch(`${root}?offset=cursor&limit=12`);
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), { count: 1, gifts: [{ id: 'i'.repeat(32), title: 'Gift', emoji: '🎁', date: 1700000000,
      saved: true, unique: false, refunded: false, convertStars: '10', upgradeStars: '25', canUpgrade: true,
      transferStars: '15', canTransfer: true, message: '' }], nextOffset: '', chatNotificationsEnabled: true });
    assert.equal((await post('save', { id: 'short', saved: false })).status, 400);
    assert.equal((await post('save', { id: 'i'.repeat(32), saved: false })).status, 200);
    assert.equal((await post('convert', { id: 'short' })).status, 400);
    const converted = await post('convert', { id: 'i'.repeat(32) });
    assert.equal(converted.status, 200);
    assert.deepEqual(await converted.json(), { converted: true, stars: '10' });
    assert.equal((await post('upgrade/prepare', { id: 'short' })).status, 400);
    const preparedUpgrade = await post('upgrade/prepare', { id: 'i'.repeat(32) });
    assert.equal(preparedUpgrade.status, 200);
    assert.deepEqual(await preparedUpgrade.json(), { token: 'u'.repeat(32), stars: '25' });
    assert.equal((await post('upgrade/confirm', { token: 'u'.repeat(32), keepOriginalDetails: 'yes' })).status, 400);
    const upgraded = await post('upgrade/confirm', { token: 'u'.repeat(32), keepOriginalDetails: true });
    assert.equal(upgraded.status, 200);
    assert.deepEqual(await upgraded.json(), { upgraded: true, stars: '25' });
    assert.equal((await post('transfer/prepare', { id: 'i'.repeat(32), chatId: -100 })).status, 400);
    const preparedTransfer = await post('transfer/prepare', { id: 'i'.repeat(32), chatId: 42 });
    assert.equal(preparedTransfer.status, 200);
    assert.deepEqual(await preparedTransfer.json(), { token: 'v'.repeat(32), stars: '15' });
    assert.equal((await post('transfer/confirm', { token: 'v'.repeat(32), chatId: 0 })).status, 400);
    const transferred = await post('transfer/confirm', { token: 'v'.repeat(32), chatId: 42 });
    assert.equal(transferred.status, 200);
    assert.deepEqual(await transferred.json(), { transferred: true, stars: '15' });
    assert.deepEqual(calls, [
      { action: 'get_account_saved_star_gifts', payload: { offset: 'cursor', limit: 12 } },
      { action: 'set_account_star_gift_saved', payload: { id: 'i'.repeat(32), saved: false } },
      { action: 'convert_account_star_gift', payload: { id: 'i'.repeat(32) } },
      { action: 'prepare_account_star_gift_upgrade', payload: { id: 'i'.repeat(32) } },
      { action: 'confirm_account_star_gift_upgrade', payload: { token: 'u'.repeat(32), keepOriginalDetails: true } },
      { action: 'prepare_account_star_gift_transfer', payload: { id: 'i'.repeat(32), chatId: 42 } },
      { action: 'confirm_account_star_gift_transfer', payload: { token: 'v'.repeat(32), chatId: 42 } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

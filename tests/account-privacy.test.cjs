'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('privacy setting reads map base rules and exception counts without exposing exception users', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.key instanceof Api.InputPrivacyKeyPhoneNumber) throw new Error('key unavailable');
    return { rules: [
      new Api.PrivacyValueDisallowUsers({ users: [bigInt(42), bigInt(43)] }),
      new Api.PrivacyValueAllowContacts(),
      new Api.PrivacyValueAllowChatParticipants({ chats: [bigInt(1)] }),
    ], users: [new Api.User({ id: bigInt(42), firstName: 'private name', accessHash: bigInt(99) })] };
  } };
  const result = await driver.getAccountPrivacySettings();
  assert.equal(result.length, 11);
  assert.deepEqual(result[0], { key: 'lastSeen', title: '上线时间', mode: 'contacts', available: true,
    exceptions: { allowedUsers: 0, blockedUsers: 2, allowedChats: 1, blockedChats: 0, otherRules: 0 } });
  assert.equal(result[1].key, 'phoneNumber');
  assert.equal(result[1].available, false);
  assert.equal(Object.hasOwn(result[0], 'users'), false);
  assert.equal(calls[0].key.className, 'InputPrivacyKeyStatusTimestamp');
  assert.equal(calls.at(-1).key.className, 'InputPrivacyKeyAddedByPhone');
});

test('changing a privacy base mode preserves Telegram user, chat and special-rule exceptions', async () => {
  const calls = [];
  const privateUser = new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 7;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetPrivacy) return { users: [privateUser], rules: [
      new Api.PrivacyValueDisallowUsers({ users: [bigInt(42)] }),
      new Api.PrivacyValueAllowContacts(),
      new Api.PrivacyValueAllowChatParticipants({ chats: [bigInt(123)] }),
      new Api.PrivacyValueAllowBots(),
    ] };
    return { rules: [], users: [] };
  } };
  await driver.setAccountPrivacySetting('lastSeen', 'everybody');
  assert.equal(calls.length, 2);
  assert.ok(calls[1] instanceof Api.account.SetPrivacy);
  assert.equal(calls[1].key.className, 'InputPrivacyKeyStatusTimestamp');
  assert.deepEqual(calls[1].rules.map(rule => rule.className), [
    'InputPrivacyValueDisallowUsers', 'InputPrivacyValueAllowAll',
    'InputPrivacyValueAllowChatParticipants', 'InputPrivacyValueAllowBots',
  ]);
  assert.equal(calls[1].rules[0].users[0].userId.toString(), '42');
  assert.equal(calls[1].rules[0].users[0].accessHash.toString(), '99');
  assert.equal(calls[1].rules[2].chats[0].toString(), '123');
  await assert.rejects(driver.setAccountPrivacySetting('lastSeen', 'unexpected'), /Invalid account privacy mode/);
});

test('privacy writes stop safely when Telegram user exceptions cannot be reconstructed', async () => {
  let writes = 0;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    if (request instanceof Api.account.SetPrivacy) writes++;
    return { users: [], rules: [new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] })] };
  } };
  await assert.rejects(driver.setAccountPrivacySetting('phoneNumber', 'nobody'), /无法安全保留/);
  assert.equal(writes, 0);
});

test('privacy exception lists expose readable names and exact allow or deny categories', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    assert.ok(request instanceof Api.account.GetPrivacy);
    return { rules: [
      new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] }),
      new Api.PrivacyValueDisallowUsers({ users: [bigInt(43)] }),
      new Api.PrivacyValueAllowChatParticipants({ chats: [bigInt(123)] }),
      new Api.PrivacyValueDisallowChatParticipants({ chats: [bigInt(456)] }),
    ], users: [
      new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) }),
      new Api.User({ id: bigInt(43), firstName: 'Bob', accessHash: bigInt(100) }),
    ], chats: [
      new Api.Chat({ id: bigInt(123), title: 'Family', photo: new Api.ChatPhotoEmpty(), date: 1 }),
      new Api.Channel({ id: bigInt(456), title: 'News', photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true }),
    ] };
  } };
  const exceptions = await driver.getAccountPrivacyExceptions('lastSeen');
  assert.deepEqual(exceptions.map(({ id, category, title, kind }) => ({ id, category, title, kind })), [
    { id: '42', category: 'allowedUsers', title: 'Alice', kind: 'user' },
    { id: '43', category: 'blockedUsers', title: 'Bob', kind: 'user' },
    { id: '123', category: 'allowedChats', title: 'Family', kind: 'chat' },
    { id: '456', category: 'blockedChats', title: 'News', kind: 'chat' },
  ]);
});

test('adding a group privacy exception normalizes its peer ID and preserves user rules', async () => {
  const calls = [];
  const targetPeer = new Api.InputPeerChat({ chatId: bigInt(77) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 7;
  driver.client = {
    getInputEntity: async peer => { assert.equal(peer, -77n); return targetPeer; },
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.account.GetPrivacy) return {
        users: [new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) })], chats: [], rules: [
          new Api.PrivacyValueAllowContacts(),
          new Api.PrivacyValueDisallowChatParticipants({ chats: [bigInt(88)] }),
          new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] }),
        ],
      };
      return true;
    },
  };
  await driver.addAccountPrivacyChatException('lastSeen', 'allowedChats', -77);
  const update = calls.find(request => request instanceof Api.account.SetPrivacy);
  assert.ok(update);
  assert.deepEqual(update.rules.map(rule => rule.className), [
    'InputPrivacyValueAllowChatParticipants', 'InputPrivacyValueAllowContacts',
    'InputPrivacyValueDisallowChatParticipants', 'InputPrivacyValueAllowUsers',
  ]);
  assert.equal(update.rules[0].chats[0].toString(), '77');
  assert.equal(update.rules[2].chats[0].toString(), '88');
  assert.equal(update.rules[3].users[0].accessHash.toString(), '99');
});

test('group privacy exception search rejects broadcast channels and keeps supergroup IDs raw', async () => {
  const channel = new Api.Channel({ id: bigInt(123), accessHash: bigInt(5), title: 'Community', photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
  const peer = new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(5) });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async () => peer,
    getEntity: async () => channel,
    invoke: async request => { calls.push(request); return request instanceof Api.account.GetPrivacy ? { users: [], chats: [], rules: [] } : true; },
  };
  await driver.addAccountPrivacyChatException('lastSeen', 'blockedChats', -100123);
  const update = calls.find(request => request instanceof Api.account.SetPrivacy);
  assert.equal(update.rules[0].className, 'InputPrivacyValueDisallowChatParticipants');
  assert.equal(update.rules[0].chats[0].toString(), '123');
  channel.megagroup = false; channel.broadcast = true;
  const before = calls.length;
  await assert.rejects(driver.addAccountPrivacyChatException('lastSeen', 'allowedChats', -100123), /只能将群组/);
  assert.equal(calls.length, before);
});

test('removing a privacy exception preserves the base mode and unrelated Telegram rules', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetPrivacy) return { users: [
      new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) }),
      new Api.User({ id: bigInt(43), firstName: 'Bob', accessHash: bigInt(100) }),
    ], rules: [
      new Api.PrivacyValueAllowContacts(),
      new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] }),
      new Api.PrivacyValueDisallowUsers({ users: [bigInt(43)] }),
      new Api.PrivacyValueAllowChatParticipants({ chats: [bigInt(123)] }),
      new Api.PrivacyValueAllowBots(),
    ] };
    return true;
  } };
  await driver.removeAccountPrivacyException('lastSeen', 'blockedUsers', '43');
  assert.equal(calls.length, 2);
  assert.ok(calls[1] instanceof Api.account.SetPrivacy);
  assert.deepEqual(calls[1].rules.map(rule => rule.className), [
    'InputPrivacyValueAllowContacts', 'InputPrivacyValueAllowUsers',
    'InputPrivacyValueAllowChatParticipants', 'InputPrivacyValueAllowBots',
  ]);
  assert.equal(calls[1].rules[1].users[0].userId.toString(), '42');
  assert.equal(calls[1].rules[2].chats[0].toString(), '123');
  await assert.rejects(driver.removeAccountPrivacyException('lastSeen', 'blockedUsers', '999'), /未找到/);
  await assert.rejects(driver.removeAccountPrivacyException('lastSeen', 'blockedUsers', '0'), /Invalid/);
});

test('account privacy special rules can be edited without reordering the base or losing exceptions', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 7;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.account.GetPrivacy) return { users: [
      new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) }),
    ], rules: [
      new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] }),
      new Api.PrivacyValueAllowBots(),
      new Api.PrivacyValueAllowContacts(),
      new Api.PrivacyValueAllowChatParticipants({ chats: [bigInt(123)] }),
    ] };
    return true;
  } };
  const current = await driver.getAccountPrivacySpecialRules('lastSeen');
  assert.deepEqual(current, { allowPremium: false, botAccess: 'allow', editable: true, unsupportedRules: 0 });
  await driver.setAccountPrivacySpecialRule('lastSeen', 'allowPremium', true);
  const premiumUpdate = calls.at(-1);
  assert.deepEqual(premiumUpdate.rules.map(rule => rule.className), [
    'InputPrivacyValueAllowUsers', 'InputPrivacyValueAllowBots', 'InputPrivacyValueAllowPremium',
    'InputPrivacyValueAllowContacts', 'InputPrivacyValueAllowChatParticipants',
  ]);
  assert.equal(premiumUpdate.rules[0].users[0].accessHash.toString(), '99');
  assert.equal(premiumUpdate.rules[4].chats[0].toString(), '123');

  await driver.setAccountPrivacySpecialRule('lastSeen', 'botAccess', 'deny');
  const botUpdate = calls.at(-1);
  assert.deepEqual(botUpdate.rules.map(rule => rule.className), [
    'InputPrivacyValueAllowUsers', 'InputPrivacyValueDisallowBots', 'InputPrivacyValueAllowContacts', 'InputPrivacyValueAllowChatParticipants',
  ]);
  await driver.setAccountPrivacySpecialRule('lastSeen', 'botAccess', 'default');
  assert.equal(calls.at(-1).rules.some(rule => ['InputPrivacyValueAllowBots', 'InputPrivacyValueDisallowBots'].includes(rule.className)), false);
  await assert.rejects(driver.setAccountPrivacySpecialRule('lastSeen', 'unknown', true), /Invalid/);
});

test('privacy special rule editing is blocked when the current Telegram rules are unknown', async () => {
  let writes = 0;
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    if (request instanceof Api.account.SetPrivacy) writes++;
    return { rules: [{ className: 'PrivacyValueNewFromFutureTelegram' }], users: [] };
  } };
  assert.deepEqual(await driver.getAccountPrivacySpecialRules('lastSeen'), {
    allowPremium: false, botAccess: 'default', editable: false, unsupportedRules: 1,
  });
  await assert.rejects(driver.setAccountPrivacySpecialRule('lastSeen', 'allowPremium', true), /无法安全保留/);
  assert.equal(writes, 0);
});

test('adding a user exception moves that user from the opposing rule and preserves other privacy rules', async () => {
  const calls = [];
  const targetPeer = new Api.InputPeerUser({ userId: bigInt(43), accessHash: bigInt(100) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = {
    getInputEntity: async peer => { assert.equal(peer, 43n); return targetPeer; },
    invoke: async request => {
      calls.push(request);
      if (request instanceof Api.account.GetPrivacy) return { users: [
        new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(99) }),
        new Api.User({ id: bigInt(43), firstName: 'Bob', accessHash: bigInt(100) }),
      ], rules: [
        new Api.PrivacyValueAllowContacts(),
        new Api.PrivacyValueAllowUsers({ users: [bigInt(42)] }),
        new Api.PrivacyValueDisallowUsers({ users: [bigInt(43)] }),
        new Api.PrivacyValueAllowBots(),
      ] };
      return true;
    },
  };
  await driver.addAccountPrivacyUserException('lastSeen', 'allowedUsers', '43');
  assert.equal(calls.length, 2);
  assert.ok(calls[1] instanceof Api.account.SetPrivacy);
  assert.deepEqual(calls[1].rules.map(rule => rule.className), [
    'InputPrivacyValueAllowContacts', 'InputPrivacyValueAllowUsers', 'InputPrivacyValueAllowBots',
  ]);
  assert.deepEqual(calls[1].rules[1].users.map(user => user.userId.toString()), ['42', '43']);
  await assert.rejects(driver.addAccountPrivacyUserException('lastSeen', 'allowedChats', '43'), /Invalid/);
});

test('account privacy routes validate fields and dispatch only to the selected account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_account_privacy_settings' ? [{ key: 'lastSeen', mode: 'contacts' }]
      : action === 'get_account_privacy_exceptions' ? [{ id: '42', category: 'allowedUsers', title: 'Alice', kind: 'user' }]
        : action === 'get_account_privacy_special_rules' ? { allowPremium: false, botAccess: 'default', editable: true, unsupportedRules: 0 } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/privacy-settings`;
    const get = await fetch(base);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), [{ key: 'lastSeen', mode: 'contacts' }]);
    const post = body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ key: 'bad-key', mode: 'nobody' })).status, 400);
    assert.equal((await post({ key: 'lastSeen', mode: 'closeFriends' })).status, 400);
    assert.equal((await post({ key: 'lastSeen', mode: 'nobody' })).status, 200);
    const exceptionsUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/privacy-exceptions`;
    assert.equal((await fetch(`${exceptionsUrl}?key=lastSeen`)).status, 200);
    const postException = body => fetch(exceptionsUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await postException({ key: 'lastSeen', category: 'allowedUsers', entityId: '42' })).status, 200);
    assert.equal((await postException({ key: 'lastSeen', category: 'blockedUsers', entityId: '43', operation: 'add' })).status, 200);
    assert.equal((await postException({ key: 'lastSeen', category: 'bad', entityId: '42' })).status, 400);
    assert.equal((await postException({ key: 'lastSeen', category: 'allowedChats', entityId: '43', operation: 'add' })).status, 400);
    assert.equal((await postException({ key: 'lastSeen', category: 'allowedChats', chatId: -100123, operation: 'add' })).status, 200);
    assert.equal((await postException({ key: 'lastSeen', category: 'blockedChats', chatId: 123, operation: 'add' })).status, 400);
    assert.equal((await postException({ key: 'lastSeen', category: 'blockedUsers', entityId: '0' })).status, 400);
    const specialUrl = `http://127.0.0.1:${server.address().port}/api/instances/a/account/privacy-special-rules`;
    assert.deepEqual(await (await fetch(`${specialUrl}?key=lastSeen`)).json(), { allowPremium: false, botAccess: 'default', editable: true, unsupportedRules: 0 });
    const postSpecial = body => fetch(specialUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await postSpecial({ key: 'lastSeen', field: 'allowPremium', value: true })).status, 200);
    assert.equal((await postSpecial({ key: 'lastSeen', field: 'botAccess', value: 'deny' })).status, 200);
    assert.equal((await postSpecial({ key: 'lastSeen', field: 'botAccess', value: 'maybe' })).status, 400);
    assert.equal((await postSpecial({ key: 'bad-key', field: 'allowPremium', value: true })).status, 400);
    assert.deepEqual(calls, [
      { action: 'get_account_privacy_settings', payload: undefined },
      { action: 'set_account_privacy_setting', payload: { key: 'lastSeen', mode: 'nobody' } },
      { action: 'get_account_privacy_exceptions', payload: { key: 'lastSeen' } },
      { action: 'remove_account_privacy_exception', payload: { key: 'lastSeen', category: 'allowedUsers', entityId: '42' } },
      { action: 'add_account_privacy_user_exception', payload: { key: 'lastSeen', category: 'blockedUsers', userId: '43' } },
      { action: 'add_account_privacy_chat_exception', payload: { key: 'lastSeen', category: 'allowedChats', chatId: -100123 } },
      { action: 'get_account_privacy_special_rules', payload: { key: 'lastSeen' } },
      { action: 'set_account_privacy_special_rule', payload: { key: 'lastSeen', field: 'allowPremium', value: true } },
      { action: 'set_account_privacy_special_rule', payload: { key: 'lastSeen', field: 'botAccess', value: 'deny' } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

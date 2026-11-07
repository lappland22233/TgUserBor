'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

const actor = { id: 42, firstName: 'Alice' };
const map = action => Object.create(TelegramDriver.prototype).mapServiceAction(action, actor);

test('Telegram service actions distinguish membership, migration, and chat lifecycle events', () => {
  assert.deepEqual(map(new Api.MessageActionChatJoinedByLink({ inviterId: bigInt(10) })),
    { type: 'joined', text: 'Alice 通过邀请链接加入了群组' });
  assert.deepEqual(map(new Api.MessageActionChatJoinedByRequest({})),
    { type: 'joined', text: 'Alice 通过加入申请加入了群组' });
  assert.deepEqual(map(new Api.MessageActionChatAddUser({ users: [bigInt(42)] })),
    { type: 'joined', text: 'Alice 加入了群组' });
  assert.deepEqual(map(new Api.MessageActionChatAddUser({ users: [bigInt(43), bigInt(44)] })),
    { type: 'members_added', text: 'Alice 添加了 2 位成员' });
  assert.deepEqual(map(new Api.MessageActionChatDeleteUser({ userId: bigInt(42) })),
    { type: 'left', text: 'Alice 退出了群组' });
  assert.deepEqual(map(new Api.MessageActionChatDeleteUser({ userId: bigInt(43) })),
    { type: 'member_removed', text: 'Alice 移除了一位成员' });
  assert.match(map(new Api.MessageActionChannelMigrateFrom({ title: 'Old group', chatId: bigInt(100) })).text,
    /Old group.*升级为超级群组/);
});

test('Telegram payment, Stars, gift, and boost service events map without exposing payment payloads', () => {
  assert.equal(map(new Api.MessageActionPaymentSent({ currency: 'XTR', totalAmount: bigInt(500) })).text,
    '已支付 500 Stars');
  assert.equal(map(new Api.MessageActionPaymentSentMe({ currency: 'XTR', totalAmount: bigInt(500),
    payload: Buffer.alloc(0), charge: new Api.PaymentCharge({ id: 'charge', providerChargeId: '' }) })).text,
  '已收到 500 Stars 付款');
  assert.equal(map(new Api.MessageActionPaymentRefunded({ peer: new Api.PeerUser({ userId: bigInt(7) }),
    currency: 'XTR', totalAmount: bigInt(75), charge: new Api.PaymentCharge({ id: 'charge', providerChargeId: '' }) })).text,
  '已退还 75 Stars');
  assert.equal(map(new Api.MessageActionGiftPremium({ currency: 'XTR', amount: bigInt(500), months: 12 })).text,
    'Alice 赠送了 12 个月 Telegram Premium');
  assert.equal(map(new Api.MessageActionGiftStars({ currency: 'USD', amount: bigInt(1), stars: bigInt(250) })).text,
    'Alice 赠送了 250 Stars');
  assert.equal(map(new Api.MessageActionBoostApply({ boosts: 3 })).text,
    'Alice 为群组增加了 3 个 Boost');
});

test('Telegram service actions cover timers, calls, themes, and Mini App data safely', () => {
  assert.equal(map(new Api.MessageActionSetMessagesTTL({ period: 86400 })).text,
    '设置了自动删除计时器 · 1 天');
  assert.equal(map(new Api.MessageActionSetMessagesTTL({ period: 0 })).text,
    '关闭了自动删除计时器');
  assert.equal(map(new Api.MessageActionPhoneCall({ callId: bigInt(1), video: true, duration: 3600 })).text,
    '视频通话 · 1 小时');
  assert.equal(map(new Api.MessageActionSetChatTheme({ emoticon: '💜' })).text,
    '更改了聊天主题 💜');
  const webAppAction = new Api.MessageActionWebViewDataSentMe({ text: 'Shop', data: 'private payload' });
  assert.equal(map(webAppAction).text, '通过 Shop 发送了 Mini App 数据');
  assert.doesNotMatch(map(webAppAction).text, /private payload/);
  assert.equal(map(new Api.MessageActionCustomAction({ message: '<b>plain text</b>' })).text,
    '<b>plain text</b>');
});

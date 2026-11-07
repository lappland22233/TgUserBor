'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

test('voting uses the poll answer opaque bytes rather than assuming numeric IDs', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const requests = [];
  driver.client = {
    getMessages: async () => [{ media: { poll: { answers: [{ option: Buffer.from('abc') }, { option: Buffer.from([9, 2]) }] } } }],
    invoke: async request => requests.push(request),
  };
  await driver.sendVote(100, 5, [1]);
  assert.deepEqual(requests[0].options[0], Buffer.from([9, 2]));
  await driver.sendVote(100, 5, []);
  assert.deepEqual(requests[1].options, []);
  await assert.rejects(driver.sendVote(100, 5, [2]), /无效的投票选项/);
  assert.equal(requests.length, 2);
});

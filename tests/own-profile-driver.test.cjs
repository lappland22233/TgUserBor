'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

test('own profile obtains the full bio and uses the self Telegram input user', async()=>{
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfUser = {id:123,firstName:'Old',isBot:false};
  let received;
  driver.client = { invoke: async request => {received=request; return {fullUser:{about:'existing bio'},users:[{id:123,firstName:'Current',self:true}]};} };
  const profile = await driver.getOwnProfile();
  assert.ok(received instanceof Api.users.GetFullUser);
  assert.ok(received.id instanceof Api.InputUserSelf);
  assert.equal(profile.firstName,'Current');
  assert.equal(profile.bio,'existing bio');
});
test('full profile read failure is propagated rather than replaced with an empty bio', async()=>{
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfUser = {id:123,isBot:false};
  driver.client = { invoke: async()=>{throw new Error('offline');} };
  await assert.rejects(driver.getOwnProfile(),/offline/);
});

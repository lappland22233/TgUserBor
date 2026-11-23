'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandRegistry } = require('../dist/bot/parser');
const { MiddlewareChain } = require('../dist/bot/middleware');
const { Scheduler } = require('../dist/bot/core/scheduler');

test('command registration reserves aliases atomically and releases them on unload', () => {
  const registry = new CommandRegistry();
  const handler = () => {};
  registry.register('one', { name: 'first', aliases: ['shortcut'] }, handler);
  registry.alias('SHORTCUT', 'first');
  registry.alias('another', 'first');

  assert.throws(() => registry.register('two', { name: 'shortcut' }, handler), /registered alias/);
  assert.throws(() => {
    registry.register('two', { name: 'second', aliases: ['free', 'SHORTCUT'] }, handler);
  }, /already registered/);
  assert.throws(() => registry.alias('first', 'second'), /registered command/);
  assert.equal(registry.resolve('second'), undefined);
  assert.equal(registry.resolve('free'), undefined);
  assert.equal(registry.resolve('shortcut').def.name, 'first');

  registry.unregister('one');
  registry.register('two', { name: 'shortcut', aliases: ['another'] }, handler);
  assert.equal(registry.resolve('another').def.name, 'shortcut');
});

test('removing middleware preserves an in-flight chain and removes only its own registration', async () => {
  const chain = new MiddlewareChain();
  const calls = [];
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  const removePause = chain.use(async (msg, next) => {
    await paused;
    await next();
  });
  const middleware = async (msg, next) => {
    calls.push('middleware');
    await next();
  };
  const removeFirst = chain.use(middleware);
  chain.use(middleware);

  const pending = chain.run({}, async () => { calls.push('in flight'); });
  removePause();
  removeFirst();
  removeFirst();
  resume();
  await pending;
  await chain.run({}, async () => { calls.push('new run'); });

  assert.deepEqual(calls, ['middleware', 'middleware', 'in flight', 'middleware', 'new run']);
});

test('scoped scheduler replaces named tasks and disposes only its own scope', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const scheduler = new Scheduler();
  const calls = [];
  const previous = scheduler.createScope('plugin');
  previous.schedule('task', 10, () => { calls.push('old named timer'); });
  previous.interval(10, () => { calls.push('old interval'); });

  const current = scheduler.createScope('plugin');
  current.schedule('task', 10, () => { calls.push('replaced timer'); });
  current.schedule('task', 20, () => { calls.push('current timer'); });
  current.schedule('cancelled', 10, () => { calls.push('cancelled timer'); });
  assert.equal(current.cancel('cancelled'), true);
  assert.equal(current.cancel('cancelled'), false);
  assert.equal(previous.cancel('task'), false);
  previous.delay(10, () => { calls.push('disposed scope'); });
  previous.clear();
  previous.dispose();

  t.mock.timers.tick(20);
  assert.deepEqual(calls, ['current timer']);
  assert.equal(current.cancel('task'), false);

  current.clear();
  current.delay(10, () => { calls.push('after clear'); });
  t.mock.timers.tick(10);
  current.delay(10, () => { calls.push('after shutdown'); });
  scheduler.shutdown();
  t.mock.timers.tick(10);
  assert.deepEqual(calls, ['current timer', 'after clear']);
});

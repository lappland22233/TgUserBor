'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const pino = require('pino');
const { EventBus } = require('../dist/bot/core/event-bus');
const { Scheduler } = require('../dist/bot/core/scheduler');
const { Database } = require('../dist/bot/database');
const { MIGRATIONS } = require('../dist/bot/database/schema');
const { MiddlewareChain } = require('../dist/bot/middleware');
const { CommandRegistry } = require('../dist/bot/parser');
const { PermissionManager } = require('../dist/bot/permission');
const { PluginManager } = require('../dist/bot/plugin');
const { readPluginConfig, readPluginEnabled, writePluginConfig } = require('../dist/bot/plugin/state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plugins-'));
  const pluginDir = path.join(root, 'plugins');
  const instances = [];

  t.after(async () => {
    try {
      for (const { manager, scheduler, db } of instances.reverse()) {
        try {
          await manager.shutdown();
        } finally {
          scheduler.shutdown();
          db.close();
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function open({ database = 'first.db', hotReload = false } = {}) {
    const db = new Database(path.join(root, database));
    const bus = new EventBus();
    const commands = new CommandRegistry();
    const middleware = new MiddlewareChain();
    const scheduler = new Scheduler();
    const calls = [];
    const manager = new PluginManager({
      bot: { record: (value) => calls.push(value) },
      bus,
      db,
      permissions: new PermissionManager(db, 1),
      commands,
      scheduler,
      middleware,
      logger: pino({ level: 'silent' }),
      pluginDir,
      hotReload,
      ownerId: 1,
    });
    const instance = { manager, db, bus, commands, middleware, scheduler, calls };
    instances.push(instance);
    return instance;
  }

  return { root, pluginDir, open };
}

function writePlugin(dir, manifest, source) {
  const metadata = { name: 'sample', version: '1.0.0', entry: 'index.js', ...manifest };
  const entryPath = path.join(dir, metadata.entry);
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, source);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(metadata));
  return entryPath;
}

function samplePlugin(valueExpression) {
  return `
    module.exports = {
      manifest: { name: 'sample', version: '1.0.0' },
      activate(ctx) {
        ctx.command({ name: 'sample', aliases: ['sample-short'] }, () => ${valueExpression});
      },
    };
  `;
}

test('failed activation removes commands, aliases, listeners, middleware and timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { pluginDir, open } = fixture(t);
  const { manager, db, bus, commands, middleware, calls } = open();
  writePlugin(path.join(pluginDir, 'sample'), { defaultEnabled: false }, `
    module.exports = {
      manifest: { name: 'sample', version: '1.0.0' },
      async activate(ctx) {
        ctx.command({ name: 'sample', aliases: ['sample-short'] }, () => {});
        ctx.commands.alias('manual-short', 'sample');
        ctx.on('test:event', () => ctx.bot.record('listener'));
        ctx.onAny(() => ctx.bot.record('any listener'));
        ctx.use(async (_message, next) => {
          ctx.bot.record('middleware');
          await next();
        });
        ctx.scheduler.delay(5, () => ctx.bot.record('delay'));
        ctx.scheduler.interval(5, () => ctx.bot.record('interval'));
        ctx.scheduler.schedule('sample-timer', 5, () => ctx.bot.record('scheduled'));
        throw new Error('activation failed');
      },
    };
  `);

  await manager.loadAll();
  await assert.rejects(manager.setEnabled('sample', true), /activation failed/);
  assert.equal(manager.get('sample').enabled, false);
  assert.equal(readPluginEnabled(db, 'sample'), undefined);
  assert.equal(commands.resolve('sample'), undefined);

  commands.register('other', { name: 'sample' }, () => {});
  assert.equal(commands.resolve('sample-short'), undefined);
  assert.equal(commands.resolve('manual-short'), undefined);

  bus.emit('test:event', {});
  await middleware.run({}, async () => calls.push('terminal'));
  t.mock.timers.tick(30);
  assert.deepEqual(calls, ['terminal']);
});

test('reload retains the active version when loading or activation fails', async (t) => {
  const { pluginDir, open } = fixture(t);
  const { manager, commands, bus, calls } = open();
  const entry = writePlugin(path.join(pluginDir, 'sample'), {}, samplePlugin('"current"'));
  await manager.loadAll();

  fs.writeFileSync(entry, 'module.exports =');
  await assert.rejects(manager.reload('sample'));
  assert.equal(manager.get('sample').enabled, true);
  assert.equal(await commands.resolve('sample-short').handler(), 'current');

  fs.writeFileSync(entry, `
    module.exports = {
      manifest: { name: 'sample', version: '2.0.0' },
      activate(ctx) {
        ctx.command({ name: 'sample', aliases: ['candidate-short'] }, () => 'candidate');
        ctx.on('test:event', () => ctx.bot.record('candidate'));
        throw new Error('activation failed');
      },
    };
  `);
  await assert.rejects(manager.reload('sample'), /activation failed/);
  assert.equal(manager.get('sample').enabled, true);
  assert.equal(await commands.resolve('sample-short').handler(), 'current');
  assert.equal(commands.resolve('candidate-short'), undefined);
  bus.emit('test:event', {});
  assert.deepEqual(calls, []);

  fs.writeFileSync(entry, samplePlugin('"replacement"'));
  await manager.reload('sample');
  assert.equal(await commands.resolve('sample-short').handler(), 'replacement');
});

test('manual reload reads changed local dependencies for a nested entry', async (t) => {
  const { pluginDir, open } = fixture(t);
  const { manager, commands } = open();
  const dir = path.join(pluginDir, 'sample');
  writePlugin(dir, { entry: 'lib/main.js' }, `
    const value = require('../helper');
    ${samplePlugin('value')}
  `);
  const helper = path.join(dir, 'helper.js');
  fs.writeFileSync(helper, 'module.exports = "before";');
  await manager.loadAll();
  assert.equal(await commands.resolve('sample').handler(), 'before');

  fs.writeFileSync(helper, 'module.exports = "after";');
  await manager.reload('sample');
  assert.equal(await commands.resolve('sample').handler(), 'after');
});

test('default-disabled plugins stay unevaluated until enabled and use per-instance overrides', async (t) => {
  const { root, pluginDir, open } = fixture(t);
  const first = open();
  const second = open({ database: 'second.db' });
  const marker = path.join(root, 'entry-loaded');
  writePlugin(path.join(pluginDir, 'sample'), { defaultEnabled: false }, `
    require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
    ${samplePlugin('ctx.getConfig().message')}
  `);

  writePluginConfig(first.db, 'sample', { message: 'first' });
  writePluginConfig(second.db, 'sample', { message: 'second' });
  await first.manager.loadAll();
  await second.manager.loadAll();
  assert.equal(first.manager.get('sample').enabled, false);
  assert.equal(readPluginEnabled(first.db, 'sample'), undefined);
  assert.equal(second.manager.get('sample').enabled, false);
  assert.equal(readPluginEnabled(second.db, 'sample'), undefined);
  assert.equal(fs.existsSync(marker), false);

  await first.manager.setEnabled('sample', true);
  assert.equal(first.manager.get('sample').enabled, true);
  assert.equal(readPluginEnabled(first.db, 'sample'), true);
  assert.equal(await first.commands.resolve('sample').handler(), 'first');
  assert.equal(second.commands.resolve('sample'), undefined);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded\n');

  writePluginConfig(first.db, 'sample', { message: 'updated' });
  assert.equal(readPluginEnabled(first.db, 'sample'), true);
  const restarted = open();
  await restarted.manager.loadAll();
  assert.equal(await restarted.commands.resolve('sample').handler(), 'updated');

  await first.manager.setEnabled('sample', false);
  assert.equal(first.commands.resolve('sample'), undefined);
  assert.equal(readPluginEnabled(first.db, 'sample'), false);
  assert.equal(readPluginEnabled(second.db, 'sample'), undefined);
});

test('plugin state migration keeps legacy toggles and configuration', (t) => {
  const { root, open } = fixture(t);
  const legacy = new DatabaseSync(path.join(root, 'first.db'));
  try {
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
    const insertMigration = legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)');
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 5)) {
      // Migration 4 already creates the column added by migration 5 on a fresh database.
      if (migration.version !== 5) legacy.exec(migration.up);
      insertMigration.run(migration.version, migration.name, 1);
    }
    const insertState = legacy.prepare('INSERT INTO plugin_state VALUES (?, ?, ?, ?, ?)');
    insertState.run('enabled', 1, '{"key":"value"}', 1, 1);
    insertState.run('disabled', 0, null, 1, 1);
  } finally {
    legacy.close();
  }

  const { db } = open();
  assert.equal(readPluginEnabled(db, 'enabled'), true);
  assert.equal(readPluginEnabled(db, 'disabled'), false);
  assert.deepEqual(readPluginConfig(db, 'enabled'), { key: 'value' });
  writePluginConfig(db, 'config-only', { key: 'value' });
  assert.equal(readPluginEnabled(db, 'config-only'), undefined);
});

async function waitFor(predicate, message) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(25);
  }
}

test('watcher loads an added plugin and unloads it when its manifest is deleted', async (t) => {
  const { root, pluginDir, open } = fixture(t);
  const { manager, commands } = open({ hotReload: true });
  const staged = path.join(root, 'staged');
  writePlugin(staged, {}, samplePlugin('"watched"'));
  assert.equal(fs.existsSync(pluginDir), false);

  await manager.loadAll();
  const installed = path.join(pluginDir, 'sample');
  fs.renameSync(staged, installed);
  await waitFor(() => commands.resolve('sample'), 'watcher did not load the added plugin');
  assert.equal(await commands.resolve('sample').handler(), 'watched');

  fs.unlinkSync(path.join(installed, 'plugin.json'));
  await waitFor(() => !manager.get('sample'), 'watcher did not unload the removed manifest');
  assert.equal(commands.resolve('sample'), undefined);
});

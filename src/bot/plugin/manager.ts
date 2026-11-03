import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';

import type { Logger } from '../logger';
import type { Database } from '../database';
import type { PermissionManager } from '../permission';
import type { CommandRegistry, CommandDefinition, CommandHandler } from '../parser';
import type { BotAdapter, IncomingMessage, UserRef, MediaOptions, SendOptions } from '../adapter';
import type { EventBus, ListenerHandle } from '../core/event-bus';
import type { Scheduler, ScopedScheduler } from '../core/scheduler';
import type { PluginContext, PluginManifest, PluginModule } from './api';
import { Filters } from '../filters';
import { Conversation } from '../conversation';
import type { MiddlewareChain, MiddlewareFn } from '../middleware';
import type { RateLimiter } from '../ratelimit';

export interface PluginManagerDeps {
  bot: BotAdapter;
  bus: EventBus;
  db: Database;
  permissions: PermissionManager;
  commands: CommandRegistry;
  scheduler: Scheduler;
  logger: Logger;
  pluginDir: string;
  hotReload: boolean;
  ownerId: number;
  middleware?: MiddlewareChain;
  ratelimiter?: RateLimiter;
}

interface LoadedPlugin {
  name: string;
  version: string;
  sourcePath: string;
  enabled: boolean;
  module: PluginModule;
  context?: PluginContext;
  listeners: ListenerHandle[];
  scheduler: ScopedScheduler;
}

export class PluginManager {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private watcher?: chokidar.FSWatcher;

  constructor(private readonly deps: PluginManagerDeps) {}

  async loadAll(): Promise<void> {
    const dir = this.deps.pluginDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      this.deps.logger.info({ dir }, 'plugin directory did not exist, created it');
      return;
    }

    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));

    for (const pluginPath of entries) {
      try {
        await this.loadFromDir(pluginPath);
      } catch (err) {
        this.deps.logger.error({ err, pluginPath }, 'failed to load plugin');
      }
    }

    if (this.deps.hotReload) this.startWatcher();
  }

  async loadFromDir(pluginPath: string): Promise<void> {
    const pkgPath = path.join(pluginPath, 'plugin.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`plugin manifest not found: ${pkgPath}`);
    }
    const manifest: PluginManifest = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const entry = manifest.entry ?? 'index.js';
    const entryPath = path.join(pluginPath, entry);

    const enabled = this.readEnabledState(manifest.name);

    let mod: PluginModule;
    const resolvedEntry = path.resolve(entryPath);
    try {
      delete require.cache[require.resolve(resolvedEntry)];
    } catch {
      /* ignore if not yet cached */
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(resolvedEntry);

    if (!mod?.manifest) throw new Error(`plugin at ${pluginPath} has no manifest export`);

    const loaded: LoadedPlugin = {
      name: mod.manifest.name,
      version: mod.manifest.version,
      sourcePath: entryPath,
      enabled,
      module: mod,
      listeners: [],
      scheduler: this.deps.scheduler.createScope(mod.manifest.name),
    };
    this.plugins.set(loaded.name, loaded);

    if (enabled) await this.activate(loaded.name);
    this.deps.logger.info({ plugin: loaded.name, version: loaded.version, enabled }, 'plugin loaded');
  }

  async unload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    await this.deactivate(name);
    this.deps.commands.unregister(name);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve(plugin.sourcePath)];
    this.plugins.delete(name);
    this.deps.logger.info({ plugin: name }, 'plugin unloaded');
  }

  async reload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    const dir = path.dirname(plugin.sourcePath);
    await this.unload(name);
    await this.loadFromDir(dir);
  }

  async activate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`plugin "${name}" not loaded`);
    if (plugin.context) return;
    const ctx = this.buildContext(plugin);
    plugin.context = ctx;
    if (plugin.module.activate) await plugin.module.activate(ctx);
    plugin.enabled = true;
  }

  async deactivate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    if (plugin.context && plugin.module.deactivate) {
      try {
        await plugin.module.deactivate(plugin.context);
      } catch (err) {
        this.deps.logger.error({ err, plugin: name }, 'error during plugin deactivation');
      }
    }
    plugin.scheduler.clear();
    for (const h of plugin.listeners) h.off();
    plugin.listeners = [];
    this.deps.commands.unregister(name);
    plugin.context = undefined;
    plugin.enabled = false;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.activate(name);
      this.writeEnabledState(name, true);
    } else {
      await this.deactivate(name);
      this.writeEnabledState(name, false);
    }
  }

  list(): Array<{ name: string; version: string; description?: string; enabled: boolean; configSchema?: unknown[] }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.name,
      version: p.version,
      description: p.module.manifest?.description,
      enabled: p.enabled,
      configSchema: p.module.manifest?.configSchema || [],
    }));
  }

  get(name: string): { name: string; version: string; description?: string; enabled: boolean; configSchema?: unknown[] } | undefined {
    const p = this.plugins.get(name);
    if (!p) return undefined;
    return {
      name: p.name,
      version: p.version,
      description: p.module.manifest?.description,
      enabled: p.enabled,
      configSchema: p.module.manifest?.configSchema || [],
    };
  }

  async shutdown(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    for (const name of Array.from(this.plugins.keys())) {
      await this.deactivate(name);
    }
  }

  private buildContext(plugin: LoadedPlugin): PluginContext {
    const configRow = this.deps.db
      .raw()
      .prepare('SELECT config_json FROM plugin_state WHERE name = ?')
      .get(plugin.name) as { config_json: string | null } | undefined;

    const getConfig = <T = Record<string, unknown>>(): T => {
      const row = this.deps.db
        .raw()
        .prepare('SELECT config_json FROM plugin_state WHERE name = ?')
        .get(plugin.name) as { config_json: string | null } | undefined;
      if (!row?.config_json) return {} as T;
      try {
        return JSON.parse(row.config_json) as T;
      } catch {
        return {} as T;
      }
    };

    const setConfig = (value: Record<string, unknown>): void => {
      const now = Date.now();
      const existing = this.deps.db
        .raw()
        .prepare('SELECT name FROM plugin_state WHERE name = ?')
        .get(plugin.name);
      if (existing) {
        this.deps.db
          .raw()
          .prepare('UPDATE plugin_state SET config_json = ?, updated_at = ? WHERE name = ?')
          .run(JSON.stringify(value), now, plugin.name);
      } else {
        this.deps.db
          .raw()
          .prepare(
            'INSERT INTO plugin_state (name, enabled, config_json, loaded_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(plugin.name, plugin.enabled ? 1 : 0, JSON.stringify(value), now, now);
      }
    };

    const on = (event: string, handler: (msg: IncomingMessage) => void | Promise<void>): ListenerHandle => {
      const h = this.deps.bus.on(event, handler);
      plugin.listeners.push(h);
      return h;
    };

    const onAny = (
      handler: (event: string, payload: unknown) => void | Promise<void>,
    ): ListenerHandle => {
      const h = this.deps.bus.onAny(async ({ event, payload }) => {
        try {
          await handler(event, payload);
        } catch (err) {
          this.deps.logger.error({ err, plugin: plugin.name }, 'plugin onAny handler error');
        }
      });
      plugin.listeners.push(h);
      return h;
    };

    const command = (def: CommandDefinition, handler: CommandHandler): void => {
      this.deps.commands.register(plugin.name, def, handler);
    };

    const getUser = (id: number): Promise<UserRef | undefined> => this.deps.bot.getUser(id);

    return {
      name: plugin.name,
      logger: this.deps.logger.child({ plugin: plugin.name }),
      bot: this.deps.bot,
      bus: this.deps.bus,
      db: this.deps.db,
      permissions: this.deps.permissions,
      commands: this.deps.commands,
      scheduler: plugin.scheduler,
      ownerId: this.deps.ownerId,
      getConfig,
      setConfig,
      command,
      on,
      onAny,
      getUser,

      filters: Filters,
      ratelimit: this.deps.ratelimiter as any,
      conversation: (chatId: number, userId: number) =>
        new Conversation(chatId, userId, this.deps.bot, this.deps.bus),
      use: (fn: MiddlewareFn) => {
        if (this.deps.middleware) {
          this.deps.middleware.use(fn);
        }
      },

      sendPhoto: (chatId: number, file: string | Buffer, options?: MediaOptions) =>
        this.deps.bot.sendPhoto(chatId, file, options),
      sendVideo: (chatId: number, file: string | Buffer, options?: MediaOptions) =>
        this.deps.bot.sendVideo(chatId, file, options),
      sendFile: (chatId: number, file: string | Buffer, options?: MediaOptions) =>
        this.deps.bot.sendFile(chatId, file, options),
      sendSticker: (chatId: number, file: string | Buffer, options?: SendOptions) =>
        this.deps.bot.sendSticker(chatId, file, options),
      downloadMedia: (chatId: number, messageId: number, destPath: string) =>
        this.deps.bot.downloadMedia(chatId, messageId, destPath),
      forwardMessage: (fromChatId: number, toChatId: number, messageId: number) =>
        this.deps.bot.forwardMessage(fromChatId, toChatId, messageId),
      pinMessage: (chatId: number, messageId: number, silent?: boolean) =>
        this.deps.bot.pinMessage(chatId, messageId, silent),
      unpinMessage: (chatId: number, messageId?: number) =>
        this.deps.bot.unpinMessage(chatId, messageId),
    };
  }

  private readEnabledState(name: string): boolean {
    const row = this.deps.db
      .raw()
      .prepare('SELECT enabled FROM plugin_state WHERE name = ?')
      .get(name) as { enabled: number } | undefined;
    if (!row) return true;
    return Boolean(row.enabled);
  }

  private writeEnabledState(name: string, enabled: boolean): void {
    const now = Date.now();
    const existing = this.deps.db
      .raw()
      .prepare('SELECT name FROM plugin_state WHERE name = ?')
      .get(name);
    if (existing) {
      this.deps.db
        .raw()
        .prepare('UPDATE plugin_state SET enabled = ?, updated_at = ? WHERE name = ?')
        .run(enabled ? 1 : 0, now, name);
    } else {
      this.deps.db
        .raw()
        .prepare(
          'INSERT INTO plugin_state (name, enabled, config_json, loaded_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
        )
        .run(name, enabled ? 1 : 0, now, now);
    }
  }

  private startWatcher(): void {
    this.watcher = chokidar.watch(this.deps.pluginDir, {
      ignored: /(^|[\\\/])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const onChange = async (filePath: string) => {
      const pluginRoot = this.findPluginRoot(filePath);
      if (!pluginRoot) return;
      const name = this.findPluginNameByPath(pluginRoot);
      if (!name) return;
      this.deps.logger.info({ plugin: name, file: filePath }, 'plugin file changed, reloading');
      try {
        await this.reload(name);
      } catch (err) {
        this.deps.logger.error({ err, plugin: name }, 'plugin hot reload failed');
      }
    };

    this.watcher.on('change', onChange);
    this.watcher.on('add', onChange);
    this.watcher.on('unlink', (p) => {
      const root = this.findPluginRoot(p);
      if (!root) return;
      const name = this.findPluginNameByPath(root);
      if (name) void this.unload(name);
    });
  }

  private findPluginRoot(filePath: string): string | undefined {
    let cur = path.dirname(filePath);
    while (cur && cur !== path.dirname(cur)) {
      if (fs.existsSync(path.join(cur, 'plugin.json'))) return cur;
      cur = path.dirname(cur);
    }
    return undefined;
  }

  private findPluginNameByPath(pluginRoot: string): string | undefined {
    for (const p of this.plugins.values()) {
      if (path.dirname(p.sourcePath) === pluginRoot) return p.name;
    }
    return undefined;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import * as chokidar from 'chokidar';

import type { Logger } from '../logger';
import type { Database } from '../database';
import type { PermissionManager } from '../permission';
import type { CommandRegistry, CommandDefinition, CommandHandler } from '../parser';
import type { BotAdapter, UserRef, MediaOptions, SendOptions } from '../adapter';
import type { EventBus, ListenerHandle } from '../core/event-bus';
import type { Scheduler, ScopedScheduler } from '../core/scheduler';
import type { ConfigField, PluginContext, PluginManifest, PluginModule } from './api';
import { readPluginManifest } from './manifest';
import { readPluginConfig, readPluginEnabled, writePluginConfig, writePluginEnabled } from './state';
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

interface Activation {
  context: PluginContext;
  close(): void;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  directory: string;
  realDirectory: string;
  entryPath: string;
  module?: PluginModule;
  activation?: Activation;
}

interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  defaultEnabled: boolean;
  configSchema: ConfigField[];
}

type ModuleCache = Array<[string, NodeJS.Module]>;

function isInside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return Boolean(relative) && relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export class PluginManager {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly pluginDir: string;
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private watcher?: chokidar.FSWatcher;
  private pending: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(private readonly deps: PluginManagerDeps) {
    this.pluginDir = path.resolve(deps.pluginDir);
  }

  loadAll(): Promise<void> {
    return this.run(async () => {
      fs.mkdirSync(this.pluginDir, { recursive: true });
      if (this.deps.hotReload && !this.watcher && !this.stopping) await this.startWatcher();

      const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const directory = path.join(this.pluginDir, entry.name);
        if (this.findByDirectory(directory) || !fs.existsSync(path.join(directory, 'plugin.json'))) continue;
        try {
          await this.loadDirectory(directory);
        } catch (err) {
          this.deps.logger.error({ err, pluginPath: directory }, 'failed to load plugin');
        }
      }
    });
  }

  loadFromDir(pluginPath: string): Promise<void> {
    return this.run(() => this.loadDirectory(path.resolve(pluginPath)));
  }

  unload(name: string): Promise<void> {
    return this.run(async () => {
      const plugin = this.plugins.get(name);
      if (plugin) await this.unloadPlugin(plugin);
    });
  }

  reload(name: string): Promise<void> {
    return this.run(async () => {
      const current = this.plugins.get(name);
      if (current) {
        await this.loadDirectory(current.directory);
      } else {
        if (!name || name === '..' || path.basename(name) !== name) {
          throw new Error(`plugin "${name}" not found`);
        }
        const directory = path.join(this.pluginDir, name);
        if (!fs.existsSync(path.join(directory, 'plugin.json'))) {
          throw new Error(`plugin "${name}" not found`);
        }
        await this.loadDirectory(directory, name);
      }
    });
  }

  activate(name: string): Promise<void> {
    return this.run(() => this.activatePlugin(this.requirePlugin(name)));
  }

  deactivate(name: string): Promise<void> {
    return this.run(async () => {
      const plugin = this.plugins.get(name);
      if (plugin) await this.deactivatePlugin(plugin);
    });
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.run(async () => {
      const plugin = this.requirePlugin(name);
      const wasEnabled = Boolean(plugin.activation);
      if (enabled) await this.activatePlugin(plugin);
      else await this.deactivatePlugin(plugin);

      try {
        writePluginEnabled(this.deps.db, name, enabled);
      } catch (err) {
        if (wasEnabled && !enabled) await this.restoreActivation(plugin);
        if (enabled && !wasEnabled) await this.deactivatePlugin(plugin);
        throw err;
      }
    });
  }

  list(): PluginInfo[] {
    return Array.from(this.plugins.values(), (plugin) => this.getInfo(plugin));
  }

  get(name: string): PluginInfo | undefined {
    const plugin = this.plugins.get(name);
    return plugin && this.getInfo(plugin);
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    return this.enqueue(async () => {
      try {
        await this.watcher?.close();
      } finally {
        this.watcher = undefined;
        for (const plugin of this.plugins.values()) await this.deactivatePlugin(plugin);
      }
    });
  }

  private run(operation: () => Promise<void>): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('plugin manager is shutting down'));
    return this.enqueue(operation);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private requirePlugin(name: string): LoadedPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`plugin "${name}" not loaded`);
    return plugin;
  }

  private getInfo(plugin: LoadedPlugin): PluginInfo {
    const { manifest } = plugin;
    const exported = plugin.module?.manifest;
    return {
      name: manifest.name,
      version: exported?.version ?? manifest.version,
      description: manifest.description ?? exported?.description,
      enabled: Boolean(plugin.activation),
      defaultEnabled: manifest.defaultEnabled ?? true,
      configSchema: manifest.configSchema ?? exported?.configSchema ?? [],
    };
  }

  private async loadDirectory(directory: string, expectedName?: string): Promise<void> {
    const manifest = readPluginManifest(directory);
    const { name } = manifest;
    if (expectedName !== undefined && name !== expectedName) {
      throw new Error(`expected plugin "${expectedName}" in ${directory}, found "${name}"`);
    }
    const previous = this.findByDirectory(directory);
    const duplicate = this.plugins.get(name);
    if (duplicate && duplicate !== previous) {
      throw new Error(`plugin "${name}" is already loaded from ${duplicate.directory}`);
    }
    const entryPath = path.resolve(directory, manifest.entry ?? 'index.js');
    if (!isInside(directory, entryPath)) throw new Error(`plugin "${name}" entry must be inside its directory`);

    const candidate: LoadedPlugin = { manifest, directory, realDirectory: fs.realpathSync(directory), entryPath };
    const enabled = readPluginEnabled(this.deps.db, name) ?? manifest.defaultEnabled ?? true;
    if (previous) {
      await this.replacePlugin(previous, candidate, enabled);
    } else {
      this.plugins.set(name, candidate);
      if (enabled) await this.activatePlugin(candidate);
    }
    this.deps.logger.info({ plugin: name, version: this.getInfo(candidate).version, enabled }, 'plugin loaded');
  }

  private loadModule(plugin: LoadedPlugin): PluginModule {
    const entry = require.resolve(plugin.entryPath);
    if (!isInside(plugin.realDirectory, fs.realpathSync(entry))) {
      throw new Error(`plugin "${plugin.manifest.name}" entry must be inside its directory`);
    }
    const mod: PluginModule = createRequire(plugin.entryPath)(entry);
    if (mod?.manifest?.name !== plugin.manifest.name) {
      throw new Error(`plugin export name must match "${plugin.manifest.name}" in plugin.json`);
    }
    if ((mod.activate !== undefined && typeof mod.activate !== 'function') ||
        (mod.deactivate !== undefined && typeof mod.deactivate !== 'function')) {
      throw new Error(`invalid lifecycle hooks for plugin "${plugin.manifest.name}"`);
    }
    return mod;
  }

  private moduleCache(directory: string): ModuleCache {
    return Object.entries(require.cache).filter(
      (entry): entry is [string, NodeJS.Module] => Boolean(entry[1]) &&
        isInside(directory, entry[0]) &&
        !path.relative(directory, entry[0]).split(path.sep).includes('node_modules'),
    );
  }

  private resetModuleCache(directory: string, entries: ModuleCache = []): void {
    for (const [file] of this.moduleCache(directory)) delete require.cache[file];
    for (const [file, module] of entries) require.cache[file] = module;
  }

  private async replacePlugin(previous: LoadedPlugin, candidate: LoadedPlugin, enabled: boolean): Promise<void> {
    const directory = candidate.realDirectory;
    const previousCache = this.moduleCache(directory);
    let candidateCache: ModuleCache = [];
    if (enabled) {
      this.resetModuleCache(directory);
      try {
        candidate.module = this.loadModule(candidate);
        candidateCache = this.moduleCache(directory);
      } finally {
        this.resetModuleCache(directory, previousCache);
      }
    }

    const wasEnabled = Boolean(previous.activation);
    await this.deactivatePlugin(previous);
    this.resetModuleCache(directory, candidateCache);
    try {
      if (enabled) await this.activatePlugin(candidate);
    } catch (err) {
      this.resetModuleCache(directory, previousCache);
      if (wasEnabled) await this.restoreActivation(previous);
      throw err;
    }

    if (previous.realDirectory !== directory) this.resetModuleCache(previous.realDirectory);
    if (previous.manifest.name !== candidate.manifest.name) this.plugins.delete(previous.manifest.name);
    this.plugins.set(candidate.manifest.name, candidate);
  }

  private async restoreActivation(plugin: LoadedPlugin): Promise<void> {
    try {
      await this.activatePlugin(plugin);
    } catch (err) {
      this.deps.logger.error({ err, plugin: plugin.manifest.name }, 'failed to restore plugin activation');
    }
  }

  private async activatePlugin(plugin: LoadedPlugin): Promise<void> {
    if (plugin.activation) return;

    const name = plugin.manifest.name;
    const previousCache = plugin.module ? undefined : this.moduleCache(plugin.realDirectory);
    const activation = this.buildActivation(name);
    try {
      if (!plugin.module) {
        this.resetModuleCache(plugin.realDirectory);
        plugin.module = this.loadModule(plugin);
      }
      await plugin.module.activate?.(activation.context);
      plugin.activation = activation;
    } catch (err) {
      await this.closeActivation(plugin, activation);
      if (previousCache) {
        plugin.module = undefined;
        this.resetModuleCache(plugin.realDirectory, previousCache);
      }
      throw err;
    }
  }

  private async closeActivation(plugin: LoadedPlugin, activation: Activation): Promise<void> {
    try {
      await plugin.module?.deactivate?.(activation.context);
    } catch (err) {
      this.deps.logger.error({ err, plugin: plugin.manifest.name }, 'error during plugin deactivation');
    } finally {
      activation.close();
    }
  }

  private async deactivatePlugin(plugin: LoadedPlugin): Promise<void> {
    if (!plugin.activation) return;
    await this.closeActivation(plugin, plugin.activation);
    plugin.activation = undefined;
  }

  private async unloadPlugin(plugin: LoadedPlugin): Promise<void> {
    await this.deactivatePlugin(plugin);
    this.resetModuleCache(plugin.realDirectory);
    this.plugins.delete(plugin.manifest.name);
    this.deps.logger.info({ plugin: plugin.manifest.name }, 'plugin unloaded');
  }

  private buildActivation(name: string): Activation {
    const logger = this.deps.logger.child({ plugin: name });
    const scheduler = this.deps.scheduler.createScope(name);
    const cleanups = new Set<() => void>();
    let open = true;

    const invoke = async (event: string, handler: () => void | Promise<void>): Promise<void> => {
      if (!open) return;
      try {
        await handler();
      } catch (err) {
        logger.error({ err, event }, 'plugin event handler error');
      }
    };
    const track = (listener: ListenerHandle): ListenerHandle => {
      const off = () => {
        if (cleanups.delete(off)) listener.off();
      };
      cleanups.add(off);
      return { off };
    };
    const inactiveListener: ListenerHandle = { off() {} };

    const context: PluginContext = {
      name,
      logger,
      bot: this.deps.bot,
      bus: this.deps.bus,
      db: this.deps.db,
      permissions: this.deps.permissions,
      commands: this.deps.commands,
      scheduler,
      ownerId: this.deps.ownerId,
      getConfig: <T>() => readPluginConfig(this.deps.db, name) as T,
      setConfig: (value) => writePluginConfig(this.deps.db, name, value),
      command: (def: CommandDefinition, handler: CommandHandler) => {
        if (open) this.deps.commands.register(name, def, (ctx) => open ? handler(ctx) : undefined);
      },
      on: (event, handler) => open ? track(this.deps.bus.on(event, (payload) =>
        invoke(event, () => handler(payload)))) : inactiveListener,
      onAny: (handler) => open ? track(this.deps.bus.onAny(({ event, payload }) =>
        invoke(event, () => handler(event, payload)))) : inactiveListener,
      getUser: (id: number): Promise<UserRef | undefined> => this.deps.bot.getUser(id),

      filters: Filters,
      ratelimit: this.deps.ratelimiter as RateLimiter,
      conversation: (chatId: number, userId: number) =>
        new Conversation(chatId, userId, this.deps.bot, this.deps.bus),
      use: (fn: MiddlewareFn) => {
        if (open && this.deps.middleware) {
          cleanups.add(this.deps.middleware.use((msg, next) => open ? fn(msg, next) : next()));
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

    return {
      context,
      close: () => {
        open = false;
        scheduler.dispose();
        for (const cleanup of cleanups) cleanup();
        cleanups.clear();
        this.deps.commands.unregister(name);
      },
    };
  }

  private async startWatcher(): Promise<void> {
    const watcher = chokidar.watch(this.pluginDir, {
      ignored: (file) => path.relative(this.pluginDir, file).split(path.sep)
        .some((part) => (part.startsWith('.') && part !== '..') || part === 'node_modules'),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher = watcher;
    watcher.on('error', (err) => this.deps.logger.error({ err }, 'plugin watcher error'));
    watcher.on('all', (_event, file) => {
      if (this.stopping || !isInside(this.pluginDir, file)) return;
      const folder = path.relative(this.pluginDir, file).split(path.sep)[0];
      const directory = path.join(this.pluginDir, folder);
      clearTimeout(this.watchTimers.get(directory));
      this.watchTimers.set(directory, setTimeout(() => {
        this.watchTimers.delete(directory);
        if (this.stopping) return;
        void this.run(async () => {
          if (fs.existsSync(path.join(directory, 'plugin.json'))) {
            await this.loadDirectory(directory);
          } else {
            const plugin = this.findByDirectory(directory);
            if (plugin) await this.unloadPlugin(plugin);
          }
        }).catch((err) => this.deps.logger.error({ err, pluginPath: directory }, 'plugin hot reload failed'));
      }, 100));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        watcher.once('ready', resolve);
        watcher.once('error', reject);
      });
    } catch {
      await watcher.close();
      this.watcher = undefined;
    }
  }

  private findByDirectory(directory: string): LoadedPlugin | undefined {
    return Array.from(this.plugins.values()).find((plugin) => plugin.directory === directory);
  }
}

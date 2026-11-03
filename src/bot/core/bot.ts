import type { Logger } from '../logger';
import type { BotConfig } from '../config';
import type { BotAdapter, IncomingMessage, SendOptions } from '../adapter';
import { TelegramDriver } from '../driver/telegram';
import { Database } from '../database';
import { PermissionManager, AccessLevel } from '../permission';
import { CommandParser, CommandRegistry, type CommandContext } from '../parser';
import { PluginManager } from '../plugin';
import { EventBus } from './event-bus';
import { Scheduler } from './scheduler';
import { MiddlewareChain } from '../middleware';
import { RateLimiter } from '../ratelimit';

export class Bot {
  readonly config: BotConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly permissions: PermissionManager;
  readonly commands = new CommandRegistry();
  readonly parser: CommandParser;
  readonly bus = new EventBus();
  readonly scheduler = new Scheduler();
  readonly middleware = new MiddlewareChain();
  readonly ratelimiter: RateLimiter;
  readonly adapter: BotAdapter;
  readonly plugins: PluginManager;

  private started = false;

  constructor(config: BotConfig, logger: Logger, adapter?: BotAdapter) {
    this.config = config;
    this.logger = logger;
    this.db = new Database(config.db.path);
    this.ratelimiter = new RateLimiter(this.db);
    this.permissions = new PermissionManager(this.db, config.ownerId);
    this.parser = new CommandParser(config.command.prefixes);
    this.adapter = adapter ?? new TelegramDriver(config, logger);
    this.plugins = new PluginManager({
      bot: this.adapter,
      bus: this.bus,
      db: this.db,
      permissions: this.permissions,
      commands: this.commands,
      scheduler: this.scheduler,
      logger,
      pluginDir: config.plugin.dir,
      hotReload: config.plugin.hotReload,
      ownerId: config.ownerId,
      middleware: this.middleware,
      ratelimiter: this.ratelimiter,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.adapter.on('message', (msg) => this.bus.emit('message', msg));
    this.adapter.on('message:edited', (msg) => this.bus.emit('message:edited', msg));
    this.adapter.on('message:deleted', (e) => this.bus.emit('message:deleted', e));
    this.adapter.on('message:reaction', (e) => this.bus.emit('message:reaction', e));
    this.adapter.on('callback:query', (e) => this.bus.emit('callback:query', e));
    this.adapter.on('user:status', (e) => this.bus.emit('user:status', e));
    this.adapter.on('chat:action', (e) => this.bus.emit('chat:action', e));
    this.adapter.on('chat:participant:joined', (p) => this.bus.emit('chat:participant:joined', p));
    this.adapter.on('chat:participant:left', (p) => this.bus.emit('chat:participant:left', p));
    this.adapter.on('ready', (p) => {
      this.logger.info({ self: p.self }, 'bot ready');
      this.bus.emit('ready', p);
    });
    this.adapter.on('error', (e) => {
      this.logger.error({ err: e.error, context: e.context }, 'adapter error');
    });
    this.adapter.on('disconnected', (e) => {
      this.logger.warn({ reason: e.reason }, 'adapter disconnected');
      this.bus.emit('disconnected', e);
    });

    this.bus.on<IncomingMessage>('message', async (msg) => {
      await this.handleMessage(msg);
    });

    await this.adapter.start();
    await this.plugins.loadAll();
    this.logger.info({ pluginCount: this.plugins.list().length }, 'all plugins loaded');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.scheduler.shutdown();
    await this.plugins.shutdown();
    await this.adapter.stop();
    this.db.close();
    this.logger.info('bot stopped');
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    this.recordEntity(msg);

    if (msg.from.isBot && !msg.outgoing) return;

    await this.middleware.run(msg, async () => {
      const selfId = this.adapter.getSelf()?.id;
      const isOwner = Boolean(msg.outgoing) || msg.from.id === this.config.ownerId || (selfId !== undefined && msg.from.id === selfId);
      
      this.logger.debug(
        { text: msg.text, from: msg.from.id, chat: msg.chat.id, outgoing: msg.outgoing, isOwner },
        'incoming message',
      );

      const parsed = this.parser.parse(msg);
      if (!parsed) return;

      // 白名单机制：仅主人（包括本机账号自身）和白名单内的用户响应命令
      const isWhitelisted = isOwner || this.isWhitelisted(msg.from.id);
      if (!isWhitelisted) {
        this.logger.debug(
          { from: msg.from.id, user: msg.from.username, text: msg.text },
          'command ignored: sender is not in whitelist',
        );
        return;
      }

      const cmd = this.commands.resolve(parsed.name);
      if (!cmd) return;

      const access = this.permissions.resolve({
        userId: msg.from.id,
        chatId: msg.chat.id,
        isOwner,
        pluginName: cmd.plugin,
        commandName: parsed.name,
      });

      if (access === AccessLevel.DENIED) return;
      if (!isOwner && access === AccessLevel.ADMIN) {
        await this.adapter.replyTo(msg.chat.id, msg.id, '⛔ 您没有权限执行此命令。');
        return;
      }

      this.recordUsage(msg, parsed.name, cmd.plugin);

      const ctx: CommandContext = {
        command: parsed,
        reply: async (text: string, options?: SendOptions) => {
          await this.adapter.replyTo(msg.chat.id, msg.id, text, options);
        },
        replyHtml: async (text: string, options?: SendOptions) => {
          await this.adapter.replyTo(msg.chat.id, msg.id, text, { ...options, parseMode: 'html' });
        },
        editOrReply: async (text: string, options?: SendOptions) => {
          if (msg.outgoing) {
            try {
              await this.adapter.editMessage(msg.chat.id, msg.id, text, options);
            } catch (editErr) {
              this.logger.warn({ editErr }, 'editMessage failed, falling back to replyTo');
              await this.adapter.replyTo(msg.chat.id, msg.id, text, options);
            }
          } else {
            await this.adapter.replyTo(msg.chat.id, msg.id, text, options);
          }
        },
        bot: this,
      };

      try {
        await cmd.handler(ctx);
      } catch (err) {
        this.logger.error({ err, plugin: cmd.plugin, command: parsed.name }, 'command handler error');
        try {
          await ctx.editOrReply('❌ 命令执行失败，详情请查看系统日志。');
        } catch {
          /* swallow */
        }
      }
    });
  }

  private recordEntity(msg: IncomingMessage): void {
    try {
      const now = Date.now();
      this.db
        .raw()
        .prepare(
          `INSERT INTO users (id, username, first_name, last_name, is_bot, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             username = excluded.username,
             first_name = excluded.first_name,
             last_name = excluded.last_name,
             updated_at = excluded.updated_at`,
        )
        .run(
          msg.from.id,
          msg.from.username ?? null,
          msg.from.firstName ?? null,
          msg.from.lastName ?? null,
          msg.from.isBot ? 1 : 0,
          now,
          now,
        );

      this.db
        .raw()
        .prepare(
          `INSERT INTO chats (id, type, title, username, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             username = excluded.username,
             updated_at = excluded.updated_at`,
        )
        .run(
          msg.chat.id,
          msg.chat.type,
          msg.chat.title ?? null,
          msg.chat.username ?? null,
          now,
          now,
        );
    } catch {
      /* swallow non-critical error */
    }
  }

  private recordUsage(msg: IncomingMessage, command: string, plugin: string): void {
    try {
      this.db
        .raw()
        .prepare(
          'INSERT INTO command_usage (user_id, chat_id, command, plugin, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(msg.from.id, msg.chat.id, command, plugin, Date.now());
    } catch (err) {
      this.logger.warn({ err }, 'failed to record command usage');
    }
  }

  isWhitelisted(userId: number): boolean {
    try {
      const row = this.db.raw().prepare('SELECT user_id FROM whitelist WHERE user_id = ?').get(userId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  addWhitelist(userId: number, username?: string, remark?: string): void {
    const now = Date.now();
    this.db.raw().prepare(`
      INSERT INTO whitelist (user_id, username, remark, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        remark = excluded.remark
    `).run(userId, username ?? null, remark ?? null, now);
  }

  removeWhitelist(userId: number): boolean {
    const res = this.db.raw().prepare('DELETE FROM whitelist WHERE user_id = ?').run(userId);
    return (res as any)?.changes > 0;
  }

  listWhitelist(): Array<{ user_id: number; username: string | null; remark: string | null; created_at: number }> {
    try {
      return this.db.raw().prepare('SELECT user_id, username, remark, created_at FROM whitelist ORDER BY created_at DESC').all() as any;
    } catch {
      return [];
    }
  }
}

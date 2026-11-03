import type { BotAdapter, IncomingMessage, UserRef, MediaOptions, SendOptions } from '../adapter';
import type { CommandRegistry, CommandHandler, CommandDefinition } from '../parser';
import type { PermissionManager, AccessLevel } from '../permission';
import type { Database } from '../database';
import type { Logger } from '../logger';
import type { EventBus, ListenerHandle } from '../core/event-bus';
import type { ScopedScheduler } from '../core/scheduler';
import type { Filters } from '../filters';
import type { RateLimiter } from '../ratelimit';
import type { Conversation } from '../conversation';
import type { MiddlewareFn } from '../middleware';

export interface PluginContext {
  name: string;
  logger: Logger;
  bot: BotAdapter;
  bus: EventBus;
  db: Database;
  permissions: PermissionManager;
  commands: CommandRegistry;
  scheduler: ScopedScheduler;
  /** Per-plugin config persisted in DB.plugin_state.config_json. */
  getConfig<T = Record<string, unknown>>(): T;
  setConfig(value: Record<string, unknown>): void;
  /** Owner id for permission checks. */
  ownerId: number;
  /** Command decorator. */
  command(def: CommandDefinition, handler: CommandHandler): void;
  /** Convenience subscription helpers; auto-removed on unload. */
  on(event: string, handler: (payload: any) => void | Promise<void>): ListenerHandle;
  onAny(handler: (event: string, payload: unknown) => void | Promise<void>): ListenerHandle;
  /** Resolve a user (cached, best-effort). */
  getUser(id: number): Promise<UserRef | undefined>;

  /** Filter DSL helpers */
  filters: typeof Filters;
  /** Rate limiter */
  ratelimit: RateLimiter;
  /** Start a guided conversation */
  conversation(chatId: number, userId: number): Conversation;
  /** Register custom middleware */
  use(fn: MiddlewareFn): void;

  /** Media shortcuts */
  sendPhoto(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendVideo(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendFile(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendSticker(chatId: number, file: string | Buffer, options?: SendOptions): Promise<number | undefined>;
  downloadMedia(chatId: number, messageId: number, destPath: string): Promise<string | undefined>;
  forwardMessage(fromChatId: number, toChatId: number, messageId: number): Promise<number | undefined>;
  pinMessage(chatId: number, messageId: number, silent?: boolean): Promise<void>;
  unpinMessage(chatId: number, messageId?: number): Promise<void>;
}

export interface PluginModule {
  /** Plugin metadata. */
  manifest: PluginManifest;
  /** Called once after the plugin is registered. */
  activate?(ctx: PluginContext): void | Promise<void>;
  /** Called once on shutdown / unload. */
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  entry?: string;
}

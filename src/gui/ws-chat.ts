import { WebSocketServer, WebSocket } from 'ws';
import type { InstanceManager } from '../manager';
import { CacheManager } from './cache-manager';
import type { GUIAuth } from './auth';

function validSavedTagReaction(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type === 'custom') return typeof value.value === 'string' && /^[1-9]\d{0,19}$/.test(value.value) && BigInt(value.value) <= 9223372036854775807n;
  if (value.type !== 'emoji' || typeof value.value !== 'string' || !value.value || value.value.length > 32 || /\s/u.test(value.value) ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value.value)) return false;
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.value)].length === 1; }
  catch { return [...value.value].length <= 8; }
}

export class ChatWSGateway {
  public readonly streamWss: WebSocketServer;
  public readonly rpcWss: WebSocketServer;
  public readonly chatWss: WebSocketServer;
  private readonly manager: InstanceManager;
  private readonly cache: CacheManager;
  private readonly auth?: GUIAuth;

  constructor(manager: InstanceManager, cache: CacheManager, auth?: GUIAuth) {
    this.manager = manager;
    this.cache = cache;
    this.auth = auth;

    // noServer: true lets HTTP server route 'upgrade' events to the appropriate WSS
    this.streamWss = new WebSocketServer({ noServer: true });
    this.rpcWss = new WebSocketServer({ noServer: true });
    this.chatWss = new WebSocketServer({ noServer: true });

    this.initStreamChannel();
    this.initRpcChannel();
    this.wireInstanceEvents();
  }

  /**
   * 通道 1: 实时聊天流 (/ws/chat-stream)
   * 仅向下单向广播高频实时消息、打字中、撤回与更新事件
   */
  private initStreamChannel(): void {
    const onConnection = (ws: WebSocket) => {
      (ws as any).isAlive = true;
      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });

      // 发送当前初始心跳
      ws.send(JSON.stringify({ type: 'connected', channel: 'chat-stream', timestamp: Date.now() }));
    };
    this.streamWss.on('connection', onConnection);
    this.chatWss.on('connection', onConnection);

    // 15 秒心跳保活检测
    const heartbeat = setInterval(() => {
      for (const server of [this.streamWss, this.chatWss]) {
        server.clients.forEach((ws: WebSocket) => {
          if (!(ws as any).isAlive) return ws.terminate();
          (ws as any).isAlive = false;
          ws.ping();
        });
      }
    }, 15000);
    heartbeat.unref();
  }

  /**
   * 通道 2: 双向交互与历史拉取 RPC 通道 (/ws/chat-rpc)
   */
  private initRpcChannel(): void {
    const onConnection = (ws: WebSocket) => {
      if (typeof (ws as any).isAlive !== 'boolean') {
        (ws as any).isAlive = true;
        ws.on('pong', () => { (ws as any).isAlive = true; });
      }

      ws.on('message', async (raw: string) => {
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          return ws.send(JSON.stringify({ error: 'Invalid JSON message' }));
        }

        const { id, action, params = {} } = msg;
        if (!id || !action) return;

        try {
          const result = await this.handleRpcAction(action, params);
          ws.send(JSON.stringify({ id, success: true, data: result }));
        } catch (err: any) {
          ws.send(JSON.stringify({ id, success: false, error: err.message || 'Action failed' }));
        }
      });
    };
    this.rpcWss.on('connection', onConnection);
    this.chatWss.on('connection', onConnection);

    const heartbeat = setInterval(() => {
      this.rpcWss.clients.forEach((ws: WebSocket) => {
        if (!(ws as any).isAlive) return ws.terminate();
        (ws as any).isAlive = false;
        ws.ping();
      });
    }, 15000);
    heartbeat.unref();
  }

  /**
   * 处理聊天 RPC 业务指令
   */
  private async handleRpcAction(action: string, params: any): Promise<any> {
    const { instId } = params;
    const inst = instId ? this.manager.getInstance(instId) : undefined;

    switch (action) {
      case 'get_dialog_folders': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        return await inst.accountAction('get_dialog_folders');
      }
      // Read dialogs from the account. The old stale-while-revalidate cache
      // could replace newer real-time changes with an older snapshot.
      case 'search_dialogs': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const query = String(params.query || '').trim();
        if (query.length > 128) throw new Error('Search query is too long');
        return query ? await inst.accountAction('search_dialogs', { query }) : [];
      }
      case 'get_dialogs': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const fresh = await inst.accountAction('get_dialogs', { limit: params.limit, offset: params.offset, folderId: params.folderId });
        return fresh || [];
      }

      // Always request message history from the account until a cache can
      // reconcile edits, deletions, reconnects and in-flight updates safely.
      case 'get_messages': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, limit = 50, offsetId, offsetDate, search, searchFilter, savedReaction } = params;
        if (!chatId) throw new Error('Missing chatId');
        const allowedSearchFilters = ['photos', 'videos', 'files', 'links', 'music', 'voice', 'round-video', 'round-voice', 'geo', 'calls'];
        if (searchFilter != null && searchFilter !== '' && !allowedSearchFilters.includes(searchFilter)) {
          throw new Error('Invalid message search filter');
        }
        if (savedReaction != null && !validSavedTagReaction(savedReaction)) throw new Error('Invalid Saved Messages tag filter');
        const messages = await inst.accountAction('get_messages', {
          chatId, limit, offsetId, offsetDate, search, searchFilter: searchFilter || undefined,
          ...(savedReaction ? { savedReaction } : {}),
        });
        return messages || [];
      }

      case 'get_draft': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid chatId');
        return await inst.accountAction('get_draft', { chatId });
      }

      case 'save_draft': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof params.text !== 'string' || params.text.length > 16384) throw new Error('Invalid draft');
        return await inst.accountAction('save_draft', { chatId, text: params.text, options: params.options });
      }

      // 3. 发送消息
      case 'send_message': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, text, options } = params;
        const res = await inst.accountAction('send_message', { chatId, text, options });
        return res;
      }

      // 4. 撤回/删除消息
      case 'delete_messages': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageIds, revoke = true } = params;
        const res = await inst.accountAction('delete_messages', { chatId, messageIds, revoke });
        this.cache.deleteMessages(instId, chatId, messageIds);
        this.broadcastStream({ type: 'message_delete', instId, chatId, messageIds });
        return res;
      }

      // 5. 消息 Reaction
      case 'send_reaction': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageId, reaction } = params;
        const res = await inst.accountAction('send_reaction', { chatId, messageId, reaction });
        return res;
      }

      // 6. 置顶消息
      case 'pin_message': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageId, silent = false } = params;
        const res = await inst.accountAction('pin_message', { chatId, messageId, silent });
        return res;
      }

      // 6.1 取消置顶
      case 'unpin_message': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageId } = params;
        const res = await inst.accountAction('unpin_message', { chatId, messageId });
        return res;
      }

      // 6.2 转发消息 (支持单条或多条)
      case 'forward_messages': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { fromChatId, toChatId, messageIds } = params;
        const res = await inst.accountAction('forward_messages', { fromChatId, toChatId, messageIds });
        return res;
      }

      // 6.5 编辑消息
      case 'edit_message': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageId, text, options } = params;
        const res = await inst.accountAction('edit_message', { chatId, messageId, text, options });
        return res;
      }

      // 6.6 标记已读 (已读上报)
      case 'mark_as_read': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, maxId } = params;
        const res = await inst.accountAction('mark_as_read', { chatId, maxId });
        return res;
      }

      // 6.7 群成员获取与管理
      case 'set_chat_title': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), title = params.title;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof title !== 'string' || !title.trim() ||
            title.length > 128 || /[\u0000-\u001f]/.test(title)) throw new Error('Invalid Telegram chat title');
        return inst.accountAction('set_chat_title', { chatId, title: title.trim() });
      }

      case 'set_chat_username': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), username = typeof params.username === 'string' ? params.username.trim() : undefined;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || username === undefined ||
            (username !== '' && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))) throw new Error('Invalid Telegram public username');
        return inst.accountAction('set_chat_username', { chatId, username });
      }

      case 'set_chat_description': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), description = params.description;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof description !== 'string' ||
            description.length > 255 || description.includes('\u0000')) throw new Error('Invalid Telegram chat description');
        return inst.accountAction('set_chat_description', { chatId, description });
      }

      case 'set_chat_permissions': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), rights = params.rights;
        const keys = ['viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
          'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline', 'embedLinks',
          'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics'];
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !rights || typeof rights !== 'object' || Array.isArray(rights) ||
            Object.keys(rights).length !== keys.length || keys.some(key => typeof rights[key] !== 'boolean') ||
            Object.keys(rights).some(key => !keys.includes(key))) throw new Error('Invalid Telegram group permissions');
        return inst.accountAction('set_chat_permissions', { chatId, rights });
      }

      case 'set_chat_slow_mode': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), seconds = params.seconds;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || ![0, 10, 30, 60, 300, 900, 3600].includes(seconds)) {
          throw new Error('Invalid Telegram slow mode');
        }
        return inst.accountAction('set_chat_slow_mode', { chatId, seconds });
      }

      case 'set_supergroup_setting': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), setting = params.setting, enabled = params.enabled;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 ||
            !['joinToSend', 'joinRequest', 'antiSpam', 'participantsHidden'].includes(setting) || typeof enabled !== 'boolean') {
          throw new Error('Invalid Telegram supergroup setting');
        }
        return inst.accountAction('set_supergroup_setting', { chatId, setting, enabled });
      }

      case 'get_participants': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId);
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 50);
        const query = typeof params.query === 'string' ? params.query : '';
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 128) {
          throw new Error('Invalid participant query');
        }
        const res = await inst.accountAction('get_participants', { chatId, offset, limit, query });
        return res;
      }

      case 'get_banned_participants': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 50);
        const query = typeof params.query === 'string' ? params.query : '';
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 128) {
          throw new Error('Invalid banned participant query');
        }
        return inst.accountAction('get_banned_participants', { chatId, offset, limit, query });
      }

      case 'get_chat_invite_links': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), limit = Number(params.limit ?? 50), cursor = params.cursor;
        const pattern = /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            (cursor != null && (typeof cursor !== 'object' || !Number.isSafeInteger(cursor.date) || cursor.date < 0 || typeof cursor.link !== 'string' || !pattern.test(cursor.link)))) {
          throw new Error('Invalid Telegram invite link query');
        }
        return inst.accountAction('get_chat_invite_links', { chatId, cursor, limit });
      }

      case 'create_chat_invite_link': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, title, expireDate, usageLimit, requestNeeded } = params;
        if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 ||
            (title !== undefined && (typeof title !== 'string' || title.length > 32)) ||
            (expireDate !== undefined && (!Number.isSafeInteger(expireDate) || expireDate <= Math.floor(Date.now() / 1000))) ||
            (usageLimit !== undefined && (!Number.isSafeInteger(usageLimit) || usageLimit < 1 || usageLimit > 99999)) ||
            typeof requestNeeded !== 'boolean') throw new Error('Invalid Telegram invite link options');
        return inst.accountAction('create_chat_invite_link', {
          chatId: Number(chatId), title, expireDate, usageLimit, requestNeeded,
        });
      }

      case 'revoke_chat_invite_link': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), link = params.link;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof link !== 'string' ||
            !/^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(link)) {
          throw new Error('Invalid Telegram invite link');
        }
        return inst.accountAction('revoke_chat_invite_link', { chatId, link });
      }

      case 'edit_chat_invite_link': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), link = params.link, title = params.title;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof link !== 'string' ||
            !/^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(link) ||
            typeof title !== 'string' || title.trim().length > 32 || /[\u0000-\u001f]/.test(title)) {
          throw new Error('Invalid Telegram invite link title');
        }
        return inst.accountAction('edit_chat_invite_link', { chatId, link, title: title.trim() });
      }

      case 'get_join_requests': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, cursor, limit = 50, query = '' } = params;
        return inst.accountAction('get_join_requests', { chatId: Number(chatId), cursor, limit: Number(limit), query: String(query) });
      }

      case 'decide_join_request': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId, approved } = params;
        return inst.accountAction('decide_join_request', { chatId: Number(chatId), userId: Number(userId), approved });
      }

      case 'decide_all_join_requests': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, approved } = params;
        return inst.accountAction('decide_all_join_requests', { chatId: Number(chatId), approved });
      }

      case 'kick_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId } = params;
        const res = await inst.accountAction('kick_user', { chatId: Number(chatId), userId: Number(userId) });
        return res;
      }

      case 'invite_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), userId = Number(params.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          throw new Error('Invalid Telegram member invitation');
        }
        return inst.accountAction('invite_user', { chatId, userId });
      }

      case 'create_chat': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { type, title, about = '', userIds = [], forum = false } = params;
        if (!['group', 'supergroup', 'channel'].includes(type) || typeof title !== 'string' || !title.trim() || title.trim().length > 128 ||
            /[\u0000-\u001f]/.test(title) || typeof about !== 'string' || about.length > 255 || about.includes('\u0000') ||
            typeof forum !== 'boolean' || (forum && type !== 'supergroup') || !Array.isArray(userIds) || userIds.length > 200 ||
            (type === 'group' && !userIds.length) || userIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(userIds).size !== userIds.length) {
          throw new Error('Invalid Telegram chat creation options');
        }
        return inst.accountAction('create_chat', { type, title: title.trim(), about, userIds, forum });
      }

      case 'ban_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), userId = Number(params.userId), untilDate = Number(params.untilDate ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
            !Number.isSafeInteger(untilDate) || (untilDate !== 0 && (untilDate <= now || untilDate > now + 31536000))) {
          throw new Error('Invalid Telegram member ban');
        }
        return inst.accountAction('ban_user', { chatId, userId, untilDate });
      }

      case 'unban_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), userId = Number(params.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          throw new Error('Invalid unban target');
        }
        return inst.accountAction('unban_user', { chatId, userId });
      }

      case 'mute_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const chatId = Number(params.chatId), userId = Number(params.userId), seconds = Number(params.seconds ?? 0);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
            !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31536000) throw new Error('Invalid Telegram member mute');
        return inst.accountAction('mute_user', { chatId, userId, seconds });
      }

      case 'promote_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId, perms } = params;
        return inst.accountAction('promote_user', { chatId: Number(chatId), userId: Number(userId), perms });
      }

      case 'demote_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId } = params;
        return inst.accountAction('demote_user', { chatId: Number(chatId), userId: Number(userId) });
      }

      // 6.8 投票与问卷
      case 'send_poll': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, question, options, pollOptions } = params;
        const res = await inst.accountAction('send_poll', { chatId, question, options, pollOptions });
        return res;
      }

      case 'send_vote': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, messageId, optionIndexes } = params;
        const res = await inst.accountAction('send_vote', { chatId, messageId, optionIndexes });
        return res;
      }

      // 6.9 会话免打扰静音
      case 'set_chat_mute': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, muteUntil } = params;
        const res = await inst.accountAction('set_chat_mute', { chatId, muteUntil });
        return res;
      }

      // 6.10 一键全标已读
      case 'mark_all_read': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const res = await inst.accountAction('mark_all_read');
        return res;
      }

      // 7. 缓存系统信息与动态配置
      case 'get_cache_stats': {
        return this.cache.getStats();
      }

      case 'set_cache_limit': {
        const { maxMB } = params;
        if (typeof maxMB === 'number' && maxMB >= 100) {
          this.cache.setLimit(maxMB * 1024 * 1024);
        }
        return this.cache.getStats();
      }

      case 'clear_cache': {
        this.cache.clearAll();
        return this.cache.getStats();
      }

      default:
        throw new Error(`Unknown RPC action: "${action}"`);
    }
  }

  /**
   * 绑定底层 Telegram 账号事件，驱动 WebSocket 实时广播
   */
  private wireInstanceEvents(): void {
    this.manager.on('log', (d) => {
      // 广播日志到 stream
      this.broadcastStream({ type: 'log', data: d });
    });

    this.manager.on('status_change', (d) => {
      this.broadcastStream({ type: 'status_change', data: d });
    });

    // 监听实时 Telegram 消息事件推送
    this.manager.on('raw_event', (event: any) => {
      if (!event || !event.type) return;
      if (event.type === 'new_message' && event.instId && event.message) {
        this.cache.prependMessage(event.instId, event.message.chatId, event.message);
      }
      if (event.type === 'message_edited' && event.instId && event.message) {
        this.cache.updateMessage(event.instId, event.message.chatId, event.message);
      }
      if (event.type === 'message_delete' && event.instId && event.chatId && Array.isArray(event.messageIds)) {
        this.cache.deleteMessages(event.instId, event.chatId, event.messageIds);
      }
      this.broadcastStream(event);
    });
  }

  /**
   * 向所有连接到 chat-stream 的客户端广播消息
   */
  public broadcastStream(data: any): void {
    const raw = JSON.stringify(data);
    for (const server of [this.streamWss, this.chatWss]) server.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(raw, (err) => {
            if (err) {
              try { client.terminate(); } catch {}
            }
          });
        } catch {
          try { client.terminate(); } catch {}
        }
      }
    });
  }
}

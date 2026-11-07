import { WebSocketServer, WebSocket } from 'ws';
import type { InstanceManager } from '../manager';
import { CacheManager } from './cache-manager';
import type { GUIAuth } from './auth';

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
    this.chatWss.on('connection', (ws: WebSocket) => {
      this.initHeartbeat(ws);
      this.initRpcHandler(ws);
      ws.send(JSON.stringify({ type: 'connected', channel: 'chat', timestamp: Date.now() }));
    });
    const heartbeat = setInterval(() => {
      for (const server of [this.streamWss, this.rpcWss, this.chatWss]) {
        server.clients.forEach((ws: WebSocket) => {
          if (!(ws as any).isAlive) return ws.terminate();
          (ws as any).isAlive = false;
          ws.ping();
        });
      }
    }, 15000);
    heartbeat.unref();
    this.wireInstanceEvents();
  }

  /**
   * 通道 1: 实时聊天流 (/ws/chat-stream)
   * 仅向下单向广播高频实时消息、打字中、撤回与更新事件
   */
  private initStreamChannel(): void {
    this.streamWss.on('connection', (ws: WebSocket) => {
      this.initHeartbeat(ws);

      // 发送当前初始心跳
      ws.send(JSON.stringify({ type: 'connected', channel: 'chat-stream', timestamp: Date.now() }));
    });
  }

  /**
   * 通道 2: 双向交互与历史拉取 RPC 通道 (/ws/chat-rpc)
   */
  private initRpcChannel(): void {
    this.rpcWss.on('connection', (ws: WebSocket) => {
      this.initHeartbeat(ws);
      this.initRpcHandler(ws);
    });
  }

  private initHeartbeat(ws: WebSocket): void {
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
  }

  private initRpcHandler(ws: WebSocket): void {
    ws.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ error: 'Invalid JSON message' }));
        return;
      }

      if (!msg || typeof msg !== 'object') return;
      const { id, action, params = {} } = msg;
      if (!id || !action) return;

      try {
        const result = await this.handleRpcAction(action, params);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, success: true, data: result }));
      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, success: false, error: err.message || 'Action failed' }));
      }
    });
  }

  /**
   * 处理聊天 RPC 业务指令
   */
  private async handleRpcAction(action: string, params: any): Promise<any> {
    const { instId } = params;
    const inst = instId ? this.manager.getInstance(instId) : undefined;

    switch (action) {
      // 1. 获取会话列表 (优先读内存高速缓存)
      case 'get_dialogs': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const forceRefresh = Boolean(params.refresh);
        const cached = !forceRefresh ? this.cache.getDialogs(instId) : null;
        if (cached && cached.length > 0) {
          // 异步后台静默刷新
          setTimeout(async () => {
            try {
              const fresh = await inst.accountAction('get_dialogs', {});
              if (Array.isArray(fresh)) {
                this.cache.setDialogs(instId, fresh);
                this.broadcastStream({ type: 'dialogs_update', instId, dialogs: fresh });
              }
            } catch {
              /* ignore */
            }
          }, 100);
          return cached;
        }

        const fresh = await inst.accountAction('get_dialogs', {});
        if (Array.isArray(fresh)) {
          this.cache.setDialogs(instId, fresh);
        }
        return fresh || [];
      }

      // 2. 获取特定会话的历史消息 (优先从最近消息缓存读取)
      case 'get_messages': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, limit = 50, offsetId, search } = params;
        if (!chatId) throw new Error('Missing chatId');

        // 如果指定了 search 关键字，直接穿透请求底层检索，不走缓存
        if (search) {
          return await inst.accountAction('get_messages', { chatId, limit, search });
        }

        // 如果未指定翻页偏移量，优先命中最近 100 条环形缓存
        if (!offsetId) {
          const cached = this.cache.getRecentMessages(instId, chatId);
          if (cached && cached.length > 0) {
            // 异步后台同步最新
            setTimeout(async () => {
              try {
                const fresh = await inst.accountAction('get_messages', { chatId, limit });
                if (Array.isArray(fresh)) {
                  this.cache.setRecentMessages(instId, chatId, fresh);
                  this.broadcastStream({ type: 'messages_update', instId, chatId, messages: fresh });
                }
              } catch {
                /* ignore */
              }
            }, 50);
            return cached;
          }
        }

        const messages = await inst.accountAction('get_messages', { chatId, limit, offsetId });
        if (Array.isArray(messages) && !offsetId) {
          this.cache.setRecentMessages(instId, chatId, messages);
        }
        return messages || [];
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
      case 'get_participants': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, limit = 100 } = params;
        const res = await inst.accountAction('get_participants', { chatId: Number(chatId), limit: Number(limit) });
        return res;
      }

      case 'kick_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId } = params;
        const res = await inst.accountAction('kick_user', { chatId: Number(chatId), userId: Number(userId) });
        return res;
      }

      case 'ban_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId, untilDate } = params;
        const res = await inst.accountAction('ban_user', { chatId: Number(chatId), userId: Number(userId), untilDate: Number(untilDate || 0) });
        return res;
      }

      case 'mute_user': {
        if (!inst) throw new Error(`Instance "${instId}" not found`);
        const { chatId, userId, seconds } = params;
        const res = await inst.accountAction('mute_user', { chatId: Number(chatId), userId: Number(userId), seconds: Number(seconds || 0) });
        return res;
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
        // 更新缓存
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
    for (const server of [this.streamWss, this.chatWss]) {
      server.clients.forEach((client) => {
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
}

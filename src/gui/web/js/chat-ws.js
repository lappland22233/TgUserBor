'use strict';

// ==========================================
// Chat events and RPC share one connection, leaving more capacity for HTTP.
// ==========================================
class ChatWSManager {
  constructor() {
    this.ws = null;
    this.rpcCallbacks = new Map();
    this.rpcIdCounter = 0;
    this.reconnectTimer = null;
    this.isManualClosed = false;
    this.messageSnapshots = new Set();
    this.dialogSnapshots = new Set();
    this.dialogRefreshTimer = null;
    this.unknownDeletionTimer = null;
    this.needsResync = false;
    this.readOnFocusPending = false;
  }

  connect() {
    this.isManualClosed = false;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    // A closing socket can still have requests in flight. Do not let its
    // eventual close clear requests made on the replacement.
    if (this.ws) {
      this.ws = null;
      this.rejectPending('Connection closed');
      this.needsResync = true;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const socket = this.ws = new WebSocket(`${proto}//${location.host}/ws/chat`);
      socket.onmessage = (e) => {
        if (this.ws !== socket) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.id && this.rpcCallbacks.has(msg.id)) {
            const cb = this.rpcCallbacks.get(msg.id);
            this.rpcCallbacks.delete(msg.id);
            clearTimeout(cb.timeout);
            if (msg.success) cb.resolve(msg.data);
            else cb.reject(new Error(msg.error || 'RPC action failed'));
          } else if (msg.type) {
            this.handleStreamEvent(msg);
          }
        } catch (_) {}
      };
      socket.onerror = () => {};
      socket.onopen = () => { if (this.ws === socket) this.resyncIfReady(); };
      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.ws = null;
        this.rejectPending('Connection closed');
        if (!this.isManualClosed) {
          this.needsResync = true;
          this.scheduleReconnect();
        }
      };
    } catch (_) { this.needsResync = true; this.scheduleReconnect(); }
  }

  disconnect() {
    if (this.ws) this.needsResync = true;
    this.isManualClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.dialogRefreshTimer) {
      clearTimeout(this.dialogRefreshTimer);
      this.dialogRefreshTimer = null;
    }
    if (this.unknownDeletionTimer) {
      clearTimeout(this.unknownDeletionTimer);
      this.unknownDeletionTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try { socket.close(); } catch (_) {}
    }
    this.rejectPending('Connection closed');
  }

  rejectPending(reason) {
    this.rpcCallbacks.forEach((cb) => {
      clearTimeout(cb.timeout);
      cb.reject(new Error(reason));
    });
    this.rpcCallbacks.clear();
  }

  isConnected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async markVisibleChatRead() {
    if (this.readOnFocusPending || document.hidden === true ||
        (typeof document.hasFocus === 'function' && !document.hasFocus()) ||
        !document.getElementById('view-client')?.classList.contains('active') ||
        state.clientHistoryOffsetDate != null || state.clientSavedReactionFilter || !this.isConnected()) return;
    const instId = state.clientSelectedInstance;
    const chatId = state.clientActiveChatId;
    const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(chatId));
    if (dialog?.isForum || (typeof window !== 'undefined' && window.ForumTopics?.isCurrentForum?.())) return;
    if (!instId || chatId == null || !dialog || !dialog.unreadCount) return;
    const maxId = Math.max(0, ...(state.clientMessages || []).map((m) => Number(m.id) || 0));
    if (!maxId) return;
    this.readOnFocusPending = true;
    try {
      await this.sendRpc('mark_as_read', { instId, chatId, maxId });
      if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId)) return;
      const current = state.clientDialogs.find((d) => String(d.id) === String(chatId));
      if (current && Number(current.lastMessageId || 0) <= maxId) {
        current.unreadCount = 0;
        this.recordDialogRead(instId, chatId, maxId);
        renderClientDialogs();
      }
    } catch (_) { /* Keep unread state if the request fails. */ }
    finally { this.readOnFocusPending = false; }
  }

  resyncIfReady() {
    if (!this.needsResync || this.isManualClosed || !this.isConnected()) return;
    this.needsResync = false;
    if (!state.clientSelectedInstance) return;
    // Refresh both views after the stream has missed events. The message
    // loader guards against account/chat switches and replays in-flight events.
    if (typeof window !== 'undefined') window.DialogFolders?.load();
    if (typeof window !== 'undefined' && typeof window.loadClientStoriesFeed === 'function') window.loadClientStoriesFeed(true, true);
    if (typeof window !== 'undefined' && state.currentProfileIsSelf && typeof window.loadStoryArchive === 'function') window.loadStoryArchive(true);
    loadClientDialogs();
    if (state.clientActiveChatId != null) {
      loadClientMessages(state.clientActiveChatId, true);
    }
  }

  beginMessageSnapshot(instId, chatId) {
    const snapshot = { instId, chatId: String(chatId), events: [] };
    this.messageSnapshots.add(snapshot);
    return snapshot;
  }

  beginDialogSnapshot(instId) {
    const snapshot = { instId, events: [] };
    this.dialogSnapshots.add(snapshot);
    return snapshot;
  }

  finishDialogSnapshot(snapshot, dialogs) {
    this.dialogSnapshots.delete(snapshot);
    if (!Array.isArray(dialogs)) return dialogs;
    const result = dialogs.map((dialog) => ({ ...dialog }));
    let needsRefresh = false;
    for (const event of snapshot.events) {
      if (this.applyDialogEvent(result, event)) needsRefresh = true;
    }
    if (needsRefresh) this.scheduleDialogRefresh(snapshot.instId);
    return result;
  }

  recordDialogRead(instId, chatId, maxId) {
    const event = { type: 'local_read', instId, chatId, maxId };
    for (const snapshot of this.dialogSnapshots) {
      if (snapshot.instId === instId) snapshot.events.push(event);
    }
  }

  scheduleDialogRefresh(instId) {
    if (this.dialogRefreshTimer) return;
    this.dialogRefreshTimer = setTimeout(() => {
      this.dialogRefreshTimer = null;
      if (!this.isManualClosed && state.clientSelectedInstance === instId) loadClientDialogs();
    }, 250);
  }

  // UpdateDeleteMessages does not identify the private chat or basic group.
  // Message IDs cannot safely be used to choose a chat: channel IDs can
  // overlap. Re-fetch the selected view instead of deleting any local item.
  scheduleUnknownDeletionRefresh(instId) {
    this.scheduleDialogRefresh(instId);
    const chatId = state.clientActiveChatId;
    if (chatId == null) return;
    const selectionVersion = state.chatSelectionVersion;
    if (this.unknownDeletionTimer) clearTimeout(this.unknownDeletionTimer);
    this.unknownDeletionTimer = setTimeout(() => {
      this.unknownDeletionTimer = null;
      if (!this.isManualClosed && state.clientSelectedInstance === instId &&
          String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
        loadClientMessages(chatId, true);
      }
    }, 250);
  }

  // Returns true when the event lacks enough information for a safe preview.
  applyDialogEvent(dialogs, event) {
    const message = event.message;
    const chatId = message ? message.chatId : event.type === 'user_status' ? event.userId : event.chatId;
    const index = dialogs.findIndex((dialog) => String(dialog.id) === String(chatId));
    if (index < 0) return event.type === 'new_message';
    const dialog = dialogs[index];
    if (event.type === 'history_ttl') {
      dialog.ttlPeriod = event.period;
    } else if (event.type === 'user_status') {
      dialog.online = Boolean(event.online);
      dialog.lastSeen = event.lastSeen || undefined;
    } else if (event.type === 'local_read') {
      if (!event.maxId || !dialog.lastMessageId || Number(dialog.lastMessageId) <= Number(event.maxId)) dialog.unreadCount = 0;
    } else if (event.type === 'message_read') {
      const maxId = Number(event.maxId);
      if (Number.isSafeInteger(maxId) && maxId > 0) dialog.readOutboxMaxId = Math.max(Number(dialog.readOutboxMaxId) || 0, maxId);
    } else if (event.type === 'new_message') {
      const id = Number(message.id);
      const lastId = Number(dialog.lastMessageId || 0);
      // The returned snapshot may already include the event. Its top-message
      // ID prevents both duplicate previews and duplicate unread counts.
      if (id && lastId && id <= lastId) return false;
      if (!id) return true;
      dialog.lastMessageId = id;
      dialog.lastMessage = message.text || (message.media ? `[${message.media.type}]` : '');
      dialog.lastSender = message.from?.firstName || message.from?.username || '';
      dialog.lastMessageDate = Number(message.date) || Date.now();
      if (!event.activeChat && !message.outgoing) dialog.unreadCount = (dialog.unreadCount || 0) + 1;
      if (!dialog.pinned) {
        dialogs.splice(index, 1);
        const firstUnpinned = dialogs.findIndex((item) => !item.pinned);
        dialogs.splice(firstUnpinned < 0 ? dialogs.length : firstUnpinned, 0, dialog);
      }
    } else if ((event.type === 'message_edited' || event.type === 'message_edit') &&
               Number(dialog.lastMessageId) === Number(message.id)) {
      dialog.lastMessage = message.text || (message.media ? `[${message.media.type}]` : '');
    } else if (event.type === 'message_delete' &&
               event.messageIds.some((id) => Number(id) === Number(dialog.lastMessageId))) {
      return true;
    }
    return false;
  }

  finishMessageSnapshot(snapshot, messages, includeNew = true) {
    this.messageSnapshots.delete(snapshot);
    if (!Array.isArray(messages)) return messages;
    let result = [...messages];
    for (const event of snapshot.events) {
      if (event.type === 'message_delete') {
        const ids = new Set(event.messageIds.map(String));
        result = result.filter((message) => !ids.has(String(message.id)));
      } else {
        const index = result.findIndex((message) => String(message.id) === String(event.message.id));
        if (index >= 0) result[index] = event.message;
        else if (includeNew && event.type === 'new_message') result.push(event.message);
      }
    }
    return result;
  }

  scheduleReconnect() {
    if (this.isManualClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isManualClosed) this.connect();
    }, 3000);
  }

  sendRpc(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('RPC WebSocket is not connected'));
      }
      const id = ++this.rpcIdCounter;
      const timeout = setTimeout(() => {
        if (this.rpcCallbacks.has(id)) {
          this.rpcCallbacks.delete(id);
          reject(new Error(`RPC timeout for action "${action}"`));
        }
      }, 8000);

      this.rpcCallbacks.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, action, params }));
      } catch (err) {
        clearTimeout(timeout);
        this.rpcCallbacks.delete(id);
        reject(err);
      }
    });
  }

  handleStreamEvent(event) {
    if (!event || !event.type) return;
    // Stream broadcasts include every managed account. Never apply another
    // account's updates to the selected account's in-memory state.
    if (event.instId !== state.clientSelectedInstance) return;
    if (event.type === 'draft_updated') {
      if (typeof window !== 'undefined') window.CloudDrafts?.incoming(event.instId, event.chatId, event.draft);
      return;
    }
    if (event.type === 'stories_updated') {
      if (typeof window !== 'undefined') {
        if (typeof window.loadClientStoriesFeed === 'function') window.loadClientStoriesFeed(true, true);
        if (event.storyId && typeof window.refreshStoryViewerForUpdate === 'function') {
          window.refreshStoryViewerForUpdate(event.instId, event.chatId, event.storyId);
        }
        if (event.storyId && state.currentProfileIsSelf && Number(state.currentProfileChatId) === Number(event.chatId) &&
            typeof window.loadStoryArchive === 'function') window.loadStoryArchive(true);
      }
      return;
    }
    if (event.type === 'stories_stealth_updated') {
      if (typeof window !== 'undefined' && typeof window.refreshStoryStealthStatus === 'function') {
        window.refreshStoryStealthStatus(event.instId);
      }
      return;
    }
    if (event.type === 'forum_topics_updated') {
      if (typeof window !== 'undefined' && event.chatId != null && Number(event.chatId) === Number(state.clientActiveChatId)) {
        window.ForumTopics?.refreshTopics?.();
      }
      return;
    }
    if (event.type === 'chat_history_ttl_updated') {
      const chatId = Number(event.chatId);
      const period = Number(event.period);
      if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(period) || period < 0 || period > 31536000) return;
      const tracked = { ...event, type: 'history_ttl', chatId, period };
      for (const snapshot of this.dialogSnapshots) {
        if (snapshot.instId === event.instId) snapshot.events.push(tracked);
      }
      const needsRefresh = this.applyDialogEvent(state.clientDialogs, tracked);
      if (needsRefresh && this.dialogSnapshots.size === 0) this.scheduleDialogRefresh(event.instId);
      renderClientDialogs();
      if (typeof window !== 'undefined' && typeof window.applyPeerHistoryTtlUpdate === 'function') {
        window.applyPeerHistoryTtlUpdate(chatId, period);
      }
      return;
    }
    if (event.type === 'peer_wallpaper_updated') {
      const chatId = Number(event.chatId);
      if (Number.isSafeInteger(chatId) && chatId !== 0 && chatId === Number(state.clientActiveChatId) &&
          typeof window !== 'undefined' && typeof window.refreshTelegramChatWallpaper === 'function') {
        window.refreshTelegramChatWallpaper(event.instId, chatId);
      }
      return;
    }
    if (typeof window !== 'undefined') window.BotKeyboard?.applyReplyEvent(event);
    if (event.type === 'dialog_folders_changed') {
      window.DialogFolders?.load();
      return;
    }
    if (event.type === 'message_delete' && Array.isArray(event.messageIds) && event.messageIds.length &&
        (event.chatId == null || String(event.chatId) === '0')) {
      this.scheduleUnknownDeletionRefresh(event.instId);
      return;
    }
    const foreground = document.hidden !== true &&
      (typeof document.hasFocus !== 'function' || document.hasFocus());

    const messageEvent = (event.type === 'new_message' || event.type === 'message_edited' ||
      event.type === 'message_edit') && event.message;
    const deleteEvent = event.type === 'message_delete' && Array.isArray(event.messageIds);
    const dialogEvent = messageEvent || deleteEvent || event.type === 'user_status' || event.type === 'message_read';
    if (dialogEvent) {
      // Do not assume a visible message was marked read: wait for Telegram's
      // acknowledgement below. This also makes failed reads visible as unread.
      const tracked = { ...event, activeChat: false };
      for (const snapshot of this.dialogSnapshots) {
        if (snapshot.instId === event.instId) snapshot.events.push(tracked);
      }
      const refresh = this.applyDialogEvent(state.clientDialogs, tracked);
      if (refresh && this.dialogSnapshots.size === 0) this.scheduleDialogRefresh(event.instId);
      if (event.type !== 'user_status') renderClientDialogs();
    }
    if (messageEvent || deleteEvent) {
      const chatId = String(messageEvent ? event.message.chatId : event.chatId);
      for (const snapshot of this.messageSnapshots) {
        if (snapshot.instId === event.instId && snapshot.chatId === chatId) snapshot.events.push(event);
      }
    }

    // Real-time message push
    if (event.type === 'new_message' && event.message) {
      const m = event.message;
      if (typeof window !== 'undefined' && window.ChatNotifications) window.ChatNotifications.maybeNotify(event, state);
      const isCurrentChat =
        event.instId === state.clientSelectedInstance &&
        String(m.chatId) === String(state.clientActiveChatId);
      const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(m.chatId));
      const isForum = Boolean(dialog?.isForum || (isCurrentChat && typeof window !== 'undefined' && window.ForumTopics?.isCurrentForum?.()));
      if (isCurrentChat && isForum && typeof window !== 'undefined') window.ForumTopics?.handleMessage?.(m);
      if (isCurrentChat && state.clientHistoryOffsetDate == null && !state.clientSavedReactionFilter) {
        if (!state.clientMessages.some((x) => String(x.id) === String(m.id))) {
          state.clientMessages.push(m);
          renderClientMessages(false);
          // Auto mark as read if active chat
          try {
            if (!m.outgoing && !isForum && foreground && this.isConnected()) {
              const selectionVersion = state.chatSelectionVersion;
              this.sendRpc('mark_as_read', { instId: event.instId, chatId: m.chatId, maxId: m.id }).then(() => {
                if (state.clientSelectedInstance !== event.instId || String(state.clientActiveChatId) !== String(m.chatId) ||
                    state.chatSelectionVersion !== selectionVersion) return;
                const dialog = state.clientDialogs.find((d) => String(d.id) === String(m.chatId));
                if (dialog && (!dialog.lastMessageId || Number(dialog.lastMessageId) <= Number(m.id))) {
                  dialog.unreadCount = 0;
                  renderClientDialogs();
                }
                this.recordDialogRead(event.instId, m.chatId, m.id);
              }).catch(() => {});
            }
          } catch (_) {}
        }
      }
    }

    // Real-time message edit
    if ((event.type === 'message_edited' || event.type === 'message_edit') && event.message) {
      const m = event.message;
      if (
        event.instId === state.clientSelectedInstance &&
        String(m.chatId) === String(state.clientActiveChatId)
      ) {
        const idx = state.clientMessages.findIndex((x) => String(x.id) === String(m.id));
        if (idx !== -1) {
          state.clientMessages[idx] = m;
          renderClientMessages(true);
        }
      }
    }

    // Real-time message delete
    if (event.type === 'message_delete' && event.messageIds) {
      if (
        event.instId === state.clientSelectedInstance &&
        String(event.chatId) === String(state.clientActiveChatId)
      ) {
        const idSet = new Set(event.messageIds.map(String));
        state.clientMessages = state.clientMessages.filter((m) => !idSet.has(String(m.id)));
        renderClientMessages(true);
      }
    }

    // Real-time peer typing push
    if (event.type === 'chat_typing' && event.instId === state.clientSelectedInstance) {
      const cancelled = event.action === 'SendMessageCancelAction';
      if (String(event.chatId) === String(state.clientActiveChatId)) {
        const subtitleEl = document.getElementById('client-chat-subtitle');
        if (subtitleEl) {
          if (state.typingTimer) clearTimeout(state.typingTimer);
          state.typingTimer = null;
          const restoreSubtitle = () => {
            if (state.clientSelectedInstance !== event.instId || String(state.clientActiveChatId) !== String(event.chatId)) return;
            const curDialog = state.clientDialogs.find((d) => String(d.id) === String(event.chatId));
            if (curDialog) {
              const typeMap = { private: '私聊 (Private)', group: '普通群组 (Group)', supergroup: '超级群组 (Supergroup)', channel: '广播频道 (Channel)', bot: '机器人 (Bot)' };
              const userTag = curDialog.username ? ` | @${curDialog.username}` : '';
              subtitleEl.innerText = `${typeMap[curDialog.type] || curDialog.type} | ID: ${curDialog.id}${userTag}`;
            }
          };
          if (cancelled) {
            restoreSubtitle();
          } else {
            const sender = state.clientMessages.find((m) => String(m.from?.id) === String(event.userId))?.from?.firstName || '对方';
            subtitleEl.innerHTML = `<span style="color:var(--color-primary);">${escapeHtml(sender)} 正在输入<span class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span></span>`;
            state.typingTimer = setTimeout(() => {
              state.typingTimer = null;
              restoreSubtitle();
            }, 4500);
          }
        }
      } else {
        // Show typing indicator in dialog list
        const dIndex = state.clientDialogs.findIndex((d) => String(d.id) === String(event.chatId));
        if (dIndex !== -1) {
          const d = state.clientDialogs[dIndex];
          d._typing = !cancelled;
          renderClientDialogs();
          // Clear after timeout
          if (d._typingTimer) clearTimeout(d._typingTimer);
          d._typingTimer = cancelled ? null : setTimeout(() => {
            d._typing = false;
            renderClientDialogs();
          }, 4500);
        }
      }
    }

    // Real-time message read receipt
    if (event.type === 'message_read' && event.instId === state.clientSelectedInstance) {
      const maxId = Number(event.maxId || 0);
      const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(event.chatId));
      if (dialog && Number.isSafeInteger(maxId) && maxId > 0) {
        dialog.readOutboxMaxId = Math.max(Number(dialog.readOutboxMaxId) || 0, maxId);
      }
      if (String(event.chatId) !== String(state.clientActiveChatId)) return;
      // Mark all outgoing messages <= maxId as read
      for (const m of state.clientMessages) {
        if (m.outgoing && m.id <= maxId && !m.read) {
          m.read = true;
          // Update tick in-place
          const msgEl = document.getElementById(`chat-msg-${m.id}`);
          if (msgEl) {
            const tick = msgEl.querySelector('.msg-status-tick');
            if (tick) {
              tick.className = 'msg-status-tick read';
              tick.title = '已读';
              tick.textContent = '✓✓';
            }
          }
        }
      }
    }

    // Real-time user online status
    if (event.type === 'user_status' && event.instId === state.clientSelectedInstance) {
      const userId = String(event.userId);
      // Update dialog list
      renderClientDialogs();
      // Update chat header subtitle if current chat
      if (String(state.clientActiveChatId) === userId) {
        const subtitleEl = document.getElementById('client-chat-subtitle');
        if (subtitleEl && !state.typingTimer) {
          if (event.online) {
            subtitleEl.innerHTML = '<span style="color:var(--tg-online-dot);">在线</span>';
          } else if (event.lastSeen) {
            const ls = new Date(event.lastSeen);
            subtitleEl.innerText = `最后上线于 ${ls.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          } else {
            subtitleEl.innerText = '最近上线时间不可见';
          }
        }
      }
    }

    // Real-time dialogs update
    if (event.type === 'dialogs_update' && event.instId === state.clientSelectedInstance) {
      if (Array.isArray(event.dialogs)) {
        state.clientDialogs = event.dialogs;
        renderClientDialogs();
      }
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('focus', () => window.chatWs?.markVisibleChatRead());
}
if (typeof window !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.chatWs?.markVisibleChatRead();
  });
}

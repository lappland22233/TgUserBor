'use strict';

// Browser notifications are opt-in and only available while the chat view is open.
(function () {
  const storageKey = 'tgbot_desktop_notifications';
  const recent = new Set();

  function enabled() {
    return localStorage.getItem(storageKey) === 'true';
  }

  async function setEnabled(value) {
    if (!value) {
      localStorage.setItem(storageKey, 'false');
      return false;
    }
    if (!('Notification' in window)) return false;
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    const allowed = permission === 'granted';
    localStorage.setItem(storageKey, String(allowed));
    return allowed;
  }

  function maybeNotify(event, currentState) {
    const message = event?.message;
    if (!enabled() || !('Notification' in window) || Notification.permission !== 'granted' ||
        !message || message.outgoing || event.instId !== currentState.clientSelectedInstance) return;
    const dialog = (currentState.clientDialogs || []).find((d) => String(d.id) === String(message.chatId));
    if (dialog?.muted) return;
    const currentChat = String(currentState.clientActiveChatId) === String(message.chatId) &&
      currentState.clientHistoryOffsetDate == null;
    const foreground = document.hidden !== true && (typeof document.hasFocus !== 'function' || document.hasFocus());
    if (currentChat && foreground) return;
    const key = `${event.instId}:${message.chatId}:${message.id}`;
    if (recent.has(key)) return;
    recent.add(key);
    if (recent.size > 200) recent.delete(recent.values().next().value);
    const title = dialog?.title || dialog?.username || message.from?.firstName || 'Telegram';
    const body = message.text || (message.media ? '收到媒体消息' : '收到新消息');
    try {
      const notification = new Notification(title, { body, tag: key });
      notification.onclick = () => { window.focus(); notification.close(); };
    } catch (_) { /* The browser may disable notifications after permission was granted. */ }
  }

  window.ChatNotifications = { enabled, setEnabled, maybeNotify };
})();

'use strict';

// Channel discussions are separate from the active chat's message list.
// Account, chat and selection version are captured before any async operation.
window.ChatComments = (() => {
  let modal, list, status, textarea, send, more, title, fileInput, fileName, clearFile, refresh;
  let active = null;
  let sequence = 0;
  let loading = false;
  let sending = false;
  let oldestId = null;
  let renderedIds = new Set();
  let selectedFile = null;
  let refreshTimer = null;
  let loadedOlder = false;

  function init() {
    if (modal) return;
    const style = document.createElement('style');
    style.textContent = `
      .channel-comments-overlay { position:fixed;inset:0;z-index:1500;background:#0009;display:flex;align-items:center;justify-content:center;padding:16px; }
      .channel-comments-overlay[hidden] { display:none; }
      .channel-comments-window { background:var(--bg-card,#202a33);color:var(--text-primary,#fff);border-radius:12px;width:min(600px,100%);height:min(700px,90vh);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 60px #0008; }
      .channel-comments-header { display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border-color,#ffffff24); }
      .channel-comments-list { flex:1;overflow:auto;padding:12px 16px; }
      .channel-comment { border-bottom:1px solid var(--border-color,#ffffff18);padding:10px 0;white-space:pre-wrap;overflow-wrap:anywhere; }
      .channel-comment-author { font-weight:600;margin-bottom:4px; }
      .channel-comment-date { color:var(--text-muted,#aaa);font-size:12px;margin-left:8px;font-weight:normal; }
      .channel-comments-status { color:var(--text-muted,#aaa);padding:4px 16px;min-height:22px; }
      .channel-comments-compose { display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border-color,#ffffff24); }
      .channel-comments-compose textarea { flex:1;min-width:0;resize:vertical;min-height:40px;max-height:120px; }
      .channel-comments-attachment { padding:0 16px;overflow-wrap:anywhere;color:var(--text-muted,#aaa); }
      .channel-comments-attach { position:relative;overflow:hidden;flex:none; }
      .channel-comments-attach:focus-within { outline:2px solid var(--color-primary,#4fa9ed);outline-offset:2px; }
      .channel-comments-attach input { position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer; }
      .channel-comment-media { display:block;max-width:100%;max-height:320px;margin-top:8px; }
      .channel-comment-media img { max-width:100%;max-height:320px;object-fit:contain; }
      .channel-comments-more { margin:8px auto;display:block; }
    `;
    document.head.appendChild(style);
    modal = document.createElement('div');
    modal.className = 'channel-comments-overlay';
    modal.hidden = true;
    modal.innerHTML = `<div class="channel-comments-window" role="dialog" aria-modal="true" aria-labelledby="channel-comments-title">
      <div class="channel-comments-header"><strong id="channel-comments-title">评论</strong><div><button type="button" class="btn btn-secondary btn-sm" data-refresh>刷新</button> <button type="button" class="btn btn-secondary btn-sm" data-close aria-label="关闭评论">关闭</button></div></div>
      <div class="channel-comments-list" aria-live="polite"></div><button type="button" class="btn btn-secondary btn-sm channel-comments-more" hidden>加载更早评论</button>
      <div class="channel-comments-status" role="status"></div><div class="channel-comments-attachment"><span data-file-name></span> <button type="button" class="btn btn-secondary btn-xs" data-clear-file hidden>移除附件</button></div><div class="channel-comments-compose"><label class="btn btn-secondary channel-comments-attach"><span>附件</span><input type="file" data-file aria-label="选择评论附件"></label><textarea class="form-textarea" maxlength="4096" placeholder="添加评论" aria-label="添加评论"></textarea><button type="button" class="btn btn-primary" data-send>发送</button></div></div>`;
    document.body.appendChild(modal);
    list = modal.querySelector('.channel-comments-list');
    status = modal.querySelector('.channel-comments-status');
    textarea = modal.querySelector('textarea');
    send = modal.querySelector('[data-send]');
    more = modal.querySelector('.channel-comments-more');
    title = modal.querySelector('#channel-comments-title');
    fileInput = modal.querySelector('[data-file]');
    fileName = modal.querySelector('[data-file-name]');
    clearFile = modal.querySelector('[data-clear-file]');
    refresh = modal.querySelector('[data-refresh]');
    fileInput.onchange = () => {
      selectedFile = fileInput.files?.[0] || null;
      fileName.textContent = selectedFile ? selectedFile.name : '';
      clearFile.hidden = !selectedFile;
    };
    clearFile.onclick = () => { selectedFile = null; fileInput.value = ''; fileName.textContent = ''; clearFile.hidden = true; };
    modal.querySelector('[data-close]').onclick = close;
    modal.onclick = (event) => { if (event.target === modal) close(); };
    modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    send.onclick = sendComment;
    more.onclick = () => load(true);
    refresh.onclick = () => load(false);
  }

  function current(context = active) {
    return Boolean(context && context === active && state.clientSelectedInstance === context.instId &&
      String(state.clientActiveChatId) === String(context.chatId) && state.chatSelectionVersion === context.version);
  }

  function close() {
    ++sequence;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    active = null;
    loading = false;
    // A pending request can still complete; its captured context prevents it
    // from changing a newly opened thread.
    sending = false;
    selectedFile = null;
    if (fileInput) { fileInput.value = ''; fileInput.disabled = false; }
    if (fileName) fileName.textContent = '';
    if (clearFile) { clearFile.hidden = true; clearFile.disabled = false; }
    if (modal) modal.hidden = true;
  }

  function open(messageId, chatId) {
    if (!state.clientSelectedInstance || String(state.clientActiveChatId) !== String(chatId)) return;
    init();
    ++sequence;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    active = { instId: state.clientSelectedInstance, chatId, messageId, version: state.chatSelectionVersion };
    modal.hidden = false;
    list.textContent = '';
    textarea.value = '';
    selectedFile = null;
    fileInput.value = '';
    fileInput.disabled = false;
    fileName.textContent = '';
    clearFile.hidden = true;
    clearFile.disabled = false;
    title.textContent = '评论';
    status.textContent = '';
    send.disabled = false;
    more.hidden = true;
    loading = false;
    sending = false;
    oldestId = null;
    renderedIds = new Set();
    loadedOlder = false;
    load(false);
    scheduleRefresh(active);
  }

  // Poll only the open thread. Do not replace pages while the user is
  // reading older comments, and suspend requests in a background tab.
  function scheduleRefresh(context) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!current(context)) return;
      if (!document.hidden && !loading && !sending && !loadedOlder) void load(false, true);
      scheduleRefresh(context);
    }, 15000);
  }

  function renderMessage(message) {
    const item = document.createElement('div');
    item.className = 'channel-comment';
    const author = document.createElement('div');
    author.className = 'channel-comment-author';
    author.textContent = [message.from?.firstName, message.from?.lastName].filter(Boolean).join(' ') || message.from?.username || '用户';
    if (message.date) {
      const date = document.createElement('span');
      date.className = 'channel-comment-date';
      date.textContent = new Date(message.date).toLocaleString();
      author.appendChild(date);
    }
    const text = document.createElement('div');
    text.textContent = message.text || '';
    item.append(author, text);
    const media = message.media;
    const chatId = Number(message.chat?.id);
    const messageId = Number(message.id);
    if (media && Number.isSafeInteger(chatId) && chatId !== 0 && Number.isSafeInteger(messageId) && messageId > 0) {
      const params = new URLSearchParams({ chatId: String(chatId), messageId: String(messageId) });
      const url = `/api/instances/${encodeURIComponent(active.instId)}/account/media?${params}`;
      if (media.type === 'photo') {
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.className = 'channel-comment-media';
        const image = document.createElement('img');
        image.src = `${url}&thumb=1`; image.alt = '评论图片'; image.loading = 'lazy';
        link.appendChild(image); item.appendChild(link);
      } else if (['video', 'animation', 'audio', 'voice'].includes(media.type)) {
        const player = document.createElement(media.type === 'audio' || media.type === 'voice' ? 'audio' : 'video');
        player.className = 'channel-comment-media'; player.controls = true; player.preload = 'metadata'; player.src = url;
        item.appendChild(player);
      } else {
        const link = document.createElement('a');
        link.className = 'channel-comment-media'; link.href = `${url}&download=1`;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = media.fileName || '[媒体消息]';
        item.appendChild(link);
      }
    } else if (media && !message.text) {
      text.textContent = '[媒体消息]';
    }
    return item;
  }

  async function load(append, silent = false) {
    const context = active;
    if (!current(context)) { close(); return; }
    if (loading || (append && !oldestId)) return;
    loading = true;
    const request = ++sequence;
    const offsetId = append ? oldestId : null;
    if (!silent) status.textContent = '正在加载评论…';
    more.disabled = true;
    try {
      const params = new URLSearchParams({ chatId: String(context.chatId), messageId: String(context.messageId) });
      if (offsetId) params.set('offsetId', String(offsetId));
      const messages = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/channel-comments?${params}`);
      if (!current(context) || request !== sequence) return;
      const items = Array.isArray(messages) ? messages : [];
      if (!append) { list.textContent = ''; renderedIds = new Set(); loadedOlder = false; }
      else loadedOlder = true;
      const frag = document.createDocumentFragment();
      for (const message of items) {
        const key = String(message.id);
        if (renderedIds.has(key)) continue;
        renderedIds.add(key);
        frag.appendChild(renderMessage(message));
      }
      list.appendChild(frag);
      const nextId = items.length ? items[items.length - 1].id : null;
      oldestId = nextId && String(nextId) !== String(offsetId) ? nextId : null;
      more.hidden = items.length < 50 || !oldestId;
      if (!silent) status.textContent = !append && !items.length ? '暂无评论' : '';
    } catch (error) {
      if (!silent && current(context) && request === sequence) status.textContent = `无法加载评论：${error.message}`;
    } finally {
      if (current(context) && request === sequence) { loading = false; more.disabled = false; }
    }
  }

  async function sendComment() {
    const context = active;
    if (!current(context)) { close(); return; }
    const text = textarea.value;
    const file = selectedFile;
    if ((!text.trim() && !file) || sending) return;
    if (file && (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024)) {
      status.textContent = '附件为空或超过 2 GiB，请选择其他文件。';
      return;
    }
    sending = true;
    send.disabled = true;
    fileInput.disabled = true;
    clearFile.disabled = true;
    status.textContent = '正在发送评论…';
    try {
      if (file) {
        const mime = file.type || '';
        const mediaType = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
        await sendMediaStream(`/api/instances/${encodeURIComponent(context.instId)}/account/send-media`, file, {
          chatId: context.chatId, commentTo: context.messageId, fileName: file.name,
          mediaType, caption: text || undefined, parseMode: 'plain',
        }, (phase, percent) => {
          if (current(context)) status.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
        });
      } else {
        await api(`/api/instances/${encodeURIComponent(context.instId)}/account/channel-comments`, 'POST', {
          chatId: context.chatId, messageId: context.messageId, text,
        });
      }
      if (!current(context)) return;
      if (textarea.value === text) textarea.value = '';
      if (file && selectedFile === file) { selectedFile = null; fileInput.value = ''; fileName.textContent = ''; clearFile.hidden = true; }
      loading = false;
      await load(false);
    } catch (error) {
      if (current(context)) status.textContent = `发送未确认，请检查后重试：${error.message}`;
    } finally {
      if (current(context)) { sending = false; send.disabled = false; fileInput.disabled = false; clearFile.disabled = false; }
    }
  }

  return { open, close };
})();

'use strict';

window.PinnedMessages = (() => {
  let button, modal, title, status, list, more;
  let dialog = null, context = null, sequence = 0, busy = false, mutating = false, offsetId = null;
  let messageIds = new Set(), total = 0;

  function valid(ctx = context) {
    return Boolean(ctx && ctx === context && state.clientSelectedInstance === ctx.instId &&
      String(state.clientActiveChatId) === String(ctx.chatId) && state.chatSelectionVersion === ctx.version);
  }

  function close() {
    sequence++;
    context = null;
    busy = false;
    mutating = false;
    offsetId = null;
    if (modal) modal.hidden = true;
  }

  function init() {
    if (modal) return;
    button = document.getElementById('btn-chat-pinned');
    const style = document.createElement('style');
    style.textContent = `.pinned-messages-overlay{position:fixed;inset:0;z-index:1501;background:#0009;display:flex;align-items:center;justify-content:center;padding:16px}.pinned-messages-overlay[hidden]{display:none}.pinned-messages-window{background:var(--bg-card,#202a33);color:var(--text-primary,#fff);border-radius:12px;width:min(640px,100%);height:min(680px,90dvh);display:flex;flex-direction:column;overflow:hidden}.pinned-messages-head{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid var(--border-color,#ffffff24)}.pinned-messages-head strong{flex:1}.pinned-messages-list{flex:1;overflow:auto;padding:8px 12px}.pinned-message-row{display:flex;align-items:stretch;gap:8px;border-bottom:1px solid var(--border-color,#ffffff24)}.pinned-message-open{flex:1;min-width:0;padding:12px;text-align:left;background:transparent;border:0;color:inherit;cursor:pointer}.pinned-message-open:hover{background:var(--bg-hover,#ffffff12)}.pinned-message-preview{display:block;white-space:pre-wrap;overflow-wrap:anywhere;max-height:5.5em;overflow:hidden;color:var(--text-muted,#aaa);font-size:13px;margin-top:5px}.pinned-message-date{white-space:nowrap;color:var(--text-muted,#aaa);font-size:11px}.pinned-message-unpin{align-self:center;margin-right:6px}.pinned-messages-status{padding:8px 12px;color:var(--text-muted,#aaa)}.pinned-messages-more{margin:8px auto}.pinned-messages-more[hidden]{display:none}`;
    document.head.appendChild(style);
    modal = document.createElement('div');
    modal.className = 'pinned-messages-overlay';
    modal.hidden = true;
    modal.innerHTML = `<section class="pinned-messages-window" role="dialog" aria-modal="true" aria-labelledby="pinned-messages-title"><header class="pinned-messages-head"><strong id="pinned-messages-title">置顶消息</strong><button type="button" class="btn btn-danger btn-sm" data-unpin-all hidden>取消全部置顶</button><button type="button" class="btn btn-secondary btn-sm" data-close>关闭</button></header><div class="pinned-messages-list" role="list"></div><button type="button" class="btn btn-secondary btn-sm pinned-messages-more" hidden>加载更多</button><div class="pinned-messages-status" role="status"></div></section>`;
    document.body.appendChild(modal);
    title = modal.querySelector('#pinned-messages-title');
    status = modal.querySelector('.pinned-messages-status');
    list = modal.querySelector('.pinned-messages-list');
    more = modal.querySelector('.pinned-messages-more');
    modal.querySelector('[data-close]').onclick = close;
    modal.querySelector('[data-unpin-all]').onclick = () => unpinMessage();
    modal.onclick = event => { if (event.target === modal) close(); };
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    more.onclick = () => loadPage(Boolean(offsetId));
    button?.addEventListener('click', open);
  }

  function setDialog(nextDialog) {
    dialog = nextDialog || null;
    init();
    if (button) button.hidden = !dialog;
    if (!dialog) close();
  }

  function open() {
    if (!dialog || !state.clientSelectedInstance || String(state.clientActiveChatId) !== String(dialog.id)) return;
    init();
    close();
    context = { instId: state.clientSelectedInstance, chatId: dialog.id, version: state.chatSelectionVersion };
    offsetId = null;
    messageIds = new Set();
    total = 0;
    title.textContent = `置顶消息 · ${dialog.title || '当前会话'}`;
    list.replaceChildren();
    more.hidden = true;
    modal.hidden = false;
    void loadPage(false);
  }

  function previewText(message) {
    if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
    const labels = { photo: '照片', video: '视频', animation: '动图', voice: '语音消息', audio: '音频', document: '文件', sticker: '贴纸', poll: '投票', location: '位置', contact: '联系人' };
    return labels[message.media?.type] ? `[${labels[message.media.type]}]` : '[置顶消息]';
  }

  function renderMessage(message, ctx) {
    if (!Number.isSafeInteger(Number(message?.id)) || Number(message.id) <= 0 || messageIds.has(String(message.id))) return;
    messageIds.add(String(message.id));
    const row = document.createElement('div');
    row.className = 'pinned-message-row';
    row.setAttribute('role', 'listitem');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'pinned-message-open';
    const heading = document.createElement('span');
    heading.textContent = `消息 #${message.id}`;
    const preview = document.createElement('span');
    preview.className = 'pinned-message-preview';
    preview.textContent = previewText(message);
    const when = document.createElement('span');
    when.className = 'pinned-message-date';
    when.textContent = Number(message.date) > 0 ? new Date(Number(message.date)).toLocaleString() : '';
    openButton.append(heading, preview);
    openButton.onclick = async () => {
      if (!valid(ctx)) { close(); return; }
      const id = Number(message.id);
      const date = Number(message.date) > 0 ? Math.floor(Number(message.date) / 1000) : Math.floor(Date.now() / 1000);
      close();
      if (typeof window.loadClientMessagesAround === 'function') {
        await window.loadClientMessagesAround(ctx.chatId, id, date);
      }
    };
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'btn btn-secondary btn-sm pinned-message-unpin';
    unpin.textContent = '取消置顶';
    unpin.title = '从会话置顶列表移除此消息';
    unpin.onclick = event => { event.stopPropagation(); void unpinMessage(Number(message.id)); };
    row.append(openButton, when, unpin);
    list.appendChild(row);
  }

  async function loadPage(append) {
    const ctx = context;
    if (!valid(ctx) || busy || (append && !offsetId)) return;
    busy = true;
    const current = ++sequence;
    const oldOffset = append ? offsetId : null;
    more.disabled = true;
    status.textContent = '正在加载置顶消息…';
    try {
      const params = new URLSearchParams({ chatId: String(ctx.chatId), limit: '30' });
      if (oldOffset) params.set('offsetId', String(oldOffset));
      const result = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/pinned-messages?${params}`);
      if (!valid(ctx) || current !== sequence) return;
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      if (!append) { list.replaceChildren(); messageIds = new Set(); }
      messages.forEach(message => renderMessage(message, ctx));
      total = Number.isSafeInteger(Number(result?.total)) && Number(result.total) >= 0 ? Number(result.total) : total;
      const next = Number(result?.nextOffsetId);
      offsetId = Number.isSafeInteger(next) && next > 0 && next !== oldOffset && messages.length > 0 ? next : null;
      more.hidden = !offsetId;
      const unpinAll = modal.querySelector('[data-unpin-all]');
      if (unpinAll) unpinAll.hidden = !messageIds.size;
      more.textContent = '加载更多';
      status.textContent = messageIds.size ? (total ? `已显示 ${messageIds.size} / ${total} 条` : '') : '此会话没有置顶消息';
    } catch (error) {
      if (valid(ctx) && current === sequence) {
        offsetId = oldOffset;
        status.textContent = `无法加载置顶消息：${error.message}`;
        more.hidden = false;
        more.textContent = '重试';
      }
    } finally {
      if (valid(ctx) && current === sequence) { busy = false; more.disabled = false; }
    }
  }

  async function unpinMessage(messageId) {
    const ctx = context;
    if (!valid(ctx) || busy || mutating) return;
    const all = messageId === undefined;
    const prompt = all ? '确定取消此会话中全部消息的置顶吗？' : `确定取消消息 #${messageId} 的置顶吗？`;
    if (typeof window.confirm === 'function' && !window.confirm(prompt)) return;
    mutating = true;
    status.textContent = all ? '正在取消全部置顶…' : '正在取消置顶…';
    more.disabled = true;
    try {
      const body = { chatId: ctx.chatId };
      if (!all) body.messageId = messageId;
      await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/unpin`, 'POST', body);
      if (!valid(ctx)) return;
      window.showToast?.(all ? '已取消全部置顶消息' : '已取消置顶', 'success');
      window.loadPeerProfile?.(ctx.chatId);
      offsetId = null;
      messageIds = new Set();
      total = 0;
      mutating = false;
      await loadPage(false);
    } catch (error) {
      if (valid(ctx)) {
        status.textContent = `取消置顶失败：${error.message}`;
        window.showToast?.(`取消置顶失败：${error.message}`, 'error');
      }
    } finally {
      if (valid(ctx)) { mutating = false; more.disabled = false; }
    }
  }

  function initialize() {
    init();
    if (dialog && button) button.hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();

  return { setDialog, open, close };
})();

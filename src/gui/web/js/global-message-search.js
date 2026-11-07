'use strict';

// Global message search is separate from the existing contact/dialog search.
(function () {
  let active = false;
  let version = 0;
  let timer = null;
  let result = { instId: null, query: '', filter: '', messages: [], cursor: null, loading: false, error: '' };

  function render() {
    const panel = document.getElementById('global-message-results');
    const dialogs = document.getElementById('client-dialogs-list');
    const toggle = document.getElementById('btn-global-message-search');
    const filter = document.getElementById('global-message-search-filter');
    if (!panel || !dialogs || !toggle) return;
    if (filter) { filter.hidden = !active; filter.value = result.filter; }
    panel.hidden = !active;
    dialogs.hidden = active;
    toggle.setAttribute('aria-pressed', String(active));
    const label = toggle.querySelector?.('.dialogs-icon-label');
    if (label) label.textContent = active ? '返回会话' : '搜索消息';
    const icon = toggle.querySelector?.('svg use');
    if (icon) icon.setAttribute('href', active ? '#icon-arrow-left' : '#icon-search-chat');
    toggle.title = active ? '返回会话列表' : '搜索所有消息';
    toggle.setAttribute('aria-label', toggle.title);
    if (!active) return;
    panel.replaceChildren();
    if (!result.query && !result.filter) {
      const hint = document.createElement('div');
      hint.className = 'empty-state';
      hint.textContent = '输入关键词或选择类型搜索消息';
      panel.appendChild(hint);
      return;
    }
    for (const message of result.messages) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'global-message-result';
      const title = document.createElement('span');
      title.className = 'global-message-title';
      title.textContent = message.chat?.title || [message.chat?.firstName, message.chat?.lastName].filter(Boolean).join(' ') || message.chat?.username || String(message.chat?.id || '');
      const body = document.createElement('span');
      body.className = 'global-message-text';
      body.textContent = message.text || (message.media ? `[${message.media.type}]` : '消息');
      const date = document.createElement('span');
      date.className = 'global-message-date';
      const timestamp = Number(message.date);
      date.textContent = Number.isFinite(timestamp) && timestamp ? new Date(timestamp < 1e11 ? timestamp * 1000 : timestamp).toLocaleString() : '';
      row.append(title, body, date);
      row.onclick = () => openResult(message, result.instId);
      panel.appendChild(row);
    }
    if (result.loading || result.error || !result.messages.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-state';
      hint.textContent = result.loading ? '正在搜索消息...' : result.error || '没有找到消息';
      panel.appendChild(hint);
    }
    if (!result.loading && (result.cursor || result.error)) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-secondary global-message-more';
      more.textContent = result.error ? '重试' : '加载更多';
      more.onclick = () => fetchPage(Boolean(result.cursor));
      panel.appendChild(more);
    }
  }

  async function openResult(message, instId) {
    const chatId = message.chat?.id;
    if (!instId || chatId == null || !message.id || state.clientSelectedInstance !== instId) return;
    const dialog = state.clientDialogs.find((d) => String(d.id) === String(chatId)) || {
      id: chatId, title: message.chat?.title || message.chat?.firstName || message.chat?.username || String(chatId),
      type: message.chat?.type || 'private', username: message.chat?.username,
    };
    const date = Number(message.date);
    const seconds = Number.isFinite(date) && date ? Math.floor(date < 1e11 ? date : date / 1000) : Math.floor(Date.now() / 1000);
    await selectClientChat(dialog, { historyAnchor: { id: message.id, date: seconds + 1 } });
  }

  async function fetchPage(append) {
    if (!active || result.loading || (!result.query && !result.filter) || !result.instId) return;
    const current = version;
    const instId = result.instId;
    const query = result.query;
    const filter = result.filter;
    const cursor = append ? result.cursor : null;
    result.loading = true;
    result.error = '';
    render();
    try {
      const params = new URLSearchParams({ query });
      if (filter) params.set('filter', filter);
      if (cursor) {
        params.set('peer', String(cursor.peer)); params.set('id', String(cursor.id)); params.set('rate', String(cursor.rate));
      }
      const response = await api(`/api/instances/${encodeURIComponent(instId)}/account/search-global-messages?${params}`);
      if (current !== version || !active || state.clientSelectedInstance !== instId || result.query !== query || result.filter !== filter) return;
      const messages = append ? [...result.messages] : [];
      const seen = new Set(messages.map((m) => `${m.chat?.id}:${m.id}`));
      for (const message of Array.isArray(response?.messages) ? response.messages : []) {
        const key = `${message.chat?.id}:${message.id}`;
        if (message.chat?.id != null && message.id && !seen.has(key)) { seen.add(key); messages.push(message); }
      }
      result.messages = messages;
      const next = response?.nextCursor;
      result.cursor = next && (!cursor || String(next.peer) !== String(cursor.peer) || next.id !== cursor.id || next.rate !== cursor.rate) ? next : null;
      result.loading = false;
    } catch (err) {
      if (current !== version || !active || state.clientSelectedInstance !== instId || result.query !== query || result.filter !== filter) return;
      result.loading = false;
      result.error = `搜索失败: ${err.message}`;
    }
    render();
  }

  function reset() {
    version++;
    if (timer) clearTimeout(timer);
    timer = null;
    const query = (document.getElementById('client-dialogs-search')?.value || '').trim();
    const filter = document.getElementById('global-message-search-filter')?.value || '';
    result = { instId: state.clientSelectedInstance, query, filter, messages: [], cursor: null, loading: false, error: '' };
    render();
    if (active && (query || filter) && result.instId) timer = setTimeout(() => { timer = null; fetchPage(false); }, 350);
  }

  function init() {
    const toggle = document.getElementById('btn-global-message-search');
    if (!toggle) return;
    toggle.addEventListener('click', () => { active = !active; reset(); });
    document.getElementById('client-dialogs-search')?.addEventListener('input', reset);
    document.getElementById('global-message-search-filter')?.addEventListener('change', reset);
    // The account selector's on-change handler updates the selected account.
    // Run after all synchronous change handlers regardless of registration order.
    document.getElementById('client-account-select')?.addEventListener('change', () => Promise.resolve().then(reset));
    render();
  }
  window.GlobalMessageSearch = { reset };
  window.addEventListener('load', init);
})();

'use strict';

// Each draft is scoped to an account and peer. Never overwrite a draft whose
// format cannot be round-tripped or a remote change that conflicts with edits.
window.CloudDrafts = (() => {
  const entries = new Map();
  const keyOf = (instId, chatId) => JSON.stringify([instId, String(chatId)]);
  const fingerprint = (draft) => JSON.stringify(draft == null ? null : {
    text: String(draft.text || ''), replyToMessageId: draft.replyToMessageId || null,
    hasUnsupportedFeatures: Boolean(draft.hasUnsupportedFeatures),
  });
  const sameContent = (draft, text, replyTo) => (draft == null && !text && !replyTo) ||
    Boolean(draft && !draft.hasUnsupportedFeatures && String(draft.text || '') === text &&
      (draft.replyToMessageId || null) === (replyTo || null));
  function entryFor(instId, chatId) {
    if (!instId || chatId == null) return null;
    const key = keyOf(instId, chatId);
    if (!entries.has(key)) entries.set(key, { key, instId, chatId, revision: 0, loaded: false, dirty: false,
      text: '', replyTo: null, blocked: false, conflict: false, readError: false, paused: 0, timer: null, writing: false, loading: false, request: 0, remoteVersion: 0 });
    return entries.get(key);
  }
  function active(entry) {
    return state.clientSelectedInstance === entry.instId && String(state.clientActiveChatId) === String(entry.chatId);
  }
  function warn(entry, text) {
    if (active(entry) && entry.warning !== text) { entry.warning = text; showToast(text, 'warn'); }
  }
  function updateStatus() {
    const banner = document.getElementById('cloud-draft-status');
    if (!banner) return;
    const entry = entries.get(keyOf(state.clientSelectedInstance, state.clientActiveChatId));
    const text = document.getElementById('cloud-draft-status-text');
    const remote = document.getElementById('cloud-draft-use-remote');
    const local = document.getElementById('cloud-draft-use-local');
    const retry = document.getElementById('cloud-draft-retry');
    const hasChoice = Boolean(entry && (entry.blocked || entry.conflict));
    banner.hidden = !entry || (!hasChoice && !entry.readError);
    if (banner.hidden) return;
    if (text) text.textContent = entry.conflict ? '云端草稿已变化，本地更改尚未同步。请选择保留哪份草稿。' :
      entry.blocked ? '云端草稿包含暂不支持的格式或附件，本地更改不会自动覆盖它。' : '无法读取云草稿，本地更改暂不会同步。';
    if (remote) { remote.hidden = !hasChoice; remote.disabled = entry.writing || entry.paused > 0 || entry.resolving; }
    if (local) { local.hidden = !hasChoice; local.disabled = entry.writing || entry.paused > 0 || entry.resolving; }
    if (retry) { retry.hidden = hasChoice || !entry.readError; retry.disabled = entry.loading || entry.resolving; }
  }
  function show(entry, draft) {
    if (!active(entry) || state.clientEditingMessageId) return;
    const input = document.getElementById('client-message-textarea');
    if (input) { input.value = draft?.text || ''; autoResizeTextarea(input); }
    state.clientReplyingTo = draft?.replyToMessageId ? { id: draft.replyToMessageId } : null;
    const banner = document.getElementById('chat-reply-banner');
    const sender = document.getElementById('reply-banner-sender');
    const text = document.getElementById('reply-banner-text');
    if (banner) banner.style.display = state.clientReplyingTo ? 'flex' : 'none';
    if (sender) sender.innerText = state.clientReplyingTo ? '回复消息' : '';
    if (text) text.innerText = state.clientReplyingTo ? `消息 #${state.clientReplyingTo.id}` : '';
  }
  function applyRemote(entry, draft) {
    const key = entry.key;
    if (draft?.text) state.clientDrafts[key] = draft.text;
    else delete state.clientDrafts[key];
    entry.text = draft?.text || '';
    entry.replyTo = draft?.replyToMessageId || null;
    entry.blocked = Boolean(draft?.hasUnsupportedFeatures);
    entry.conflict = false;
    entry.readError = false;
    entry.warning = null;
    entry.base = fingerprint(draft);
    entry.loaded = true;
    if (entry.blocked) warn(entry, '云草稿含暂不支持的格式或附件；仅显示文字，本地更改不会覆盖云端。');
    show(entry, draft);
    renderClientDialogs();
    updateStatus();
  }
  function acceptRemote(entry, draft) {
    if (entry.writing && sameContent(draft, entry.sentText, entry.sentReply)) {
      entry.base = fingerprint(draft);
      return;
    }
    if (entry.dirty || entry.paused || entry.writing) {
      if (fingerprint(draft) !== entry.base && !sameContent(draft, entry.text, entry.replyTo)) {
        entry.conflict = true;
        entry.remote = draft;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        warn(entry, '云端草稿在其他设备发生变化，本地修改暂未同步，请先处理冲突。');
        updateStatus();
      }
      return;
    }
    applyRemote(entry, draft);
  }
  async function open(instId, chatId) {
    const entry = entryFor(instId, chatId);
    if (!entry) return;
    const request = ++entry.request;
    entry.loading = true;
    updateStatus();
    try {
      const response = await api(`/api/instances/${encodeURIComponent(instId)}/account/draft?chatId=${encodeURIComponent(chatId)}`);
      if (entries.get(entry.key) !== entry || request !== entry.request) return;
      const draft = response?.draft ?? null;
      entry.readError = false;
      entry.remote = draft;
      if (!entry.loaded && entry.dirty) {
        entry.loaded = true;
        entry.base = fingerprint(draft);
        entry.blocked = Boolean(draft?.hasUnsupportedFeatures);
        if (draft != null && !sameContent(draft, entry.text, entry.replyTo)) {
          entry.conflict = true;
          warn(entry, '云端已有草稿，本地修改未覆盖云端，请先处理冲突。');
        }
        if (entry.blocked) warn(entry, '云草稿含暂不支持的格式或附件；本地更改不会覆盖云端。');
      } else acceptRemote(entry, draft);
      schedule(entry);
    } catch (_) {
      if (entries.get(entry.key) !== entry || request !== entry.request) return;
      entry.loaded = false;
      entry.readError = true;
      warn(entry, '无法读取云草稿，本地内容不会自动覆盖云端。');
    } finally {
      if (entries.get(entry.key) === entry && request === entry.request) entry.loading = false;
      updateStatus();
    }
  }
  function schedule(entry) {
    if (!entry || !entry.loaded || !entry.dirty || entry.blocked || entry.conflict || entry.writing || entry.paused) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = null; void flush(entry); }, 800);
  }
  async function flush(entry) {
    if (entries.get(entry.key) !== entry || !entry.loaded || !entry.dirty || entry.blocked || entry.conflict || entry.writing || entry.paused) return;
    const revision = entry.revision, text = entry.text, replyTo = entry.replyTo;
    entry.writing = true; entry.sentText = text; entry.sentReply = replyTo;
    updateStatus();
    try {
      await api(`/api/instances/${encodeURIComponent(entry.instId)}/account/draft`, 'POST', {
        chatId: entry.chatId, text, options: { parseMode: 'plain', ...(replyTo ? { replyToMessageId: replyTo } : {}) },
      });
      if (entries.get(entry.key) !== entry) return;
      // Server echoes contain timestamps that can differ; compare content for
      // own writes and wait for subsequent remote update to refresh the date.
      if (!entry.conflict && !entry.blocked) {
        entry.base = fingerprint(text || replyTo ? { text, replyToMessageId: replyTo } : null);
        if (entry.revision === revision) entry.dirty = false;
        entry.warning = null;
      }
    } catch (_) {
      if (entries.get(entry.key) === entry) warn(entry, '云草稿保存失败，本地修改仍保留；下次编辑时可重试。');
      return;
    } finally {
      entry.writing = false;
      updateStatus();
    }
    if (entries.get(entry.key) === entry) schedule(entry);
  }
  function changed(instId, chatId, text, replyTo) {
    const entry = entryFor(instId, chatId);
    if (!entry) return;
    entry.text = String(text || ''); entry.replyTo = replyTo || null;
    entry.revision++; entry.dirty = true;
    if (entry.blocked) warn(entry, '云草稿含暂不支持的格式或附件；本地更改不会覆盖云端。');
    if (entry.conflict) warn(entry, '云端草稿在其他设备发生变化，本地修改暂未同步，请先处理冲突。');
    if (!entry.loaded && !entry.loading) void open(instId, chatId);
    schedule(entry);
    updateStatus();
  }
  function beginSend(instId, chatId, text, replyTo) {
    const entry = entryFor(instId, chatId);
    if (!entry) return null;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null; entry.paused++;
    updateStatus();
    return { entry, revision: entry.revision, text, replyTo };
  }
  function finishSend(token, success) {
    if (!token) return;
    const { entry } = token;
    if (entries.get(entry.key) !== entry) return;
    entry.paused = Math.max(0, entry.paused - 1);
    if (success && entry.revision === token.revision) {
      entry.text = ''; entry.replyTo = null; entry.revision++; entry.dirty = true;
    }
    schedule(entry);
    updateStatus();
  }
  function incoming(instId, chatId, draft) {
    if (state.clientSelectedInstance === instId) {
      const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(chatId));
      if (dialog) dialog.draft = draft;
    }
    const entry = entries.get(keyOf(instId, chatId));
    if (entry) {
      entry.remoteVersion++;
      entry.remote = draft;
      entry.readError = false;
      // A later push supersedes any in-flight snapshot.
      entry.request++;
      entry.loading = false;
      if (!entry.loaded && entry.dirty) {
        entry.loaded = true;
        entry.base = fingerprint(draft);
        entry.blocked = Boolean(draft?.hasUnsupportedFeatures);
        if (draft != null && !sameContent(draft, entry.text, entry.replyTo)) {
          entry.conflict = true;
          warn(entry, '云端已有草稿，本地修改未覆盖云端，请先处理冲突。');
        }
      } else acceptRemote(entry, draft);
      schedule(entry);
    }
    if (state.clientSelectedInstance === instId) renderClientDialogs();
    updateStatus();
  }
  function getText(instId, chatId, draft) {
    const key = keyOf(instId, chatId);
    const entry = entries.get(key);
    if (entry && (entry.loaded || entry.dirty)) return entry.text;
    return state.clientDrafts[key] ?? draft?.text ?? '';
  }
  function clearAccount(instId) {
    for (const [key, entry] of entries) {
      if (entry.instId !== instId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entries.delete(key);
    }
    updateStatus();
  }
  async function resolveConflict(mode) {
    const entry = entries.get(keyOf(state.clientSelectedInstance, state.clientActiveChatId));
    if (!entry || !active(entry) || entry.writing || entry.paused || entry.resolving || !['remote', 'local'].includes(mode)) return;
    if (mode === 'local' && !window.confirm('将用本地草稿覆盖当前 Telegram 云端草稿，是否继续？')) return;
    entry.resolving = true;
    const revision = entry.revision, remoteVersion = entry.remoteVersion;
    updateStatus();
    try {
      const response = await api(`/api/instances/${encodeURIComponent(entry.instId)}/account/draft?chatId=${encodeURIComponent(entry.chatId)}`);
      if (entries.get(entry.key) !== entry || !active(entry)) return;
      if (entry.revision !== revision || entry.remoteVersion !== remoteVersion) {
        warn(entry, '草稿在处理期间发生变化，请重新选择。');
        return;
      }
      const draft = response?.draft ?? null;
      entry.remote = draft;
      entry.readError = false;
      if (mode === 'remote') {
        entry.dirty = false;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        applyRemote(entry, draft);
      } else {
        entry.loaded = true;
        entry.blocked = false;
        entry.conflict = false;
        entry.base = fingerprint(draft);
        entry.warning = null;
        entry.dirty = true;
      }
    } catch (_) {
      if (entries.get(entry.key) === entry) warn(entry, '无法读取最新云草稿，请稍后重试。');
    } finally {
      entry.resolving = false;
      if (entries.get(entry.key) === entry) { updateStatus(); schedule(entry); }
    }
  }
  function init() {
    const remote = document.getElementById('cloud-draft-use-remote');
    const local = document.getElementById('cloud-draft-use-local');
    const retry = document.getElementById('cloud-draft-retry');
    if (remote) remote.onclick = () => { void resolveConflict('remote'); };
    if (local) local.onclick = () => { void resolveConflict('local'); };
    if (retry) retry.onclick = () => { void open(state.clientSelectedInstance, state.clientActiveChatId); };
  }
  if (typeof window.addEventListener === 'function') window.addEventListener('load', init);
  return { open, changed, beginSend, finishSend, incoming, clearAccount, getText, resolveConflict, updateStatus };
})();

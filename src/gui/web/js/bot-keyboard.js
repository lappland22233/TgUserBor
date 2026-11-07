'use strict';

// Telegram inline button contents are untrusted. Build DOM nodes instead of
// interpolating text or URLs into HTML or inline JavaScript.
window.BotKeyboard = (() => {
  const pending = new Set();
  const hiddenReplyKeyboards = new Set();
  const accountEpoch = new Map();
  let activeReply = null;
  let forceReplyApplied = null;
  let replyStateEpoch = 0;
  function safeUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'tg:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  function current(context) {
    return state.clientSelectedInstance === context.instId && String(state.clientActiveChatId) === String(context.chatId) &&
      state.chatSelectionVersion === context.selectionVersion;
  }
  async function callback(button, context, item, status) {
    if (!current(context)) return;
    const key = JSON.stringify([context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true; status.replaceChildren();
    try {
      const answer = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-callback`, 'POST', {
        chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column,
      });
      if (!current(context)) return;
      if (answer?.message) {
        if (answer.alert && typeof window.alert === 'function') window.alert(String(answer.message));
        else showToast(String(answer.message), 'info');
      }
      if (answer?.url) {
        const url = safeUrl(answer.url);
        if (!url) { status.textContent = '机器人返回了不受支持的链接'; return; }
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = '打开机器人返回的链接';
        status.appendChild(link);
      }
    } catch (error) {
      if (current(context)) showToast(`机器人按钮操作失败: ${error.message}`, 'error');
    } finally {
      pending.delete(key);
      button.disabled = false;
    }
  }
  async function launchGame(button, context, item, status) {
    if (!current(context) || !Number.isInteger(item.row) || !Number.isInteger(item.column)) return;
    const key = JSON.stringify(['game', context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true; status.replaceChildren();
    try {
      const answer = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-game`, 'POST', {
        chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column,
      });
      if (!current(context)) return;
      if (answer?.message) {
        if (answer.alert && typeof window.alert === 'function') window.alert(String(answer.message));
        else showToast(String(answer.message), 'info');
      }
      const url = safeUrl(answer?.url);
      if (!url) { if (!answer?.message) status.textContent = 'Telegram 未返回可用的游戏链接'; return; }
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '点击打开 Telegram 游戏'; status.appendChild(link);
    } catch (error) {
      if (current(context)) showToast(`启动 Telegram 游戏失败：${error.message}`, 'error');
    } finally { pending.delete(key); button.disabled = false; }
  }
  async function requestUrlAuth(button, context, item, status) {
    if (!current(context)) return;
    const key = JSON.stringify(['url-auth', context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true; status.replaceChildren();
    try {
      let result = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-url-auth`, 'POST', {
        chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column,
      });
      if (!current(context)) return;
      if (result?.type === 'request') {
        const domain = typeof result.domain === 'string' ? result.domain.slice(0, 253) : '机器人请求的网站';
        if (typeof window.confirm !== 'function' || !window.confirm(`机器人请求为 ${domain} 登录 Telegram 账号。是否继续？`)) return;
        let writeAllowed = false;
        if (result.requestWriteAccess && typeof window.confirm === 'function') {
          writeAllowed = window.confirm('同时允许此机器人主动向你发送消息？');
        }
        result = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-url-auth/accept`, 'POST', {
          chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column, writeAllowed,
        });
      }
      if (!current(context)) return;
      if (result?.type !== 'accepted' && result?.type !== 'default') { status.textContent = 'Telegram 未完成登录授权。'; return; }
      const url = safeUrl(result.url);
      if (!url) { status.textContent = 'Telegram 返回了不受支持的登录链接。'; return; }
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '点击打开授权后的网站'; status.appendChild(link);
    } catch (error) {
      if (current(context)) showToast(`登录授权失败：${error.message}`, 'error');
    } finally { pending.delete(key); button.disabled = false; }
  }
  async function copyText(button, context, item) {
    if (!current(context) || typeof item.copyText !== 'string' || !item.copyText || item.copyText.length > 4096) return;
    const key = JSON.stringify(['copy', context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true;
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('此浏览器不支持安全剪贴板写入');
      await navigator.clipboard.writeText(item.copyText);
      if (current(context)) showToast('已复制到剪贴板', 'success');
    } catch (error) {
      if (current(context)) showToast(`复制失败：${error.message}`, 'error');
    } finally { pending.delete(key); button.disabled = false; }
  }
  function matchesPeerRequest(dialog, request) {
    if (!dialog || !Number.isSafeInteger(Number(dialog.id)) || Number(dialog.id) === 0) return false;
    if (request.kind === 'user') {
      return dialog.type === 'private' && (typeof request.bot !== 'boolean' || Boolean(dialog.isBot) === request.bot) &&
        (typeof request.premium !== 'boolean' || Boolean(dialog.isPremium) === request.premium);
    }
    if (request.kind === 'broadcast') {
      return dialog.type === 'channel' && dialog.isBroadcast === true &&
        (typeof request.creator !== 'boolean' || Boolean(dialog.isCreator) === request.creator) &&
        (typeof request.hasUsername !== 'boolean' || Boolean(dialog.username) === request.hasUsername);
    }
    if (request.kind === 'group') {
      const isGroup = dialog.type === 'group' || dialog.type === 'supergroup' || (dialog.type === 'channel' && dialog.isBroadcast !== true);
      return isGroup && (typeof request.creator !== 'boolean' || Boolean(dialog.isCreator) === request.creator) &&
        (typeof request.hasUsername !== 'boolean' || Boolean(dialog.username) === request.hasUsername) &&
        (typeof request.forum !== 'boolean' || Boolean(dialog.isForum) === request.forum);
    }
    return false;
  }
  function openPeerRequest(context, item, target, append = false) {
    const request = item?.peerRequest;
    if (!current(context) || !request || !['user', 'group', 'broadcast'].includes(request.kind)) return;
    const maxQuantity = Number.isInteger(request.maxQuantity) ? Math.max(1, Math.min(10, request.maxQuantity)) : 1;
    let candidates = (state.clientDialogs || []).filter(dialog => matchesPeerRequest(dialog, request)).slice(0, 200);
    const selected = new Set();
    let searchTimer = null, searchRequestId = 0;
    const panel = document.createElement('div'); panel.className = 'bot-peer-request-picker';
    const heading = document.createElement('strong');
    heading.textContent = request.kind === 'user' ? '选择要分享给机器人的用户' : request.kind === 'broadcast' ? '选择要分享的频道' : '选择要分享的群组';
    const note = document.createElement('div'); note.className = 'bot-peer-request-note';
    note.textContent = `最多选择 ${maxQuantity} 个。可筛选已载入会话，也可输入至少 2 个字符搜索 Telegram。`;
    const search = document.createElement('input'); search.type = 'search'; search.className = 'form-input input-sm';
    search.placeholder = '筛选已载入的会话'; search.setAttribute('aria-label', '筛选可分享的会话');
    const list = document.createElement('div'); list.className = 'bot-peer-request-list';
    const actions = document.createElement('div'); actions.className = 'bot-peer-request-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-xs'; cancel.textContent = '取消';
    const closePicker = () => {
      searchRequestId++;
      if (searchTimer !== null) clearTimeout(searchTimer);
      panel.remove();
    };
    cancel.onclick = closePicker;
    const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary btn-xs'; send.textContent = '分享给机器人'; send.disabled = true;
    const renderCandidates = () => {
      list.replaceChildren();
      const query = String(search.value || '').trim().toLowerCase();
      const visible = candidates.filter(dialog => !query || `${dialog.title || ''} ${dialog.username || ''}`.toLowerCase().includes(query));
      for (const dialog of visible) {
        const id = Number(dialog.id);
        const label = document.createElement('label'); label.className = 'bot-peer-request-option';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(id);
        checkbox.disabled = !checkbox.checked && selected.size >= maxQuantity;
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(id); else selected.delete(id);
          send.disabled = selected.size === 0;
          note.textContent = `已选择 ${selected.size}/${maxQuantity} 个。${request.botAdminRights?.length && request.kind !== 'user' ? 'Telegram 可能会按机器人请求授予管理员权限。' : ''}`;
          renderCandidates();
        };
        const name = document.createElement('span');
        name.textContent = `${dialog.title || dialog.username || `会话 ${id}`}${dialog.username ? ` (@${dialog.username})` : ''}`;
        label.appendChild(checkbox); label.appendChild(name); list.appendChild(label);
      }
      if (!visible.length) {
        const empty = document.createElement('div'); empty.className = 'bot-peer-request-empty';
        empty.textContent = candidates.length ? '没有匹配的会话' : '没有已载入或搜索到符合条件的对象'; list.appendChild(empty);
      }
    };
    search.oninput = () => {
      renderCandidates();
      if (searchTimer !== null) clearTimeout(searchTimer);
      const query = String(search.value || '').trim();
      const requestId = ++searchRequestId;
      if (query.length < 2 || !current(context)) return;
      searchTimer = setTimeout(async () => {
        try {
          const results = await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-request-peer-search`, 'POST', {
            chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column, query,
          });
          if (!current(context) || requestId !== searchRequestId || String(search.value || '').trim() !== query) return;
          const byId = new Map();
          for (const dialog of [...(state.clientDialogs || []), ...(Array.isArray(results) ? results : [])]) {
            if (matchesPeerRequest(dialog, request)) byId.set(String(dialog.id), dialog);
          }
          candidates = [...byId.values()].slice(0, 200);
          renderCandidates();
        } catch (error) {
          if (current(context) && requestId === searchRequestId) showToast(`搜索 Telegram 会话失败：${error.message}`, 'error');
        }
      }, 250);
    };
    send.onclick = async () => {
      if (!current(context) || !selected.size || selected.size > maxQuantity) return;
      if (request.kind !== 'user' && typeof window.confirm === 'function' &&
          !window.confirm('将所选群组或频道分享给机器人。Telegram 可能会把机器人加入会话或授予其请求的管理员权限。是否继续？')) return;
      const key = JSON.stringify(['request-peer', context.instId, context.chatId, context.messageId, item.row, item.column]);
      if (pending.has(key)) return;
      pending.add(key); send.disabled = true;
      try {
        await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-request-peer`, 'POST', {
          chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column, peerIds: [...selected],
        });
        if (!current(context)) return;
        closePicker(); showToast('已向机器人分享所选会话', 'success');
        await loadClientMessages(context.chatId, true);
      } catch (error) {
        if (current(context)) showToast(`分享会话失败：${error.message}`, 'error');
      } finally { pending.delete(key); send.disabled = selected.size === 0; }
    };
    actions.appendChild(cancel); actions.appendChild(send);
    panel.appendChild(heading); panel.appendChild(note); panel.appendChild(search); panel.appendChild(list); panel.appendChild(actions);
    if (append) target.appendChild(panel); else target.replaceChildren(panel);
    renderCandidates();
  }
  async function shareReplyPhone(button, context, item, keyboardKey, keyboard) {
    if (!current(context) || typeof window.confirm !== 'function' ||
        !window.confirm('机器人请求你的电话号码。确认后，电话号码会作为联系人消息发送给此机器人。')) return;
    const key = JSON.stringify(['request-phone', context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true;
    try {
      await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-keyboard/phone`, 'POST', {
        chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column,
      });
      if (!current(context)) return;
      if (keyboard.singleUse && (accountEpoch.get(context.instId) || 0) === context.accountEpoch) hiddenReplyKeyboards.add(keyboardKey);
      showToast('已向机器人分享电话号码', 'success');
      renderReply();
      await loadClientMessages(context.chatId, true);
    } catch (error) {
      if (current(context)) showToast(`分享电话号码失败：${error.message}`, 'error');
    } finally { pending.delete(key); button.disabled = false; }
  }
  async function shareReplyLocation(button, context, item, keyboardKey, keyboard) {
    if (!current(context) || typeof window.confirm !== 'function' ||
        !window.confirm('机器人请求你的当前位置。位置会发送到此 Telegram 会话。')) return;
    const key = JSON.stringify(['request-location', context.instId, context.chatId, context.messageId, item.row, item.column]);
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true;
    try {
      if (typeof navigator?.geolocation?.getCurrentPosition !== 'function') throw new Error('此浏览器不支持定位');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
        { maximumAge: 30000, timeout: 15000, enableHighAccuracy: false }));
      const latitude = Number(position?.coords?.latitude), longitude = Number(position?.coords?.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error('浏览器未返回有效位置');
      }
      if (!current(context)) return;
      await api(`/api/instances/${encodeURIComponent(context.instId)}/account/bot-keyboard/location`, 'POST', {
        chatId: context.chatId, messageId: context.messageId, row: item.row, column: item.column, latitude, longitude,
      });
      if (!current(context)) return;
      if (keyboard.singleUse && (accountEpoch.get(context.instId) || 0) === context.accountEpoch) hiddenReplyKeyboards.add(keyboardKey);
      showToast('已向会话发送当前位置', 'success');
      renderReply();
      await loadClientMessages(context.chatId, true);
    } catch (error) {
      if (current(context)) showToast(`分享位置失败：${error.message}`, 'error');
    } finally { pending.delete(key); button.disabled = false; }
  }
  function mount(parent, message, instId, chatId) {
    if (!parent || !Array.isArray(message.botKeyboard) || !message.botKeyboard.length) return;
    const context = { instId, chatId, messageId: message.id, selectionVersion: state.chatSelectionVersion };
    const wrapper = document.createElement('div');
    wrapper.className = 'bot-keyboard';
    const status = document.createElement('div');
    status.className = 'bot-keyboard-status';
    status.setAttribute('role', 'status');
    for (const row of message.botKeyboard) {
      if (!Array.isArray(row) || !row.length) continue;
      const rowNode = document.createElement('div'); rowNode.className = 'bot-keyboard-row';
      for (const item of row) {
        if (!item || typeof item.text !== 'string') continue;
        let button;
        const url = item.type === 'url' ? safeUrl(item.url) : null;
        if (url) {
          button = document.createElement('a'); button.href = url;
          button.target = '_blank'; button.rel = 'noopener noreferrer';
        } else {
          button = document.createElement('button'); button.type = 'button';
          if (item.type === 'callback' && Number.isInteger(item.row) && Number.isInteger(item.column)) {
            button.onclick = () => callback(button, context, item, status);
          } else if (item.type === 'game' && Number.isInteger(item.row) && Number.isInteger(item.column)) {
            button.onclick = () => launchGame(button, context, item, status);
          } else if (item.type === 'request_peer' && item.peerRequest) {
            button.onclick = () => openPeerRequest(context, item, status);
          } else if (item.type === 'url_auth' && Number.isInteger(item.row) && Number.isInteger(item.column)) {
            button.onclick = () => requestUrlAuth(button, context, item, status);
          } else if (item.type === 'copy' && typeof item.copyText === 'string') {
            button.onclick = () => copyText(button, context, item);
          } else if (item.type === 'user_profile' && Number.isSafeInteger(item.userId) && item.userId > 0) {
            button.onclick = () => { if (current(context)) window.loadPeerProfile?.(item.userId); };
          } else if (['web_app', 'simple_web_app'].includes(item.type) && Number.isInteger(item.row) && Number.isInteger(item.column) && window.MiniApp) {
            button.onclick = () => { if (current(context)) void window.MiniApp.open(context, item.row, item.column); };
          } else {
            button.disabled = true; button.title = '该按钮类型暂不支持';
          }
        }
        button.className = 'bot-keyboard-button';
        button.textContent = item.text;
        rowNode.appendChild(button);
      }
      wrapper.appendChild(rowNode);
    }
    wrapper.appendChild(status);
    parent.appendChild(wrapper);
  }

  function resetReply() {
    replyStateEpoch++;
    activeReply = null;
    forceReplyApplied = null;
    const container = document.getElementById('bot-reply-keyboard');
    if (container) { container.hidden = true; container.replaceChildren(); }
  }

  function clearAccount(instId) {
    accountEpoch.set(instId, (accountEpoch.get(instId) || 0) + 1);
    for (const key of hiddenReplyKeyboards) {
      try { if (JSON.parse(key)[0] === instId) hiddenReplyKeyboards.delete(key); } catch (_) {}
    }
    if (state.clientSelectedInstance === instId) resetReply();
  }

  function replaceReplySnapshot(messages, instId, chatId) {
    if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId)) return;
    let latest = null;
    for (const message of messages || []) {
      if (!message.replyKeyboard || !Number.isSafeInteger(Number(message.id)) || Number(message.id) <= 0) continue;
      if (!latest || Number(message.id) > Number(latest.id)) latest = message;
    }
    // A refresh fetches only the newest messages. The active keyboard can be
    // older than that window; keep it until a newer keyboard/hide event or a
    // deletion arrives. Chat/account switches explicitly reset this state.
    if (latest && (!activeReply || Number(latest.id) >= Number(activeReply.id))) {
      const keyboard = latest.replyKeyboard;
      const hasAnswer = messages.some(message => message.outgoing && String(message.text || '').length &&
        (keyboard.type === 'force' ? String(message.replyToMessageId) === String(latest.id) :
          keyboard.singleUse && Number(message.id) > Number(latest.id)));
      activeReply = hasAnswer ? null : latest;
    }
  }

  function replaceReplyState(snapshot, instId, chatId, expectedEpoch) {
    if (instId !== state.clientSelectedInstance || String(chatId) !== String(state.clientActiveChatId)) return;
    if (Number.isSafeInteger(expectedEpoch) && expectedEpoch !== replyStateEpoch) return;
    const latestMessageId = Number(snapshot?.latestMessageId) || 0;
    if (activeReply && Number(activeReply.id) > latestMessageId) return;
    activeReply = snapshot?.message?.replyKeyboard ? snapshot.message : null;
    forceReplyApplied = null;
    renderReply();
  }

  function applyReplyEvent(event) {
    if (!event || event.instId !== state.clientSelectedInstance) return;
    if (event.type === 'message_delete' && String(event.chatId) === String(state.clientActiveChatId)) {
      replyStateEpoch++;
      if (activeReply && Array.isArray(event.messageIds) && event.messageIds.some(id => String(id) === String(activeReply.id))) {
        activeReply = null;
        renderReply();
      }
      return;
    }
    const message = event.message;
    if (!message || String(message.chatId) !== String(state.clientActiveChatId)) return;
    if (event.type === 'new_message' || event.type === 'message_edited' || event.type === 'message_edit') replyStateEpoch++;
    const activeKeyboard = activeReply?.replyKeyboard;
    const answersForceReply = activeKeyboard?.type === 'force' && String(message.replyToMessageId) === String(activeReply.id);
    const consumesSingleUse = activeKeyboard?.singleUse && message.outgoing && String(message.text || '').length > 0 &&
      Number(message.id) > Number(activeReply.id);
    if (event.type === 'new_message' && activeReply && (answersForceReply || consumesSingleUse)) {
      activeReply = null;
      forceReplyApplied = null;
      renderReply();
      return;
    }
    if ((event.type === 'message_edited' || event.type === 'message_edit') && activeReply && String(activeReply.id) === String(message.id)) {
      activeReply = message.replyKeyboard || null;
      renderReply();
    } else if (event.type === 'new_message' && message.replyKeyboard &&
        (!activeReply || Number(message.id) > Number(activeReply.id))) {
      activeReply = message;
      renderReply();
    }
  }

  function renderReply() {
    const container = document.getElementById('bot-reply-keyboard');
    if (!container) return;
    container.replaceChildren();
    container.hidden = true;
    if (!state.clientSelectedInstance || state.clientActiveChatId == null || state.clientHistoryOffsetDate != null || state.clientHistoryAnchorId != null) return;
    const latest = activeReply;
    const keyboard = latest?.replyKeyboard;
    if (!keyboard) return;
    if (keyboard.type === 'force') {
      const forceKey = JSON.stringify([state.clientSelectedInstance, String(state.clientActiveChatId), String(latest.id)]);
      if (forceReplyApplied !== forceKey) {
        forceReplyApplied = forceKey;
        if (!state.clientReplyingTo) window.setReplyingMessage?.(latest);
      }
      return;
    }
    if (keyboard.type !== 'keyboard' || !Array.isArray(keyboard.rows)) return;
    const context = { instId: state.clientSelectedInstance, chatId: state.clientActiveChatId,
      messageId: latest.id, selectionVersion: state.chatSelectionVersion,
      accountEpoch: accountEpoch.get(state.clientSelectedInstance) || 0 };
    const keyboardKey = JSON.stringify([context.instId, String(context.chatId), String(context.messageId)]);
    const header = document.createElement('div'); header.className = 'bot-reply-keyboard-header';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'btn btn-secondary btn-xs';
    const isHidden = hiddenReplyKeyboards.has(keyboardKey);
    toggle.textContent = isHidden ? '显示机器人键盘' : '隐藏机器人键盘';
    toggle.onclick = () => {
      if (!current(context)) return;
      if (isHidden) hiddenReplyKeyboards.delete(keyboardKey);
      else {
        hiddenReplyKeyboards.add(keyboardKey);
        if (hiddenReplyKeyboards.size > 200) hiddenReplyKeyboards.delete(hiddenReplyKeyboards.values().next().value);
      }
      renderReply();
    };
    header.appendChild(toggle); container.appendChild(header);
    if (!isHidden) {
      for (const row of keyboard.rows) {
        if (!Array.isArray(row) || !row.length) continue;
        const rowNode = document.createElement('div'); rowNode.className = 'bot-keyboard-row';
        for (const item of row) {
          if (!item || typeof item.text !== 'string') continue;
          const button = document.createElement('button'); button.type = 'button'; button.className = 'bot-keyboard-button';
          button.textContent = item.text;
          if (item.type === 'request_phone' && Number.isInteger(item.row) && Number.isInteger(item.column)) {
            button.onclick = () => shareReplyPhone(button, context, item, keyboardKey, keyboard);
          } else if (item.type === 'request_location' && Number.isInteger(item.row) && Number.isInteger(item.column)) {
            button.onclick = () => shareReplyLocation(button, context, item, keyboardKey, keyboard);
          } else if (item.type === 'request_poll') {
            button.onclick = () => { if (current(context)) window.openPollCreationForRequest?.(item.quiz); };
          } else if (item.type === 'request_peer' && item.peerRequest) {
            button.onclick = () => openPeerRequest(context, item, container, true);
          } else if (item.type === 'user_profile' && Number.isSafeInteger(item.userId) && item.userId > 0) {
            button.onclick = () => { if (current(context)) window.loadPeerProfile?.(item.userId); };
          } else if (item.type === 'simple_web_app' && Number.isInteger(item.row) && Number.isInteger(item.column) && window.MiniApp) {
            button.onclick = () => { if (current(context)) void window.MiniApp.open(context, item.row, item.column); };
          } else if (item.type !== 'text' || !item.text) {
            button.disabled = true; button.title = item.reason || '该按钮类型暂不支持';
            button.textContent = `${item.text}（${button.title}）`;
          } else {
            button.onclick = async () => {
              if (!current(context)) return;
              const key = JSON.stringify(['reply', context.instId, context.chatId, context.messageId]);
              if (pending.has(key)) return;
              pending.add(key); button.disabled = true;
              try {
                await api(`/api/instances/${encodeURIComponent(context.instId)}/account/send`, 'POST', {
                  chatId: context.chatId, text: item.text, options: { parseMode: 'plain', silent: Boolean(state.clientSilent),
                    ...(Number(context.chatId) < 0 ? { replyTo: Number(context.messageId) } : {}) },
                });
                if (keyboard.singleUse && (accountEpoch.get(context.instId) || 0) === context.accountEpoch) hiddenReplyKeyboards.add(keyboardKey);
                if (!current(context)) return;
                renderReply();
                await loadClientMessages(context.chatId, true);
              } catch (error) {
                if (current(context)) showToast(`发送未确认，请检查会话后重试: ${error.message}`, 'error');
              } finally { pending.delete(key); button.disabled = false; }
            };
          }
          rowNode.appendChild(button);
        }
        container.appendChild(rowNode);
      }
    }
    container.hidden = false;
  }
  return { mount, safeUrl, renderReply, resetReply, clearAccount, replaceReplySnapshot, replaceReplyState,
    getReplyStateEpoch: () => replyStateEpoch, applyReplyEvent };
})();

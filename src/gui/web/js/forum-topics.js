'use strict';

// Topic view is kept separate from the parent chat composer and drafts.
window.ForumTopics = (() => {
  let modal, title, status, list, more, back, composer, input, send, replyLabel, attachButton, fileInput, stickerButton, stickerPanel, stickerSearch, stickerPacks, stickerGrid, stickerStatus, gifButton, gifPanel, gifGrid, gifStatus;
  let context = null, selectedDialog = null, sequence = 0, busy = false, sending = false, mutating = false, cursor = null, messageOffset = null, replyTo = null, topicRefreshTimer = null;
  let topicIds = new Set(), messageIds = new Set();
  let stickerCache = { instId: null, packs: null, details: new Map() }, gifCache = { instId: null, gifs: null }, selectedStickerPack = null;

  function valid(ctx = context) {
    return Boolean(ctx && ctx === context && state.clientSelectedInstance === ctx.instId &&
      String(state.clientActiveChatId) === String(ctx.chatId) && state.chatSelectionVersion === ctx.version);
  }
  function close() {
    sequence++; context = null; busy = false; sending = false; mutating = false; cursor = null; messageOffset = null; replyTo = null;
    if (topicRefreshTimer) { clearTimeout(topicRefreshTimer); topicRefreshTimer = null; }
    if (modal) modal.hidden = true;
    if (stickerPanel) stickerPanel.hidden = true;
    if (gifPanel) gifPanel.hidden = true;
  }
  function init() {
    if (modal) return;
    const style = document.createElement('style');
    style.textContent = `.forum-overlay{position:fixed;inset:0;z-index:1500;background:#0009;display:flex;align-items:center;justify-content:center;padding:16px}.forum-overlay[hidden]{display:none}.forum-window{background:var(--bg-card,#202a33);color:var(--text-primary,#fff);border-radius:12px;width:min(760px,100%);height:min(720px,90dvh);display:flex;flex-direction:column;overflow:hidden}.forum-head,.forum-compose{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid var(--border-color,#ffffff24)}.forum-head strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.forum-list{flex:1;overflow:auto;padding:8px 12px}.forum-row{display:block;width:100%;padding:12px;text-align:left;background:transparent;color:inherit;border:0;cursor:pointer}.forum-topic-row{display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border-color,#ffffff24);flex-wrap:wrap}.forum-topic-open{flex:1;min-width:180px}.forum-topic-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.forum-topic-action{padding:5px 7px;font-size:11px}.forum-message{padding:10px 0;border-bottom:1px solid var(--border-color,#ffffff24);white-space:pre-wrap;overflow-wrap:anywhere}.forum-compose{border-top:1px solid var(--border-color,#ffffff24);border-bottom:0;flex-wrap:wrap}.forum-compose textarea{flex:1;min-width:0;min-height:42px;max-height:100px;resize:vertical}.forum-status,.forum-reply{padding:4px 12px;color:var(--text-muted,#aaa)}.forum-more{margin:8px auto}.forum-reply[hidden],.forum-compose[hidden],.forum-more[hidden]{display:none}.forum-stickers,.forum-gifs{padding:8px 12px;border-top:1px solid var(--border-color,#ffffff24)}.forum-stickers[hidden],.forum-gifs[hidden]{display:none}.forum-sticker-packs{display:flex;gap:6px;overflow-x:auto;padding:6px 0}.forum-sticker-grid,.forum-gif-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;max-height:210px;overflow:auto}.forum-sticker-pack{white-space:nowrap}.forum-sticker,.forum-gif{display:grid;place-items:center;min-height:68px;border:0;border-radius:8px;background:transparent;cursor:pointer}.forum-sticker:hover,.forum-gif:hover{background:var(--bg-hover,#ffffff14)}.forum-sticker img,.forum-gif video{width:60px;height:60px;object-fit:contain}.forum-sticker-search{width:100%;max-width:260px}`;
    style.textContent += '.forum-media-image,.forum-media-video{display:block;max-width:min(100%,420px);max-height:360px;border-radius:8px;margin:8px 0}.forum-media-audio{display:block;width:min(100%,360px);margin:8px 0}.forum-media-location{display:grid;gap:5px;padding:8px 10px;border-radius:8px;background:var(--bg-hover,#ffffff14)}';
    document.head.appendChild(style);
    modal = document.createElement('div'); modal.className = 'forum-overlay'; modal.hidden = true;
    modal.innerHTML = `<div class="forum-window" role="dialog" aria-modal="true" aria-labelledby="forum-title"><div class="forum-head"><button type="button" class="btn btn-secondary btn-sm" data-back hidden>返回</button><strong id="forum-title">话题</strong><button type="button" class="btn btn-secondary btn-sm" data-create>新建话题</button><button type="button" class="btn btn-secondary btn-sm" data-close>关闭</button></div><div class="forum-list"></div><button type="button" class="btn btn-secondary btn-sm forum-more" hidden>加载更多</button><div class="forum-status" role="status"></div><div class="forum-reply" hidden></div><div class="forum-compose" hidden><textarea class="form-textarea" maxlength="4096" aria-label="话题消息或媒体说明" placeholder="输入消息或媒体说明"></textarea><button type="button" class="btn btn-secondary" data-attach>附件</button><input type="file" data-file accept="image/*,video/*,*/*" multiple hidden><button type="button" class="btn btn-secondary" data-location>实时位置</button><button type="button" class="btn btn-secondary" data-stickers>贴纸</button><button type="button" class="btn btn-secondary" data-gifs>GIF</button><select data-dice-choice aria-label="选择骰子"><option value="🎲">骰子</option><option value="🎯">飞镖</option><option value="🏀">篮球</option><option value="⚽">足球</option><option value="🎳">保龄球</option><option value="🎰">老虎机</option></select><button type="button" class="btn btn-secondary" data-send-dice>掷</button><button type="button" class="btn btn-primary" data-send>发送</button></div><div class="forum-stickers" hidden><input class="form-input forum-sticker-search" type="search" maxlength="128" placeholder="搜索贴纸包" aria-label="搜索贴纸包"><div class="forum-sticker-packs"></div><div class="forum-sticker-grid"></div><div class="forum-sticker-status forum-status" role="status"></div></div><div class="forum-gifs" hidden><div class="forum-gif-grid"></div><div class="forum-gif-status forum-status" role="status"></div></div></div>`;
    document.body.appendChild(modal);
    title = modal.querySelector('#forum-title'); status = modal.querySelector('.forum-status'); list = modal.querySelector('.forum-list'); more = modal.querySelector('.forum-more'); back = modal.querySelector('[data-back]'); composer = modal.querySelector('.forum-compose'); input = modal.querySelector('textarea'); send = modal.querySelector('[data-send]'); attachButton = modal.querySelector('[data-attach]'); fileInput = modal.querySelector('[data-file]'); replyLabel = modal.querySelector('.forum-reply'); stickerButton = modal.querySelector('[data-stickers]'); stickerPanel = modal.querySelector('.forum-stickers'); stickerSearch = modal.querySelector('.forum-sticker-search'); stickerPacks = modal.querySelector('.forum-sticker-packs'); stickerGrid = modal.querySelector('.forum-sticker-grid'); stickerStatus = modal.querySelector('.forum-sticker-status'); gifButton = modal.querySelector('[data-gifs]'); gifPanel = modal.querySelector('.forum-gifs'); gifGrid = modal.querySelector('.forum-gif-grid'); gifStatus = modal.querySelector('.forum-gif-status');
    modal.querySelector('[data-close]').onclick = close;
    modal.onclick = event => { if (event.target === modal) close(); };
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    list.addEventListener('scroll', () => {
      if (context?.topic && messageOffset && list.scrollTop <= 64 && !busy) void loadMessages(true);
    }, { passive: true });
    back.onclick = () => showTopics();
    const createButton = modal.querySelector('[data-create]');
    if (createButton) { createButton.onclick = createTopic; createButton.title = '需要管理员权限'; }
    more.onclick = () => context?.topic ? loadMessages(Boolean(messageOffset)) : loadTopics(Boolean(cursor));
    send.onclick = sendMessage;
    const diceChoice = modal.querySelector('[data-dice-choice]');
    const diceSend = modal.querySelector('[data-send-dice]');
    if (diceChoice && diceSend) diceSend.onclick = async () => {
      const ctx = context, topic = ctx?.topic;
      if (!valid(ctx) || !topic || typeof window.sendTelegramDice !== 'function') return;
      diceSend.disabled = true;
      try {
        const sent = await window.sendTelegramDice(ctx.chatId, diceChoice.value, Number(topic.id));
        if (sent && valid(ctx) && context.topic === topic) await loadMessages(false);
      } finally { diceSend.disabled = false; }
    };
    const locationButton = modal.querySelector('[data-location]');
    if (locationButton) locationButton.onclick = () => {
      const ctx = context, topic = ctx?.topic;
      if (!valid(ctx) || !topic || typeof window.startClientLiveLocation !== 'function') return;
      window.startClientLiveLocation({ instId: ctx.instId, chatId: ctx.chatId, selectionVersion: ctx.version,
        isCurrent: () => valid(ctx) && Number(ctx.topic?.id) === Number(topic.id) }, Number(topic.id));
    };
    if (attachButton && fileInput) {
      attachButton.onclick = () => fileInput.click();
      fileInput.onchange = () => { const files = Array.from(fileInput.files || []); fileInput.value = ''; if (files.length > 1) sendMediaAlbum(files); else if (files[0]) sendMedia(files[0]); };
    }
    if (stickerButton) stickerButton.onclick = () => { stickerPanel.hidden = !stickerPanel.hidden; if (!stickerPanel.hidden) { if (gifPanel) gifPanel.hidden = true; void loadStickerPacks(); } };
    if (gifButton) gifButton.onclick = () => { gifPanel.hidden = !gifPanel.hidden; if (!gifPanel.hidden) { if (stickerPanel) stickerPanel.hidden = true; void loadSavedGifs(); } };
    if (stickerSearch) stickerSearch.oninput = () => renderStickerPacks();
  }
  function open() {
    const dialog = currentDialog();
    if (!state.clientSelectedInstance || !dialog?.isForum) return;
    init(); close();
    context = { instId: state.clientSelectedInstance, chatId: dialog.id, version: state.chatSelectionVersion, topic: null };
    modal.hidden = false; showTopics();
  }
  function showTopics() {
    if (!valid()) { close(); return; }
    sequence++; busy = false; sending = false; mutating = false; send.disabled = false; context.topic = null; cursor = null; topicIds = new Set(); replyTo = null;
    list.replaceChildren(); title.textContent = '话题'; back.hidden = true; composer.hidden = true; replyLabel.hidden = true; more.hidden = true;
    const createButton = modal.querySelector('[data-create]'); if (createButton) createButton.hidden = false;
    status.textContent = '新建、改名、置顶及关闭操作需要相应的管理员权限。';
    loadTopics(false);
  }
  async function loadTopics(append) {
    const ctx = context;
    if (!valid(ctx) || busy || (append && !cursor)) return;
    busy = true; const current = ++sequence; const oldCursor = append ? cursor : null;
    status.textContent = '正在加载话题…'; more.disabled = true;
    try {
      const params = new URLSearchParams({ chatId: String(ctx.chatId) });
      if (oldCursor) { params.set('date', String(oldCursor.date)); params.set('messageId', String(oldCursor.messageId)); params.set('topicId', String(oldCursor.topicId)); }
      const result = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/forum-topics?${params}`);
      if (!valid(ctx) || current !== sequence || ctx.topic) return;
      const topics = Array.isArray(result?.topics) ? result.topics : [];
      if (!append) { list.replaceChildren(); topicIds = new Set(); }
      for (const topic of topics) {
        if (!Number.isSafeInteger(topic.id) || topic.id <= 0 || topicIds.has(topic.id)) continue;
        topicIds.add(topic.id);
        const row = document.createElement('div'); row.className = 'forum-topic-row';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'forum-row forum-topic-open';
        button.textContent = `${topic.title || '话题'}${topic.closed ? ' · 已关闭' : ''}${topic.unreadCount ? ` · ${topic.unreadCount} 条未读` : ''}`;
        const iconColor = Number(topic.iconColor);
        button.style.borderLeft = Number.isSafeInteger(iconColor) && iconColor > 0 && iconColor <= 0xffffff
          ? `4px solid #${iconColor.toString(16).padStart(6, '0')}` : '';
        button.onclick = () => openTopic(topic);
        const actions = document.createElement('div'); actions.className = 'forum-topic-actions';
        actions.append(
          topicActionButton('改名', () => editTopicTitle(topic)),
          topicActionButton(topic.pinned ? '取消置顶' : '置顶', () => mutateTopic(topic, { action: 'pin', pinned: !topic.pinned })),
          topicActionButton(topic.closed ? '重开' : '关闭', () => mutateTopic(topic, { action: 'edit', closed: !topic.closed })),
          topicActionButton(topic.hidden ? '显示' : '隐藏', () => mutateTopic(topic, { action: 'edit', hidden: !topic.hidden })),
        );
        if (topic.pinned) actions.append(
          topicActionButton('置顶上移', () => mutateTopic(topic, { action: 'movePin', direction: 'up' })),
          topicActionButton('置顶下移', () => mutateTopic(topic, { action: 'movePin', direction: 'down' })),
        );
        if (topic.id !== 1) actions.append(topicActionButton('删除', () => deleteTopic(topic), true));
        row.append(button, actions);
        list.appendChild(row);
      }
      const next = result?.nextCursor;
      cursor = next && (!oldCursor || JSON.stringify(next) !== JSON.stringify(oldCursor)) ? next : null;
      if (result?.incomplete) cursor = oldCursor;
      more.hidden = !cursor && !result?.incomplete; more.textContent = result?.incomplete ? '重试' : '加载更多话题';
      status.textContent = result?.incomplete ? '无法确定下一页，请稍后重试。' : (!topicIds.size ? '暂无话题' : '');
    } catch (error) {
      if (valid(ctx) && current === sequence) { status.textContent = `无法加载话题：${error.message}`; cursor = oldCursor; more.hidden = false; more.textContent = '重试'; }
    } finally { if (valid(ctx) && current === sequence) { busy = false; more.disabled = false; } }
  }
  function openTopic(topic) {
    if (!valid()) { close(); return; }
    sequence++; busy = false; sending = false; mutating = false; send.disabled = false; context.topic = topic; messageOffset = null; messageIds = new Set(); replyTo = null;
    list.replaceChildren(); title.textContent = topic.title || '话题'; back.hidden = false; composer.hidden = Boolean(topic.closed); replyLabel.hidden = true; input.value = ''; more.hidden = true; if (stickerPanel) stickerPanel.hidden = true; if (gifPanel) gifPanel.hidden = true;
    const iconColor = Number(topic.iconColor);
    title.style.color = Number.isSafeInteger(iconColor) && iconColor > 0 && iconColor <= 0xffffff
      ? `#${iconColor.toString(16).padStart(6, '0')}` : '';
    title.dataset = title.dataset || {};
    title.dataset.topicIconEmojiId = typeof topic.iconEmojiId === 'string' && /^[1-9]\d{0,19}$/.test(topic.iconEmojiId) ? topic.iconEmojiId : '';
    if (topic.closed) status.textContent = '此话题已关闭，只能查看历史消息。';
    const createButton = modal.querySelector('[data-create]'); if (createButton) createButton.hidden = true;
    loadMessages(false);
  }
  function renderMessage(message) {
    const row = document.createElement('div'); row.className = 'forum-message';
    const author = document.createElement('strong'); author.textContent = [message.from?.firstName, message.from?.lastName].filter(Boolean).join(' ') || message.from?.username || '用户';
    row.appendChild(author);
    if (message.media) row.appendChild(renderMedia(message));
    const text = document.createElement('div'); text.textContent = message.text || '';
    const reply = document.createElement('button'); reply.type = 'button'; reply.className = 'btn btn-secondary btn-xs'; reply.textContent = '回复';
    reply.onclick = () => { if (!valid()) return; replyTo = message.id; replyLabel.textContent = `回复消息 #${message.id}（点击取消）`; replyLabel.hidden = false; input.focus(); };
    row.append(text, reply);
    if (message.outgoing && message.media?.type === 'location' && message.media.liveLocation) {
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn btn-secondary btn-xs'; stop.textContent = '停止共享实时位置';
      stop.onclick = event => { event.stopPropagation(); if (valid() && typeof window.stopClientLiveLocation === 'function') void window.stopClientLiveLocation(context.instId, context.chatId, Number(message.id)); };
      row.appendChild(stop);
    }
    return row;
  }
  function renderMedia(message) {
    const media = message.media || {};
    const url = `/api/instances/${encodeURIComponent(context.instId)}/account/media?chatId=${encodeURIComponent(context.chatId)}&messageId=${encodeURIComponent(message.id)}`;
    if (media.type === 'photo' || (media.type === 'animation' && media.mimeType === 'image/gif') ||
        (media.type === 'sticker' && !media.isVideoSticker && media.mimeType === 'image/webp')) {
      const image = document.createElement('img'); image.className = 'forum-media-image'; image.loading = 'lazy'; image.alt = media.fileName || '图片'; image.src = url; return image;
    }
    if (media.type === 'video' || media.type === 'animation' || (media.type === 'sticker' && media.isVideoSticker)) {
      const video = document.createElement('video'); video.className = 'forum-media-video'; video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = url; return video;
    }
    if (media.type === 'audio' || media.type === 'voice') {
      const audio = document.createElement('audio'); audio.className = 'forum-media-audio'; audio.controls = true; audio.preload = 'metadata'; audio.src = url; return audio;
    }
    if (media.type === 'document') {
      const link = document.createElement('a'); link.href = `${url}&download=1`; link.textContent = media.fileName || '下载文件'; link.rel = 'noreferrer'; return link;
    }
    if (media.type === 'location') {
      const card = document.createElement('div'); card.className = 'forum-media-location';
      const title = document.createElement('strong'); title.textContent = media.liveLocation ? '实时位置' : (media.locationTitle || '位置'); card.appendChild(title);
      const lat = Number(media.latitude), lon = Number(media.longitude);
      if (Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180) {
        const map = document.createElement('a'); map.href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=15/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}`;
        map.target = '_blank'; map.rel = 'noopener noreferrer'; map.textContent = '在地图中打开'; card.appendChild(map);
      }
      return card;
    }
    const hint = document.createElement('div'); hint.textContent = '[媒体消息]'; return hint;
  }
  async function loadMessages(append) {
    const ctx = context, topic = ctx?.topic;
    if (!valid(ctx) || !topic || busy || (append && !messageOffset)) return;
    busy = true; const current = ++sequence; const oldOffset = append ? messageOffset : null;
    const oldScrollHeight = append ? (Number(list.scrollHeight) || 0) : 0;
    const oldScrollTop = append ? (Number(list.scrollTop) || 0) : 0;
    status.textContent = '正在加载话题消息…'; more.disabled = true;
    try {
      const params = new URLSearchParams({ chatId: String(ctx.chatId), topicId: String(topic.id) });
      if (oldOffset) params.set('offsetId', String(oldOffset));
      const result = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/forum-messages?${params}`);
      if (!valid(ctx) || current !== sequence || ctx.topic !== topic) return;
      const messages = Array.isArray(result) ? result : [];
      if (!append) { list.replaceChildren(); messageIds = new Set(); }
      const elements = [];
      for (const message of [...messages].reverse()) {
        const id = Number(message.id); if (!Number.isSafeInteger(id) || id <= 0 || messageIds.has(id)) continue;
        messageIds.add(id); elements.push(renderMessage(message));
      }
      if (append) {
        list.prepend(...elements);
        list.scrollTop = oldScrollTop + Math.max(0, (Number(list.scrollHeight) || 0) - oldScrollHeight);
      } else {
        list.append(...elements);
        list.scrollTop = list.scrollHeight;
      }
      const lastId = messages.length ? Number(messages[messages.length - 1].id) : 0;
      messageOffset = messages.length >= 50 && lastId > 0 && lastId !== oldOffset ? lastId : null;
      more.hidden = !messageOffset; more.textContent = '加载更早消息'; status.textContent = !messageIds.size ? '暂无话题消息' : '';
      if (!append && messages.length) {
        const maxId = Math.max(0, ...messages.map(message => Number(message.id) || 0));
        void markTopicRead(ctx, topic, maxId);
      }
    } catch (error) {
      if (valid(ctx) && current === sequence && ctx.topic === topic) { status.textContent = `无法加载话题消息：${error.message}`; messageOffset = oldOffset; more.hidden = false; more.textContent = '重试'; }
    } finally { if (valid(ctx) && current === sequence) { busy = false; more.disabled = false; } }
  }
  async function markTopicRead(ctx, topic, maxId) {
    if (!valid(ctx) || ctx.topic !== topic || modal.hidden || !Number.isSafeInteger(maxId) || maxId <= 0 ||
        (typeof document !== 'undefined' && document.hidden === true) ||
        (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus())) return;
    if (!(Number(topic.unreadCount) > 0) && !ctx.forceTopicRead) return;
    ctx.readMaxId = Math.max(Number(ctx.readMaxId) || 0, maxId);
    if (ctx.readPromise) return ctx.readPromise;
    ctx.readPromise = (async () => {
      let completedMaxId = 0;
      while (valid(ctx) && ctx.topic === topic && ctx.readMaxId > completedMaxId) {
        const requestedMaxId = ctx.readMaxId;
        try {
          await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/forum-topic-read`, 'POST', {
            chatId: ctx.chatId, topicId: topic.id, maxId: requestedMaxId,
          });
          completedMaxId = requestedMaxId;
          if (valid(ctx) && ctx.topic === topic && !modal.hidden) topic.unreadCount = 0;
        } catch (error) {
          if (valid(ctx) && ctx.topic === topic) status.textContent = `话题消息已加载，但未能确认已读：${error.message}`;
          break;
        }
      }
    })().finally(() => { if (ctx.readPromise) ctx.readPromise = null; });
    return ctx.readPromise;
  }
  function handleMessage(message) {
    const ctx = context;
    if (!valid(ctx) || !message || String(message.chatId) !== String(ctx.chatId)) return;
    const topicId = Number(message.topicId);
    if (!ctx.topic) {
      if (topicRefreshTimer) return;
      topicRefreshTimer = setTimeout(() => {
        topicRefreshTimer = null;
        if (valid(ctx) && !ctx.topic) refreshTopics();
      }, 220);
      return;
    }
    if (!Number.isSafeInteger(topicId) || topicId !== Number(ctx.topic.id)) return;
    if (message.topicUpdate && typeof message.topicUpdate === 'object') {
      const update = message.topicUpdate;
      if (typeof update.title === 'string') { ctx.topic.title = update.title; title.textContent = update.title || '话题'; }
      if (typeof update.iconEmojiId === 'string' && /^[1-9]\d{0,19}$/.test(update.iconEmojiId)) {
        ctx.topic.iconEmojiId = update.iconEmojiId;
        title.dataset = title.dataset || {};
        title.dataset.topicIconEmojiId = update.iconEmojiId;
      }
      if (typeof update.closed === 'boolean') { ctx.topic.closed = update.closed; composer.hidden = update.closed; }
      if (typeof update.hidden === 'boolean') ctx.topic.hidden = update.hidden;
      if (update.closed === true) status.textContent = '此话题已关闭，只能查看历史消息。';
      else if (update.closed === false && /此话题已关闭/.test(status.textContent)) status.textContent = '';
    }
    const id = Number(message.id);
    if (!Number.isSafeInteger(id) || id <= 0 || messageIds.has(id)) return;
    messageIds.add(id);
    list.appendChild(renderMessage(message));
    if (!message.outgoing) {
      ctx.topic.unreadCount = (Number(ctx.topic.unreadCount) || 0) + 1;
      ctx.forceTopicRead = true;
      void markTopicRead(ctx, ctx.topic, id).finally(() => { ctx.forceTopicRead = false; });
    }
    list.scrollTop = list.scrollHeight;
  }
  async function sendMessage() {
    const ctx = context, topic = ctx?.topic, text = input.value, reply = replyTo;
    if (!valid(ctx) || !topic || !text.trim() || sending) return;
    sending = true; send.disabled = true; if (attachButton) attachButton.disabled = true; status.textContent = '正在发送…';
    try {
      await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/forum-messages`, 'POST', { chatId: ctx.chatId, topicId: topic.id, text, replyTo: reply || undefined });
      if (!valid(ctx) || ctx.topic !== topic) return;
      if (input.value === text) input.value = '';
      if (replyTo === reply) { replyTo = null; replyLabel.hidden = true; }
      busy = false; await loadMessages(false);
    } catch (error) { if (valid(ctx) && ctx.topic === topic) status.textContent = `发送未确认，请检查后重试：${error.message}`; }
    finally { if (valid(ctx) && ctx.topic === topic) { sending = false; send.disabled = false; if (attachButton) attachButton.disabled = false; } }
  }
  async function sendMedia(file) {
    const ctx = context, topic = ctx?.topic, caption = input.value, reply = replyTo;
    if (!valid(ctx) || !topic || sending) return;
    if (file.size > 2 * 1024 * 1024 * 1024) { status.textContent = '附件超过 2 GiB。'; return; }
    let mediaType = 'document';
    if (file.type.startsWith('image/')) mediaType = 'photo';
    else if (file.type.startsWith('video/')) mediaType = 'video';
    else if (file.type.startsWith('audio/')) mediaType = 'audio';
    sending = true; send.disabled = true; if (attachButton) attachButton.disabled = true; status.textContent = '正在上传附件…';
    try {
      await sendMediaStream(`/api/instances/${encodeURIComponent(ctx.instId)}/account/send-media`, file, {
        chatId: ctx.chatId, topicId: topic.id, replyTo: reply || topic.id, mediaType,
        fileName: file.name, caption: caption || undefined, parseMode: 'plain',
      }, (phase, percent) => {
        if (valid(ctx) && ctx.topic === topic) status.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
      });
      if (!valid(ctx) || ctx.topic !== topic) return;
      if (input.value === caption) input.value = '';
      if (replyTo === reply) { replyTo = null; replyLabel.hidden = true; }
      busy = false; await loadMessages(false);
    } catch (error) { if (valid(ctx) && ctx.topic === topic) status.textContent = `附件发送失败：${error.message}`; }
    finally { if (valid(ctx) && ctx.topic === topic) { sending = false; send.disabled = false; if (attachButton) attachButton.disabled = false; } }
  }
  async function sendMediaAlbum(files) {
    const ctx = context, topic = ctx?.topic, caption = input.value, reply = replyTo;
    if (!valid(ctx) || !topic || sending) return;
    const allowedType = file => /^(?:image\/(?:jpeg|png|webp|heic|heif)|video\/(?:mp4|webm|quicktime|x-m4v|3gpp))$/i.test(file.type || '');
    if (!Array.isArray(files) || files.length < 2 || files.length > 10 || files.some(file => !allowedType(file) || file.size > 2 * 1024 * 1024 * 1024)) {
      status.textContent = '相册仅支持 2 到 10 张照片或视频，单个文件不能超过 2 GiB。'; return;
    }
    sending = true; send.disabled = true; if (attachButton) attachButton.disabled = true; status.textContent = '正在上传相册…';
    try {
      await sendMediaAlbumStream(`/api/instances/${encodeURIComponent(ctx.instId)}/account/send-media-album`, files, {
        chatId: ctx.chatId, topicId: topic.id, replyTo: reply || topic.id,
        caption: caption || undefined, parseMode: 'plain',
      }, (phase, percent) => {
        if (valid(ctx) && ctx.topic === topic) status.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
      });
      if (!valid(ctx) || ctx.topic !== topic) return;
      if (input.value === caption) input.value = '';
      if (replyTo === reply) { replyTo = null; replyLabel.hidden = true; }
      busy = false; await loadMessages(false);
    } catch (error) { if (valid(ctx) && ctx.topic === topic) status.textContent = `相册发送失败：${error.message}`; }
    finally { if (valid(ctx) && ctx.topic === topic) { sending = false; send.disabled = false; if (attachButton) attachButton.disabled = false; } }
  }
  async function loadStickerPacks() {
    const ctx = context;
    if (!valid(ctx)) return;
    if (stickerCache.instId !== ctx.instId) { stickerCache = { instId: ctx.instId, packs: null, details: new Map() }; selectedStickerPack = null; }
    if (stickerCache.packs) { renderStickerPacks(); return; }
    stickerStatus.textContent = '正在加载已安装的贴纸包…';
    try {
      const packs = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/stickers`);
      if (!valid(ctx)) return;
      stickerCache.packs = Array.isArray(packs) ? packs : [];
      stickerStatus.textContent = stickerCache.packs.length ? '' : '当前账号没有已安装的贴纸包。';
      renderStickerPacks();
      if (stickerCache.packs.length && !selectedStickerPack) await loadStickerPack(stickerCache.packs[0]);
    } catch (error) {
      if (valid(ctx)) stickerStatus.textContent = `无法加载贴纸包：${error.message}`;
    }
  }
  function packKey(pack) { return `${pack.id}:${pack.accessHash}`; }
  function renderStickerPacks() {
    if (!stickerPacks || !stickerCache.packs) return;
    const query = (stickerSearch.value || '').trim().toLowerCase();
    stickerPacks.replaceChildren();
    const packs = stickerCache.packs.filter(pack => `${pack.title || ''} ${pack.shortName || ''}`.toLowerCase().includes(query));
    for (const pack of packs) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = `btn btn-secondary btn-sm forum-sticker-pack${selectedStickerPack && packKey(selectedStickerPack) === packKey(pack) ? ' active' : ''}`;
      button.textContent = `${pack.title || pack.shortName || '贴纸包'} (${pack.count || 0})`;
      button.onclick = () => void loadStickerPack(pack);
      stickerPacks.appendChild(button);
    }
    if (!packs.length) { stickerGrid.replaceChildren(); stickerStatus.textContent = query ? '没有匹配的贴纸包。' : '当前账号没有已安装的贴纸包。'; }
  }
  async function loadStickerPack(pack) {
    const ctx = context;
    if (!valid(ctx) || !pack) return;
    selectedStickerPack = pack; renderStickerPacks(); stickerGrid.replaceChildren();
    const key = packKey(pack);
    let details = stickerCache.details.get(key);
    if (!details) {
      stickerStatus.textContent = `正在加载“${pack.title || '贴纸包'}”…`;
      try {
        details = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/sticker-set?setId=${encodeURIComponent(pack.id)}&accessHash=${encodeURIComponent(pack.accessHash)}`);
        if (!valid(ctx) || selectedStickerPack !== pack) return;
        if (!details || !Array.isArray(details.stickers)) throw new Error('贴纸包数据无效');
        stickerCache.details.set(key, details);
      } catch (error) { if (valid(ctx)) stickerStatus.textContent = `贴纸包加载失败：${error.message}`; return; }
    }
    if (!valid(ctx) || selectedStickerPack !== pack) return;
    stickerStatus.textContent = '';
    for (const sticker of details.stickers) {
      if (!sticker?.id || !sticker.accessHash) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'forum-sticker'; button.title = sticker.emoji || '发送贴纸';
      const image = document.createElement('img'); image.alt = sticker.emoji || '贴纸'; image.loading = 'lazy';
      image.src = sticker.thumbDataUri || `/api/instances/${encodeURIComponent(ctx.instId)}/account/sticker-thumb?docId=${encodeURIComponent(sticker.id)}&accessHash=${encodeURIComponent(sticker.accessHash)}&fileRef=${encodeURIComponent(sticker.fileReference || '')}`;
      button.appendChild(image); button.onclick = () => void sendForumSticker(sticker); stickerGrid.appendChild(button);
    }
    if (!stickerGrid.childElementCount) stickerStatus.textContent = '此贴纸包没有可发送的贴纸。';
  }
  async function sendForumSticker(sticker) {
    const ctx = context, topic = ctx?.topic, reply = replyTo;
    if (!valid(ctx) || !topic || sending || !sticker?.id || !sticker.accessHash) return;
    sending = true; send.disabled = true; if (attachButton) attachButton.disabled = true; if (stickerButton) stickerButton.disabled = true; stickerStatus.textContent = '正在发送贴纸…';
    try {
      await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/send-sticker`, 'POST', {
        chatId: ctx.chatId, topicId: topic.id, replyTo: reply || topic.id,
        docId: sticker.id, accessHash: sticker.accessHash, fileReference: sticker.fileReference || '',
      });
      if (!valid(ctx) || ctx.topic !== topic) return;
      stickerPanel.hidden = true; stickerStatus.textContent = '';
      if (replyTo === reply) { replyTo = null; replyLabel.hidden = true; }
      busy = false; await loadMessages(false);
    } catch (error) { if (valid(ctx) && ctx.topic === topic) stickerStatus.textContent = `贴纸发送失败：${error.message}`; }
    finally { if (valid(ctx) && ctx.topic === topic) { sending = false; send.disabled = false; if (attachButton) attachButton.disabled = false; if (stickerButton) stickerButton.disabled = false; } }
  }
  async function loadSavedGifs() {
    const ctx = context;
    if (!valid(ctx)) return;
    if (gifCache.instId !== ctx.instId) gifCache = { instId: ctx.instId, gifs: null };
    if (gifCache.gifs) { renderSavedGifs(gifCache.gifs, ctx); return; }
    gifStatus.textContent = '正在加载已保存的 GIF…';
    try {
      const gifs = await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/gifs`);
      if (!valid(ctx)) return;
      gifCache.gifs = Array.isArray(gifs) ? gifs : [];
      renderSavedGifs(gifCache.gifs, ctx);
    } catch (error) { if (valid(ctx)) gifStatus.textContent = `无法加载 GIF：${error.message}`; }
  }
  function renderSavedGifs(gifs, ctx) {
    if (!valid(ctx) || !gifGrid) return;
    gifGrid.replaceChildren();
    if (!gifs.length) { gifStatus.textContent = '当前账号没有已保存的 GIF。'; return; }
    gifStatus.textContent = '';
    gifs.forEach((gif, index) => {
      if (!gif?.id || !gif.accessHash) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'forum-gif'; button.title = '发送此 GIF';
      const video = document.createElement('video'); video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'none';
      const params = new URLSearchParams({ docId: String(gif.id), accessHash: String(gif.accessHash), fileReference: String(gif.fileReference || ''), mimeType: gif.mimeType || 'video/mp4' });
      video.src = `/api/instances/${encodeURIComponent(ctx.instId)}/account/gif-preview?${params}`;
      button.appendChild(video);
      const label = document.createElement('span'); label.textContent = `GIF ${index + 1}`; button.appendChild(label);
      button.onmouseenter = () => { if (valid(ctx)) void video.play().catch(() => {}); };
      button.onmouseleave = () => video.pause();
      button.onclick = () => void sendForumGif(gif);
      gifGrid.appendChild(button);
    });
  }
  async function sendForumGif(gif) {
    const ctx = context, topic = ctx?.topic, reply = replyTo;
    if (!valid(ctx) || !topic || sending || !gif?.id || !gif.accessHash) return;
    sending = true; send.disabled = true; if (attachButton) attachButton.disabled = true; if (gifButton) gifButton.disabled = true; gifStatus.textContent = '正在发送 GIF…';
    try {
      await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/send-gif`, 'POST', {
        chatId: ctx.chatId, topicId: topic.id, replyTo: reply || topic.id,
        docId: gif.id, accessHash: gif.accessHash, fileReference: gif.fileReference || '',
      });
      if (!valid(ctx) || ctx.topic !== topic) return;
      gifPanel.hidden = true; gifStatus.textContent = '';
      if (replyTo === reply) { replyTo = null; replyLabel.hidden = true; }
      busy = false; await loadMessages(false);
    } catch (error) { if (valid(ctx) && ctx.topic === topic) gifStatus.textContent = `GIF 发送失败：${error.message}`; }
    finally { if (valid(ctx) && ctx.topic === topic) { sending = false; send.disabled = false; if (attachButton) attachButton.disabled = false; if (gifButton) gifButton.disabled = false; } }
  }
  function topicActionButton(label, action, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-secondary btn-sm forum-topic-action${danger ? ' btn-danger' : ''}`;
    button.textContent = label;
    button.onclick = event => { event.stopPropagation(); action(); };
    return button;
  }
  async function createTopic() {
    if (!valid() || mutating) return;
    const title = window.prompt('输入新话题名称（最多 128 个字符）');
    if (title == null) return;
    if (!title.trim() || title.trim().length > 128) { status.textContent = '话题名称不能为空且不能超过 128 个字符。'; return; }
    await mutateTopic(null, { action: 'create', title: title.trim() });
  }
  async function editTopicTitle(topic) {
    if (!valid() || mutating) return;
    const title = window.prompt('修改话题名称（最多 128 个字符）', topic.title || '');
    if (title == null || title.trim() === (topic.title || '')) return;
    if (!title.trim() || title.trim().length > 128) { status.textContent = '话题名称不能为空且不能超过 128 个字符。'; return; }
    await mutateTopic(topic, { action: 'edit', title: title.trim() });
  }
  async function deleteTopic(topic) {
    if (!valid() || mutating || topic.id === 1) return;
    if (!window.confirm(`删除话题“${topic.title || '话题'}”及其消息？此操作无法撤销。`)) return;
    await mutateTopic(topic, { action: 'delete' });
  }
  async function mutateTopic(topic, action) {
    const ctx = context;
    if (!valid(ctx) || ctx.topic || mutating) return;
    mutating = true; status.textContent = '正在更新话题…';
    try {
      await api(`/api/instances/${encodeURIComponent(ctx.instId)}/account/forum-topics`, 'POST', {
        chatId: ctx.chatId, topicId: topic?.id, ...action,
      });
      if (!valid(ctx) || ctx.topic) return;
      await loadTopics(false);
      if (valid(ctx) && !ctx.topic) status.textContent = '话题已更新。';
    } catch (error) {
      if (valid(ctx) && !ctx.topic) status.textContent = `话题操作失败：${error.message}`;
    } finally { mutating = false; }
  }
  function refreshButton() {
    const button = document.getElementById('btn-chat-topics');
    if (!button) return;
    const dialog = currentDialog();
    button.hidden = !dialog?.isForum;
    if (context && !valid()) close();
  }
  function currentDialog() {
    if (selectedDialog && selectedDialog.instId === state.clientSelectedInstance &&
        String(selectedDialog.dialog.id) === String(state.clientActiveChatId) &&
        selectedDialog.version === state.chatSelectionVersion) return selectedDialog.dialog;
    return (state.clientDialogs || []).find(d => String(d.id) === String(state.clientActiveChatId));
  }
  function setDialog(dialog) {
    close();
    selectedDialog = dialog ? { dialog, instId: state.clientSelectedInstance, version: state.chatSelectionVersion } : null;
    if (!dialog) {
      const button = document.getElementById('btn-chat-topics');
      if (button) button.hidden = true;
      return;
    }
    refreshButton();
  }
  function isCurrentForum() { return Boolean(currentDialog()?.isForum); }
  function refreshTopics() {
    if (valid() && !context.topic) showTopics();
  }
  function refreshCurrentTopic() {
    if (!valid() || !context.topic || busy) return;
    messageOffset = null; messageIds = new Set();
    void loadMessages(false);
  }
  function setup() {
    document.getElementById('btn-chat-topics')?.addEventListener('click', open);
    document.getElementById('client-account-select')?.addEventListener('change', () => { close(); queueMicrotask(refreshButton); });
    const chatTitle = document.getElementById('client-chat-title');
    if (chatTitle) new MutationObserver(refreshButton).observe(chatTitle, { subtree: true, childList: true, characterData: true });
    refreshButton();
  }
  // Keep reply selection explicit and easy to cancel without exposing markup.
  document.addEventListener('click', event => { if (event.target === replyLabel) { replyTo = null; replyLabel.hidden = true; } });
  window.addEventListener('load', setup);
  return { open, close, refreshButton, refreshTopics, refreshCurrentTopic, setDialog, isCurrentForum, handleMessage };
})();

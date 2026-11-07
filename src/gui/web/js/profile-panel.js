/**
 * Profile Panel — Right-side user/chat profile panel.
 */
(function () {
  'use strict';

  let isOpen = false;

  function init() {
    // Wire toggle button
    const toggleBtn = document.getElementById('btn-chat-drawer-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = () => toggle();
    }
  }

  function toggle() {
    const pane = document.querySelector('.client-profile-pane');
    if (!pane) return;
    isOpen = !isOpen;
    pane.classList.toggle('open', isOpen);

    if (isOpen) {
      loadProfile();
    }
  }

  async function loadProfile() {
    const pane = document.querySelector('.client-profile-pane');
    if (!pane) return;

    const chatId = state.clientActiveChatId;
    const instId = state.clientSelectedInstance;
    if (!chatId || !instId) {
      pane.innerHTML = '<div class="profile-pane-empty">请先选择一个会话</div>';
      return;
    }

    pane.innerHTML = '<div class="profile-pane-empty">加载中...</div>';

    try {
      const res = await api(`/api/instances/${instId}/account/peer-profile?chatId=${chatId}`);
      const p = res.profile || res;
      const avatarUrl = `/api/instances/${encodeURIComponent(instId)}/account/avatar?chatId=${encodeURIComponent(chatId)}`;

      pane.innerHTML = `
        <div class="profile-pane-header">
          <button class="btn-icon-subtle" onclick="window.ProfilePanel.close()" title="关闭">
            <svg class="ui-icon-sm"><use href="#icon-close"/></svg>
          </button>
        </div>
        <div class="profile-pane-avatar">
          <img data-network-src="${escapeHtml(avatarUrl)}" alt="" onerror="this.style.display='none'">
        </div>
        <div class="profile-pane-name">${escapeHtml(p.firstName || p.title || '未知')}</div>
        <div class="profile-pane-username">${p.username ? '@' + escapeHtml(p.username) : ''}</div>
        <div class="profile-pane-id">ID: ${escapeHtml(p.id || chatId)}</div>
        ${p.bio || p.about ? `<div class="profile-pane-bio">${escapeHtml(p.bio || p.about)}</div>` : ''}
        <div class="profile-pane-tabs">
          <button class="profile-tab active">媒体</button>
          <button class="profile-tab">文件</button>
          <button class="profile-tab">链接</button>
        </div>
        <div class="profile-pane-media" id="profile-media-grid">
          <div class="profile-pane-empty">加载共享媒体...</div>
        </div>
      `;

      // Load shared media
      loadSharedMedia(instId, chatId);
    } catch (err) {
      pane.innerHTML = `<div class="profile-pane-empty">加载失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadSharedMedia(instId, chatId) {
    try {
      const res = await api(`/api/instances/${instId}/account/chat-media?chatId=${chatId}&type=photos&limit=30`);
      const grid = document.getElementById('profile-media-grid');
      if (!grid) return;

      const media = res.messages || res || [];
      if (media.length === 0) {
        grid.innerHTML = '<div class="profile-pane-empty">暂无共享媒体</div>';
        return;
      }

      grid.innerHTML = media.map((m) => {
        const url = `/api/instances/${encodeURIComponent(instId)}/account/media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(m.id)}&thumb=1`;
        return `<div class="profile-media-item"><img data-network-src="${escapeHtml(url)}" loading="lazy" alt=""></div>`;
      }).join('');
    } catch (_) {
      const grid = document.getElementById('profile-media-grid');
      if (grid) grid.innerHTML = '<div class="profile-pane-empty">暂无共享媒体</div>';
    }
  }

  function close() {
    const pane = document.querySelector('.client-profile-pane');
    if (pane) pane.classList.remove('open');
    isOpen = false;
  }

  // Expose
  window.ProfilePanel = { init, toggle, close, loadProfile };
})();

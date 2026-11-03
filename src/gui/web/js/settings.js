/**
 * Settings Page — Multi-section settings panel with theme toggle.
 */
(function () {
  'use strict';

  function init() {
    renderSettingsView();
    bindEvents();
  }

  function renderSettingsView() {
    const container = document.getElementById('view-settings');
    if (!container) return;

    const currentTheme = window.ThemeManager ? window.ThemeManager.getStored() : 'dark';

    container.innerHTML = `
      <div class="settings-layout">
        <div class="settings-nav">
          <button class="settings-nav-item active" data-section="appearance">外观</button>
          <button class="settings-nav-item" data-section="chat">聊天与媒体</button>
          <button class="settings-nav-item" data-section="notifications">通知</button>
          <button class="settings-nav-item" data-section="privacy">隐私</button>
          <button class="settings-nav-item" data-section="cache">缓存</button>
        </div>
        <div class="settings-content">
          <!-- Appearance -->
          <div class="settings-section active" id="settings-appearance">
            <h3>外观设置</h3>
            <div class="settings-field">
              <label class="settings-label">主题模式</label>
              <div class="settings-theme-options">
                <label class="theme-option ${currentTheme === 'light' ? 'active' : ''}">
                  <input type="radio" name="theme" value="light" ${currentTheme === 'light' ? 'checked' : ''}>
                  <div class="theme-preview light-preview">
                    <div class="tp-sidebar"></div>
                    <div class="tp-chat"></div>
                  </div>
                  <span>浅色</span>
                </label>
                <label class="theme-option ${currentTheme === 'dark' ? 'active' : ''}">
                  <input type="radio" name="theme" value="dark" ${currentTheme === 'dark' ? 'checked' : ''}>
                  <div class="theme-preview dark-preview">
                    <div class="tp-sidebar"></div>
                    <div class="tp-chat"></div>
                  </div>
                  <span>暗色</span>
                </label>
                <label class="theme-option ${currentTheme === 'system' ? 'active' : ''}">
                  <input type="radio" name="theme" value="system" ${currentTheme === 'system' ? 'checked' : ''}>
                  <div class="theme-preview system-preview">
                    <div class="tp-sidebar"></div>
                    <div class="tp-chat"></div>
                  </div>
                  <span>跟随系统</span>
                </label>
              </div>
            </div>
            <div class="settings-field">
              <label class="settings-label">聊天壁纸</label>
              <div class="settings-wallpaper-row">
                <button class="wallpaper-btn" data-theme="obsidian">经典</button>
                <button class="wallpaper-btn" data-theme="doodle">涂鸦</button>
                <button class="wallpaper-btn" data-theme="neon">霓虹</button>
                <button class="wallpaper-btn" data-theme="aurora">极光</button>
              </div>
            </div>
          </div>

          <!-- Chat -->
          <div class="settings-section" id="settings-chat">
            <h3>聊天与媒体</h3>
            <div class="settings-field">
              <label class="settings-label">发送快捷键</label>
              <select class="form-select" id="setting-send-mode">
                <option value="enter">Enter 发送</option>
                <option value="ctrl-enter">Ctrl+Enter 发送</option>
              </select>
            </div>
            <div class="settings-field">
              <label class="settings-label">默认解析模式</label>
              <select class="form-select" id="setting-parse-mode">
                <option value="none">纯文本</option>
                <option value="html">HTML</option>
                <option value="markdown">Markdown</option>
              </select>
            </div>
            <div class="settings-field">
              <label class="settings-label">静默发送</label>
              <label class="pcf-switch">
                <input type="checkbox" id="setting-silent">
                <span class="pcf-switch-slider"></span>
                <span class="pcf-switch-label">默认静默发送（不通知对方）</span>
              </label>
            </div>
          </div>

          <!-- Notifications -->
          <div class="settings-section" id="settings-notifications">
            <h3>通知与声音</h3>
            <div class="settings-field">
              <label class="settings-label">通知偏好</label>
              <p class="settings-desc">账号级通知设置请在 Telegram 官方客户端修改。此处控制 Web 控制台的提示行为。</p>
            </div>
            <div class="settings-field">
              <label class="settings-label">Toast 提示</label>
              <label class="pcf-switch">
                <input type="checkbox" id="setting-toast" checked>
                <span class="pcf-switch-slider"></span>
                <span class="pcf-switch-label">显示操作结果提示</span>
              </label>
            </div>
          </div>

          <!-- Privacy -->
          <div class="settings-section" id="settings-privacy">
            <h3>隐私与安全</h3>
            <div class="settings-field">
              <label class="settings-label">账号隐私</label>
              <p class="settings-desc">Telegram 账号的隐私设置（在线状态可见性、手机号可见性等）请在官方客户端中修改。</p>
            </div>
            <div class="settings-field">
              <label class="settings-label">Web 控制台访问</label>
              <p class="settings-desc">默认仅监听 127.0.0.1。如需局域网访问请设置 GUI_ALLOW_LAN=true。</p>
            </div>
          </div>

          <!-- Cache -->
          <div class="settings-section" id="settings-cache">
            <h3>缓存管理</h3>
            <div class="settings-field" id="cache-stats-container">
              <p class="settings-desc">加载中...</p>
            </div>
            <div class="settings-field">
              <button class="btn btn-secondary" id="btn-settings-clear-cache">清理缓存</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    const container = document.getElementById('view-settings');
    if (!container) return;

    // Nav
    container.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.onclick = () => {
        container.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        container.querySelectorAll('.settings-section').forEach((s) => s.classList.remove('active'));
        const section = container.querySelector(`#settings-${btn.dataset.section}`);
        if (section) section.classList.add('active');
      };
    });

    // Theme switching
    container.querySelectorAll('input[name="theme"]').forEach((radio) => {
      radio.onchange = () => {
        if (window.ThemeManager) window.ThemeManager.set(radio.value);
        container.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('active'));
        radio.closest('.theme-option').classList.add('active');
      };
    });

    // Wallpaper buttons
    container.querySelectorAll('.wallpaper-btn').forEach((btn) => {
      btn.onclick = () => {
        const theme = btn.dataset.theme;
        document.body.className = document.body.className.replace(/theme-\w+/g, '').trim();
        document.body.classList.add(`theme-${theme}`);
        container.querySelectorAll('.wallpaper-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('tgbot_chat_wallpaper', theme);
      };
    });

    // Send mode / parse mode / silent
    const sendMode = container.querySelector('#setting-send-mode');
    const parseMode = container.querySelector('#setting-parse-mode');
    const silent = container.querySelector('#setting-silent');

    if (sendMode) {
      sendMode.value = localStorage.getItem('tgbot_chat_send_mode') || 'ctrl-enter';
      sendMode.onchange = () => localStorage.setItem('tgbot_chat_send_mode', sendMode.value);
    }
    if (parseMode) {
      parseMode.value = localStorage.getItem('tgbot_chat_parse_mode') || 'none';
      parseMode.onchange = () => localStorage.setItem('tgbot_chat_parse_mode', parseMode.value);
    }
    if (silent) {
      silent.checked = localStorage.getItem('tgbot_chat_silent') === 'true';
      silent.onchange = () => localStorage.setItem('tgbot_chat_silent', silent.checked);
    }

    // Clear cache
    const clearBtn = container.querySelector('#btn-settings-clear-cache');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        try {
          await fetch('/api/cache/clear', { method: 'POST' });
          if (window.showToast) showToast('缓存已清理', 'success');
        } catch (err) {
          if (window.showToast) showToast(`清理失败: ${err.message}`, 'error');
        }
      };
    }
  }

  // Expose
  window.SettingsPage = { init };
})();

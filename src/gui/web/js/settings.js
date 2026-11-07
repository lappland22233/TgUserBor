/**
 * Settings Page — Multi-section settings panel with theme toggle.
 */
(function () {
  'use strict';

  let authorizationRequest = 0;
  let loadedAuthorizationInstance = null;
  let privacyRequest = 0;
  let loadedPrivacyInstance = null;
  let globalPrivacyRequest = 0;
  let loadedGlobalPrivacyInstance = null;
  let notificationRequest = 0;
  let loadedNotificationInstance = null;
  let notificationExceptionRequest = 0;
  let starsRequest = 0;
  let loadedStarsInstance = null;
  let starsNextOffset = '';
  let starsTopupRequest = 0;
  let loadedStarsTopupInstance = null;
  let starsSubscriptionsRequest = 0;
  let loadedStarsSubscriptionsInstance = null;
  let starsSubscriptionsNextOffset = '';
  let starGiftsRequest = 0;
  let loadedStarGiftsInstance = null;
  let savedStarGiftsRequest = 0;
  let loadedSavedStarGiftsInstance = null;
  let savedStarGiftsNextOffset = '';
  let giftCodePreviewRequest = 0;
  let giftCodePreview = null;
  let telegramAppThemesRequest = 0;
  let loadedTelegramAppThemesInstance = null;
  let telegramAppThemes = [];
  let businessSettingsRequest = 0;
  let loadedBusinessSettingsInstance = null;
  let defaultHistoryTtlRequest = 0;
  let loadedDefaultHistoryTtlInstance = null;
  let existingHistoryTtlRequest = 0;
  let existingHistoryTtlSearchRequest = 0;
  let existingHistoryTtlPickerState = null;
  const defaultHistoryTtlOptions = [0, 86400, 172800, 259200, 345600, 432000, 518400, 604800, 1209600,
    1814400, 2592000, 5184000, 7776000, 10368000, 12960000, 15552000, 31536000];

  function init() {
    renderSettingsView();
    bindEvents();
    const container = document.getElementById('view-settings');
    if (container) {
      new MutationObserver(() => {
        if (container.classList.contains('active')) refreshSettings(container);
      }).observe(container, { attributes: true, attributeFilter: ['class'] });
    }
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
          <button class="settings-nav-item" data-section="account">Telegram 账号</button>
          <button class="settings-nav-item" data-section="notifications">通知</button>
          <button class="settings-nav-item" data-section="privacy">隐私</button>
          <button class="settings-nav-item" data-section="cache">缓存</button>
        </div>
        <div class="settings-content">
          <div class="settings-search-wrap">
            <input type="search" class="form-input settings-search-input" id="setting-search" placeholder="搜索设置" aria-label="搜索设置" autocomplete="off">
            <div class="settings-search-results" id="settings-search-results" role="listbox" aria-label="设置搜索结果" aria-live="polite" hidden></div>
          </div>
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
              <label class="settings-label">Telegram 主题</label>
              <p class="settings-desc">从当前账号读取 Telegram 主题目录并安装主题。网页以基础明暗和强调色预览；完整主题资源仍由 Telegram 客户端渲染。</p>
              <div class="settings-session-actions"><button class="btn btn-secondary btn-sm" id="btn-refresh-telegram-themes" type="button">刷新主题</button></div>
              <div id="setting-telegram-themes-status" class="settings-desc" role="status">请选择一个已登录账号。</div>
              <div id="setting-telegram-themes-list" class="settings-telegram-themes-list"></div>
            </div>
            <div class="settings-field">
              <label class="settings-label">本机聊天风格</label>
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
                <option value="ctrlEnter">Ctrl+Enter 发送</option>
              </select>
            </div>
            <div class="settings-field">
              <label class="settings-label">默认解析模式</label>
              <select class="form-select" id="setting-parse-mode">
                <option value="plain">纯文本</option>
                <option value="html">HTML</option>
                <option value="markdown">Markdown</option>
              </select>
            </div>
            <div class="settings-field">
              <label class="settings-label" for="setting-translation-language">消息翻译目标语言</label>
              <select class="form-select" id="setting-translation-language">
                <option value="zh-hans">简体中文</option>
                <option value="zh-hant">繁体中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="ru">Русский</option>
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

          <!-- Telegram account -->
          <div class="settings-section" id="settings-account">
            <h3>Telegram 账号</h3>
            <div class="settings-field">
              <label class="settings-label">Telegram Business</label>
              <p class="settings-desc">查看并编辑 Telegram Business 营业时间、位置、自动回复和简介，也可创建或删除聊天链接。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-business-settings" type="button">刷新 Business 信息</button>
                <button class="btn btn-secondary btn-sm" id="btn-edit-business-work-hours" type="button" hidden>编辑营业时间</button>
                <button class="btn btn-secondary btn-sm" id="btn-edit-business-location" type="button" hidden>编辑 Business 位置</button>
                <button class="btn btn-secondary btn-sm" id="btn-edit-business-intro" type="button" hidden>编辑 Business 简介</button>
                <button class="btn btn-secondary btn-sm" id="btn-add-business-chat-link" type="button" hidden>创建聊天链接</button>
                <button class="btn btn-secondary btn-sm" id="btn-edit-business-greeting" type="button" hidden>编辑欢迎消息</button>
                <button class="btn btn-secondary btn-sm" id="btn-edit-business-away" type="button" hidden>编辑离开消息</button>
              </div>
              <div class="settings-desc" id="setting-business-status" role="status" aria-live="polite">请选择一个已登录账号。</div>
              <div class="settings-business-editor" id="setting-business-work-hours-editor" hidden>
                <label class="settings-label" for="setting-business-timezone">时区</label>
                <input class="form-input" id="setting-business-timezone" type="text" maxlength="128" autocomplete="off" placeholder="Europe/Helsinki">
                <div class="settings-desc">每段时间使用周一至周日的起止日期和 24 小时时间。跨日时选择下一天；周日结束于午夜时选择“下周一”。</div>
                <div class="settings-business-intervals" id="setting-business-intervals"></div>
                <div class="settings-session-actions">
                  <button class="btn btn-secondary btn-sm" id="btn-add-business-interval" type="button">添加时间段</button>
                  <button class="btn btn-primary btn-sm" id="btn-save-business-work-hours" type="button">保存营业时间</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-work-hours" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-work-hours-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-editor" id="setting-business-location-editor" hidden>
                <label class="settings-label" for="setting-business-location-address">地址</label>
                <input class="form-input" id="setting-business-location-address" type="text" maxlength="512" autocomplete="off">
                <div class="settings-business-coordinate-fields">
                  <div><label class="settings-label" for="setting-business-location-latitude">纬度</label><input class="form-input" id="setting-business-location-latitude" type="number" min="-90" max="90" step="any"></div>
                  <div><label class="settings-label" for="setting-business-location-longitude">经度</label><input class="form-input" id="setting-business-location-longitude" type="number" min="-180" max="180" step="any"></div>
                </div>
                <div class="settings-desc">经纬度可以留空；填写时必须同时填写。清空地址和坐标后保存会移除 Business 位置。</div>
                <div class="settings-session-actions">
                  <button class="btn btn-primary btn-sm" id="btn-save-business-location" type="button">保存位置</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-location" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-location-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-editor" id="setting-business-intro-editor" hidden>
                <label class="settings-label" for="setting-business-intro-title">标题</label>
                <input class="form-input" id="setting-business-intro-title" type="text" maxlength="256">
                <label class="settings-label" for="setting-business-intro-description">简介</label>
                <textarea class="form-input" id="setting-business-intro-description" rows="4" maxlength="4096"></textarea>
                <div class="settings-desc">保存文字时会保留 Telegram 上已有的 Business 贴纸。清除操作会移除整段简介和贴纸。</div>
                <div class="settings-session-actions">
                  <button class="btn btn-primary btn-sm" id="btn-save-business-intro" type="button">保存简介</button>
                  <button class="btn btn-secondary btn-sm" id="btn-clear-business-intro" type="button">清除简介</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-intro" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-intro-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-editor" id="setting-business-chat-link-editor" hidden>
                <label class="settings-label" for="setting-business-chat-link-title">链接名称</label>
                <input class="form-input" id="setting-business-chat-link-title" type="text" maxlength="128">
                <label class="settings-label" for="setting-business-chat-link-message">预填消息</label>
                <textarea class="form-input" id="setting-business-chat-link-message" rows="3" maxlength="2048"></textarea>
                <div class="settings-desc" id="setting-business-chat-link-formatting">修改预填消息时，Telegram 会使用纯文本格式。</div>
                <div class="settings-session-actions">
                  <button class="btn btn-primary btn-sm" id="btn-save-business-chat-link" type="button">创建链接</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-chat-link" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-chat-link-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-editor" id="setting-business-greeting-editor" hidden>
                <label class="settings-label" for="setting-business-greeting-shortcut">快捷回复模板</label>
                <select class="form-select" id="setting-business-greeting-shortcut"></select>
                <label class="settings-label" for="setting-business-greeting-days">无活动天数</label>
                <input class="form-input" id="setting-business-greeting-days" type="number" min="0" max="365" step="1">
                <div class="settings-desc" id="setting-business-greeting-preserved-users"></div>
                <div class="settings-business-recipients" id="setting-business-greeting-recipients"></div>
                <div class="settings-session-actions">
                  <button class="btn btn-primary btn-sm" id="btn-save-business-greeting" type="button">保存欢迎消息</button>
                  <button class="btn btn-secondary btn-sm" id="btn-clear-business-greeting" type="button">停用</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-greeting" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-greeting-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-editor" id="setting-business-away-editor" hidden>
                <label class="settings-label" for="setting-business-away-shortcut">快捷回复模板</label>
                <select class="form-select" id="setting-business-away-shortcut"></select>
                <label class="settings-label" for="setting-business-away-schedule">发送时间</label>
                <select class="form-select" id="setting-business-away-schedule">
                  <option value="always">始终发送</option>
                  <option value="outside_work_hours">非工作时间</option>
                  <option value="custom">自定义时段</option>
                </select>
                <div class="settings-business-coordinate-fields" id="setting-business-away-custom-dates" hidden>
                  <div><label class="settings-label" for="setting-business-away-start">开始</label><input class="form-input" id="setting-business-away-start" type="datetime-local"></div>
                  <div><label class="settings-label" for="setting-business-away-end">结束</label><input class="form-input" id="setting-business-away-end" type="datetime-local"></div>
                </div>
                <label class="pcf-switch"><input type="checkbox" id="setting-business-away-offline-only"><span class="pcf-switch-slider"></span><span class="pcf-switch-label">仅在离线时发送</span></label>
                <div class="settings-desc" id="setting-business-away-preserved-users"></div>
                <div class="settings-business-recipients" id="setting-business-away-recipients"></div>
                <div class="settings-session-actions">
                  <button class="btn btn-primary btn-sm" id="btn-save-business-away" type="button">保存离开消息</button>
                  <button class="btn btn-secondary btn-sm" id="btn-clear-business-away" type="button">停用</button>
                  <button class="btn btn-secondary btn-sm" id="btn-cancel-business-away" type="button">取消</button>
                </div>
                <div class="settings-desc" id="setting-business-away-status" role="status" aria-live="polite"></div>
              </div>
              <div class="settings-business-list" id="setting-business-list"></div>
            </div>
            <div class="settings-field">
              <label class="settings-label">Telegram Stars</label>
              <p class="settings-desc">查看余额和交易记录，或使用 Telegram 返回的当前可用套餐购买 Stars。付款前会显示最终方案并再次确认。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-stars" type="button">刷新 Stars</button>
              </div>
              <div class="settings-desc" id="setting-stars-status" role="status">请选择一个已登录账号。</div>
              <strong id="setting-stars-balance">—</strong>
              <div class="settings-desc" id="setting-stars-topup-status" role="status"></div>
              <div id="setting-stars-topup-options" class="settings-stars-topup-options"></div>
              <a id="setting-stars-topup-verification" class="btn btn-secondary btn-sm" href="#" target="_blank" rel="noopener noreferrer" hidden>继续 Telegram 付款验证</a>
              <div id="setting-stars-history" class="settings-stars-history"></div>
              <button class="btn btn-secondary btn-sm" id="btn-more-stars" type="button" hidden>加载更多记录</button>
            </div>
            <div class="settings-field">
              <label class="settings-label">Stars 订阅</label>
              <p class="settings-desc">查看和管理当前账号通过 Stars 开通的订阅。取消或恢复续订前会再次确认。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-stars-subscriptions" type="button">刷新订阅</button>
              </div>
              <div class="settings-desc" id="setting-stars-subscriptions-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-stars-subscriptions-list" class="settings-stars-subscriptions"></div>
              <button class="btn btn-secondary btn-sm" id="btn-more-stars-subscriptions" type="button" hidden>加载更多订阅</button>
            </div>
            <div class="settings-field">
              <label class="settings-label" for="setting-gift-code-input">Telegram Premium 礼物链接</label>
              <p class="settings-desc">粘贴 Telegram 礼物链接或代码。先检查收件对象和有效状态，再由你确认是否激活。</p>
              <div class="settings-session-actions">
                <input class="form-input" id="setting-gift-code-input" type="text" maxlength="512" autocomplete="off" placeholder="https://t.me/giftcode/…">
                <button class="btn btn-secondary btn-sm" id="btn-check-gift-code" type="button">检查链接</button>
                <button class="btn btn-primary btn-sm" id="btn-apply-gift-code" type="button" hidden>激活 Premium</button>
              </div>
              <div class="settings-desc" id="setting-gift-code-status" role="status" aria-live="polite">选择已登录账号后可检查礼物链接。</div>
            </div>
            <div class="settings-field">
              <label class="settings-label">Telegram 礼物目录</label>
              <p class="settings-desc">浏览可用礼物；选择私聊后可赠送。扣除 Stars 前会显示收件人、金额和不可撤回提示。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-star-gifts" type="button">刷新礼物目录</button>
              </div>
              <div class="settings-desc" id="setting-star-gifts-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-star-gifts-list" class="settings-star-gifts"></div>
            </div>
            <div class="settings-field">
              <label class="settings-label">已收到的 Telegram 礼物</label>
              <p class="settings-desc">管理个人资料中显示的礼物，或将支持转换的普通礼物兑换为 Stars。兑换不可撤回，需再次确认。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-saved-star-gifts" type="button">刷新已收到礼物</button>
              </div>
              <div class="settings-desc" id="setting-saved-star-gifts-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-saved-star-gifts-list" class="settings-saved-star-gifts"></div>
              <button class="btn btn-secondary btn-sm" id="btn-more-saved-star-gifts" type="button" hidden>加载更多礼物</button>
            </div>
          </div>

          <!-- Notifications -->
          <div class="settings-section" id="settings-notifications">
            <h3>通知与声音</h3>
            <div class="settings-field">
              <label class="settings-label">通知偏好</label>
              <p class="settings-desc">在聊天页面打开时接收当前账号的浏览器通知；需要浏览器授权，静音会话不会通知。</p>
              <label class="pcf-switch">
                <input type="checkbox" id="setting-desktop-notifications">
                <span class="pcf-switch-slider"></span>
                <span class="pcf-switch-label">浏览器通知</span>
              </label>
              <p class="settings-desc" id="setting-desktop-notifications-status"></p>
            </div>
            <div class="settings-field">
              <label class="settings-label">Telegram 默认通知规则</label>
              <p class="settings-desc">私聊、群组和频道分别由 Telegram 同步通知设置；这里的静音、消息预览和静默选项不会更改单个会话的例外。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-telegram-notifications" type="button">刷新 Telegram 通知</button>
              </div>
              <p class="settings-desc">可上传 5 MiB 以内的音频到当前 Telegram 账号，并试听或删除账号已保存的提示音。</p>
              <div class="settings-notification-sound-tools" id="setting-notification-sounds-tools"></div>
              <div class="settings-desc" id="setting-telegram-notifications-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-telegram-notifications-list" class="settings-account-privacy-list"></div>
            </div>
          </div>

          <!-- Privacy -->
          <div class="settings-section" id="settings-privacy">
            <h3>隐私与安全</h3>
            <div class="settings-field">
              <label class="settings-label">账号隐私</label>
              <p class="settings-desc">调整账号隐私可见范围，并管理用户、群组成员和 Telegram 特殊规则；可从联系人或 Telegram 搜索结果添加例外。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-account-privacy" type="button">刷新隐私设置</button>
              </div>
              <div class="settings-desc" id="setting-account-privacy-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-account-privacy-list" class="settings-account-privacy-list"></div>
            </div>
            <div class="settings-field">
              <label class="settings-label" for="setting-default-history-ttl">新聊天自动删除</label>
              <p class="settings-desc">设置新聊天的默认消息计时器；也可把当前默认时长应用到你选择的既有聊天。</p>
              <select class="form-input" id="setting-default-history-ttl" disabled>
                <option value="0">关闭</option>
                <option value="86400">1 天</option><option value="172800">2 天</option>
                <option value="259200">3 天</option><option value="345600">4 天</option>
                <option value="432000">5 天</option><option value="518400">6 天</option>
                <option value="604800">1 周</option><option value="1209600">2 周</option><option value="1814400">3 周</option>
                <option value="2592000">1 个月</option><option value="5184000">2 个月</option>
                <option value="7776000">3 个月</option><option value="10368000">4 个月</option>
                <option value="12960000">5 个月</option><option value="15552000">6 个月</option>
                <option value="31536000">1 年</option>
              </select>
              <div class="settings-desc" id="setting-default-history-ttl-status" role="status">请选择一个已登录账号。</div>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-open-default-history-ttl-picker" type="button">应用到既有聊天</button>
              </div>
              <div class="settings-history-ttl-picker" id="setting-default-history-ttl-picker" hidden>
                <input class="form-input" id="setting-default-history-ttl-search" type="search" maxlength="128" placeholder="搜索会话或联系人" aria-label="搜索要应用计时器的会话">
                <div class="settings-desc" id="setting-default-history-ttl-picker-status" role="status"></div>
                <div class="settings-account-privacy-list" id="setting-default-history-ttl-chats"></div>
                <div class="settings-session-actions">
                  <button class="btn btn-secondary btn-sm" id="btn-more-default-history-ttl-chats" type="button" hidden>加载更多会话</button>
                  <button class="btn btn-primary btn-sm" id="btn-apply-default-history-ttl" type="button" disabled>应用到所选聊天</button>
                </div>
              </div>
            </div>
            <div class="settings-field">
              <label class="settings-label">Telegram 全局隐私选项</label>
              <p class="settings-desc">管理陌生人新会话、归档行为和已读标记等 Telegram 账号级设置。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-global-privacy" type="button">刷新全局隐私</button>
              </div>
              <div class="settings-desc" id="setting-global-privacy-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-global-privacy-list" class="settings-account-privacy-list"></div>
            </div>
            <div class="settings-field">
              <label class="settings-label">登录设备</label>
              <p class="settings-desc">查看此 Telegram 账号的登录设备，或终止不再使用的会话。当前设备不能从此处终止。</p>
              <div class="settings-session-actions">
                <button class="btn btn-secondary btn-sm" id="btn-refresh-authorizations" type="button">刷新设备</button>
                <button class="btn btn-danger btn-sm" id="btn-revoke-other-authorizations" type="button">终止其他所有会话</button>
              </div>
              <div class="settings-desc" id="setting-authorizations-status" role="status">请选择一个已登录账号。</div>
              <div id="setting-authorizations-list" class="settings-authorizations-list"></div>
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

    const activateSection = sectionId => {
      container.querySelectorAll('.settings-nav-item').forEach(button => {
        button.classList.toggle('active', button.dataset.section === sectionId);
      });
      container.querySelectorAll('.settings-section').forEach(section => {
        section.classList.toggle('active', section.id === `settings-${sectionId}`);
      });
    };

    const searchInput = container.querySelector('#setting-search');
    const searchResults = container.querySelector('#settings-search-results');
    if (searchInput && searchResults) {
      const searchSettings = () => {
        const query = String(searchInput.value || '').trim().toLocaleLowerCase();
        searchResults.replaceChildren();
        if (!query) { searchResults.hidden = true; return; }
        const seen = new Set();
        const matches = [];
        container.querySelectorAll('.settings-label, .settings-account-privacy-info strong').forEach(label => {
          const section = label.closest('.settings-section');
          if (!section) return;
          const field = label.closest('.settings-field') || label.closest('.settings-account-privacy-row') || label.closest('.settings-notification-category') || label;
          const heading = section.querySelector('h3')?.textContent || '';
          const text = `${heading} ${label.textContent || ''} ${field.textContent || ''}`.toLocaleLowerCase();
          const key = `${section.id}:${String(label.textContent || '').trim()}`;
          if (!text.includes(query) || seen.has(key)) return;
          seen.add(key);
          matches.push({ label: String(label.textContent || '').trim(), heading, section, target: field });
        });
        searchResults.hidden = false;
        if (!matches.length) {
          const empty = document.createElement('div');
          empty.className = 'settings-search-empty';
          empty.textContent = '没有匹配的设置';
          searchResults.appendChild(empty);
          return;
        }
        for (const match of matches.slice(0, 30)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'settings-search-result';
          button.setAttribute('role', 'option');
          button.textContent = `${match.heading} · ${match.label}`;
          button.onclick = () => {
            activateSection(match.section.id.replace(/^settings-/, ''));
            searchResults.hidden = true;
            match.target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          };
          searchResults.appendChild(button);
        }
      };
      searchInput.oninput = searchSettings;
      searchInput.onkeydown = event => {
        if (event.key === 'Escape') { searchInput.value = ''; searchSettings(); }
        else if (event.key === 'ArrowDown') searchResults.querySelector('button')?.focus();
      };
    }

    // Nav
    container.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.onclick = () => {
        activateSection(btn.dataset.section);
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
        if (typeof applyChatTheme === 'function') applyChatTheme(theme);
        container.querySelectorAll('.wallpaper-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });

    // Send mode / parse mode / silent
    const sendMode = container.querySelector('#setting-send-mode');
    const parseMode = container.querySelector('#setting-parse-mode');
    const translationLanguage = container.querySelector('#setting-translation-language');
    const silent = container.querySelector('#setting-silent');
    const desktopNotifications = container.querySelector('#setting-desktop-notifications');
    if (desktopNotifications) {
      desktopNotifications.checked = Boolean(window.ChatNotifications?.enabled());
      desktopNotifications.onchange = async () => {
        desktopNotifications.disabled = true;
        try {
          const requested = desktopNotifications.checked;
          const enabled = await window.ChatNotifications.setEnabled(requested);
          desktopNotifications.checked = enabled;
          const status = container.querySelector('#setting-desktop-notifications-status');
          if (status) status.textContent = requested && !enabled ? '浏览器未允许通知，请检查浏览器设置。' : '';
        } catch {
          desktopNotifications.checked = false;
        } finally {
          desktopNotifications.disabled = false;
        }
      };
    }

    if (sendMode) {
      sendMode.onchange = () => {
        state.chatSendKeyMode = sendMode.value;
        localStorage.setItem('tgbot_chat_send_mode', sendMode.value);
        updateChatMenuVisuals();
        updateChatSendHint();
      };
    }
    if (parseMode) {
      parseMode.onchange = () => {
        state.clientParseMode = parseMode.value;
        localStorage.setItem('tgbot_chat_parse_mode', parseMode.value);
        updateChatMenuVisuals();
      };
    }
    if (translationLanguage) {
      translationLanguage.onchange = () => {
        const allowed = ['zh-hans', 'zh-hant', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];
        state.clientTranslationLanguage = allowed.includes(translationLanguage.value) ? translationLanguage.value : 'zh-hans';
        localStorage.setItem('tgbot_translation_language', state.clientTranslationLanguage);
        window.ChatTranslation?.refreshLanguage?.();
      };
    }
    if (silent) {
      silent.onchange = () => {
        state.clientSilent = silent.checked;
        localStorage.setItem('tgbot_chat_silent', String(silent.checked));
        updateChatMenuVisuals();
      };
    }

    // Migrate values written by older versions of this settings panel.
    if (state.chatSendKeyMode === 'ctrl-enter') state.chatSendKeyMode = 'ctrlEnter';
    if (state.clientParseMode === 'none') state.clientParseMode = 'plain';
    localStorage.setItem('tgbot_chat_send_mode', state.chatSendKeyMode);
    localStorage.setItem('tgbot_chat_parse_mode', state.clientParseMode);
    refreshSettings(container);

    container.querySelector('#btn-refresh-authorizations')?.addEventListener('click', () => { void loadAuthorizations(container, true); });
    container.querySelector('#btn-refresh-business-settings')?.addEventListener('click', () => {
      loadedBusinessSettingsInstance = null;
      void loadBusinessSettings(container, true);
    });
    container.querySelector('#btn-refresh-account-privacy')?.addEventListener('click', () => {
      loadedPrivacyInstance = null;
      void loadAccountPrivacy(container, true);
    });
    container.querySelector('#setting-default-history-ttl')?.addEventListener('change', event => {
      void saveDefaultHistoryTtl(container, Number(event.currentTarget.value));
    });
    container.querySelector('#btn-open-default-history-ttl-picker')?.addEventListener('click', () => {
      const picker = container.querySelector('#setting-default-history-ttl-picker');
      if (!picker) return;
      picker.hidden = !picker.hidden;
      if (!picker.hidden && (!existingHistoryTtlPickerState || existingHistoryTtlPickerState.instId !== state.clientSelectedInstance)) {
        void loadExistingHistoryTtlChats(container, true);
      }
    });
    container.querySelector('#btn-more-default-history-ttl-chats')?.addEventListener('click', () => {
      void loadExistingHistoryTtlChats(container, false);
    });
    container.querySelector('#setting-default-history-ttl-search')?.addEventListener('input', event => {
      void searchExistingHistoryTtlChats(container, String(event.currentTarget.value || '').trim());
    });
    container.querySelector('#btn-apply-default-history-ttl')?.addEventListener('click', () => {
      void applyDefaultHistoryTtlToChats(container);
    });
    container.querySelector('#btn-refresh-global-privacy')?.addEventListener('click', () => {
      loadedGlobalPrivacyInstance = null;
      void loadAccountGlobalPrivacySettings(container, true);
    });
    container.querySelector('#btn-refresh-telegram-themes')?.addEventListener('click', () => {
      loadedTelegramAppThemesInstance = null;
      void loadTelegramAppThemes(container, true);
    });
    container.querySelector('#btn-refresh-telegram-notifications')?.addEventListener('click', () => {
      loadedNotificationInstance = null;
      void loadAccountNotificationSettings(container, true);
    });
    container.querySelector('#btn-refresh-stars')?.addEventListener('click', () => {
      loadedStarsInstance = null;
      loadedStarsTopupInstance = null;
      void loadAccountStars(container, false, true);
      void loadAccountStarsTopupOptions(container, true);
    });
    container.querySelector('#btn-more-stars')?.addEventListener('click', () => {
      void loadAccountStars(container, true);
    });
    container.querySelector('#btn-refresh-star-gifts')?.addEventListener('click', () => {
      loadedStarGiftsInstance = null;
      void loadAccountStarGifts(container, true);
    });
    container.querySelector('#btn-refresh-saved-star-gifts')?.addEventListener('click', () => {
      loadedSavedStarGiftsInstance = null;
      void loadAccountSavedStarGifts(container, false, true);
    });
    container.querySelector('#btn-more-saved-star-gifts')?.addEventListener('click', () => {
      void loadAccountSavedStarGifts(container, true);
    });
    container.querySelector('#btn-check-gift-code')?.addEventListener('click', () => { void checkAccountGiftCode(container); });
    container.querySelector('#btn-apply-gift-code')?.addEventListener('click', () => { void applyAccountGiftCode(container); });
    container.querySelector('#setting-gift-code-input')?.addEventListener('input', () => {
      giftCodePreviewRequest++;
      giftCodePreview = null;
      const apply = container.querySelector('#btn-apply-gift-code');
      if (apply) apply.hidden = true;
    });
    container.querySelector('#btn-refresh-stars-subscriptions')?.addEventListener('click', () => {
      loadedStarsSubscriptionsInstance = null;
      void loadAccountStarsSubscriptions(container, false, true);
    });
    container.querySelector('#btn-more-stars-subscriptions')?.addEventListener('click', () => {
      void loadAccountStarsSubscriptions(container, true);
    });
    container.querySelector('#btn-revoke-other-authorizations')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const instId = state.clientSelectedInstance;
      if (!instId) return;
      if (!window.confirm('终止其他所有 Telegram 登录会话？其他设备需要重新登录。')) return;
      button.disabled = true;
      try {
        await api(`/api/instances/${encodeURIComponent(instId)}/account/authorizations/revoke-others`, 'POST', {});
        if (state.clientSelectedInstance !== instId) return;
        showToast('已请求终止其他登录会话', 'success');
        await loadAuthorizations(container, true);
      } catch (error) {
        if (state.clientSelectedInstance === instId) showToast(`终止其他会话失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    // Clear cache
    const clearBtn = container.querySelector('#btn-settings-clear-cache');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        try {
          clearBtn.disabled = true;
          const response = await fetch('/api/cache/clear', { method: 'POST' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await loadCacheStats(container);
          if (window.showToast) showToast('缓存已清理', 'success');
        } catch (err) {
          if (window.showToast) showToast(`清理失败: ${err.message}`, 'error');
        } finally {
          clearBtn.disabled = false;
        }
      };
    }
  }

  function refreshSettings(container) {
    const sendMode = container.querySelector('#setting-send-mode');
    const parseMode = container.querySelector('#setting-parse-mode');
    const translationLanguage = container.querySelector('#setting-translation-language');
    const silent = container.querySelector('#setting-silent');
    if (sendMode) sendMode.value = state.chatSendKeyMode;
    if (parseMode) parseMode.value = state.clientParseMode;
    if (translationLanguage) translationLanguage.value = state.clientTranslationLanguage || 'zh-hans';
    if (silent) silent.checked = Boolean(state.clientSilent);
    if (existingHistoryTtlPickerState && existingHistoryTtlPickerState.instId !== state.clientSelectedInstance) {
      existingHistoryTtlRequest++;
      existingHistoryTtlSearchRequest++;
      existingHistoryTtlPickerState = null;
      const picker = container.querySelector('#setting-default-history-ttl-picker');
      const list = container.querySelector('#setting-default-history-ttl-chats');
      const search = container.querySelector('#setting-default-history-ttl-search');
      const pickerStatus = container.querySelector('#setting-default-history-ttl-picker-status');
      if (picker) picker.hidden = true;
      if (list) list.replaceChildren();
      if (search) search.value = '';
      if (pickerStatus) pickerStatus.textContent = '';
    }
    if (existingHistoryTtlPickerState && existingHistoryTtlPickerState.instId !== state.clientSelectedInstance) {
      existingHistoryTtlRequest++;
      existingHistoryTtlSearchRequest++;
      existingHistoryTtlPickerState = null;
      const picker = container.querySelector('#setting-default-history-ttl-picker');
      const list = container.querySelector('#setting-default-history-ttl-chats');
      const search = container.querySelector('#setting-default-history-ttl-search');
      const pickerStatus = container.querySelector('#setting-default-history-ttl-picker-status');
      if (picker) picker.hidden = true;
      if (list) list.replaceChildren();
      if (search) search.value = '';
      if (pickerStatus) pickerStatus.textContent = '';
    }
    const wallpaper = localStorage.getItem('tg_chat_wallpaper_theme') || 'obsidian';
    container.querySelectorAll('.wallpaper-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === wallpaper);
    });
    loadCacheStats(container);
    if (container.classList.contains('active')) {
      void loadAuthorizations(container);
      void loadAccountPrivacy(container);
      void loadDefaultHistoryTtl(container);
      void loadAccountGlobalPrivacySettings(container);
      void loadAccountNotificationSettings(container);
      void loadAccountStars(container);
      void loadAccountStarsTopupOptions(container);
      void loadAccountStarsSubscriptions(container);
      void loadAccountStarGifts(container);
      void loadAccountSavedStarGifts(container);
      void loadTelegramAppThemes(container);
      void loadBusinessSettings(container);
    }
  }

  async function loadBusinessSettings(container, force = false) {
    const status = container.querySelector('#setting-business-status');
    const list = container.querySelector('#setting-business-list');
    const editor = container.querySelector('#setting-business-work-hours-editor');
    const editButton = container.querySelector('#btn-edit-business-work-hours');
    const locationEditor = container.querySelector('#setting-business-location-editor');
    const editLocationButton = container.querySelector('#btn-edit-business-location');
    const introEditor = container.querySelector('#setting-business-intro-editor');
    const editIntroButton = container.querySelector('#btn-edit-business-intro');
    const chatLinkEditor = container.querySelector('#setting-business-chat-link-editor');
    const addChatLinkButton = container.querySelector('#btn-add-business-chat-link');
    const greetingEditor = container.querySelector('#setting-business-greeting-editor');
    const editGreetingButton = container.querySelector('#btn-edit-business-greeting');
    const awayEditor = container.querySelector('#setting-business-away-editor');
    const editAwayButton = container.querySelector('#btn-edit-business-away');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      businessSettingsRequest++;
      loadedBusinessSettingsInstance = null;
      if (editor) editor.hidden = true;
      if (editButton) editButton.hidden = true;
      if (locationEditor) locationEditor.hidden = true;
      if (editLocationButton) editLocationButton.hidden = true;
      if (introEditor) introEditor.hidden = true;
      if (editIntroButton) editIntroButton.hidden = true;
      if (chatLinkEditor) chatLinkEditor.hidden = true;
      if (addChatLinkButton) addChatLinkButton.hidden = true;
      if (greetingEditor) greetingEditor.hidden = true;
      if (editGreetingButton) editGreetingButton.hidden = true;
      if (awayEditor) awayEditor.hidden = true;
      if (editAwayButton) editAwayButton.hidden = true;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedBusinessSettingsInstance === instId) return;
    const requestId = ++businessSettingsRequest;
    const stillCurrent = () => requestId === businessSettingsRequest && state.clientSelectedInstance === instId;
    if (editor) editor.hidden = true;
    if (editButton) editButton.hidden = true;
    if (locationEditor) locationEditor.hidden = true;
    if (editLocationButton) editLocationButton.hidden = true;
    if (introEditor) introEditor.hidden = true;
    if (editIntroButton) editIntroButton.hidden = true;
    if (chatLinkEditor) chatLinkEditor.hidden = true;
    if (addChatLinkButton) addChatLinkButton.hidden = true;
    if (greetingEditor) greetingEditor.hidden = true;
    if (editGreetingButton) editGreetingButton.hidden = true;
    if (awayEditor) awayEditor.hidden = true;
    if (editAwayButton) editAwayButton.hidden = true;
    status.textContent = '正在读取 Telegram Business 信息…';
    list.replaceChildren();
    try {
      const settings = await api(`/api/instances/${encodeURIComponent(instId)}/account/business-settings`);
      if (!stillCurrent()) return;
      const rows = [];
      const addRow = (labelText, valueText) => {
        if (!valueText) return;
        const row = document.createElement('div'); row.className = 'settings-business-row';
        const label = document.createElement('strong'); label.textContent = labelText;
        const value = document.createElement('span'); value.textContent = valueText;
        row.append(label, value); rows.push(row);
      };
      const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const formatWeeklyMinute = minute => {
        if (minute === 10080) return '下周一 00:00';
        const day = Math.floor(minute / 1440) % 7;
        const withinDay = minute % 1440;
        return `${days[day]} ${String(Math.floor(withinDay / 60)).padStart(2, '0')}:${String(withinDay % 60).padStart(2, '0')}`;
      };
      if (settings?.workHours) {
        const intervals = Array.isArray(settings.workHours.weeklyOpen) ? settings.workHours.weeklyOpen : [];
        const schedule = intervals.map(item => `${formatWeeklyMinute(Number(item.startMinute))}–${formatWeeklyMinute(Number(item.endMinute))}`).join('；');
        const stateText = typeof settings.workHours.openNow === 'boolean' ? (settings.workHours.openNow ? '营业中' : '非营业时间') : '';
        addRow('营业时间', [stateText, settings.workHours.timezoneId, schedule].filter(Boolean).join(' · ') || '未设置时间段');
      } else addRow('营业时间', '尚未设置');
      const location = settings?.location;
      if (location) {
        const coords = Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))
          ? `${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)}` : '';
        addRow('Business 位置', [location.address, coords].filter(Boolean).join(' · ') || '未设置地址');
      }
      const recipientText = recipients => {
        const labels = [['newChats', '新聊天'], ['existingChats', '已有聊天'], ['contacts', '联系人'], ['nonContacts', '非联系人']]
          .filter(([key]) => recipients?.[key]).map(([, label]) => label);
        if (Number(recipients?.selectedUsers) > 0) labels.push(`${Number(recipients.selectedUsers)} 个指定对象`);
        if (recipients?.excludeSelected) labels.push('排除所选对象');
        return labels.length ? labels.join('、') : '未指定收件范围';
      };
      if (settings?.greeting) {
        addRow('欢迎消息', `快捷回复 #${settings.greeting.shortcutId} · ${settings.greeting.noActivityDays} 天无活动后 · ${recipientText(settings.greeting.recipients)}`);
      }
      if (settings?.away) {
        const scheduleNames = { always: '始终发送', outside_work_hours: '非工作时间', custom: '自定义时段' };
        let schedule = scheduleNames[settings.away.schedule] || '始终发送';
        if (settings.away.schedule === 'custom' && Number(settings.away.startDate) > 0 && Number(settings.away.endDate) > 0) {
          schedule += ` (${new Date(Number(settings.away.startDate) * 1000).toLocaleString()}–${new Date(Number(settings.away.endDate) * 1000).toLocaleString()})`;
        }
        addRow('离开消息', `快捷回复 #${settings.away.shortcutId} · ${schedule}${settings.away.offlineOnly ? ' · 仅离线时' : ''} · ${recipientText(settings.away.recipients)}`);
      }
      if (settings?.intro) {
        addRow('Business 简介', [settings.intro.title, settings.intro.description, settings.intro.hasSticker ? '包含贴纸' : ''].filter(Boolean).join(' · ') || '已启用');
      }
      let editingBusinessChatLinkSlug = null;
      for (const link of Array.isArray(settings?.chatLinks) ? settings.chatLinks : []) {
        if (!link || typeof link !== 'object') continue;
        const item = document.createElement('div'); item.className = 'settings-business-link';
        const heading = document.createElement('strong'); heading.textContent = link.title || 'Business 聊天链接';
        const body = document.createElement('span'); body.textContent = link.message || '';
        item.append(heading, body);
        if (typeof link.url === 'string' && /^https:\/\/t\.me\/m\/[A-Za-z0-9_-]{1,128}\/?$/.test(link.url)) {
          const anchor = document.createElement('a'); anchor.href = link.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = link.url;
          item.appendChild(anchor);
        }
        const views = Number(link.views);
        if (Number.isSafeInteger(views) && views >= 0) { const count = document.createElement('small'); count.textContent = `${views} 次打开`; item.appendChild(count); }
        const slug = typeof link.url === 'string' ? /^https:\/\/t\.me\/m\/([A-Za-z0-9_-]{1,128})\/?$/.exec(link.url)?.[1] : '';
        if (slug) {
          const actions = document.createElement('div'); actions.className = 'settings-session-actions';
          const editButton = document.createElement('button'); editButton.type = 'button';
          editButton.className = 'btn btn-secondary btn-sm'; editButton.textContent = '编辑链接';
          editButton.onclick = () => {
            if (!stillCurrent()) return;
            const titleInput = container.querySelector('#setting-business-chat-link-title');
            const messageInput = container.querySelector('#setting-business-chat-link-message');
            const editorStatus = container.querySelector('#setting-business-chat-link-status');
            const save = container.querySelector('#btn-save-business-chat-link');
            const editor = container.querySelector('#setting-business-chat-link-editor');
            const formatHint = container.querySelector('#setting-business-chat-link-formatting');
            if (!titleInput || !messageInput || !editorStatus || !editor || !save) return;
            editingBusinessChatLinkSlug = slug;
            titleInput.value = link.title || ''; messageInput.value = link.message || '';
            editorStatus.textContent = '';
            if (formatHint) formatHint.textContent = link.hasFormatting
              ? '此链接包含文字格式：只改名称会保留格式；修改预填消息会清除原格式。'
              : '修改预填消息时，Telegram 会使用纯文本格式。';
            save.textContent = '保存更改'; editor.hidden = false;
          };
          const deleteButton = document.createElement('button'); deleteButton.type = 'button';
          deleteButton.className = 'btn btn-secondary btn-sm'; deleteButton.textContent = '删除链接';
          deleteButton.onclick = async () => {
            if (!stillCurrent() || !window.confirm(`删除 Business 聊天链接“${link.title || '未命名'}”？`)) return;
            deleteButton.disabled = true;
            try {
              await api(`/api/instances/${encodeURIComponent(instId)}/account/business-chat-links`, 'POST', { action: 'delete', slug });
              if (!stillCurrent()) return;
              loadedBusinessSettingsInstance = null;
              await loadBusinessSettings(container, true);
            } catch (error) {
              if (stillCurrent()) { deleteButton.disabled = false; status.textContent = `无法删除聊天链接：${error.message}`; }
            }
          };
          actions.append(editButton, deleteButton); item.appendChild(actions);
        }
        rows.push(item);
      }
      list.replaceChildren(...rows);
      loadedBusinessSettingsInstance = instId;
      status.textContent = rows.length ? '营业时间、Business 位置、简介和欢迎/离开消息可编辑；聊天链接可创建、编辑或删除。' : 'Telegram 当前未返回 Business 配置或聊天链接。';

      const intervalList = container.querySelector('#setting-business-intervals');
      const timezoneInput = container.querySelector('#setting-business-timezone');
      const editorStatus = container.querySelector('#setting-business-work-hours-status');
      const addIntervalButton = container.querySelector('#btn-add-business-interval');
      const saveButton = container.querySelector('#btn-save-business-work-hours');
      const cancelButton = container.querySelector('#btn-cancel-business-work-hours');
      if (editButton && editor && intervalList && timezoneInput && editorStatus && addIntervalButton && saveButton && cancelButton) {
        const endDays = [...days, '下周一'];
        const makeSelect = (className, label, labels, value) => {
          const select = document.createElement('select');
          select.className = `form-select ${className}`;
          select.setAttribute('aria-label', label);
          labels.forEach((text, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = text;
            select.appendChild(option);
          });
          if (value != null) select.value = String(value);
          return select;
        };
        const minuteTime = minute => `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        const makeTime = (className, label, value) => {
          const input = document.createElement('input');
          input.className = `form-input ${className}`;
          input.type = 'time'; input.step = '60'; input.setAttribute('aria-label', label);
          if (value != null) input.value = minuteTime(value);
          return input;
        };
        const makeIntervalRow = (startMinute, endMinute) => {
          const row = document.createElement('div'); row.className = 'settings-business-interval';
          const startDay = startMinute == null ? 0 : Math.floor(startMinute / 1440);
          const endDay = endMinute == null ? 0 : Math.floor(endMinute / 1440);
          const startDayField = makeSelect('business-interval-start-day', '开始日期', days, startDay);
          const startTimeField = makeTime('business-interval-start-time', '开始时间', startMinute);
          const separator = document.createElement('span'); separator.className = 'business-interval-separator'; separator.textContent = '至';
          const endDayField = makeSelect('business-interval-end-day', '结束日期', endDays, endDay);
          const endTimeField = makeTime('business-interval-end-time', '结束时间', endMinute);
          const removeButton = document.createElement('button');
          removeButton.type = 'button'; removeButton.className = 'btn btn-secondary btn-sm';
          removeButton.textContent = '移除'; removeButton.setAttribute('aria-label', '移除此营业时间段');
          removeButton.onclick = () => row.remove();
          row.__businessFields = { startDayField, startTimeField, endDayField, endTimeField };
          row.append(startDayField, startTimeField, separator, endDayField, endTimeField, removeButton);
          return row;
        };
        editButton.hidden = false;
        editButton.onclick = () => {
          if (!stillCurrent()) return;
          const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
          timezoneInput.value = settings?.workHours?.timezoneId || defaultTimezone;
          const intervals = Array.isArray(settings?.workHours?.weeklyOpen) ? settings.workHours.weeklyOpen : [];
          intervalList.replaceChildren(...intervals.map(item => makeIntervalRow(Number(item.startMinute), Number(item.endMinute))));
          editorStatus.textContent = '';
          editor.hidden = false;
        };
        addIntervalButton.onclick = () => intervalList.appendChild(makeIntervalRow(null, null));
        cancelButton.onclick = () => { editor.hidden = true; editorStatus.textContent = ''; };
        saveButton.onclick = async () => {
          if (!stillCurrent()) return;
          try {
            const timezoneId = String(timezoneInput.value || '').trim();
            if (!timezoneId || timezoneId.length > 128) throw new Error('请输入有效时区。');
            try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }).format(); }
            catch { throw new Error('请输入有效的 IANA 时区，例如 Europe/Helsinki。'); }
            const parseTime = value => {
              const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
              if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('请为每段时间填写有效的起止时间。');
              return Number(match[1]) * 60 + Number(match[2]);
            };
            const weeklyOpen = Array.from(intervalList.children).map(row => {
              const fields = row.__businessFields;
              const startDay = Number(fields?.startDayField?.value), endDay = Number(fields?.endDayField?.value);
              const startMinute = startDay * 1440 + parseTime(fields?.startTimeField?.value);
              const endMinute = endDay * 1440 + parseTime(fields?.endTimeField?.value);
              if (!Number.isInteger(startDay) || startDay < 0 || startDay > 6 || !Number.isInteger(endDay) || endDay < 0 || endDay > 7 ||
                  (endDay === 7 && endMinute !== 10080) || startMinute >= endMinute || endMinute > 10080) {
                throw new Error('营业时间段必须在一周内，并且结束时间晚于开始时间。');
              }
              return { startMinute, endMinute };
            }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
            if (weeklyOpen.length > 100) throw new Error('最多可设置 100 段营业时间。');
            for (let index = 1; index < weeklyOpen.length; index++) {
              if (weeklyOpen[index].startMinute < weeklyOpen[index - 1].endMinute) throw new Error('营业时间段不能重叠。');
            }
            editorStatus.textContent = '正在保存…';
            saveButton.disabled = true; addIntervalButton.disabled = true; cancelButton.disabled = true;
            await api(`/api/instances/${encodeURIComponent(instId)}/account/business-settings`, 'POST', { timezoneId, weeklyOpen });
            if (!stillCurrent()) return;
            editor.hidden = true;
            editorStatus.textContent = '营业时间已保存。';
            loadedBusinessSettingsInstance = null;
            await loadBusinessSettings(container, true);
          } catch (error) {
            if (stillCurrent()) editorStatus.textContent = `无法保存营业时间：${error.message}`;
          } finally {
            if (stillCurrent()) { saveButton.disabled = false; addIntervalButton.disabled = false; cancelButton.disabled = false; }
          }
        };
      }

      const locationAddress = container.querySelector('#setting-business-location-address');
      const locationLatitude = container.querySelector('#setting-business-location-latitude');
      const locationLongitude = container.querySelector('#setting-business-location-longitude');
      const locationStatus = container.querySelector('#setting-business-location-status');
      const saveLocationButton = container.querySelector('#btn-save-business-location');
      const cancelLocationButton = container.querySelector('#btn-cancel-business-location');
      if (editLocationButton && locationEditor && locationAddress && locationLatitude && locationLongitude && locationStatus && saveLocationButton && cancelLocationButton) {
        editLocationButton.hidden = false;
        editLocationButton.onclick = () => {
          if (!stillCurrent()) return;
          const location = settings?.location || {};
          locationAddress.value = location.address || '';
          locationLatitude.value = location.latitude == null ? '' : String(location.latitude);
          locationLongitude.value = location.longitude == null ? '' : String(location.longitude);
          locationStatus.textContent = '';
          locationEditor.hidden = false;
        };
        cancelLocationButton.onclick = () => { locationEditor.hidden = true; locationStatus.textContent = ''; };
        saveLocationButton.onclick = async () => {
          if (!stillCurrent()) return;
          try {
            const address = String(locationAddress.value || '').trim();
            if (address.length > 512) throw new Error('地址最多 512 个字符。');
            const latitudeText = String(locationLatitude.value || '').trim();
            const longitudeText = String(locationLongitude.value || '').trim();
            if (Boolean(latitudeText) !== Boolean(longitudeText)) throw new Error('请同时填写纬度和经度，或将两项都留空。');
            let latitude, longitude;
            if (latitudeText) {
              latitude = Number(latitudeText); longitude = Number(longitudeText);
              if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
                throw new Error('纬度范围为 -90 至 90，经度范围为 -180 至 180。');
              }
            }
            locationStatus.textContent = '正在保存…';
            saveLocationButton.disabled = true; cancelLocationButton.disabled = true;
            await api(`/api/instances/${encodeURIComponent(instId)}/account/business-location`, 'POST', {
              address, ...(latitude == null ? {} : { latitude, longitude }),
            });
            if (!stillCurrent()) return;
            locationEditor.hidden = true;
            locationStatus.textContent = 'Business 位置已保存。';
            loadedBusinessSettingsInstance = null;
            await loadBusinessSettings(container, true);
          } catch (error) {
            if (stillCurrent()) locationStatus.textContent = `无法保存 Business 位置：${error.message}`;
          } finally {
            if (stillCurrent()) { saveLocationButton.disabled = false; cancelLocationButton.disabled = false; }
          }
        };
      }

      const introTitle = container.querySelector('#setting-business-intro-title');
      const introDescription = container.querySelector('#setting-business-intro-description');
      const introStatus = container.querySelector('#setting-business-intro-status');
      const saveIntroButton = container.querySelector('#btn-save-business-intro');
      const clearIntroButton = container.querySelector('#btn-clear-business-intro');
      const cancelIntroButton = container.querySelector('#btn-cancel-business-intro');
      if (editIntroButton && introEditor && introTitle && introDescription && introStatus && saveIntroButton && clearIntroButton && cancelIntroButton) {
        editIntroButton.hidden = false;
        editIntroButton.onclick = () => {
          if (!stillCurrent()) return;
          introTitle.value = settings?.intro?.title || '';
          introDescription.value = settings?.intro?.description || '';
          introStatus.textContent = '';
          introEditor.hidden = false;
        };
        cancelIntroButton.onclick = () => { introEditor.hidden = true; introStatus.textContent = ''; };
        const submitIntro = async clear => {
          if (!stillCurrent()) return;
          if (clear && !window.confirm('清除 Business 简介及其贴纸？')) return;
          try {
            const title = String(introTitle.value || ''), description = String(introDescription.value || '');
            if (title.length > 256 || description.length > 4096) throw new Error('简介超出 Telegram 字数限制。');
            introStatus.textContent = '正在保存…';
            saveIntroButton.disabled = true; clearIntroButton.disabled = true; cancelIntroButton.disabled = true;
            await api(`/api/instances/${encodeURIComponent(instId)}/account/business-intro`, 'POST', { title, description, clear });
            if (!stillCurrent()) return;
            introEditor.hidden = true;
            introStatus.textContent = clear ? 'Business 简介已清除。' : 'Business 简介已保存。';
            loadedBusinessSettingsInstance = null;
            await loadBusinessSettings(container, true);
          } catch (error) {
            if (stillCurrent()) introStatus.textContent = `无法保存 Business 简介：${error.message}`;
          } finally {
            if (stillCurrent()) { saveIntroButton.disabled = false; clearIntroButton.disabled = false; cancelIntroButton.disabled = false; }
          }
        };
        saveIntroButton.onclick = () => submitIntro(false);
        clearIntroButton.onclick = () => submitIntro(true);
      }

      const chatLinkTitle = container.querySelector('#setting-business-chat-link-title');
      const chatLinkMessage = container.querySelector('#setting-business-chat-link-message');
      const chatLinkStatus = container.querySelector('#setting-business-chat-link-status');
      const saveChatLinkButton = container.querySelector('#btn-save-business-chat-link');
      const cancelChatLinkButton = container.querySelector('#btn-cancel-business-chat-link');
      if (addChatLinkButton && chatLinkEditor && chatLinkTitle && chatLinkMessage && chatLinkStatus && saveChatLinkButton && cancelChatLinkButton) {
        addChatLinkButton.hidden = false;
        addChatLinkButton.onclick = () => {
          if (!stillCurrent()) return;
          editingBusinessChatLinkSlug = null;
          chatLinkTitle.value = ''; chatLinkMessage.value = ''; chatLinkStatus.textContent = '';
          const formatHint = container.querySelector('#setting-business-chat-link-formatting');
          if (formatHint) formatHint.textContent = '修改预填消息时，Telegram 会使用纯文本格式。';
          saveChatLinkButton.textContent = '创建链接';
          chatLinkEditor.hidden = false;
          chatLinkMessage.focus?.();
        };
        cancelChatLinkButton.onclick = () => { editingBusinessChatLinkSlug = null; chatLinkEditor.hidden = true; chatLinkStatus.textContent = ''; };
        saveChatLinkButton.onclick = async () => {
          if (!stillCurrent()) return;
          const title = String(chatLinkTitle.value || '').trim(), message = String(chatLinkMessage.value || '');
          if (!message.trim()) { chatLinkStatus.textContent = '请输入链接打开后显示的消息。'; return; }
          const action = editingBusinessChatLinkSlug ? 'edit' : 'create';
          chatLinkStatus.textContent = action === 'edit' ? '正在保存链接…' : '正在创建链接…';
          saveChatLinkButton.disabled = true; cancelChatLinkButton.disabled = true;
          try {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/business-chat-links`, 'POST', {
              action, ...(editingBusinessChatLinkSlug ? { slug: editingBusinessChatLinkSlug } : {}), title, message,
            });
            if (!stillCurrent()) return;
            editingBusinessChatLinkSlug = null;
            chatLinkEditor.hidden = true;
            loadedBusinessSettingsInstance = null;
            await loadBusinessSettings(container, true);
          } catch (error) {
            if (stillCurrent()) chatLinkStatus.textContent = `${action === 'edit' ? '无法保存' : '无法创建'}聊天链接：${error.message}`;
          } finally {
            if (stillCurrent()) { saveChatLinkButton.disabled = false; cancelChatLinkButton.disabled = false; }
          }
        };
      }

      const recipientKeys = [['newChats', '新聊天'], ['existingChats', '已有聊天'], ['contacts', '联系人'], ['nonContacts', '非联系人']];
      const renderRecipients = (target, recipients) => {
        if (!target) return;
        target.replaceChildren(...recipientKeys.map(([key, labelText]) => {
          const label = document.createElement('label'); label.className = 'settings-business-recipient';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(recipients?.[key]); checkbox.dataset.recipient = key;
          const text = document.createElement('span'); text.textContent = labelText;
          label.append(checkbox, text); return label;
        }));
      };
      const collectRecipients = target => Object.fromEntries(Array.from(target?.children || []).map(label => {
        const checkbox = label.children?.[0], key = checkbox?.dataset?.recipient;
        return [key, Boolean(checkbox?.checked)];
      }).filter(([key]) => recipientKeys.some(([allowed]) => allowed === key)));
      const loadQuickReplyOptions = async (select, currentId, requestStatus) => {
        select.replaceChildren();
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择快捷回复模板';
        select.appendChild(placeholder);
        const shortcuts = await api(`/api/instances/${encodeURIComponent(instId)}/account/quick-replies`);
        if (!stillCurrent()) return false;
        const valid = (Array.isArray(shortcuts) ? shortcuts : []).filter(item => Number.isSafeInteger(Number(item?.shortcutId)) && Number(item.shortcutId) > 0);
        for (const shortcut of valid) {
          const option = document.createElement('option');
          option.value = String(shortcut.shortcutId);
          option.textContent = `/${String(shortcut.shortcut || '').slice(0, 64)} · ${Number(shortcut.count) || 0} 条消息`;
          select.appendChild(option);
        }
        if (currentId > 0 && valid.some(item => Number(item.shortcutId) === currentId)) select.value = String(currentId);
        else if (currentId > 0) {
          const missing = document.createElement('option'); missing.value = String(currentId); missing.textContent = `快捷回复 #${currentId}（当前不可用）`; missing.disabled = true;
          select.appendChild(missing); select.value = String(currentId);
          if (requestStatus) requestStatus.textContent = '当前模板已不在快捷回复列表中；请选择其他模板，或先恢复该模板。';
        }
        if (!valid.length && requestStatus) requestStatus.textContent = '账号没有可用的快捷回复模板；请先在聊天输入框创建快捷回复。';
        return valid.length > 0;
      };
      if (editGreetingButton && greetingEditor) {
        editGreetingButton.hidden = false;
        editGreetingButton.onclick = async () => {
          if (!stillCurrent()) return;
          const shortcutSelect = container.querySelector('#setting-business-greeting-shortcut');
          const daysInput = container.querySelector('#setting-business-greeting-days');
          const statusNode = container.querySelector('#setting-business-greeting-status');
          const usersNode = container.querySelector('#setting-business-greeting-preserved-users');
          const recipientsNode = container.querySelector('#setting-business-greeting-recipients');
          if (!shortcutSelect || !daysInput || !statusNode || !recipientsNode) return;
          greetingEditor.hidden = false; statusNode.textContent = '正在读取快捷回复…';
          daysInput.value = String(settings?.greeting?.noActivityDays ?? 7);
          renderRecipients(recipientsNode, settings?.greeting?.recipients);
          const selectedUsers = Number(settings?.greeting?.recipients?.selectedUsers) || 0;
          if (usersNode) usersNode.textContent = selectedUsers ? `Telegram 还配置了 ${selectedUsers} 个指定用户；保存时会保留这些对象及排除规则。` : 'Telegram 上的指定用户和排除规则会在保存时保留。';
          try {
            await loadQuickReplyOptions(shortcutSelect, Number(settings?.greeting?.shortcutId) || 0, statusNode);
            if (stillCurrent() && statusNode.textContent === '正在读取快捷回复…') statusNode.textContent = '';
          } catch (error) { if (stillCurrent()) statusNode.textContent = `无法读取快捷回复：${error.message}`; }
        };
      }
      const greetingSubmit = async clear => {
        if (!stillCurrent()) return;
        if (clear && !window.confirm('停用 Telegram Business 欢迎消息？')) return;
        const shortcutId = Number(container.querySelector('#setting-business-greeting-shortcut')?.value);
        const noActivityDays = Number(container.querySelector('#setting-business-greeting-days')?.value);
        const recipients = collectRecipients(container.querySelector('#setting-business-greeting-recipients'));
        const statusNode = container.querySelector('#setting-business-greeting-status');
        const save = container.querySelector('#btn-save-business-greeting'), stop = container.querySelector('#btn-clear-business-greeting'), cancel = container.querySelector('#btn-cancel-business-greeting');
        try {
          if (!clear && (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !Number.isSafeInteger(noActivityDays) || noActivityDays < 0 || noActivityDays > 365)) {
            throw new Error('请选择快捷回复模板并设置 0 至 365 天。');
          }
          statusNode.textContent = clear ? '正在停用…' : '正在保存…';
          if (save) save.disabled = true; if (stop) stop.disabled = true; if (cancel) cancel.disabled = true;
          await api(`/api/instances/${encodeURIComponent(instId)}/account/business-greeting-message`, 'POST',
            clear ? { clear: true } : { shortcutId, noActivityDays, recipients, clear: false });
          if (!stillCurrent()) return;
          greetingEditor.hidden = true; loadedBusinessSettingsInstance = null;
          await loadBusinessSettings(container, true);
        } catch (error) { if (stillCurrent() && statusNode) statusNode.textContent = `无法保存欢迎消息：${error.message}`; }
        finally { if (stillCurrent()) { if (save) save.disabled = false; if (stop) stop.disabled = false; if (cancel) cancel.disabled = false; } }
      };
      const saveGreetingButton = container.querySelector('#btn-save-business-greeting');
      const clearGreetingButton = container.querySelector('#btn-clear-business-greeting');
      const cancelGreetingButton = container.querySelector('#btn-cancel-business-greeting');
      if (saveGreetingButton) saveGreetingButton.onclick = () => greetingSubmit(false);
      if (clearGreetingButton) clearGreetingButton.onclick = () => greetingSubmit(true);
      if (cancelGreetingButton) cancelGreetingButton.onclick = () => { if (greetingEditor) greetingEditor.hidden = true; };

      if (editAwayButton && awayEditor) {
        editAwayButton.hidden = false;
        editAwayButton.onclick = async () => {
          if (!stillCurrent()) return;
          const shortcutSelect = container.querySelector('#setting-business-away-shortcut');
          const scheduleSelect = container.querySelector('#setting-business-away-schedule');
          const startInput = container.querySelector('#setting-business-away-start');
          const endInput = container.querySelector('#setting-business-away-end');
          const customDates = container.querySelector('#setting-business-away-custom-dates');
          const offlineOnly = container.querySelector('#setting-business-away-offline-only');
          const statusNode = container.querySelector('#setting-business-away-status');
          const usersNode = container.querySelector('#setting-business-away-preserved-users');
          const recipientsNode = container.querySelector('#setting-business-away-recipients');
          if (!shortcutSelect || !scheduleSelect || !startInput || !endInput || !customDates || !offlineOnly || !statusNode || !recipientsNode) return;
          const current = settings?.away;
          awayEditor.hidden = false; statusNode.textContent = '正在读取快捷回复…';
          scheduleSelect.value = current?.schedule || 'always';
          customDates.hidden = scheduleSelect.value !== 'custom';
          offlineOnly.checked = Boolean(current?.offlineOnly);
          const localDateTime = seconds => {
            const date = new Date(Number(seconds) * 1000);
            return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
          };
          startInput.value = localDateTime(current?.startDate);
          endInput.value = localDateTime(current?.endDate);
          renderRecipients(recipientsNode, current?.recipients);
          const selectedUsers = Number(current?.recipients?.selectedUsers) || 0;
          if (usersNode) usersNode.textContent = selectedUsers ? `Telegram 还配置了 ${selectedUsers} 个指定用户；保存时会保留这些对象及排除规则。` : 'Telegram 上的指定用户和排除规则会在保存时保留。';
          scheduleSelect.onchange = () => { customDates.hidden = scheduleSelect.value !== 'custom'; };
          try {
            await loadQuickReplyOptions(shortcutSelect, Number(current?.shortcutId) || 0, statusNode);
            if (stillCurrent() && statusNode.textContent === '正在读取快捷回复…') statusNode.textContent = '';
          } catch (error) { if (stillCurrent()) statusNode.textContent = `无法读取快捷回复：${error.message}`; }
        };
      }
      const awaySubmit = async clear => {
        if (!stillCurrent()) return;
        if (clear && !window.confirm('停用 Telegram Business 离开消息？')) return;
        const shortcutId = Number(container.querySelector('#setting-business-away-shortcut')?.value);
        const schedule = String(container.querySelector('#setting-business-away-schedule')?.value || 'always');
        const offlineOnly = Boolean(container.querySelector('#setting-business-away-offline-only')?.checked);
        const recipients = collectRecipients(container.querySelector('#setting-business-away-recipients'));
        const statusNode = container.querySelector('#setting-business-away-status');
        const save = container.querySelector('#btn-save-business-away'), stop = container.querySelector('#btn-clear-business-away'), cancel = container.querySelector('#btn-cancel-business-away');
        try {
          if (!clear && (!Number.isSafeInteger(shortcutId) || shortcutId <= 0)) throw new Error('请选择快捷回复模板。');
          let startDate, endDate;
          if (!clear && schedule === 'custom') {
            startDate = Math.floor(new Date(container.querySelector('#setting-business-away-start')?.value || '').getTime() / 1000);
            endDate = Math.floor(new Date(container.querySelector('#setting-business-away-end')?.value || '').getTime() / 1000);
            if (!Number.isSafeInteger(startDate) || !Number.isSafeInteger(endDate) || startDate <= 0 || endDate <= startDate || endDate > 2147483647) {
              throw new Error('请选择有效的自定义起止时间。');
            }
          }
          statusNode.textContent = clear ? '正在停用…' : '正在保存…';
          if (save) save.disabled = true; if (stop) stop.disabled = true; if (cancel) cancel.disabled = true;
          await api(`/api/instances/${encodeURIComponent(instId)}/account/business-away-message`, 'POST', clear ? { clear: true } : {
            shortcutId, offlineOnly, schedule, startDate, endDate, recipients, clear: false,
          });
          if (!stillCurrent()) return;
          awayEditor.hidden = true; loadedBusinessSettingsInstance = null;
          await loadBusinessSettings(container, true);
        } catch (error) { if (stillCurrent() && statusNode) statusNode.textContent = `无法保存离开消息：${error.message}`; }
        finally { if (stillCurrent()) { if (save) save.disabled = false; if (stop) stop.disabled = false; if (cancel) cancel.disabled = false; } }
      };
      const saveAwayButton = container.querySelector('#btn-save-business-away');
      const clearAwayButton = container.querySelector('#btn-clear-business-away');
      const cancelAwayButton = container.querySelector('#btn-cancel-business-away');
      if (saveAwayButton) saveAwayButton.onclick = () => awaySubmit(false);
      if (clearAwayButton) clearAwayButton.onclick = () => awaySubmit(true);
      if (cancelAwayButton) cancelAwayButton.onclick = () => { if (awayEditor) awayEditor.hidden = true; };
    } catch (error) {
      if (!stillCurrent()) return;
      loadedBusinessSettingsInstance = null;
      status.textContent = `无法读取 Telegram Business 信息：${error.message}`;
    }
  }

  async function loadDefaultHistoryTtl(container, force = false) {
    const select = container.querySelector('#setting-default-history-ttl');
    const status = container.querySelector('#setting-default-history-ttl-status');
    if (!select || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      defaultHistoryTtlRequest++;
      loadedDefaultHistoryTtlInstance = null;
      select.disabled = true;
      status.textContent = '请选择一个已登录账号。';
      return;
    }
    if (!force && loadedDefaultHistoryTtlInstance === instId) return;
    loadedDefaultHistoryTtlInstance = instId;
    const requestId = ++defaultHistoryTtlRequest;
    const stillCurrent = () => requestId === defaultHistoryTtlRequest && state.clientSelectedInstance === instId;
    select.disabled = true;
    status.textContent = '正在读取 Telegram 默认计时器…';
    try {
      const result = await api('/api/instances/' + encodeURIComponent(instId) + '/account/default-history-ttl');
      if (!stillCurrent()) return;
      const period = Number(result?.period);
      if (!Number.isSafeInteger(period) || period < 0 || period > 31536000) throw new Error('Telegram 返回了无效计时器');
      select.querySelectorAll?.('option[data-telegram-custom]')?.forEach(option => option.remove());
      if (!defaultHistoryTtlOptions.includes(period) && period > 0) {
        const custom = document.createElement('option');
        custom.value = String(period);
        custom.textContent = 'Telegram 当前值（' + period + ' 秒）';
        custom.dataset.telegramCustom = 'true';
        select.appendChild(custom);
      }
      select.value = String(period);
      if (select.dataset) select.dataset.savedPeriod = String(period);
      status.textContent = period ? '此计时器用于新聊天；现有会话可单独设置。' : '新聊天默认不自动删除消息。';
    } catch (error) {
      if (!stillCurrent()) return;
      loadedDefaultHistoryTtlInstance = null;
      status.textContent = '无法读取 Telegram 默认计时器：' + error.message;
    } finally {
      if (stillCurrent()) select.disabled = false;
    }
  }

  async function saveDefaultHistoryTtl(container, period) {
    const select = container.querySelector('#setting-default-history-ttl');
    const status = container.querySelector('#setting-default-history-ttl-status');
    const instId = state.clientSelectedInstance;
    if (!select || !status || !instId || !Number.isSafeInteger(period) || period < 0 || period > 31536000) return;
    const previous = select.dataset?.savedPeriod ?? '0';
    const requestId = ++defaultHistoryTtlRequest;
    const stillCurrent = () => requestId === defaultHistoryTtlRequest && state.clientSelectedInstance === instId;
    select.disabled = true;
    status.textContent = '正在保存 Telegram 默认计时器…';
    try {
      const result = await api('/api/instances/' + encodeURIComponent(instId) + '/account/default-history-ttl', 'POST', { period });
      if (!stillCurrent()) return;
      if (Number(result?.period) !== period) throw new Error('Telegram 未确认计时器');
      select.value = String(period);
      if (select.dataset) select.dataset.savedPeriod = String(period);
      loadedDefaultHistoryTtlInstance = instId;
      status.textContent = period ? '已设置新聊天的默认计时器。' : '新聊天默认不自动删除消息。';
    } catch (error) {
      if (!stillCurrent()) return;
      select.value = previous;
      loadedDefaultHistoryTtlInstance = null;
      status.textContent = '保存失败：' + error.message;
    } finally {
      if (stillCurrent()) select.disabled = false;
    }
  }

  async function loadExistingHistoryTtlChats(container, reset) {
    const list = container.querySelector('#setting-default-history-ttl-chats');
    const status = container.querySelector('#setting-default-history-ttl-picker-status');
    const more = container.querySelector('#btn-more-default-history-ttl-chats');
    const instId = state.clientSelectedInstance;
    if (!list || !status || !instId) return;
    if (reset || !existingHistoryTtlPickerState || existingHistoryTtlPickerState.instId !== instId) {
      existingHistoryTtlRequest++;
      existingHistoryTtlSearchRequest++;
      existingHistoryTtlPickerState = {
        instId, requestId: existingHistoryTtlRequest, dialogs: new Map(), selected: new Set(), searchResults: null,
        folders: {
          0: { cursor: null, hasMore: true },
          1: { cursor: null, hasMore: true },
        },
        loading: false,
      };
    }
    const session = existingHistoryTtlPickerState;
    if (session.loading) return;
    session.loading = true;
    if (more) more.disabled = true;
    status.textContent = '正在读取 Telegram 会话…';
    const isCurrent = () => existingHistoryTtlPickerState === session && state.clientSelectedInstance === instId;
    try {
      for (const folderId of [0, 1]) {
        const folder = session.folders[folderId];
        if (!folder.hasMore) continue;
        const query = new URLSearchParams({ limit: '50', folderId: String(folderId) });
        if (folder.cursor) {
          query.set('offsetPeer', String(folder.cursor.peer));
          query.set('offsetId', String(folder.cursor.id));
          query.set('offsetDate', String(folder.cursor.date));
        }
        const page = await api('/api/instances/' + encodeURIComponent(instId) + '/account/dialogs?' + query.toString());
        if (!isCurrent()) return;
        const dialogs = Array.isArray(page) ? page : [];
        for (const dialog of dialogs) {
          const id = Number(dialog?.id);
          if (!Number.isSafeInteger(id) || id === 0 || dialog?.isSelf || !['private', 'group', 'supergroup', 'channel'].includes(dialog?.type)) continue;
          session.dialogs.set(id, { ...dialog, id });
        }
        const last = dialogs.at(-1);
        if (dialogs.length < 50 || !Number.isSafeInteger(Number(last?.lastMessageId)) ||
            Number(last.lastMessageId) <= 0 || !Number.isFinite(Number(last?.lastMessageDate)) || Number(last.lastMessageDate) <= 0) {
          folder.hasMore = false;
          folder.cursor = null;
        } else {
          folder.cursor = { peer: Number(last.id), id: Number(last.lastMessageId), date: Number(last.lastMessageDate) };
        }
      }
      if (!isCurrent()) return;
      session.searchResults = null;
      renderExistingHistoryTtlChats(container);
      status.textContent = session.dialogs.size
        ? session.dialogs.size + ' 个会话已载入；可搜索已载入会话或 Telegram 联系人。'
        : '没有可设置的既有会话。';
    } catch (error) {
      if (isCurrent()) status.textContent = '读取会话失败：' + error.message;
    } finally {
      if (isCurrent()) {
        session.loading = false;
        if (more) {
          more.hidden = !Object.values(session.folders).some(folder => folder.hasMore);
          more.disabled = false;
        }
      }
    }
  }

  async function searchExistingHistoryTtlChats(container, query) {
    const session = existingHistoryTtlPickerState;
    const status = container.querySelector('#setting-default-history-ttl-picker-status');
    if (!session || session.instId !== state.clientSelectedInstance) return;
    const requestId = ++existingHistoryTtlSearchRequest;
    if (!query) {
      session.searchResults = null;
      renderExistingHistoryTtlChats(container);
      if (status) status.textContent = session.dialogs.size + ' 个已载入会话。';
      return;
    }
    if (query.length > 128) return;
    if (status) status.textContent = '正在搜索 Telegram…';
    try {
      const results = await api('/api/instances/' + encodeURIComponent(session.instId) + '/account/search-dialogs?query=' + encodeURIComponent(query));
      if (requestId !== existingHistoryTtlSearchRequest || existingHistoryTtlPickerState !== session ||
          state.clientSelectedInstance !== session.instId) return;
      session.searchResults = (Array.isArray(results) ? results : []).filter(dialog =>
        Number.isSafeInteger(Number(dialog?.id)) && Number(dialog.id) !== 0 && !dialog.isSelf &&
        ['private', 'group', 'supergroup', 'channel'].includes(dialog.type));
      renderExistingHistoryTtlChats(container);
      if (status) status.textContent = session.searchResults.length
        ? '找到 ' + session.searchResults.length + ' 个匹配会话或联系人。'
        : '未找到匹配的会话或联系人。';
    } catch (error) {
      if (requestId === existingHistoryTtlSearchRequest && existingHistoryTtlPickerState === session && status) {
        status.textContent = '搜索失败：' + error.message;
      }
    }
  }

  function renderExistingHistoryTtlChats(container) {
    const session = existingHistoryTtlPickerState;
    const list = container.querySelector('#setting-default-history-ttl-chats');
    const apply = container.querySelector('#btn-apply-default-history-ttl');
    const status = container.querySelector('#setting-default-history-ttl-picker-status');
    if (!session || !list || !apply) return;
    const dialogs = session.searchResults || [...session.dialogs.values()];
    list.replaceChildren();
    for (const dialog of dialogs.slice(0, 100)) {
      const id = Number(dialog.id);
      const row = document.createElement('label');
      row.className = 'settings-default-history-ttl-chat';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = session.selected.has(id);
      checkbox.disabled = !checkbox.checked && session.selected.size >= 100;
      checkbox.addEventListener('change', () => {
        if (existingHistoryTtlPickerState !== session || state.clientSelectedInstance !== session.instId) return;
        if (checkbox.checked) {
          if (session.selected.size >= 100) { checkbox.checked = false; return; }
          session.selected.add(id);
        } else session.selected.delete(id);
        if (status) status.textContent = session.selected.size + ' 个会话已选；最多可同时应用到 100 个。';
        apply.disabled = session.selected.size === 0;
        list.querySelectorAll?.('input[type="checkbox"]')?.forEach(input => {
          input.disabled = !input.checked && session.selected.size >= 100;
        });
      });
      const title = document.createElement('span');
      title.textContent = String(dialog.title || dialog.username || 'Telegram 会话');
      const subtitle = document.createElement('small');
      subtitle.textContent = dialog.username ? '@' + String(dialog.username) : (dialog.type || '会话');
      row.append(checkbox, title, subtitle);
      list.appendChild(row);
    }
    apply.disabled = session.selected.size === 0;
  }

  async function applyDefaultHistoryTtlToChats(container) {
    const session = existingHistoryTtlPickerState;
    const select = container.querySelector('#setting-default-history-ttl');
    const status = container.querySelector('#setting-default-history-ttl-picker-status');
    const apply = container.querySelector('#btn-apply-default-history-ttl');
    if (!session || !select || !status || !apply || session.instId !== state.clientSelectedInstance || !session.selected.size) return;
    const chatIds = [...session.selected].slice(0, 100);
    const period = Number(select.value);
    if (!Number.isSafeInteger(period) || period < 0 || period > 31536000) return;
    if (!window.confirm('把当前默认计时器应用到 ' + chatIds.length + ' 个所选聊天？Telegram 会分别检查每个聊天的管理权限。')) return;
    const requestId = ++existingHistoryTtlRequest;
    const stillCurrent = () => existingHistoryTtlPickerState === session && requestId === existingHistoryTtlRequest &&
      state.clientSelectedInstance === session.instId;
    apply.disabled = true;
    status.textContent = '正在逐个更新所选聊天…';
    try {
      const result = await api('/api/instances/' + encodeURIComponent(session.instId) + '/account/chat-history-ttl/bulk',
        'POST', { chatIds, period });
      if (!stillCurrent()) return;
      const updated = Number(result?.updated) || 0;
      const failedChatIds = Array.isArray(result?.failedChatIds) ? result.failedChatIds.filter(Number.isSafeInteger) : [];
      const failed = failedChatIds.length || Math.max(0, chatIds.length - updated);
      status.textContent = updated + ' 个聊天已更新，' + failed + ' 个未能更新。';
      session.selected = new Set(failedChatIds);
      renderExistingHistoryTtlChats(container);
    } catch (error) {
      if (stillCurrent()) status.textContent = '应用失败：' + error.message;
    } finally {
      if (stillCurrent()) apply.disabled = session.selected.size === 0;
    }
  }

  async function loadTelegramAppThemes(container, force = false) {
    const status = container.querySelector('#setting-telegram-themes-status');
    const list = container.querySelector('#setting-telegram-themes-list');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      telegramAppThemesRequest++;
      loadedTelegramAppThemesInstance = null;
      telegramAppThemes = [];
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedTelegramAppThemesInstance === instId) return;
    const requestId = ++telegramAppThemesRequest;
    const stillCurrent = () => requestId === telegramAppThemesRequest && state.clientSelectedInstance === instId;
    status.textContent = '正在读取 Telegram 主题…';
    try {
      const themes = await api(`/api/instances/${encodeURIComponent(instId)}/account/app-themes`);
      if (!stillCurrent()) return;
      telegramAppThemes = Array.isArray(themes) ? themes.filter(theme => theme && typeof theme.slug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(theme.slug) && typeof theme.title === 'string').slice(0, 200) : [];
      loadedTelegramAppThemesInstance = instId;
      const savedSlug = localStorage.getItem(`tg_telegram_app_theme_${instId}`) || '';
      const savedTheme = telegramAppThemes.find(theme => theme.slug === savedSlug);
      if (savedTheme) applyTelegramAppThemeLocally(instId, savedTheme);
      else document.documentElement?.style?.removeProperty?.('--color-primary');
      renderTelegramAppThemes(container, instId);
      status.textContent = telegramAppThemes.length ? `${telegramAppThemes.length} 个主题；选择“安装并应用”后由 Telegram 保存安装状态。` : 'Telegram 当前未返回可安装主题。';
    } catch (error) {
      if (!stillCurrent()) return;
      loadedTelegramAppThemesInstance = null;
      status.textContent = `无法读取 Telegram 主题：${error.message}`;
    }
  }

  function renderTelegramAppThemes(container, instId) {
    const list = container.querySelector('#setting-telegram-themes-list');
    if (!list) return;
    list.replaceChildren();
    const selectedSlug = localStorage.getItem(`tg_telegram_app_theme_${instId}`) || '';
    for (const theme of telegramAppThemes) {
      const card = document.createElement('div');
      card.className = `settings-telegram-theme-card${theme.slug === selectedSlug ? ' active' : ''}`;
      const colors = Array.isArray(theme.messageColors) ? theme.messageColors.filter(color => Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF).slice(0, 4) : [];
      if (!colors.length && Number.isInteger(theme.accentColor)) colors.push(theme.accentColor);
      if (colors.length) {
        const swatches = document.createElement('div'); swatches.className = 'settings-telegram-theme-swatches';
        for (const color of colors) {
          const swatch = document.createElement('span'); swatch.style.backgroundColor = `#${color.toString(16).padStart(6, '0')}`;
          swatches.appendChild(swatch);
        }
        card.appendChild(swatches);
      }
      const title = document.createElement('strong'); title.textContent = `${theme.emoticon ? `${theme.emoticon} ` : ''}${theme.title}`;
      const description = document.createElement('span'); description.textContent = theme.dark ? '暗色基础主题' : '浅色基础主题';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary btn-xs';
      button.textContent = theme.slug === selectedSlug ? '已在此网页应用' : '安装并应用';
      button.onclick = () => { void installTelegramAppTheme(container, instId, theme, button); };
      card.append(title, description, button);
      list.appendChild(card);
    }
  }

  function applyTelegramAppThemeLocally(instId, theme) {
    localStorage.setItem(`tg_telegram_app_theme_${instId}`, theme.slug);
    if (Number.isInteger(theme.accentColor) && theme.accentColor >= 0 && theme.accentColor <= 0xFFFFFF) {
      document.documentElement?.style?.setProperty?.('--color-primary', `#${theme.accentColor.toString(16).padStart(6, '0')}`);
    } else document.documentElement?.style?.removeProperty?.('--color-primary');
    if (window.ThemeManager) window.ThemeManager.set(theme.dark ? 'dark' : 'light');
    const container = document.getElementById('view-settings');
    container?.querySelectorAll?.('input[name="theme"]')?.forEach(radio => {
      radio.checked = radio.value === (theme.dark ? 'dark' : 'light');
      radio.closest?.('.theme-option')?.classList?.toggle?.('active', radio.checked);
    });
  }

  async function installTelegramAppTheme(container, instId, theme, button) {
    const requestId = ++telegramAppThemesRequest;
    const stillCurrent = () => requestId === telegramAppThemesRequest && state.clientSelectedInstance === instId;
    const status = container.querySelector('#setting-telegram-themes-status');
    button.disabled = true;
    if (status) status.textContent = `正在通过 Telegram 安装“${theme.title}”…`;
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/app-theme`, 'POST', { slug: theme.slug, dark: Boolean(theme.dark) });
      if (!stillCurrent()) return;
      applyTelegramAppThemeLocally(instId, theme);
      renderTelegramAppThemes(container, instId);
      if (status) status.textContent = `“${theme.title}”已由 Telegram 安装；网页已应用基础明暗和强调色。`;
    } catch (error) {
      if (stillCurrent() && status) status.textContent = `安装 Telegram 主题失败：${error.message}`;
    } finally {
      if (stillCurrent()) button.disabled = false;
    }
  }

  async function loadAuthorizations(container, force = false) {
    const list = container.querySelector('#setting-authorizations-list');
    const status = container.querySelector('#setting-authorizations-status');
    const refresh = container.querySelector('#btn-refresh-authorizations');
    if (!list || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      authorizationRequest++;
      loadedAuthorizationInstance = null;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedAuthorizationInstance === instId) return;
    loadedAuthorizationInstance = instId;
    const requestId = ++authorizationRequest;
    status.textContent = '正在读取 Telegram 登录设备…';
    if (refresh) refresh.disabled = true;
    const stillCurrent = () => requestId === authorizationRequest && state.clientSelectedInstance === instId;
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/authorizations`);
      if (!stillCurrent()) return;
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      list.replaceChildren();
      for (const session of sessions) {
        const card = document.createElement('div'); card.className = 'settings-authorization-card';
        const info = document.createElement('div'); info.className = 'settings-authorization-info';
        const name = document.createElement('strong');
        name.textContent = [session.appName, session.appVersion].filter(Boolean).join(' ') || session.deviceModel || 'Telegram 登录设备';
        if (session.current) name.textContent += ' · 当前设备';
        info.appendChild(name);
        const details = document.createElement('span');
        details.textContent = [session.deviceModel, session.platform, session.systemVersion].filter(Boolean).join(' · ');
        info.appendChild(details);
        const location = document.createElement('span');
        location.textContent = [session.ip, session.country, session.region].filter(Boolean).join(' · ');
        if (location.textContent) info.appendChild(location);
        const active = Number(session.dateActive);
        if (active > 0) {
          const date = document.createElement('time');
          date.dateTime = new Date(active * 1000).toISOString();
          date.textContent = `最近活跃：${new Date(active * 1000).toLocaleString()}`;
          info.appendChild(date);
        }
        card.appendChild(info);
        if (!session.current && typeof session.hash === 'string' && /^-?\d{1,20}$/.test(session.hash)) {
          const revoke = document.createElement('button'); revoke.type = 'button';
          revoke.className = 'btn btn-secondary btn-xs'; revoke.textContent = '终止';
          revoke.onclick = async () => {
            if (!stillCurrent()) return;
            if (!window.confirm('终止此 Telegram 登录会话？')) return;
            revoke.disabled = true;
            try {
              await api(`/api/instances/${encodeURIComponent(instId)}/account/authorization/revoke`, 'POST', { hash: session.hash });
              if (!stillCurrent()) return;
              showToast('登录会话已终止', 'success');
              loadedAuthorizationInstance = null;
              await loadAuthorizations(container, true);
            } catch (error) {
              if (stillCurrent()) showToast(`终止登录会话失败：${error.message}`, 'error');
            } finally {
              revoke.disabled = false;
            }
          };
          card.appendChild(revoke);
        }
        list.appendChild(card);
      }
      const ttl = Number(result?.authorizationTtlDays) || 0;
      status.textContent = sessions.length ? `共 ${sessions.length} 个登录设备${ttl ? ` · 会话有效期 ${ttl} 天` : ''}` : 'Telegram 未返回登录设备。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取登录设备：${error.message}`;
    } finally {
      if (stillCurrent() && refresh) refresh.disabled = false;
    }
  }

  async function loadAccountPrivacy(container, force = false) {
    const list = container.querySelector('#setting-account-privacy-list');
    const status = container.querySelector('#setting-account-privacy-status');
    const refresh = container.querySelector('#btn-refresh-account-privacy');
    if (!list || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      privacyRequest++;
      loadedPrivacyInstance = null;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedPrivacyInstance === instId) return;
    loadedPrivacyInstance = instId;
    const requestId = ++privacyRequest;
    const stillCurrent = () => requestId === privacyRequest && state.clientSelectedInstance === instId;
    status.textContent = '正在读取 Telegram 隐私规则…';
    if (refresh) refresh.disabled = true;
    try {
      const settings = await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-settings`);
      if (!stillCurrent()) return;
      list.replaceChildren();
      for (const setting of Array.isArray(settings) ? settings : []) {
        const row = document.createElement('div'); row.className = 'settings-account-privacy-row';
        const info = document.createElement('div'); info.className = 'settings-account-privacy-info';
        const title = document.createElement('strong'); title.textContent = String(setting.title || setting.key || '隐私设置');
        const exceptions = setting.exceptions || {};
        const exceptionCount = Number(exceptions.allowedUsers || 0) + Number(exceptions.blockedUsers || 0) +
          Number(exceptions.allowedChats || 0) + Number(exceptions.blockedChats || 0) + Number(exceptions.otherRules || 0);
        const detail = document.createElement('span');
        detail.textContent = !setting.available ? 'Telegram 暂不支持读取此项。' : exceptionCount
          ? `已有 ${exceptionCount} 条例外或特殊规则；更改基础范围时会保留。` : '未检测到额外例外规则。';
        info.append(title, detail);
        if (setting.available) {
          const manage = document.createElement('button'); manage.type = 'button';
          manage.className = 'btn btn-secondary btn-xs'; manage.textContent = '查看并管理例外';
          const exceptionList = document.createElement('div'); exceptionList.className = 'settings-privacy-exceptions'; exceptionList.hidden = true;
          const specialManage = document.createElement('button'); specialManage.type = 'button';
          specialManage.className = 'btn btn-secondary btn-xs'; specialManage.textContent = '管理特殊规则';
          const specialPanel = document.createElement('div'); specialPanel.className = 'settings-privacy-exceptions'; specialPanel.hidden = true;
          const addButton = document.createElement('button'); addButton.type = 'button'; addButton.className = 'btn btn-secondary btn-xs'; addButton.textContent = '添加例外';
          const addPanel = document.createElement('div'); addPanel.className = 'settings-privacy-exception-add'; addPanel.hidden = true;
          const addCategory = document.createElement('select'); addCategory.className = 'form-select';
          for (const [value, label] of [['allowedUsers', '允许此用户'], ['blockedUsers', '不允许此用户'], ['allowedChats', '允许此群组成员'], ['blockedChats', '不允许此群组成员']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = label; addCategory.appendChild(option);
          }
          addCategory.value = 'allowedUsers';
          const contactSearch = document.createElement('input'); contactSearch.type = 'search'; contactSearch.className = 'form-input'; contactSearch.placeholder = '搜索联系人'; contactSearch.maxLength = 128;
          contactSearch.setAttribute('aria-label', '搜索 Telegram 联系人或用户');
          const searchScope = document.createElement('button'); searchScope.type = 'button'; searchScope.className = 'btn btn-secondary btn-xs'; searchScope.textContent = '搜索 Telegram 用户';
          const searchRemote = document.createElement('button'); searchRemote.type = 'button'; searchRemote.className = 'btn btn-secondary btn-xs'; searchRemote.textContent = '搜索'; searchRemote.hidden = true;
          const contactSelect = document.createElement('select'); contactSelect.className = 'form-select'; contactSelect.setAttribute('aria-label', '选择 Telegram 用户');
          const addStatus = document.createElement('span');
          const applyAdd = document.createElement('button'); applyAdd.type = 'button'; applyAdd.className = 'btn btn-primary btn-xs'; applyAdd.textContent = '添加'; applyAdd.disabled = true;
          addPanel.append(addCategory, contactSearch, searchScope, searchRemote, contactSelect, applyAdd, addStatus);
          let contactsLoaded = false;
          let accountContacts = [];
          let searchedEntities = [];
          let searchMode = 'contacts';
          let searchRequest = 0;
          const setSearchMode = mode => {
            searchMode = mode;
            contactSearch.value = '';
            searchedEntities = [];
            searchRemote.disabled = false;
            searchRemote.hidden = searchMode === 'contacts';
            searchScope.textContent = searchMode === 'contacts' ? '搜索 Telegram 用户' : searchMode === 'users' ? '搜索 Telegram 群组' : '返回联系人';
            contactSearch.placeholder = searchMode === 'contacts' ? '搜索联系人或群组' : searchMode === 'users' ? '输入用户名或姓名' : '输入群组名称';
            addStatus.textContent = searchMode === 'contacts' ? '可选择已加载的联系人或群组。' : searchMode === 'users' ? '输入用户名或姓名后点击搜索。' : '输入群组名称后点击搜索。';
          };
          const renderContactOptions = () => {
            const query = String(contactSearch.value || '').trim().toLocaleLowerCase();
            const selected = contactSelect.value;
            contactSelect.replaceChildren();
            const isGroupException = addCategory.value.endsWith('Chats');
            const source = searchMode === 'contacts'
              ? (isGroupException ? (state.clientDialogs || []).filter(item => ['group', 'supergroup'].includes(item.type)) : accountContacts)
              : searchedEntities;
            const filtered = source.filter(contact => {
              const label = [contact.title, contact.firstName, contact.lastName, contact.username && `@${contact.username}`].filter(Boolean).join(' ').toLocaleLowerCase();
              const groupResult = contact.type === 'group' || contact.type === 'supergroup';
              const eligible = isGroupException ? groupResult : (!groupResult && (!contact.type || contact.type === 'private') && !contact.isBot);
              return eligible && (!query || label.includes(query));
            }).slice(0, 100);
            for (const contact of filtered) {
              const id = Number(contact.id);
              if (!Number.isSafeInteger(id) || id === 0 || (isGroupException ? id >= 0 : id <= 0)) continue;
              const option = document.createElement('option'); option.value = String(contact.id);
              option.textContent = contact.title || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || (contact.username ? `@${contact.username}` : `${isGroupException ? 'Telegram 群组' : 'Telegram 用户'} ${contact.id}`);
              contactSelect.appendChild(option);
            }
            if (filtered.some(contact => String(contact.id) === selected)) contactSelect.value = selected;
            applyAdd.disabled = !contactSelect.value;
            if (!contactSelect.children.length && contactsLoaded) {
              addStatus.textContent = searchMode === 'contacts'
                ? (isGroupException ? '没有已加载的群组，请搜索 Telegram 群组。' : (query ? '没有匹配的联系人。' : '此账号没有可添加的联系人。'))
                : (query ? `没有可添加的${searchMode === 'groups' ? '群组' : '用户'}，请尝试其他名称。` : `输入${searchMode === 'groups' ? '群组名称' : '用户名或姓名'}后点击搜索。`);
            }
          };
          addButton.onclick = async () => {
            if (!stillCurrent()) return;
            addPanel.hidden = !addPanel.hidden;
            if (addPanel.hidden) return;
            addButton.disabled = true; addStatus.textContent = '正在读取 Telegram 联系人…';
            try {
              if (!contactsLoaded) {
                const contacts = await api(`/api/instances/${encodeURIComponent(instId)}/account/contacts`);
                if (!stillCurrent()) return;
                accountContacts = Array.isArray(contacts) ? contacts : [];
                contactsLoaded = true;
              }
              renderContactOptions();
              addStatus.textContent = contactSelect.children.length ? '可从当前账号的联系人或已加载群组中选择，也可搜索其他 Telegram 用户或群组。' : addStatus.textContent;
            } catch (error) {
              if (stillCurrent()) addStatus.textContent = `无法读取联系人：${error.message}`;
            } finally {
              if (stillCurrent()) addButton.disabled = false;
            }
          };
          searchScope.onclick = () => {
            if (!stillCurrent()) return;
            searchRequest++;
            const modes = ['contacts', 'users', 'groups'];
            setSearchMode(modes[(modes.indexOf(searchMode) + 1) % modes.length]);
            renderContactOptions();
          };
          addCategory.onchange = () => {
            if (!stillCurrent()) return;
            searchRequest++;
            const groupException = addCategory.value.endsWith('Chats');
            if (groupException && searchMode !== 'groups') setSearchMode('groups');
            else if (!groupException && searchMode === 'groups') setSearchMode('contacts');
            renderContactOptions();
          };
          contactSearch.oninput = () => {
            if (searchMode === 'contacts') renderContactOptions();
            else { searchRequest++; searchRemote.disabled = false; searchedEntities = []; renderContactOptions(); }
          };
          searchRemote.onclick = async () => {
            const query = String(contactSearch.value || '').trim();
            if (!stillCurrent() || searchMode === 'contacts' || !query || query.length > 128) return;
            const currentSearch = ++searchRequest;
            const searchingGroups = searchMode === 'groups';
            searchRemote.disabled = true; addStatus.textContent = `正在搜索 Telegram ${searchingGroups ? '群组' : '用户'}…`;
            try {
              const results = await api(`/api/instances/${encodeURIComponent(instId)}/account/search-dialogs?query=${encodeURIComponent(query)}`);
              if (!stillCurrent() || currentSearch !== searchRequest) return;
              searchedEntities = (Array.isArray(results) ? results : []).filter(entity => {
                const id = Number(entity?.id);
                const groupResult = entity?.type === 'group' || entity?.type === 'supergroup';
                return Number.isSafeInteger(id) && (searchingGroups
                  ? groupResult && id < 0
                  : entity?.type === 'private' && !entity.isBot && id > 0);
              });
              renderContactOptions();
              addStatus.textContent = contactSelect.children.length ? `从 Telegram 搜索结果中选择${searchingGroups ? '群组' : '用户'}。` : `没有可添加的${searchingGroups ? '群组' : '用户'}，请尝试完整名称。`;
            } catch (error) {
              if (stillCurrent() && currentSearch === searchRequest) addStatus.textContent = `搜索失败：${error.message}`;
            } finally {
              if (stillCurrent() && currentSearch === searchRequest) searchRemote.disabled = false;
            }
          };
          contactSelect.onchange = () => { applyAdd.disabled = !contactSelect.value; };
          applyAdd.onclick = async () => {
            const entityId = String(contactSelect.value || '');
            const isGroupException = addCategory.value.endsWith('Chats');
            const chatId = Number(entityId);
            if (!stillCurrent() || (isGroupException
              ? (!Number.isSafeInteger(chatId) || chatId >= 0)
              : (!/^\d{1,20}$/.test(entityId) || /^0+$/.test(entityId)))) return;
            applyAdd.disabled = true; addStatus.textContent = '正在更新 Telegram 隐私规则…';
            try {
              const body = { operation: 'add', key: setting.key, category: addCategory.value };
              if (isGroupException) body.chatId = chatId;
              else body.entityId = entityId;
              await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-exceptions`, 'POST', body);
              if (state.clientSelectedInstance !== instId) return;
              loadedPrivacyInstance = null;
              await loadAccountPrivacy(container, true);
              showToast(`已更新“${title.textContent}”例外`, 'success');
            } catch (error) {
              if (stillCurrent()) { addStatus.textContent = `添加失败：${error.message}`; applyAdd.disabled = !contactSelect.value; }
            }
          };
          let exceptionRequest = 0;
          manage.onclick = async () => {
            if (!stillCurrent()) return;
            if (!exceptionList.hidden) {
              exceptionRequest++;
              exceptionList.hidden = true;
              manage.textContent = '查看并管理例外';
              return;
            }
            const currentExceptionRequest = ++exceptionRequest;
            exceptionList.hidden = false;
            exceptionList.textContent = '正在读取用户和群组例外…';
            manage.disabled = true;
            try {
              const entries = await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-exceptions?key=${encodeURIComponent(setting.key)}`);
              if (!stillCurrent() || currentExceptionRequest !== exceptionRequest) return;
              exceptionList.replaceChildren(addButton, addPanel);
              const exceptionItems = Array.isArray(entries) ? entries : [];
              if (!exceptionItems.length) {
                const empty = document.createElement('span'); empty.textContent = '没有可管理的用户或群组例外。';
                exceptionList.appendChild(empty);
              }
              for (const exception of exceptionItems) {
                const item = document.createElement('div'); item.className = 'settings-privacy-exception';
                const name = document.createElement('span'); name.textContent = String(exception.title || `Telegram ${exception.kind === 'chat' ? '群组' : '用户'} ${exception.id}`);
                const labels = {
                  allowedUsers: '允许用户', blockedUsers: '不允许用户',
                  allowedChats: '允许群组成员', blockedChats: '不允许群组成员',
                };
                const category = document.createElement('span'); category.textContent = labels[exception.category] || '隐私例外';
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary btn-xs'; remove.textContent = '移除';
                remove.onclick = async () => {
                  if (!stillCurrent() || remove.disabled || !window.confirm(`从“${title.textContent}”中移除此隐私例外？`)) return;
                  remove.disabled = true;
                  try {
                    await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-exceptions`, 'POST', {
                      key: setting.key, category: exception.category, entityId: String(exception.id),
                    });
                    if (state.clientSelectedInstance !== instId) return;
                    loadedPrivacyInstance = null;
                    await loadAccountPrivacy(container, true);
                    showToast(`已从“${title.textContent}”中移除此例外`, 'success');
                  } catch (error) {
                    if (stillCurrent()) { status.textContent = `移除隐私例外失败：${error.message}`; remove.disabled = false; }
                  }
                };
                item.append(name, category, remove); exceptionList.appendChild(item);
              }
              manage.textContent = `${exceptionItems.length} 条可管理例外`;
            } catch (error) {
              if (stillCurrent() && currentExceptionRequest === exceptionRequest) exceptionList.textContent = `无法读取隐私例外：${error.message}`;
            } finally {
              if (stillCurrent() && currentExceptionRequest === exceptionRequest) manage.disabled = false;
            }
          };
          specialManage.onclick = async () => {
            if (!stillCurrent()) return;
            if (!specialPanel.hidden) {
              specialPanel.hidden = true;
              specialManage.textContent = '管理特殊规则';
              return;
            }
            specialPanel.hidden = false;
            specialPanel.textContent = '正在读取 Telegram 特殊规则…';
            specialManage.disabled = true;
            try {
              const rules = await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-special-rules?key=${encodeURIComponent(setting.key)}`);
              if (!stillCurrent()) return;
              specialPanel.replaceChildren();
              const save = async (field, value, control, previous) => {
                control.disabled = true;
                try {
                  await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-special-rules`, 'POST', { key: setting.key, field, value });
                  if (!stillCurrent()) return;
                  loadedPrivacyInstance = null;
                  await loadAccountPrivacy(container, true);
                  if (stillCurrent()) showToast(`已更新“${title.textContent}”特殊规则`, 'success');
                } catch (error) {
                  if (stillCurrent()) {
                    if (control.type === 'checkbox') control.checked = previous;
                    else control.value = previous;
                    control.disabled = false;
                    specialStatus.textContent = `更新失败：${error.message}`;
                  }
                }
              };
              const premiumRow = document.createElement('label'); premiumRow.className = 'settings-privacy-special-row';
              const premium = document.createElement('input'); premium.type = 'checkbox'; premium.checked = Boolean(rules.allowPremium);
              const premiumText = document.createElement('span'); premiumText.textContent = '允许 Telegram Premium 用户';
              premiumRow.append(premium, premiumText);
              premium.onchange = () => { const previous = !premium.checked; save('allowPremium', premium.checked, premium, previous); };
              const botsRow = document.createElement('label'); botsRow.className = 'settings-privacy-special-row';
              const botsText = document.createElement('span'); botsText.textContent = '机器人规则';
              const bots = document.createElement('select'); bots.className = 'form-select';
              for (const [value, label] of [['default', '不额外限制'], ['allow', '允许机器人'], ['deny', '禁止机器人']]) {
                const option = document.createElement('option'); option.value = value; option.textContent = label; bots.appendChild(option);
              }
              bots.value = ['default', 'allow', 'deny'].includes(rules.botAccess) ? rules.botAccess : 'default';
              botsRow.append(botsText, bots);
              bots.onchange = () => save('botAccess', bots.value, bots, rules.botAccess || 'default');
              const specialStatus = document.createElement('span'); specialStatus.className = 'settings-desc';
              specialStatus.textContent = rules.editable === false
                ? `当前规则包含 ${Number(rules.unsupportedRules || 0)} 项此客户端无法安全保留的内容，已禁用编辑。`
                : '规则写入 Telegram 账号；不支持的规则会由 Telegram 拒绝。';
              if (rules.editable === false) { premium.disabled = true; bots.disabled = true; }
              specialPanel.append(premiumRow, botsRow, specialStatus);
            } catch (error) {
              if (stillCurrent()) specialPanel.textContent = `无法读取 Telegram 特殊规则：${error.message}`;
            } finally {
              if (stillCurrent()) specialManage.disabled = false;
            }
          };
          info.append(manage, exceptionList, specialManage, specialPanel);
        }
        const select = document.createElement('select'); select.className = 'form-select';
        const choices = [['everybody', '所有人'], ['contacts', '我的联系人'], ['nobody', '无人']];
        if (setting.mode === 'custom' || setting.mode === 'unavailable') {
          const option = document.createElement('option'); option.value = setting.mode; option.textContent = setting.available ? '复杂规则（只读）' : '不可用';
          select.appendChild(option); select.value = setting.mode;
        }
        for (const [value, label] of choices) {
          const option = document.createElement('option'); option.value = value; option.textContent = label;
          select.appendChild(option);
        }
        select.value = setting.mode;
        select.disabled = !setting.available || setting.mode === 'custom';
        select.setAttribute('aria-label', `${title.textContent}可见范围`);
        select.onchange = async () => {
          if (!stillCurrent() || select.disabled) return;
          const previous = setting.mode;
          const mode = select.value;
          select.disabled = true;
          status.textContent = `正在更新“${title.textContent}”…`;
          try {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/privacy-settings`, 'POST', { key: setting.key, mode });
            if (!stillCurrent()) return;
            loadedPrivacyInstance = null;
            await loadAccountPrivacy(container, true);
            if (stillCurrent()) showToast(`已更新“${title.textContent}”`, 'success');
          } catch (error) {
            if (stillCurrent()) {
              select.value = previous;
              status.textContent = `更新失败：${error.message}`;
              select.disabled = false;
            }
          }
        };
        row.append(info, select); list.appendChild(row);
      }
      status.textContent = `${list.children.length} 项 Telegram 隐私设置`;
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram 隐私设置：${error.message}`;
    } finally {
      if (stillCurrent() && refresh) refresh.disabled = false;
    }
  }

  async function loadAccountGlobalPrivacySettings(container, force = false) {
    const list = container.querySelector('#setting-global-privacy-list');
    const status = container.querySelector('#setting-global-privacy-status');
    const refresh = container.querySelector('#btn-refresh-global-privacy');
    if (!list || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      globalPrivacyRequest++;
      loadedGlobalPrivacyInstance = null;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedGlobalPrivacyInstance === instId) return;
    loadedGlobalPrivacyInstance = instId;
    const requestId = ++globalPrivacyRequest;
    const stillCurrent = () => requestId === globalPrivacyRequest && state.clientSelectedInstance === instId;
    status.textContent = '正在读取 Telegram 全局隐私设置…';
    if (refresh) refresh.disabled = true;
    try {
      const settings = await api(`/api/instances/${encodeURIComponent(instId)}/account/global-privacy-settings`);
      if (!stillCurrent()) return;
      list.replaceChildren();
      for (const setting of Array.isArray(settings) ? settings : []) {
        const row = document.createElement('div'); row.className = 'settings-account-privacy-row';
        const info = document.createElement('div'); info.className = 'settings-account-privacy-info';
        const title = document.createElement('strong'); title.textContent = String(setting.title || setting.key || '全局隐私');
        const description = document.createElement('span'); description.textContent = String(setting.description || '');
        info.append(title, description);
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = Boolean(setting.value);
        toggle.setAttribute('aria-label', `${title.textContent}开关`);
        toggle.onchange = async () => {
          if (!stillCurrent() || toggle.disabled) return;
          const previous = Boolean(setting.value);
          toggle.disabled = true;
          status.textContent = `正在更新“${title.textContent}”…`;
          try {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/global-privacy-settings`, 'POST', { key: setting.key, value: toggle.checked });
            if (!stillCurrent()) return;
            setting.value = toggle.checked;
            status.textContent = `“${title.textContent}”已保存。`;
          } catch (error) {
            if (stillCurrent()) {
              toggle.checked = previous;
              status.textContent = `保存失败：${error.message}`;
            }
          } finally {
            if (stillCurrent()) toggle.disabled = false;
          }
        };
        row.append(info, toggle); list.appendChild(row);
      }
      status.textContent = `${list.children.length} 项 Telegram 全局隐私设置`;
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram 全局隐私设置：${error.message}`;
    } finally {
      if (stillCurrent() && refresh) refresh.disabled = false;
    }
  }

  async function loadAccountStars(container, append = false, force = false) {
    const status = container.querySelector('#setting-stars-status');
    const balance = container.querySelector('#setting-stars-balance');
    const history = container.querySelector('#setting-stars-history');
    const more = container.querySelector('#btn-more-stars');
    const refresh = container.querySelector('#btn-refresh-stars');
    if (!status || !balance || !history) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      starsRequest++;
      loadedStarsInstance = null;
      starsNextOffset = '';
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      balance.textContent = '—'; history.replaceChildren();
      if (more) more.hidden = true;
      return;
    }
    if (append && !starsNextOffset) return;
    if (!append && !force && loadedStarsInstance === instId) return;
    loadedStarsInstance = instId;
    const requestId = ++starsRequest;
    const offset = append ? starsNextOffset : '';
    const stillCurrent = () => requestId === starsRequest && state.clientSelectedInstance === instId;
    if (!append) { starsNextOffset = ''; history.replaceChildren(); }
    status.textContent = append ? '正在读取更多 Stars 记录…' : '正在读取 Telegram Stars…';
    if (refresh) refresh.disabled = true;
    if (more) more.disabled = true;
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/stars?offset=${encodeURIComponent(offset)}&limit=20`);
      if (!stillCurrent()) return;
      const formatAmount = value => {
        const raw = String(value?.amount ?? '0');
        const grouped = /^-?\d+$/.test(raw) ? raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0';
        const nanos = Math.max(0, Math.min(999999999, Number(value?.nanos) || 0));
        const fraction = nanos ? `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}` : '';
        return `${grouped}${fraction}`;
      };
      balance.textContent = `${formatAmount(result?.balance)} ⭐`;
      const transactions = Array.isArray(result?.transactions) ? result.transactions : [];
      for (const transaction of transactions) {
        const row = document.createElement('div'); row.className = 'settings-stars-transaction';
        const title = document.createElement('strong');
        title.textContent = String(transaction.title || transaction.description || 'Stars 交易');
        const detail = document.createElement('span');
        const timestamp = Number(transaction.date);
        const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toLocaleString() : '时间未知';
        const stateLabel = ({ pending: '处理中', failed: '失败', refund: '退款', complete: '完成' })[transaction.status] || '完成';
        detail.textContent = `${formatAmount(transaction.stars)} ⭐ · ${stateLabel} · ${date}`;
        row.append(title, detail); history.appendChild(row);
      }
      starsNextOffset = typeof result?.nextOffset === 'string' ? result.nextOffset : '';
      if (more) more.hidden = !starsNextOffset;
      status.textContent = transactions.length || append ? `已加载 ${history.children.length} 条 Stars 记录。` : '暂无 Stars 交易记录。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram Stars：${error.message}`;
    } finally {
      if (stillCurrent()) {
        if (refresh) refresh.disabled = false;
        if (more) more.disabled = false;
      }
    }
  }

  async function loadAccountStarsTopupOptions(container, force = false) {
    const status = container.querySelector('#setting-stars-topup-status');
    const list = container.querySelector('#setting-stars-topup-options');
    const verification = container.querySelector('#setting-stars-topup-verification');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      starsTopupRequest++;
      loadedStarsTopupInstance = null;
      list.replaceChildren();
      status.textContent = '请选择一个已登录账号后读取购买选项。';
      if (verification) verification.hidden = true;
      return;
    }
    if (!force && loadedStarsTopupInstance === instId) return;
    loadedStarsTopupInstance = instId;
    const requestId = ++starsTopupRequest;
    const stillCurrent = () => requestId === starsTopupRequest && state.clientSelectedInstance === instId;
    list.replaceChildren();
    if (verification) verification.hidden = true;
    status.textContent = '正在读取 Telegram Stars 购买选项…';
    try {
      const options = await api(`/api/instances/${encodeURIComponent(instId)}/account/stars-topup-options`);
      if (!stillCurrent()) return;
      for (const option of Array.isArray(options) ? options : []) {
        if (!option || typeof option.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(option.id) ||
            typeof option.stars !== 'string' || !/^\d{1,20}$/.test(option.stars) ||
            typeof option.currency !== 'string' || !/^[A-Z]{3}$/.test(option.currency) ||
            typeof option.amount !== 'string' || !/^\d{1,20}$/.test(option.amount)) continue;
        const row = document.createElement('div'); row.className = 'settings-stars-topup-option';
        const info = document.createElement('div'); info.className = 'settings-stars-topup-info';
        const title = document.createElement('strong');
        title.textContent = `${option.stars.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} Stars${option.extended ? ' · 加量套餐' : ''}`;
        const detail = document.createElement('span');
        const rawAmount = Number(option.amount);
        let price = `${option.amount} ${option.currency}`;
        try {
          const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: option.currency });
          const digits = formatter.resolvedOptions().maximumFractionDigits;
          if (Number.isSafeInteger(rawAmount)) price = formatter.format(rawAmount / (10 ** digits));
        } catch { /* Keep Telegram's exact amount and currency as a fallback. */ }
        detail.textContent = price;
        info.append(title, detail);
        const buy = document.createElement('button'); buy.type = 'button'; buy.className = 'btn btn-secondary btn-sm';
        buy.textContent = '购买';
        buy.onclick = () => prepareStarsTopup(container, instId, option, buy);
        row.append(info, buy); list.appendChild(row);
      }
      status.textContent = list.children.length ? '套餐价格来自 Telegram；选择后会重新读取付款表单并要求确认。' : 'Telegram 当前没有可用的 Stars 购买选项。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram Stars 购买选项：${error.message}`;
    }
  }

  async function prepareStarsTopup(container, instId, option, button) {
    const status = container.querySelector('#setting-stars-topup-status');
    const verification = container.querySelector('#setting-stars-topup-verification');
    const requestId = starsTopupRequest;
    const stillCurrent = () => requestId === starsTopupRequest && state.clientSelectedInstance === instId;
    if (!stillCurrent() || !option?.id) return;
    button.disabled = true;
    if (verification) verification.hidden = true;
    if (status) status.textContent = '正在向 Telegram 请求最新付款金额…';
    try {
      const form = await api(`/api/instances/${encodeURIComponent(instId)}/account/stars-topup/prepare`, 'POST', { optionId: option.id });
      if (!stillCurrent()) return;
      const rawAmount = Number(form.amount);
      let price = `${form.amount} ${form.currency}`;
      try {
        const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: form.currency });
        const digits = formatter.resolvedOptions().maximumFractionDigits;
        if (Number.isSafeInteger(rawAmount)) price = formatter.format(rawAmount / (10 ** digits));
      } catch { /* Keep Telegram's exact amount as a fallback. */ }
      const details = [form.title, form.description, `购买 ${form.stars} Stars`, `Telegram 报价：${price}`]
        .filter(value => typeof value === 'string' && value.trim()).join('\n');
      if (!window.confirm(`${details}\n\n继续提交 Telegram 付款？`)) {
        if (status) status.textContent = '已取消；未提交付款。';
        return;
      }
      if (!stillCurrent()) return;
      if (status) status.textContent = '正在通过 Telegram 提交付款…';
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/stars-topup/confirm`, 'POST', { token: form.token });
      if (!stillCurrent()) return;
      if (result?.verificationUrl) {
        let url;
        try { url = new URL(result.verificationUrl); } catch { throw new Error('Telegram 返回了无效的验证地址'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Telegram 返回了不安全的验证地址');
        if (verification) { verification.href = url.href; verification.hidden = false; }
        if (status) status.textContent = 'Telegram 要求完成外部付款验证；请手动打开验证页。完成后刷新余额。';
        return;
      }
      if (status) status.textContent = `Telegram 已确认购买 ${result.stars} Stars。正在刷新余额…`;
      loadedStarsInstance = null;
      await loadAccountStars(container, false, true);
      if (stillCurrent() && status) status.textContent = `Telegram 已确认购买 ${result.stars} Stars。`;
    } catch (error) {
      if (stillCurrent() && status) status.textContent = `Stars 购买未完成：${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function loadAccountStarsSubscriptions(container, append = false, force = false) {
    const status = container.querySelector('#setting-stars-subscriptions-status');
    const list = container.querySelector('#setting-stars-subscriptions-list');
    const refresh = container.querySelector('#btn-refresh-stars-subscriptions');
    const more = container.querySelector('#btn-more-stars-subscriptions');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      starsSubscriptionsRequest++;
      loadedStarsSubscriptionsInstance = null;
      starsSubscriptionsNextOffset = '';
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      if (more) more.hidden = true;
      return;
    }
    if (append && !starsSubscriptionsNextOffset) return;
    if (!append && !force && loadedStarsSubscriptionsInstance === instId) return;
    loadedStarsSubscriptionsInstance = instId;
    const requestId = ++starsSubscriptionsRequest;
    const offset = append ? starsSubscriptionsNextOffset : '';
    const stillCurrent = () => requestId === starsSubscriptionsRequest && state.clientSelectedInstance === instId;
    if (!append) { list.replaceChildren(); starsSubscriptionsNextOffset = ''; }
    status.textContent = append ? '正在读取更多订阅…' : '正在读取 Stars 订阅…';
    if (refresh) refresh.disabled = true;
    if (more) more.disabled = true;
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/stars-subscriptions?offset=${encodeURIComponent(offset)}`);
      if (!stillCurrent()) return;
      const subscriptions = Array.isArray(result?.subscriptions) ? result.subscriptions : [];
      for (const subscription of subscriptions) {
        const row = document.createElement('div'); row.className = 'settings-stars-subscription';
        const info = document.createElement('div'); info.className = 'settings-stars-subscription-info';
        const title = document.createElement('strong'); title.textContent = String(subscription.title || 'Telegram 订阅');
        const until = Number(subscription.untilDate);
        const untilText = Number.isFinite(until) && until > 0 ? new Date(until * 1000).toLocaleDateString() : '日期未知';
        const periodDays = Math.max(1, Math.round(Number(subscription.period || 0) / 86400));
        const stateText = subscription.missingBalance ? '余额不足' : subscription.canceled ? `已取消 · 到期 ${untilText}` : `续订至 ${untilText}`;
        const detail = document.createElement('span'); detail.textContent = `${String(subscription.amount || '0')} ⭐ / ${periodDays} 天 · ${stateText}`;
        info.append(title, detail);
        const action = document.createElement('button'); action.type = 'button'; action.className = 'btn btn-secondary btn-sm';
        action.textContent = subscription.canceled ? subscription.canRefulfill ? '恢复续订' : '已取消' : '取消续订';
        action.disabled = Boolean(subscription.canceled && !subscription.canRefulfill);
        action.onclick = async () => {
          if (!stillCurrent() || action.disabled) return;
          const canceled = !subscription.canceled;
          const prompt = canceled ? `取消“${title.textContent}”的自动续订？当前订阅仍可使用至 ${untilText}。` : `恢复“${title.textContent}”的自动续订？`;
          if (!window.confirm(prompt)) return;
          action.disabled = true;
          status.textContent = '正在更新 Stars 订阅…';
          try {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/stars-subscriptions`, 'POST', {
              subscriptionId: subscription.id, canceled,
            });
            if (!stillCurrent()) return;
            loadedStarsSubscriptionsInstance = null;
            await loadAccountStarsSubscriptions(container, false, true);
          } catch (error) {
            if (stillCurrent()) { status.textContent = `订阅更新失败：${error.message}`; action.disabled = false; }
          }
        };
        row.append(info, action); list.appendChild(row);
      }
      starsSubscriptionsNextOffset = typeof result?.nextOffset === 'string' ? result.nextOffset : '';
      if (more) more.hidden = !starsSubscriptionsNextOffset;
      status.textContent = subscriptions.length || append ? `已加载 ${list.children.length} 个 Stars 订阅。` : '没有 Stars 订阅。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Stars 订阅：${error.message}`;
    } finally {
      if (stillCurrent()) {
        if (refresh) refresh.disabled = false;
        if (more) more.disabled = false;
      }
    }
  }

  function normalizeGiftCodeInput(value) {
    const input = String(value || '').trim();
    if (/^[A-Za-z0-9_-]{4,128}$/.test(input)) return input;
    let url;
    try { url = new URL(input); } catch { return ''; }
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 't.me' && !url.username && !url.password &&
        !url.port && !url.search && !url.hash) {
      return /^\/giftcode\/([A-Za-z0-9_-]{4,128})\/?$/.exec(url.pathname)?.[1] || '';
    }
    if (url.protocol === 'tg:' && url.hostname.toLowerCase() === 'giftcode' && !url.hash &&
        [...url.searchParams.keys()].every(key => key === 'slug') && url.searchParams.getAll('slug').length === 1) {
      const slug = url.searchParams.get('slug') || '';
      return /^[A-Za-z0-9_-]{4,128}$/.test(slug) ? slug : '';
    }
    return '';
  }

  async function checkAccountGiftCode(container) {
    const input = container.querySelector('#setting-gift-code-input');
    const check = container.querySelector('#btn-check-gift-code');
    const apply = container.querySelector('#btn-apply-gift-code');
    const status = container.querySelector('#setting-gift-code-status');
    if (!input || !check || !apply || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) { status.textContent = '请先选择一个已登录的 Telegram 账号。'; return; }
    const slug = normalizeGiftCodeInput(input.value);
    if (!slug) { status.textContent = '请输入有效的 Telegram 礼物代码或 t.me/giftcode 链接。'; apply.hidden = true; return; }
    const requestId = ++giftCodePreviewRequest;
    const stillCurrent = () => requestId === giftCodePreviewRequest && state.clientSelectedInstance === instId &&
      normalizeGiftCodeInput(input.value) === slug;
    giftCodePreview = null;
    apply.hidden = true;
    check.disabled = true;
    status.textContent = '正在向 Telegram 检查礼物链接…';
    try {
      const preview = await api(`/api/instances/${encodeURIComponent(instId)}/account/gift-codes/check`, 'POST', { slug });
      if (!stillCurrent()) return;
      if (!preview || preview.slug !== slug || !Number.isInteger(preview.months) || preview.months < 1 ||
          !Number.isInteger(preview.date) || typeof preview.recipientMatches !== 'boolean') throw new Error('Telegram 返回的礼物信息无效');
      giftCodePreview = { instId, slug, preview };
      const issued = preview.date ? ` · 发放于 ${new Date(preview.date * 1000).toLocaleDateString()}` : '';
      if (preview.usedDate) {
        status.textContent = `该礼物链接已于 ${new Date(preview.usedDate * 1000).toLocaleDateString()} 使用。`;
      } else if (!preview.recipientMatches) {
        status.textContent = `该链接指定给其他 Telegram 账号，无法在当前账号激活 · ${preview.months} 个月 Premium${issued}`;
      } else {
        status.textContent = `${preview.months} 个月 Telegram Premium${preview.viaGiveaway ? ' · 抽奖礼物' : ''}${issued}。激活前会再次确认。`;
        apply.hidden = false;
      }
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法检查礼物链接：${error.message}`;
    } finally {
      if (requestId === giftCodePreviewRequest) check.disabled = false;
    }
  }

  async function applyAccountGiftCode(container) {
    const apply = container.querySelector('#btn-apply-gift-code');
    const status = container.querySelector('#setting-gift-code-status');
    const input = container.querySelector('#setting-gift-code-input');
    const check = container.querySelector('#btn-check-gift-code');
    const current = giftCodePreview;
    if (!apply || !status || !input || !check || !current || current.instId !== state.clientSelectedInstance ||
        normalizeGiftCodeInput(input.value) !== current.slug || current.preview.usedDate || !current.preview.recipientMatches) {
      if (status) status.textContent = '礼物预览已失效，请重新检查链接。';
      if (apply) apply.hidden = true;
      return;
    }
    const confirmation = `确认在当前账号激活 ${current.preview.months} 个月 Telegram Premium 礼物？${current.preview.viaGiveaway ? '\n此代码来自 Telegram 抽奖。' : ''}`;
    if (!window.confirm(confirmation)) return;
    if (current !== giftCodePreview || current.instId !== state.clientSelectedInstance || normalizeGiftCodeInput(input.value) !== current.slug) return;
    const requestId = ++giftCodePreviewRequest;
    const stillCurrent = () => requestId === giftCodePreviewRequest && state.clientSelectedInstance === current.instId &&
      normalizeGiftCodeInput(input.value) === current.slug;
    apply.disabled = true; check.disabled = true;
    status.textContent = '正在请求 Telegram 激活礼物…';
    try {
      const result = await api(`/api/instances/${encodeURIComponent(current.instId)}/account/gift-codes/apply`, 'POST', { slug: current.slug });
      if (!stillCurrent()) return;
      if (!result || result.applied !== true) throw new Error('Telegram 未确认礼物已激活');
      giftCodePreview = null;
      apply.hidden = true;
      input.value = '';
      status.textContent = `已激活 ${result.months} 个月 Telegram Premium。`;
      if (window.showToast) window.showToast('Telegram Premium 礼物已激活', 'success');
    } catch (error) {
      if (stillCurrent()) status.textContent = `激活失败：${error.message}`;
    } finally {
      if (requestId === giftCodePreviewRequest) { apply.disabled = false; check.disabled = false; }
    }
  }

  async function loadAccountStarGifts(container, force = false) {
    const status = container.querySelector('#setting-star-gifts-status');
    const list = container.querySelector('#setting-star-gifts-list');
    const refresh = container.querySelector('#btn-refresh-star-gifts');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      starGiftsRequest++;
      loadedStarGiftsInstance = null;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedStarGiftsInstance === instId) return;
    loadedStarGiftsInstance = instId;
    const requestId = ++starGiftsRequest;
    const stillCurrent = () => requestId === starGiftsRequest && state.clientSelectedInstance === instId;
    status.textContent = '正在读取 Telegram 礼物目录…';
    if (refresh) refresh.disabled = true;
    try {
      const gifts = await api(`/api/instances/${encodeURIComponent(instId)}/account/star-gifts`);
      if (!stillCurrent()) return;
      list.replaceChildren();
      const items = Array.isArray(gifts) ? gifts : [];
      for (const gift of items) {
        const card = document.createElement('div'); card.className = 'settings-star-gift';
        const image = document.createElement('img'); image.className = 'settings-star-gift-image';
        image.alt = String(gift.sticker?.emoji || 'Telegram 礼物'); image.loading = 'lazy';
        const emoji = document.createElement('span'); emoji.className = 'settings-star-gift-emoji';
        emoji.textContent = String(gift.sticker?.emoji || '🎁'); emoji.hidden = true;
        const docId = String(gift.sticker?.id || '');
        const accessHash = String(gift.sticker?.accessHash || '');
        if (/^\d{1,20}$/.test(docId) && /^-?\d{1,20}$/.test(accessHash) && !/^0+$/.test(docId) && !/^-?0+$/.test(accessHash)) {
          image.src = `/api/instances/${encodeURIComponent(instId)}/account/sticker-thumb?docId=${encodeURIComponent(docId)}&accessHash=${encodeURIComponent(accessHash)}&fileRef=${encodeURIComponent(String(gift.sticker?.fileReference || ''))}`;
          image.onload = () => { emoji.hidden = true; };
          image.onerror = () => { image.hidden = true; emoji.hidden = false; };
        } else image.hidden = true;
        if (image.hidden) emoji.hidden = false;
        const details = document.createElement('div'); details.className = 'settings-star-gift-details';
        const title = document.createElement('strong'); title.textContent = `${String(gift.sticker?.emoji || '🎁')} 礼物`;
        const price = document.createElement('span'); price.textContent = `${String(gift.stars || '0')} ⭐`;
        const availability = document.createElement('span');
        availability.textContent = gift.soldOut ? '已售罄' : gift.limited && gift.availabilityRemains != null
          ? `限量 · 剩余 ${Number(gift.availabilityRemains)}` : '可用';
        const actions = document.createElement('div'); actions.className = 'settings-star-gift-actions';
        const hideNameLabel = document.createElement('label');
        const hideName = document.createElement('input'); hideName.type = 'checkbox';
        hideNameLabel.append(hideName, document.createTextNode('隐藏姓名'));
        actions.appendChild(hideNameLabel);
        let includeUpgrade;
        if (gift.upgradeStars && /^\d{1,20}$/.test(String(gift.upgradeStars))) {
          const upgradeLabel = document.createElement('label'); includeUpgrade = document.createElement('input'); includeUpgrade.type = 'checkbox';
          upgradeLabel.append(includeUpgrade, document.createTextNode(`升级 +${String(gift.upgradeStars)} ⭐`));
          actions.appendChild(upgradeLabel);
        }
        const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary btn-sm';
        send.textContent = '赠送给当前私聊'; send.disabled = Boolean(gift.soldOut);
        send.onclick = async () => {
          if (send.disabled) return;
          const target = state.clientDialogs?.find(dialog => String(dialog.id) === String(state.clientActiveChatId));
          if (!target || target.type !== 'private') {
            if (window.showToast) window.showToast('请先打开一个私聊，再从这里选择收件人。', 'warn');
            return;
          }
          const targetInstance = state.clientSelectedInstance;
          const targetSelectionVersion = state.chatSelectionVersion;
          const id = String(gift.id || '');
          if (!targetInstance || targetInstance !== instId || !/^\d{1,20}$/.test(id) || /^0+$/.test(id)) return;
          const targetStillCurrent = () => state.clientSelectedInstance === targetInstance &&
            String(state.clientActiveChatId) === String(target.id) && state.chatSelectionVersion === targetSelectionVersion;
          const upgrade = Boolean(includeUpgrade?.checked);
          const recipient = String(target.title || target.username || `用户 ${target.id}`);
          send.disabled = true;
          let paymentSubmitted = false;
          try {
            const payment = await api(`/api/instances/${encodeURIComponent(targetInstance)}/account/star-gifts/prepare`, 'POST', {
              chatId: String(target.id), giftId: id, hideName: hideName.checked, includeUpgrade: upgrade,
            });
            if (!targetStillCurrent()) {
              if (state.clientSelectedInstance === targetInstance) status.textContent = '收件人或账号已切换，未提交付款。';
              return;
            }
            if (!payment || typeof payment.token !== 'string' || !/^\d{1,20}$/.test(String(payment.stars)) || /^0+$/.test(String(payment.stars))) {
              throw new Error('Telegram 未返回有效的最终扣款金额');
            }
            const confirmation = `确认向 ${recipient} 赠送此礼物并支付 ${String(payment.stars)} Stars？${hideName.checked ? '\n将隐藏你的姓名。' : ''}${upgrade ? '\n包含礼物升级。' : ''}\n此操作不能撤回。`;
            if (!window.confirm(confirmation)) {
              if (state.clientSelectedInstance === targetInstance) status.textContent = '已取消赠送，未提交付款。';
              return;
            }
            if (!targetStillCurrent()) return;
            paymentSubmitted = true;
            const result = await api(`/api/instances/${encodeURIComponent(targetInstance)}/account/star-gifts/confirm`, 'POST', {
              chatId: String(target.id), giftId: id, token: payment.token,
            });
            if (state.clientSelectedInstance === targetInstance) {
              loadedStarsInstance = null;
              await loadAccountStars(container, false, true);
              if (state.clientSelectedInstance === targetInstance) {
                status.textContent = `已向 ${recipient} 赠送礼物，扣除 ${String(result?.stars || payment.stars)} Stars。`;
              }
            }
          } catch (error) {
            if (state.clientSelectedInstance === targetInstance) status.textContent = paymentSubmitted
              ? `Telegram 未能确认付款结果；请检查 Stars 记录和聊天后再操作：${error.message}`
              : `未发起付款：${error.message}`;
          } finally {
            if (state.clientSelectedInstance === targetInstance) send.disabled = Boolean(gift.soldOut);
          }
        };
        actions.appendChild(send);
        card.append(image, emoji, details, actions); details.append(title, price, availability); list.appendChild(card);
      }
      status.textContent = items.length ? `${items.length} 个 Telegram 礼物。选择一个当前私聊后可赠送；发送前会确认 Stars 花费。` : '当前没有可显示的礼物。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram 礼物目录：${error.message}`;
    } finally {
      if (stillCurrent() && refresh) refresh.disabled = false;
    }
  }

  async function loadAccountSavedStarGifts(container, append = false, force = false) {
    const status = container.querySelector('#setting-saved-star-gifts-status');
    const list = container.querySelector('#setting-saved-star-gifts-list');
    const refresh = container.querySelector('#btn-refresh-saved-star-gifts');
    const more = container.querySelector('#btn-more-saved-star-gifts');
    if (!status || !list) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      savedStarGiftsRequest++;
      loadedSavedStarGiftsInstance = null;
      savedStarGiftsNextOffset = '';
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      if (more) more.hidden = true;
      return;
    }
    if (append && !savedStarGiftsNextOffset) return;
    if (!append && !force && loadedSavedStarGiftsInstance === instId) return;
    loadedSavedStarGiftsInstance = instId;
    const requestId = ++savedStarGiftsRequest;
    const offset = append ? savedStarGiftsNextOffset : '';
    const stillCurrent = () => requestId === savedStarGiftsRequest && state.clientSelectedInstance === instId;
    if (!append) { list.replaceChildren(); savedStarGiftsNextOffset = ''; }
    status.textContent = append ? '正在读取更多已收到礼物…' : '正在读取已收到的 Telegram 礼物…';
    if (refresh) refresh.disabled = true;
    if (more) more.disabled = true;
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts?offset=${encodeURIComponent(offset)}&limit=20`);
      if (!stillCurrent()) return;
      const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
      for (const gift of gifts) {
        if (!gift || typeof gift.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(gift.id) ||
            typeof gift.title !== 'string' || typeof gift.saved !== 'boolean' || typeof gift.unique !== 'boolean') continue;
        const row = document.createElement('div'); row.className = 'settings-saved-star-gift';
        const info = document.createElement('div'); info.className = 'settings-saved-star-gift-info';
        const title = document.createElement('strong'); title.textContent = `${gift.emoji || (gift.unique ? '💎' : '🎁')} ${gift.title}`;
        const date = Number(gift.date);
        const received = Number.isSafeInteger(date) && date > 0 ? new Date(date * 1000).toLocaleDateString() : '日期未知';
        const details = document.createElement('span'); details.textContent = `${received} · ${gift.refunded ? '已退款' : gift.saved ? '显示在个人资料' : '未显示在个人资料'}`;
        info.append(title, details);
        if (gift.message) {
          const message = document.createElement('span'); message.textContent = gift.message;
          info.appendChild(message);
        }
        const actions = document.createElement('div'); actions.className = 'settings-saved-star-gift-actions';
        const visibility = document.createElement('button'); visibility.type = 'button'; visibility.className = 'btn btn-secondary btn-sm';
        visibility.textContent = gift.saved ? '从个人资料移除' : '显示在个人资料';
        visibility.disabled = Boolean(gift.refunded);
        visibility.onclick = async () => {
          if (visibility.disabled || !stillCurrent()) return;
          visibility.disabled = true;
          try {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/save`, 'POST', { id: gift.id, saved: !gift.saved });
            if (!stillCurrent()) return;
            loadedSavedStarGiftsInstance = null;
            await loadAccountSavedStarGifts(container, false, true);
          } catch (error) {
            if (stillCurrent()) status.textContent = `无法更新礼物资料显示状态：${error.message}`;
          } finally { if (stillCurrent()) visibility.disabled = false; }
        };
        actions.appendChild(visibility);
        const convertStars = String(gift.convertStars || '0');
        if (!gift.unique && !gift.refunded && /^\d{1,20}$/.test(convertStars) && !/^0+$/.test(convertStars)) {
          const convert = document.createElement('button'); convert.type = 'button'; convert.className = 'btn btn-secondary btn-sm';
          convert.textContent = `兑换 ${convertStars.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} Stars`;
          convert.onclick = async () => {
            if (!stillCurrent() || !window.confirm(`将“${gift.title}”兑换为 ${convertStars} Stars？兑换后礼物会被移除，不能撤回。`)) return;
            convert.disabled = true;
            try {
              const converted = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/convert`, 'POST', { id: gift.id });
              if (!stillCurrent()) return;
              loadedStarsInstance = null;
              await loadAccountStars(container, false, true);
              if (!stillCurrent()) return;
              status.textContent = `已将礼物兑换为 ${converted.stars} Stars。`;
              loadedSavedStarGiftsInstance = null;
              await loadAccountSavedStarGifts(container, false, true);
              if (state.clientSelectedInstance === instId) status.textContent = `已将礼物兑换为 ${converted.stars} Stars。`;
            } catch (error) {
              if (stillCurrent()) status.textContent = `礼物兑换未完成：${error.message}`;
            } finally { if (stillCurrent()) convert.disabled = false; }
          };
          actions.appendChild(convert);
        }
        const upgradeStars = String(gift.upgradeStars || '0');
        if (gift.canUpgrade && !gift.unique && !gift.refunded && /^\d{1,20}$/.test(upgradeStars) && !/^0+$/.test(upgradeStars)) {
          const keepLabel = document.createElement('label'); keepLabel.className = 'settings-saved-star-gift-keep';
          const keepDetails = document.createElement('input'); keepDetails.type = 'checkbox'; keepDetails.checked = true;
          keepLabel.append(keepDetails, document.createTextNode('保留礼物原始信息'));
          const upgrade = document.createElement('button'); upgrade.type = 'button'; upgrade.className = 'btn btn-secondary btn-sm';
          upgrade.textContent = `升级 · ${upgradeStars.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} Stars`;
          upgrade.onclick = async () => {
            if (!stillCurrent()) return;
            upgrade.disabled = true;
            let submitted = false;
            try {
              const prepared = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/upgrade/prepare`, 'POST', { id: gift.id });
              if (!stillCurrent()) return;
              if (!prepared || typeof prepared.token !== 'string' || !/^\d{1,20}$/.test(String(prepared.stars)) || /^0+$/.test(String(prepared.stars))) {
                throw new Error('Telegram 未返回有效的升级金额');
              }
              const keepOriginalDetails = Boolean(keepDetails.checked);
              if (!window.confirm(`升级“${gift.title}”并支付 ${prepared.stars} Stars？${keepOriginalDetails ? '\n保留礼物原始信息。' : '\n不保留礼物原始信息。'}\n此操作不能撤回。`)) return;
              if (!stillCurrent()) return;
              submitted = true;
              const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/upgrade/confirm`, 'POST', {
                token: prepared.token, keepOriginalDetails,
              });
              if (!stillCurrent()) return;
              loadedStarsInstance = null;
              await loadAccountStars(container, false, true);
              if (!stillCurrent()) return;
              loadedSavedStarGiftsInstance = null;
              await loadAccountSavedStarGifts(container, false, true);
              if (state.clientSelectedInstance === instId) status.textContent = `礼物已升级，扣除 ${result.stars} Stars。`;
            } catch (error) {
              if (stillCurrent()) status.textContent = submitted
                ? `Telegram 未能确认礼物升级结果；请检查礼物列表和 Stars 记录后再操作：${error.message}`
                : `礼物升级未提交：${error.message}`;
            } finally { if (stillCurrent()) upgrade.disabled = false; }
          };
          actions.append(keepLabel, upgrade);
        }
        const transferStars = String(gift.transferStars || '0');
        if (gift.canTransfer && !gift.refunded && /^\d{1,20}$/.test(transferStars)) {
          const transfer = document.createElement('button'); transfer.type = 'button'; transfer.className = 'btn btn-secondary btn-sm';
          transfer.textContent = '转让给当前私聊';
          transfer.onclick = async () => {
            if (!stillCurrent()) return;
            const target = state.clientDialogs?.find(dialog => String(dialog.id) === String(state.clientActiveChatId));
            if (!target || target.type !== 'private') {
              if (window.showToast) window.showToast('请先打开要接收礼物的其他用户私聊。', 'warn');
              return;
            }
            const targetChatId = Number(target.id);
            const selectionVersion = state.chatSelectionVersion;
            const recipient = String(target.title || target.username || `用户 ${target.id}`);
            const targetStillCurrent = () => stillCurrent() && String(state.clientActiveChatId) === String(targetChatId) &&
              state.chatSelectionVersion === selectionVersion;
            transfer.disabled = true;
            let submitted = false;
            try {
              const prepared = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/transfer/prepare`, 'POST', {
                id: gift.id, chatId: targetChatId,
              });
              if (!targetStillCurrent()) return;
              if (!prepared || typeof prepared.token !== 'string' || !/^\d{1,20}$/.test(String(prepared.stars))) {
                throw new Error('Telegram 未返回有效的转让费用');
              }
              const fee = BigInt(prepared.stars) === 0n ? '免费' : `${String(prepared.stars)} Stars`;
              if (!window.confirm(`将“${gift.title}”转让给 ${recipient}？Telegram 当前显示费用：${fee}。礼物转让后不能撤回。`)) return;
              if (!targetStillCurrent()) return;
              submitted = true;
              const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-star-gifts/transfer/confirm`, 'POST', {
                token: prepared.token, chatId: targetChatId,
              });
              if (!targetStillCurrent()) return;
              loadedStarsInstance = null;
              await loadAccountStars(container, false, true);
              if (!targetStillCurrent()) return;
              loadedSavedStarGiftsInstance = null;
              await loadAccountSavedStarGifts(container, false, true);
              if (state.clientSelectedInstance === instId) status.textContent = `礼物已转让给 ${recipient}，扣除 ${result.stars} Stars。`;
            } catch (error) {
              if (targetStillCurrent()) status.textContent = submitted
                ? `Telegram 未能确认礼物转让结果；请检查礼物和 Stars 状态后再操作：${error.message}`
                : `礼物转让未提交：${error.message}`;
            } finally { if (targetStillCurrent()) transfer.disabled = false; }
          };
          actions.appendChild(transfer);
        }
        row.append(info, actions); list.appendChild(row);
      }
      savedStarGiftsNextOffset = typeof result?.nextOffset === 'string' ? result.nextOffset : '';
      if (more) more.hidden = !savedStarGiftsNextOffset;
      const count = Number.isSafeInteger(result?.count) ? result.count : list.children.length;
      status.textContent = gifts.length || append ? `已加载 ${list.children.length} 项礼物，共 ${count} 项。` : '当前账号没有已收到的 Telegram 礼物。';
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取已收到的 Telegram 礼物：${error.message}`;
    } finally {
      if (stillCurrent()) {
        if (refresh) refresh.disabled = false;
        if (more) more.disabled = false;
      }
    }
  }

  async function loadAccountNotificationSettings(container, force = false) {
    const list = container.querySelector('#setting-telegram-notifications-list');
    const status = container.querySelector('#setting-telegram-notifications-status');
    const refresh = container.querySelector('#btn-refresh-telegram-notifications');
    if (!list || !status) return;
    const instId = state.clientSelectedInstance;
    if (!instId) {
      notificationRequest++;
      loadedNotificationInstance = null;
      list.replaceChildren();
      status.textContent = '请先在 Web 客户端选择一个已登录账号。';
      return;
    }
    if (!force && loadedNotificationInstance === instId) return;
    loadedNotificationInstance = instId;
    const requestId = ++notificationRequest;
    const stillCurrent = () => requestId === notificationRequest && state.clientSelectedInstance === instId;
    status.textContent = '正在读取 Telegram 通知设置…';
    if (refresh) refresh.disabled = true;
    try {
      const [settings, fetchedSoundOptions] = await Promise.all([
        api(`/api/instances/${encodeURIComponent(instId)}/account/notification-settings`),
        api(`/api/instances/${encodeURIComponent(instId)}/account/notification-sounds`).catch(() => []),
      ]);
      if (!stillCurrent()) return;
      const soundOptions = Array.isArray(fetchedSoundOptions) && fetchedSoundOptions.length
        ? fetchedSoundOptions : [{ id: 'default', title: '默认提示音' }, { id: 'none', title: '无提示音' }];
      const soundTitleFor = soundId => soundOptions.find(option => String(option.id) === String(soundId))?.title || '自定义提示音';
      const soundTools = container.querySelector('#setting-notification-sounds-tools');
      if (soundTools) {
        soundTools.replaceChildren();
        const uploadInput = document.createElement('input');
        uploadInput.type = 'file'; uploadInput.accept = 'audio/*'; uploadInput.hidden = true;
        uploadInput.setAttribute('aria-label', '选择 Telegram 提示音文件');
        const uploadButton = document.createElement('button'); uploadButton.type = 'button';
        uploadButton.className = 'btn btn-secondary btn-sm'; uploadButton.textContent = '上传提示音';
        uploadButton.onclick = () => uploadInput.click();
        uploadInput.onchange = async () => {
          if (!stillCurrent()) return;
          const file = uploadInput.files && uploadInput.files[0];
          if (!file) return;
          if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
            status.textContent = '提示音文件必须大于 0 且不超过 5 MiB。'; uploadInput.value = ''; return;
          }
          const extension = String(file.name || '').split('.').pop().toLowerCase();
          const inferredMime = ({ mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav' })[extension];
          const mimeType = String(file.type || inferredMime || '').toLowerCase();
          if (!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) {
            status.textContent = '请选择浏览器识别为音频的提示音文件。'; uploadInput.value = ''; return;
          }
          uploadButton.disabled = true;
          status.textContent = `正在上传“${String(file.name || '提示音')}”…`;
          try {
            const encoded = new TextEncoder().encode(JSON.stringify({ fileName: String(file.name || 'notification-sound'), mimeType }));
            const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, encoded.length);
            const body = new Blob([length, encoded, file], { type: 'application/vnd.tguserbot.media-stream' });
            const response = await fetch(`/api/instances/${encodeURIComponent(instId)}/account/notification-sounds`, {
              method: 'POST', headers: { 'Content-Type': 'application/vnd.tguserbot.media-stream' }, body,
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            uploadInput.value = '';
            loadedNotificationInstance = null;
            await loadAccountNotificationSettings(container, true);
            if (stillCurrent()) status.textContent = '提示音已上传并保存到当前 Telegram 账号。';
          } catch (error) {
            if (stillCurrent()) status.textContent = `提示音上传失败：${error.message}`;
          } finally {
            uploadButton.disabled = false;
            uploadInput.value = '';
          }
        };
        soundTools.append(uploadButton, uploadInput);
        const savedSounds = soundOptions.filter(sound => /^\d{1,20}$/.test(String(sound.id)) && !/^0+$/.test(String(sound.id)));
        if (savedSounds.length) {
          const savedLabel = document.createElement('span'); savedLabel.className = 'settings-notification-sounds-label';
          savedLabel.textContent = '已保存提示音：'; soundTools.appendChild(savedLabel);
          for (const sound of savedSounds) {
            const item = document.createElement('span'); item.className = 'settings-notification-sound-item';
            const name = document.createElement('span'); name.textContent = String(sound.title || 'Telegram 提示音');
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary btn-xs';
            remove.textContent = '删除'; remove.setAttribute('aria-label', `删除提示音 ${name.textContent}`);
            remove.onclick = async () => {
              if (!stillCurrent() || remove.disabled) return;
              if (typeof window.confirm === 'function' && !window.confirm(`从当前 Telegram 账号删除提示音“${name.textContent}”？`)) return;
              remove.disabled = true;
              try {
                await api(`/api/instances/${encodeURIComponent(instId)}/account/notification-sounds/remove`, 'POST', { soundId: String(sound.id) });
                if (!stillCurrent()) return;
                loadedNotificationInstance = null;
                await loadAccountNotificationSettings(container, true);
                if (stillCurrent()) status.textContent = `已删除提示音“${name.textContent}”。`;
              } catch (error) {
                if (stillCurrent()) { remove.disabled = false; status.textContent = `删除提示音失败：${error.message}`; }
              }
            };
            item.append(name, remove); soundTools.appendChild(item);
          }
        }
      }
      const fillSoundSelect = (select, currentId, currentTitle, label) => {
        const selectedId = currentId == null || currentId === '' ? 'default' : String(currentId);
        const options = soundOptions.slice();
        if (!options.some(option => String(option.id) === selectedId)) {
          options.push({ id: selectedId, title: currentTitle || '当前设备提示音', disabled: true });
        }
        for (const sound of options) {
          const option = document.createElement('option');
          option.value = String(sound.id);
          option.textContent = String(sound.title || sound.id);
          option.disabled = Boolean(sound.disabled);
          select.appendChild(option);
        }
        select.value = selectedId;
        select.setAttribute('aria-label', `${label}提示音`);
      };
      const currentMuteChoice = muteUntil => {
        const until = Number(muteUntil) || 0;
        if (!until || until <= Math.floor(Date.now() / 1000)) return 'enabled';
        return until >= 2147483647 ? 'muted' : 'custom';
      };
      const fillMuteSelect = (select, muteUntil, label) => {
        for (const [value, text] of [['enabled', '允许通知'], ['muted', '始终静音'], ['hour-1', '静音 1 小时'], ['hour-8', '静音 8 小时'], ['day-2', '静音 2 天']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
        }
        const current = currentMuteChoice(muteUntil);
        if (current === 'custom') {
          const option = document.createElement('option'); option.value = 'custom'; option.disabled = true;
          option.textContent = `静音至 ${new Date(Number(muteUntil) * 1000).toLocaleString()}`; select.appendChild(option);
        }
        select.value = current;
        select.setAttribute('aria-label', `${label}通知状态`);
      };
      const muteChangeFor = value => {
        if (value === 'enabled') return { property: 'muted', value: false };
        if (value === 'muted') return { property: 'muted', value: true };
        const seconds = ({ 'hour-1': 3600, 'hour-8': 28800, 'day-2': 172800 })[value];
        return seconds ? { property: 'muteUntil', value: Math.min(2147483647, Math.floor(Date.now() / 1000) + seconds) } : null;
      };
      const appendSoundPreview = (controls, select, label) => {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'btn btn-secondary btn-xs'; button.textContent = '试听提示音';
        const audio = document.createElement('audio'); audio.className = 'settings-notification-audio';
        audio.controls = true; audio.preload = 'none'; audio.hidden = true;
        audio.setAttribute('aria-label', `${label}提示音试听`);
        button.onclick = async () => {
          const soundId = String(select.value || '');
          if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId)) {
            status.textContent = '只有账号已保存的提示音可以试听。';
            return;
          }
          audio.src = `/api/instances/${encodeURIComponent(instId)}/account/notification-sound-preview?soundId=${encodeURIComponent(soundId)}`;
          audio.hidden = false;
          try { await audio.play(); }
          catch (error) { if (stillCurrent()) status.textContent = `提示音无法播放：${error.message}`; }
        };
        controls.append(button, audio);
      };
      list.replaceChildren();
      const update = async (setting, property, value, controls, changedControl, detail) => {
        if (!stillCurrent() || controls[0]?.disabled) return;
        const previous = setting[property];
        controls.forEach(control => { control.disabled = true; });
        status.textContent = `正在更新“${setting.title}”通知…`;
        try {
          await api(`/api/instances/${encodeURIComponent(instId)}/account/notification-settings`, 'POST', { key: setting.key, [property]: value });
          if (!stillCurrent()) return;
          setting[property] = value;
          if (property === 'muted') detail.textContent = value ? '此类会话的默认通知已静音。' : '此类会话的默认通知已开启。';
          if (property === 'muteUntil') {
            setting.muted = value > Math.floor(Date.now() / 1000);
            detail.textContent = setting.muted ? `此类会话的默认通知静音至 ${new Date(value * 1000).toLocaleString()}。` : '此类会话的默认通知已开启。';
          }
          if (property === 'soundId' || property === 'storiesSoundId') {
            const titleProperty = property === 'storiesSoundId' ? 'storiesSoundTitle' : 'soundTitle';
            setting[titleProperty] = soundTitleFor(value);
            detail.textContent = `${setting.muted ? '此类会话的默认通知已静音。' : '此类会话的默认通知已开启。'} ${property === 'storiesSoundId' ? '故事提示音' : '提示音'}：${setting[titleProperty]}。`;
          } else if (property === 'storiesMuted') {
            detail.textContent = value ? '此类会话的故事通知已静音。' : '此类会话的故事通知已开启。';
          } else if (property === 'storiesHideSender') {
            detail.textContent = value ? '故事通知中隐藏发布者。' : '故事通知中显示发布者。';
          }
          status.textContent = `“${setting.title}”通知设置已保存。`;
        } catch (error) {
          if (stillCurrent()) {
            setting[property] = previous;
            if (property === 'muted') changedControl.value = previous ? 'muted' : 'enabled';
            else if (property === 'muteUntil') changedControl.value = currentMuteChoice(setting.muteUntil);
            else if (property === 'soundId' || property === 'storiesSoundId') changedControl.value = previous || 'default';
            else changedControl.checked = Boolean(previous);
            status.textContent = `保存失败：${error.message}`;
          }
        } finally {
          if (stillCurrent()) controls.forEach(control => { control.disabled = false; });
        }
      };
      for (const setting of Array.isArray(settings) ? settings : []) {
        const category = document.createElement('div'); category.className = 'settings-notification-category';
        const row = document.createElement('div'); row.className = 'settings-account-privacy-row';
        const info = document.createElement('div'); info.className = 'settings-account-privacy-info';
        const title = document.createElement('strong'); title.textContent = String(setting.title || setting.key || '通知');
        const settingMuteUntil = setting.muteUntil ?? (setting.muted ? 2147483647 : 0);
        const detail = document.createElement('span'); detail.textContent = setting.muted
          ? Number(settingMuteUntil) >= 2147483647 ? '此类会话的默认通知已静音。' : `此类会话的默认通知静音至 ${new Date(Number(settingMuteUntil) * 1000).toLocaleString()}。`
          : '此类会话的默认通知已开启。';
        info.append(title, detail);
        const controls = document.createElement('div'); controls.className = 'settings-notification-controls';
        const mute = document.createElement('select'); mute.className = 'form-select';
        fillMuteSelect(mute, settingMuteUntil, title.textContent);
        const previewsLabel = document.createElement('label'); previewsLabel.className = 'settings-notification-toggle';
        const previews = document.createElement('input'); previews.type = 'checkbox'; previews.checked = setting.showPreviews !== false;
        previews.setAttribute('aria-label', `${title.textContent}显示消息预览`);
        previewsLabel.append(previews, document.createTextNode('消息预览'));
        const silentLabel = document.createElement('label'); silentLabel.className = 'settings-notification-toggle';
        const silent = document.createElement('input'); silent.type = 'checkbox'; silent.checked = Boolean(setting.silent);
        silent.setAttribute('aria-label', `${title.textContent}静默通知`);
        silentLabel.append(silent, document.createTextNode('静默通知'));
        const soundSelect = document.createElement('select'); soundSelect.className = 'form-select settings-notification-sound';
        fillSoundSelect(soundSelect, setting.soundId, setting.soundTitle, title.textContent);
        const storiesPanel = document.createElement('div'); storiesPanel.className = 'settings-notification-stories';
        const storiesTitle = document.createElement('strong'); storiesTitle.textContent = '故事通知';
        const storiesMutedLabel = document.createElement('label'); storiesMutedLabel.className = 'settings-notification-toggle';
        const storiesMuted = document.createElement('input'); storiesMuted.type = 'checkbox'; storiesMuted.checked = Boolean(setting.storiesMuted);
        storiesMuted.setAttribute('aria-label', `${title.textContent}静音故事通知`);
        storiesMutedLabel.append(storiesMuted, document.createTextNode('静音故事通知'));
        const storiesHideLabel = document.createElement('label'); storiesHideLabel.className = 'settings-notification-toggle';
        const storiesHideSender = document.createElement('input'); storiesHideSender.type = 'checkbox'; storiesHideSender.checked = Boolean(setting.storiesHideSender);
        storiesHideSender.setAttribute('aria-label', `${title.textContent}隐藏故事发布者`);
        storiesHideLabel.append(storiesHideSender, document.createTextNode('隐藏发布者'));
        const storiesSoundSelect = document.createElement('select'); storiesSoundSelect.className = 'form-select settings-notification-sound';
        fillSoundSelect(storiesSoundSelect, setting.storiesSoundId, setting.storiesSoundTitle, `${title.textContent}故事`);
        storiesPanel.append(storiesTitle, storiesMutedLabel, storiesHideLabel, storiesSoundSelect);
        appendSoundPreview(storiesPanel, storiesSoundSelect, `${title.textContent}故事`);
        const exceptionButton = document.createElement('button'); exceptionButton.type = 'button';
        exceptionButton.className = 'btn btn-secondary btn-xs'; exceptionButton.textContent = '查看例外';
        const exceptionList = document.createElement('div'); exceptionList.className = 'settings-notification-exceptions'; exceptionList.hidden = true;
        let exceptionLoadRequest = 0;
        exceptionButton.onclick = async () => {
          if (!stillCurrent()) return;
          if (!exceptionList.hidden) {
            exceptionLoadRequest++;
            exceptionList.hidden = true;
            exceptionButton.textContent = '查看例外';
            return;
          }
          const exceptionRequestId = ++exceptionLoadRequest;
          const outerRequestId = ++notificationExceptionRequest;
          exceptionList.hidden = false;
          exceptionList.textContent = '正在读取此类别的通知例外…';
          exceptionButton.disabled = true;
          try {
            const exceptions = await api(`/api/instances/${encodeURIComponent(instId)}/account/notification-exceptions?key=${encodeURIComponent(setting.key)}`);
            if (!stillCurrent() || exceptionRequestId !== exceptionLoadRequest || outerRequestId !== notificationExceptionRequest) return;
            exceptionList.replaceChildren();
            const exceptionItems = Array.isArray(exceptions) ? exceptions : [];
            if (!exceptionItems.length) {
              exceptionList.textContent = '没有自定义通知例外。';
            } else {
              for (const exception of exceptionItems) {
                const item = document.createElement('div'); item.className = 'settings-notification-exception';
                const info = document.createElement('div'); info.className = 'settings-notification-exception-info';
                const name = document.createElement('strong'); name.textContent = String(exception.title || `会话 ${exception.chatId}`);
                const details = [];
                if (exception.muted) details.push(Number(exception.muteUntil) >= 2147483647 ? '已静音' : `静音至 ${new Date(Number(exception.muteUntil) * 1000).toLocaleString()}`);
                if (exception.showPreviews === false) details.push('隐藏预览');
                if (exception.silent) details.push('静默通知');
                if (exception.soundId && exception.soundId !== 'default') details.push(`提示音：${exception.soundTitle || soundTitleFor(exception.soundId)}`);
                if (exception.storiesMuted) details.push('故事已静音');
                if (exception.storiesHideSender) details.push('隐藏故事发布者');
                if (exception.storiesSoundId && exception.storiesSoundId !== 'default') details.push(`故事提示音：${exception.storiesSoundTitle || soundTitleFor(exception.storiesSoundId)}`);
                const detail = document.createElement('span'); detail.textContent = details.join(' · ') || '自定义通知规则';
                info.append(name, detail);
                const controls = document.createElement('div'); controls.className = 'settings-notification-exception-controls';
                const mute = document.createElement('select'); mute.className = 'form-select';
                fillMuteSelect(mute, exception.muteUntil, name.textContent);
                const previewsLabel = document.createElement('label'); previewsLabel.className = 'settings-notification-toggle';
                const previews = document.createElement('input'); previews.type = 'checkbox'; previews.checked = exception.showPreviews !== false;
                previews.setAttribute('aria-label', `${name.textContent}显示消息预览`);
                previewsLabel.append(previews, document.createTextNode('消息预览'));
                const silentLabel = document.createElement('label'); silentLabel.className = 'settings-notification-toggle';
                const silent = document.createElement('input'); silent.type = 'checkbox'; silent.checked = Boolean(exception.silent);
                silent.setAttribute('aria-label', `${name.textContent}静默通知`);
                silentLabel.append(silent, document.createTextNode('静默'));
                const soundSelect = document.createElement('select'); soundSelect.className = 'form-select settings-notification-sound';
                fillSoundSelect(soundSelect, exception.soundId, exception.soundTitle, name.textContent);
                const storiesPanel = document.createElement('div'); storiesPanel.className = 'settings-notification-stories';
                const storiesTitle = document.createElement('strong'); storiesTitle.textContent = '故事通知';
                const storiesMutedLabel = document.createElement('label'); storiesMutedLabel.className = 'settings-notification-toggle';
                const storiesMuted = document.createElement('input'); storiesMuted.type = 'checkbox'; storiesMuted.checked = Boolean(exception.storiesMuted);
                storiesMuted.setAttribute('aria-label', `${name.textContent}静音故事通知`);
                storiesMutedLabel.append(storiesMuted, document.createTextNode('静音故事通知'));
                const storiesHideLabel = document.createElement('label'); storiesHideLabel.className = 'settings-notification-toggle';
                const storiesHideSender = document.createElement('input'); storiesHideSender.type = 'checkbox'; storiesHideSender.checked = Boolean(exception.storiesHideSender);
                storiesHideSender.setAttribute('aria-label', `${name.textContent}隐藏故事发布者`);
                storiesHideLabel.append(storiesHideSender, document.createTextNode('隐藏发布者'));
                const storiesSoundSelect = document.createElement('select'); storiesSoundSelect.className = 'form-select settings-notification-sound';
                fillSoundSelect(storiesSoundSelect, exception.storiesSoundId, exception.storiesSoundTitle, `${name.textContent}故事`);
                storiesPanel.append(storiesTitle, storiesMutedLabel, storiesHideLabel, storiesSoundSelect);
                appendSoundPreview(storiesPanel, storiesSoundSelect, `${name.textContent}故事`);
                const saveException = async (property, value, control) => {
                  if (!stillCurrent() || control.disabled) return;
                  const previous = exception[property];
                  [mute, previews, silent, soundSelect, storiesMuted, storiesHideSender, storiesSoundSelect].forEach(field => { field.disabled = true; });
                  status.textContent = `正在更新“${name.textContent}”通知…`;
                  try {
                    await api(`/api/instances/${encodeURIComponent(instId)}/account/notification-exceptions`, 'POST', {
                      key: setting.key, chatId: exception.chatId, [property]: value,
                    });
                    if (!stillCurrent()) return;
                    exception[property] = value;
                    if (property === 'soundId' || property === 'storiesSoundId') {
                      exception[property === 'storiesSoundId' ? 'storiesSoundTitle' : 'soundTitle'] = soundTitleFor(value);
                    }
                    if (property === 'muted') exception.muteUntil = value
                      ? Number(exception.muteUntil) > Math.floor(Date.now() / 1000) ? exception.muteUntil : 2147483647
                      : 0;
                    if (property === 'muteUntil') exception.muted = value > Math.floor(Date.now() / 1000);
                    const details = [];
                    if (exception.muted) details.push(Number(exception.muteUntil) >= 2147483647 ? '已静音' : `静音至 ${new Date(Number(exception.muteUntil) * 1000).toLocaleString()}`);
                    if (exception.showPreviews === false) details.push('隐藏预览');
                    if (exception.silent) details.push('静默通知');
                    if (exception.soundId && exception.soundId !== 'default') details.push(`提示音：${exception.soundTitle || soundTitleFor(exception.soundId)}`);
                    if (exception.storiesMuted) details.push('故事已静音');
                    if (exception.storiesHideSender) details.push('隐藏故事发布者');
                    if (exception.storiesSoundId && exception.storiesSoundId !== 'default') details.push(`故事提示音：${exception.storiesSoundTitle || soundTitleFor(exception.storiesSoundId)}`);
                    detail.textContent = details.join(' · ') || '自定义通知规则';
                    status.textContent = `“${name.textContent}”的通知例外已保存。`;
                  } catch (error) {
                    if (stillCurrent()) {
                      exception[property] = previous;
                      if (property === 'muted') mute.value = previous ? 'muted' : 'enabled';
                      else if (property === 'muteUntil') mute.value = currentMuteChoice(exception.muteUntil);
                      else if (property === 'soundId') soundSelect.value = previous || 'default';
                      else if (property === 'storiesSoundId') storiesSoundSelect.value = previous || 'default';
                      else control.checked = Boolean(previous);
                      status.textContent = `保存失败：${error.message}`;
                    }
                  } finally {
                    if (stillCurrent()) [mute, previews, silent, soundSelect, storiesMuted, storiesHideSender, storiesSoundSelect].forEach(field => { field.disabled = false; });
                  }
                };
                mute.onchange = () => {
                  const change = muteChangeFor(mute.value);
                  if (change) void saveException(change.property, change.value, mute);
                };
                previews.onchange = () => void saveException('showPreviews', previews.checked, previews);
                silent.onchange = () => void saveException('silent', silent.checked, silent);
                soundSelect.onchange = () => void saveException('soundId', soundSelect.value, soundSelect);
                storiesMuted.onchange = () => void saveException('storiesMuted', storiesMuted.checked, storiesMuted);
                storiesHideSender.onchange = () => void saveException('storiesHideSender', storiesHideSender.checked, storiesHideSender);
                storiesSoundSelect.onchange = () => void saveException('storiesSoundId', storiesSoundSelect.value, storiesSoundSelect);
                controls.append(mute, previewsLabel, silentLabel, soundSelect, storiesPanel);
                appendSoundPreview(controls, soundSelect, name.textContent);
                item.append(info, controls); exceptionList.appendChild(item);
              }
            }
            exceptionButton.textContent = `${exceptionItems.length} 条例外`;
          } catch (error) {
            if (stillCurrent() && exceptionRequestId === exceptionLoadRequest) exceptionList.textContent = `无法读取通知例外：${error.message}`;
          } finally {
            if (stillCurrent() && exceptionRequestId === exceptionLoadRequest) exceptionButton.disabled = false;
          }
        };
        const rowControls = [mute, previews, silent, soundSelect, storiesMuted, storiesHideSender, storiesSoundSelect];
        mute.onchange = () => {
          const change = muteChangeFor(mute.value);
          if (change) void update(setting, change.property, change.value, rowControls, mute, detail);
        };
        previews.onchange = () => void update(setting, 'showPreviews', previews.checked, rowControls, previews, detail);
        silent.onchange = () => void update(setting, 'silent', silent.checked, rowControls, silent, detail);
        soundSelect.onchange = () => void update(setting, 'soundId', soundSelect.value, rowControls, soundSelect, detail);
        storiesMuted.onchange = () => void update(setting, 'storiesMuted', storiesMuted.checked, rowControls, storiesMuted, detail);
        storiesHideSender.onchange = () => void update(setting, 'storiesHideSender', storiesHideSender.checked, rowControls, storiesHideSender, detail);
        storiesSoundSelect.onchange = () => void update(setting, 'storiesSoundId', storiesSoundSelect.value, rowControls, storiesSoundSelect, detail);
        controls.append(mute, previewsLabel, silentLabel, exceptionButton, soundSelect, storiesPanel);
        appendSoundPreview(controls, soundSelect, title.textContent);
        row.append(info, controls); category.append(row, exceptionList); list.appendChild(category);
      }
      status.textContent = `${list.children.length} 类 Telegram 通知设置`;
    } catch (error) {
      if (stillCurrent()) status.textContent = `无法读取 Telegram 通知设置：${error.message}`;
    } finally {
      if (stillCurrent() && refresh) refresh.disabled = false;
    }
  }

  async function loadCacheStats(container) {
    const stats = container.querySelector('#cache-stats-container');
    if (!stats) return;
    try {
      const response = await fetch('/api/cache/stats');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      stats.textContent = `已用 ${Number(data.usedMB) || 0} MB / ${Number(data.maxMB) || 0} MB，${Number(data.fileCount) || 0} 个文件`;
    } catch {
      stats.textContent = '无法加载缓存统计，请稍后重试。';
    }
  }

  // Expose
  window.SettingsPage = { init, refresh: () => {
    const container = document.getElementById('view-settings');
    if (container) {
      loadedAuthorizationInstance = null; loadedPrivacyInstance = null; loadedGlobalPrivacyInstance = null;
      refreshSettings(container);
    }
  } };
})();

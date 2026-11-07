'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const state = {
    chatSendKeyMode: values.get('tgbot_chat_send_mode') || 'enter',
    clientParseMode: values.get('tgbot_chat_parse_mode') || 'markdown',
    clientTranslationLanguage: values.get('tgbot_translation_language') || 'zh-hans',
    clientSilent: values.get('tgbot_chat_silent') === 'true',
  };
  const makeNode = () => ({
    children: [], handlers: {}, dataset: {}, textContent: '', disabled: false, hidden: false, className: '', value: '', files: [], scrolls: 0,
    style: {},
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      toggle(value, force) { const next = force === undefined ? !this.values.has(value) : force; if (next) this.values.add(value); else this.values.delete(value); return next; },
      contains(value) { return this.values.has(value); },
    },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    click() { this.onclick?.({ target: this }); },
    play() { return Promise.resolve(); },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    replaceChildren(...children) { this.children = children; },
    scrollIntoView() { this.scrolls++; },
    focus() {},
    querySelector() { return null; },
  });
  const controls = Object.fromEntries(['#setting-send-mode', '#setting-parse-mode', '#setting-translation-language', '#setting-silent', '#btn-settings-clear-cache', '#cache-stats-container',
    '#setting-search', '#settings-search-results',
    '#btn-refresh-authorizations', '#btn-revoke-other-authorizations', '#setting-authorizations-status', '#setting-authorizations-list',
    '#btn-refresh-account-privacy', '#setting-account-privacy-status', '#setting-account-privacy-list',
    '#btn-refresh-global-privacy', '#setting-global-privacy-status', '#setting-global-privacy-list',
    '#setting-default-history-ttl', '#setting-default-history-ttl-status',
    '#btn-open-default-history-ttl-picker', '#setting-default-history-ttl-picker',
    '#setting-default-history-ttl-search', '#setting-default-history-ttl-picker-status',
    '#setting-default-history-ttl-chats', '#btn-more-default-history-ttl-chats', '#btn-apply-default-history-ttl',
    '#btn-refresh-telegram-themes', '#setting-telegram-themes-status', '#setting-telegram-themes-list',
    '#btn-refresh-telegram-notifications', '#setting-notification-sounds-tools', '#setting-telegram-notifications-status', '#setting-telegram-notifications-list',
    '#btn-refresh-stars', '#btn-more-stars', '#setting-stars-status', '#setting-stars-balance', '#setting-stars-history',
    '#btn-refresh-star-gifts', '#setting-star-gifts-status', '#setting-star-gifts-list', '#btn-refresh-stars-subscriptions',
    '#btn-more-stars-subscriptions', '#setting-stars-subscriptions-status', '#setting-stars-subscriptions-list'].map(key => [key, makeNode()]));
  controls['#setting-default-history-ttl-picker'].hidden = true;
  controls['#btn-more-default-history-ttl-chats'].hidden = true;
  let onVisibilityChange;
  let clearStatus = 200;
  let menuUpdates = 0;
  let sendHintUpdates = 0;
  let appliedWallpaper;
  const themeModes = [];
  const notifications = [];
  const fetchCalls = [];
  const privacyCalls = [];
  const privacyExceptionCalls = [];
  const privacySpecialCalls = [];
  const privacySearchCalls = [];
  const globalPrivacyCalls = [];
  const notificationCalls = [];
  const starsCalls = [];
  const starsSubscriptionCalls = [];
  const starGiftCalls = [];
  const appThemeCalls = [];
  const defaultHistoryTtlCalls = [];
  const defaultHistoryTtlChatCalls = [];
  const defaultHistoryTtlBulkCalls = [];
  let defaultHistoryTtl = 604800;
  let starsSubscriptions = [{ id: 'sub-1', title: 'Premium subscription', canceled: false, canRefulfill: true, missingBalance: false,
    untilDate: 1700000000, amount: '250', period: 2592000 }];
  let privacySettings = [
    { key: 'lastSeen', title: '上线时间', mode: 'contacts', available: true, exceptions: { allowedUsers: options.emptyPrivacyExceptions ? 0 : 1 } },
    { key: 'profilePhoto', title: '头像', mode: 'custom', available: true, exceptions: { otherRules: 1 } },
  ];
  let notificationSettings = [
    { key: 'private', title: '私聊', muted: false, muteUntil: 0, showPreviews: true, silent: false, storiesMuted: false, storiesHideSender: false, storiesSoundId: 'default' },
    { key: 'groups', title: '群组', muted: true, muteUntil: 2147483647, showPreviews: false, silent: true, storiesMuted: true, storiesHideSender: false, storiesSoundId: 'default' },
    { key: 'channels', title: '频道', muted: false, muteUntil: 0, showPreviews: false, silent: false, storiesMuted: false, storiesHideSender: false, storiesSoundId: 'default' },
  ];
  let globalPrivacySettings = [
    { key: 'archiveNewNoncontacts', title: '自动归档陌生人', description: '将新会话归档。', value: true },
    { key: 'hideReadMarks', title: '隐藏已读标记', description: '隐藏已读状态。', value: false },
  ];
  const wallpaper = { dataset: { theme: 'doodle' }, classList: { toggle() {}, remove() {}, add() {} } };
  const sectionNames = ['appearance', 'chat', 'account', 'notifications', 'privacy', 'cache'];
  const sections = Object.fromEntries(sectionNames.map(name => {
    const section = makeNode(); section.id = `settings-${name}`;
    const heading = makeNode(); heading.textContent = ({appearance:'外观设置',chat:'聊天与媒体',account:'Telegram 账号',notifications:'通知与声音',privacy:'隐私与安全',cache:'缓存管理'})[name];
    section.querySelector = selector => selector === 'h3' ? heading : null;
    return [name, section];
  }));
  const navButtons = sectionNames.map(name => { const button = makeNode(); button.dataset.section = name; return button; });
  const staticSearchTargets = [];
  const silentLabel = makeNode(); silentLabel.textContent = '静默发送';
  const silentField = makeNode(); silentField.textContent = '静默发送 默认静默发送（不通知对方）';
  silentLabel.closest = selector => selector === '.settings-section' ? sections.chat : selector === '.settings-field' ? silentField : null;
  staticSearchTargets.push(silentLabel);
  const container = {
    classList: { contains: () => true },
    querySelector: selector => controls[selector] || (selector.startsWith('#settings-') ? sections[selector.slice('#settings-'.length)] : null),
    querySelectorAll: selector => selector === '.wallpaper-btn' ? [wallpaper]
      : selector === '.settings-nav-item' ? navButtons
      : selector === '.settings-section' ? Object.values(sections)
      : selector === '.settings-label, .settings-account-privacy-info strong' ? staticSearchTargets : [],
  };
  const context = {
    state,
    window: { showToast: true, confirm: () => true, ThemeManager: { set: mode => themeModes.push(mode), getStored: () => 'dark' } },
    document: { getElementById: id => id === 'view-settings' ? container : null, createElement: makeNode, createTextNode: text => ({ textContent: text }),
      documentElement: { style: { setProperty() {}, removeProperty() {} } } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    MutationObserver: class { constructor(callback) { onVisibilityChange = callback; } observe() {} },
    updateChatMenuVisuals: () => menuUpdates++,
    updateChatSendHint: () => sendHintUpdates++,
    applyChatTheme: theme => { appliedWallpaper = theme; values.set('tg_chat_wallpaper_theme', theme); },
    showToast: (message, type) => notifications.push({ message, type }),
    Blob, TextEncoder, Uint8Array, DataView, URLSearchParams,
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url.endsWith('/clear')) return { ok: clearStatus === 200, status: clearStatus };
      if (url.endsWith('/notification-sounds') && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true }) };
      return { ok: true, status: 200, json: async () => ({ usedMB: 12, maxMB: 5120, fileCount: 3 }) };
    },
    api: async (url, method = 'GET', body) => {
      if (url.endsWith('/default-history-ttl')) {
        defaultHistoryTtlCalls.push({ url, method, body });
        if (method === 'POST') defaultHistoryTtl = body.period;
        return { period: defaultHistoryTtl };
      }
      if (url.includes('/account/dialogs?')) {
        defaultHistoryTtlChatCalls.push({ url, method, body });
        return url.includes('folderId=1')
          ? [{ id: -9, type: 'group', title: 'Archived group', unreadCount: 0, lastMessageId: 5, lastMessageDate: 2000 }]
          : [{ id: 7, type: 'private', title: 'Alice', unreadCount: 0, lastMessageId: 10, lastMessageDate: 1000 },
            { id: 99, type: 'private', title: 'Saved Messages', isSelf: true, unreadCount: 0 }];
      }
      if (url.endsWith('/account/chat-history-ttl/bulk')) {
        defaultHistoryTtlBulkCalls.push({ url, method, body });
        return { updated: 1, failedChatIds: [-9] };
      }
      if (url.endsWith('/authorizations')) return { authorizationTtlDays: 90, sessions: [
        { current: true, appName: 'TGuserBOT', appVersion: '1.0', deviceModel: 'Web', platform: 'Linux', systemVersion: '6', dateActive: 20 },
        { current: false, hash: '222', appName: 'Telegram Android', appVersion: '11', deviceModel: 'Phone', platform: 'Android', systemVersion: '15', dateActive: 21, ip: '192.0.2.1', country: 'Example' },
      ] };
      if (url.endsWith('/privacy-settings')) {
        privacyCalls.push({ url, method, body });
        if (method === 'POST') privacySettings = privacySettings.map(item => item.key === body.key ? { ...item, mode: body.mode } : item);
        return method === 'POST' ? { success: true } : privacySettings;
      }
      if (url.includes('/privacy-special-rules?')) {
        privacySpecialCalls.push({ url, method, body });
        return { allowPremium: false, botAccess: 'default', editable: true, unsupportedRules: 0 };
      }
      if (url.endsWith('/privacy-special-rules')) {
        privacySpecialCalls.push({ url, method, body });
        return { success: true };
      }
      if (url.includes('/privacy-exceptions?')) {
        privacyExceptionCalls.push({ url, method, body });
        return options.emptyPrivacyExceptions ? [] : [{ id: '42', category: 'allowedUsers', title: 'Alice Example', kind: 'user' }];
      }
      if (url.endsWith('/privacy-exceptions')) {
        privacyExceptionCalls.push({ url, method, body });
        return { success: true };
      }
      if (url.endsWith('/contacts')) return [{ id: 77, firstName: 'Charlie', lastName: 'Contact', username: 'charlie', isBot: false }];
      if (url.includes('/search-dialogs?')) {
        privacySearchCalls.push({ url, method, body });
        return [
          { id: 88, type: 'private', title: 'Dana Noncontact', username: 'dana', isBot: false },
          { id: 89, type: 'private', firstName: 'Bot', username: 'helper_bot', isBot: true },
          { id: -12, type: 'group', title: 'Family Group', isBot: false },
        ];
      }
      if (url.endsWith('/global-privacy-settings')) {
        globalPrivacyCalls.push({ url, method, body });
        if (method === 'POST') globalPrivacySettings = globalPrivacySettings.map(item => item.key === body.key ? { ...item, value: body.value } : item);
        return method === 'POST' ? { success: true } : globalPrivacySettings;
      }
      if (url.endsWith('/app-themes')) return [
        { slug: 'blue-theme', title: '蓝色主题', emoticon: '🌊', dark: true, accentColor: 0x123456, messageColors: [0x123456, 0xabcdef] },
        { slug: 'day-theme', title: '日间主题', dark: false, accentColor: 0xfedcba, messageColors: [] },
      ];
      if (url.endsWith('/app-theme')) { appThemeCalls.push({ url, method, body }); return { slug: body.slug, dark: body.dark }; }
      if (url.includes('/account/stars?')) {
        starsCalls.push({ url, method, body });
        return { balance: { amount: '1234', nanos: 0 }, transactions: [
          { id: 'tx-1', stars: { amount: '25', nanos: 0 }, date: 1700000000, title: 'Telegram gift', status: 'complete' },
        ], nextOffset: '' };
      }
      if (url.includes('/account/stars-subscriptions')) {
        starsSubscriptionCalls.push({ url, method, body });
        if (method === 'POST') starsSubscriptions = starsSubscriptions.map(item => item.id === body.subscriptionId ? { ...item, canceled: body.canceled } : item);
        return method === 'POST' ? { success: true } : { subscriptions: starsSubscriptions, nextOffset: '' };
      }
      if (url.endsWith('/account/star-gifts')) {
        starGiftCalls.push({ url, method, body });
        return [{ id: 'gift-1', stars: '15', limited: true, availabilityRemains: 7, soldOut: false,
          sticker: { id: '500', accessHash: '-88', fileReference: 'AQI=', emoji: '🎁' } }];
      }
      if (url.endsWith('/notification-sounds')) {
        notificationCalls.push({ url, method, body });
        return [{ id: 'default', title: '默认提示音' }, { id: 'none', title: '无提示音' }, { id: '77', title: 'Soft bell' }];
      }
      if (url.endsWith('/notification-sounds/remove')) {
        notificationCalls.push({ url, method, body });
        return { success: true };
      }
      if (url.endsWith('/notification-settings')) {
        notificationCalls.push({ url, method, body });
        if (method === 'POST') notificationSettings = notificationSettings.map(item => item.key === body.key ? { ...item, ...body } : item);
        return method === 'POST' ? { success: true } : notificationSettings;
      }
      if (url.includes('/notification-exceptions?')) {
        notificationCalls.push({ url, method, body });
        return [{ chatId: 42, title: 'Alice Example', type: 'private', muted: true, muteUntil: 2147483647, showPreviews: false, silent: true, soundId: '77', soundTitle: 'Soft bell', storiesMuted: true, storiesHideSender: false, storiesSoundId: 'default' }];
      }
      if (url.endsWith('/notification-exceptions')) {
        notificationCalls.push({ url, method, body });
        return { success: true };
      }
      return { success: true };
    },
  };
  vm.runInNewContext(fs.readFileSync('src/gui/web/js/settings.js', 'utf8'), context);
  context.window.SettingsPage.init();
  return { state, values, controls, wallpaper, notifications, fetchCalls, onVisibilityChange, sections, navButtons,
    privacyCalls, privacyExceptionCalls, privacySpecialCalls, privacySearchCalls, globalPrivacyCalls, notificationCalls, starsCalls, starsSubscriptionCalls, starGiftCalls, appThemeCalls, defaultHistoryTtlCalls, defaultHistoryTtlChatCalls, defaultHistoryTtlBulkCalls, themeModes,
    settingsPage: context.window.SettingsPage,
    setClearStatus: status => { clearStatus = status; },
    get appliedWallpaper() { return appliedWallpaper; },
    get menuUpdates() { return menuUpdates; }, get sendHintUpdates() { return sendHintUpdates; } };
}

test('Telegram theme catalog installs to the selected account and previews its base palette', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const list = fixture.controls['#setting-telegram-themes-list'];
  assert.equal(list.children.length, 2);
  const firstCard = list.children[0];
  const install = firstCard.children[firstCard.children.length - 1];
  assert.equal(install.textContent, '安装并应用');
  install.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.appThemeCalls.length, 1);
  assert.equal(fixture.appThemeCalls[0].url, '/api/instances/account-a/account/app-theme');
  assert.equal(fixture.appThemeCalls[0].method, 'POST');
  assert.equal(fixture.appThemeCalls[0].body.slug, 'blue-theme');
  assert.equal(fixture.appThemeCalls[0].body.dark, true);
  assert.equal(fixture.values.get('tg_telegram_app_theme_account-a'), 'blue-theme');
  assert.match(fixture.controls['#setting-telegram-themes-status'].textContent, /已由 Telegram 安装/);
  assert.equal(list.children[0].className.includes('active'), true);
  assert.deepEqual(fixture.themeModes, ['dark']);
});

test('settings migrate old values and immediately update chat state', () => {
  const fixture = setup({ tgbot_chat_send_mode: 'ctrl-enter', tgbot_chat_parse_mode: 'none' });
  assert.equal(fixture.state.chatSendKeyMode, 'ctrlEnter');
  assert.equal(fixture.state.clientParseMode, 'plain');
  fixture.controls['#setting-send-mode'].value = 'enter';
  fixture.controls['#setting-send-mode'].onchange();
  fixture.controls['#setting-parse-mode'].value = 'html';
  fixture.controls['#setting-parse-mode'].onchange();
  fixture.controls['#setting-silent'].checked = true;
  fixture.controls['#setting-silent'].onchange();
  assert.equal(fixture.state.chatSendKeyMode, 'enter');
  assert.equal(fixture.state.clientParseMode, 'html');
  assert.equal(fixture.state.clientSilent, true);
  assert.equal(fixture.values.get('tgbot_chat_silent'), 'true');
  assert.equal(fixture.menuUpdates, 3);
  assert.equal(fixture.sendHintUpdates, 1);
});

test('settings reflect chat changes on return and use chat wallpaper controller', () => {
  const fixture = setup();
  fixture.state.chatSendKeyMode = 'ctrlEnter';
  fixture.state.clientSilent = true;
  fixture.onVisibilityChange();
  assert.equal(fixture.controls['#setting-send-mode'].value, 'ctrlEnter');
  assert.equal(fixture.controls['#setting-silent'].checked, true);
  fixture.controls['#setting-translation-language'].value = 'ja';
  fixture.controls['#setting-translation-language'].onchange();
  assert.equal(fixture.state.clientTranslationLanguage, 'ja');
  assert.equal(fixture.values.get('tgbot_translation_language'), 'ja');
  fixture.wallpaper.onclick();
  assert.equal(fixture.appliedWallpaper, 'doodle');
});

test('settings search finds a setting, navigates to it, and leaves its current value intact', () => {
  const fixture = setup();
  fixture.controls['#setting-send-mode'].value = 'ctrlEnter';
  const search = fixture.controls['#setting-search'];
  const results = fixture.controls['#settings-search-results'];
  search.value = '静默发送';
  search.oninput();
  assert.equal(results.hidden, false);
  assert.equal(results.children.length, 1);
  assert.equal(results.children[0].textContent, '聊天与媒体 · 静默发送');
  results.children[0].onclick();
  assert.equal(fixture.sections.chat.classList.contains('active'), true);
  assert.equal(fixture.navButtons[1].classList.contains('active'), true);
  assert.equal(fixture.controls['#setting-send-mode'].value, 'ctrlEnter');
  assert.equal(fixture.state.clientParseMode, 'markdown');
  search.value = 'no such setting'; search.oninput();
  assert.equal(results.children[0].textContent, '没有匹配的设置');
  search.onkeydown({ key: 'Escape' });
  assert.equal(search.value, '');
  assert.equal(results.hidden, true);
});

test('cache displays real stats and reports failed clear operations', async () => {
  const fixture = setup();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(fixture.controls['#cache-stats-container'].textContent, /12 MB \/ 5120 MB，3 个文件/);
  fixture.setClearStatus(403);
  await fixture.controls['#btn-settings-clear-cache'].onclick();
  assert.equal(fixture.notifications.at(-1).type, 'error');
  assert.equal(fixture.controls['#btn-settings-clear-cache'].disabled, false);
});

test('privacy settings list Telegram sessions and can revoke an old device', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const list = fixture.controls['#setting-authorizations-list'];
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].children[0].textContent, 'TGuserBOT 1.0 · 当前设备');
  assert.equal(list.children[0].children.length, 1);
  assert.equal(list.children[1].children.length, 2);
  assert.equal(fixture.controls['#setting-authorizations-status'].textContent, '共 2 个登录设备 · 会话有效期 90 天');
  await list.children[1].children[1].onclick();
  assert.equal(fixture.notifications.at(-1).type, 'success');
});

test('account privacy controls show exception state and update the selected Telegram account', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const list = fixture.controls['#setting-account-privacy-list'];
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].children[0].textContent, '上线时间');
  assert.match(list.children[0].children[0].children[1].textContent, /会保留/);
  assert.equal(list.children[0].children[1].value, 'contacts');
  assert.equal(list.children[1].children[1].disabled, true);
  list.children[0].children[1].value = 'everybody';
  await list.children[0].children[1].onchange();
  assert.equal(fixture.privacyCalls.find(call => call.method === 'POST').url, '/api/instances/account-a/account/privacy-settings');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.privacyCalls.find(call => call.method === 'POST').body)), { key: 'lastSeen', mode: 'everybody' });
  assert.equal(fixture.controls['#setting-account-privacy-list'].children[0].children[1].value, 'everybody');
  const privacyInfo = fixture.controls['#setting-account-privacy-list'].children[0].children[0];
  const manageExceptions = privacyInfo.children[2];
  await manageExceptions.onclick();
  const exceptionList = privacyInfo.children[3];
  assert.equal(exceptionList.children.length, 3);
  assert.equal(exceptionList.children[2].children[0].textContent, 'Alice Example');
  await exceptionList.children[0].onclick();
  const addPanel = exceptionList.children[1];
  const contactSelect = addPanel.children[4];
  contactSelect.value = '77'; contactSelect.onchange();
  await addPanel.children[5].onclick();
  const addException = fixture.privacyExceptionCalls.find(call => call.method === 'POST' && call.body.operation === 'add');
  assert.equal(addException.url, '/api/instances/account-a/account/privacy-exceptions');
  assert.deepEqual(JSON.parse(JSON.stringify(addException.body)), { operation: 'add', key: 'lastSeen', category: 'allowedUsers', entityId: '77' });
  const refreshedInfo = fixture.controls['#setting-account-privacy-list'].children[0].children[0];
  await refreshedInfo.children[2].onclick();
  const refreshedExceptions = refreshedInfo.children[3];
  await refreshedExceptions.children[2].children[2].onclick();
  const removeException = fixture.privacyExceptionCalls.find(call => call.method === 'POST' && !call.body.operation);
  assert.equal(removeException.url, '/api/instances/account-a/account/privacy-exceptions');
  assert.deepEqual(JSON.parse(JSON.stringify(removeException.body)), { key: 'lastSeen', category: 'allowedUsers', entityId: '42' });
});

test('privacy exception picker can find non-contact Telegram users while excluding bots and chats', async () => {
  const fixture = setup({}, { emptyPrivacyExceptions: true });
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const privacyInfo = fixture.controls['#setting-account-privacy-list'].children[0].children[0];
  await privacyInfo.children[2].onclick();
  const exceptionList = privacyInfo.children[3];
  await exceptionList.children[0].onclick();
  const addPanel = exceptionList.children[1];
  await addPanel.children[2].onclick();
  addPanel.children[1].value = 'dana';
  assert.equal(addPanel.children[3].hidden, false);
  await addPanel.children[3].onclick();
  assert.match(fixture.privacySearchCalls[0].url, /query=dana/);
  const contactSelect = addPanel.children[4];
  assert.equal(contactSelect.children.length, 1);
  assert.equal(contactSelect.children[0].textContent, 'Dana Noncontact');
  contactSelect.value = '88'; contactSelect.onchange();
  await addPanel.children[5].onclick();
  const added = fixture.privacyExceptionCalls.find(call => call.method === 'POST' && call.body.operation === 'add');
  assert.deepEqual(JSON.parse(JSON.stringify(added.body)), { operation: 'add', key: 'lastSeen', category: 'allowedUsers', entityId: '88' });
});

test('privacy exception picker can add a searched group to a group-participant rule', async () => {
  const fixture = setup({}, { emptyPrivacyExceptions: true });
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const privacyInfo = fixture.controls['#setting-account-privacy-list'].children[0].children[0];
  await privacyInfo.children[2].onclick();
  const exceptionList = privacyInfo.children[3];
  await exceptionList.children[0].onclick();
  const addPanel = exceptionList.children[1];
  addPanel.children[0].value = 'blockedChats';
  addPanel.children[0].onchange();
  addPanel.children[1].value = 'family';
  addPanel.children[1].oninput();
  await addPanel.children[3].onclick();
  const groupSelect = addPanel.children[4];
  assert.equal(groupSelect.children.length, 1, `${fixture.privacySearchCalls[0]?.url} :: ${addPanel.children[6].textContent}`);
  assert.equal(groupSelect.children[0].textContent, 'Family Group');
  groupSelect.value = '-12'; groupSelect.onchange();
  await addPanel.children[5].onclick();
  const added = fixture.privacyExceptionCalls.find(call => call.method === 'POST' && call.body.operation === 'add');
  assert.deepEqual(JSON.parse(JSON.stringify(added.body)), { operation: 'add', key: 'lastSeen', category: 'blockedChats', chatId: -12 });
});

test('account privacy special rules can be inspected and updated from the selected account', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const privacyInfo = fixture.controls['#setting-account-privacy-list'].children[0].children[0];
  const specialManage = privacyInfo.children[4];
  await specialManage.onclick();
  assert.match(fixture.privacySpecialCalls[0].url, /\/privacy-special-rules\?key=lastSeen$/);
  const panel = privacyInfo.children[5];
  assert.equal(panel.children.length, 3);
  const premium = panel.children[0].children[0];
  premium.checked = true;
  await premium.onchange();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.privacySpecialCalls.find(call => call.method === 'POST').body)), {
    key: 'lastSeen', field: 'allowPremium', value: true,
  });
  assert.match(fixture.privacySpecialCalls.find(call => call.method === 'POST').url, /\/api\/instances\/account-a\/account\/privacy-special-rules$/);
});

test('Telegram global privacy toggles save one field while staying account-scoped', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const list = fixture.controls['#setting-global-privacy-list'];
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].children[0].textContent, '自动归档陌生人');
  const hideReadMarks = list.children[1].children[1];
  assert.equal(hideReadMarks.checked, false);
  hideReadMarks.checked = true;
  await hideReadMarks.onchange();
  const update = fixture.globalPrivacyCalls.find(call => call.method === 'POST');
  assert.equal(update.url, '/api/instances/account-a/account/global-privacy-settings');
  assert.deepEqual(JSON.parse(JSON.stringify(update.body)), { key: 'hideReadMarks', value: true });
  assert.equal(hideReadMarks.disabled, false);
});

test('Telegram notification controls edit only the selected category field', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const list = fixture.controls['#setting-telegram-notifications-list'];
  assert.equal(list.children.length, 3);
  const category = list.children[0];
  const privateRow = category.children[0];
  const controls = privateRow.children[1];
  assert.equal(controls.children[0].value, 'enabled');
  assert.equal(controls.children[1].children[0].checked, true);
  const exceptionButton = controls.children[3];
  const defaultSound = controls.children[4];
  assert.equal(defaultSound.value, 'default');
  defaultSound.value = '77';
  await controls.children[6].onclick();
  assert.equal(controls.children[7].src, '/api/instances/account-a/account/notification-sound-preview?soundId=77');
  await defaultSound.onchange();
  await new Promise(resolve => setImmediate(resolve));
  const defaultSoundUpdate = fixture.notificationCalls.find(call => call.method === 'POST' && call.url.endsWith('/notification-settings'));
  assert.deepEqual(JSON.parse(JSON.stringify(defaultSoundUpdate.body)), { key: 'private', soundId: '77' });
  const defaultStories = controls.children[5];
  const storiesMuted = defaultStories.children[1].children[0];
  storiesMuted.checked = true;
  await storiesMuted.onchange();
  await new Promise(resolve => setImmediate(resolve));
  const storyUpdate = fixture.notificationCalls.filter(call => call.method === 'POST' && call.url.endsWith('/notification-settings')).at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(storyUpdate.body)), { key: 'private', storiesMuted: true });
  controls.children[0].value = 'hour-1';
  await controls.children[0].onchange();
  await new Promise(resolve => setImmediate(resolve));
  const timedMuteUpdate = fixture.notificationCalls.filter(call => call.method === 'POST' && call.url.endsWith('/notification-settings')).at(-1);
  assert.equal(timedMuteUpdate.body.key, 'private');
  assert.ok(timedMuteUpdate.body.muteUntil > Math.floor(Date.now() / 1000));
  assert.ok(timedMuteUpdate.body.muteUntil <= Math.floor(Date.now() / 1000) + 3600);
  await exceptionButton.onclick();
  const exceptions = category.children[1];
  assert.equal(exceptions.hidden, false);
  assert.equal(exceptions.children.length, 1);
  assert.equal(exceptions.children[0].children[0].children[0].textContent, 'Alice Example');
  assert.match(exceptions.children[0].children[0].children[1].textContent, /已静音/);
  const exceptionControls = exceptions.children[0].children[1];
  assert.match(exceptions.children[0].children[0].children[1].textContent, /Soft bell/);
  assert.match(exceptions.children[0].children[0].children[1].textContent, /故事已静音/);
  const exceptionPreview = exceptionControls.children[1].children[0];
  exceptionPreview.checked = true;
  await exceptionPreview.onchange();
  await new Promise(resolve => setImmediate(resolve));
  const exceptionUpdate = fixture.notificationCalls.find(call => call.method === 'POST' && call.url.endsWith('/notification-exceptions'));
  assert.equal(exceptionUpdate.url, '/api/instances/account-a/account/notification-exceptions');
  assert.deepEqual(JSON.parse(JSON.stringify(exceptionUpdate.body)), { key: 'private', chatId: 42, showPreviews: true });
  const exceptionSound = exceptionControls.children[3];
  exceptionSound.value = 'none';
  await exceptionSound.onchange();
  await new Promise(resolve => setImmediate(resolve));
  const exceptionSoundUpdate = fixture.notificationCalls.find(call => call.method === 'POST' && call.url.endsWith('/notification-exceptions') && call.body?.soundId);
  assert.deepEqual(JSON.parse(JSON.stringify(exceptionSoundUpdate.body)), { key: 'private', chatId: 42, soundId: 'none' });
  const exceptionStories = exceptionControls.children[4];
  const exceptionStoriesMuted = exceptionStories.children[1].children[0];
  exceptionStoriesMuted.checked = false;
  await exceptionStoriesMuted.onchange();
  await new Promise(resolve => setImmediate(resolve));
  const exceptionStoryUpdate = fixture.notificationCalls.filter(call => call.method === 'POST' && call.url.endsWith('/notification-exceptions')).at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(exceptionStoryUpdate.body)), { key: 'private', chatId: 42, storiesMuted: false });
  exceptionControls.children[0].value = 'day-2';
  await exceptionControls.children[0].onchange();
  await new Promise(resolve => setImmediate(resolve));
  const timedExceptionUpdate = fixture.notificationCalls.filter(call => call.method === 'POST' && call.url.endsWith('/notification-exceptions')).at(-1);
  assert.equal(timedExceptionUpdate.body.key, 'private');
  assert.equal(timedExceptionUpdate.body.chatId, 42);
  assert.ok(timedExceptionUpdate.body.muteUntil > Math.floor(Date.now() / 1000));
  assert.ok(timedExceptionUpdate.body.muteUntil <= Math.floor(Date.now() / 1000) + 172800);
  controls.children[0].value = 'muted';
  controls.children[0].onchange();
  await new Promise(resolve => setImmediate(resolve));
  const update = fixture.notificationCalls.find(call => call.method === 'POST' && call.url.endsWith('/notification-settings'));
  assert.equal(update.url, '/api/instances/account-a/account/notification-settings');
  assert.deepEqual(JSON.parse(JSON.stringify(update.body)), { key: 'private', soundId: '77' });
  const muteUpdate = fixture.notificationCalls.filter(call => call.method === 'POST' && call.url.endsWith('/notification-settings')).at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(muteUpdate.body)), { key: 'private', muted: true });
  assert.match(privateRow.children[0].children[1].textContent, /已静音/);
});

test('notification sound settings upload an audio stream and remove a saved ringtone', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const tools = fixture.controls['#setting-notification-sounds-tools'];
  assert.equal(tools.children[0].textContent, '上传提示音');
  const input = tools.children[1];
  input.files = [Object.assign(new Blob(['OggS1234'], { type: 'audio/ogg' }), { name: 'bell.ogg' })];
  await input.onchange();
  const upload = fixture.fetchCalls.find(call => call.options.method === 'POST' && call.url.endsWith('/notification-sounds'));
  assert.ok(upload);
  assert.equal(upload.options.headers['Content-Type'], 'application/vnd.tguserbot.media-stream');
  const encoded = new Uint8Array(await upload.options.body.slice(4).arrayBuffer());
  const prefix = await upload.options.body.slice(0, 4).arrayBuffer();
  const metadataLength = new DataView(prefix).getUint32(0);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded.subarray(0, metadataLength))), { fileName: 'bell.ogg', mimeType: 'audio/ogg' });
  const refreshedTools = fixture.controls['#setting-notification-sounds-tools'];
  const saved = refreshedTools.children.find(child => child.className === 'settings-notification-sound-item');
  assert.ok(saved);
  await saved.children[1].onclick();
  const remove = fixture.notificationCalls.find(call => call.url.endsWith('/notification-sounds/remove'));
  assert.deepEqual(JSON.parse(JSON.stringify(remove.body)), { soundId: '77' });
});

test('Telegram Stars balance and history load only for the selected account', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.controls['#setting-stars-balance'].textContent, '1,234 ⭐');
  assert.equal(fixture.controls['#setting-stars-history'].children.length, 1);
  assert.match(fixture.controls['#setting-stars-history'].children[0].children[0].textContent, /Telegram gift/);
  assert.equal(fixture.starsCalls.length, 1);
  assert.equal(fixture.starsCalls[0].url, '/api/instances/account-a/account/stars?offset=&limit=20');
  assert.equal(fixture.starGiftCalls.length, 1);
  assert.equal(fixture.controls['#setting-star-gifts-list'].children.length, 1);
  assert.equal(fixture.controls['#setting-star-gifts-list'].children[0].children[0].src,
    '/api/instances/account-a/account/sticker-thumb?docId=500&accessHash=-88&fileRef=AQI%3D');
  assert.match(fixture.controls['#setting-star-gifts-list'].children[0].children[2].children[1].textContent, /15 ⭐/);
  const subscriptions = fixture.controls['#setting-stars-subscriptions-list'];
  assert.equal(subscriptions.children.length, 1);
  assert.match(subscriptions.children[0].children[0].children[0].textContent, /Premium subscription/);
  await subscriptions.children[0].children[1].onclick();
  const cancel = fixture.starsSubscriptionCalls.find(call => call.method === 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(cancel.body)), { subscriptionId: 'sub-1', canceled: true });
  assert.match(subscriptions.children[0].children[0].children[1].textContent, /已取消/);
});

test('default auto-delete timer loads and saves custom durations for the selected Telegram account', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const select = fixture.controls['#setting-default-history-ttl'];
  const status = fixture.controls['#setting-default-history-ttl-status'];
  assert.equal(select.value, '604800');
  assert.equal(select.disabled, false);
  assert.equal(fixture.defaultHistoryTtlCalls[0].url, '/api/instances/account-a/account/default-history-ttl');
  select.value = '31536000';
  await select.handlers.change({ currentTarget: select });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.defaultHistoryTtlCalls.at(-1).method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.defaultHistoryTtlCalls.at(-1).body)), { period: 31536000 });
  assert.equal(select.dataset.savedPeriod, '31536000');
  assert.match(status.textContent, /已设置新聊天/);
});

test('default auto-delete picker pages active and archived chats and reports partial updates', async () => {
  const fixture = setup();
  fixture.state.clientSelectedInstance = 'account-a';
  fixture.settingsPage.refresh();
  await new Promise(resolve => setImmediate(resolve));
  await fixture.controls['#btn-open-default-history-ttl-picker'].handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.defaultHistoryTtlChatCalls.length, 2);
  const list = fixture.controls['#setting-default-history-ttl-chats'];
  assert.equal(list.children.length, 2);
  const first = list.children[0].children[0];
  const second = list.children[1].children[0];
  first.checked = true;
  first.handlers.change();
  second.checked = true;
  second.handlers.change();
  await fixture.controls['#btn-apply-default-history-ttl'].handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.defaultHistoryTtlBulkCalls[0].body)), { chatIds: [7, -9], period: 604800 });
  assert.equal(fixture.controls['#setting-default-history-ttl-picker-status'].textContent, '1 个聊天已更新，1 个未能更新。');
  assert.equal(fixture.controls['#setting-default-history-ttl-chats'].children[1].children[0].checked, true);
});

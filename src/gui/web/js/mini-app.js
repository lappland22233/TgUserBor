'use strict';

// Limited Mini App host. The app runs with an opaque origin and receives only
// public visual data. Authentication data and capabilities are never logged.
window.MiniApp = (() => {
  let active = null;
  let generation = 0;
  let overlay, frame, status, linkArea, frameArea, backButton, settingsButton, mainButton, secondaryButton, buttonRow, popupRoot;
  let motionTimer, orientationTimer, qrScanner, qrDecoderPromise;
  let motionState = { accelerometerRate: -1, gyroscopeRate: -1, accelerometerLast: 0, gyroscopeLast: 0 };
  let orientationState = { rate: -1, last: 0, absolute: false, eventName: 'deviceorientation' };

  function current(context) {
    return Boolean(context && state.clientSelectedInstance === context.instId &&
      String(state.clientActiveChatId) === String(context.chatId) &&
      state.chatSelectionVersion === context.selectionVersion);
  }
  function safeExternalUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const localName = host === 'localhost' || ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home', '.home.arpa']
        .some((suffix) => host.endsWith(suffix));
      if (host === location.hostname.toLowerCase() || localName || !host.includes('.') ||
          host.startsWith('[') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
      return url.href;
    } catch { return null; }
  }
  function safeTelegramUrl(pathFull) {
    if (typeof pathFull !== 'string' || pathFull.length > 16384 || /[\u0000-\u001f\u007f\\]/.test(pathFull)) return null;
    const path = pathFull.replace(/^\/+/, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) return null;
    try { return new URL(`https://t.me/${path}`).href; } catch { return null; }
  }
  function displayExternalLink(url, label) {
    linkArea.replaceChildren();
    if (!url) { status.textContent = '此链接不可用。'; return; }
    // A separate trusted click is required; the app cannot open a popup itself.
    const link = document.createElement('a'); link.href = url; link.target = '_blank';
    link.rel = 'noopener noreferrer'; link.textContent = label;
    linkArea.appendChild(link);
  }
  function loadQrDecoder() {
    if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
    if (qrDecoderPromise) return qrDecoderPromise;
    qrDecoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/vendor/jsQR.js';
      script.async = true;
      script.onload = () => typeof window.jsQR === 'function' ? resolve(window.jsQR) : reject(new Error('QR decoder unavailable'));
      script.onerror = () => reject(new Error('QR decoder unavailable'));
      document.head.appendChild(script);
    }).catch(error => { qrDecoderPromise = null; throw error; });
    return qrDecoderPromise;
  }
  function triggerHaptic(data) {
    if (!data || typeof data !== 'object' || typeof navigator?.vibrate !== 'function') return;
    let pattern;
    if (data.type === 'impact') {
      pattern = { light: 8, medium: 16, heavy: 28, rigid: 22, soft: 10 }[data.impact_style];
    } else if (data.type === 'notification') {
      pattern = { success: [12, 24, 12], warning: [22, 30, 22], error: [30, 25, 30] }[data.notification_type];
    } else if (data.type === 'selection_change') pattern = 6;
    if (pattern) { try { navigator.vibrate(pattern); } catch (_) {} }
  }
  function ensureUi() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'mini-app-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<div class="mini-app-window" role="dialog" aria-modal="true" aria-label="Mini App（受限模式）">
      <div class="mini-app-header"><button type="button" class="btn btn-secondary btn-sm" data-back aria-label="Mini App 返回" hidden>返回</button><strong>Mini App（受限模式）</strong><div class="mini-app-header-actions"><button type="button" class="btn btn-secondary btn-sm" data-settings aria-label="Mini App 设置" hidden>设置</button><button type="button" class="btn btn-secondary btn-sm" data-close aria-label="关闭 Mini App">关闭</button></div></div>
      <p class="mini-app-hint">Mini App 发票仅支持 Telegram Stars 付款；其他付款方式暂不可用。</p>
      <div class="mini-app-status" role="status"></div><div class="mini-app-link"></div><div class="mini-app-frame-area"></div>
      <div class="mini-app-button-row"><button type="button" class="mini-app-secondary-button" hidden></button><button type="button" class="mini-app-main-button" hidden></button></div>
    </div>`;
    document.body.appendChild(overlay);
    status = overlay.querySelector('.mini-app-status');
    linkArea = overlay.querySelector('.mini-app-link');
    frameArea = overlay.querySelector('.mini-app-frame-area');
    backButton = overlay.querySelector('[data-back]');
    settingsButton = overlay.querySelector('[data-settings]');
    mainButton = overlay.querySelector('.mini-app-main-button');
    secondaryButton = overlay.querySelector('.mini-app-secondary-button');
    buttonRow = overlay.querySelector('.mini-app-button-row');
    overlay.querySelector('[data-close]').onclick = requestClose;
    backButton.onclick = () => { if (active && current(active.context)) post('back_button_pressed', {}); };
    settingsButton.onclick = () => { if (active && current(active.context)) post('settings_button_pressed', {}); };
    mainButton.onclick = () => { if (active && current(active.context) && !mainButton.disabled) post('main_button_pressed', {}); };
    secondaryButton.onclick = () => { if (active && current(active.context) && !secondaryButton.disabled) post('secondary_button_pressed', {}); };
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); requestClose(); } });
  }
  async function endRemote(session) {
    if (!session?.key) return;
    try {
      await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app`, {
        method: 'DELETE', headers: { 'X-Mini-App-Key': session.key }, cache: 'no-store',
      });
    } catch (_) { /* Server also expires the capability. */ }
  }
  function close() {
    generation++;
    const old = active;
    if (old) post('visibility_changed', { is_visible: false });
    if (qrScanner && old) finishQrScanner(old, false);
    stopSensors();
    const appWindow = overlay?.querySelector('.mini-app-window');
    if (document.fullscreenElement === appWindow) { try { void document.exitFullscreen?.(); } catch (_) {} }
    active = null;
    if (old?.timer) clearTimeout(old.timer);
    old?.themeObserver?.disconnect();
    if (overlay) overlay.hidden = true;
    if (frameArea) frameArea.replaceChildren();
    frame = null;
    if (linkArea) linkArea.replaceChildren();
    if (backButton) backButton.hidden = true;
    if (settingsButton) settingsButton.hidden = true;
    if (buttonRow) buttonRow.hidden = true;
    if (buttonRow) buttonRow.style.backgroundColor = '';
    if (mainButton) { mainButton.hidden = true; mainButton.disabled = false; mainButton.textContent = ''; mainButton.style.backgroundColor = ''; mainButton.style.color = ''; }
    if (secondaryButton) { secondaryButton.hidden = true; secondaryButton.disabled = false; secondaryButton.textContent = ''; secondaryButton.style.backgroundColor = ''; secondaryButton.style.color = ''; }
    if (overlay) overlay.querySelector('.mini-app-window').style.backgroundColor = '';
    if (overlay) overlay.querySelector('.mini-app-header').style.backgroundColor = '';
    if (popupRoot) { popupRoot.remove(); popupRoot = null; }
    void endRemote(old);
  }
  function requestClose() {
    if (!active || !current(active.context)) { close(); return; }
    if (!active.needCloseConfirmation) { close(); return; }
    if (qrScanner?.session === active) finishQrScanner(active, true);
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '关闭 Mini App？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = '更改可能尚未保存。';
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'btn btn-secondary btn-sm'; keep.textContent = '继续使用';
    keep.onclick = () => { popupRoot?.remove(); popupRoot = null; };
    const closeAnyway = document.createElement('button'); closeAnyway.type = 'button'; closeAnyway.className = 'btn btn-danger btn-sm'; closeAnyway.textContent = '关闭';
    closeAnyway.onclick = () => { if (active) close(); };
    actions.append(keep, closeAnyway); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }
  function post(type, data) {
    // Opaque sandbox origins cannot be addressed by a concrete target origin.
    // The capability stays in the host; only protocol data is sent to this frame.
    if (active && frame?.contentWindow && current(active.context)) {
      frame.contentWindow.postMessage(JSON.stringify({ eventType: type, eventData: data }), '*');
    }
  }
  function sendTheme() {
    const root = document.documentElement;
    const computed = typeof getComputedStyle === 'function' && root ? getComputedStyle(root) : null;
    const parse = value => {
      const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value || '');
      if (hex) {
        const raw = hex[1].length === 3 ? [...hex[1]].map(char => char + char).join('') : hex[1];
        return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), 1];
      }
      const rgb = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+)%?\s*)?\)$/i.exec(value || '');
      if (!rgb) return null;
      const alpha = rgb[4] == null ? 1 : Math.min(1, Math.max(0, Number(rgb[4]) / (value.includes('%') ? 100 : 1)));
      return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
    };
    const color = (token, fallback, underlay) => {
      const parsed = parse(computed?.getPropertyValue(token)?.trim()) || parse(fallback) || [0, 0, 0, 1];
      const base = parse(underlay) || [0, 0, 0, 1];
      const alpha = parsed[3];
      return `#${parsed.slice(0, 3).map((channel, index) => Math.round(channel * alpha + base[index] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
    };
    const background = color('--bg-app', '#0c0f14');
    const section = color('--bg-card', '#161c26', background);
    post('theme_changed', { color_scheme: root?.dataset?.theme === 'light' ? 'light' : 'dark', theme_params: {
      bg_color: background,
      text_color: color('--text-primary', '#f8fafc'),
      hint_color: color('--text-muted', '#64748b'),
      link_color: color('--tg-link', '#4fa7f5'),
      button_color: color('--color-primary', '#007aff'),
      button_text_color: color('--tg-out-text', '#ffffff'),
      secondary_bg_color: section,
      header_bg_color: color('--bg-header', background, background),
      accent_text_color: color('--color-primary', '#007aff'),
      section_bg_color: section,
      section_header_text_color: color('--text-secondary', '#94a3b8'),
      subtitle_text_color: color('--text-muted', '#64748b'),
      destructive_text_color: color('--color-danger', '#ff3b30'),
    } });
  }
  function sendViewport() {
    if (!frame) return;
    const height = Math.max(0, Math.round(frame.getBoundingClientRect().height));
    post('viewport_changed', { height, width: Math.max(0, Math.round(frame.getBoundingClientRect().width)), is_expanded:true, is_state_stable:true });
  }
  function showPopup(data) {
    if (!active || !current(active.context) || !data || typeof data !== 'object') return;
    const buttons = Array.isArray(data.buttons) ? data.buttons.slice(0, 3).filter(button => button &&
      typeof button.id === 'string' && button.id.length > 0 && button.id.length <= 64 && typeof button.text === 'string' && button.text.length <= 64) : [];
    if (!buttons.length || typeof data.message !== 'string' || data.message.length > 2048) {
      status.textContent = '此 Mini App 弹窗请求不可用。';
      return;
    }
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    popupRoot.setAttribute('role', 'presentation');
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    if (typeof data.title === 'string' && data.title.trim()) {
      const title = document.createElement('strong'); title.className = 'mini-app-popup-title';
      title.textContent = data.title.slice(0, 128); dialog.appendChild(title);
    }
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = data.message;
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    for (const item of buttons) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = item.type === 'destructive' ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm';
      button.textContent = item.text;
      button.onclick = () => {
        if (!active || !current(active.context)) return;
        post('popup_closed', { button_id: item.id });
        popupRoot?.remove(); popupRoot = null;
      };
      actions.appendChild(button);
    }
    dialog.append(message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }
  async function prolong(session) {
    if (active !== session || !current(session.context)) { if (active === session) close(); return; }
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/prolong`, {
        method:'POST', headers:{'X-Mini-App-Key':session.key}, cache:'no-store',
      });
      if (active !== session) return;
      if (!response.ok) { status.textContent = '会话已过期，请关闭后重新打开。'; return; }
    } catch (_) {
      if (active !== session) return;
      status.textContent = '连接暂时中断，正在重试。';
    }
    if (active === session) session.timer = setTimeout(() => prolong(session), 50000);
  }

  function validVector(vector) {
    return vector && ['x', 'y', 'z'].every(axis => Number.isFinite(vector[axis]));
  }
  function removeMotionListener() {
    window.removeEventListener?.('devicemotion', handleDeviceMotion, true);
    if (motionTimer) clearTimeout(motionTimer);
    motionTimer = null;
  }
  function setupMotion() {
    removeMotionListener();
    if (motionState.accelerometerRate === -1 && motionState.gyroscopeRate === -1) return;
    window.addEventListener?.('devicemotion', handleDeviceMotion, true);
    motionTimer = setTimeout(() => {
      if (!active) return;
      if (motionState.accelerometerRate !== -1) post('accelerometer_failed', { error: 'UNSUPPORTED' });
      if (motionState.gyroscopeRate !== -1) post('gyroscope_failed', { error: 'UNSUPPORTED' });
      motionState.accelerometerRate = -1;
      motionState.gyroscopeRate = -1;
      removeMotionListener();
    }, 1000);
  }
  function handleDeviceMotion(event) {
    if (!active || !current(active.context)) return;
    if (motionTimer) {
      clearTimeout(motionTimer); motionTimer = null;
      if (motionState.accelerometerRate !== -1) {
        if (validVector(event.acceleration)) post('accelerometer_started', {});
        else { post('accelerometer_failed', { error: 'UNSUPPORTED' }); motionState.accelerometerRate = -1; }
      }
      if (motionState.gyroscopeRate !== -1) {
        const rotation = event.rotationRate && { x: event.rotationRate.alpha, y: event.rotationRate.beta, z: event.rotationRate.gamma };
        if (validVector(rotation)) post('gyroscope_started', {});
        else { post('gyroscope_failed', { error: 'UNSUPPORTED' }); motionState.gyroscopeRate = -1; }
      }
      if (motionState.accelerometerRate === -1 && motionState.gyroscopeRate === -1) removeMotionListener();
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (motionState.accelerometerRate !== -1 && now - motionState.accelerometerLast >= motionState.accelerometerRate && validVector(event.acceleration)) {
      motionState.accelerometerLast = now;
      post('accelerometer_changed', { x: event.acceleration.x, y: event.acceleration.y, z: event.acceleration.z });
    }
    const rotation = event.rotationRate && { x: event.rotationRate.alpha, y: event.rotationRate.beta, z: event.rotationRate.gamma };
    if (motionState.gyroscopeRate !== -1 && now - motionState.gyroscopeLast >= motionState.gyroscopeRate && validVector(rotation)) {
      motionState.gyroscopeLast = now;
      post('gyroscope_changed', rotation);
    }
  }
  function startAccelerometer(data) {
    motionState.accelerometerRate = Math.min(1000, Math.max(20, Number(data?.refresh_rate) || 20));
    setupMotion();
  }
  function startGyroscope(data) {
    motionState.gyroscopeRate = Math.min(1000, Math.max(20, Number(data?.refresh_rate) || 20));
    setupMotion();
  }
  function stopAccelerometer() {
    motionState.accelerometerRate = -1; setupMotion(); post('accelerometer_stopped', {});
  }
  function stopGyroscope() {
    motionState.gyroscopeRate = -1; setupMotion(); post('gyroscope_stopped', {});
  }
  function handleDeviceOrientation(event) {
    if (!active || orientationState.rate === -1 || !current(active.context)) return;
    if (orientationTimer) {
      clearTimeout(orientationTimer); orientationTimer = null;
      if ([event.alpha, event.beta, event.gamma].every(Number.isFinite)) post('device_orientation_started', {});
      else { post('device_orientation_failed', { error: 'UNSUPPORTED' }); stopOrientation(false); return; }
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - orientationState.last < orientationState.rate || ![event.alpha, event.beta, event.gamma].every(Number.isFinite)) return;
    orientationState.last = now;
    post('device_orientation_changed', { absolute: event.absolute === true, alpha: event.alpha, beta: event.beta, gamma: event.gamma });
  }
  function stopOrientation(emit = true) {
    window.removeEventListener?.(orientationState.eventName, handleDeviceOrientation, true);
    if (orientationTimer) clearTimeout(orientationTimer);
    orientationTimer = null; orientationState.rate = -1;
    if (emit) post('device_orientation_stopped', {});
  }
  function startOrientation(data) {
    stopOrientation(false);
    orientationState.rate = Math.min(1000, Math.max(20, Number(data?.refresh_rate) || 20));
    orientationState.absolute = data?.need_absolute === true && 'ondeviceorientationabsolute' in window;
    orientationState.eventName = orientationState.absolute ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener?.(orientationState.eventName, handleDeviceOrientation, true);
    orientationTimer = setTimeout(() => {
      if (active && orientationState.rate !== -1) {
        post('device_orientation_failed', { error: 'UNSUPPORTED' });
        stopOrientation(false);
      }
    }, 1000);
  }
  function stopSensors() {
    motionState.accelerometerRate = -1; motionState.gyroscopeRate = -1;
    removeMotionListener(); stopOrientation(false);
  }
  function dispatchUnsupported(type, data) {
    if (type === 'web_app_add_to_home_screen') post('home_screen_failed', { error: 'UNSUPPORTED' });
    else if (type === 'web_app_check_home_screen') post('home_screen_checked', { status: 'unsupported' });
    else if (type === 'web_app_biometry_get_info') post('biometry_info_received', {
      available: false, access_requested: false, access_granted: false, token_saved: false, device_id: '',
    });
    else if (type.startsWith('web_app_secure_storage_') && (typeof data?.req_id === 'string' || Number.isSafeInteger(data?.req_id))) {
      post('secure_storage_failed', { req_id: data.req_id, error: 'UNSUPPORTED' });
    } else return false;
    return true;
  }
  async function requestFullscreen(session) {
    const target = overlay?.querySelector('.mini-app-window');
    if (document.fullscreenElement === target) { post('fullscreen_failed', { error: 'ALREADY_FULLSCREEN' }); return; }
    if (!target || typeof target.requestFullscreen !== 'function') { post('fullscreen_failed', { error: 'UNSUPPORTED' }); return; }
    try { await target.requestFullscreen(); }
    catch (_) { if (active === session) post('fullscreen_failed', { error: 'UNSUPPORTED' }); }
  }
  function exitFullscreen() {
    const target = overlay?.querySelector('.mini-app-window');
    if (document.fullscreenElement === target) {
      try { void document.exitFullscreen?.(); } catch (_) {}
    }
    post('fullscreen_changed', { is_fullscreen: false });
  }
  function handleFullscreenChange() {
    if (!active) return;
    post('fullscreen_changed', { is_fullscreen: document.fullscreenElement === overlay?.querySelector('.mini-app-window') });
  }
  function handleVisibilityChange() {
    if (!active) return;
    const visible = document.visibilityState !== 'hidden';
    if (!visible && qrScanner) finishQrScanner(active, true);
    post('visibility_changed', { is_visible: visible });
  }
  async function startSession(context, openRequest) {
    if (!current(context)) return;
    close();
    const request = generation;
    ensureUi(); overlay.hidden = false; status.textContent = '正在打开…';
    try {
      const response = await openRequest();
      if (!response.ok) throw new Error('无法启动 Mini App');
      const result = await response.json();
      const session = { context, key:result.capability, botId:result.botId, accountId:result.accountId,
        simpleWebView:result.simpleWebView === true, buttonText:typeof result.buttonText === 'string' ? result.buttonText : '', timer:null, count:0, windowStart:0 };
      if (generation !== request || !current(context)) { void endRemote(session); return; }
      const url = safeExternalUrl(result.url);
      if (!url || typeof session.key !== 'string' || !session.key) { void endRemote(session); throw new Error('启动地址不可用'); }
      active = session;
      if (typeof MutationObserver === 'function') {
        session.themeObserver = new MutationObserver(() => { if (active === session) sendTheme(); });
        session.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      backButton.hidden = true;
      settingsButton.hidden = true;
      mainButton.hidden = true;
      secondaryButton.hidden = true;
      buttonRow.hidden = true;
      buttonRow.className = 'mini-app-button-row';
      frame = document.createElement('iframe');
      frame.className = 'mini-app-frame';
      frame.setAttribute('title', 'Mini App');
      frame.setAttribute('sandbox', 'allow-scripts allow-forms');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.onload = () => { if (active === session) { sendTheme(); sendViewport(); post('visibility_changed', { is_visible: true }); } };
      frameArea.replaceChildren(frame);
      frame.src = url;
      status.textContent = '受限模式：部分功能可能不可用。';
      if (!session.simpleWebView) session.timer = setTimeout(() => prolong(session), 50000);
    } catch (error) {
      if (generation === request) status.textContent = `无法打开 Mini App：${error.message}`;
    }
  }
  async function open(context, row, column) {
    if (!current(context) || !Number.isInteger(row) || !Number.isInteger(column)) return;
    return startSession(context, () => fetch(`/api/instances/${encodeURIComponent(context.instId)}/account/mini-app`, {
      method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store',
      body:JSON.stringify({chatId:context.chatId, messageId:context.messageId, row, column}),
    }));
  }
  async function openBotMenu(context) {
    if (!current(context)) return;
    return startSession(context, () => fetch(`/api/instances/${encodeURIComponent(context.instId)}/account/mini-app/menu`, {
      method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store', body:JSON.stringify({chatId:context.chatId}),
    }));
  }
  async function invokeCustomMethod(session, data) {
    const requestId = data?.req_id;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || String(requestId).length > 64) return;
    const fail = () => post('custom_method_invoked', { req_id: requestId, error: { code: 500, message: 'Mini App custom method failed' } });
    if (typeof data?.method !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(data.method)) { fail(); return; }
    let paramsJson;
    try { paramsJson = JSON.stringify(data.params ?? {}); } catch { fail(); return; }
    if (typeof paramsJson !== 'string' || new TextEncoder().encode(paramsJson).length > 4096) { fail(); return; }
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/method`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
        cache: 'no-store', body: JSON.stringify({ method: data.method, paramsJson }),
      });
      if (active !== session || !current(session.context) || response.ok !== true) throw new Error('Unavailable');
      const result = await response.json();
      if (active !== session || !current(session.context)) return;
      let value = result?.result;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) { /* Telegram may return a string value. */ }
      }
      post('custom_method_invoked', { req_id: requestId, result: value });
    } catch (_) {
      if (active === session && current(session.context)) fail();
    }
  }
  function validStorageKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= 128 && !/[\u0000-\u001f\u007f]/.test(key);
  }
  function deviceStoragePrefix(session) {
    if (!/^\d+$/.test(session.accountId || '') || !/^\d+$/.test(session.botId || '')) return null;
    return `tg-miniapp-device:v1:${encodeURIComponent(session.context.instId)}:${session.accountId}:${session.botId}:`;
  }
  function deviceStorageError(requestId, message) {
    const error = message === 'Invalid device storage key' ? 'KEY_INVALID' :
      message === 'Invalid device storage value' || message === 'Device storage value is too large' ? 'VALUE_INVALID' :
      message === 'Device storage is full' || message === 'Device storage has too many keys' ? 'QUOTA_EXCEEDED' : 'UNKNOWN_ERROR';
    post('device_storage_failed', { req_id: requestId, error });
  }
  function handleDeviceStorage(session, type, data) {
    const requestId = data?.req_id;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || String(requestId).length > 64) return;
    const prefix = deviceStoragePrefix(session);
    if (!prefix) { deviceStorageError(requestId, 'Device storage is unavailable'); return; }
    const storage = typeof localStorage === 'undefined' ? null : localStorage;
    if (!storage) { deviceStorageError(requestId, 'Device storage is unavailable'); return; }
    const key = data?.key;
    const fullKey = validStorageKey(key) ? prefix + key : null;
    try {
      if (type === 'web_app_device_storage_get_key') {
        if (!fullKey) { deviceStorageError(requestId, 'Invalid device storage key'); return; }
        post('device_storage_key_received', { req_id: requestId, key, value: storage.getItem(fullKey) });
      } else if (type === 'web_app_device_storage_save_key') {
        if (!fullKey || typeof data?.value !== 'string') { deviceStorageError(requestId, 'Invalid device storage value'); return; }
        const valueBytes = new TextEncoder().encode(data.value).length;
        if (valueBytes > 4096) { deviceStorageError(requestId, 'Device storage value is too large'); return; }
        let bytes = 0, keys = 0;
        for (let i = 0; i < storage.length; i++) {
          const current = storage.key(i);
          if (current?.startsWith(prefix)) { keys++; bytes += new TextEncoder().encode(storage.getItem(current) || '').length; }
        }
        const previous = storage.getItem(fullKey);
        if (previous === null && keys >= 1000) { deviceStorageError(requestId, 'Device storage has too many keys'); return; }
        if (bytes - new TextEncoder().encode(previous || '').length + valueBytes > 262144) {
          deviceStorageError(requestId, 'Device storage is full'); return;
        }
        storage.setItem(fullKey, data.value);
        post('device_storage_key_saved', { req_id: requestId, key });
      } else if (type === 'web_app_device_storage_get_keys') {
        const keys = [];
        for (let i = 0; i < storage.length && keys.length < 1000; i++) {
          const current = storage.key(i);
          if (current?.startsWith(prefix)) keys.push(current.slice(prefix.length));
        }
        post('device_storage_keys_received', { req_id: requestId, keys });
      } else if (type === 'web_app_device_storage_remove_key') {
        if (!fullKey) { deviceStorageError(requestId, 'Invalid device storage key'); return; }
        storage.removeItem(fullKey);
        post('device_storage_key_removed', { req_id: requestId, key });
      } else if (type === 'web_app_device_storage_clear') {
        for (let i = storage.length - 1; i >= 0; i--) {
          const current = storage.key(i);
          if (current?.startsWith(prefix)) storage.removeItem(current);
        }
        post('device_storage_cleared', { req_id: requestId });
      }
    } catch (_) { deviceStorageError(requestId, 'Device storage operation failed'); }
  }

  function updateButton(button, data, fallbackText) {
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, 64) : '';
    button.textContent = text || fallbackText;
    button.disabled = data.is_active === false || data.is_progress_visible === true;
    button.hidden = data.is_visible !== true;
    button.setAttribute('aria-busy', data.is_progress_visible === true ? 'true' : 'false');
    button.style.backgroundColor = /^#[\da-f]{6}$/i.test(data.color || '') ? data.color : '';
    button.style.color = /^#[\da-f]{6}$/i.test(data.text_color || '') ? data.text_color : '';
  }

  function requestClipboardRead(session, data) {
    const requestId = data?.req_id;
    if ((typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) || String(requestId).length > 64) return;
    linkArea.replaceChildren();
    status.textContent = 'Mini App 请求读取剪贴板；只有点击下方按钮后才会授权。';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn btn-secondary btn-sm'; button.textContent = '允许读取剪贴板';
    button.onclick = async () => {
      if (active !== session || !current(session.context)) return;
      button.disabled = true;
      try {
        if (typeof navigator.clipboard?.readText !== 'function') throw new Error('unavailable');
        const text = await navigator.clipboard.readText();
        if (active !== session || !current(session.context)) return;
        if (new TextEncoder().encode(text).length > 16384) throw new Error('too_large');
        post('clipboard_text_received', { req_id: requestId, data: text });
        status.textContent = '剪贴板文本已交给当前 Mini App。';
      } catch (error) {
        if (active !== session || !current(session.context)) return;
        status.textContent = error?.message === 'too_large' ? '剪贴板文本过长，未发送给 Mini App。' : '无法读取剪贴板，请检查浏览器权限。';
        post('clipboard_text_received', { req_id: requestId });
      } finally {
        if (active === session) linkArea.replaceChildren();
      }
    };
    linkArea.appendChild(button);
  }

  async function requestWriteAccess(session) {
    if (session.writeAccessPending) return;
    session.writeAccessPending = true;
    const endpoint = `/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/write-access`;
    try {
      const response = await fetch(endpoint, { headers: { 'X-Mini-App-Key': session.key }, cache: 'no-store' });
      if (active !== session || !current(session.context)) return;
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json();
      if (result?.allowed === true) {
        session.writeAccessPending = false;
        post('write_access_requested', { status: 'allowed' });
        return;
      }
    } catch (_) {
      if (active !== session || !current(session.context)) return;
      session.writeAccessPending = false;
      status.textContent = '无法检查机器人的消息权限。';
      post('write_access_requested', { status: 'cancelled' });
      return;
    }

    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '允许机器人发送消息？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = '允许后，此机器人可以向你的 Telegram 账号发送消息。';
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    cancel.onclick = () => {
      if (active !== session) return;
      session.writeAccessPending = false; popupRoot?.remove(); popupRoot = null;
      post('write_access_requested', { status: 'cancelled' });
    };
    const allow = document.createElement('button'); allow.type = 'button'; allow.className = 'btn btn-primary btn-sm'; allow.textContent = '允许';
    allow.onclick = async () => {
      if (active !== session || !current(session.context)) return;
      allow.disabled = true;
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Mini-App-Key': session.key }, cache: 'no-store' });
        if (!response.ok || active !== session || !current(session.context)) throw new Error('unavailable');
        session.writeAccessPending = false; popupRoot?.remove(); popupRoot = null;
        status.textContent = '已允许此机器人向你发送消息。';
        post('write_access_requested', { status: 'allowed' });
      } catch (_) {
        if (active !== session || !current(session.context)) return;
        session.writeAccessPending = false; popupRoot?.remove(); popupRoot = null;
        status.textContent = '未能更新机器人权限。';
        post('write_access_requested', { status: 'cancelled' });
      }
    };
    actions.append(cancel, allow); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  function finishQrScanner(session, notifyMiniApp = true, text) {
    const scanner = qrScanner;
    if (!scanner || scanner.session !== session) return;
    qrScanner = null;
    if (scanner.frameId != null) window.cancelAnimationFrame?.(scanner.frameId);
    if (scanner.timer != null) clearTimeout(scanner.timer);
    for (const track of scanner.stream?.getTracks?.() || []) { try { track.stop(); } catch (_) {} }
    if (scanner.video) scanner.video.srcObject = null;
    scanner.root?.remove();
    if (popupRoot === scanner.root) popupRoot = null;
    if (!notifyMiniApp || active !== session || !current(session.context)) return;
    if (typeof text === 'string') {
      status.textContent = 'QR 内容已交给当前 Mini App。';
      post('qr_text_received', { data: text });
    }
    post('scan_qr_popup_closed', {});
  }

  function openScanQrPopup(session) {
    if (qrScanner?.session === session) return;
    if (qrScanner) finishQrScanner(qrScanner.session, true);
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      status.textContent = '此浏览器无法访问相机。';
      post('scan_qr_popup_closed', {});
      return;
    }
    let detector = null;
    try {
      if (typeof window.BarcodeDetector === 'function') detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) { /* Use the local JavaScript decoder below. */ }

    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const root = popupRoot;
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '扫描 QR 码';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message';
    message.textContent = '相机仅在本机用于识别 QR 码，画面不会上传。';
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    video.setAttribute('aria-label', 'QR 扫描相机画面');
    video.style.width = '100%'; video.style.maxHeight = '50vh'; video.style.objectFit = 'cover'; video.style.borderRadius = '10px';
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    const scan = document.createElement('button'); scan.type = 'button'; scan.className = 'btn btn-primary btn-sm'; scan.textContent = '开启相机';
    const scanner = { session, root, video, detector, decoder: null, canvas: null, canvasContext: null,
      stream: null, frameId: null, timer: null, starting: false, lastDecodeAt: 0 };
    qrScanner = scanner;
    cancel.onclick = () => finishQrScanner(session, true);
    scan.onclick = async () => {
      if (qrScanner !== scanner || scanner.starting || scanner.stream) return;
      scanner.starting = true; scan.disabled = true; scan.textContent = '正在请求相机…';
      let cameraRequest;
      try { cameraRequest = navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
      catch (error) { cameraRequest = Promise.reject(error); }
      try {
        // Start getUserMedia during the user's click, before awaiting the lazy
        // decoder download, so browsers retain the camera permission gesture.
        const [stream, decoder] = await Promise.all([
          cameraRequest,
          scanner.detector ? Promise.resolve(null) : loadQrDecoder(),
        ]);
        if (qrScanner !== scanner || active !== session || !current(session.context)) {
          for (const track of stream.getTracks?.() || []) { try { track.stop(); } catch (_) {} }
          return;
        }
        scanner.stream = stream;
        scanner.decoder = decoder;
        if (!scanner.detector) {
          scanner.canvas = document.createElement('canvas');
          scanner.canvasContext = scanner.canvas.getContext?.('2d', { willReadFrequently: true });
          if (!scanner.canvasContext) throw new Error('Canvas QR decoding unavailable');
        }
        video.srcObject = stream;
        await video.play?.();
        if (qrScanner !== scanner || active !== session || !current(session.context)) return;
        message.textContent = '正在本机识别 QR 码；相机画面不会上传。检测到内容后会发送给当前 Mini App。';
        scan.textContent = '相机已开启';
        const detect = async () => {
          if (qrScanner !== scanner || active !== session || !current(session.context)) return;
          if (video.readyState >= 2) {
            try {
              let value;
              if (scanner.detector) {
                const codes = await scanner.detector.detect(video);
                if (qrScanner !== scanner) return;
                value = codes?.find(code => typeof code?.rawValue === 'string' && code.rawValue.length > 0)?.rawValue;
              } else if (Date.now() - scanner.lastDecodeAt >= 120) {
                scanner.lastDecodeAt = Date.now();
                const sourceWidth = video.videoWidth;
                const sourceHeight = video.videoHeight;
                if (sourceWidth > 0 && sourceHeight > 0) {
                  const scale = Math.min(1, 960 / Math.max(sourceWidth, sourceHeight));
                  const width = Math.max(1, Math.round(sourceWidth * scale));
                  const height = Math.max(1, Math.round(sourceHeight * scale));
                  scanner.canvas.width = width; scanner.canvas.height = height;
                  scanner.canvasContext.drawImage(video, 0, 0, width, height);
                  const pixels = scanner.canvasContext.getImageData(0, 0, width, height);
                  const code = scanner.decoder(pixels.data, width, height, { inversionAttempts: 'attemptBoth' });
                  if (qrScanner !== scanner) return;
                  value = code?.data;
                }
              }
              if (typeof value === 'string' && value.length <= 4096) { finishQrScanner(session, true, value); return; }
            } catch (_) {
              message.textContent = '读取相机画面失败。请关闭后重试。';
              finishQrScanner(session, true);
              return;
            }
          }
          if (qrScanner === scanner) {
            if (typeof window.requestAnimationFrame === 'function') scanner.frameId = window.requestAnimationFrame(() => { scanner.frameId = null; void detect(); });
            else scanner.timer = setTimeout(() => { scanner.timer = null; void detect(); }, 150);
          }
        };
        void detect();
      } catch (_) {
        const stream = scanner.stream || await cameraRequest.catch(() => null);
        for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch (_) {} }
        scanner.stream = null; video.srcObject = null;
        if (qrScanner !== scanner || active !== session) return;
        message.textContent = scanner.detector || scanner.decoder
          ? '无法访问相机。请检查浏览器权限后重试，或取消扫码。'
          : '无法准备本机 QR 解码器。请检查网络后重试，或取消扫码。';
        scan.disabled = false; scan.textContent = '重试开启相机';
      } finally { scanner.starting = false; }
    };
    actions.append(cancel, scan); dialog.append(title, message, video, actions); root.appendChild(dialog); overlay.appendChild(root);
  }

  async function requestFileDownload(session, data) {
    if (session.downloadPending) return;
    const fileName = typeof data?.file_name === 'string' ? data.file_name.trim() : '';
    const url = safeExternalUrl(data?.url);
    if (!fileName || fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(fileName) || !url) {
      post('file_download_requested', { status: 'cancelled' });
      return;
    }
    session.downloadPending = true;
    let allowed = false;
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/download-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
        cache: 'no-store', body: JSON.stringify({ fileName, url }),
      });
      if (active !== session || !current(session.context)) return;
      if (!response.ok) throw new Error('unavailable');
      allowed = (await response.json())?.allowed === true;
    } catch (_) {
      if (active !== session || !current(session.context)) return;
    }
    if (!allowed) {
      session.downloadPending = false;
      post('file_download_requested', { status: 'cancelled' });
      status.textContent = 'Telegram 未允许此文件下载。';
      return;
    }
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '下载文件？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = `此机器人请求下载“${fileName}”。`;
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    cancel.onclick = () => {
      if (active !== session) return;
      session.downloadPending = false; popupRoot?.remove(); popupRoot = null;
      post('file_download_requested', { status: 'cancelled' });
    };
    const download = document.createElement('a'); download.className = 'btn btn-primary btn-sm'; download.href = url;
    download.target = '_blank'; download.rel = 'noopener noreferrer'; download.download = fileName; download.textContent = '下载';
    download.onclick = () => {
      if (active !== session || !current(session.context)) return;
      session.downloadPending = false; popupRoot?.remove(); popupRoot = null;
      post('file_download_requested', { status: 'downloading' });
    };
    actions.append(cancel, download); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  async function requestInvoice(session, data) {
    if (session.invoicePending) return;
    const slug = typeof data?.slug === 'string' ? data.slug : '';
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(slug)) {
      post('invoice_closed', { slug, status: 'failed' });
      return;
    }
    session.invoicePending = true;
    let invoice;
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/invoice/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
        cache: 'no-store', body: JSON.stringify({ slug }),
      });
      if (!response.ok) throw new Error('unavailable');
      invoice = await response.json();
      if (typeof invoice?.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(invoice.token) ||
          typeof invoice.stars !== 'string' || !/^\d{1,13}$/.test(invoice.stars) ||
          typeof invoice.title !== 'string' || typeof invoice.description !== 'string') throw new Error('invalid invoice');
    } catch (_) {
      if (active !== session || !current(session.context)) return;
      session.invoicePending = false;
      status.textContent = '此发票暂不可付款，或不支持 Telegram Stars。';
      post('invoice_closed', { slug, status: 'failed' });
      return;
    }
    if (active !== session || !current(session.context)) {
      void fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/invoice/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
        cache: 'no-store', body: JSON.stringify({ token: invoice.token }),
      }).catch(() => {});
      return;
    }
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '确认 Stars 付款？';
    const details = document.createElement('div'); details.className = 'mini-app-popup-message';
    details.textContent = `${invoice.title}${invoice.description ? `\n${invoice.description}` : ''}\n\n金额：${invoice.stars} Stars`;
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    const finish = (paymentStatus, message) => {
      if (active !== session) return;
      session.invoicePending = false; popupRoot?.remove(); popupRoot = null;
      if (message) status.textContent = message;
      post('invoice_closed', { slug, status: paymentStatus });
    };
    cancel.onclick = () => {
      if (active !== session) return;
      void fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/invoice/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
        cache: 'no-store', body: JSON.stringify({ token: invoice.token }),
      }).catch(() => {});
      finish('cancelled', '已取消 Stars 付款。');
    };
    const pay = document.createElement('button'); pay.type = 'button'; pay.className = 'btn btn-primary btn-sm'; pay.textContent = `支付 ${invoice.stars} Stars`;
    pay.onclick = async () => {
      if (active !== session || !current(session.context)) return;
      pay.disabled = true; cancel.disabled = true;
      try {
        const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/invoice/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
          cache: 'no-store', body: JSON.stringify({ token: invoice.token }),
        });
        if (!response.ok) throw new Error('unavailable');
        const result = await response.json();
        if (active !== session || !current(session.context)) return;
        const paid = result?.status === 'paid';
        finish(paid ? 'paid' : 'failed', paid ? 'Stars 付款已完成。' : 'Telegram 未确认付款；请检查 Stars 余额或付款状态。');
      } catch (_) {
        if (active === session && current(session.context)) finish('failed', '未能确认 Stars 付款状态。');
      }
    };
    actions.append(cancel, pay); dialog.append(title, details, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  function requestSendData(session, data) {
    if (!session.simpleWebView || session.sendDataPending) return;
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > 4096) {
      status.textContent = '发送数据无效或超过 4096 字节限制。';
      return;
    }
    session.sendDataPending = true;
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '向机器人发送数据？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message mini-app-send-data-preview';
    message.textContent = `“${session.buttonText || 'Mini App'}”将发送以下数据：\n\n${data}`;
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    cancel.onclick = () => {
      if (active !== session) return;
      session.sendDataPending = false; popupRoot?.remove(); popupRoot = null;
      status.textContent = '未发送 Mini App 数据。';
    };
    const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-primary btn-sm'; send.textContent = '发送数据';
    send.onclick = async () => {
      if (active !== session || !current(session.context)) return;
      send.disabled = true;
      try {
        const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/send-data`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-App-Key': session.key },
          cache: 'no-store', body: JSON.stringify({ data }),
        });
        if (!response.ok || active !== session || !current(session.context)) throw new Error('unavailable');
        popupRoot?.remove(); popupRoot = null; session.sendDataPending = false;
        close();
        showToast('Mini App 数据已发送给机器人', 'success');
      } catch (_) {
        if (active !== session || !current(session.context)) return;
        session.sendDataPending = false; popupRoot?.remove(); popupRoot = null;
        status.textContent = '未能发送 Mini App 数据。';
      }
    };
    actions.append(cancel, send); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  function locationPermissionKey(session, kind) {
    if (!session || !/^\d+$/.test(session.accountId || '') || !/^\d+$/.test(session.botId || '') ||
        !['requested', 'granted'].includes(kind)) return null;
    return `tg-miniapp-location:v1:${encodeURIComponent(session.context.instId)}:${session.accountId}:${session.botId}:${kind}`;
  }
  function hasLocationPermission(session, kind) {
    const key = locationPermissionKey(session, kind);
    if (!key || typeof localStorage === 'undefined') return false;
    try { return localStorage.getItem(key) === '1'; } catch (_) { return false; }
  }
  function saveLocationPermission(session, kind) {
    const key = locationPermissionKey(session, kind);
    if (!key || typeof localStorage === 'undefined') return false;
    try { localStorage.setItem(key, '1'); return true; } catch (_) { return false; }
  }
  function openLocationSettings(session) {
    if (active !== session || !current(session.context) || session.locationSettingsPending) return;
    session.locationSettingsPending = true;
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '位置权限设置';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message';
    const persistent = hasLocationPermission(session, 'granted');
    message.textContent = `${persistent ? '此 Mini App 已获持续定位授权。' : '此 Mini App 当前没有持续定位授权。'}浏览器定位权限仍由浏览器管理，请在地址栏的站点设置中查看。`;
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const finish = () => {
      if (active !== session || !current(session.context)) return;
      session.locationSettingsPending = false;
      popupRoot?.remove(); popupRoot = null;
      post('location_settings_opened', {});
    };
    if (persistent) {
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-danger btn-sm'; revoke.textContent = '撤销持续授权';
      revoke.onclick = () => {
        const key = locationPermissionKey(session, 'granted');
        try { if (key && typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch (_) {}
        finish();
      };
      actions.appendChild(revoke);
    }
    const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'btn btn-secondary btn-sm'; closeButton.textContent = '完成';
    closeButton.onclick = finish;
    actions.appendChild(closeButton); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }
  async function checkLocation(session) {
    if (typeof navigator.geolocation?.getCurrentPosition !== 'function') {
      post('location_checked', { available: false });
      return;
    }
    let browserPermission;
    try {
      const permission = await navigator.permissions?.query?.({ name: 'geolocation' });
      if (active !== session || !current(session.context)) return;
      browserPermission = permission?.state;
    } catch (_) { /* The geolocation request can still ask the browser directly. */ }
    if (active === session && current(session.context)) {
      const accessRequested = hasLocationPermission(session, 'requested');
      const accessGranted = hasLocationPermission(session, 'granted') && browserPermission !== 'denied';
      post('location_checked', { available: browserPermission === 'denied' ? false : true,
        access_requested: accessRequested, access_granted: accessGranted });
    }
  }

  function requestLocation(session) {
    if (session.locationPending) return;
    session.locationPending = true;
    const finish = data => {
      if (active !== session || !current(session.context)) return;
      session.locationPending = false;
      if (popupRoot) { popupRoot.remove(); popupRoot = null; }
      post('location_requested', data);
    };
    const acquire = remember => {
      if (active !== session || !current(session.context)) return;
      try {
        navigator.geolocation.getCurrentPosition(position => {
          const coords = position?.coords;
          const latitude = Number(coords?.latitude), longitude = Number(coords?.longitude);
          if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            finish({ available: false }); return;
          }
          if (remember) saveLocationPermission(session, 'granted');
          finish({ available: true, latitude, longitude,
            altitude: Number(coords.altitude) || 0, course: Number(coords.heading) || 0, speed: Number(coords.speed) || 0,
            horizontal_accuracy: Number(coords.accuracy) || 0, vertical_accuracy: Number(coords.altitudeAccuracy) || 0,
            course_accuracy: 0, speed_accuracy: 0 });
        }, () => finish({ available: false }), { maximumAge: 30000, timeout: 15000, enableHighAccuracy: false });
      } catch (_) { finish({ available: false }); }
    };
    if (typeof navigator.geolocation?.getCurrentPosition !== 'function') {
      finish({ available: false });
      return;
    }
    if (hasLocationPermission(session, 'granted')) {
      acquire(true);
      return;
    }
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '与此机器人分享位置？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = '位置只发送给当前 Mini App。浏览器还会单独询问定位权限。';
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    cancel.onclick = () => finish({ available: false });
    const allowOnce = document.createElement('button'); allowOnce.type = 'button'; allowOnce.className = 'btn btn-secondary btn-sm'; allowOnce.textContent = '只允许一次';
    const alwaysAllow = document.createElement('button'); alwaysAllow.type = 'button'; alwaysAllow.className = 'btn btn-primary btn-sm'; alwaysAllow.textContent = '始终允许';
    const allow = remember => {
      if (active !== session || !current(session.context)) return;
      saveLocationPermission(session, 'requested');
      allowOnce.disabled = true; alwaysAllow.disabled = true;
      status.textContent = '正在等待浏览器定位权限…';
      acquire(remember);
    };
    allowOnce.onclick = () => allow(false);
    alwaysAllow.onclick = () => allow(true);
    actions.append(cancel, allowOnce, alwaysAllow); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  function requestPhone(session) {
    if (session.phoneRequestPending) return;
    session.phoneRequestPending = true;
    if (popupRoot) popupRoot.remove();
    popupRoot = document.createElement('div'); popupRoot.className = 'mini-app-popup-scrim';
    const dialog = document.createElement('div'); dialog.className = 'mini-app-popup';
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('strong'); title.className = 'mini-app-popup-title'; title.textContent = '向机器人分享电话号码？';
    const message = document.createElement('div'); message.className = 'mini-app-popup-message'; message.textContent = '确认后，你的电话号码会作为联系人消息发送给此机器人；号码不会回传给网页。';
    const actions = document.createElement('div'); actions.className = 'mini-app-popup-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    cancel.onclick = () => {
      if (active !== session) return;
      session.phoneRequestPending = false; popupRoot?.remove(); popupRoot = null;
      post('phone_requested', { status: 'cancelled' });
    };
    const share = document.createElement('button'); share.type = 'button'; share.className = 'btn btn-primary btn-sm'; share.textContent = '分享电话号码';
    share.onclick = async () => {
      if (active !== session || !current(session.context)) return;
      share.disabled = true;
      try {
        const response = await fetch(`/api/instances/${encodeURIComponent(session.context.instId)}/account/mini-app/phone`, {
          method: 'POST', headers: { 'X-Mini-App-Key': session.key }, cache: 'no-store',
        });
        if (!response.ok || active !== session || !current(session.context)) throw new Error('unavailable');
        session.phoneRequestPending = false; popupRoot?.remove(); popupRoot = null;
        status.textContent = '电话号码已作为联系人发送给机器人。';
        post('phone_requested', { status: 'sent' });
      } catch (_) {
        if (active !== session || !current(session.context)) return;
        session.phoneRequestPending = false; popupRoot?.remove(); popupRoot = null;
        status.textContent = '未能向机器人分享电话号码。';
        post('phone_requested', { status: 'cancelled' });
      }
    };
    actions.append(cancel, share); dialog.append(title, message, actions); popupRoot.appendChild(dialog); overlay.appendChild(popupRoot);
  }

  function onMessage(event) {
    const session = active;
    // With allow-same-origin absent, sandboxed frames have an opaque origin.
    if (!session || !frame || event.source !== frame.contentWindow || event.origin !== 'null' || !current(session.context)) return;
    let payload = event.data;
    if (typeof payload === 'string') {
      if (payload.length > 8192) return;
      try { payload = JSON.parse(payload); } catch { return; }
    } else return; // Telegram Web App protocol uses JSON strings.
    if (!payload || typeof payload !== 'object') return;
    const now = Date.now();
    if (now - session.windowStart >= 1000) { session.windowStart = now; session.count = 0; }
    if (++session.count > 30) return;
    const type = payload.eventType;
    if (qrScanner?.session === session && ['web_app_open_popup', 'web_app_request_write_access', 'web_app_request_location',
      'web_app_request_phone', 'web_app_data_send', 'web_app_read_text_from_clipboard', 'web_app_request_file_download', 'web_app_open_invoice'].includes(type)) {
      finishQrScanner(session, true);
    }
    if (type === 'web_app_ready') status.textContent = '受限模式：部分功能可能不可用。';
    else if (type === 'web_app_request_theme') sendTheme();
    else if (type === 'web_app_request_viewport') sendViewport();
    else if (type === 'web_app_expand') sendViewport();
    else if (type === 'web_app_setup_back_button') backButton.hidden = payload.eventData?.is_visible !== true;
    else if (type === 'web_app_setup_main_button') {
      const data = payload.eventData && typeof payload.eventData === 'object' ? payload.eventData : {};
      updateButton(mainButton, data, '继续');
      buttonRow.hidden = mainButton.hidden && secondaryButton.hidden;
    }
    else if (type === 'web_app_setup_secondary_button') {
      const data = payload.eventData && typeof payload.eventData === 'object' ? payload.eventData : {};
      updateButton(secondaryButton, data, '继续');
      const position = ['left', 'right', 'top', 'bottom'].includes(data.position) ? data.position : 'left';
      buttonRow.className = `mini-app-button-row secondary-${position}`;
      buttonRow.hidden = mainButton.hidden && secondaryButton.hidden;
    }
    else if (type === 'web_app_setup_settings_button') settingsButton.hidden = payload.eventData?.is_visible !== true;
    else if (type === 'web_app_setup_closing_behavior') active.needCloseConfirmation = payload.eventData?.need_confirmation === true;
    else if (type === 'web_app_start_accelerometer') startAccelerometer(payload.eventData);
    else if (type === 'web_app_stop_accelerometer') stopAccelerometer();
    else if (type === 'web_app_start_gyroscope') startGyroscope(payload.eventData);
    else if (type === 'web_app_stop_gyroscope') stopGyroscope();
    else if (type === 'web_app_start_device_orientation') startOrientation(payload.eventData);
    else if (type === 'web_app_stop_device_orientation') stopOrientation();
    else if (type === 'web_app_request_fullscreen') void requestFullscreen(session);
    else if (type === 'web_app_exit_fullscreen') exitFullscreen();
    else if (type === 'web_app_request_write_access') void requestWriteAccess(session);
    else if (type === 'web_app_check_location') void checkLocation(session);
    else if (type === 'web_app_request_location') requestLocation(session);
    else if (type === 'web_app_open_location_settings') openLocationSettings(session);
    else if (type === 'web_app_request_phone') requestPhone(session);
    else if (type === 'web_app_request_file_download') void requestFileDownload(session, payload.eventData);
    else if (type === 'web_app_open_invoice') void requestInvoice(session, payload.eventData);
    else if (type === 'web_app_data_send') requestSendData(session, payload.eventData?.data);
    else if (type === 'web_app_read_text_from_clipboard') requestClipboardRead(session, payload.eventData);
    else if (type === 'web_app_set_background_color') {
      const color = payload.eventData?.color;
      if (/^#[\da-f]{6}$/i.test(color || '')) overlay.querySelector('.mini-app-window').style.backgroundColor = color;
    }
    else if (type === 'web_app_set_bottom_bar_color') {
      const color = payload.eventData?.color;
      if (/^#[\da-f]{6}$/i.test(color || '')) buttonRow.style.backgroundColor = color;
    }
    else if (type === 'web_app_set_header_color') {
      const data = payload.eventData || {};
      const color = /^#[\da-f]{6}$/i.test(data.color || '') ? data.color :
        data.color_key === 'secondary_bg_color' ? getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim() :
        data.color_key === 'bg_color' ? getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() : '';
      if (color) overlay.querySelector('.mini-app-header').style.backgroundColor = color;
    }
    else if (type === 'web_app_open_popup') showPopup(payload.eventData);
    else if (type === 'web_app_open_scan_qr_popup') openScanQrPopup(session);
    else if (type === 'web_app_close_scan_qr_popup') finishQrScanner(session, false);
    else if (type === 'web_app_close') close();
    else if (type === 'web_app_trigger_haptic_feedback') triggerHaptic(payload.eventData);
    else if (type === 'web_app_invoke_custom_method') void invokeCustomMethod(session, payload.eventData);
    else if (['web_app_device_storage_get_key', 'web_app_device_storage_save_key', 'web_app_device_storage_get_keys',
      'web_app_device_storage_remove_key', 'web_app_device_storage_clear'].includes(type)) handleDeviceStorage(session, type, payload.eventData);
    else if (type === 'web_app_open_link') {
      displayExternalLink(safeExternalUrl(payload.eventData?.url), '点击打开 Mini App 请求的外部链接');
    } else if (type === 'web_app_open_tg_link') {
      displayExternalLink(safeTelegramUrl(payload.eventData?.path_full), '点击打开 Telegram 链接');
    } else if (typeof type === 'string' && type.startsWith('web_app_')) {
      if (!dispatchUnsupported(type, payload.eventData)) status.textContent = '此 Mini App 请求的功能暂不支持。';
    }
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', sendViewport);
  window.visualViewport?.addEventListener('resize', sendViewport);
  document.addEventListener?.('fullscreenchange', handleFullscreenChange);
  document.addEventListener?.('visibilitychange', handleVisibilityChange);
  return { open, openBotMenu, close };
})();

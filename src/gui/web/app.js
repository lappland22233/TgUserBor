/**
 * TGuserBOT Management Console (Professional Minimalist UI, Zero Emojis)
 */

'use strict';

const state = {
  instances: [],
  plugins: [],
  logs: [],
  currentAuthInstanceId: null,
  currentAuthStep: null,
  selectedInstanceForPlugins: null,
  selectedConfigPlugin: null,
  clientSelectedInstance: null,
  clientActiveChatId: null,
  clientActiveDialog: null,
  clientDialogs: [],
  clientMessages: [],
  clientMessageEffectId: null,
  clientTranslationEnabled: null,
  clientTelegramChatTheme: null,
  clientTelegramChatWallpaper: null,
  clientSavedReactionFilter: null,
  clientHistoryOffsetDate: null,
  clientDialogFilter: 'all',
  clientReplyingTo: null,
  clientSearchQuery: '',
  clientSearchFilter: '',
  profilePhotos: [],
  currentPhotoIndex: 0,
  currentProfileChatId: null,
  currentProfileIsSelf: false,
  sharedMediaTab: 'photos',
  sharedMediaList: [],
  playlist: [],
  currentTrackIndex: -1,
  isPlaying: false,
  schedulerSelectedInstance: null,
  schedulerTasks: [],
  clientDrafts: {},
  clientDraftsByAccount: {},
  chatSendKeyMode: localStorage.getItem('tgbot_chat_send_mode') || 'enter',
  clientSilent: localStorage.getItem('tgbot_chat_silent') === 'true',
  clientParseMode: localStorage.getItem('tgbot_chat_parse_mode') || 'markdown',
  clientTranslationLanguage: localStorage.getItem('tgbot_translation_language') || 'zh-hans',
  clientStagedFile: null,
  clientStagedFiles: [],
  clientVideoNote: false,
  clientCaptionAboveMedia: false,
  clientPaidMediaStars: null,
  selectedMsgIds: new Set(),
  isSelectionMode: false,
  pendingForwardMsgIds: [],
  voiceRecorder: null,
  voiceAudioChunks: [],
  voiceRecInterval: null,
  voiceRecSeconds: 0,
  lightboxImages: [],
  lightboxCurrentIdx: -1,
  searchMatchIds: [],
  searchMatchIdx: -1,
  typingTimer: null,
};

// DOM References
const el = {
  navItems: document.querySelectorAll('.nav-item'),
  views: document.querySelectorAll('.view-section'),
  currentTitle: document.getElementById('current-view-title'),

  // Dashboard
  dashInstRatio: document.getElementById('dash-inst-ratio'),
  dashInstSub: document.getElementById('dash-inst-sub'),
  dashMemPercent: document.getElementById('dash-mem-percent'),
  dashMemSub: document.getElementById('dash-mem-sub'),
  dashPluginsCount: document.getElementById('dash-plugins-count'),
  dashSysUptime: document.getElementById('dash-sys-uptime'),
  dashSysArch: document.getElementById('dash-sys-arch'),
  dashInstGrid: document.getElementById('dashboard-instances-grid'),

  // Instances
  instFullGrid: document.getElementById('instances-full-grid'),

  // Plugins
  pluginInstSelect: document.getElementById('plugin-instance-select'),
  pluginSearchInput: document.getElementById('plugin-search-input'),
  pluginsGrid: document.getElementById('plugins-grid'),

  // Logs
  logFilterInst: document.getElementById('log-filter-instance'),
  logFilterLevel: document.getElementById('log-filter-level'),
  logSearchInput: document.getElementById('log-search-input'),
  logAutoScroll: document.getElementById('log-auto-scroll'),
  btnClearLogs: document.getElementById('btn-clear-logs'),
  terminalContainer: document.getElementById('terminal-log-container'),

  // Buttons
  btnStartAll: document.getElementById('btn-start-all'),
  btnStopAll: document.getElementById('btn-stop-all'),
  btnOpenCreateInst: document.getElementById('btn-open-create-inst'),
  btnOpenCreatePlugin: document.getElementById('btn-open-create-plugin'),

  // Modals
  modalAuth: document.getElementById('modal-auth'),
  modalInst: document.getElementById('modal-instance'),
  modalCreatePlugin: document.getElementById('modal-create-plugin'),
  modalPluginConfig: document.getElementById('modal-plugin-config'),
  toastContainer: document.getElementById('toast-container'),
};

// Utilities
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const iconId = type === 'success' ? '#icon-check' : type === 'error' ? '#icon-alert' : '#icon-info';
  t.innerHTML = `<svg class="ui-icon toast-icon"><use href="${iconId}"/></svg><span>${escapeHtml(msg)}</span>`;
  el.toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, 4000);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '0分';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}天 ${h % 24}时`;
  if (h > 0) return `${h}时 ${m % 60}分`;
  return `${m}分`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours}小时 ${remainingMins}分钟` : `${hours}小时`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}天 ${remHours}小时` : `${days}天`;
}

function formatDurationSec(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

// Dynamic Network Connection Scheduler & Concurrency Pool
class NetworkScheduler {
  constructor(maxConcurrent = 3, maxImages = maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.maxImages = maxImages;
    this.running = 0;
    this.runningImages = 0;
    this.queue = [];
    this.imageRequests = new WeakMap();
    this.imageObjectUrls = new WeakMap();
    this.visibleRequests = new WeakMap();
  }

  enqueue(fn, priority = 1, isImage = false) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, priority, isImage });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.dequeue();
    });
  }

  dequeue() {
    while (this.running < this.maxConcurrent) {
      const index = this.queue.findIndex(item => !item.isImage || this.runningImages < this.maxImages);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
      this.running++;
      if (item.isImage) this.runningImages++;
      let result;
      try { result = item.fn(); } catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(item.resolve, item.reject).finally(() => {
        this.running--;
        if (item.isImage) this.runningImages--;
        this.dequeue();
      });
    }
  }

  loadImage(imgEl, src, fallbackSrc = '') {
    const request = { controller: new AbortController() };
    if (imgEl) {
      this.imageRequests.get(imgEl)?.controller.abort();
      this.imageRequests.set(imgEl, request);
    }
    const current = () => !request.controller.signal.aborted &&
      (!imgEl || this.imageRequests.get(imgEl) === request);
    const fail = () => {
      if (current() && imgEl && fallbackSrc) {
        imgEl.src = fallbackSrc;
        const previous = this.imageObjectUrls.get(imgEl);
        if (previous) URL.revokeObjectURL(previous);
        this.imageObjectUrls.delete(imgEl);
      }
      return false;
    };
    return this.enqueue(async () => {
      let objectUrl = '';
      let transferred = false;
      try {
        if (!current()) return false;
        // Media responses are deliberately no-store. Fetch once and decode the
        // resulting blob so assigning the image never downloads it a second time.
        const response = await fetch(src, { signal: request.controller.signal });
        if (!response.ok) return fail();
        const blob = await response.blob();
        if (!current()) return false;
        objectUrl = URL.createObjectURL(blob);
        const loaded = await new Promise(resolve => {
          const img = new Image();
          const done = ok => {
            img.onload = null;
            img.onerror = null;
            request.controller.signal.removeEventListener('abort', aborted);
            resolve(ok);
          };
          const aborted = () => { img.src = ''; done(false); };
          img.onload = () => done(true);
          img.onerror = () => done(false);
          request.controller.signal.addEventListener('abort', aborted, { once: true });
          if (!current()) return aborted();
          img.src = objectUrl;
        });
        if (!loaded) return fail();
        if (!current()) return false;
        if (imgEl) {
          const previous = this.imageObjectUrls.get(imgEl);
          imgEl.src = objectUrl;
          this.imageObjectUrls.set(imgEl, objectUrl);
          transferred = true;
          if (previous) URL.revokeObjectURL(previous);
        }
        return true;
      } catch (_) {
        return fail();
      } finally {
        if (objectUrl && !transferred) URL.revokeObjectURL(objectUrl);
        if (imgEl && this.imageRequests.get(imgEl) === request) this.imageRequests.delete(imgEl);
      }
    }, 2, true);
  }

  loadVisibleImage(img, src, shouldStart = () => true, onSkip = () => {}) {
    return this.enqueue(() => new Promise((resolve) => {
      if (!img.isConnected) return resolve(false);
      if (!shouldStart()) { onSkip(); return resolve(false); }
      const done = (success) => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        this.visibleRequests.delete(img);
        resolve(success);
      };
      const onLoad = () => done(true);
      const onError = () => done(false);
      this.visibleRequests.set(img, () => { img.removeAttribute('src'); done(false); });
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      // Visibility was already checked before entering the queue. Native lazy
      // loading can otherwise stall this slot if the image scrolls away.
      img.loading = 'eager';
      img.src = src;
    }), 2, true);
  }

  loadVisiblePoster(video, src) {
    return this.enqueue(async () => {
      if (!video.isConnected) return;
      const controller = new AbortController();
      let objectUrl = '';
      this.visibleRequests.set(video, () => {
        controller.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        this.visibleRequests.delete(video);
      });
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!video.isConnected || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        video.poster = objectUrl;
      } catch (_) {
        // A removed card or failed thumbnail must not block the image queue.
      } finally {
        if (!objectUrl) this.visibleRequests.delete(video);
      }
    }, 2, true);
  }

  cancelVisibleImage(img) {
    this.visibleRequests.get(img)?.();
  }

  cancelImage(imgEl) {
    if (!imgEl) return;
    this.imageRequests.get(imgEl)?.controller.abort();
    this.imageRequests.delete(imgEl);
    const objectUrl = this.imageObjectUrls.get(imgEl);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    this.imageObjectUrls.delete(imgEl);
  }
}

// Two image requests can progress together while the third slot remains available
// for interactive API work under the browser's small per-origin connection pool.
const scheduler = new NetworkScheduler(3, 2);

function initManagedImages() {
  const selector = 'img[data-network-src], video[data-network-poster]';
  const stickerVisibility = new WeakMap();
  const pendingStickers = new WeakSet();
  const load = img => {
    const src = img.dataset.networkSrc || img.dataset.networkPoster;
    if (!src) return;
    if (img.dataset.networkPoster) {
      delete img.dataset.networkPoster;
      void scheduler.loadVisiblePoster(img, src);
    } else {
      delete img.dataset.networkSrc;
      if (intersection && img.dataset.networkSticker === '1') {
        pendingStickers.add(img);
        void scheduler.loadVisibleImage(img, src,
          () => stickerVisibility.get(img) === true && img.getClientRects().length > 0,
          () => { img.dataset.networkSrc = src; }
        ).finally(() => {
          pendingStickers.delete(img);
          if (!img.dataset.networkSrc) intersection.unobserve(img);
        });
      } else {
        void scheduler.loadVisibleImage(img, src);
      }
    }
  };
  const intersection = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          const img = entry.target;
          if (img.dataset.networkSticker === '1') {
            stickerVisibility.set(img, entry.isIntersecting);
            if (entry.isIntersecting && !pendingStickers.has(img)) load(img);
          } else if (entry.isIntersecting) {
            intersection.unobserve(img);
            load(img);
          }
        }
      }, { rootMargin: '100px' })
    : null;
  const visit = (node, callback) => {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) callback(node);
    node.querySelectorAll(selector).forEach(callback);
  };
  const observe = img => intersection ? intersection.observe(img) : load(img);
  visit(document.body, observe);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) visit(node, observe);
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue;
        // Loaded images no longer have data-network-src, so include all images
        // when cancelling a list that was removed while loading.
        const images = node.matches('img, video') ? [node] : [];
        images.push(...node.querySelectorAll('img, video'));
        for (const img of images) {
          if (intersection) intersection.unobserve(img);
          scheduler.cancelVisibleImage(img);
          scheduler.cancelImage(img);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}


// Autoplay media can otherwise start dozens of parallel range requests as the
// message list is built. Play one visible item at a time; a tap selects another.
function initManagedAutoplay() {
  const selector = 'video[data-network-autoplay]';
  const visible = new Set();
  let active = null;
  const stop = video => {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  const activate = video => {
    if (active === video || !video?.isConnected) return;
    stop(active);
    active = video;
    video.src = video.dataset.networkAutoplay;
    video.play().catch(() => {});
  };
  const next = () => {
    if (active) return;
    for (const video of visible) {
      if (video.isConnected) { activate(video); return; }
    }
  };
  const intersection = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else {
            visible.delete(entry.target);
            if (active === entry.target) { stop(active); active = null; }
          }
        }
        next();
      })
    : null;
  const visit = (node, callback) => {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) callback(node);
    node.querySelectorAll(selector).forEach(callback);
  };
  const observe = video => {
    video.addEventListener('pointerdown', () => { if (visible.has(video)) activate(video); });
    if (intersection) intersection.observe(video);
    else { visible.add(video); next(); }
  };
  visit(document.body, observe);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) visit(node, observe);
      for (const node of record.removedNodes) {
        if (node.isConnected) continue;
        visit(node, video => {
          if (intersection) intersection.unobserve(video);
          visible.delete(video);
          if (active === video) { stop(active); active = null; }
        });
      }
    }
    next();
  }).observe(document.body, { childList: true, subtree: true });
}

// Telegram / Twemoji Vector SVG Emojis (No System Fonts)
function getEmojiHex(emoji) {
  const cleaned = emoji.replace(/[\ufe0e\ufe0f]/g, '');
  const codes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.codePointAt(i);
    codes.push(code.toString(16));
    if (code > 0xffff) i++;
  }
  return codes.join('-');
}

function getEmojiSvgUrl(emoji) {
  const hex = getEmojiHex(emoji);
  return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/${hex}.svg`;
}

// API Helper (Prioritized via NetworkScheduler)
async function api(path, method = 'GET', data = null, priority = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (data) opts.body = JSON.stringify(data);
  const prio = priority !== null ? priority : (method === 'GET' ? 1 : 0);
  return scheduler.enqueue(async () => {
    const res = await fetch(path, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '网络请求异常' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, prio);
}

// SSE Connection
function initSSE() {
  const sse = new EventSource('/api/events');
  const indicator = document.getElementById('sse-indicator');
  const sseText = document.getElementById('sse-text');

  sse.onopen = () => {
    indicator.style.background = 'var(--color-success)';
    sseText.innerText = '实时连接正常';
  };

  sse.onerror = () => {
    indicator.style.background = 'var(--color-danger)';
    sseText.innerText = '连接中断重试中...';
  };

  const handleStatusChange = (data) => {
    if (data && data.instanceId) {
      updateInstanceStatus(data.instanceId, data.status);
    }
  };
  sse.addEventListener('status', (e) => handleStatusChange(JSON.parse(e.data)));
  sse.addEventListener('status_change', (e) => handleStatusChange(JSON.parse(e.data)));

  sse.addEventListener('metrics', (e) => {
    const data = JSON.parse(e.data);
    updateInstanceCardMetrics(data.instanceId, data.metrics);
  });

  const handleAuthPrompt = (data) => {
    if (data && data.instanceId) {
      openAuthModal(data.instanceId, data.step || 'phone');
    }
  };
  sse.addEventListener('auth_prompt', (e) => handleAuthPrompt(JSON.parse(e.data)));
  sse.addEventListener('auth_required', (e) => handleAuthPrompt(JSON.parse(e.data)));

  sse.addEventListener('auth_success', (e) => {
    const data = JSON.parse(e.data);
    if (state.currentAuthInstanceId === data.instanceId) closeAuthModal(true);
    showToast(`实例 "${data.instanceId}" 认证登录成功`, 'success');
    loadInstances();
  });

  sse.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    appendLog(entry);
  });
}

// Navigation View Switcher
function switchView(viewName) {
  if (viewName !== 'client') {
    window.MiniApp?.close();
    closeStoryViewer();
    window.ChatComments?.close();
    window.PinnedMessages?.close();
    window.ForumTopics?.close();
    if (typeof stopVoiceRecording === 'function') void stopVoiceRecording(false);
    if (typeof stopVideoNoteRecording === 'function') void stopVideoNoteRecording(false);
  }
  // 1. Reset views container scroll to top immediately (prevents scheduler view from opening at bottom)
  const viewsContainer = document.querySelector('.views-container');
  if (viewsContainer) viewsContainer.scrollTop = 0;
  window.scrollTo(0, 0);
  document.querySelector('.app-container')?.classList.toggle('telegram-client-mode', viewName === 'client');

  // 2. Dual WebSocket lifecycle: only active in client (chat) view
  if (viewName === 'client') {
    if (window.chatWs) window.chatWs.connect();
  } else {
    if (window.chatWs) window.chatWs.disconnect();
  }

  el.navItems.forEach((n) => {
    n.classList.toggle('active', n.dataset.view === viewName);
  });
  el.views.forEach((v) => {
    const isActive = v.id === `view-${viewName}`;
    v.classList.toggle('active', isActive);
    if (isActive) v.scrollTop = 0;
  });

  const titles = {
    dashboard: '系统总览大盘',
    instances: '多实例托管与控制',
    client: '客户端操作与仿真控制',
    scheduler: '定时与自动重复广播管理',
    plugins: '全局插件中心',
    logs: '实时控制台日志',
    settings: '系统设置',
  };
  el.currentTitle.innerText = titles[viewName] || '控制台';

  if (viewName === 'instances') renderInstances();
  if (viewName === 'client') initClientView();
  if (viewName === 'scheduler') {
    const vSched = document.getElementById('view-scheduler');
    if (vSched) vSched.scrollTop = 0;
    const tableWrap = document.querySelector('#view-scheduler .data-table-wrapper');
    if (tableWrap) tableWrap.scrollTop = 0;
    initSchedulerView();
  }
  if (viewName === 'plugins') renderPlugins();
  if (viewName === 'logs') loadHistoryLogs(el.logFilterInst?.value || 'all');
}

// Global System Status
async function loadStatus() {
  try {
    const data = await api('/api/status');
    const sys = data.system;
    const inst = data.instances;

    el.dashInstRatio.innerText = `${inst.online} / ${inst.total}`;
    el.dashInstSub.innerText = `${inst.total} 个实例已托管`;

    el.dashMemPercent.innerText = `${sys.memory.percent}%`;
    el.dashMemSub.innerText = `${formatBytes(sys.memory.used)} / ${formatBytes(sys.memory.total)}`;

    el.dashSysUptime.innerText = formatUptime(sys.uptime);
    el.dashSysArch.innerText = `${sys.platform} (${sys.arch}) · ${sys.cpuCores}核`;
  } catch (err) {
    /* swallow polling errors */
  }
}

// Instances
async function loadInstances() {
  try {
    state.instances = await api('/api/instances');
    renderInstances();
    updateInstanceDropdowns();

    // 🌟 状态自愈: 任何时候发现有实例正处于待认证步骤，且当前弹窗未打开，立即自动唤起输入弹窗！
    for (const inst of state.instances) {
      const step = inst.pendingAuthStep || (inst.status === 'NEEDS_CODE' ? 'code' : inst.status === 'NEEDS_PASSWORD' ? 'password' : inst.status === 'NEEDS_PHONE' ? 'phone' : null);
      if (step) {
        if (!el.modalAuth.classList.contains('active')) {
          openAuthModal(inst.config.id, step);
        }
        break;
      }
    }
  } catch (err) {
    showToast(`加载实例数据失败: ${err.message}`, 'error');
  }
}

// Plugins
async function loadPlugins() {
  try {
    state.plugins = await api('/api/plugins');
    el.dashPluginsCount.innerText = String(state.plugins.length);
    renderPlugins();
  } catch (err) {
    showToast(`加载插件列表失败: ${err.message}`, 'error');
  }
}

// Rendering Instances Cards
function renderInstances() {
  const html = state.instances.map(createInstanceCardHtml).join('');
  el.dashInstGrid.innerHTML = html || '<div class="empty-hint" style="color:var(--text-muted); font-size:13px;">暂无托管实例，请点击上方“新建实例”创建</div>';
  el.instFullGrid.innerHTML = html || '<div class="empty-hint" style="color:var(--text-muted); font-size:13px;">暂无托管实例，请点击上方“新建实例”创建</div>';
  bindCardActionButtons();
}

function createInstanceCardHtml(inst) {
  const cfg = inst.config;
  const isOnline = inst.status === 'ONLINE';
  const isNeedsAuth = ['NEEDS_PHONE', 'NEEDS_QR', 'NEEDS_CODE', 'NEEDS_PASSWORD', 'AUTH_REQUIRED'].includes(inst.status);
  const isStarting = inst.status === 'STARTING';

  let statusClass = 'stopped';
  let statusText = '已停止';
  let authStep = 'phone';

  if (isOnline) {
    statusClass = 'online';
    statusText = '运行中';
  } else if (isNeedsAuth) {
    statusClass = 'auth_required';
    if (inst.status === 'NEEDS_QR') {
      statusText = '等待扫码';
      authStep = 'qr';
    } else if (inst.status === 'NEEDS_CODE') {
      statusText = '待输入验证码';
      authStep = 'code';
    } else if (inst.status === 'NEEDS_PASSWORD') {
      statusText = '待输入2FA密码';
      authStep = 'password';
    } else {
      statusText = '待输入手机号';
      authStep = 'phone';
    }
  } else if (isStarting) {
    statusClass = 'starting';
    statusText = '启动中';
  } else if (inst.status === 'ERROR') {
    statusClass = 'stopped';
    statusText = '启动异常';
  }

  const userDisplay = inst.self?.username ? `@${inst.self.username}` : inst.self?.id ? `ID: ${inst.self.id}` : '未连接';

  return `
    <div class="instance-card" id="card-${escapeHtml(cfg.id)}">
      <div class="inst-card-top">
        <div class="inst-card-info">
          <h4>${escapeHtml(cfg.name)}</h4>
          <span class="inst-card-id">${escapeHtml(cfg.id)} · ${escapeHtml(userDisplay)}</span>
        </div>
        <span class="status-pill ${statusClass}" id="inst-status-badge-${escapeHtml(cfg.id)}">
          <span class="pill-dot"></span>
          <span>${statusText}</span>
        </span>
      </div>

      <table class="inst-details-table">
        <tbody>
          <tr>
            <td class="key">内存 / 运行</td>
            <td class="val" id="inst-mem-${escapeHtml(cfg.id)}">${formatBytes(inst.metrics?.memoryRss)} · ${formatUptime(inst.metrics?.uptime)}</td>
          </tr>
          <tr>
            <td class="key">消息 / 命令</td>
            <td class="val" id="inst-msgs-${escapeHtml(cfg.id)}">${escapeHtml(inst.metrics?.messagesCount || 0)} / ${escapeHtml(inst.metrics?.commandsCount || 0)}</td>
          </tr>
          <tr>
            <td class="key">网络代理</td>
            <td class="val">${cfg.proxy ? `${escapeHtml(String(cfg.proxy.type).toUpperCase())} (${escapeHtml(cfg.proxy.host)}:${escapeHtml(cfg.proxy.port)})` : '直连 (无代理)'}</td>
          </tr>
          <tr>
            <td class="key">命令前缀</td>
            <td class="val">${escapeHtml((cfg.prefixes || ['.', '/']).join(' '))}</td>
          </tr>
        </tbody>
      </table>

      <div class="inst-card-actions">
        ${
          isOnline
            ? `<button class="btn btn-secondary btn-sm" data-action="restart" data-id="${escapeHtml(cfg.id)}">
                 <svg class="ui-icon-sm"><use href="#icon-refresh"/></svg><span>重启</span>
               </button>
               <button class="btn btn-danger btn-sm" data-action="stop" data-id="${escapeHtml(cfg.id)}">
                 <svg class="ui-icon-sm"><use href="#icon-stop"/></svg><span>停止</span>
               </button>
               <button class="btn btn-secondary btn-sm" data-action="logout" data-id="${escapeHtml(cfg.id)}" title="退出此 Telegram 登录会话">
                 <svg class="ui-icon-sm"><use href="#icon-logout"/></svg><span>退出账号</span>
               </button>`
            : isStarting || isNeedsAuth
            ? `<button class="btn btn-danger btn-sm" data-action="stop" data-id="${escapeHtml(cfg.id)}" title="终止运行">
                 <svg class="ui-icon-sm"><use href="#icon-stop"/></svg><span>停止</span>
               </button>`
            : `<button class="btn btn-primary btn-sm" data-action="start" data-id="${escapeHtml(cfg.id)}">
                 <svg class="ui-icon-sm"><use href="#icon-play"/></svg><span>启动</span>
               </button>`
        }
        ${
          isNeedsAuth
            ? `<button class="btn btn-primary btn-sm" style="border-color: var(--color-warning); background: rgba(245, 158, 11, 0.25); color: #fbbf24;" data-action="auth" data-id="${escapeHtml(cfg.id)}" data-step="${authStep}">
                 <svg class="ui-icon-sm"><use href="#icon-key"/></svg><span>${authStep === 'qr' ? '扫码登录中' : authStep === 'code' ? '输入验证码' : authStep === 'password' ? '输入2FA密码' : '输入手机号'}</span>
               </button>`
            : ''
        }
        <button class="btn btn-secondary btn-sm" data-action="view-logs" data-id="${escapeHtml(cfg.id)}">
          <svg class="ui-icon-sm"><use href="#icon-terminal"/></svg><span>日志</span>
        </button>
        <button class="btn btn-secondary btn-sm" style="margin-left: auto;" data-action="delete" data-id="${escapeHtml(cfg.id)}" title="删除实例">
          <svg class="ui-icon-sm"><use href="#icon-trash"/></svg>
        </button>
      </div>
    </div>
  `;
}

function updateInstanceStatus(instanceId, status) {
  if (state.clientSelectedInstance === instanceId && status !== 'ONLINE') window.MiniApp?.close();
  const inst = state.instances.find((i) => i.config.id === instanceId);
  if (inst) {
    inst.status = status;
    renderInstances();
  } else {
    loadInstances();
  }
}

function updateInstanceCardMetrics(instanceId, metrics) {
  const memEl = document.querySelectorAll(`#inst-mem-${instanceId}`);
  memEl.forEach((e) => {
    e.innerText = `${formatBytes(metrics.memoryRss)} · ${formatUptime(metrics.uptime)}`;
  });
  const msgsEl = document.querySelectorAll(`#inst-msgs-${instanceId}`);
  msgsEl.forEach((e) => {
    e.innerText = `${metrics.messagesCount || 0} / ${metrics.commandsCount || 0}`;
  });
}

function clearLoggedOutAccountState(instanceId) {
  window.CloudDrafts?.clearAccount(instanceId);
  window.BotKeyboard?.clearAccount(instanceId);
  // Draft keys include the instance ID. A later login in the same instance
  // must not inherit the previous account's unsent text.
  for (const key of Object.keys(state.clientDrafts || {})) {
    try {
      if (JSON.parse(key)[0] === instanceId) delete state.clientDrafts[key];
    } catch (_) { /* Ignore keys from old versions. */ }
  }
  if (state.clientSelectedInstance !== instanceId) return;
  window.MiniApp?.close();
  window.PinnedMessages?.close();
  if (typeof closePollVotersDialog === 'function') closePollVotersDialog();
  if (typeof closeMessageReactionUsersDialog === 'function') closeMessageReactionUsersDialog();
  if (typeof closeMessageReadParticipantsDialog === 'function') closeMessageReadParticipantsDialog();
  if (typeof closeQuickRepliesDialog === 'function') closeQuickRepliesDialog();
  if (typeof closeScheduledMessagesDialog === 'function') closeScheduledMessagesDialog();
  if (typeof closeStoryViewer === 'function') closeStoryViewer();
  if (document.getElementById('modal-profile')?.classList?.contains('active')) closeProfileModal();
  window.ChatComments?.close();
  window.ForumTopics?.setDialog(null);
  resetClientExpressions();
  if (typeof invalidateGroupMembers === 'function') invalidateGroupMembers();
  if (typeof stopVoiceRecording === 'function') void stopVoiceRecording(false);
  if (typeof stopVideoNoteRecording === 'function') void stopVideoNoteRecording(false);
  state.chatSelectionVersion = (state.chatSelectionVersion || 0) + 1;
  state.clientActiveChatId = null;
  state.clientActiveDialog = null;
  if (typeof clearTelegramChatAppearance === 'function') clearTelegramChatAppearance();
  state.clientSavedReactionFilter = null;
  state.clientMessageEffectId = null;
  const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
  document.getElementById('modal-saved-message-tags')?.classList.remove('active');
  if (document.getElementById('saved-message-tags-bar')) document.getElementById('saved-message-tags-bar').hidden = true;
  const quickReplyButton = document.getElementById('btn-chat-quick-replies');
  if (quickReplyButton) quickReplyButton.hidden = true;
  state.currentProfileChatId = null;
  state.clientDialogs = [];
  state.clientMessages = [];
  state.clientHistoryOffsetDate = null;
  state.clientSearchQuery = '';
  state.searchMatchIds = [];
  state.searchMatchIdx = -1;
  cancelReplyBanner();
  cancelEditBanner();
  clearStagedAttachment();
  const input = document.getElementById('client-message-textarea');
  if (input) { input.value = ''; autoResizeTextarea(input); }
  const messages = document.getElementById('client-messages-container');
  if (messages) messages.innerHTML = '<div class="chat-placeholder"><p>账号已退出</p></div>';
  const title = document.getElementById('client-chat-title');
  if (title) title.textContent = '请选择左侧会话';
  const subtitle = document.getElementById('client-chat-subtitle');
  if (subtitle) subtitle.textContent = '';
  const actions = document.getElementById('client-chat-actions');
  if (actions) actions.style.display = 'none';
  const avatarImg = document.getElementById('client-chat-avatar-img');
  if (avatarImg) { scheduler.cancelImage(avatarImg); avatarImg.removeAttribute('src'); avatarImg.style.opacity = '0'; }
  const avatarText = document.getElementById('client-chat-avatar');
  if (avatarText) { avatarText.textContent = 'TG'; avatarText.style.display = 'flex'; }
  const drawer = document.getElementById('client-drawer');
  if (drawer) { drawer.classList.remove('open'); drawer.style.display = 'none'; }
  document.querySelector('.client-layout')?.classList.remove('in-chat');
  updateClientHistoryBanner();
  renderClientDialogs();
}

function bindCardActionButtons() {
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      try {
        if (action === 'start') {
          showToast(`正在启动实例 "${id}"...`, 'info');
          await api(`/api/instances/${id}/start`, 'POST');
          await loadInstances();

          // 🌟 主动探测轮询: 启动后每 800ms 探测一次实例状态 (最多持续 15 次)，感知待验证或上线状态并自动弹出窗口
          let pollCount = 0;
          const pollTimer = setInterval(async () => {
            pollCount++;
            await loadInstances();
            const current = state.instances.find((i) => i.config.id === id);
            if (!current || current.status === 'ONLINE' || current.status === 'ERROR' || pollCount > 15) {
              clearInterval(pollTimer);
            }
          }, 800);
        } else if (action === 'stop') {
          showToast(`正在停止实例 "${id}"...`, 'info');
          await api(`/api/instances/${id}/stop`, 'POST');
          await loadInstances();
        } else if (action === 'restart') {
          showToast(`正在重启实例 "${id}"...`, 'info');
          await api(`/api/instances/${id}/restart`, 'POST');
          await loadInstances();
        } else if (action === 'logout') {
          if (!confirm(`退出账号将撤销实例 "${id}" 的 Telegram 登录会话并停止该实例。下次启动需要重新登录。确定退出吗？`)) return;
          btn.disabled = true;
          try {
            const result = await api(`/api/instances/${encodeURIComponent(id)}/account/logout`, 'POST');
            clearLoggedOutAccountState(id);
            await loadInstances();
            showToast(result.localSessionRemoved ? '已退出 Telegram 账号' : '已退出 Telegram，但本地会话文件未能删除，请检查文件权限', result.localSessionRemoved ? 'success' : 'warn');
          } finally {
            btn.disabled = false;
          }
        } else if (action === 'auth') {
          const step = btn.dataset.step || 'phone';
          openAuthModal(id, step);
        } else if (action === 'view-logs') {
          el.logFilterInst.value = id;
          switchView('logs');
          loadHistoryLogs(id);
        } else if (action === 'delete') {
          if (confirm(`确定彻底删除实例 "${id}" 及其数据吗？`)) {
            await api(`/api/instances/${id}`, 'DELETE');
            showToast(`实例 "${id}" 已删除`, 'success');
            loadInstances();
          }
        }
      } catch (err) {
        showToast(err.message, 'error');
        await loadInstances();
      }
    };
  });
}

async function loadHistoryLogs(instanceId = 'all') {
  try {
    if (instanceId && instanceId !== 'all') {
      const history = await api(`/api/instances/${instanceId}/logs`);
      if (Array.isArray(history)) {
        state.logs = history;
        filterRenderLogs();
      }
    }
  } catch {
    /* swallow */
  }
}

function updateInstanceDropdowns() {
  const opts = state.instances.map((i) => `<option value="${escapeHtml(i.config.id)}">${escapeHtml(i.config.name)} (${escapeHtml(i.config.id)})</option>`).join('');
  el.pluginInstSelect.innerHTML = opts || '<option value="none">无可用实例</option>';
  el.logFilterInst.innerHTML = '<option value="all">全部实例</option>' + opts;

  if (state.instances.length > 0 && !state.instances.find((i) => i.config.id === state.selectedInstanceForPlugins)) {
    state.selectedInstanceForPlugins = state.instances[0].config.id;
    el.pluginInstSelect.value = state.selectedInstanceForPlugins;
  }
}

// Rendering Plugins
function renderPlugins() {
  const query = (el.pluginSearchInput.value || '').toLowerCase().trim();

  const filtered = state.plugins.filter(
    (p) => p.name.toLowerCase().includes(query) || (p.description || '').toLowerCase().includes(query),
  );

  el.pluginsGrid.innerHTML = filtered
    .map((p) => {
      return `
      <div class="plugin-card">
        <div class="plugin-card-header">
          <div class="plugin-card-title">
            <svg class="ui-icon" style="color: #60a5fa;"><use href="#icon-plugins"/></svg>
            <span class="plugin-name">${escapeHtml(p.name)}</span>
            <span class="plugin-version">v${escapeHtml(p.version)}</span>
          </div>
          <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(p.author || 'builtin')}</span>
        </div>
        <div class="plugin-desc">${escapeHtml(p.description || '暂无详细描述')}</div>
        <div class="plugin-card-footer">
          <div class="plugin-actions">
            <button class="btn btn-secondary btn-sm" onclick="openConfigModal(${inlineJsArg(p.name)})">
              <svg class="ui-icon-sm"><use href="#icon-settings"/></svg><span>配置</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="reloadPlugin(${inlineJsArg(p.name)})">
              <svg class="ui-icon-sm"><use href="#icon-refresh"/></svg><span>重载</span>
            </button>
            <button class="btn btn-danger btn-sm" onclick="deletePlugin(${inlineJsArg(p.name)})">
              <svg class="ui-icon-sm"><use href="#icon-trash"/></svg><span>卸载</span>
            </button>
          </div>
          <label class="switch" title="启用/禁用">
            <input type="checkbox" checked onchange="togglePlugin(${inlineJsArg(p.name)}, this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
    })
    .join('');
}

// Plugin Actions
window.togglePlugin = async (pluginName, enabled) => {
  const instId = el.pluginInstSelect.value;
  try {
    const action = enabled ? 'enable' : 'disable';
    await api(`/api/instances/${instId}/plugins/${pluginName}/${action}`, 'POST');
    showToast(`实例 "${instId}" 插件 "${pluginName}" 已${enabled ? '启用' : '禁用'}`, 'success');
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
};

window.reloadPlugin = async (pluginName) => {
  const instId = el.pluginInstSelect.value;
  try {
    await api(`/api/instances/${instId}/plugins/${pluginName}/reload`, 'POST');
    showToast(`插件 "${pluginName}" 热重载完成`, 'success');
  } catch (err) {
    showToast(`热重载失败: ${err.message}`, 'error');
  }
};

window.deletePlugin = async (pluginName) => {
  if (confirm(`确定要从硬盘中彻底删除插件 "${pluginName}" 吗？该插件将从所有实例中注销！`)) {
    try {
      await api(`/api/plugins/${pluginName}`, 'DELETE');
      showToast(`插件 "${pluginName}" 已卸载`, 'success');
      loadPlugins();
    } catch (err) {
      showToast(`卸载失败: ${err.message}`, 'error');
    }
  }
};

window.openConfigModal = async (pluginName) => {
  state.selectedConfigPlugin = pluginName;
  const instId = el.pluginInstSelect.value;
  document.getElementById('plugin-config-title').innerText = `插件配置: ${pluginName} (${instId})`;
  try {
    const [configRes, pluginsRes] = await Promise.all([
      api(`/api/plugins/${pluginName}/config?instance=${instId}`),
      api('/api/plugins'),
    ]);
    const config = configRes.config || {};
    const pluginMeta = Array.isArray(pluginsRes) ? pluginsRes.find((p) => p.name === pluginName) : null;
    const schema = pluginMeta?.configSchema || [];

    state.selectedConfigSchema = schema;
    state.selectedConfigValues = config;

    const formEl = document.getElementById('plugin-config-form');
    const jsonEl = document.getElementById('plugin-config-json');
    const formBtn = document.getElementById('btn-config-mode-form');
    const jsonBtn = document.getElementById('btn-config-mode-json');

    if (schema.length > 0) {
      // Schema available → default to form mode
      window.PluginConfigForm.render(formEl, schema, config);
      formEl.style.display = '';
      jsonEl.style.display = 'none';
      formBtn.classList.add('active');
      jsonBtn.classList.remove('active');
    } else {
      // No schema → JSON mode
      formEl.style.display = 'none';
      jsonEl.style.display = '';
      formBtn.classList.remove('active');
      jsonBtn.classList.add('active');
      jsonEl.value = JSON.stringify(config, null, 2);
    }

    el.modalPluginConfig.classList.add('active');
  } catch (err) {
    showToast(`获取配置失败: ${err.message}`, 'error');
  }
};

// Logs
function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();

  // Check filter
  const instFilter = el.logFilterInst.value;
  if (instFilter !== 'all' && entry.instanceId !== instFilter) return;

  const levelFilter = el.logFilterLevel.value;
  if (levelFilter !== 'all' && entry.level !== levelFilter) return;

  const searchFilter = (el.logSearchInput.value || '').toLowerCase();
  if (searchFilter && !entry.msg.toLowerCase().includes(searchFilter)) return;

  const timeStr = new Date(entry.time).toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-tag">[${escapeHtml(entry.instanceId)}]</span>
    <span class="log-level ${escapeHtml(entry.level)}">[${escapeHtml(entry.level.toUpperCase())}]</span>
    <span class="log-msg">${escapeHtml(entry.msg)}</span>
  `;

  el.terminalContainer.appendChild(line);

  if (el.logAutoScroll.checked) {
    el.terminalContainer.scrollTop = el.terminalContainer.scrollHeight;
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// JSON protects the JavaScript string context; HTML escaping then protects
// the surrounding quoted attribute. Neither layer is sufficient alone.
function inlineJsArg(value) {
  if (typeof value === 'bigint') value = String(value);
  const json = JSON.stringify(value == null ? null : value) || 'null';
  return escapeHtml(json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
}

/**
 * Sanitizes URLs to ensure safe schemes (http, https, tg, mailto)
 */
function sanitizeUrl(url) {
  if (!url) return '#';
  const trimmed = String(url).trim();
  if (/^(https?:\/\/|tg:\/\/|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(trimmed)) {
    return 'https://' + trimmed;
  }
  return '#';
}

/**
 * Parses plain text fallback links and markdown formatting
 */
function autoLinkPlainText(text) {
  if (!text) return '';

  // Protect generated HTML from the formatting replacements below. Otherwise
  // markup inside a URL can be interpreted inside an attribute.
  const links = [];
  const saveLink = (html) => `\u0000LINK${links.push(html) - 1}\u0000`;
  const unescapeOnce = (value) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  })[entity]);

  // 1. Extract markdown links [label](url)
  let processed = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+|tg:\/\/[^\s\)]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\)]*)\)/g, (match, label, url) => {
    const safe = escapeHtml(sanitizeUrl(url));
    return saveLink(`<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-text-link" title="${safe}">${escapeHtml(label)}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`);
  });

  // 2. Escape HTML
  processed = escapeHtml(processed);

  // 3. Autolink plain URLs (https://, http://, t.me/, tg://)
  const urlRegex = /(https?:\/\/[^\s<]+|t\.me\/[a-zA-Z0-9_+\/-]+|tg:\/\/[^\s<]+)/gi;
  processed = processed.replace(urlRegex, (url) => {
    const safe = escapeHtml(sanitizeUrl(unescapeOnce(url)));
    return saveLink(`<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-url-link" title="${safe}">${url}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`);
  });

  // 4. Basic markdown inline formatting
  processed = processed
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="tg-code">$1</code>')
    .replace(/\|\|([^|]+)\|\|/g, '<span class="tg-spoiler" onclick="this.classList.toggle(\'revealed\')" title="点击显示/隐藏剧透">$1</span>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');

  return processed.replace(/\u0000LINK(\d+)\u0000/g, (match, i) => links[Number(i)] ?? match);
}

/**
 * Telegram Full Rich Message Content Formatter
 * Accurately parses entities (TextUrl, Url, Bold, Italic, Code, Pre, Spoiler, etc.)
 */
function formatMessageContent(text, entities) {
  if (!text) return '';
  const rawText = String(text);
  const sorted = (Array.isArray(entities) ? entities : []).map(entity => ({
    entity,
    start: Number(entity?.offset),
    end: Number(entity?.offset) + Number(entity?.length),
  })).filter(item => Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) &&
    item.start >= 0 && item.end > item.start && item.end <= rawText.length)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const renderEntity = (item, inner) => {
    const { entity } = item;
    const entityText = rawText.slice(item.start, item.end);
    const escaped = escapeHtml(entityText);
    const type = entity?.type || '';
    if ((type === 'MessageEntityTextUrl' || type === 'text_url') && entity.url) {
      const safe = escapeHtml(sanitizeUrl(entity.url));
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-text-link" title="${safe}">${inner}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`;
    }
    if (type === 'MessageEntityUrl' || type === 'url') {
      const safe = escapeHtml(sanitizeUrl(entityText));
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-url-link" title="${safe}">${escaped}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`;
    }
    if (type === 'MessageEntityBold' || type === 'bold') return `<strong>${inner}</strong>`;
    if (type === 'MessageEntityItalic' || type === 'italic') return `<em>${inner}</em>`;
    if (type === 'MessageEntityCode' || type === 'code') return `<code class="tg-code">${escaped}</code>`;
    if (type === 'MessageEntityPre' || type === 'pre') return `<pre class="tg-pre"><code>${escaped}</code></pre>`;
    if (type === 'MessageEntityStrike' || type === 'strike') return `<s>${inner}</s>`;
    if (type === 'MessageEntityUnderline' || type === 'underline') return `<u>${inner}</u>`;
    if (type === 'MessageEntitySpoiler' || type === 'spoiler') return `<span class="tg-spoiler" onclick="this.classList.toggle('revealed')" title="点击显示/隐藏剧透">${inner}</span>`;
    if (type === 'MessageEntityBlockquote' || type === 'blockquote') {
      if (entity.collapsed === true) return `<details class="tg-blockquote tg-blockquote-collapsed"><summary><span class="tg-quote-show">显示引用文本</span><span class="tg-quote-hide">收起引用文本</span></summary><div class="tg-blockquote-content">${inner}</div></details>`;
      return `<blockquote class="tg-blockquote">${inner}</blockquote>`;
    }
    if (type === 'MessageEntityCustomEmoji' || type === 'custom_emoji') {
      const documentId = String(entity.documentId || entity.document_id || '');
      const instanceId = typeof state !== 'undefined' ? String(state.clientSelectedInstance || '') : '';
      if (/^\d{1,20}$/.test(documentId) && !/^0+$/.test(documentId) && instanceId) {
        const src = `/api/instances/${encodeURIComponent(instanceId)}/account/custom-emoji?documentId=${encodeURIComponent(documentId)}`;
        return `<img class="tg-custom-emoji" data-network-src="${escapeHtml(src)}" alt="${escaped}" title="${escaped}" loading="lazy" decoding="async">`;
      }
      return escaped;
    }
    if (type === 'MessageEntityMention' || type === 'MessageEntityMentionName' || type === 'mention') return `<span class="tg-mention">${inner}</span>`;
    return inner;
  };

  const renderRange = (start, end, candidates) => {
    let result = '';
    let cursor = start;
    for (const item of candidates) {
      if (item.start < cursor || item.start < start || item.end > end) continue;
      if (item.start > cursor) result += autoLinkPlainText(rawText.slice(cursor, item.start));
      const children = candidates.filter(child => child !== item && child.start >= item.start && child.end <= item.end &&
        (child.start > item.start || child.end < item.end));
      const entityType = item.entity?.type || '';
      const inner = entityType === 'MessageEntityCode' || entityType === 'code' || entityType === 'MessageEntityPre' || entityType === 'pre'
        ? escapeHtml(rawText.slice(item.start, item.end))
        : renderRange(item.start, item.end, children);
      result += renderEntity(item, inner);
      cursor = item.end;
    }
    if (cursor < end) result += autoLinkPlainText(rawText.slice(cursor, end));
    return result;
  };

  return renderRange(0, rawText.length, sorted).replace(/\n/g, '<br>');
}

// Interactive Auth Modal
// The temporary access key stays in this page's memory and is never logged or
// persisted. QR tokens themselves are returned only as a no-store image.
let authQrSession = null;

function forgetAuthQr() {
  if (authQrSession?.timer) clearTimeout(authQrSession.timer);
  authQrSession = null;
  const image = document.getElementById('auth-qr-image');
  if (image) { image.removeAttribute('src'); image.style.display = 'none'; }
}

async function cancelAuthQr(session) {
  if (!session) return;
  try {
    await fetch(`/api/instances/${encodeURIComponent(session.instanceId)}/auth/qr`, {
      method: 'DELETE', headers: { 'X-QR-Access-Key': session.key }, cache: 'no-store',
    });
  } catch (_) { /* The worker may already have completed or stopped. */ }
}

async function pollAuthQr(session) {
  if (authQrSession !== session) return;
  try {
    const response = await fetch(`/api/instances/${encodeURIComponent(session.instanceId)}/auth/qr`, {
      headers: { 'X-QR-Access-Key': session.key }, cache: 'no-store',
    });
    if (authQrSession !== session) return;
    if ([401, 403, 404, 410].includes(response.status)) {
      forgetAuthQr();
      const status = document.getElementById('auth-qr-status');
      if (status) status.textContent = '二维码登录已结束，请检查实例状态，必要时重新启动实例。';
      return;
    }
    if (!response.ok) throw new Error('二维码登录已结束，请重新开始');
    const result = await response.json();
    if (authQrSession !== session) return;
    const image = document.getElementById('auth-qr-image');
    const status = document.getElementById('auth-qr-status');
    if (result.image && result.expires * 1000 > Date.now()) {
      image.src = result.image;
      image.style.display = 'block';
      status.textContent = '在 Telegram 的设置中选择“设备”并扫描二维码。二维码会自动刷新。';
    } else {
      image.removeAttribute('src');
      image.style.display = 'none';
      status.textContent = '正在等待有效的二维码...';
    }
  } catch (_) {
    if (authQrSession !== session) return;
    document.getElementById('auth-qr-status').textContent = '二维码暂时不可用，正在重试...';
  }
  if (authQrSession === session) session.timer = setTimeout(() => pollAuthQr(session), 2000);
}

async function startAuthQr() {
  const instanceId = state.currentAuthInstanceId;
  if (!instanceId || state.currentAuthStep !== 'phone') return;
  const button = document.getElementById('btn-auth-qr');
  button.disabled = true;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(instanceId)}/auth/qr`, 'POST');
    const session = { instanceId, key: result.accessKey, timer: null };
    // The modal can be closed or switched to another account during the request.
    if (state.currentAuthInstanceId !== instanceId || state.currentAuthStep !== 'phone') {
      await cancelAuthQr(session);
      return;
    }
    authQrSession = session;
    openAuthModal(instanceId, 'qr');
    pollAuthQr(session);
  } catch (err) {
    showToast(`无法开始扫码登录: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function openAuthModal(instanceId, step = 'phone') {
  // A delayed duplicate phone/code prompt must not discard an active QR
  // credential. After a scan, the same account may proceed to 2FA.
  if (authQrSession && authQrSession.instanceId === instanceId && (step === 'phone' || step === 'code')) return;
  if (authQrSession && (authQrSession.instanceId !== instanceId || step !== 'qr')) {
    const oldSession = authQrSession;
    const anotherAccount = oldSession.instanceId !== instanceId;
    forgetAuthQr();
    // Password prompts from the same account mean the QR was scanned. A
    // different account's prompt instead abandons this in-flight QR login.
    if (anotherAccount) cancelAuthQr(oldSession);
  }
  if (state.currentAuthInstanceId !== instanceId || state.currentAuthStep !== step) {
    for (const id of ['auth-input-phone', 'auth-input-code', 'auth-input-password']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
  }
  state.currentAuthInstanceId = instanceId;
  state.currentAuthStep = step;

  document.getElementById('auth-modal-title').innerText = `Telegram 身份验证 (${instanceId})`;

  document.getElementById('auth-group-phone').style.display = step === 'phone' ? 'flex' : 'none';
  const qrGroup = document.getElementById('auth-group-qr');
  if (qrGroup) qrGroup.style.display = step === 'qr' ? 'flex' : 'none';
  document.getElementById('auth-group-code').style.display = step === 'code' ? 'flex' : 'none';
  document.getElementById('auth-group-password').style.display = step === 'password' ? 'flex' : 'none';

  const hints = {
    phone: '请输入该账号国际格式手机号码（如 +8613800000000），点击提交后 Telegram 会发送验证码。',
    qr: authQrSession ? '使用已登录的 Telegram 客户端扫描二维码。取消将停止此实例的登录。' : '扫码登录由另一个页面发起，请在该页面完成或停止实例后重试。',
    code: 'Telegram 验证码已发送至您的官方客户端或短信，请输入收到的数字验证码。',
    password: '该账号已开启两步验证保护，请输入两步验证 (2FA) 密码。',
  };
  document.getElementById('auth-hint').innerText = hints[step] || '请输入验证信息。';

  el.modalAuth.classList.add('active');
  const submit = document.getElementById('btn-submit-auth');
  if (submit) submit.style.display = step === 'qr' ? 'none' : '';
  const activeInput =
    step === 'phone'
      ? document.getElementById('auth-input-phone')
      : step === 'code'
      ? document.getElementById('auth-input-code')
      : document.getElementById('auth-input-password');
  if (step !== 'qr' && activeInput) setTimeout(() => activeInput.focus(), 100);
}

function closeAuthModal(completed = false) {
  const session = authQrSession;
  forgetAuthQr();
  if (session && !completed) cancelAuthQr(session);
  el.modalAuth.classList.remove('active');
  state.currentAuthInstanceId = null;
  state.currentAuthStep = null;
  for (const id of ['auth-input-phone', 'auth-input-code', 'auth-input-password']) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }
}

// Event Listeners
function initListeners() {
  // Mobile Sidebar Toggle
  const btnMobileMenu = document.getElementById('btn-mobile-menu');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const sidebar = document.querySelector('.sidebar');

  const openMobileSidebar = () => {
    sidebar?.classList.add('open');
    sidebarBackdrop?.classList.add('open');
  };
  const closeMobileSidebar = () => {
    sidebar?.classList.remove('open');
    sidebarBackdrop?.classList.remove('open');
  };

  if (btnMobileMenu) btnMobileMenu.onclick = openMobileSidebar;
  const btnClientAdminMenu = document.getElementById('btn-client-admin-menu');
  if (btnClientAdminMenu) btnClientAdminMenu.onclick = openMobileSidebar;
  if (sidebarBackdrop) sidebarBackdrop.onclick = closeMobileSidebar;

  // Navigation
  el.navItems.forEach((item) => {
    item.onclick = () => {
      switchView(item.dataset.view);
      closeMobileSidebar();
    };
  });

  // Global actions
  el.btnStartAll.onclick = async () => {
    showToast('正在启动所有配置为自动运行的实例...', 'info');
    for (const inst of state.instances) {
      if (inst.status !== 'ONLINE') {
        api(`/api/instances/${inst.config.id}/start`, 'POST').catch(() => {});
      }
    }
  };

  el.btnStopAll.onclick = async () => {
    showToast('正在停止所有实例...', 'info');
    for (const inst of state.instances) {
      if (inst.status !== 'STOPPED') {
        api(`/api/instances/${inst.config.id}/stop`, 'POST').catch(() => {});
      }
    }
  };

  // Auth modal
  document.getElementById('btn-close-auth').onclick = () => closeAuthModal();
  document.getElementById('btn-cancel-auth').onclick = () => closeAuthModal();
  document.getElementById('btn-auth-qr').onclick = startAuthQr;

  const submitAuth = async () => {
    const instId = state.currentAuthInstanceId;
    const step = state.currentAuthStep;
    const btn = document.getElementById('btn-submit-auth');
    if (btn.disabled) return;
    const val =
      step === 'phone'
        ? document.getElementById('auth-input-phone').value.trim()
        : step === 'code'
        ? document.getElementById('auth-input-code').value.trim()
        : document.getElementById('auth-input-password').value;

    if (!val && step !== 'password') {
      return showToast('输入内容不能为空', 'error');
    }

    try {
      btn.disabled = true;
      btn.innerText = '提交验证中...';
      await api(`/api/instances/${instId}/auth`, 'POST', { step, value: val });
      showToast(`已提交 ${step === 'phone' ? '手机号码' : step === 'code' ? '验证码' : '2FA密码'}，等待 Telegram 响应...`, 'info');
    } catch (err) {
      showToast(`提交失败: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerText = '提交';
    }
  };

  document.getElementById('btn-submit-auth').onclick = submitAuth;

  // Bind Enter key for auth inputs
  ['auth-input-phone', 'auth-input-code', 'auth-input-password'].forEach((inputId) => {
    const inp = document.getElementById(inputId);
    if (inp) {
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitAuth();
        }
      };
    }
  });

  // Create Instance Modal
  el.btnOpenCreateInst.onclick = () => {
    document.getElementById('inst-modal-title').innerText = '新建实例配置';
    document.getElementById('inst-input-id').value = `bot_${state.instances.length + 1}`;
    document.getElementById('inst-input-name').value = `Bot Account ${state.instances.length + 1}`;
    el.modalInst.classList.add('active');
  };
  document.getElementById('btn-close-inst').onclick = () => el.modalInst.classList.remove('active');
  document.getElementById('btn-cancel-inst').onclick = () => el.modalInst.classList.remove('active');
  document.getElementById('btn-save-inst').onclick = async () => {
    const id = document.getElementById('inst-input-id').value.trim();
    const name = document.getElementById('inst-input-name').value.trim();
    const apiId = document.getElementById('inst-input-api-id').value.trim();
    const apiHash = document.getElementById('inst-input-api-hash').value.trim();
    const ownerId = document.getElementById('inst-input-owner-id').value.trim();
    const prefixes = document
      .getElementById('inst-input-prefixes')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const autoStart = document.getElementById('inst-input-autostart').checked;

    if (!id || !apiId || !apiHash || !ownerId) {
      return showToast('请填写所有必填字段 (*)', 'error');
    }

    const proxyType = document.getElementById('inst-proxy-type').value;
    const proxyHost = document.getElementById('inst-proxy-host').value.trim();
    const proxyPort = document.getElementById('inst-proxy-port').value.trim();
    let proxy = undefined;
    if (proxyType !== 'none' && proxyHost && proxyPort) {
      proxy = {
        type: proxyType,
        host: proxyHost,
        port: Number(proxyPort),
      };
    }

    try {
      await api('/api/instances', 'POST', {
        id,
        name,
        apiId: Number(apiId),
        apiHash,
        ownerId: Number(ownerId),
        prefixes,
        proxy,
        autoStart,
      });
      showToast(`实例 "${id}" 创建成功`, 'success');
      el.modalInst.classList.remove('active');
      loadInstances();
    } catch (err) {
      showToast(`创建实例失败: ${err.message}`, 'error');
    }
  };

  // Create Plugin Modal
  el.btnOpenCreatePlugin.onclick = () => el.modalCreatePlugin.classList.add('active');
  document.getElementById('btn-close-create-plugin').onclick = () => el.modalCreatePlugin.classList.remove('active');
  document.getElementById('btn-cancel-create-plugin').onclick = () => el.modalCreatePlugin.classList.remove('active');
  document.getElementById('btn-save-create-plugin').onclick = async () => {
    const name = document.getElementById('plugin-input-name').value.trim();
    const version = document.getElementById('plugin-input-version').value.trim() || '1.0.0';
    const description = document.getElementById('plugin-input-desc').value.trim();
    const code = document.getElementById('plugin-input-code').value.trim();

    if (!name) return showToast('请输入插件名称', 'error');

    try {
      await api('/api/plugins', 'POST', { name, version, description, code });
      showToast(`插件 "${name}" 创建成功`, 'success');
      el.modalCreatePlugin.classList.remove('active');
      loadPlugins();
    } catch (err) {
      showToast(`创建插件失败: ${err.message}`, 'error');
    }
  };

  // Plugin Config Modal — dual mode (form / JSON)
  document.getElementById('btn-close-plugin-config').onclick = () => el.modalPluginConfig.classList.remove('active');
  document.getElementById('btn-cancel-plugin-config').onclick = () => el.modalPluginConfig.classList.remove('active');

  // Mode switching
  document.getElementById('btn-config-mode-form').onclick = () => {
    const formEl = document.getElementById('plugin-config-form');
    const jsonEl = document.getElementById('plugin-config-json');
    formEl.style.display = '';
    jsonEl.style.display = 'none';
    document.getElementById('btn-config-mode-form').classList.add('active');
    document.getElementById('btn-config-mode-json').classList.remove('active');
  };
  document.getElementById('btn-config-mode-json').onclick = () => {
    const formEl = document.getElementById('plugin-config-form');
    const jsonEl = document.getElementById('plugin-config-json');
    formEl.style.display = 'none';
    jsonEl.style.display = '';
    document.getElementById('btn-config-mode-form').classList.remove('active');
    document.getElementById('btn-config-mode-json').classList.add('active');
    // Sync form values → JSON
    if (state.selectedConfigSchema?.length) {
      jsonEl.value = JSON.stringify(window.PluginConfigForm.toJSON(formEl, state.selectedConfigSchema), null, 2);
    }
  };

  // Reset to defaults
  document.getElementById('btn-reset-plugin-config').onclick = () => {
    if (state.selectedConfigSchema?.length) {
      window.PluginConfigForm.resetToDefaults(
        document.getElementById('plugin-config-form'),
        state.selectedConfigSchema
      );
      showToast('已恢复默认值（未保存）', 'info');
    }
  };

  // Save
  document.getElementById('btn-save-plugin-config').onclick = async () => {
    const pluginName = state.selectedConfigPlugin;
    const instId = el.pluginInstSelect.value;
    const formEl = document.getElementById('plugin-config-form');
    const jsonEl = document.getElementById('plugin-config-json');
    const isFormMode = formEl.style.display !== 'none';

    try {
      let parsed;
      if (isFormMode && state.selectedConfigSchema?.length) {
        // Validate form
        if (!window.PluginConfigForm.validate(formEl, state.selectedConfigSchema)) {
          showToast('请修正表单中的校验错误', 'error');
          return;
        }
        parsed = window.PluginConfigForm.toJSON(formEl, state.selectedConfigSchema);
      } else {
        parsed = JSON.parse(jsonEl.value);
      }
      await api(`/api/plugins/${pluginName}/config?instance=${instId}`, 'PUT', { config: parsed });
      showToast(`插件 "${pluginName}" 配置已更新`, 'success');
      el.modalPluginConfig.classList.remove('active');
    } catch (err) {
      showToast(`保存配置失败: ${err.message}`, 'error');
    }
  };

  // Search & Filter
  el.pluginSearchInput.oninput = () => renderPlugins();
  el.pluginInstSelect.onchange = () => {
    state.selectedInstanceForPlugins = el.pluginInstSelect.value;
    renderPlugins();
  };

  el.btnClearLogs.onclick = () => {
    el.terminalContainer.innerHTML = '';
  };
  el.logFilterInst.onchange = () => filterRenderLogs();
  el.logFilterLevel.onchange = () => filterRenderLogs();
  el.logSearchInput.oninput = () => filterRenderLogs();

  // Web Client View Listeners
  const clientAccountSelect = document.getElementById('client-account-select');
  if (clientAccountSelect) {
    clientAccountSelect.onchange = () => {
      closeCreateChatModal();
      window.MiniApp?.close();
      window.PinnedMessages?.close();
      if (typeof closePollVotersDialog === 'function') closePollVotersDialog();
      if (typeof closeMessageReactionUsersDialog === 'function') closeMessageReactionUsersDialog();
      if (typeof closeMessageReadParticipantsDialog === 'function') closeMessageReadParticipantsDialog();
      if (typeof closeQuickRepliesDialog === 'function') closeQuickRepliesDialog();
      if (typeof closeScheduledMessagesDialog === 'function') closeScheduledMessagesDialog();
      closeStoryViewer();
      window.BotKeyboard?.resetReply();
      if (document.getElementById('modal-profile')?.classList?.contains('active')) closeProfileModal();
      window.ChatComments?.close();
      window.ForumTopics?.setDialog(null);
      resetClientExpressions();
      if (typeof invalidateGroupMembers === 'function') invalidateGroupMembers();
      if (typeof stopVoiceRecording === 'function') void stopVoiceRecording(false);
      if (typeof stopVideoNoteRecording === 'function') void stopVideoNoteRecording(false);
      const textarea = document.getElementById('client-message-textarea');
      if (state.clientActiveChatId && textarea && !state.clientEditingMessageId) {
        const key = clientDraftKey(state.clientActiveChatId);
        if (textarea.value.trim()) state.clientDrafts[key] = textarea.value;
        else delete state.clientDrafts[key];
      }
      state.chatSelectionVersion = (state.chatSelectionVersion || 0) + 1;
      if (state.clientSelectedInstance) {
        state.clientDraftsByAccount[state.clientSelectedInstance] = state.clientDrafts;
      }
      state.clientSelectedInstance = clientAccountSelect.value;
      state.clientDrafts = state.clientDraftsByAccount[state.clientSelectedInstance] || {};
      state.clientDraftsByAccount[state.clientSelectedInstance] = state.clientDrafts;
      state.clientActiveChatId = null;
      state.clientActiveDialog = null;
      if (typeof clearTelegramChatAppearance === 'function') clearTelegramChatAppearance();
      state.clientSavedReactionFilter = null;
      state.clientMessageEffectId = null;
      const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
      document.getElementById('modal-saved-message-tags')?.classList.remove('active');
      if (document.getElementById('saved-message-tags-bar')) document.getElementById('saved-message-tags-bar').hidden = true;
      const quickReplyButton = document.getElementById('btn-chat-quick-replies');
      if (quickReplyButton) quickReplyButton.hidden = true;
      window.CloudDrafts?.updateStatus();
      state.clientMessages = [];
      state.clientHistoryOffsetDate = null;
      updateClientHistoryBanner();
      state.clientDialogs = [];
      state.clientReplyingTo = null;
      if (state.typingTimer) clearTimeout(state.typingTimer);
      state.typingTimer = null;
      cancelReplyBanner();
      cancelEditBanner();
      clearStagedAttachment();
      if (textarea) { textarea.value = ''; autoResizeTextarea(textarea); }
      document.getElementById('client-chat-title').textContent = '请选择左侧会话';
      document.getElementById('client-chat-subtitle').textContent = '';
      document.getElementById('client-chat-actions').style.display = 'none';
      const avatarImg = document.getElementById('client-chat-avatar-img');
      scheduler.cancelImage(avatarImg);
      avatarImg.removeAttribute('src');
      avatarImg.style.opacity = '0';
      document.getElementById('client-chat-avatar').style.display = 'flex';
      document.getElementById('client-chat-avatar').textContent = 'TG';
      document.getElementById('client-messages-container').innerHTML = '<div class="chat-placeholder"><p>请选择会话</p></div>';
      const drawer = document.getElementById('client-drawer');
      if (drawer) { drawer.classList.remove('open'); drawer.style.display = 'none'; }
      document.querySelector('.client-layout')?.classList.remove('in-chat');
      updateClientAccountBadge();
      reloadClientExpressionsIfOpen();
      window.SettingsPage?.refresh();
      startClientDialogSearch();
      window.DialogFolders?.load();
      loadClientDialogs();
      void loadClientStoriesFeed(true);
    };
  }
  initClientAccountPicker();

  // Mobile Back to Dialogs Button
  const btnClientBack = document.getElementById('btn-client-back-dialogs');
  if (btnClientBack) {
    btnClientBack.onclick = () => {
      document.querySelector('.client-layout')?.classList.remove('in-chat');
    };
  }

  // Client Right Drawer Toggle & Tabs
  const btnToggleDrawer = document.getElementById('btn-chat-drawer-toggle');
  const btnCloseDrawer = document.getElementById('btn-close-drawer');
  const clientDrawer = document.getElementById('client-drawer');
  document.getElementById('btn-profile-stories-archive')?.addEventListener('click', toggleStoryArchive);
  document.getElementById('btn-profile-stories-archive-back')?.addEventListener('click', () => toggleStoryArchive(false));
  document.getElementById('btn-profile-stories-archive-more')?.addEventListener('click', () => { void loadStoryArchive(false); });
  document.getElementById('profile-story-album-filter')?.addEventListener('change', () => { void selectStoryAlbumFilter(); });
  document.getElementById('profile-story-album-target')?.addEventListener('change', () => { if (storyArchiveState) renderStoryAlbumControls(storyArchiveState); });
  document.getElementById('profile-story-albums-select')?.addEventListener('change', () => { void selectPeerStoryAlbum(); });
  document.getElementById('btn-profile-story-albums-more')?.addEventListener('click', () => { void loadPeerStoryAlbumStories(true); });
  document.getElementById('btn-create-story-album')?.addEventListener('click', () => { void createArchivedStoryAlbum(); });
  document.getElementById('btn-rename-story-album')?.addEventListener('click', () => { void renameArchivedStoryAlbum(); });
  document.getElementById('btn-delete-story-album')?.addEventListener('click', () => { void deleteArchivedStoryAlbum(); });
  document.getElementById('btn-move-story-album-up')?.addEventListener('click', () => { void moveArchivedStoryAlbum(-1); });
  document.getElementById('btn-move-story-album-down')?.addEventListener('click', () => { void moveArchivedStoryAlbum(1); });
  document.getElementById('btn-add-stories-to-album')?.addEventListener('click', () => { void updateArchivedStoryAlbumMembers('add'); });
  document.getElementById('btn-remove-stories-from-album')?.addEventListener('click', () => { void updateArchivedStoryAlbumMembers('remove'); });

  if (btnToggleDrawer) {
    btnToggleDrawer.onclick = () => {
      toggleExpressionDrawer(false);
      clientDrawer?.classList.toggle('open');
      if (clientDrawer?.classList.contains('open')) {
        clientDrawer.style.display = 'flex';
        if (state.clientActiveChatId) loadPeerProfile(state.clientActiveChatId);
      } else {
        clientDrawer.style.display = 'none';
      }
    };
  }
  if (btnCloseDrawer) {
    btnCloseDrawer.onclick = () => {
      clientDrawer?.classList.remove('open');
      clientDrawer.style.display = 'none';
    };
  }

  // Client Expression Drawer Toggle & Tabs (Telegram Desktop PC Style)
  const btnToggleExpr = document.getElementById('btn-chat-expression-toggle');
  const btnCloseExpr = document.getElementById('btn-close-expression-drawer');
  if (btnToggleExpr) btnToggleExpr.onclick = () => toggleExpressionDrawer();
  if (btnCloseExpr) btnCloseExpr.onclick = () => toggleExpressionDrawer(false);

  // Expression Drawer Tabs Switching (Emoji / Stickers / GIFs)
  document.querySelectorAll('#client-expression-drawer .drawer-tab').forEach((tab) => {
    tab.onclick = () => {
      switchExpressionTab(tab.dataset.tab);
    };
  });

  // Emoji Category Switching
  document.querySelectorAll('.emoji-cat-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.emoji-cat-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateEmojiPickerSearch(document.getElementById('emoji-search-input')?.value.trim(), btn.dataset.cat);
    };
  });

  // Emoji Search Input
  const emojiSearch = document.getElementById('emoji-search-input');
  if (emojiSearch) {
    emojiSearch.oninput = () => {
      const activeCat = document.querySelector('.emoji-cat-btn.active')?.dataset.cat || 'smileys';
      updateEmojiPickerSearch(emojiSearch.value.trim(), activeCat);
    };
  }
  document.getElementById('btn-search-custom-emoji')?.addEventListener('click', () => { void searchCustomEmoji(); });

  // Stickers Search Input
  const stickersSearch = document.getElementById('stickers-search-input');
  if (stickersSearch) {
    stickersSearch.oninput = () => {
      stickerSearchRequest++;
      const results = document.getElementById('sticker-search-results');
      const status = document.getElementById('sticker-search-status');
      const searchButton = document.getElementById('btn-search-telegram-stickers');
      if (results) results.replaceChildren();
      if (status) { status.hidden = true; status.textContent = ''; }
      if (searchButton) searchButton.disabled = false;
      renderStickerStream();
    };
    stickersSearch.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); void searchTelegramStickers(); }
    };
  }
  document.getElementById('btn-search-telegram-stickers')?.addEventListener('click', () => void searchTelegramStickers());

  const gifSearchInput = document.getElementById('gif-search-input');
  if (gifSearchInput) {
    gifSearchInput.oninput = () => queueClientGifSearch();
    gifSearchInput.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); void loadClientGifSearch(true); }
    };
  }
  document.getElementById('btn-more-gif-search')?.addEventListener('click', () => { void loadClientGifSearch(false); });

  // Markdown Formatting Toolbar Buttons
  document.querySelectorAll('.fmt-btn').forEach((btn) => {
    btn.onclick = () => insertMarkdown(btn.dataset.fmt);
  });

  // Direct Clipboard Image Paste & Modal Handlers
  initPasteImageSupport();
  const btnClosePaste = document.getElementById('btn-paste-image-close');
  const btnCancelPaste = document.getElementById('btn-paste-image-cancel');
  const btnSendPaste = document.getElementById('btn-paste-image-send');
  if (btnClosePaste) btnClosePaste.onclick = closePasteImageModal;
  if (btnCancelPaste) btnCancelPaste.onclick = closePasteImageModal;
  if (btnSendPaste) btnSendPaste.onclick = sendPastedImage;

  const captionEl = document.getElementById('paste-image-caption');
  if (captionEl) {
    captionEl.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendPastedImage();
      }
    };
  }

  // Sticker Pack Modal Handlers
  const btnClosePack = document.getElementById('btn-sticker-pack-close');
  const btnActionPack = document.getElementById('btn-sticker-pack-action');
  if (btnClosePack) btnClosePack.onclick = closeStickerPackModal;
  if (btnActionPack) btnActionPack.onclick = toggleInstallStickerPack;

  // Drawer Tabs Switching (Profile / Media / Tools)
  document.querySelectorAll('#client-drawer .drawer-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('#client-drawer .drawer-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.dataset.tab;
      const pPane = document.getElementById('drawer-tab-profile');
      const mbPane = document.getElementById('drawer-tab-members');
      const mPane = document.getElementById('drawer-tab-media');
      const tPane = document.getElementById('drawer-tab-tools');
      if (pPane) pPane.style.display = tabName === 'profile' ? 'block' : 'none';
      if (mbPane) mbPane.style.display = tabName === 'members' ? 'flex' : 'none';
      if (mPane) mPane.style.display = tabName === 'media' ? 'block' : 'none';
      if (tPane) tPane.style.display = tabName === 'tools' ? 'block' : 'none';
      if (tabName === 'media') {
        loadSharedMedia(state.sharedMediaTab || 'photos');
      } else if (tabName === 'members') {
        loadGroupMembers(state.clientActiveChatId);
      }
    };
  });

  // Profile Hero Photo Slider Controls
  const btnPhotoPrev = document.getElementById('btn-profile-photo-prev');
  const btnPhotoNext = document.getElementById('btn-profile-photo-next');
  if (btnPhotoPrev) {
    btnPhotoPrev.onclick = () => {
      if (state.profilePhotos.length <= 1) return;
      state.currentPhotoIndex = (state.currentPhotoIndex - 1 + state.profilePhotos.length) % state.profilePhotos.length;
      updateHeroPhotoDisplay(state.currentProfileChatId);
    };
  }
  if (btnPhotoNext) {
    btnPhotoNext.onclick = () => {
      if (state.profilePhotos.length <= 1) return;
      state.currentPhotoIndex = (state.currentPhotoIndex + 1) % state.profilePhotos.length;
      updateHeroPhotoDisplay(state.currentProfileChatId);
    };
  }

  // Shared Media Subtabs
  document.querySelectorAll('.shared-subtab').forEach((subtab) => {
    subtab.onclick = () => {
      loadSharedMedia(subtab.dataset.type);
    };
  });

  // In-Chat Search Bar Toggle & Input
  const btnSearchToggle = document.getElementById('btn-chat-search-toggle');
  const btnSearchClose = document.getElementById('btn-chat-search-close');
  const chatSearchInput = document.getElementById('chat-search-input');
  const chatSearchFilter = document.getElementById('chat-search-filter');
  const chatHeaderOverflow = document.querySelector('.chat-header-overflow');
  const chatHeaderOverflowMenu = chatHeaderOverflow?.querySelector('.chat-header-overflow-menu');
  chatHeaderOverflowMenu?.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) chatHeaderOverflow.open = false;
  });
  document.addEventListener('click', (event) => {
    if (chatHeaderOverflow?.open && event.target instanceof Node && !chatHeaderOverflow.contains(event.target)) {
      chatHeaderOverflow.open = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && chatHeaderOverflow?.open) {
      chatHeaderOverflow.open = false;
      chatHeaderOverflow.querySelector('summary')?.focus();
    }
  });
  if (btnSearchToggle) btnSearchToggle.onclick = () => toggleChatSearchBar();
  if (btnSearchClose) btnSearchClose.onclick = () => toggleChatSearchBar(false);
  if (chatSearchInput) {
    chatSearchInput.oninput = () => {
      clientSearchRequest++;
      state.clientSearchQuery = chatSearchInput.value.toLowerCase().trim();
      state.searchMatchIds = [];
      state.searchMatchIdx = -1;
      const stats = document.getElementById('chat-search-stats');
      const previous = document.getElementById('btn-chat-search-prev');
      const next = document.getElementById('btn-chat-search-next');
      if (stats) stats.style.display = 'none';
      if (previous) previous.style.display = 'none';
      if (next) next.style.display = 'none';
      renderClientMessages();
    };
    chatSearchInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeChatServerSearch(chatSearchInput.value.trim());
      }
    };
  }
  if (chatSearchFilter) chatSearchFilter.onchange = () => {
    state.clientSearchFilter = chatSearchFilter.value;
    clientSearchRequest++;
    state.searchMatchIds = [];
    state.searchMatchIdx = -1;
    const query = chatSearchInput?.value.trim() || '';
    if (query || chatSearchFilter.value) executeChatServerSearch(query);
    else renderClientMessages();
  };

  const btnSearchPrev = document.getElementById('btn-chat-search-prev');
  if (btnSearchPrev) btnSearchPrev.onclick = () => navigateSearchMatch('prev');
  const btnSearchNext = document.getElementById('btn-chat-search-next');
  if (btnSearchNext) btnSearchNext.onclick = () => navigateSearchMatch('next');

  // Cancel Replying Banner
  const btnCancelReply = document.getElementById('btn-cancel-reply');
  if (btnCancelReply) btnCancelReply.onclick = () => { cancelReplyBanner(); notifyCurrentDraftChanged(); };

  // Close Pinned Bar
  const btnPinnedClose = document.getElementById('btn-pinned-close');
  if (btnPinnedClose) {
    btnPinnedClose.onclick = () => {
      document.getElementById('chat-pinned-bar').style.display = 'none';
    };
  }

  // Multi-Selection Bar Buttons
  const btnCancelSelection = document.getElementById('btn-cancel-selection');
  if (btnCancelSelection) btnCancelSelection.onclick = () => exitSelectionMode();
  const btnSelForward = document.getElementById('btn-selection-forward');
  if (btnSelForward) btnSelForward.onclick = () => openForwardModal(Array.from(state.selectedMsgIds));
  const btnSelDelete = document.getElementById('btn-selection-delete');
  if (btnSelDelete) {
    btnSelDelete.onclick = async () => {
      if (state.selectedMsgIds.size === 0) return;
      if (!confirm(`确定撤回/删除选中的 ${state.selectedMsgIds.size} 条消息吗？`)) return;
      const ids = Array.from(state.selectedMsgIds);
      const instId = state.clientSelectedInstance;
      const chatId = state.clientActiveChatId;
      const selectionVersion = state.chatSelectionVersion;
      try {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('delete_messages', { instId, chatId, messageIds: ids });
        } else {
          await api(`/api/instances/${instId}/account/delete-messages`, 'POST', { chatId, messageIds: ids });
        }
        showToast(`已删除 ${ids.length} 条消息`, 'success');
        if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId) || state.chatSelectionVersion !== selectionVersion) return;
        const idSet = new Set(ids.map(String));
        state.clientMessages = state.clientMessages.filter((m) => !idSet.has(String(m.id)));
        exitSelectionMode();
        renderClientMessages(true);
      } catch (err) {
        showToast(`删除失败: ${err.message}`, 'error');
      }
    };
  }

  // Forward Modal Close & Search
  const btnCloseForward = document.getElementById('btn-close-forward-modal');
  if (btnCloseForward) btnCloseForward.onclick = () => closeForwardModal();
  const forwardSearch = document.getElementById('forward-dialogs-search');
  if (forwardSearch) {
    forwardSearch.oninput = (e) => renderForwardDialogsList(e.target.value);
  }

  // Voice Recording Buttons (cancel/send within the recording bar)
  const btnCancelVoice = document.getElementById('btn-cancel-voice-rec');
  if (btnCancelVoice) btnCancelVoice.onclick = () => stopVoiceRecording(false);
  const btnSendVoice = document.getElementById('btn-send-voice-rec');
  if (btnSendVoice) btnSendVoice.onclick = () => stopVoiceRecording(true);
  const btnRecordVideoNote = document.getElementById('btn-chat-video-note');
  if (btnRecordVideoNote) btnRecordVideoNote.onclick = () => { void startVideoNoteRecording(); };
  const btnCancelVideoNote = document.getElementById('btn-cancel-video-rec');
  if (btnCancelVideoNote) btnCancelVideoNote.onclick = () => { void stopVideoNoteRecording(false); };
  const btnFinishVideoNote = document.getElementById('btn-finish-video-rec');
  if (btnFinishVideoNote) btnFinishVideoNote.onclick = () => { void stopVideoNoteRecording(true); };

  // Infinite scroll cursor pagination for client messages
  const dialogContainer = document.getElementById('client-dialogs-list');
  if (dialogContainer) {
    dialogContainer.addEventListener('scroll', () => {
      if (dialogContainer.scrollTop + dialogContainer.clientHeight >= dialogContainer.scrollHeight - 100) {
        loadClientDialogs(true);
      }
    }, { passive: true });
  }
  const msgContainer = document.getElementById('client-messages-container');
  const returnLatest = document.getElementById('btn-chat-return-latest');
  if (returnLatest) returnLatest.onclick = returnToLatestMessages;
  if (msgContainer) {
    let scrollThrottleTimer = null;
    msgContainer.addEventListener('scroll', () => {
      if (scrollThrottleTimer) return;
      scrollThrottleTimer = setTimeout(() => {
        scrollThrottleTimer = null;
        if (msgContainer.scrollTop < 60 && !isLoadingEarlierMessages && !hasReachedEarliestMessage) {
          loadEarlierMessages();
        }
      }, 150);
    }, { passive: true });
  }

  // Attachment Button & File Input
  // Fullscreen Photo Lightbox Controls
  const btnLightboxPrev = document.getElementById('btn-lightbox-prev');
  if (btnLightboxPrev) btnLightboxPrev.onclick = (e) => { e.stopPropagation(); navigateLightbox('prev'); };
  const btnLightboxNext = document.getElementById('btn-lightbox-next');
  if (btnLightboxNext) btnLightboxNext.onclick = (e) => { e.stopPropagation(); navigateLightbox('next'); };
  const btnLightboxRotate = document.getElementById('btn-lightbox-rotate');
  if (btnLightboxRotate) {
    btnLightboxRotate.onclick = () => {
      lightboxRotation = (lightboxRotation + 90) % 360;
      const img = document.getElementById('lightbox-img');
      if (img) img.style.transform = `scale(1) rotate(${lightboxRotation}deg)`;
    };
  }
  const btnLightboxClose = document.getElementById('btn-lightbox-close');
  if (btnLightboxClose) btnLightboxClose.onclick = () => closeLightbox();
  const lightboxModal = document.getElementById('modal-lightbox');
  if (lightboxModal) {
    lightboxModal.onclick = (e) => {
      if (e.target === lightboxModal || e.target.id === 'lightbox-content') {
        closeLightbox();
      }
    };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
    const modal = document.getElementById('modal-lightbox');
    if (modal && modal.classList.contains('active')) {
      if (e.key === 'ArrowLeft') navigateLightbox('prev');
      else if (e.key === 'ArrowRight') navigateLightbox('next');
    }
  });

  // Global Music Player Setup
  initMusicPlayer();

  // Cinema Video Player Setup
  cinemaVideoPlayer.init();

  // Phase 4: Jump to Date & Schedule Message Setup
  initJumpToDate();
  initScheduleMessage();

  document.getElementById('member-search-input')?.addEventListener('input', () => {
    if (groupMemberSearchTimer) clearTimeout(groupMemberSearchTimer);
    groupMemberSearchTimer = setTimeout(() => {
      groupMemberSearchTimer = null;
      void loadGroupMembers(state.clientActiveChatId);
    }, 300);
  });
  document.getElementById('btn-add-group-members')?.addEventListener('click', openGroupInviteModal);
  document.getElementById('btn-close-group-invite')?.addEventListener('click', closeGroupInviteModal);
  document.getElementById('btn-cancel-group-invite')?.addEventListener('click', closeGroupInviteModal);
  document.getElementById('btn-add-selected-group-members')?.addEventListener('click', () => { void inviteSelectedGroupMembers(); });
  document.getElementById('group-invite-search')?.addEventListener('input', () => {
    if (groupInviteSearchTimer) clearTimeout(groupInviteSearchTimer);
    groupInviteSearchTimer = setTimeout(() => {
      groupInviteSearchTimer = null;
      void searchGroupInviteCandidates(document.getElementById('group-invite-search')?.value || '');
    }, 300);
  });
  const groupInviteModal = document.getElementById('modal-add-group-members');
  if (groupInviteModal) groupInviteModal.addEventListener('click', event => {
    if (event.target === groupInviteModal) closeGroupInviteModal();
  });
  document.getElementById('btn-close-group-member-mute')?.addEventListener('click', closeGroupMuteModal);
  document.getElementById('btn-cancel-group-member-mute')?.addEventListener('click', closeGroupMuteModal);
  document.getElementById('form-group-member-mute')?.addEventListener('submit', saveGroupMute);
  const groupMemberMuteModal = document.getElementById('modal-group-member-mute');
  if (groupMemberMuteModal) groupMemberMuteModal.addEventListener('click', event => {
    if (event.target === groupMemberMuteModal) closeGroupMuteModal();
  });
  document.getElementById('btn-refresh-members')?.addEventListener('click', () => loadGroupMembers(state.clientActiveChatId));
  const membersList = document.getElementById('members-list-container');
  membersList?.addEventListener('click', event => {
    if (event.target.closest('.member-menu-action')) {
      const menu = event.target.closest('.member-actions-menu');
      if (menu) menu.open = false;
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.member-actions-menu, .members-toolbar-menu')) return;
    document.querySelectorAll('.member-actions-menu[open], .members-toolbar-menu[open]').forEach(menu => { menu.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = document.querySelector('.member-actions-menu[open], .members-toolbar-menu[open]');
    if (!menu) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
  document.getElementById('btn-view-join-requests')?.addEventListener('click', openJoinRequestsModal);
  document.getElementById('btn-view-banned-members')?.addEventListener('click', openBannedMembersModal);
  document.getElementById('btn-view-invite-links')?.addEventListener('click', openInviteLinksModal);
  document.getElementById('btn-edit-group-info')?.addEventListener('click', openGroupInfoModal);
  document.getElementById('btn-change-group-photo')?.addEventListener('click', () => document.getElementById('group-photo-file')?.click());
  document.getElementById('group-photo-file')?.addEventListener('change', event => { void uploadGroupPhoto(event); });
  const groupInfoModal = document.getElementById('modal-group-info');
  document.getElementById('btn-close-group-info')?.addEventListener('click', closeGroupInfoModal);
  document.getElementById('btn-cancel-group-info')?.addEventListener('click', closeGroupInfoModal);
  document.getElementById('form-group-info')?.addEventListener('submit', saveGroupInfo);
  if (groupInfoModal) groupInfoModal.addEventListener('click', (event) => {
    if (event.target === groupInfoModal) closeGroupInfoModal();
  });
  document.getElementById('btn-edit-chat-permissions')?.addEventListener('click', openChatPermissionsModal);
  const chatPermissionsModal = document.getElementById('modal-chat-permissions');
  document.getElementById('btn-close-chat-permissions')?.addEventListener('click', closeChatPermissionsModal);
  document.getElementById('btn-cancel-chat-permissions')?.addEventListener('click', closeChatPermissionsModal);
  document.getElementById('form-chat-permissions')?.addEventListener('submit', saveChatPermissions);
  if (chatPermissionsModal) chatPermissionsModal.addEventListener('click', (event) => {
    if (event.target === chatPermissionsModal) closeChatPermissionsModal();
  });
  const joinRequestsModal = document.getElementById('modal-join-requests');
  document.getElementById('btn-close-join-requests')?.addEventListener('click', closeJoinRequestsModal);
  document.getElementById('btn-cancel-join-requests')?.addEventListener('click', closeJoinRequestsModal);
  document.getElementById('btn-more-join-requests')?.addEventListener('click', () => { void loadJoinRequests(false); });
  document.getElementById('btn-approve-all-join-requests')?.addEventListener('click', () => { void decideAllJoinRequests(true); });
  document.getElementById('btn-reject-all-join-requests')?.addEventListener('click', () => { void decideAllJoinRequests(false); });
  document.getElementById('join-request-search')?.addEventListener('input', (event) => {
    if (!joinRequestSession) return;
    joinRequestSession.query = event.target.value.trim();
    updateJoinRequestBulkActions();
    if (joinRequestSearchTimer) clearTimeout(joinRequestSearchTimer);
    joinRequestSearchTimer = setTimeout(() => { joinRequestSearchTimer = null; void loadJoinRequests(true); }, 300);
  });
  if (joinRequestsModal) joinRequestsModal.addEventListener('click', (event) => {
    if (event.target === joinRequestsModal) closeJoinRequestsModal();
  });
  const bannedMembersModal = document.getElementById('modal-banned-members');
  document.getElementById('btn-close-banned-members')?.addEventListener('click', closeBannedMembersModal);
  document.getElementById('btn-cancel-banned-members')?.addEventListener('click', closeBannedMembersModal);
  document.getElementById('btn-more-banned-members')?.addEventListener('click', () => { void loadBannedMembers(false); });
  document.getElementById('banned-member-search')?.addEventListener('input', (event) => {
    if (!bannedMemberSession) return;
    bannedMemberSession.query = event.target.value.trim();
    if (bannedMemberSearchTimer) clearTimeout(bannedMemberSearchTimer);
    bannedMemberSearchTimer = setTimeout(() => { bannedMemberSearchTimer = null; void loadBannedMembers(true); }, 300);
  });
  if (bannedMembersModal) bannedMembersModal.addEventListener('click', (event) => {
    if (event.target === bannedMembersModal) closeBannedMembersModal();
  });
  const inviteLinksModal = document.getElementById('modal-invite-links');
  document.getElementById('btn-close-invite-links')?.addEventListener('click', closeInviteLinksModal);
  document.getElementById('btn-cancel-invite-links')?.addEventListener('click', closeInviteLinksModal);
  document.getElementById('btn-more-invite-links')?.addEventListener('click', () => { void loadInviteLinks(false); });
  document.getElementById('btn-create-invite-link')?.addEventListener('click', () => { void createInviteLink(); });
  if (inviteLinksModal) inviteLinksModal.addEventListener('click', (event) => {
    if (event.target === inviteLinksModal) closeInviteLinksModal();
  });
  const adminRightsModal = document.getElementById('modal-admin-rights');
  document.getElementById('btn-close-admin-rights')?.addEventListener('click', closeGroupAdminRights);
  document.getElementById('btn-cancel-admin-rights')?.addEventListener('click', closeGroupAdminRights);
  if (adminRightsModal) adminRightsModal.addEventListener('click', (event) => {
    if (event.target === adminRightsModal) closeGroupAdminRights();
  });
  document.getElementById('form-admin-rights')?.addEventListener('submit', saveGroupAdminRights);
  document.getElementById('btn-demote-admin-rights')?.addEventListener('click', revokeGroupAdminRights);

  const clientSearchInput = document.getElementById('client-dialogs-search');
  if (clientSearchInput) {
    clientSearchInput.maxLength = 128;
    clientSearchInput.oninput = () => startClientDialogSearch();
  }
  document.getElementById('btn-create-chat')?.addEventListener('click', openCreateChatModal);
  document.getElementById('btn-close-create-chat')?.addEventListener('click', closeCreateChatModal);
  document.getElementById('btn-cancel-create-chat')?.addEventListener('click', closeCreateChatModal);
  document.getElementById('form-create-chat')?.addEventListener('submit', createTelegramChat);
  document.getElementById('create-chat-type')?.addEventListener('change', updateCreateChatType);
  document.getElementById('create-chat-name')?.addEventListener('input', updateCreateChatSubmitState);
  document.getElementById('create-chat-member-search')?.addEventListener('input', () => {
    if (createChatSearchTimer) clearTimeout(createChatSearchTimer);
    createChatSearchTimer = setTimeout(() => {
      createChatSearchTimer = null;
      void searchCreateChatCandidates(document.getElementById('create-chat-member-search')?.value || '');
    }, 300);
  });
  const createChatModal = document.getElementById('modal-create-chat');
  if (createChatModal) createChatModal.addEventListener('click', event => {
    if (event.target === createChatModal) closeCreateChatModal();
  });
  document.getElementById('btn-client-stories-refresh')?.addEventListener('click', () => { void loadClientStoriesFeed(true); });
  document.getElementById('btn-client-stories-more')?.addEventListener('click', () => { void loadClientStoriesFeed(false); });
  document.querySelectorAll('[data-story-feed-hidden]').forEach(button => {
    button.addEventListener('click', () => {
      const hidden = button.dataset.storyFeedHidden === '1';
      if (hidden === storyFeedHiddenView) return;
      if (storyViewer?.session?.source === 'feed') closeStoryViewer();
      storyFeedHiddenView = hidden;
      document.querySelectorAll('[data-story-feed-hidden]').forEach(filter => {
        const selected = filter === button;
        filter.classList.toggle('active', selected);
        filter.setAttribute('aria-pressed', String(selected));
      });
      void loadClientStoriesFeed(true);
    });
  });

  document.querySelectorAll('.dialog-tab').forEach((tab) => {
    if (tab.id === 'btn-manage-dialog-folders') return;
    tab.onclick = () => {
      const previousArchive = state.clientDialogFilter === 'archived';
      const previousCustomFolder = String(state.clientDialogFilter || '').startsWith('folder:');
      document.querySelectorAll('.dialog-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.clientDialogFilter = tab.dataset.type;
      if (previousCustomFolder || previousArchive !== (state.clientDialogFilter === 'archived')) {
        state.clientDialogs = [];
        loadClientDialogs();
      } else renderClientDialogs();
    };
  });

  // Morph send/voice button (single button: mic when empty, send when text)
  const btnMorph = document.getElementById('btn-chat-morph');
  const msgTextarea = document.getElementById('client-message-textarea');
  if (btnMorph && msgTextarea) {
    // Toggle morph state based on input
    const updateMorphState = () => {
      const hasText = msgTextarea.value.trim().length > 0 || state.clientStagedFile;
      btnMorph.classList.toggle('has-text', Boolean(hasText));
      btnMorph.title = hasText ? '发送消息' : '录制语音消息';
    };
    msgTextarea.addEventListener('input', updateMorphState);
    // Also watch for staged file changes
    setInterval(updateMorphState, 500); // lightweight poll for staged file

    btnMorph.onclick = () => {
      const hasText = msgTextarea.value.trim().length > 0 || state.clientStagedFile;
      if (hasText) {
        sendClientMessage();
      } else {
        startVoiceRecording();
      }
    };
  }

  if (msgTextarea) {
    msgTextarea.onkeydown = (e) => {
      // 1. Chinese IME composition guard
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

      if (e.key === 'Escape' && hideQuickReplySuggestions()) {
        e.preventDefault();
        return;
      }
      const suggestions = document.getElementById('quick-reply-suggestions');
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && suggestions && !suggestions.hidden) {
        const firstSuggestion = suggestions.querySelector('button');
        if (firstSuggestion) {
          e.preventDefault();
          firstSuggestion.click();
          return;
        }
      }

      // 2. Formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+K)
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'b') {
          e.preventDefault();
          insertMarkdown('bold');
          return;
        } else if (key === 'i') {
          e.preventDefault();
          insertMarkdown('italic');
          return;
        } else if (key === 'u') {
          e.preventDefault();
          insertMarkdown('underline');
          return;
        } else if (key === 'k') {
          e.preventDefault();
          openInsertLinkModal();
          return;
        }
      }

      // 3. Escape key to cancel reply quote
      if (e.key === 'Escape') {
        if (state.clientReplyingTo) {
          e.preventDefault();
          cancelReplyBanner();
          notifyCurrentDraftChanged();
          return;
        }
      }

      // 4. Send logic according to send mode
      const sendMode = state.chatSendKeyMode || 'enter';
      if (sendMode === 'ctrlEnter') {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendClientMessage();
        }
      } else {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          sendClientMessage();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendClientMessage();
        }
      }
    };

    msgTextarea.oninput = () => {
      autoResizeTextarea(msgTextarea);
      triggerAutoTyping();
      void updateQuickReplySuggestions(msgTextarea);
      if (state.clientActiveChatId && !state.clientEditingMessageId) {
        window.CloudDrafts?.changed(state.clientSelectedInstance, state.clientActiveChatId, msgTextarea.value, state.clientReplyingTo?.id);
        state.clientDrafts = state.clientDrafts || {};
        if (msgTextarea.value.trim()) {
          state.clientDrafts[clientDraftKey(state.clientActiveChatId)] = msgTextarea.value;
        } else {
          delete state.clientDrafts[clientDraftKey(state.clientActiveChatId)];
        }
        renderClientDialogs();
      }
    };
  }

  const sendModeSel = document.getElementById('client-input-sendmode');
  if (sendModeSel) {
    sendModeSel.value = state.chatSendKeyMode || 'enter';
    sendModeSel.onchange = () => {
      state.chatSendKeyMode = sendModeSel.value;
      localStorage.setItem('tgbot_chat_send_mode', sendModeSel.value);
      updateChatSendHint();
    };
  }
  updateChatSendHint();
  initChatDragAndDrop();
  initSwipeToReply();
  initChatContextMenu();

  const btnInsertLinkClose = document.getElementById('btn-insert-link-close');
  const btnInsertLinkCancel = document.getElementById('btn-insert-link-cancel');
  const btnInsertLinkConfirm = document.getElementById('btn-insert-link-confirm');
  if (btnInsertLinkClose) btnInsertLinkClose.onclick = closeInsertLinkModal;
  if (btnInsertLinkCancel) btnInsertLinkCancel.onclick = closeInsertLinkModal;
  if (btnInsertLinkConfirm) btnInsertLinkConfirm.onclick = confirmInsertLink;
  const linkUrlInput = document.getElementById('link-url-input');
  if (linkUrlInput) {
    linkUrlInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmInsertLink();
      }
    };
  }

  const btnRefreshDialogs = document.getElementById('btn-client-refresh-dialogs');
  if (btnRefreshDialogs) btnRefreshDialogs.onclick = () => loadClientDialogs();

  const btnChatTyping = document.getElementById('btn-chat-typing');
  if (btnChatTyping) btnChatTyping.onclick = () => quickSendTyping();

  const btnChatPurge = document.getElementById('btn-chat-purge');
  if (btnChatPurge) btnChatPurge.onclick = () => quickPurge(15);

  const btnChatLeave = document.getElementById('btn-chat-leave');
  if (btnChatLeave) btnChatLeave.onclick = () => quickLeaveChat();

  document.querySelectorAll('.btn-quick-purge').forEach((btn) => {
    btn.onclick = () => quickPurge(Number(btn.dataset.count) || 10);
  });

  const btnQuickOnline = document.getElementById('btn-quick-online');
  if (btnQuickOnline) btnQuickOnline.onclick = () => quickToggleOnline(true);

  const btnQuickOffline = document.getElementById('btn-quick-offline');
  if (btnQuickOffline) btnQuickOffline.onclick = () => quickToggleOnline(false);

  const btnQuickTyping = document.getElementById('btn-quick-typing');
  if (btnQuickTyping) btnQuickTyping.onclick = () => quickSendTyping();

  const btnToggleOnlineHeader = document.getElementById('btn-client-toggle-online');
  if (btnToggleOnlineHeader) {
    btnToggleOnlineHeader.onclick = () => {
      const isOnline = document.getElementById('client-online-text')?.innerText?.includes('隐身');
      quickToggleOnline(!isOnline);
    };
  }

  const btnToolLookup = document.getElementById('btn-tool-lookup');
  if (btnToolLookup) btnToolLookup.onclick = () => doPeerLookup();

  // Profile Modal
  const btnOpenProfile = document.getElementById('btn-client-open-profile');
  if (btnOpenProfile) btnOpenProfile.onclick = () => openProfileModal();
  document.getElementById('btn-close-profile').onclick = closeProfileModal;
  document.getElementById('btn-cancel-profile').onclick = closeProfileModal;
  document.getElementById('btn-save-profile').onclick = () => saveProfileModal();
  document.getElementById('btn-profile-emoji-status-clear')?.addEventListener('click', () => {
    const current = profileEmojiStatusState;
    if (current) void saveProfileEmojiStatus(current, null);
  });

  // Broadcast Modal
  const btnOpenBroadcast = document.getElementById('btn-client-open-broadcast');
  if (btnOpenBroadcast) btnOpenBroadcast.onclick = () => openBroadcastModal();
  document.getElementById('btn-close-broadcast').onclick = () => document.getElementById('modal-broadcast').classList.remove('active');
  document.getElementById('btn-cancel-broadcast').onclick = () => document.getElementById('modal-broadcast').classList.remove('active');
  document.getElementById('btn-submit-broadcast').onclick = () => submitBroadcast();
  document.getElementById('btn-broadcast-import-recent').onclick = () => {
    const ids = state.clientDialogs.map((d) => d.id).join('\n');
    document.getElementById('broadcast-input-targets').value = ids;
    showToast(`已导入 ${state.clientDialogs.length} 个最近会话 ID`, 'info');
  };

  // Scheduler View Listeners
  const schedulerAccountSelect = document.getElementById('scheduler-account-select');
  if (schedulerAccountSelect) {
    schedulerAccountSelect.onchange = () => {
      state.schedulerSelectedInstance = schedulerAccountSelect.value;
      loadScheduledTasks();
    };
  }

  const btnOpenCreateSched = document.getElementById('btn-open-create-schedule');
  if (btnOpenCreateSched) btnOpenCreateSched.onclick = () => openCreateScheduleModal();

  const btnRefreshSched = document.getElementById('btn-refresh-schedules');
  if (btnRefreshSched) btnRefreshSched.onclick = () => loadScheduledTasks();

  document.getElementById('btn-close-create-schedule').onclick = () => document.getElementById('modal-create-schedule').classList.remove('active');
  document.getElementById('btn-cancel-create-schedule').onclick = () => document.getElementById('modal-create-schedule').classList.remove('active');
  document.getElementById('btn-save-create-schedule').onclick = () => saveScheduleTask();

  // Schedule Repeat Mode Cards
  document.querySelectorAll('.repeat-mode-card').forEach((card) => {
    card.onclick = () => {
      document.querySelectorAll('.repeat-mode-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const mode = card.dataset.mode;
      document.getElementById('sched-form-daily').style.display = mode === 'daily' ? 'block' : 'none';
      document.getElementById('sched-form-interval').style.display = mode === 'interval' ? 'block' : 'none';
      document.getElementById('sched-form-once').style.display = mode === 'once' ? 'block' : 'none';
    };
  });

  // Preset Chips
  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll('.preset-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const timeVal = chip.dataset.time;
      const input = document.getElementById('sched-input-daily-time');
      if (input) {
        input.value = timeVal;
        updateDailyLivePreview();
      }
    };
  });

  const dailyTimeInput = document.getElementById('sched-input-daily-time');
  if (dailyTimeInput) {
    dailyTimeInput.oninput = () => updateDailyLivePreview();
  }
}

function filterRenderLogs() {
  el.terminalContainer.innerHTML = '';
  for (const entry of state.logs) {
    appendLog(entry);
  }
}

// ==========================================
// Web Client: Official Client-like Account Operations
// ==========================================
function initClientAccountPicker() {
  const wrapper = document.getElementById('client-account-picker');
  const trigger = document.getElementById('client-account-picker-trigger');
  const menu = document.getElementById('client-account-picker-menu');
  const select = document.getElementById('client-account-select');
  if (!wrapper || !trigger || !menu || !select || wrapper.dataset.initialized === 'true') return;
  wrapper.dataset.initialized = 'true';

  const close = (restoreFocus = false) => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  trigger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) (menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role="option"]'))?.focus();
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('[role="option"][data-value]');
    if (!option) return;
    if (select.value !== option.dataset.value) {
      select.value = option.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close(true);
  });
  menu.addEventListener('keydown', event => {
    const options = Array.from(menu.querySelectorAll('[role="option"]'));
    if (!options.length) return;
    const current = options.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = (current + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (current <= 0 ? options.length : current) - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next !== null) {
      event.preventDefault();
      options[next].focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!wrapper.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) close(true);
  });
  updateClientAccountPicker();
}

function updateClientAccountPicker() {
  const trigger = document.getElementById('client-account-picker-trigger');
  const label = document.getElementById('client-account-picker-label');
  const statusDot = document.getElementById('client-account-picker-status');
  const menu = document.getElementById('client-account-picker-menu');
  if (!trigger || !label || !statusDot || !menu) return;

  const instances = Array.isArray(state.instances) ? state.instances : [];
  const selected = instances.find(instance => instance.config?.id === state.clientSelectedInstance);
  trigger.disabled = instances.length === 0;
  label.textContent = selected?.config?.name || (instances.length ? '选择账号' : '无可用实例');
  const selectedState = selected?.status === 'ONLINE' ? '在线' : (selected?.status || '离线');
  trigger.title = selected ? `${selected.config.name} (${selected.config.id}) · ${selectedState}` : '无可用实例';
  trigger.setAttribute('aria-label', selected ? `切换账号，当前 ${selected.config.name}，${selectedState}` : '无可用实例');
  statusDot.className = `client-account-picker-status status-dot ${selected?.status === 'ONLINE' ? 'running' : 'stopped'}`;
  menu.replaceChildren();

  instances.forEach((instance, index) => {
    const id = String(instance.config?.id || '');
    const name = String(instance.config?.name || id || 'Telegram');
    const online = instance.status === 'ONLINE';
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'client-account-picker-option';
    option.dataset.value = id;
    option.id = `client-account-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(id === state.clientSelectedInstance));

    const dot = document.createElement('span');
    dot.className = `status-dot ${online ? 'running' : 'stopped'}`;
    const copy = document.createElement('span');
    copy.className = 'client-account-picker-copy';
    const title = document.createElement('span');
    title.className = 'client-account-picker-name';
    title.textContent = name;
    const secondary = document.createElement('span');
    secondary.className = 'client-account-picker-id';
    secondary.textContent = id;
    copy.append(title, secondary);
    const stateLabel = document.createElement('span');
    stateLabel.className = 'client-account-picker-state';
    stateLabel.textContent = online ? '在线' : (instance.status || '离线');
    option.append(dot, copy, stateLabel);
    menu.appendChild(option);
  });
}

async function initClientView() {
  const select = document.getElementById('client-account-select');
  if (!select) return;
  select.innerHTML = '';

  if (state.instances.length === 0) {
    resetClientExpressions();
    if (state.clientSelectedInstance) clearLoggedOutAccountState(state.clientSelectedInstance);
    state.clientSelectedInstance = null;
    select.innerHTML = '<option value="">无可用实例</option>';
    document.getElementById('client-account-name').innerText = '暂无实例';
    updateClientAccountPicker();
    startClientDialogSearch();
    window.DialogFolders?.load();
    window.GlobalMessageSearch?.reset();
    void loadClientStoriesFeed(true);
    return;
  }

  for (const inst of state.instances) {
    const opt = document.createElement('option');
    opt.value = inst.config.id;
    const isOnline = inst.status === 'ONLINE';
    opt.innerText = `${inst.config.name} (${inst.config.id}) [${isOnline ? '在线' : inst.status}]`;
    select.appendChild(opt);
  }

  if (!state.clientSelectedInstance || !state.instances.find((i) => i.config.id === state.clientSelectedInstance)) {
    const onlineOne = state.instances.find((i) => i.status === 'ONLINE');
    resetClientExpressions();
    if (state.clientSelectedInstance) clearLoggedOutAccountState(state.clientSelectedInstance);
    state.clientSelectedInstance = onlineOne ? onlineOne.config.id : state.instances[0].config.id;
    startClientDialogSearch();
    window.GlobalMessageSearch?.reset();
    reloadClientExpressionsIfOpen();
  }
  select.value = state.clientSelectedInstance;

  updateClientAccountBadge();
  window.DialogFolders?.load();
  await loadClientDialogs();
  void loadClientStoriesFeed(true);
}

function updateClientAccountBadge() {
  updateClientAccountPicker();
  const inst = state.instances.find((i) => i.config.id === state.clientSelectedInstance);
  const badgeDot = document.querySelector('#client-account-badge .status-dot');
  const badgeName = document.getElementById('client-account-name');
  if (inst && badgeDot && badgeName) {
    const isOnline = inst.status === 'ONLINE';
    badgeDot.className = `status-dot ${isOnline ? 'running' : 'stopped'}`;
    const selfName = inst.self?.firstName || inst.self?.username || inst.config.name;
    badgeName.innerText = `${selfName} (${inst.status})`;
  }
}

let botMenuButtonRequest = 0;
async function loadBotMenuButton(instId, dialog, selectionVersion) {
  const button = document.getElementById('btn-chat-bot-menu');
  if (!button) return;
  const request = ++botMenuButtonRequest;
  button.hidden = true;
  button.textContent = '菜单';
  button.removeAttribute?.('title');
  if (!instId || !dialog || dialog.type !== 'bot') return;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/mini-app/menu?chatId=${encodeURIComponent(dialog.id)}`);
    if (request !== botMenuButtonRequest || state.clientSelectedInstance !== instId ||
        String(state.clientActiveChatId) !== String(dialog.id) || state.chatSelectionVersion !== selectionVersion) return;
    if (result?.available === true) {
      const text = typeof result.text === 'string' ? result.text.trim().slice(0, 64) : '';
      button.textContent = text || '菜单';
      if (text) button.title = text;
      button.hidden = false;
    }
  } catch { /* A menu is optional; a failed lookup leaves the button hidden. */ }
}

let clientDialogsRequest = 0;
const clientDialogsPageSize = 50;
let clientDialogsCursor = null;
let clientDialogsHasMore = false;
let clientDialogsLoadingMore = false;
// A Telegram custom folder is a filter over both physical dialog folders.
// Scan them independently; a null cursor is valid when starting the archive.
let clientCustomFolderStage = 0;
let clientCustomFolderIncomplete = false;
let clientCustomFolderExplicitIncomplete = false;
let clientDialogSearchTimer = null;
let clientDialogSearchVersion = 0;
let clientDialogRemoteSearch = { instId: null, query: '', results: [], loading: false, error: false };

function startClientDialogSearch() {
  const input = document.getElementById('client-dialogs-search');
  const query = (input?.value || '').trim();
  const instId = state.clientSelectedInstance;
  const version = ++clientDialogSearchVersion;
  if (clientDialogSearchTimer) clearTimeout(clientDialogSearchTimer);
  clientDialogSearchTimer = null;
  clientDialogRemoteSearch = { instId, query: query.toLowerCase(), results: [], loading: Boolean(query && instId), error: false };
  renderClientDialogs();
  if (!query || !instId) return;
  clientDialogSearchTimer = setTimeout(async () => {
    clientDialogSearchTimer = null;
    try {
      let results;
      if (window.chatWs && window.chatWs.isConnected()) {
        try { results = await window.chatWs.sendRpc('search_dialogs', { instId, query }); } catch (_) { /* use HTTP */ }
      }
      if (!results) results = await api(`/api/instances/${encodeURIComponent(instId)}/account/search-dialogs?query=${encodeURIComponent(query)}`);
      if (version !== clientDialogSearchVersion || state.clientSelectedInstance !== instId) return;
      clientDialogRemoteSearch = { instId, query: query.toLowerCase(), results: Array.isArray(results) ? results : [], loading: false, error: false };
    } catch (_) {
      if (version !== clientDialogSearchVersion || state.clientSelectedInstance !== instId) return;
      clientDialogRemoteSearch = { instId, query: query.toLowerCase(), results: [], loading: false, error: true };
    }
    renderClientDialogs();
  }, 350);
}

function mergeClientDialogSearchResults(query, dialogs, remoteResults) {
  const list = dialogs.filter((d) =>
    (d.title && d.title.toLowerCase().includes(query)) ||
    (d.username && d.username.toLowerCase().includes(query)) || String(d.id).includes(query));
  const loaded = new Map(dialogs.map((d) => [String(d.id), d]));
  const seen = new Set(list.map((d) => String(d.id)));
  for (const remote of remoteResults) {
    const id = String(remote.id);
    if (!seen.has(id)) { list.push(loaded.get(id) || remote); seen.add(id); }
  }
  return list;
}

function clientDraftKey(chatId, instId = state.clientSelectedInstance) {
  return JSON.stringify([instId, String(chatId)]);
}

function notifyCurrentDraftChanged() {
  if (!state.clientSelectedInstance || state.clientActiveChatId == null || state.clientEditingMessageId) return;
  const text = document.getElementById('client-message-textarea')?.value || '';
  if (text.trim()) state.clientDrafts[clientDraftKey(state.clientActiveChatId)] = text;
  else delete state.clientDrafts[clientDraftKey(state.clientActiveChatId)];
  window.CloudDrafts?.changed(state.clientSelectedInstance, state.clientActiveChatId, text, state.clientReplyingTo?.id);
  renderClientDialogs();
}

function dialogListScope(filter) {
  const value = filter || 'all';
  return value.startsWith('folder:') ? value : value === 'archived' ? 'archived' : 'main';
}

async function loadClientDialogs(append = false) {
  if (append && (document.getElementById('client-dialogs-search')?.value || '').trim()) return;
  if (append && (clientDialogsLoadingMore || !clientDialogsHasMore)) return;
  const request = append ? clientDialogsRequest : ++clientDialogsRequest;
  const instId = state.clientSelectedInstance;
  if (!instId) return;
  const filter = state.clientDialogFilter || 'all';
  const scope = dialogListScope(filter);
  const isCustomFolder = filter.startsWith('folder:');
  if (!append) {
    clientDialogsCursor = null;
    clientDialogsHasMore = false;
    clientDialogsLoadingMore = false;
    clientCustomFolderStage = 0;
    clientCustomFolderIncomplete = false;
    clientCustomFolderExplicitIncomplete = false;
  }
  const folderId = isCustomFolder ? clientCustomFolderStage : filter === 'archived' ? 1 : 0;
  const offset = append && clientDialogsCursor ? { ...clientDialogsCursor } : null;

  const inst = state.instances.find((i) => i.config.id === instId);
  const container = document.getElementById('client-dialogs-list');
  if (!container) return;

  if (!inst || inst.status !== 'ONLINE') {
    container.innerHTML = '<div class="empty-state">当前账号未在线，请在“实例托管”中先启动该账号。</div>';
    return;
  }
  if (append) clientDialogsLoadingMore = true;

  if (!append) container.innerHTML = '<div class="empty-state">正在同步 Telegram 会话列表...</div>';

  const ws = window.chatWs;
  const snapshot = ws ? ws.beginDialogSnapshot(instId) : null;
  try {
    let dialogs;
    if (window.chatWs && window.chatWs.isConnected()) {
      try {
        dialogs = await window.chatWs.sendRpc('get_dialogs', { instId, limit: clientDialogsPageSize, offset, folderId });
      } catch (_) {}
    }
    if (!dialogs) {
      const params = new URLSearchParams({ limit: String(clientDialogsPageSize), folderId: String(folderId) });
      if (offset) {
        params.set('offsetPeer', String(offset.peer));
        params.set('offsetId', String(offset.id));
        params.set('offsetDate', String(offset.date));
      }
      dialogs = await api(`/api/instances/${instId}/account/dialogs?${params}`);
    }
    if (request !== clientDialogsRequest || state.clientSelectedInstance !== instId || dialogListScope(state.clientDialogFilter) !== scope) return;
    const pageResult = Array.isArray(dialogs) ? dialogs : [];
    let result = pageResult;
    if (!append && isCustomFolder) {
      const peerIds = window.DialogFolders?.getExplicitPeerIds(filter) || [];
      if (peerIds.length) {
        try {
          let explicit;
          if (window.chatWs && window.chatWs.isConnected()) {
            try { explicit = await window.chatWs.sendRpc('get_explicit_dialogs', { instId, peerIds }); } catch (_) {}
          }
          if (!explicit) explicit = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialogs/explicit?peerIds=${encodeURIComponent(peerIds.join(','))}`);
          if (request !== clientDialogsRequest || state.clientSelectedInstance !== instId || dialogListScope(state.clientDialogFilter) !== scope) return;
          if (!Array.isArray(explicit)) throw new Error('Invalid explicit dialog response');
          const seen = new Set(result.map((dialog) => String(dialog.id)));
          result = [...result, ...explicit.filter((dialog) => !seen.has(String(dialog.id)))];
        } catch (_) {
          if (request !== clientDialogsRequest || state.clientSelectedInstance !== instId || dialogListScope(state.clientDialogFilter) !== scope) return;
          clientCustomFolderExplicitIncomplete = true;
        }
      }
    }
    const last = [...pageResult].reverse().find((dialog) => !dialog.pinned && dialog.id != null && dialog.lastMessageId && dialog.lastMessageDate);
    const cursor = last ? { peer: last.id, id: last.lastMessageId, date: last.lastMessageDate } : null;
    const moved = cursor && (!offset || String(cursor.peer) !== String(offset.peer) || cursor.id !== offset.id || cursor.date !== offset.date);
    clientDialogsCursor = moved ? cursor : null;
    clientDialogsHasMore = pageResult.length === clientDialogsPageSize && Boolean(moved);
    if (isCustomFolder && pageResult.length === clientDialogsPageSize && !moved) {
      // Do not silently skip pages if the server provides an unusable cursor.
      clientCustomFolderIncomplete = true;
    } else if (isCustomFolder && !clientDialogsHasMore && folderId === 0) {
      clientCustomFolderStage = 1;
      clientDialogsCursor = null;
      clientDialogsHasMore = true;
    }
    const combined = append ? [...state.clientDialogs] : [];
    const seen = new Set(combined.map((dialog) => String(dialog.id)));
    for (const dialog of result) {
      const id = String(dialog.id);
      if (!seen.has(id)) { combined.push(dialog); seen.add(id); }
    }
    state.clientDialogs = snapshot ? ws.finishDialogSnapshot(snapshot, combined) : combined;
    const scrollTop = container.scrollTop;
    renderClientDialogs();
    if (append) container.scrollTop = scrollTop;
    populateQuickChatOptions();
  } catch (err) {
    if (request !== clientDialogsRequest || state.clientSelectedInstance !== instId || dialogListScope(state.clientDialogFilter) !== scope) return;
    if (append) {
      showToast(`加载更多会话失败: ${err.message}`, 'error');
      return;
    }
    container.innerHTML = '<div class="empty-state error"></div>';
    container.firstElementChild.textContent = `加载会话失败: ${err.message}`;
    if (isCustomFolder) {
      const notice = document.getElementById('client-folder-notice');
      if (notice) notice.textContent = '文件夹加载失败，请刷新后重试。';
    }
  } finally {
    if (append && request === clientDialogsRequest && state.clientSelectedInstance === instId) clientDialogsLoadingMore = false;
    if (snapshot) ws.finishDialogSnapshot(snapshot);
  }
}

function formatDialogTime(ts) {
  if (!ts) return '';
  const num = Number(ts);
  if (isNaN(num) || num <= 0) return '';
  const ms = num < 1e11 ? num * 1000 : num;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return '昨天';
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function updateClientTotalUnreadBadge() {
  const totalUnread = (state.clientDialogs || []).reduce((sum, dialog) => sum + (Number(dialog.unreadCount) || 0), 0);
  const totalBadgeEl = document.getElementById('badge-unread-total');
  if (!totalBadgeEl) return;
  if (totalUnread > 0) {
    totalBadgeEl.innerText = totalUnread > 99 ? '99+' : totalUnread;
    totalBadgeEl.style.display = 'inline-block';
  } else {
    totalBadgeEl.style.display = 'none';
  }
}

function updateClientDialogSelection(chatId) {
  const container = document.getElementById('client-dialogs-list');
  if (!container) return;
  for (const item of container.querySelectorAll('.dialog-item')) {
    item.classList.toggle('active', String(item.dataset.chatId) === String(chatId));
  }
}

function updateClientDialogUnreadBadge(chatId) {
  const container = document.getElementById('client-dialogs-list');
  const dialog = (state.clientDialogs || []).find(item => String(item.id) === String(chatId));
  if (container && dialog) {
    const row = [...container.querySelectorAll('.dialog-item')].find(item => String(item.dataset.chatId) === String(chatId));
    const filter = String(state.clientDialogFilter || 'all');
    const noLongerMatchesFilter = filter === 'unread'
      ? !(Number(dialog.unreadCount) > 0)
      : filter.startsWith('folder:') && !window.DialogFolders?.apply(filter, [dialog]).some(item => String(item.id) === String(chatId));
    if (row && noLongerMatchesFilter) {
      row.remove();
      if (!container.querySelector('.dialog-item')) {
        let emptyState = container.querySelector('.empty-state');
        if (!emptyState) {
          emptyState = document.createElement('div');
          emptyState.className = 'empty-state';
          container.prepend(emptyState);
        }
        emptyState.textContent = filter === 'unread' ? '没有未读会话' : '未找到匹配的会话';
      }
    } else {
      const badge = row?.querySelector('.dialog-badge');
      if (badge && !(Number(dialog.unreadCount) > 0)) badge.remove();
    }
  }
  updateClientTotalUnreadBadge();
}

function renderClientDialogs() {
  const container = document.getElementById('client-dialogs-list');
  if (!container) return;
  const storiesBar = document.getElementById('client-stories-bar');
  const searchText = document.getElementById('client-dialogs-search')?.value?.trim() || '';
  if (storiesBar) storiesBar.hidden = state.clientDialogFilter === 'archived' || String(state.clientDialogFilter || '').startsWith('folder:') || Boolean(searchText);

  // Update total unread badge on tab
  updateClientTotalUnreadBadge();

  const search = (document.getElementById('client-dialogs-search')?.value || '').toLowerCase().trim();
  const filterType = state.clientDialogFilter || 'all';
  const folderNotice = document.getElementById('client-folder-notice');
  if (folderNotice) {
    folderNotice.hidden = !filterType.startsWith('folder:');
    if (!folderNotice.hidden) {
      folderNotice.textContent = clientCustomFolderIncomplete
        ? '无法继续读取完整的文件夹，请刷新后重试。'
        : clientCustomFolderExplicitIncomplete
          ? '部分手动包含的会话暂时无法读取；其余文件夹内容仍可浏览。'
          : clientDialogsHasMore
          ? '正在分批加载主列表和归档会话，可在列表底部加载更多。'
          : '已读取主列表和归档中可访问的会话。';
    }
  }

  let list = state.clientDialogs || [];
  if (search) {
    const remote = clientDialogRemoteSearch.instId === state.clientSelectedInstance && clientDialogRemoteSearch.query === search
      ? clientDialogRemoteSearch.results : [];
    list = mergeClientDialogSearchResults(search, list, remote);
  }
  if (filterType.startsWith('folder:')) {
    list = window.DialogFolders ? window.DialogFolders.apply(filterType, list) : [];
  } else if (filterType !== 'all') {
    list = list.filter((d) => {
      if (filterType === 'unread') return (Number(d.unreadCount) || 0) > 0;
      if (filterType === 'archived') return Boolean(d.archived);
      if (filterType === 'private') return d.type === 'private';
      if (filterType === 'group') return d.type === 'group' || d.type === 'supergroup';
      if (filterType === 'channel') return d.type === 'channel';
      if (filterType === 'bot') return d.type === 'bot' || (d.username && d.username.toLowerCase().endsWith('bot'));
      return true;
    });
  }

  if (list.length === 0) {
    const status = search && clientDialogRemoteSearch.instId === state.clientSelectedInstance && clientDialogRemoteSearch.query === search ? clientDialogRemoteSearch : null;
    container.innerHTML = status?.loading ? '<div class="empty-state">正在搜索 Telegram...</div>' :
      status?.error ? '<div class="empty-state">Telegram 搜索失败 <button type="button" class="btn btn-secondary btn-sm" id="retry-dialog-search">重试</button></div>' : '<div class="empty-state">未找到匹配的会话</div>';
    if (status?.error) container.querySelector('#retry-dialog-search')?.addEventListener('click', startClientDialogSearch);
    appendLoadMoreDialogsButton(container);
    return;
  }

  const instId = state.clientSelectedInstance;
  container.innerHTML = '';
  for (const d of list) {
    const item = document.createElement('div');
    item.className = `dialog-item ${String(state.clientActiveChatId) === String(d.id) ? 'active' : ''}`;
    item.dataset.chatId = String(d.id);

    const isMuted = Boolean(d.muted);
    const initials = (d.title || d.username || 'TG').slice(0, 2);
    const timeStr = d.lastMessageDate ? formatDialogTime(d.lastMessageDate) : '';
    const badgeClass = isMuted ? 'dialog-badge muted' : 'dialog-badge';
    const unreadHtml = d.unreadCount > 0 ? `<span class="${badgeClass}">${d.unreadCount}</span>` : '';
    const muteIconHtml = isMuted ? '<svg class="dialog-mute-icon" title="已静音"><use href="#icon-volume-off"/></svg>' : '';
    const autoDeleteIconHtml = Number(d.ttlPeriod) > 0
      ? '<svg class="dialog-auto-delete-icon" title="已开启自动删除"><use href="#icon-clock"/></svg>' : '';
    const typeIcon = d.type === 'channel'
      ? '<svg class="ui-icon-xs" style="vertical-align:-1px;margin-right:3px;color:var(--text-muted);"><use href="#icon-broadcast"/></svg>'
      : d.type === 'bot'
      ? '<svg class="ui-icon-xs" style="vertical-align:-1px;margin-right:3px;color:var(--text-muted);"><use href="#icon-terminal"/></svg>'
      : '';
    const avatarUrl = `/api/instances/${instId}/account/avatar?chatId=${d.id}`;

    const draft = window.CloudDrafts?.getText(instId, d.id, d.draft) ?? (state.clientDrafts && state.clientDrafts[clientDraftKey(d.id)]);
    const hasDraft = Boolean(draft && draft.trim());
    const draftBadgeHtml = hasDraft ? '<span class="dialog-draft-tag">草稿</span>' : '';
    const folderTags = window.DialogFolders?.getTags(d, filterType) || [];
    const folderTagsHtml = folderTags.length
      ? `<div class="dialog-folder-tags" aria-label="所属文件夹">${folderTags.slice(0, 3).map(folder => `<span class="dialog-folder-tag" data-folder-color="${folder.color}">${escapeHtml(folder.title)}</span>`).join('')}${folderTags.length > 3 ? `<span class="dialog-folder-tag dialog-folder-tag-more">+${folderTags.length - 3}</span>` : ''}</div>`
      : '';
    let snippetText = '';
    let snippetClass = 'dialog-snippet';
    if (d._typing) {
      snippetText = '<span style="color:var(--tg-typing-color);">正在输入<span class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span></span>';
      snippetClass += ' typing-snippet';
    } else if (hasDraft) {
      snippetText = escapeHtml(draft.replace(/\n/g, ' '));
      snippetClass += ' draft-snippet';
    } else if (d.lastMessage) {
      const senderPrefix = d.lastSender && (d.type === 'group' || d.type === 'supergroup') ? `${escapeHtml(d.lastSender)}: ` : '';
      snippetText = `${senderPrefix}${escapeHtml(d.lastMessage)}`;
    } else {
      snippetText = d.username ? '@' + escapeHtml(d.username) : 'ID: ' + escapeHtml(d.id);
    }

    item.innerHTML = `
      <div class="dialog-avatar-wrap" style="width: 48px; height: 48px; min-width: 48px; min-height: 48px; max-width: 48px; max-height: 48px; border-radius: 50%; position: relative; overflow: visible; flex-shrink: 0; background: var(--bg-subtle);">
        <img class="dialog-avatar-img" data-network-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" style="width: 48px; height: 48px; max-width: 48px; max-height: 48px; border-radius: 50%; object-fit: cover; position: absolute; top: 0; left: 0;"
             onload="this.classList.add('loaded'); if(this.nextElementSibling) this.nextElementSibling.style.display='none';"
             onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
        <div class="dialog-avatar-initials" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 14px; color: var(--color-primary); text-transform: uppercase;">${escapeHtml(initials)}</div>
        ${d.online ? '<span class="dialog-online-dot" title="在线"></span>' : ''}
      </div>
      <div class="dialog-info">
        <div class="dialog-title-row">
          <span class="dialog-title">${typeIcon}${escapeHtml(d.title || d.username || String(d.id))}</span>
          <span class="dialog-time" style="display:flex;align-items:center;gap:4px;">${d.pinned ? '<svg class="dialog-pinned-icon" title="已置顶"><use href="#icon-pin"/></svg>' : ''}${muteIconHtml}${autoDeleteIconHtml}${timeStr}</span>
        </div>
        <div class="dialog-snippet-row">
          ${draftBadgeHtml}
          <span class="${snippetClass}">${snippetText}</span>
          ${unreadHtml}
        </div>
        ${folderTagsHtml}
      </div>
      <div class="dialog-hover-actions">
        <button class="dialog-action-btn" data-action="pin" title="${d.pinned ? '取消置顶' : '置顶'}" onclick="event.stopPropagation(); toggleDialogPin(${inlineJsArg(d.id)}, ${!d.pinned})">
          <svg class="ui-icon-xs"><use href="#icon-pin"/></svg>
        </button>
        <button class="dialog-action-btn" data-action="mute" title="${isMuted ? '取消静音' : '静音'}" onclick="event.stopPropagation(); toggleDialogMute(${inlineJsArg(d.id)})">
          <svg class="ui-icon-xs"><use href="#icon-volume-off"/></svg>
        </button>
        <button class="dialog-action-btn" data-action="more" title="更多操作" onclick="event.stopPropagation(); showDialogContextMenu(event, ${inlineJsArg(d.id)})">
          <svg class="ui-icon-xs"><use href="#icon-dots-vertical"/></svg>
        </button>
      </div>
    `;

    item.onclick = () => selectClientChat(d);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showDialogContextMenu(e, d.id);
    };
    container.appendChild(item);
  }
  if (search && clientDialogRemoteSearch.instId === state.clientSelectedInstance && clientDialogRemoteSearch.query === search && (clientDialogRemoteSearch.loading || clientDialogRemoteSearch.error)) {
    const status = document.createElement('div');
    status.className = 'empty-state';
    status.textContent = clientDialogRemoteSearch.loading ? '正在搜索 Telegram...' : 'Telegram 搜索失败 ';
    if (clientDialogRemoteSearch.error) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary btn-sm';
      retry.textContent = '重试';
      retry.onclick = startClientDialogSearch;
      status.appendChild(retry);
    }
    container.appendChild(status);
  }
  appendLoadMoreDialogsButton(container);
}

function appendLoadMoreDialogsButton(container) {
  if ((document.getElementById('client-dialogs-search')?.value || '').trim()) return;
  if (!clientDialogsHasMore) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary';
  button.textContent = '加载更多会话';
  button.onclick = () => loadClientDialogs(true);
  container.appendChild(button);
}

// ---- Dialog hover actions & context menu ----

window.toggleDialogPin = async (chatId, pin) => {
  const instId = state.clientSelectedInstance;
  if (!instId) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-pin`, 'POST', { chatId, pinned: Boolean(pin) });
    showToast(pin ? '已置顶' : '已取消置顶', 'success');
    if (state.clientSelectedInstance === instId) loadClientDialogs();
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
};

async function movePinnedDialog(chatId, direction, folderId, instId, selectionVersion) {
  if (![-1, 1].includes(direction) || !instId) return;
  const isCurrent = () => state.clientSelectedInstance === instId && state.chatSelectionVersion === selectionVersion;
  try {
    const current = await api(`/api/instances/${encodeURIComponent(instId)}/account/pinned-dialogs?folderId=${folderId}`);
    if (!isCurrent()) return;
    if (!Array.isArray(current) || !current.every(id => Number.isSafeInteger(Number(id)))) throw new Error('Telegram 返回了无效的置顶顺序');
    const order = current.map(Number);
    const index = order.indexOf(Number(chatId));
    const next = index + direction;
    if (index < 0) throw new Error('此会话已不在置顶列表中，请刷新会话列表');
    if (next < 0 || next >= order.length) return showToast(direction < 0 ? '已是最靠前的置顶会话' : '已是最后一个置顶会话', 'info');
    [order[index], order[next]] = [order[next], order[index]];
    await api(`/api/instances/${encodeURIComponent(instId)}/account/pinned-dialogs/order`, 'POST', { folderId, order });
    if (!isCurrent()) return;
    showToast('置顶顺序已更新', 'success');
    loadClientDialogs();
  } catch (error) {
    if (isCurrent()) showToast(`调整置顶顺序失败：${error.message}`, 'error');
  }
}

function isDialogMuted(chatId) {
  const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(chatId));
  return Boolean(dialog?.muted);
}

async function setDialogMute(instId, chatId, muteUntil) {
  await api(`/api/instances/${encodeURIComponent(instId)}/account/mute-chat`, 'POST', { chatId, muteUntil });
  // A response for another account must not update the currently visible list.
  if (state.clientSelectedInstance !== instId) return;
  const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(chatId));
  if (dialog) dialog.muted = muteUntil > Math.floor(Date.now() / 1000);
  if (String(state.clientActiveChatId) === String(chatId)) updateChatMuteButtonState(chatId);
  renderClientDialogs();
}

window.toggleDialogMute = async (chatId) => {
  const instId = state.clientSelectedInstance;
  if (!instId) return;
  const muteUntil = isDialogMuted(chatId) ? 0 : 2147483647;
  try {
    await setDialogMute(instId, chatId, muteUntil);
    showToast(muteUntil ? '已静音' : '已取消静音', 'success');
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
};

window.showDialogContextMenu = (event, chatId) => {
  const existing = document.getElementById('dialog-ctx-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'dialog-ctx-menu';
  menu.className = 'miuix-msg-menu';
  menu.style.display = 'flex';

  const d = (state.clientDialogs || []).find((x) => String(x.id) === String(chatId));
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  const isMuted = isDialogMuted(chatId);

  menu.innerHTML = `
    <div class="msg-menu-list">
      <button class="msg-menu-item" data-action="pin">
        <svg class="ui-icon-sm"><use href="#icon-pin"/></svg>
        <span>${d?.pinned ? '取消置顶' : '置顶对话'}</span>
      </button>
      ${d?.pinned ? `
        <button class="msg-menu-item" data-action="pin-up">
          <svg class="ui-icon-sm" style="transform:rotate(90deg)"><use href="#icon-arrow-left"/></svg>
          <span>置顶上移</span>
        </button>
        <button class="msg-menu-item" data-action="pin-down">
          <svg class="ui-icon-sm" style="transform:rotate(-90deg)"><use href="#icon-arrow-left"/></svg>
          <span>置顶下移</span>
        </button>
      ` : ''}
      <button class="msg-menu-item" data-action="mute">
        <svg class="ui-icon-sm"><use href="#icon-volume-off"/></svg>
        <span>${isMuted ? '取消静音' : '静音对话'}</span>
      </button>
      <button class="msg-menu-item" data-action="read">
        <svg class="ui-icon-sm"><use href="#icon-check"/></svg>
        <span>标为已读</span>
      </button>
      <button class="msg-menu-item" data-action="archive">
        <svg class="ui-icon-sm"><use href="#icon-instances"/></svg>
        <span>${d?.archived ? '取消归档' : '归档对话'}</span>
      </button>
      <div class="msg-menu-divider"></div>
      <button class="msg-menu-item danger" data-action="delete">
        <svg class="ui-icon-sm"><use href="#icon-trash"/></svg>
        <span>${d && d.type !== 'private' && d.type !== 'bot' ? '退出并删除对话' : '删除对话'}</span>
      </button>
    </div>
  `;

  document.body.appendChild(menu);
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 200)}px`;

  menu.querySelectorAll('.msg-menu-item').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (!instId || state.clientSelectedInstance !== instId || state.chatSelectionVersion !== selectionVersion) {
        menu.remove();
        showToast('账号或会话已切换，请重新打开菜单', 'warn');
        return;
      }
      try {
        if (action === 'pin') await window.toggleDialogPin(chatId, !d?.pinned);
        else if (action === 'pin-up' || action === 'pin-down') await movePinnedDialog(chatId, action === 'pin-up' ? -1 : 1, d?.archived ? 1 : 0, instId, selectionVersion);
        else if (action === 'mute') await window.toggleDialogMute(chatId);
        else if (action === 'read') {
          await api(`/api/instances/${encodeURIComponent(instId)}/account/read`, 'POST', { chatId });
          showToast('已标为已读', 'success');
          if (state.clientSelectedInstance === instId) loadClientDialogs();
        } else if (action === 'archive') {
          const archived = !d?.archived;
          await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-archive`, 'POST', { chatId, archived });
          showToast(archived ? '已归档' : '已取消归档', 'success');
          if (state.clientSelectedInstance === instId) loadClientDialogs();
        } else if (action === 'delete') {
          const prompt = d && (d.type === 'private' || d.type === 'bot')
            ? '确定删除此会话的本地聊天记录吗？对方的记录不会删除。'
            : '确定删除此对话吗？如果是群组或频道，将同时退出。';
          if (confirm(prompt)) {
            await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-delete`, 'POST', { chatId });
            showToast('对话已删除', 'success');
            if (state.clientSelectedInstance === instId) {
              if (String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
                window.ChatComments?.close();
                window.PinnedMessages?.close();
                window.ForumTopics?.setDialog(null);
                if (typeof stopVoiceRecording === 'function') void stopVoiceRecording(false);
                if (typeof stopVideoNoteRecording === 'function') void stopVideoNoteRecording(false);
                state.chatSelectionVersion = (state.chatSelectionVersion || 0) + 1;
                state.clientActiveChatId = null;
                state.clientActiveDialog = null;
                state.clientSavedReactionFilter = null;
                state.clientMessageEffectId = null;
                const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
                document.getElementById('modal-saved-message-tags')?.classList.remove('active');
                if (document.getElementById('saved-message-tags-bar')) document.getElementById('saved-message-tags-bar').hidden = true;
                state.clientMessages = [];
                state.currentProfileChatId = null;
                state.clientHistoryOffsetDate = null;
                cancelReplyBanner();
                cancelEditBanner();
                clearStagedAttachment();
                const messages = document.getElementById('client-messages-container');
                if (messages) messages.innerHTML = '<div class="chat-placeholder"><p>对话已删除</p></div>';
                const title = document.getElementById('client-chat-title');
                if (title) title.textContent = '请选择左侧会话';
                const subtitle = document.getElementById('client-chat-subtitle');
                if (subtitle) subtitle.textContent = '';
                const actions = document.getElementById('client-chat-actions');
                if (actions) actions.style.display = 'none';
                const drawer = document.getElementById('client-drawer');
                if (drawer) { drawer.classList.remove('open'); drawer.style.display = 'none'; }
                document.querySelector('.client-layout')?.classList.remove('in-chat');
                updateClientHistoryBanner();
              }
              loadClientDialogs();
            }
          }
        }
      } catch (err) {
        const message = action === 'delete' && /超时|timeout/i.test(err.message || '')
          ? '删除结果尚未确认，请刷新会话列表后检查。'
          : `操作失败: ${err.message}`;
        showToast(message, 'error');
      }
      menu.remove();
    };
  });

  // Close on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 10);
};

async function selectClientChat(dialog, options = {}) {
  window.MiniApp?.close();
  window.PinnedMessages?.close();
  if (typeof closeGroupInfoModal === 'function') closeGroupInfoModal();
  if (typeof closeChatPermissionsModal === 'function') closeChatPermissionsModal();
  if (typeof closePollVotersDialog === 'function') closePollVotersDialog();
  if (typeof closeMessageReactionUsersDialog === 'function') closeMessageReactionUsersDialog();
  if (typeof closeMessageReadParticipantsDialog === 'function') closeMessageReadParticipantsDialog();
  if (typeof closeQuickRepliesDialog === 'function') closeQuickRepliesDialog();
  if (typeof closeScheduledMessagesDialog === 'function') closeScheduledMessagesDialog();
  if (typeof closeStoryViewer === 'function') closeStoryViewer();
  window.BotKeyboard?.resetReply();
  window.ChatComments?.close();
  window.ForumTopics?.close();
  if (typeof invalidateGroupMembers === 'function') invalidateGroupMembers();
  if (typeof stopVoiceRecording === 'function') void stopVoiceRecording(false);
  if (typeof stopVideoNoteRecording === 'function') void stopVideoNoteRecording(false);
  const prevChatId = state.clientActiveChatId;
  const textarea = document.getElementById('client-message-textarea');
  if (prevChatId && textarea && !state.clientEditingMessageId) {
    state.clientDrafts = state.clientDrafts || {};
    if (textarea.value && textarea.value.trim()) {
      state.clientDrafts[clientDraftKey(prevChatId)] = textarea.value;
    } else {
      delete state.clientDrafts[clientDraftKey(prevChatId)];
    }
  }

  state.chatSelectionVersion = (state.chatSelectionVersion || 0) + 1;
  state.clientActiveChatId = dialog.id;
  state.clientActiveDialog = dialog;
  if (typeof loadBotMenuButton === 'function') void loadBotMenuButton(state.clientSelectedInstance, dialog, state.chatSelectionVersion);
  state.clientSavedReactionFilter = null;
  state.clientMessageEffectId = null;
  state.clientTranslationEnabled = null;
  if (typeof clearTelegramChatAppearance === 'function') clearTelegramChatAppearance();
  const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
  document.getElementById('modal-saved-message-tags')?.classList.remove('active');
  if (typeof refreshClientGifSearch === 'function') refreshClientGifSearch();
  const quickReplyButton = document.getElementById('btn-chat-quick-replies');
  if (quickReplyButton) quickReplyButton.hidden = dialog.type !== 'private';
  window.PinnedMessages?.setDialog(dialog);
  window.ForumTopics?.setDialog(dialog);
  const historyAnchor = options.historyAnchor;
  if (historyAnchor) {
    // Opening a search result is a historical view, not reading all the latest
    // messages. Establish that state before any real-time updates can arrive.
    state.clientHistoryOffsetDate = historyAnchor.date;
    state.clientHistoryAnchorId = historyAnchor.id;
    state.clientMessages = [];
    updateClientHistoryBanner();
    const container = document.getElementById('client-messages-container');
    if (container) container.innerHTML = '<div class="chat-placeholder"><p>正在定位消息...</p></div>';
  }
  state.clientReplyingTo = null;
  toggleChatSearchBar(false, false);
  cancelReplyBanner();
  cancelEditBanner();
  clearStagedAttachment();
  if (currentPreviewVideo) {
    pausePreviewVideo(currentPreviewVideo);
  }

  if (textarea) {
    textarea.value = (state.clientDrafts && state.clientDrafts[clientDraftKey(dialog.id)]) || '';
    autoResizeTextarea(textarea);
  }

  const instId = state.clientSelectedInstance;
  void window.CloudDrafts?.open(instId, dialog.id);

  document.querySelector('.client-layout')?.classList.add('in-chat');
  updateClientDialogSelection(dialog.id);

  const initials = (dialog.title || dialog.username || 'TG').slice(0, 2);
  const headerAvatarImg = document.getElementById('client-chat-avatar-img');
  const headerAvatarTxt = document.getElementById('client-chat-avatar');

  if (headerAvatarImg && headerAvatarTxt) {
    const selectionVersion = state.chatSelectionVersion;
    headerAvatarImg.style.opacity = '0';
    headerAvatarTxt.style.display = 'flex';
    headerAvatarTxt.innerText = initials;
    const avatarUrl = `/api/instances/${instId}/account/avatar?chatId=${dialog.id}`;
    scheduler.loadImage(headerAvatarImg, avatarUrl).then((ok) => {
      if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(dialog.id) || state.chatSelectionVersion !== selectionVersion) return;
      if (ok) {
        headerAvatarImg.style.opacity = '1';
        headerAvatarTxt.style.display = 'none';
      } else {
        headerAvatarImg.style.opacity = '0';
        headerAvatarTxt.style.display = 'flex';
        headerAvatarTxt.innerText = initials;
      }
    });
  }

  document.getElementById('client-chat-title').innerText = dialog.title || dialog.username || `Chat #${dialog.id}`;

  const typeMap = {
    private: '私聊 (Private)',
    group: '普通群组 (Group)',
    supergroup: '超级群组 (Supergroup)',
    channel: '广播频道 (Channel)',
    bot: '机器人 (Bot)',
  };
  const userTag = dialog.username ? ` | @${dialog.username}` : '';

  // Show member/subscriber count for groups and channels
  let memberInfo = '';
  if (dialog.type === 'group' || dialog.type === 'supergroup') {
    const count = dialog.participantsCount || dialog.membersCount;
    memberInfo = count ? ` · ${count} 位成员` : '';
  } else if (dialog.type === 'channel') {
    const count = dialog.participantsCount || dialog.membersCount || dialog.subscribersCount;
    memberInfo = count ? ` · ${count} 位订阅者` : '';
  } else if (dialog.online) {
    memberInfo = ' · 在线';
  }
  document.getElementById('client-chat-subtitle').innerText = `${typeMap[dialog.type] || dialog.type}${memberInfo} | ID: ${dialog.id}${userTag}`;
  document.getElementById('client-chat-actions').style.display = 'flex';
  const discussionGroupButton = document.getElementById('btn-chat-discussion-group');
  if (discussionGroupButton) discussionGroupButton.hidden = dialog.type !== 'channel';
  if (typeof updateChatTranslationToggle === 'function') updateChatTranslationToggle();
  if (typeof loadChatTranslationSettings === 'function') void loadChatTranslationSettings(instId, dialog, state.chatSelectionVersion);
  if (typeof loadTelegramChatThemeForDialog === 'function') void loadTelegramChatThemeForDialog(instId, dialog, state.chatSelectionVersion);
  if (typeof loadSavedMessageTags === 'function') void loadSavedMessageTags(instId, dialog, state.chatSelectionVersion);
  if (typeof loadMessageEffects === 'function') void loadMessageEffects(instId);
  updateChatMuteButtonState(dialog.id);

  // Keep the profile drawer closed unless the user explicitly opened it.
  const profileDrawer = document.getElementById('client-drawer');
  if (profileDrawer && profileDrawer.classList.contains('open')) {
    loadPeerProfile(dialog.id);
  }

  if (historyAnchor) return await loadClientMessagesAround(dialog.id, historyAnchor.id, historyAnchor.date);
  if (await loadClientMessages(dialog.id)) void markVisibleChatRead(instId, dialog.id);
}

let isLoadingEarlierMessages = false;
let hasReachedEarliestMessage = false;
let clientMessagesRequest = 0;

/** Only acknowledge messages that were loaded and are visible to the user. */
async function markVisibleChatRead(instId, chatId) {
  if (document.hidden === true || (typeof document.hasFocus === 'function' && !document.hasFocus()) ||
      state.clientHistoryOffsetDate != null || state.clientSavedReactionFilter || state.clientSelectedInstance !== instId ||
      String(state.clientActiveChatId) !== String(chatId)) return;
  const view = document.getElementById('view-client');
  if (view && !view.classList.contains('active')) return;
  const dialog = state.clientDialogs.find((d) => String(d.id) === String(chatId));
  // A forum's unread counter aggregates topics. Reading the combined chat
  // history must not mark unrelated topics as read.
  if (dialog?.isForum || window.ForumTopics?.isCurrentForum()) return;
  if (!dialog || !(dialog.unreadCount > 0)) return;
  const selectionVersion = state.chatSelectionVersion;
  const maxId = Math.max(0, ...(state.clientMessages || []).map((m) => {
    const id = Number(m.id);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }));
  if (!maxId) return;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('mark_as_read', { instId, chatId, maxId });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/read`, 'POST', { chatId, maxId });
    }
    if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId) ||
        state.chatSelectionVersion !== selectionVersion) return;
    const current = state.clientDialogs.find((d) => String(d.id) === String(chatId));
    if (!current || (current.lastMessageId && Number(current.lastMessageId) > maxId)) return;
    current.unreadCount = 0;
    window.chatWs?.recordDialogRead?.(instId, chatId, maxId);
    updateClientDialogUnreadBadge(chatId);
  } catch (_) { /* Preserve unread state if Telegram did not acknowledge it. */ }
}

function updateClientHistoryBanner() {
  const banner = document.getElementById('client-history-banner');
  if (banner) banner.hidden = state.clientHistoryOffsetDate == null;
}

async function returnToLatestMessages() {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  if (!instId || chatId == null) return;
  if (!await loadClientMessages(chatId, false, true)) return;
  if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId)) return;
  void markVisibleChatRead(instId, chatId);
}

function isCurrentMessagesRequest(request, instId, chatId) {
  return request === clientMessagesRequest &&
    state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId);
}

let savedMessageTagCatalog = { instId: null, chatId: null, tags: [], defaults: [] };
let savedMessageTagRequest = 0;

function savedMessageTagKey(reaction) {
  if (!reaction || !['emoji', 'custom'].includes(reaction.type)) return '';
  return `${reaction.type}:${reaction.value}`;
}

function getSavedMessageTagChoices() {
  const choices = new Map();
  for (const tag of savedMessageTagCatalog.tags || []) {
    const key = savedMessageTagKey(tag.reaction);
    if (key) choices.set(key, { ...tag });
  }
  for (const reaction of savedMessageTagCatalog.defaults || []) {
    const key = savedMessageTagKey(reaction);
    if (key && !choices.has(key)) choices.set(key, { reaction, count: 0 });
  }
  return [...choices.values()];
}

function isCurrentSavedTagTarget(target) {
  return Boolean(target && state.clientSelectedInstance === target.instId &&
    String(state.clientActiveChatId) === String(target.chatId) &&
    state.chatSelectionVersion === target.selectionVersion && state.clientActiveDialog?.isSelf === true);
}

function renderSavedMessageTagBar() {
  const bar = document.getElementById('saved-message-tags-bar');
  const scroll = document.getElementById('saved-message-tags-scroll');
  if (!bar || !scroll) return;
  const target = savedMessageTagCatalog;
  const isVisible = state.clientActiveDialog?.isSelf === true && target.instId === state.clientSelectedInstance &&
    String(target.chatId) === String(state.clientActiveChatId);
  bar.hidden = !isVisible;
  if (!isVisible) return;
  scroll.replaceChildren();
  const addChip = (label, reaction, count, key) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-message-tag-chip';
    const selected = reaction ? savedMessageTagKey(state.clientSavedReactionFilter) === key : !state.clientSavedReactionFilter;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.textContent = `${label}${count > 0 ? ` ${count}` : ''}`;
    button.onclick = () => {
      state.clientSavedReactionFilter = reaction && !selected ? reaction : null;
      renderSavedMessageTagBar();
      void loadClientMessages(state.clientActiveChatId);
    };
    scroll.appendChild(button);
  };
  addChip('全部', null, 0, '');
  for (const tag of getSavedMessageTagChoices()) {
    const reaction = tag.reaction;
    const emoji = reaction.type === 'emoji' ? reaction.value : '✨';
    const label = tag.title ? `${emoji} ${tag.title}` : emoji;
    addChip(label, reaction, Number(tag.count) || 0, savedMessageTagKey(reaction));
  }
  const status = document.getElementById('saved-message-tag-editor-status');
  if (status && !getSavedMessageTagChoices().length) status.textContent = 'Telegram 当前未返回可用标签。';
}

async function loadSavedMessageTags(instId, dialog, selectionVersion = state.chatSelectionVersion) {
  const bar = document.getElementById('saved-message-tags-bar');
  const request = ++savedMessageTagRequest;
  if (!dialog?.isSelf) {
    savedMessageTagCatalog = { instId: null, chatId: null, tags: [], defaults: [] };
    if (bar) bar.hidden = true;
    document.getElementById('modal-saved-message-tags')?.classList.remove('active');
    state.clientSavedReactionFilter = null;
    return;
  }
  const target = { instId, chatId: Number(dialog.id), selectionVersion };
  if (bar) bar.hidden = false;
  savedMessageTagCatalog = { ...target, tags: [], defaults: [] };
  try {
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/saved-message-tags`);
    if (request !== savedMessageTagRequest || !isCurrentSavedTagTarget(target)) return;
    savedMessageTagCatalog = {
      ...target,
      tags: Array.isArray(result?.tags) ? result.tags : [],
      defaults: Array.isArray(result?.defaults) ? result.defaults : [],
    };
    renderSavedMessageTagBar();
  } catch (error) {
    if (request !== savedMessageTagRequest || !isCurrentSavedTagTarget(target)) return;
    savedMessageTagCatalog = { ...target, tags: [], defaults: [] };
    renderSavedMessageTagBar();
    showToast(`读取 Saved Messages 标签失败：${error.message}`, 'error');
  }
}

function renderSavedMessageTagEditor() {
  const list = document.getElementById('saved-message-tag-editor-list');
  const status = document.getElementById('saved-message-tag-editor-status');
  if (!list) return;
  list.replaceChildren();
  const choices = getSavedMessageTagChoices();
  if (!choices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '此账号没有可用的 Telegram Saved Messages 标签。';
    list.appendChild(empty);
    return;
  }
  for (const tag of choices) {
    const row = document.createElement('div');
    row.className = 'saved-message-tag-editor-row';
    const emoji = document.createElement('span');
    emoji.className = 'saved-message-tag-editor-emoji';
    emoji.textContent = tag.reaction.type === 'emoji' ? tag.reaction.value : '✨';
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 64; input.className = 'form-input';
    input.value = tag.title || ''; input.placeholder = '为此 Emoji 标签命名';
    input.setAttribute('aria-label', `${emoji.textContent} 标签名称`);
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'btn btn-secondary btn-sm'; save.textContent = '保存';
    save.onclick = async () => {
      const target = { instId: savedMessageTagCatalog.instId, chatId: Number(savedMessageTagCatalog.chatId), selectionVersion: state.chatSelectionVersion };
      try {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/saved-message-tags`, 'POST', {
          reaction: tag.reaction, title: input.value.trim() || null,
        });
        if (!isCurrentSavedTagTarget(target)) return;
        await loadSavedMessageTags(target.instId, state.clientActiveDialog, target.selectionVersion);
        renderSavedMessageTagEditor();
        if (status) status.textContent = input.value.trim() ? '标签名称已保存。' : '标签名称已清除。';
      } catch (error) { if (status) status.textContent = `保存失败：${error.message}`; }
    };
    row.append(emoji, input, save);
    list.appendChild(row);
  }
}

async function setSavedMessageTag(target, messageId, reaction, enabled) {
  if (!isCurrentSavedTagTarget(target)) return;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/saved-message-tag`, 'POST', {
      chatId: target.chatId, messageId, reaction, enabled,
    });
    if (!isCurrentSavedTagTarget(target)) return;
    showToast(enabled ? '已为收藏消息添加标签' : '已从收藏消息移除标签', 'success');
    await Promise.all([
      loadSavedMessageTags(target.instId, state.clientActiveDialog, target.selectionVersion),
      loadClientMessages(target.chatId, true),
    ]);
  } catch (error) { if (isCurrentSavedTagTarget(target)) showToast(`更新标签失败：${error.message}`, 'error'); }
}

function initSavedMessageTags() {
  const modal = document.getElementById('modal-saved-message-tags');
  const close = () => modal?.classList.remove('active');
  document.getElementById('btn-manage-saved-message-tags')?.addEventListener('click', () => {
    if (state.clientActiveDialog?.isSelf !== true) return;
    renderSavedMessageTagEditor();
    modal?.classList.add('active');
  });
  document.getElementById('btn-close-saved-message-tags')?.addEventListener('click', close);
  modal?.addEventListener('click', event => { if (event.target === modal) close(); });
}

let clientTranslationSettingsRequest = 0;

function canToggleChatTranslation(dialog) {
  return Boolean(dialog && !dialog.isSelf && ['private', 'group', 'supergroup', 'channel'].includes(dialog.type));
}

function updateChatTranslationToggle() {
  const button = document.getElementById('btn-chat-translation-toggle');
  if (!button) return;
  const available = canToggleChatTranslation(state.clientActiveDialog);
  button.hidden = !available;
  const enabled = state.clientTranslationEnabled;
  button.disabled = !available || enabled == null;
  button.textContent = enabled === true ? '关闭自动翻译' : '始终翻译';
  button.title = enabled === true ? '关闭此对话的自动翻译' : '始终翻译此对话';
  button.setAttribute('aria-pressed', enabled === true ? 'true' : 'false');
}

async function loadChatTranslationSettings(instId, dialog, selectionVersion) {
  const request = ++clientTranslationSettingsRequest;
  if (!canToggleChatTranslation(dialog)) {
    state.clientTranslationEnabled = null;
    updateChatTranslationToggle();
    return;
  }
  state.clientTranslationEnabled = null;
  updateChatTranslationToggle();
  try {
    const settings = await api(`/api/instances/${encodeURIComponent(instId)}/account/translation-settings?chatId=${encodeURIComponent(dialog.id)}`);
    if (request !== clientTranslationSettingsRequest || state.clientSelectedInstance !== instId ||
        String(state.clientActiveChatId) !== String(dialog.id) || state.chatSelectionVersion !== selectionVersion) return;
    state.clientTranslationEnabled = settings?.enabled === true;
    if (state.clientTranslationEnabled) void applyAutomaticMessageTranslations();
  } catch (_) {
    if (request === clientTranslationSettingsRequest && state.clientSelectedInstance === instId &&
        String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion) {
      state.clientTranslationEnabled = null;
    }
  }
  updateChatTranslationToggle();
}

async function toggleChatTranslation() {
  const button = document.getElementById('btn-chat-translation-toggle');
  const dialog = state.clientActiveDialog;
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  if (!button || !canToggleChatTranslation(dialog) || state.clientTranslationEnabled == null || !instId) return;
  const enabled = !state.clientTranslationEnabled;
  const request = ++clientTranslationSettingsRequest;
  button.disabled = true;
  try {
    const settings = await api(`/api/instances/${encodeURIComponent(instId)}/account/translation-settings`, 'POST', {
      chatId: dialog.id, enabled,
    });
    if (request !== clientTranslationSettingsRequest || state.clientSelectedInstance !== instId ||
        String(state.clientActiveChatId) !== String(dialog.id) || state.chatSelectionVersion !== selectionVersion) return;
    state.clientTranslationEnabled = settings?.enabled === true;
    if (!state.clientTranslationEnabled) {
      for (const message of state.clientMessages || []) delete message.autoTranslatedText;
      renderClientMessages(true);
    } else {
      void applyAutomaticMessageTranslations();
    }
    showToast(state.clientTranslationEnabled ? '已开启此对话的自动翻译' : '已关闭此对话的自动翻译', 'success');
  } catch (err) {
    if (request === clientTranslationSettingsRequest && state.clientSelectedInstance === instId &&
        String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion) {
      showToast(`翻译设置失败: ${err.message}`, 'error');
    }
  }
  updateChatTranslationToggle();
}

function initChatTranslationToggle() {
  document.getElementById('btn-chat-translation-toggle')?.addEventListener('click', () => { void toggleChatTranslation(); });
  document.getElementById('btn-chat-discussion-group')?.addEventListener('click', () => { void openDiscussionGroupDialog(); });
  document.getElementById('btn-chat-bot-menu')?.addEventListener('click', () => {
    const dialog = state.clientActiveDialog;
    const context = { instId: state.clientSelectedInstance, chatId: state.clientActiveChatId, selectionVersion: state.chatSelectionVersion };
    if (dialog?.type === 'bot' && context.instId && context.chatId != null) void window.MiniApp?.openBotMenu(context);
  });
  window.ChatTranslation = { refreshLanguage: refreshAutomaticTranslationsForLanguage };
}

let discussionGroupDialogSession = null;

function closeDiscussionGroupDialog() {
  const modal = document.getElementById('modal-discussion-group');
  if (modal) modal.style.display = 'none';
  discussionGroupDialogSession = null;
}

async function openDiscussionGroupDialog() {
  const dialog = state.clientActiveDialog;
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion || 0;
  if (!instId || !dialog || dialog.type !== 'channel') return;
  const modal = document.getElementById('modal-discussion-group');
  const current = document.getElementById('discussion-group-current');
  const select = document.getElementById('discussion-group-select');
  const status = document.getElementById('discussion-group-status');
  const link = document.getElementById('btn-discussion-group-link');
  const unlink = document.getElementById('btn-discussion-group-unlink');
  if (!modal || !current || !select || !status || !link || !unlink) return;
  const session = { instId, channelId: Number(dialog.id), selectionVersion };
  discussionGroupDialogSession = session;
  const isCurrent = () => discussionGroupDialogSession === session && state.clientSelectedInstance === instId &&
    Number(state.clientActiveChatId) === session.channelId && (state.chatSelectionVersion || 0) === selectionVersion;
  const close = () => { if (discussionGroupDialogSession === session) closeDiscussionGroupDialog(); };
  const closeButton = document.getElementById('btn-discussion-group-close');
  const cancelButton = document.getElementById('btn-discussion-group-cancel');
  if (closeButton) closeButton.onclick = close;
  if (cancelButton) cancelButton.onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  modal.style.display = 'flex';
  current.textContent = '正在读取当前关联…';
  status.textContent = '';
  select.replaceChildren(new Option('正在加载…', ''));
  select.disabled = true;
  link.disabled = true;
  unlink.hidden = true;
  select.onchange = () => { link.disabled = !select.value; };
  let stateResult;
  const renderState = (result, message) => {
    stateResult = result;
    const linked = result?.linkedGroup;
    current.textContent = linked ? `当前关联讨论群：${linked.title}${linked.username ? ` · @${linked.username}` : ''}` : '此频道当前没有关联讨论群。';
    const groups = Array.isArray(result?.groups) ? result.groups.filter(group =>
      Number.isSafeInteger(Number(group?.id)) && Number(group.id) < 0 && typeof group.title === 'string' && group.title) : [];
    select.replaceChildren(new Option('选择一个超级群组…', ''));
    for (const group of groups) {
      const label = `${group.title}${group.username ? ` · @${group.username}` : ''}${Number.isSafeInteger(group.membersCount) ? ` · ${group.membersCount} 位成员` : ''}`;
      const option = new Option(label, String(group.id));
      option.disabled = Number(group.id) === Number(linked?.id);
      select.appendChild(option);
    }
    select.disabled = groups.length === 0;
    link.disabled = true;
    unlink.hidden = !linked;
    const hasAlternative = groups.some(group => Number(group.id) !== Number(linked?.id));
    status.textContent = message || (hasAlternative ? '列表仅包含 Telegram 判定当前账号可关联的超级群组。'
      : groups.length ? 'Telegram 当前只返回已关联的可用群组。' : '当前账号没有 Telegram 允许关联的超级群组。');
  };
  try {
    stateResult = await api(`/api/instances/${encodeURIComponent(instId)}/account/discussion-groups?channelId=${encodeURIComponent(session.channelId)}`);
    if (!isCurrent()) { close(); return; }
    renderState(stateResult);
  } catch (error) {
    if (!isCurrent()) { close(); return; }
    current.textContent = `读取关联讨论群失败：${error.message}`;
    select.replaceChildren(new Option('无法读取群组', ''));
    select.disabled = true;
    link.disabled = true;
    unlink.hidden = true;
    status.textContent = '请关闭对话框后重试。';
    return;
  }
  link.onclick = async () => {
    if (!isCurrent()) { close(); return; }
    const groupId = Number(select.value);
    const group = stateResult.groups?.find(item => Number(item.id) === groupId);
    if (!group || groupId >= 0) { status.textContent = '请选择可用的超级群组。'; return; }
    const prompt = stateResult.linkedGroup
      ? `将频道“${dialog.title || dialog.username || dialog.id}”的讨论群更改为“${group.title}”吗？`
      : `将“${group.title}”关联为此频道的讨论群吗？`;
    if (!window.confirm(prompt) || !isCurrent()) return;
    link.disabled = true;
    select.disabled = true;
    status.textContent = '正在通过 Telegram 更新关联…';
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/discussion-group`, 'POST', {
        channelId: session.channelId, groupId,
      });
      if (!isCurrent()) { close(); return; }
      showToast('频道讨论群已更新', 'success');
      status.textContent = `已关联“${group.title}”，正在刷新 Telegram 状态…`;
      try {
        stateResult = await api(`/api/instances/${encodeURIComponent(instId)}/account/discussion-groups?channelId=${encodeURIComponent(session.channelId)}`);
        if (!isCurrent()) { close(); return; }
        renderState(stateResult, `已关联“${group.title}”。`);
      } catch (refreshError) {
        if (!isCurrent()) { close(); return; }
        status.textContent = `关联已提交；无法刷新状态：${refreshError.message}。重新打开此面板可检查结果。`;
      }
      select.disabled = false;
      link.disabled = !select.value;
    } catch (error) {
      if (!isCurrent()) { close(); return; }
      status.textContent = `关联失败：${error.message}`;
      select.disabled = false;
      link.disabled = !select.value;
    }
  };
  unlink.onclick = async () => {
    if (!isCurrent()) { close(); return; }
    const linked = stateResult?.linkedGroup;
    if (!linked) return;
    if (!window.confirm(`解除频道“${dialog.title || dialog.username || dialog.id}”与“${linked.title}”的讨论群关联吗？`)) return;
    link.disabled = true;
    unlink.disabled = true;
    select.disabled = true;
    status.textContent = '正在通过 Telegram 解除关联…';
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/discussion-group`, 'POST', {
        channelId: session.channelId, unlink: true,
      });
      if (!isCurrent()) { close(); return; }
      showToast('频道讨论群已解除关联', 'success');
      try {
        stateResult = await api(`/api/instances/${encodeURIComponent(instId)}/account/discussion-groups?channelId=${encodeURIComponent(session.channelId)}`);
        if (!isCurrent()) { close(); return; }
        renderState(stateResult, '讨论群关联已解除。');
      } catch (refreshError) {
        if (!isCurrent()) { close(); return; }
        status.textContent = `解除关联已提交；无法刷新状态：${refreshError.message}。重新打开此面板可检查结果。`;
      }
    } catch (error) {
      if (!isCurrent()) { close(); return; }
      status.textContent = `解除关联失败：${error.message}`;
    } finally {
      if (isCurrent()) {
        select.disabled = !Array.isArray(stateResult?.groups) || stateResult.groups.length === 0;
        link.disabled = !select.value;
        unlink.disabled = !stateResult?.linkedGroup;
      }
    }
  };
}

const automaticTranslationCache = new Map();
const automaticTranslationPending = new Set();
const automaticTranslationFailures = new Set();

function refreshAutomaticTranslationsForLanguage() {
  automaticTranslationCache.clear();
  automaticTranslationFailures.clear();
  for (const message of state.clientMessages || []) delete message.autoTranslatedText;
  renderClientMessages(true);
}

async function applyAutomaticMessageTranslations() {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const language = state.clientTranslationLanguage || 'zh-hans';
  if (state.clientTranslationEnabled !== true || state.clientSavedReactionFilter || !instId || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0) return;
  const current = () => state.clientTranslationEnabled === true && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion &&
    (state.clientTranslationLanguage || 'zh-hans') === language;
  const candidates = [];
  let changed = false;
  for (const message of state.clientMessages || []) {
    const id = Number(message.id);
    if (message.outgoing || !message.text || !Number.isSafeInteger(id) || id <= 0) continue;
    const key = `${instId}:${chatId}:${language}:${id}`;
    if (automaticTranslationCache.has(key)) {
      const cached = automaticTranslationCache.get(key);
      if (message.autoTranslatedText !== cached) { message.autoTranslatedText = cached; changed = true; }
    } else if (!automaticTranslationPending.has(key) && !automaticTranslationFailures.has(key)) {
      candidates.push({ id, key });
    }
  }
  const batch = candidates.slice(0, 20);
  if (!batch.length) {
    if (changed && current()) renderClientMessages(true);
    return;
  }
  batch.forEach(item => automaticTranslationPending.add(item.key));
  try {
    const results = await api(`/api/instances/${encodeURIComponent(instId)}/account/translate-batch`, 'POST', {
      chatId, messageIds: batch.map(item => item.id), targetLang: language,
    });
    if (!current()) return;
    const translated = new Map((Array.isArray(results) ? results : []).map(item => [Number(item.messageId), item.translatedText]));
    for (const item of batch) {
      const value = translated.get(item.id);
      if (typeof value !== 'string' || !value) { automaticTranslationFailures.add(item.key); continue; }
      automaticTranslationCache.set(item.key, value);
      const message = (state.clientMessages || []).find(candidate => String(candidate.id) === String(item.id));
      if (message) { message.autoTranslatedText = value; changed = true; }
    }
    while (automaticTranslationCache.size > 1000) automaticTranslationCache.delete(automaticTranslationCache.keys().next().value);
  } catch (_) {
    if (current()) batch.forEach(item => automaticTranslationFailures.add(item.key));
  } finally {
    batch.forEach(item => automaticTranslationPending.delete(item.key));
  }
  if (changed && current()) renderClientMessages(true);
}

let messageEffectsCache = { instId: null, items: [], request: 0 };

function isValidMessageEffect(effect) {
  return effect && typeof effect.id === 'string' && /^[1-9]\d{0,19}$/.test(effect.id) &&
    typeof effect.emoticon === 'string' && effect.emoticon.length <= 32 && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(effect.emoticon);
}

function renderMessageEffectOptions(select, effects) {
  const selected = state.clientMessageEffectId || '';
  select.replaceChildren();
  const none = document.createElement('option'); none.value = ''; none.textContent = '无效果'; select.appendChild(none);
  for (const effect of effects) {
    if (!isValidMessageEffect(effect)) continue;
    const option = document.createElement('option');
    option.value = effect.id;
    option.textContent = `${effect.emoticon}${effect.premium ? ' Premium' : ''}`;
    option.title = effect.premium ? 'Telegram Premium 效果' : 'Telegram 消息效果';
    select.appendChild(option);
  }
  select.value = selected;
  select.disabled = effects.length === 0;
}

async function loadMessageEffects(instId) {
  const select = document.getElementById('chat-message-effect');
  if (!select || !instId) return;
  if (messageEffectsCache.instId === instId && Array.isArray(messageEffectsCache.items)) {
    renderMessageEffectOptions(select, messageEffectsCache.items);
    return;
  }
  const request = ++messageEffectsCache.request;
  select.disabled = true;
  try {
    const effects = await api(`/api/instances/${encodeURIComponent(instId)}/account/message-effects`);
    if (request !== messageEffectsCache.request || state.clientSelectedInstance !== instId) return;
    messageEffectsCache = { instId, items: Array.isArray(effects) ? effects.filter(isValidMessageEffect).slice(0, 100) : [], request };
    renderMessageEffectOptions(select, messageEffectsCache.items);
  } catch (_) {
    if (request === messageEffectsCache.request && state.clientSelectedInstance === instId) {
      messageEffectsCache = { instId, items: [], request };
      renderMessageEffectOptions(select, []);
    }
  }
}

function initMessageEffects() {
  const select = document.getElementById('chat-message-effect');
  if (!select) return;
  select.addEventListener('focus', () => { void loadMessageEffects(state.clientSelectedInstance); });
  select.addEventListener('change', () => {
    state.clientMessageEffectId = select.value || null;
  });
}

function restoreBotReplyKeyboardState(request, instId, chatId, messages) {
  if (messages.some(message => message.replyKeyboard)) return;
  const isBotDialog = state.clientDialogs?.some(dialog => String(dialog.id) === String(chatId) && dialog.isBot);
  const hasRecentBotMessage = messages.some(message => message.from?.isBot || message.botKeyboard?.length);
  if (!isBotDialog && !hasRecentBotMessage) return;
  const keyboard = window.BotKeyboard;
  const epoch = keyboard?.getReplyStateEpoch?.();
  void api(`/api/instances/${encodeURIComponent(instId)}/account/reply-keyboard-state?chatId=${encodeURIComponent(chatId)}`)
    .then(snapshot => {
      if (isCurrentMessagesRequest(request, instId, chatId)) keyboard?.replaceReplyState(snapshot, instId, chatId, epoch);
    })
    .catch(() => { /* Reply markup recovery is optional; visible history remains available. */ });
}

function isAlbumMediaMessage(message) {
  return ['photo', 'video'].includes(message?.media?.type) && Boolean(String(message?.groupedId || ''));
}

async function fetchMessagesBefore(instId, chatId, offsetId, limit) {
  let messages;
  if (window.chatWs && window.chatWs.isConnected()) {
    try {
      messages = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit, offsetId });
    } catch (_) { /* Fall back to HTTP when the RPC socket drops. */ }
  }
  if (!Array.isArray(messages)) {
    const params = new URLSearchParams({ chatId: String(chatId), limit: String(limit), offsetId: String(offsetId) });
    messages = await api(`/api/instances/${encodeURIComponent(instId)}/account/messages?${params}`);
  }
  return Array.isArray(messages) ? messages : [];
}

/**
 * Telegram can split an album at a history page boundary. If the oldest
 * loaded item is part of an album, probe the immediately preceding message;
 * only fetch the rest of that small group when the album actually continues.
 */
async function completeLeadingAlbumMessages(messages, instId, chatId, request) {
  if (!Array.isArray(messages) || !messages.length || !isAlbumMediaMessage(messages[0])) return messages;
  const oldest = messages[0];
  let probe;
  try {
    probe = await fetchMessagesBefore(instId, chatId, oldest.id, 1);
  } catch (_) { return messages; }
  if (!isCurrentMessagesRequest(request, instId, chatId)) return messages;
  if (!probe.length || !isAlbumMediaMessage(probe[0]) || String(probe[0].groupedId) !== String(oldest.groupedId)) return messages;

  let prefix;
  try {
    prefix = await fetchMessagesBefore(instId, chatId, oldest.id, 10);
  } catch (_) { return messages; }
  if (!isCurrentMessagesRequest(request, instId, chatId) || !prefix.length) return messages;
  const existingIds = new Set(messages.map(message => String(message.id)));
  const earlier = [...prefix].reverse().filter(message => !existingIds.has(String(message.id)));
  return earlier.length ? [...earlier, ...messages] : messages;
}

async function loadClientMessages(chatId, isSilentRefresh = false, preserveHistoryOnFailure = false) {
  if (isSilentRefresh && state.clientHistoryOffsetDate != null) {
    if (state.clientHistoryAnchorId != null) return loadClientMessagesAround(chatId, state.clientHistoryAnchorId, state.clientHistoryOffsetDate, true);
    return loadClientMessagesWithDate(chatId, state.clientHistoryOffsetDate, true);
  }
  const container = document.getElementById('client-messages-container');
  if (!container) return;
  if (!preserveHistoryOnFailure) {
    state.clientHistoryOffsetDate = null;
    state.clientHistoryAnchorId = null;
    updateClientHistoryBanner();
  }
  const request = ++clientMessagesRequest;
  const instId = state.clientSelectedInstance;
  const savedReaction = state.clientSavedReactionFilter;
  const ws = window.chatWs;
  const snapshot = ws && !savedReaction ? ws.beginMessageSnapshot(instId, chatId) : null;
  isLoadingEarlierMessages = false;
  hasReachedEarliestMessage = false;

  if (!isSilentRefresh && !preserveHistoryOnFailure) {
    state.clientMessages = [];
    container.innerHTML = '<div class="chat-placeholder"><p>正在获取历史消息...</p></div>';
  }

  try {
    let msgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      try {
        msgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 60, savedReaction });
      } catch (_) {}
    }
    if (!msgs) {
      const params = new URLSearchParams({ chatId: String(chatId), limit: '60' });
      if (savedReaction) params.set('savedReaction', JSON.stringify(savedReaction));
      msgs = await api(`/api/instances/${encodeURIComponent(instId)}/account/messages?${params}`);
    }
    if (!isCurrentMessagesRequest(request, instId, chatId)) return;
    let messages = Array.isArray(msgs) ? [...msgs].reverse() : [];
    if (!savedReaction) messages = await completeLeadingAlbumMessages(messages, instId, chatId, request);
    if (!isCurrentMessagesRequest(request, instId, chatId)) return;
    state.clientHistoryOffsetDate = null;
    state.clientHistoryAnchorId = null;
    updateClientHistoryBanner();
    state.clientMessages = snapshot ? ws.finishMessageSnapshot(snapshot, messages) : messages;
    window.BotKeyboard?.replaceReplySnapshot(state.clientMessages, instId, chatId);
    renderClientMessages(isSilentRefresh);
    if (!savedReaction && !isSilentRefresh && !preserveHistoryOnFailure) restoreBotReplyKeyboardState(request, instId, chatId, state.clientMessages);
    return true;
  } catch (err) {
    if (!isSilentRefresh && isCurrentMessagesRequest(request, instId, chatId)) {
      if (preserveHistoryOnFailure) {
        showToast(`获取最新消息失败: ${err.message}`, 'error');
      } else {
        container.innerHTML = '<div class="chat-placeholder"><p style="color:var(--color-danger)"></p></div>';
        container.querySelector('p').textContent = `获取消息失败: ${err.message}`;
      }
    }
  } finally {
    if (snapshot) ws.finishMessageSnapshot(snapshot);
  }
}

async function loadEarlierMessages() {
  if (isLoadingEarlierMessages || hasReachedEarliestMessage || state.clientMessages.length === 0) return;
  const container = document.getElementById('client-messages-container');
  if (!container || !state.clientActiveChatId) return;

  const oldestMsg = state.clientMessages[0];
  if (!oldestMsg || !oldestMsg.id) return;

  isLoadingEarlierMessages = true;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const savedReaction = state.clientSavedReactionFilter;
  const request = clientMessagesRequest;
  const ws = window.chatWs;
  const snapshot = ws && !savedReaction ? ws.beginMessageSnapshot(instId, chatId) : null;

  let topLoader = document.getElementById('chat-top-loader');
  if (!topLoader) {
    topLoader = document.createElement('div');
    topLoader.id = 'chat-top-loader';
    topLoader.className = 'chat-top-loader';
    topLoader.innerHTML = '<span class="spinner-sm"></span> <span>加载更早的历史消息...</span>';
    container.prepend(topLoader);
  } else {
    topLoader.style.display = 'flex';
  }

  const prevHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;

  try {
    let earlierMsgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      try {
        earlierMsgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 40, offsetId: oldestMsg.id, savedReaction });
      } catch (_) {}
    }
    if (!earlierMsgs) {
      const params = new URLSearchParams({ chatId: String(chatId), limit: '40', offsetId: String(oldestMsg.id) });
      if (savedReaction) params.set('savedReaction', JSON.stringify(savedReaction));
      earlierMsgs = await api(`/api/instances/${encodeURIComponent(instId)}/account/messages?${params}`);
    }
    if (!isCurrentMessagesRequest(request, instId, chatId)) return;

    if (!Array.isArray(earlierMsgs) || earlierMsgs.length === 0) {
      hasReachedEarliestMessage = true;
      if (topLoader) topLoader.remove();
      return;
    }

    const reversed = [...earlierMsgs].reverse();
    const completedPage = savedReaction ? reversed : await completeLeadingAlbumMessages(reversed, instId, chatId, request);
    if (!isCurrentMessagesRequest(request, instId, chatId)) return;
    const reconciled = snapshot ? ws.finishMessageSnapshot(snapshot, completedPage, false) : completedPage;
    const existingIds = new Set(state.clientMessages.map((m) => String(m.id)));
    const newEarlier = reconciled.filter((m) => !existingIds.has(String(m.id)));

    if (newEarlier.length === 0) {
      hasReachedEarliestMessage = true;
      if (topLoader) topLoader.remove();
      return;
    }

    state.clientMessages = [...newEarlier, ...state.clientMessages];
    renderClientMessages(true);

    const newHeight = container.scrollHeight;
    container.scrollTop = prevScrollTop + (newHeight - prevHeight);
  } catch (err) {
    if (isCurrentMessagesRequest(request, instId, chatId)) {
      showToast(`加载历史失败: ${err.message}`, 'error');
    }
  } finally {
    if (snapshot) ws.finishMessageSnapshot(snapshot);
    if (isCurrentMessagesRequest(request, instId, chatId)) {
      isLoadingEarlierMessages = false;
      if (topLoader) topLoader.style.display = 'none';
    }
  }
}

function getSenderAvatarColor(id) {
  const gradients = [
    'linear-gradient(135deg, #e53935, #e35d5b)', // Red
    'linear-gradient(135deg, #ff9800, #f7b733)', // Orange
    'linear-gradient(135deg, #8e24aa, #ba68c8)', // Purple
    'linear-gradient(135deg, #00897b, #4db6ac)', // Teal
    'linear-gradient(135deg, #1e88e5, #64b5f6)', // Light Blue
    'linear-gradient(135deg, #43a047, #81c784)', // Green
    'linear-gradient(135deg, #3949ab, #7986cb)', // Indigo
    'linear-gradient(135deg, #d81b60, #f06292)', // Pink
  ];
  const num = Math.abs(Number(id) || 0);
  return gradients[num % gradients.length];
}

function getSenderNameColor(id) {
  const colors = [
    '#f87171', // Red
    '#fb923c', // Orange
    '#c084fc', // Purple
    '#2dd4bf', // Teal
    '#60a5fa', // Blue
    '#4ade80', // Green
    '#818cf8', // Indigo
    '#f472b6', // Pink
  ];
  const num = Math.abs(Number(id) || 0);
  return colors[num % colors.length];
}

// Video Preview & Autoplay Controller
let currentPreviewVideo = null;
let previewObserver = null;
const mobilePreviewTimers = new Map();

function playPreviewVideo(video) {
  if (!video) return;
  if (currentPreviewVideo && currentPreviewVideo !== video) {
    pausePreviewVideo(currentPreviewVideo);
  }
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  const p = video.play();
  if (p !== undefined) {
    p.then(() => {
      currentPreviewVideo = video;
      video.closest('.custom-video-card')?.classList.add('preview-playing');
    }).catch(() => {});
  }
}

function pausePreviewVideo(video) {
  if (!video) return;
  video.pause();
  video.closest('.custom-video-card')?.classList.remove('preview-playing');
  if (currentPreviewVideo === video) {
    currentPreviewVideo = null;
  }
}

function handleVideoPreviewEnter(card) {
  if (!card) return;
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!isTouchDevice) {
    const video = card.querySelector('video');
    if (video) playPreviewVideo(video);
  }
}

function handleVideoPreviewLeave(card) {
  if (!card) return;
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!isTouchDevice) {
    const video = card.querySelector('video');
    if (video) pausePreviewVideo(video);
  }
}

function setupVideoIntersectionAutoplay() {
  if (previewObserver) {
    previewObserver.disconnect();
  }

  mobilePreviewTimers.forEach((timer) => clearTimeout(timer));
  mobilePreviewTimers.clear();

  const container = document.getElementById('client-messages-container');
  if (!container) return;

  const cards = container.querySelectorAll('.custom-video-card');
  if (cards.length === 0) return;

  const visibleVideos = new Set();

  previewObserver = new IntersectionObserver((entries) => {
    const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0 || window.innerWidth <= 768;
    if (!isTouchDevice) return;

    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        visibleVideos.add(video);
      } else {
        visibleVideos.delete(video);
        if (mobilePreviewTimers.has(video)) {
          clearTimeout(mobilePreviewTimers.get(video));
          mobilePreviewTimers.delete(video);
        }
        if (currentPreviewVideo === video) {
          pausePreviewVideo(video);
        }
      }
    }

    if (visibleVideos.size > 0) {
      let latestVideo = null;
      let maxMsgId = -1;
      visibleVideos.forEach((v) => {
        const wrap = v.closest('.chat-bubble-wrap');
        const msgId = Number(wrap?.dataset.msgId) || 0;
        if (msgId >= maxMsgId) {
          maxMsgId = msgId;
          latestVideo = v;
        }
      });

      visibleVideos.forEach((v) => {
        if (v !== latestVideo) {
          if (mobilePreviewTimers.has(v)) {
            clearTimeout(mobilePreviewTimers.get(v));
            mobilePreviewTimers.delete(v);
          }
          if (currentPreviewVideo === v) {
            pausePreviewVideo(v);
          }
        }
      });

      if (latestVideo && currentPreviewVideo !== latestVideo && !mobilePreviewTimers.has(latestVideo)) {
        const timer = setTimeout(() => {
          mobilePreviewTimers.delete(latestVideo);
          if (visibleVideos.has(latestVideo)) {
            playPreviewVideo(latestVideo);
          }
        }, 2000);
        mobilePreviewTimers.set(latestVideo, timer);
      }
    }
  }, {
    root: container,
    threshold: [0.0, 0.6, 1.0],
  });

  cards.forEach((card) => {
    const video = card.querySelector('video');
    if (video) previewObserver.observe(video);
  });
}

function isOutgoingMessageRead(message, chatId) {
  if (!message?.outgoing) return false;
  if (message.read === true) return true;
  const dialog = (state.clientDialogs || []).find((d) => String(d.id) === String(chatId));
  const maxId = Number(dialog?.readOutboxMaxId);
  const id = Number(message.id);
  return Number.isSafeInteger(maxId) && maxId > 0 && Number.isSafeInteger(id) && id > 0 && id <= maxId;
}

function renderAnimationMedia(media, url) {
  const safeUrl = escapeHtml(url);
  if (String(media.mimeType || '').toLowerCase() === 'image/gif') {
    return `<div class="msg-media-wrap video"><img class="msg-media-animation" data-network-src="${safeUrl}" alt="动图" loading="lazy"></div>`;
  }
  const posterUrl = `${url}${url.includes('?') ? '&' : '?'}thumb=1`;
  return `<div class="msg-media-wrap video"><video class="msg-media-animation" data-network-autoplay="${safeUrl}" data-network-poster="${escapeHtml(posterUrl)}" loop muted playsinline controls aria-label="动图">当前浏览器不支持播放此动图</video></div>`;
}

function renderTelegramVideoMedia(media, instId, chatId, messageId, senderName, timeStr) {
  const videoUrl = `/api/instances/${encodeURIComponent(instId)}/account/media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`;
  const thumbUrl = `${videoUrl}&thumb=1`;
  const duration = media.duration ? formatDurationSec(media.duration) : '';
  if (media.roundVideo === true) {
    return `<div class="video-note-card"><video class="video-note-player" controls playsinline preload="none" data-network-poster="${escapeHtml(thumbUrl)}" src="${escapeHtml(videoUrl)}" aria-label="${escapeHtml(senderName)} · 视频消息"></video>${duration ? `<span class="video-note-duration">${escapeHtml(duration)}</span>` : ''}</div>`;
  }
  const title = `${senderName} · 视频`;
  return `<div class="custom-video-card" onmouseenter="handleVideoPreviewEnter(this)" onmouseleave="handleVideoPreviewLeave(this)" onclick="openCinemaVideo(${inlineJsArg(videoUrl)}, ${inlineJsArg(title)}, ${inlineJsArg(timeStr)}, ${inlineJsArg(duration)})" title="点击在影院播放器中播放"><video preload="none" playsinline muted loop data-network-poster="${escapeHtml(thumbUrl)}" src="${escapeHtml(videoUrl)}"></video><div class="video-card-play-badge"><svg class="ui-icon" style="transform: translateX(1px);"><use href="#icon-play"/></svg></div>${duration ? `<div class="video-card-dur-badge">${escapeHtml(duration)}</div>` : ''}<div class="video-card-expand-btn" title="影院全屏模式"><svg class="ui-icon-xs"><use href="#icon-fullscreen"/></svg></div></div>`;
}

function renderSharedMessageMedia(media) {
  if (media.type === 'contact') {
    const name = [media.contactFirstName, media.contactLastName].filter(Boolean).join(' ') || '联系人';
    const phone = media.contactPhone || '未提供电话号码';
    return `<div class="shared-message-card"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(phone)}</span></div>`;
  }
  if (media.type === 'location') {
    const title = media.locationTitle || (media.liveLocation ? '实时位置' : '位置');
    const address = media.locationAddress ? `<span>${escapeHtml(media.locationAddress)}</span>` : '';
    const lat = media.latitude;
    const lon = media.longitude;
    const valid = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    const details = valid
      ? `<a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&amp;mlon=${encodeURIComponent(lon)}#map=15/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}" target="_blank" rel="noopener noreferrer">在地图中打开</a>`
      : '<span>位置不可用</span>';
    return `<div class="shared-message-card"><strong>${escapeHtml(title)}</strong>${address}${details}</div>`;
  }
  if (media.type === 'game') {
    return `<div class="shared-message-card"><strong>${escapeHtml(media.gameTitle || 'Telegram 游戏')}</strong>${media.gameDescription ? `<span>${escapeHtml(media.gameDescription)}</span>` : ''}</div>`;
  }
  if (media.type === 'dice') {
    const emoji = ['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'].includes(media.diceEmoji) ? media.diceEmoji : '🎲';
    const value = Number(media.diceValue);
    const result = Number.isSafeInteger(value) && value > 0 ? `结果 ${value}` : '正在掷…';
    return `<div class="msg-dice-card" role="img" aria-label="${escapeHtml(`${emoji} ${result}`)}"><span class="msg-dice-emoji" aria-hidden="true">${escapeHtml(emoji)}</span><span class="msg-dice-result">${escapeHtml(result)}</span></div>`;
  }
  if (media.type === 'unsupported') return '<div class="shared-message-card">此消息类型暂不支持显示</div>';
  return '';
}

function renderSharedStoryMedia(media) {
  const peerId = Number(media?.storyChatId), storyId = Number(media?.storyId);
  if (!Number.isSafeInteger(peerId) || peerId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
    return '<div class="shared-message-card">此动态不可用</div>';
  }
  return `<button type="button" class="msg-story-share-card" aria-label="打开已分享的 Telegram 动态" onclick="event.stopPropagation(); openSharedTelegramStory(${inlineJsArg(peerId)}, ${inlineJsArg(storyId)}, ${media.storyIsSelf === true})"><svg class="ui-icon"><use href="#icon-story"/></svg><span><strong>Telegram 动态</strong><small>点击查看已分享的动态</small></span></button>`;
}

function renderTodoChecklist(media, message, chatId) {
  const items = Array.isArray(media.todoItems) ? media.todoItems.filter(item => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0) : [];
  if (!items.length) return '<div class="todo-list-card"><strong>Telegram 待办清单</strong><span>清单内容暂不可用，请刷新消息。</span></div>';
  const completions = new Map((Array.isArray(media.todoCompletions) ? media.todoCompletions : []).map(item => [Number(item.id), item]));
  const readOnly = Boolean(message.fwdFrom) || (!message.outgoing && !media.todoOthersCanComplete);
  const canAppend = !message.fwdFrom && (Boolean(message.outgoing) || Boolean(media.todoOthersCanAppend));
  const completeCount = items.filter(item => completions.has(Number(item.id))).length;
  const tasks = items.map(item => {
    const id = Number(item.id), completion = completions.get(id), complete = Boolean(completion);
    const titleText = String(item.title || '');
    const title = formatMessageContent(titleText, item.entities);
    const ariaTitle = escapeHtml(titleText);
    const completerId = Number(completion?.completedBy);
    const completerAvatar = Number.isSafeInteger(completerId) && completerId > 0 && typeof state !== 'undefined' && state.clientSelectedInstance
      ? `<img class="todo-task-completer-avatar" data-network-src="/api/instances/${encodeURIComponent(state.clientSelectedInstance)}/account/avatar?chatId=${completerId}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const doneBy = completion?.completedBy ? `<span class="todo-task-completed-by" title="由 Telegram 用户 ${escapeHtml(completion.completedBy)} 完成">${completerAvatar}Telegram 用户 ${escapeHtml(completion.completedBy)}</span>` : '';
    return `<button type="button" class="todo-task${complete ? ' completed' : ''}" role="checkbox" aria-checked="${complete}" aria-label="${escapeHtml(complete ? '取消完成：' : '标记完成：')}${ariaTitle}" ${readOnly ? 'disabled' : ''} onclick="event.stopPropagation(); toggleTelegramTodoTask(${inlineJsArg(chatId)}, ${inlineJsArg(message.id)}, ${id}, ${!complete})"><span class="todo-task-check" aria-hidden="true">${complete ? '✓' : ''}</span><span class="todo-task-title">${title}</span>${doneBy}</button>`;
  }).join('');
  const append = canAppend ? `<button type="button" class="todo-task-append" onclick="event.stopPropagation(); appendTelegramTodoTask(${inlineJsArg(chatId)}, ${inlineJsArg(message.id)})">＋ 添加任务</button>` : '';
  const edit = message.outgoing && !message.fwdFrom
    ? `<button type="button" class="todo-task-append" onclick="event.stopPropagation(); editTelegramTodoList(${inlineJsArg(chatId)}, ${inlineJsArg(message.id)})">编辑清单</button>` : '';
  const title = formatMessageContent(String(media.todoTitle || ''), media.todoTitleEntities) || '待办清单';
  return `<section class="todo-list-card" aria-label="Telegram 待办清单"><header class="todo-list-header"><strong>${title}</strong><span>${completeCount}/${items.length}</span></header><div class="todo-task-list">${tasks}</div><footer class="todo-list-actions">${append}${edit}</footer></section>`;
}

function renderPaidMediaItems(media, instId, chatId, messageId, senderName) {
  const items = Array.isArray(media.paidMediaItems) ? media.paidMediaItems : [];
  if (!items.length) return '<div class="paid-media-unlocked">已解锁的媒体暂时不可预览，请刷新消息。</div>';
  return items.map((item, index) => {
    const params = new URLSearchParams({ chatId: String(chatId), messageId: String(messageId), mediaIndex: String(index) });
    const url = `/api/instances/${encodeURIComponent(instId)}/account/media?${params}`;
    const thumbUrl = `${url}&thumb=1`;
    if (item.type === 'photo') return `<div class="msg-media-wrap photo"><img class="msg-media-photo" data-network-src="${escapeHtml(thumbUrl)}" alt="付费照片 ${index + 1}" loading="lazy" onclick="openLightbox(${inlineJsArg(url)}, ${inlineJsArg(senderName)})"></div>`;
    if (item.type === 'video') return `<video class="paid-media-video" controls preload="none" playsinline data-network-poster="${escapeHtml(thumbUrl)}" src="${escapeHtml(url)}" aria-label="付费视频 ${index + 1}"></video>`;
    if (item.type === 'animation') return renderAnimationMedia(item, url);
    if (item.type === 'audio' || item.type === 'voice') return `<audio class="paid-media-audio" controls preload="none" src="${escapeHtml(url)}"></audio>`;
    const filename = item.fileName || `付费媒体 ${index + 1}`;
    return `<a class="btn btn-secondary btn-sm paid-media-file" href="${escapeHtml(url)}&download=1" download="${escapeHtml(filename)}">下载 ${escapeHtml(filename)}</a>`;
  }).join('');
}

async function buyChatPaidMedia(chatId, messageId) {
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  if (!instId || !isCurrent()) return;
  try {
    const payment = await api(`/api/instances/${encodeURIComponent(instId)}/account/paid-media/prepare`, 'POST', { chatId, messageId });
    if (!isCurrent()) return;
    const stars = String(payment?.stars || '');
    const count = Number(payment?.itemCount) || 1;
    if (!/^\d{1,13}$/.test(stars) || !payment?.token) throw new Error('Telegram 未返回有效的 Stars 付款金额');
    const details = [payment.title, payment.description, `解锁 ${count} 项媒体需支付 ${stars} Stars。付款由 Telegram 处理，确认后立即扣款。`]
      .filter(Boolean).join('\n\n');
    if (!window.confirm(details)) return;
    if (!isCurrent()) return;
    await api(`/api/instances/${encodeURIComponent(instId)}/account/paid-media/confirm`, 'POST', { chatId, messageId, token: payment.token });
    if (isCurrent()) await loadClientMessages(Number(chatId), true);
  } catch (error) {
    if (isCurrent()) showToast(`付费媒体付款失败：${error.message}`, 'error');
  }
}

async function createTelegramTodoList() {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  if (!instId || !chatId) return showToast('请先打开一个 Telegram 会话。', 'warn');
  const isCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  const title = window.prompt('待办清单标题（最多 255 个字符）');
  if (title == null) return;
  const taskInput = window.prompt('每行输入一个任务（1 到 10 项，每项最多 255 个字符）');
  if (taskInput == null) return;
  const tasks = taskInput.split(/\r?\n/).map(task => task.trim()).filter(Boolean);
  if (!title.trim() || title.trim().length > 255 || tasks.length < 1 || tasks.length > 10 || tasks.some(task => task.length > 255)) {
    return showToast('标题或任务数量、长度无效。', 'error');
  }
  const dialog = (state.clientDialogs || []).find(item => String(item.id) === String(chatId));
  const shareable = ['group', 'supergroup', 'channel'].includes(dialog?.type);
  const othersCanComplete = shareable && window.confirm('允许其他成员标记清单任务为已完成？');
  const othersCanAppend = shareable && window.confirm('允许其他成员向清单添加任务？');
  if (!isCurrent()) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/todo/create`, 'POST', {
      chatId, title: title.trim(), tasks, othersCanComplete, othersCanAppend,
    });
    if (!isCurrent()) return;
    showToast('Telegram 待办清单已发送。', 'success');
    await loadClientMessages(Number(chatId), true);
  } catch (error) {
    if (isCurrent()) showToast(`发送待办清单失败：${error.message}`, 'error');
  }
}

async function toggleTelegramTodoTask(chatId, messageId, taskId, completed) {
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  if (!instId || String(state.clientActiveChatId) !== String(chatId) || !Number.isSafeInteger(Number(messageId)) ||
      !Number.isSafeInteger(Number(taskId)) || taskId < 1 || typeof completed !== 'boolean') return;
  const key = JSON.stringify([instId, chatId, messageId, taskId]);
  if (pendingTodoToggles.has(key)) return;
  pendingTodoToggles.add(key);
  const isCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/todo/toggle`, 'POST', {
      chatId, messageId: Number(messageId), taskId: Number(taskId), completed,
    });
    if (isCurrent()) await loadClientMessages(Number(chatId), true);
  } catch (error) {
    if (isCurrent()) showToast(`更新待办任务失败：${error.message}`, 'error');
  } finally {
    pendingTodoToggles.delete(key);
  }
}

async function appendTelegramTodoTask(chatId, messageId) {
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  if (!instId || String(state.clientActiveChatId) !== String(chatId)) return;
  const rawTasks = window.prompt('输入要添加的任务，每行一项（最多 10 项）');
  if (rawTasks == null) return;
  const tasks = rawTasks.split(/\r?\n/).map(task => task.trim()).filter(Boolean);
  if (!tasks.length || tasks.length > 10 || tasks.some(task => task.length > 255)) return showToast('请输入 1 到 10 个有效任务。', 'error');
  const isCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  if (!isCurrent()) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/todo/append`, 'POST', { chatId, messageId: Number(messageId), tasks });
    if (isCurrent()) await loadClientMessages(Number(chatId), true);
  } catch (error) {
    if (isCurrent()) showToast(`添加待办任务失败：${error.message}`, 'error');
  }
}

function editTelegramTodoList(chatId, messageId) {
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  const message = state.clientMessages.find(item => String(item.id) === String(messageId));
  if (!instId || String(state.clientActiveChatId) !== String(chatId) || !message?.outgoing || message.fwdFrom || message.media?.type !== 'todo') return;
  const isCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  const overlay = document.createElement('div'); overlay.className = 'todo-editor-overlay';
  const dialog = document.createElement('section'); dialog.className = 'todo-editor-dialog'; dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'todo-editor-heading');
  const heading = document.createElement('h3'); heading.id = 'todo-editor-heading'; heading.textContent = '编辑待办清单';
  const titleLabel = document.createElement('label'); titleLabel.className = 'todo-editor-label'; titleLabel.textContent = '标题';
  const titleInput = document.createElement('input'); titleInput.className = 'form-input'; titleInput.type = 'text';
  titleInput.maxLength = 255; titleInput.value = String(message.media.todoTitle || ''); titleLabel.appendChild(titleInput);
  const list = document.createElement('div'); list.className = 'todo-editor-items';
  const status = document.createElement('div'); status.className = 'todo-editor-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const add = document.createElement('button'); add.type = 'button'; add.className = 'todo-editor-add'; add.textContent = '＋ 添加任务';
  const permissions = document.createElement('div'); permissions.className = 'todo-editor-permissions';
  const makePermission = (text, checked) => {
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(checked);
    label.append(input, document.createTextNode(text));
    permissions.appendChild(label);
    return input;
  };
  const canComplete = makePermission('允许其他成员标记任务完成', message.media.todoOthersCanComplete);
  const canAppend = makePermission('允许其他成员添加任务', message.media.todoOthersCanAppend);
  const actions = document.createElement('div'); actions.className = 'todo-editor-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = '取消';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary'; save.textContent = '保存';
  actions.append(cancel, save);
  dialog.append(heading, titleLabel, list, add, permissions, status, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  let closed = false;
  const close = () => { if (closed) return; closed = true; overlay.remove(); };
  const addRow = (item = {}) => {
    if (list.children.length >= 10) return;
    const row = document.createElement('div'); row.className = 'todo-editor-item';
    if (Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0) row.dataset.taskId = String(item.id);
    const input = document.createElement('input'); input.className = 'form-input'; input.type = 'text'; input.maxLength = 255;
    input.value = String(item.title || ''); input.setAttribute('aria-label', '待办任务');
    const moveUp = document.createElement('button'); moveUp.type = 'button'; moveUp.className = 'btn btn-secondary btn-xs'; moveUp.textContent = '↑'; moveUp.setAttribute('aria-label', '上移任务');
    const moveDown = document.createElement('button'); moveDown.type = 'button'; moveDown.className = 'btn btn-secondary btn-xs'; moveDown.textContent = '↓'; moveDown.setAttribute('aria-label', '下移任务');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary btn-xs'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除任务');
    moveUp.onclick = () => { const previous = row.previousElementSibling; if (previous) list.insertBefore(row, previous); updateRows(); };
    moveDown.onclick = () => { const next = row.nextElementSibling; if (next) list.insertBefore(next, row); updateRows(); };
    remove.onclick = () => { row.remove(); updateRows(); };
    row.append(input, moveUp, moveDown, remove); list.appendChild(row); updateRows();
  };
  const updateRows = () => {
    const rows = [...list.children];
    rows.forEach((row, index) => {
      row.querySelector('[aria-label="上移任务"]').disabled = index === 0;
      row.querySelector('[aria-label="下移任务"]').disabled = index === rows.length - 1;
    });
    add.disabled = rows.length >= 10;
    if (!rows.length) status.textContent = '至少保留一个任务。';
    else if (rows.length >= 10) status.textContent = 'Telegram 待办清单最多包含 10 项。';
    else status.textContent = '';
  };
  for (const item of message.media.todoItems || []) addRow(item);
  add.onclick = () => { addRow(); list.lastElementChild?.querySelector('input')?.focus(); };
  cancel.onclick = close;
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  save.onclick = async () => {
    if (!isCurrent()) return close();
    const rows = [...list.children];
    const tasks = rows.map(row => {
      const title = row.querySelector('input').value.trim();
      return { ...(row.dataset.taskId ? { id: Number(row.dataset.taskId) } : {}), title };
    });
    if (!titleInput.value.trim() || titleInput.value.trim().length > 255 || !tasks.length ||
        tasks.some(task => !task.title || task.title.length > 255)) {
      status.textContent = '标题和任务不能为空，且每项最多 255 个字符。';
      return;
    }
    save.disabled = true; cancel.disabled = true; add.disabled = true;
    status.textContent = '正在保存 Telegram 待办清单…';
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/todo/edit`, 'POST', {
        chatId, messageId: Number(messageId), title: titleInput.value.trim(), tasks,
        othersCanComplete: canComplete.checked, othersCanAppend: canAppend.checked,
      });
      if (!isCurrent()) return close();
      close();
      await loadClientMessages(Number(chatId), true);
    } catch (error) {
      if (!isCurrent()) return close();
      status.textContent = `保存待办清单失败：${error.message}`;
      save.disabled = false; cancel.disabled = false; add.disabled = list.children.length >= 10;
    }
  };
  titleInput.focus();
}

function getMessageAlbumGroupId(messages, index, filtering = false) {
  if (filtering || !Array.isArray(messages) || index < 0 || index >= messages.length) return '';
  const message = messages[index];
  const groupId = String(message?.groupedId || '');
  if (!groupId || !['photo', 'video'].includes(message?.media?.type)) return '';
  const isSameAlbumMedia = candidate => String(candidate?.groupedId || '') === groupId &&
    ['photo', 'video'].includes(candidate?.media?.type);
  return isSameAlbumMedia(messages[index - 1]) || isSameAlbumMedia(messages[index + 1]) ? groupId : '';
}

async function openTelegramGiftCode(slug, expectedInstId, expectedChatId) {
  if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) return;
  const instId = expectedInstId || state.clientSelectedInstance;
  const chatId = expectedChatId ?? state.clientActiveChatId;
  if (!instId || instId !== state.clientSelectedInstance || String(chatId) !== String(state.clientActiveChatId)) return;
  const stillCurrent = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId);
  try {
    const preview = await api(`/api/instances/${encodeURIComponent(instId)}/account/gift-codes/check`, 'POST', { slug });
    if (!stillCurrent()) return;
    if (preview.usedDate) return showToast('此 Telegram Premium 礼物链接已被使用。', 'info');
    if (!preview.recipientMatches) return showToast('此礼物链接指定给其他 Telegram 账号。', 'warn');
    const issued = preview.date ? `\n发放日期：${new Date(preview.date * 1000).toLocaleDateString()}` : '';
    const confirmation = `Telegram Premium 礼物\n${preview.months} 个月${preview.viaGiveaway ? '（Telegram 抽奖）' : ''}${issued}\n\n确认在当前账号激活？`;
    if (!window.confirm(confirmation) || !stillCurrent()) return;
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/gift-codes/apply`, 'POST', { slug });
    if (!stillCurrent()) return;
    if (!result || result.applied !== true) throw new Error('Telegram 未确认礼物已激活');
    showToast(`已激活 ${result.months} 个月 Telegram Premium。`, 'success');
  } catch (error) {
    if (stillCurrent()) showToast(`无法激活 Premium 礼物：${error.message}`, 'error');
  }
}

function renderClientMessages(preserveScroll = false) {
  const container = document.getElementById('client-messages-container');
  if (!container) return;
  window.BotKeyboard?.renderReply();
  if (state.clientMessages.length === 0) {
    container.innerHTML = '<div class="chat-placeholder"><p>该会话暂无历史消息记录</p></div>';
    return;
  }

  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const q = (state.clientSearchQuery || '').toLowerCase().trim();

  let list = state.clientMessages;
  if (q) {
    list = list.filter((m) =>
      (m.text && m.text.toLowerCase().includes(q)) ||
      (m.from?.firstName && m.from.firstName.toLowerCase().includes(q)) ||
      (m.from?.username && m.from.username.toLowerCase().includes(q)) ||
      (m.media?.fileName && m.media.fileName.toLowerCase().includes(q)) ||
      (m.media?.title && m.media.title.toLowerCase().includes(q))
    );
  }

  if (list.length === 0) {
    container.innerHTML = '<div class="chat-placeholder"><p>未在当前聊天中检索到匹配的消息</p></div>';
    return;
  }

  container.innerHTML = '';
  container.classList.toggle('selection-mode', Boolean(state.isSelectionMode));

  // Pre-compute message grouping info
  const msgMeta = [];
  let lastDate = '';
  let lastSenderId = null;
  let lastTime = 0;
  let activeAlbumId = '';
  let activeAlbumContainer = null;

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const msgDate = new Date(m.date || Date.now());
    const dateKey = msgDate.toDateString();
    const isNewDate = dateKey !== lastDate;
    const time = m.date || 0;
    const isService = Boolean(m.service);

    // Grouping: same sender, within 5 min, same date, not service, not first
    const canGroup = !isNewDate && !isService && lastSenderId === m.from?.id &&
      (time - lastTime) < 5 * 60 * 1000 && time >= lastTime && lastSenderId !== null;

    // Is this the last message in a group? (next message doesn't group with this)
    const nextM = list[i + 1];
    const nextGroups = nextM && !nextM.service &&
      nextM.from?.id === m.from?.id &&
      (nextM.date - time) < 5 * 60 * 1000 &&
      new Date(nextM.date).toDateString() === dateKey;

    msgMeta.push({
      isNewDate,
      dateKey,
      isService,
      isFirstInGroup: !canGroup,
      isLastInGroup: !nextGroups,
      showAvatar: !isService && (!nextGroups || !canGroup),
    });

    lastDate = dateKey;
    lastSenderId = isService ? null : m.from?.id;
    lastTime = time;
  }

  for (let mi = 0; mi < list.length; mi++) {
    const m = list[mi];
    const meta = msgMeta[mi];
    const isOut = Boolean(m.outgoing);
    const albumId = getMessageAlbumGroupId(list, mi, Boolean(q));
    if (meta.isNewDate) { activeAlbumId = ''; activeAlbumContainer = null; }
    const startsAlbum = Boolean(albumId && (albumId !== activeAlbumId || !activeAlbumContainer));
    const isSelected = state.selectedMsgIds && state.selectedMsgIds.has(m.id);
    const wrap = document.createElement('div');

    // Date separator
    if (meta.isNewDate) {
      const sepDate = new Date(m.date || Date.now());
      const today = new Date();
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      let dateLabel;
      if (sepDate.toDateString() === today.toDateString()) dateLabel = '今天';
      else if (sepDate.toDateString() === yesterday.toDateString()) dateLabel = '昨天';
      else dateLabel = sepDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

      const sep = document.createElement('div');
      sep.className = 'msg-date-sep';
      sep.innerHTML = `<span>${dateLabel}</span>`;
      container.appendChild(sep);
    }

    // Service message
    if (meta.isService && m.service) {
      activeAlbumId = ''; activeAlbumContainer = null;
      wrap.className = 'msg-service-wrap';
      wrap.id = `chat-msg-${m.id}`;
      wrap.dataset.msgId = m.id;
      const serviceCard = document.createElement('div');
      serviceCard.className = 'msg-service';
      const text = document.createElement('span');
      text.textContent = String(m.service.text || m.text || '系统消息');
      serviceCard.appendChild(text);
      const giftCode = m.service.giftCode;
      if (giftCode && typeof giftCode.slug === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(giftCode.slug)) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'msg-gift-code-action';
        action.textContent = giftCode.unclaimed ? '查看并激活礼物' : '查看礼物';
        action.setAttribute('aria-label', `查看 ${Number(giftCode.months) || ''} 个月 Telegram Premium 礼物`);
        action.addEventListener('click', () => { void openTelegramGiftCode(giftCode.slug, state.clientSelectedInstance, state.clientActiveChatId); });
        serviceCard.appendChild(action);
      }
      wrap.appendChild(serviceCard);
      container.appendChild(wrap);
      continue;
    }
    if (!albumId) {
      activeAlbumId = ''; activeAlbumContainer = null;
    } else if (startsAlbum) {
      activeAlbumId = albumId;
      activeAlbumContainer = document.createElement('div');
      activeAlbumContainer.className = `chat-album-group ${isOut ? 'outgoing' : 'incoming'}`;
      activeAlbumContainer.dataset.groupedId = albumId;
      container.appendChild(activeAlbumContainer);
    }
    const renderTarget = albumId ? activeAlbumContainer : container;
    wrap.className = `chat-bubble-wrap ${isOut ? 'outgoing' : 'incoming'} ${isSelected ? 'selected' : ''} ${meta.isFirstInGroup ? 'group-start' : 'group-mid'} ${meta.isLastInGroup ? 'group-end' : ''}`;
    wrap.id = `chat-msg-${m.id}`;
    wrap.dataset.msgId = m.id;
    wrap.dataset.isOut = isOut ? '1' : '0';
    wrap.dataset.msgText = m.text || '';
    wrap.dataset.isPinned = m.pinned ? '1' : '0';
    if (albumId) wrap.dataset.groupedId = albumId;

    wrap.onclick = (e) => {
      if (state.isSelectionMode) {
        e.stopPropagation();
        toggleSelectMessage(m.id);
      }
    };

    // Double-click to quick-react with 👍 (official Telegram behavior)
    wrap.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (!state.isSelectionMode) {
        quickToggleReaction(m.id, '👍');
      }
    });

    const senderId = m.from?.id;
    const senderName = isOut ? '我' : m.from?.firstName || m.from?.username || `UID:${m.from?.id || '?'}`;
    const initials = (m.from?.firstName || m.from?.username || 'TG').slice(0, 2);
    const senderColor = senderId ? getSenderNameColor(senderId) : '#93c5fa';
    const avatarBg = senderId ? getSenderAvatarColor(senderId) : 'var(--color-primary)';
    const avatarUrl = senderId ? `/api/instances/${instId}/account/avatar?chatId=${senderId}` : '';
    const timeStr = m.date
      ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    if (startsAlbum && !isOut) {
      const albumSender = document.createElement('div');
      albumSender.className = 'chat-album-sender';
      albumSender.textContent = senderName;
      albumSender.style.color = senderColor;
      renderTarget.appendChild(albumSender);
    }

    // Forward quote header
    let forwardHeaderHtml = '';
    if (m.fwdFrom) {
      const fwdSender = m.fwdFrom.fromName || (m.fwdFrom.fromId ? `ID:${m.fwdFrom.fromId}` : '未知来源');
      forwardHeaderHtml = `
        <div class="msg-forward-header">
          <svg class="ui-icon-xs" style="width:12px;height:12px;display:inline-block;vertical-align:-1px;margin-right:2px;"><use href="#icon-share"/></svg>
          <span>转发自 <strong>${escapeHtml(fwdSender)}</strong></span>
        </div>
      `;
    }

    // Reply quote block
    let replyQuoteHtml = '';
    if (m.isReply && m.replyToMessageId) {
      const orig = state.clientMessages.find((x) => x.id === m.replyToMessageId);
      const origSender = orig ? (orig.outgoing ? '我' : orig.from?.firstName || orig.from?.username || `UID:${orig.from?.id || '?'}`) : `消息 #${m.replyToMessageId}`;
      const origSnippet = orig ? (orig.text || (orig.media ? `[${orig.media.type}]` : '媒体消息')) : '点击定位原消息';
      replyQuoteHtml = `
        <div class="msg-reply-quote" onclick="scrollToMessage(${inlineJsArg(m.replyToMessageId)})">
          <div class="msg-reply-bar"></div>
          <div class="msg-reply-content">
            <div class="msg-reply-sender">${escapeHtml(origSender)}</div>
            <div class="msg-reply-text">${escapeHtml(origSnippet)}</div>
          </div>
        </div>
      `;
    }

    // Media attachment block
    let mediaHtml = '';
    if (m.media) {
      const media = m.media;
      if (media.type === 'paid_media') {
        if (media.paidMediaLocked !== false) {
          const itemCount = Math.max(1, Math.min(10, Number(media.paidMediaItemCount) || 1));
          const stars = /^\d{1,13}$/.test(String(media.paidMediaStars || '')) ? media.paidMediaStars : '?';
          mediaHtml = `<div class="paid-media-card"><div class="paid-media-lock" aria-hidden="true">🔒</div><div><strong>付费媒体</strong><span>${itemCount} 项内容 · ${escapeHtml(stars)} Stars</span></div><button type="button" class="btn btn-primary btn-sm" onclick="event.stopPropagation(); buyChatPaidMedia(${inlineJsArg(chatId)}, ${inlineJsArg(m.id)})">支付并查看</button></div>`;
        } else {
          mediaHtml = `<div class="paid-media-unlocked">${renderPaidMediaItems(media, instId, chatId, m.id, senderName)}</div>`;
        }
      } else if (media.type === 'todo') {
        mediaHtml = renderTodoChecklist(media, m, chatId);
      } else if (media.type === 'photo') {
        const thumbUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
        const fullUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        mediaHtml = `
          <div class="msg-media-wrap photo">
            <img class="msg-media-photo" data-network-src="${escapeHtml(thumbUrl)}" alt="Photo" loading="lazy" onclick="openLightbox(${inlineJsArg(fullUrl)}, ${inlineJsArg(senderName)})">
          </div>
        `;
      } else if (media.type === 'video') {
        mediaHtml = renderTelegramVideoMedia(media, instId, chatId, m.id, senderName, timeStr);
      } else if (media.type === 'animation') {
        const animationUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        mediaHtml = renderAnimationMedia(media, animationUrl);
      } else if (media.type === 'story') {
        mediaHtml = renderSharedStoryMedia(media);
      } else if (media.type === 'location' || media.type === 'contact' || media.type === 'game' || media.type === 'dice' || media.type === 'unsupported') {
        mediaHtml = renderSharedMessageMedia(media);
        if (media.type === 'location' && media.liveLocation && isOut) {
          mediaHtml += `<button type="button" class="btn btn-secondary btn-xs live-location-stop" data-stop-live-location="1" data-chat-id="${escapeHtml(chatId)}" data-message-id="${escapeHtml(m.id)}">停止共享实时位置</button>`;
        }
      } else if (media.type === 'audio') {
        const audioUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const trackTitle = media.title || media.fileName || '未知音频';
        const trackArtist = media.performer || senderName || '未知艺术家';
        const durationStr = media.duration ? formatDurationSec(media.duration) : '';
        mediaHtml = `
          <div class="msg-audio-card">
            <div class="audio-card-icon"><svg class="ui-icon"><use href="#icon-music"/></svg></div>
            <div class="audio-card-info">
              <div class="audio-title" title="${escapeHtml(trackTitle)}">${escapeHtml(trackTitle)}</div>
              <div class="audio-artist">${escapeHtml(trackArtist)}${durationStr ? ' · ' + durationStr : ''}</div>
            </div>
            <div class="audio-card-actions">
              <button class="btn btn-primary btn-xs" onclick="playTrackDirect(${inlineJsArg(trackTitle)}, ${inlineJsArg(trackArtist)}, ${inlineJsArg(audioUrl)}, ${inlineJsArg(m.id)})">播放</button>
              <button class="btn btn-secondary btn-xs" onclick="addTrackToPlaylist(${inlineJsArg(trackTitle)}, ${inlineJsArg(trackArtist)}, ${inlineJsArg(audioUrl)}, ${inlineJsArg(m.id)})">加歌单</button>
            </div>
          </div>
        `;
      } else if (media.type === 'voice') {
        const voiceUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const voiceDur = media.duration ? formatDurationSec(media.duration) : '语音';
        const waveformBars = generateWaveformBarsHtml(m.id, m.id, media.waveform);
        mediaHtml = `
          <div class="msg-voice-card" id="voice-card-${escapeHtml(m.id)}">
            <button class="voice-play-btn" onclick="toggleVoicePlay(this, ${inlineJsArg(voiceUrl)}, ${inlineJsArg(m.id)})" title="播放语音">
              <svg class="ui-icon-sm"><use href="#icon-play"/></svg>
            </button>
            <div class="voice-waveform-wrap">
              ${waveformBars}
              <div class="voice-time-label" id="voice-time-${escapeHtml(m.id)}">${escapeHtml(voiceDur)}</div>
            </div>
            <button class="voice-speed-btn" onclick="toggleVoiceSpeed(this, ${inlineJsArg(m.id)})" title="切换播放倍速">1.0x</button>
          </div>
          <div class="voice-transcription" id="voice-transcription-${escapeHtml(m.id)}">
            <button type="button" class="btn btn-secondary btn-xs" data-transcribe-action onclick="transcribeVoiceMessage(${inlineJsArg(chatId)}, ${inlineJsArg(m.id)})">转文字</button>
            <div class="voice-transcription-status" data-transcription-status role="status" hidden></div>
            <div class="voice-transcription-text" data-transcription-text hidden></div>
            <div class="voice-transcription-rating" data-transcription-rating hidden><span>转写有帮助吗？</span><button type="button" class="btn btn-secondary btn-xs" data-transcription-good aria-label="转写有帮助">👍</button><button type="button" class="btn btn-secondary btn-xs" data-transcription-bad aria-label="转写没有帮助">👎</button></div>
          </div>
        `;
      } else if (media.type === 'poll') {
        mediaHtml = renderPollCardHtml(media, m.id, chatId, isOut);
      } else if (media.type === 'document') {
        const docUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&download=1`;
        const fileName = media.fileName || 'Document';
        const fileSizeStr = media.fileSize ? formatBytes(media.fileSize) : '';
        mediaHtml = `
          <div class="msg-doc-card">
            <div class="doc-icon"><svg class="ui-icon"><use href="#icon-file"/></svg></div>
            <div class="doc-info">
              <div class="doc-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
              <div class="doc-size">${fileSizeStr}</div>
            </div>
            <a class="btn btn-secondary btn-xs doc-download-btn" href="${escapeHtml(docUrl)}" download="${escapeHtml(fileName)}" target="_blank" title="下载原文件">
              <svg class="ui-icon-sm"><use href="#icon-download"/></svg>
              <span>下载</span>
            </a>
          </div>
        `;
      } else if (media.type === 'sticker') {
        const setId = media.stickerSetId || '';
        const accessHash = media.stickerAccessHash || '';
        const shortName = media.stickerShortName || '';
        const isVideo = Boolean(media.isVideoSticker || (media.mimeType && media.mimeType.includes('webm')));
        if (isVideo) {
          const videoUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
          mediaHtml = `
            <div class="msg-media-wrap sticker sticker-bubble" data-set-id="${escapeHtml(setId)}" data-access-hash="${escapeHtml(accessHash)}" data-short-name="${escapeHtml(shortName)}" title="点击查看与安装此贴纸包">
              <video class="msg-media-sticker video-sticker" data-network-autoplay="${escapeHtml(videoUrl)}" data-network-poster="${escapeHtml(videoUrl + '&thumb=1')}" loop muted playsinline disablePictureInPicture></video>
            </div>
          `;
        } else {
          const stickerUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
          mediaHtml = `
            <div class="msg-media-wrap sticker sticker-bubble" data-set-id="${escapeHtml(setId)}" data-access-hash="${escapeHtml(accessHash)}" data-short-name="${escapeHtml(shortName)}" title="点击查看与安装此贴纸包">
              <img class="msg-media-sticker" data-network-src="${escapeHtml(stickerUrl)}" alt="Sticker" loading="lazy">
            </div>
          `;
        }
      }
    }

    // Text content
    let textHtml = '';
    if (m.text) {
      textHtml = `<div class="chat-bubble-text">${formatMessageContent(m.text, m.entities)}</div>`;
      if (typeof m.autoTranslatedText === 'string' && m.autoTranslatedText) {
        textHtml += `<div class="msg-translated-wrap auto"><div class="msg-translated-header"><span>Telegram 自动翻译</span></div><div class="msg-translated-body">${escapeHtml(m.autoTranslatedText).replace(/\n/g, '<br>')}</div></div>`;
      }
    }

    let factChecksHtml = '';
    const factChecks = Array.isArray(m.factChecks) ? m.factChecks : [];
    if (factChecks.length) {
      const requiresCheck = factChecks.some(item => item?.needCheck === true) && m.factCheckLoaded !== true;
      if (requiresCheck) {
        const country = factChecks.find(item => typeof item?.country === 'string')?.country;
        const loading = m.factCheckLoading === true;
        factChecksHtml = `<div class="msg-fact-check-wrap"><span class="msg-fact-check-label">事实核查</span>${country ? `<span class="msg-fact-check-country">${escapeHtml(country)}</span>` : ''}<button type="button" class="msg-fact-check-button" ${loading ? 'disabled' : ''} onclick="event.stopPropagation(); loadMessageFactCheck(${inlineJsArg(m.id)})">${loading ? '正在读取…' : '查看核查说明'}</button>${m.factCheckError ? `<span class="msg-fact-check-error">${escapeHtml(m.factCheckError)}</span>` : ''}</div>`;
      } else {
        const items = factChecks.filter(item => typeof item?.text === 'string' && item.text).map(item => `
          <div class="msg-fact-check-item">${item.country ? `<span class="msg-fact-check-country">${escapeHtml(item.country)}</span>` : ''}<div>${formatMessageContent(item.text, item.entities)}</div></div>`).join('');
        factChecksHtml = items
          ? `<div class="msg-fact-check-wrap"><span class="msg-fact-check-label">事实核查</span>${items}</div>`
          : m.factCheckLoaded === true ? '<div class="msg-fact-check-wrap"><span class="msg-fact-check-label">Telegram 暂未提供核查说明</span></div>' : '';
      }
    }

    // Status tick for outgoing (Telegram-style: ✓ sent, ✓✓ read)
    let statusTickHtml = '';
    if (isOut) {
      if (m.status === 'pending') {
        statusTickHtml = `<span class="msg-status-tick pending" title="正在发送...">⏱</span>`;
      } else if (m.status === 'failed') {
        statusTickHtml = `<span class="msg-status-tick failed" title="发送失败">✕</span>`;
      } else if (isOutgoingMessageRead(m, chatId)) {
        statusTickHtml = `<span class="msg-status-tick read" title="已读">✓✓</span>`;
      } else {
        statusTickHtml = `<span class="msg-status-tick sent" title="已送达">✓</span>`;
      }
    }

    // Reactions
    let reactionsHtml = '';
    if (m.reactions && Array.isArray(m.reactions) && m.reactions.length > 0) {
      const badges = m.reactions.map((r) => {
        const chosenClass = r.chosen ? 'chosen' : '';
        const emoji = r.emoji || r.emoticon || '❤️';
        const customEmojiId = /^[1-9]\d{0,19}$/.test(String(r.customEmojiId || '')) ? String(r.customEmojiId) : '';
        const reaction = customEmojiId ? `custom:${customEmojiId}` : emoji;
        const icon = customEmojiId
          ? `<img class="reaction-custom-emoji" data-network-src="/api/instances/${encodeURIComponent(instId)}/account/custom-emoji?documentId=${encodeURIComponent(customEmojiId)}" alt="${escapeHtml(emoji)}" loading="lazy">`
          : escapeHtml(emoji);
        return `<span class="reaction-badge ${chosenClass}"><button type="button" class="reaction-toggle" title="回应 ${escapeHtml(emoji)}" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, ${inlineJsArg(reaction)})"><span class="reaction-emoji">${icon}</span></button><button type="button" class="reaction-count" title="查看谁回应了 ${escapeHtml(emoji)}" onclick="event.stopPropagation(); showMessageReactionUsers(${inlineJsArg(chatId)}, ${inlineJsArg(m.id)}, ${inlineJsArg(reaction)})">${escapeHtml(r.count)}</button></span>`;
      }).join('');
      reactionsHtml = `<div class="msg-reactions-wrap">${badges}</div>`;
    }

    // Channel comments button
    let commentsHtml = '';
    if (m.commentsEnabled) {
      commentsHtml = `
        <div class="msg-comments-btn" onclick="event.stopPropagation(); showComments(${inlineJsArg(m.id)}, ${inlineJsArg(chatId)})">
          <svg class="ui-icon-xs" style="width:12px;height:12px;"><use href="#icon-chat"/></svg>
          <span>${m.replies ? `${escapeHtml(m.replies)} 条评论` : '发表评论'}</span>
        </div>
      `;
    }

    const isPureMedia = Boolean(m.media && ['photo', 'video', 'animation', 'sticker'].includes(m.media.type) && (!m.text || !m.text.trim()) && !m.isReply && !m.replyToMessageId && !m.fwdFrom);
    const isSticker = Boolean(m.media && m.media.type === 'sticker');
    const isWebpage = Boolean(m.media && m.media.type === 'webpage');
    const bubbleClass = `chat-bubble ${isPureMedia ? 'pure-media-bubble' : ''} ${isSticker ? 'sticker-bubble-transparent' : ''} ${meta.isLastInGroup ? 'group-tail' : 'grouped'} ${isOut ? 'out' : 'in'}`;

    // Webpage link preview
    if (isWebpage) {
      const web = m.media;
      mediaHtml = `
        <div class="msg-link-preview">
          ${web.webPhotoThumb ? `<div class="msg-link-thumb"><div class="msg-link-thumb-placeholder"></div></div>` : ''}
          <div class="msg-link-info">
            ${web.webSiteName ? `<div class="msg-link-site">${escapeHtml(web.webSiteName)}</div>` : ''}
            ${web.webTitle ? `<div class="msg-link-title">${escapeHtml(web.webTitle)}</div>` : ''}
            ${web.webDescription ? `<div class="msg-link-desc">${escapeHtml(web.webDescription)}</div>` : ''}
          </div>
        </div>
      `;
    }

    let senderHeaderHtml = '';
    if (!isOut && meta.isFirstInGroup && !albumId) {
      senderHeaderHtml = `<div class="chat-bubble-sender" style="color: ${senderColor}; cursor: pointer;" onclick="event.stopPropagation(); loadPeerProfile(${inlineJsArg(senderId)})">${escapeHtml(senderName)}</div>`;
    }

    wrap.innerHTML = `
      <div class="msg-select-checkbox">
        <svg class="ui-icon-xs"><use href="#icon-check"/></svg>
      </div>
      <div class="quick-reaction-hover-pill">
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, '👍')">👍</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, '❤️')">❤️</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, '🔥')">🔥</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, '🎉')">🎉</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction(${inlineJsArg(m.id)}, '😂')">😂</button>
      </div>
      <div class="msg-row-inner">
        ${!isOut && senderId && !meta.isLastInGroup ? '<div class="msg-sender-avatar-spacer" aria-hidden="true"></div>' : ''}
        ${!isOut && senderId && meta.isLastInGroup ? `
          <div class="msg-sender-avatar-wrap" onclick="event.stopPropagation(); loadPeerProfile(${inlineJsArg(senderId)})" title="${escapeHtml(senderName)} (点击查看资料)">
            <img class="msg-sender-avatar-img" data-network-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy"
                 onload="this.classList.add('loaded'); if (this.nextElementSibling) this.nextElementSibling.style.display='none';"
                 onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
            <div class="msg-sender-avatar-initials" style="background:${avatarBg};">${escapeHtml(initials)}</div>
          </div>
        ` : ''}
        <div class="msg-content-column">
          ${senderHeaderHtml}
          <div class="${bubbleClass}">
            ${forwardHeaderHtml}
            ${replyQuoteHtml}
            ${mediaHtml}
            ${textHtml}
            ${factChecksHtml}
            <div class="chat-bubble-meta">
              <span>${timeStr}</span>
              ${statusTickHtml}
            </div>
          </div>
          ${reactionsHtml}
          ${commentsHtml}
        </div>
      </div>
    `;

    if (window.BotKeyboard) window.BotKeyboard.mount(wrap.querySelector('.msg-content-column'), m, instId, chatId);

    const stickerBubble = wrap.querySelector('.sticker-bubble');
    if (stickerBubble) {
      stickerBubble.onclick = (e) => {
        e.stopPropagation();
        const sid = stickerBubble.dataset.setId;
        const shash = stickerBubble.dataset.accessHash;
        const sname = stickerBubble.dataset.shortName;
        if (sid || sname) {
          openStickerPackModal(sid, shash, sname);
        } else {
          showToast('此贴纸没有关联的公开贴纸包信息', 'info');
        }
      };
    }

    renderTarget.appendChild(wrap);
  }

  if (!q && !preserveScroll) {
    container.scrollTop = container.scrollHeight;
  }
  setupVideoIntersectionAutoplay();
  if (state.clientTranslationEnabled === true) void applyAutomaticMessageTranslations();
}

async function quickToggleReaction(msgId, reaction) {
  if (!msgId || !reaction) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('send_reaction', { instId, chatId, messageId: Number(msgId), reaction });
    } else {
      await api(`/api/instances/${instId}/account/reaction`, 'POST', { chatId, messageId: Number(msgId), reaction });
    }
    if (!isCurrent()) return;
    const m = state.clientMessages.find((x) => String(x.id) === String(msgId));
    if (m) {
      if (!m.reactions) m.reactions = [];
      const customEmojiId = /^custom:([1-9]\d{0,19})$/.exec(String(reaction))?.[1];
      const existing = m.reactions.find((r) => customEmojiId
        ? String(r.customEmojiId || '') === customEmojiId
        : (r.emoji || r.emoticon) === reaction);
      if (existing) {
        if (existing.chosen) {
          existing.chosen = false;
          existing.count = Math.max(0, existing.count - 1);
        } else {
          existing.chosen = true;
          existing.count += 1;
        }
      } else {
        m.reactions.push({ emoji: customEmojiId ? '✨' : reaction, ...(customEmojiId ? { customEmojiId } : {}), count: 1, chosen: true });
      }
      renderClientMessages(true);
    }
  } catch (err) {
    if (isCurrent()) showToast(`回应失败: ${err.message}`, 'error');
  }
}

async function loadMessageFactCheck(messageId) {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const message = (state.clientMessages || []).find(item => String(item.id) === String(messageId));
  if (!instId || !chatId || !message || message.factCheckLoading ||
      !Array.isArray(message.factChecks) || !message.factChecks.some(item => item?.needCheck === true)) return;
  const isCurrent = () => state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion;
  message.factCheckLoading = true;
  message.factCheckError = '';
  renderClientMessages(true);
  try {
    const factChecks = await api(`/api/instances/${encodeURIComponent(instId)}/account/message-fact-check`, 'POST', {
      chatId, messageId: Number(messageId),
    });
    if (!isCurrent()) { message.factCheckLoading = false; return; }
    const current = (state.clientMessages || []).find(item => String(item.id) === String(messageId));
    if (!current) { message.factCheckLoading = false; return; }
    current.factChecks = Array.isArray(factChecks) ? factChecks : [];
    current.factCheckLoaded = true;
    current.factCheckLoading = false;
    renderClientMessages(true);
  } catch (error) {
    if (!isCurrent()) { message.factCheckLoading = false; return; }
    const current = (state.clientMessages || []).find(item => String(item.id) === String(messageId));
    if (current) {
      current.factCheckLoading = false;
      current.factCheckError = error.message || '读取失败';
      renderClientMessages(true);
    }
    showToast(`读取事实核查失败：${error.message}`, 'error');
  }
}

async function reportTelegramMessage(target) {
  if (!target?.instId || !Number.isSafeInteger(target.chatId) || target.chatId === 0 ||
      !Number.isSafeInteger(target.id) || target.id <= 0) return;
  const isCurrent = () => state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && (state.chatSelectionVersion || 0) === target.selectionVersion;
  if (!isCurrent()) return;
  const modal = document.getElementById('modal-message-report');
  const title = document.getElementById('message-report-title');
  const description = document.getElementById('message-report-description');
  const choices = document.getElementById('message-report-choices');
  const commentRow = document.getElementById('message-report-comment-row');
  const commentLabel = document.getElementById('message-report-comment-label');
  const commentInput = document.getElementById('message-report-comment');
  const status = document.getElementById('message-report-status');
  const submit = document.getElementById('btn-message-report-submit');
  const cancel = document.getElementById('btn-message-report-cancel');
  const closeButton = document.getElementById('btn-message-report-close');
  if (!modal || !title || !description || !choices || !commentRow || !commentInput || !status || !submit || !cancel) return;
  let active = true;
  let busy = false;
  let progress;
  const close = () => {
    if (!active) return;
    active = false;
    modal.style.display = 'none';
    modal.classList.remove('active');
    document.removeEventListener('keydown', onKeyDown);
    modal.removeEventListener('click', onOverlayClick);
  };
  const onKeyDown = event => { if (event.key === 'Escape') close(); };
  const onOverlayClick = event => { if (event.target === modal) close(); };
  const setBusy = value => {
    busy = value;
    submit.disabled = value;
    cancel.disabled = value;
    choices.querySelectorAll('button').forEach(button => { button.disabled = value; });
  };
  const renderProgress = next => {
    if (!active) return;
    if (!isCurrent()) { close(); return; }
    progress = next;
    choices.replaceChildren();
    commentInput.value = '';
    submit.hidden = true;
    if (next?.status === 'reported') {
      close();
      showToast('举报已提交给 Telegram', 'success');
      return;
    }
    if (next?.status === 'choose' && Array.isArray(next.options) && next.options.length) {
      title.textContent = next.title || '举报消息';
      description.textContent = '请选择最符合这条消息的举报原因。';
      choices.hidden = false;
      commentRow.hidden = true;
      next.options.forEach(option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-report-option';
        button.textContent = String(option.text || '');
        button.onclick = () => continueReport(option.token);
        choices.appendChild(button);
      });
      status.textContent = '';
      choices.querySelector('button')?.focus();
      return;
    }
    if (next?.status === 'comment' && typeof next.token === 'string') {
      title.textContent = '补充举报说明';
      description.textContent = next.optional ? '可以补充说明，或留空继续。' : '请按 Telegram 要求填写举报说明。';
      choices.hidden = true;
      commentRow.hidden = false;
      if (commentLabel) commentLabel.textContent = next.optional ? '说明（可选）' : '说明（必填）';
      submit.hidden = false;
      submit.textContent = '提交举报';
      status.textContent = '';
      commentInput.focus();
      return;
    }
    throw new Error('Telegram 返回了无法识别的举报步骤');
  };
  const continueReport = async (token, comment) => {
    if (!active || busy || !isCurrent()) { close(); return; }
    if (typeof token !== 'string') return;
    if (progress?.status === 'comment' && !progress.optional && !String(comment || '').trim()) {
      status.textContent = '请填写举报说明。';
      commentInput.focus();
      return;
    }
    setBusy(true);
    status.textContent = '正在提交给 Telegram…';
    let stepFailed = false;
    try {
      const next = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/message-report/continue`, 'POST', {
        token, ...(comment === undefined ? {} : { comment }),
      });
      if (!active || !isCurrent()) { close(); return; }
      renderProgress(next);
    } catch (error) {
      if (active && isCurrent()) {
        stepFailed = true;
        status.textContent = `此步骤未能完成：${error.message}。请关闭后重新发起举报。`;
        choices.querySelectorAll('button').forEach(button => { button.disabled = true; });
        submit.disabled = true;
      }
    } finally {
      if (active) {
        setBusy(false);
        if (stepFailed) {
          choices.querySelectorAll('button').forEach(button => { button.disabled = true; });
          submit.disabled = true;
        }
      }
    }
  };
  submit.onclick = () => progress?.status === 'comment' ? continueReport(progress.token, commentInput.value) : undefined;
  cancel.onclick = close;
  if (closeButton) closeButton.onclick = close;
  modal.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKeyDown);
  modal.style.display = 'flex';
  modal.classList.add('active');
  title.textContent = '举报消息';
  description.textContent = '正在获取 Telegram 的举报选项…';
  choices.hidden = true;
  commentRow.hidden = true;
  submit.hidden = true;
  status.textContent = '';
  try {
    const initial = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/message-report`, 'POST', {
      chatId: target.chatId, messageId: target.id,
    });
    if (!active || !isCurrent()) { close(); return; }
    renderProgress(initial);
  } catch (error) {
    if (!active || !isCurrent()) { close(); return; }
    description.textContent = `无法获取举报选项：${error.message}`;
    status.textContent = '请关闭对话框后重试。';
  }
}

// A staged file remains visible while it is read and uploaded. Prevent a
// second click from submitting the same file until the first attempt settles.
const pendingMediaSends = new WeakSet();
const activeMediaUploads = new WeakMap();

// XHR exposes browser-to-server upload progress without buffering the file in
// JavaScript. The first four bytes give the size of the UTF-8 metadata frame.
function sendMediaStream(url, file, metadata, onProgress) {
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  if (!encoded.length || encoded.length > 65536) return Promise.reject(new Error('附件说明过长'));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, encoded.length);
  const body = new Blob([length, encoded, file], { type: 'application/vnd.tguserbot.media-stream' });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const active = { xhr, phase: 'upload' };
    activeMediaUploads.set(file, active);
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/vnd.tguserbot.media-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress('upload', Math.min(100, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => { active.phase = 'sending'; onProgress('sending', 100); };
    xhr.onload = () => {
      if (activeMediaUploads.get(file) === active) activeMediaUploads.delete(file);
      let result;
      try { result = JSON.parse(xhr.responseText); } catch { result = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => { activeMediaUploads.delete(file); reject(new Error('网络连接中断，发送结果可能尚未确认')); };
    xhr.onabort = () => { activeMediaUploads.delete(file); reject(new Error('上传已取消')); };
    try { xhr.send(body); } catch (err) { activeMediaUploads.delete(file); reject(err); }
  });
}

function sendMediaAlbumStream(url, files, metadata, onProgress) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 10 || files.some(file => !file || !file.size)) {
    return Promise.reject(new Error('相册需要 2 到 10 个非空文件'));
  }
  const encoded = new TextEncoder().encode(JSON.stringify({
    ...metadata,
    files: files.map(file => ({ fileName: file.name, mimeType: file.type, size: file.size })),
  }));
  if (!encoded.length || encoded.length > 65536) return Promise.reject(new Error('相册说明过长'));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, encoded.length);
  const body = new Blob([length, encoded, ...files], { type: 'application/vnd.tguserbot.media-album-stream' });
  const primary = files[0];
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const active = { xhr, phase: 'upload' };
    activeMediaUploads.set(primary, active);
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/vnd.tguserbot.media-album-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress('upload', Math.min(100, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => { active.phase = 'sending'; onProgress('sending', 100); };
    xhr.onload = () => {
      if (activeMediaUploads.get(primary) === active) activeMediaUploads.delete(primary);
      let result;
      try { result = JSON.parse(xhr.responseText); } catch { result = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => { activeMediaUploads.delete(primary); reject(new Error('网络连接中断，相册发送结果可能尚未确认')); };
    xhr.onabort = () => { activeMediaUploads.delete(primary); reject(new Error('相册上传已取消')); };
    try { xhr.send(body); } catch (error) { activeMediaUploads.delete(primary); reject(error); }
  });
}

async function sendClientMessage(scheduledTimestamp = null, scheduledRepeatPeriod = null) {
  const textInput = document.getElementById('client-message-textarea');
  const originalInput = textInput ? textInput.value : '';
  const text = originalInput.trim();
  if (!text && !state.clientStagedFile) return;
  if (!state.clientActiveChatId) {
    return showToast('请先在左侧选择一个会话', 'warn');
  }
  if (scheduledRepeatPeriod && !scheduledTimestamp) return showToast('重复发送需要先设定发送时间', 'warn');

  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion || 0;
  const draftKey = clientDraftKey(chatId, instId);
  const sameChat = () => state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && (state.chatSelectionVersion || 0) === selectionVersion;
  const reply = state.clientReplyingTo;
  const parseMode = state.clientParseMode || document.getElementById('client-input-parsemode')?.value || 'markdown';
  const silent = Boolean(state.clientSilent);
  const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;
  const effectId = state.clientMessageEffectId || undefined;
  let draftSend = null;

  // Handle staged attachment file
  if (state.clientStagedFile) {
    const file = state.clientStagedFile;
    const stagedFiles = Array.isArray(state.clientStagedFiles) && state.clientStagedFiles.length
      ? state.clientStagedFiles : [file];
    const paidStars = state.clientPaidMediaStars;
    const invertMedia = state.clientCaptionAboveMedia === true;
    const videoNote = state.clientVideoNote === true;
    if (stagedFiles.length > 1) {
      if (videoNote) return showToast('Telegram 圆形视频不能作为相册发送', 'warn');
      if (scheduledRepeatPeriod) return showToast('Telegram 暂不支持重复定时发送相册', 'warn');
      if (stagedFiles.length > 10 || stagedFiles.some(item => item.size > 2 * 1024 * 1024 * 1024)) {
        showToast('Telegram 相册最多包含 10 个文件，单个文件不能超过 2 GiB', 'error');
        return;
      }
      const albumType = item => /^(?:image\/(?:jpeg|png|webp|heic|heif)|video\/(?:mp4|webm|quicktime|x-m4v|3gpp))$/i.test(item.type || '');
      if (stagedFiles.some(item => !albumType(item))) {
        showToast('相册仅支持照片和视频，请分开发送其他附件', 'error');
        return;
      }
      if (stagedFiles.some(item => pendingMediaSends.has(item))) return;
      draftSend = window.CloudDrafts?.beginSend(instId, chatId, originalInput, replyTo);
      stagedFiles.forEach(item => pendingMediaSends.add(item));
      const status = (phase, percent) => {
        if (!sameChat() || state.clientStagedFiles !== stagedFiles) return;
        const size = document.getElementById('attachment-chip-size');
        if (size) size.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
      };
      try {
        await sendMediaAlbumStream(`/api/instances/${encodeURIComponent(instId)}/account/send-media-album`, stagedFiles, {
          chatId, caption: text || undefined, parseMode, silent, replyTo, schedule: scheduledTimestamp || undefined, effectId,
          invertMedia,
          ...(paidStars == null ? {} : { paidStars }),
        }, status);
        window.CloudDrafts?.finishSend(draftSend, true);
        if (effectId && state.clientMessageEffectId === effectId) {
          state.clientMessageEffectId = null;
          const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
        }
        if (sameChat() && state.clientStagedFiles === stagedFiles) clearStagedAttachment();
        if (sameChat() && textInput && textInput.value === originalInput) { textInput.value = ''; autoResizeTextarea(textInput); }
        const originalChatVisible = state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId);
        if ((!originalChatVisible || sameChat()) && state.clientDrafts && state.clientDrafts[draftKey] === originalInput) {
          delete state.clientDrafts[draftKey];
          if (sameChat()) renderClientDialogs();
        }
        if (sameChat() && state.clientReplyingTo === reply) cancelReplyBanner();
        showToast(paidStars != null ? `付费媒体已成功发送，每项 ${paidStars} Stars` : scheduledTimestamp
          ? `相册定时已设定 (${new Date(scheduledTimestamp * 1000).toLocaleTimeString()})` : '相册已成功发送', 'success');
        if (sameChat()) await loadClientMessages(chatId, true);
      } catch (err) {
        window.CloudDrafts?.finishSend(draftSend, false);
        if (sameChat() && state.clientStagedFiles === stagedFiles) {
          const size = document.getElementById('attachment-chip-size');
          if (size) size.textContent = `(${stagedFiles.length} 个文件，${formatBytes(stagedFiles.reduce((sum, item) => sum + item.size, 0))})`;
        }
        showToast(`发送相册失败: ${err.message}`, 'error');
      } finally {
        stagedFiles.forEach(item => pendingMediaSends.delete(item));
      }
      return;
    }
    if (scheduledRepeatPeriod && paidStars != null) return showToast('付费媒体暂不支持重复定时发送', 'warn');
    if (file.size > 2 * 1024 * 1024 * 1024) {
      showToast('附件超过 2 GiB，请选择较小的文件', 'error');
      return;
    }
    if (pendingMediaSends.has(file)) return;
    draftSend = window.CloudDrafts?.beginSend(instId, chatId, originalInput, replyTo);
    let mediaType = 'document';
    if (file.type.startsWith('image/')) mediaType = 'photo';
    else if (file.type.startsWith('video/')) mediaType = 'video';
    else if (file.type.startsWith('audio/')) mediaType = 'audio';
    if (paidStars != null && !['photo', 'video'].includes(mediaType)) {
      showToast('Telegram 付费媒体仅支持照片或视频', 'error');
      return;
    }
    if (videoNote && (mediaType !== 'video' || paidStars != null || scheduledRepeatPeriod)) {
      showToast('圆形视频消息仅支持单个视频，不能与付费媒体或重复定时一起发送', 'warn');
      return;
    }

    pendingMediaSends.add(file);
    const status = (phase, percent) => {
      if (!sameChat() || state.clientStagedFile !== file) return;
      const size = document.getElementById('attachment-chip-size');
      if (size) size.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
    };
    try {
        await sendMediaStream(`/api/instances/${encodeURIComponent(instId)}/account/send-media`, file, {
          chatId,
          mediaType,
          fileName: file.name,
          caption: text || undefined,
          parseMode,
          silent,
          replyTo,
          schedule: scheduledTimestamp || undefined,
          scheduleRepeatPeriod: scheduledRepeatPeriod || undefined,
          effectId,
          invertMedia,
          videoNote,
          ...(paidStars == null ? {} : { paidStars }),
        }, status);
        window.CloudDrafts?.finishSend(draftSend, true);

        if (effectId && state.clientMessageEffectId === effectId) {
          state.clientMessageEffectId = null;
          const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
        }

        if (sameChat() && state.clientStagedFile === file) clearStagedAttachment();
        if (sameChat() && textInput && textInput.value === originalInput) {
          textInput.value = '';
          autoResizeTextarea(textInput);
        }
        const originalChatVisible = state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId);
        if ((!originalChatVisible || sameChat()) && state.clientDrafts && state.clientDrafts[draftKey] === originalInput) {
          delete state.clientDrafts[draftKey];
          if (sameChat()) renderClientDialogs();
        }
        if (sameChat() && state.clientReplyingTo === reply) cancelReplyBanner();
        if (scheduledTimestamp) {
          const repeatLabel = scheduledRepeatPeriod ? `，每 ${scheduledRepeatPeriod / 86400} 天重复` : '';
          showToast(`附件定时已设定 (${new Date(scheduledTimestamp * 1000).toLocaleTimeString()})${repeatLabel}`, 'success');
        } else {
          showToast(videoNote ? '圆形视频消息已发送' : paidStars != null ? `付费媒体已成功发送，每项 ${paidStars} Stars` : '附件已成功发送', 'success');
        }
        if (sameChat()) await loadClientMessages(chatId, true);
    } catch (err) {
      window.CloudDrafts?.finishSend(draftSend, false);
      if (sameChat() && state.clientStagedFile === file) {
        const size = document.getElementById('attachment-chip-size');
        if (size) size.textContent = `(${formatBytes(file.size)})`;
      }
      showToast(`发送附件失败: ${err.message}`, 'error');
    } finally {
      pendingMediaSends.delete(file);
    }
    return;
  }

  // Handle editing message
  if (state.clientEditingMessageId) {
    const editMsgId = state.clientEditingMessageId;
    state.clientEditingMessageId = null;
    cancelEditBanner();
    try {
      if (window.chatWs && window.chatWs.isConnected()) {
        await window.chatWs.sendRpc('edit_message', {
          instId,
          chatId,
          messageId: editMsgId,
          text,
          options: {
            parseMode,
          },
        });
      } else {
        await api(`/api/instances/${instId}/account/edit`, 'POST', {
          chatId,
          messageId: editMsgId,
          text,
          options: {
            parseMode,
          },
        });
      }

      if (sameChat() && textInput && textInput.value === originalInput && !state.clientEditingMessageId) {
        textInput.value = '';
        autoResizeTextarea(textInput);
      }
      showToast('消息已成功修改', 'success');
      if (sameChat()) await loadClientMessages(chatId, true);
      return;
    } catch (err) {
      showToast(`编辑消息失败: ${err.message}`, 'error');
      return;
    }
  }

  // Optimistic UI bubble
  draftSend = window.CloudDrafts?.beginSend(instId, chatId, originalInput, replyTo);
  const tempId = 'temp_' + Date.now();
  const optimisticMsg = {
    id: tempId,
    outgoing: true,
    status: 'pending',
    text,
    date: Date.now(),
    from: { firstName: '我' },
    isReply: Boolean(replyTo),
    replyToMessageId: replyTo,
  };
  if (state.clientHistoryOffsetDate == null && !state.clientSavedReactionFilter) {
    state.clientMessages.push(optimisticMsg);
    renderClientMessages(false);
  }

  if (textInput) {
    textInput.value = '';
    autoResizeTextarea(textInput);
  }
  if (state.clientDrafts && state.clientActiveChatId) {
    delete state.clientDrafts[clientDraftKey(state.clientActiveChatId)];
    renderClientDialogs();
  }
  cancelReplyBanner();

  try {
    let sentRes;
    if (window.chatWs && window.chatWs.isConnected()) {
      sentRes = await window.chatWs.sendRpc('send_message', {
        instId,
        chatId,
        text,
        options: {
          parseMode,
          silent,
          replyTo,
          schedule: scheduledTimestamp || undefined,
          scheduleRepeatPeriod: scheduledRepeatPeriod || undefined,
          ...(effectId ? { effectId } : {}),
        },
      });
    } else {
      sentRes = await api(`/api/instances/${instId}/account/send`, 'POST', {
        chatId,
        text,
        options: {
          parseMode,
          silent,
          replyTo,
          schedule: scheduledTimestamp || undefined,
          scheduleRepeatPeriod: scheduledRepeatPeriod || undefined,
          ...(effectId ? { effectId } : {}),
        },
      });
    }

    window.CloudDrafts?.finishSend(draftSend, true);
    if (!sameChat()) return;
    if (effectId && state.clientMessageEffectId === effectId) {
      state.clientMessageEffectId = null;
      const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
    }
    const local = state.clientMessages.find((m) => m.id === tempId);
    if (local) {
      if (sentRes && sentRes.id) {
        Object.assign(local, sentRes, { status: 'sent' });
      } else {
        local.status = 'sent';
      }
    }
    renderClientMessages(true);
    loadClientMessages(chatId, true);
    if (scheduledTimestamp) {
      const repeatLabel = scheduledRepeatPeriod ? `，每 ${scheduledRepeatPeriod / 86400} 天重复` : '';
      showToast(`已成功设定定时消息 (${new Date(scheduledTimestamp * 1000).toLocaleString()})${repeatLabel}`, 'success');
    }
  } catch (err) {
    window.CloudDrafts?.finishSend(draftSend, false);
    const local = sameChat() && state.clientMessages.find((m) => m.id === tempId);
    if (local) {
      local.status = 'failed';
      renderClientMessages(true);
    }
    showToast(`发送失败: ${err.message}`, 'error');
  }
}

function setReplyingMessage(msgId) {
  const m = msgId && typeof msgId === 'object' ? msgId : state.clientMessages.find((x) => x.id === msgId);
  if (!m) return;
  state.clientReplyingTo = m;
  const banner = document.getElementById('chat-reply-banner');
  const senderEl = document.getElementById('reply-banner-sender');
  const textEl = document.getElementById('reply-banner-text');
  if (banner && senderEl && textEl) {
    const sender = m.outgoing ? '我' : (m.from?.firstName || m.from?.username || `用户 #${m.from?.id || '?'}`);
    senderEl.innerText = `回复 ${sender}`;
    textEl.innerText = m.text || (m.media ? `[${m.media.type}]` : '媒体消息');
    banner.style.display = 'flex';
  }
  document.getElementById('client-message-textarea')?.focus();
  const input = document.getElementById('client-message-textarea');
  window.CloudDrafts?.changed(state.clientSelectedInstance, state.clientActiveChatId, input?.value || '', m.id);
}
window.setReplyingMessage = setReplyingMessage;

function cancelReplyBanner() {
  state.clientReplyingTo = null;
  const banner = document.getElementById('chat-reply-banner');
  if (banner) banner.style.display = 'none';
}

function setEditingMessage(msgId, text) {
  state.clientEditingMessageId = msgId;
  cancelReplyBanner();

  const banner = document.getElementById('chat-edit-banner');
  const textEl = document.getElementById('edit-banner-text');
  if (banner && textEl) {
    textEl.innerText = text || `消息 #${msgId}`;
    banner.style.display = 'flex';
  }

  const textarea = document.getElementById('client-message-textarea');
  if (textarea) {
    textarea.value = text || '';
    autoResizeTextarea(textarea);
    textarea.focus();
  }
  showToast('已进入消息编辑模式', 'info');
}

function cancelEditBanner() {
  state.clientEditingMessageId = null;
  const banner = document.getElementById('chat-edit-banner');
  if (banner) banner.style.display = 'none';
}

function scrollToMessage(msgId) {
  const el = document.getElementById(`chat-msg-${msgId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-flash');
    setTimeout(() => el.classList.remove('highlight-flash'), 1800);
  } else {
    showToast(`未在当前加载列表中找到消息 #${msgId}`, 'info');
  }
}

const liveLocationWatchers = new Map();
function liveLocationWatcherKey(instId, chatId, messageId) {
  return `${String(instId)}:${Number(chatId)}:${Number(messageId)}`;
}

async function stopClientLiveLocation(instId, chatId, messageId, options = {}) {
  const key = liveLocationWatcherKey(instId, chatId, messageId);
  const watcher = liveLocationWatchers.get(key);
  if (watcher) {
    if (watcher.watchId != null) navigator.geolocation?.clearWatch(watcher.watchId);
    if (watcher.timeoutId != null) clearTimeout(watcher.timeoutId);
    liveLocationWatchers.delete(key);
  }
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/location/live/stop`, 'POST', { chatId: Number(chatId), messageId: Number(messageId) });
    if (String(state.clientSelectedInstance) === String(instId) && Number(state.clientActiveChatId) === Number(chatId)) {
      await loadClientMessages(Number(chatId), true);
      window.ForumTopics?.refreshCurrentTopic?.();
    }
    if (options.notify !== false) showToast('实时位置共享已停止', 'success');
  } catch (error) {
    showToast(`已停止本机定位，但 Telegram 未确认停止共享：${error.message}`, 'error');
  }
}

function liveLocationDistanceMeters(first, second) {
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(second.latitude - first.latitude), lonDelta = radians(second.longitude - first.longitude);
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(lonDelta / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function startClientLiveLocation(target, topMsgId) {
  const durationByMinutes = new Map([[15, 900], [60, 3600], [480, 28800]]);
  const minutesText = window.prompt('实时位置共享时长（分钟）：15、60 或 480（8 小时）', '60');
  if (minutesText == null) return;
  const period = durationByMinutes.get(Number(String(minutesText).trim()));
  if (!period) return showToast('请选择 15、60 或 480 分钟', 'warn');
  if (!target || !target.instId || !Number.isSafeInteger(Number(target.chatId))) return showToast('请先打开要分享位置的会话', 'warn');
  if (!navigator.geolocation) return showToast('当前浏览器不支持位置服务', 'error');
  if (window.isSecureContext === false) return showToast('浏览器仅允许在 HTTPS 或本机环境下读取位置', 'error');
  const isCurrent = () => (typeof target.isCurrent === 'function' ? target.isCurrent() :
    state.clientSelectedInstance === target.instId && Number(state.clientActiveChatId) === Number(target.chatId) &&
    (state.chatSelectionVersion || 0) === (target.selectionVersion || 0));
  navigator.geolocation.getCurrentPosition(async position => {
    if (!isCurrent()) return showToast('会话已切换，实时位置未发送', 'warn');
    try {
      const result = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/location/live`, 'POST', {
        chatId: Number(target.chatId), latitude: position.coords.latitude, longitude: position.coords.longitude, period,
        ...(Number.isSafeInteger(Number(topMsgId)) && Number(topMsgId) > 0 ? { topMsgId: Number(topMsgId) } : {}),
      });
      const messageId = Number(result?.result?.messageId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Telegram 未返回实时位置消息编号');
      const startedAt = Date.now();
      const watcher = {
        instId: target.instId, chatId: Number(target.chatId), messageId, period,
        expiresAt: startedAt + period * 1000, lastSentAt: startedAt,
        lastPosition: { latitude: position.coords.latitude, longitude: position.coords.longitude },
        watchId: null, timeoutId: null, inFlight: false, hasShownError: false,
      };
      const key = liveLocationWatcherKey(target.instId, target.chatId, messageId);
      watcher.timeoutId = setTimeout(() => { void stopClientLiveLocation(watcher.instId, watcher.chatId, watcher.messageId, { notify: false }); }, period * 1000);
      liveLocationWatchers.set(key, watcher);
      watcher.watchId = navigator.geolocation.watchPosition(async update => {
        if (liveLocationWatchers.get(key) !== watcher || watcher.inFlight) return;
        const nextPosition = { latitude: update.coords.latitude, longitude: update.coords.longitude };
        const now = Date.now();
        if (now >= watcher.expiresAt) {
          void stopClientLiveLocation(watcher.instId, watcher.chatId, watcher.messageId, { notify: false });
          return;
        }
        if (now - watcher.lastSentAt < 10000 && liveLocationDistanceMeters(watcher.lastPosition, nextPosition) < 25) return;
        const remaining = Math.max(1, Math.ceil((watcher.expiresAt - now) / 1000));
        watcher.inFlight = true;
        try {
          await api(`/api/instances/${encodeURIComponent(watcher.instId)}/account/location/live/update`, 'POST', {
            chatId: watcher.chatId, messageId: watcher.messageId, ...nextPosition, period: remaining,
          });
          if (liveLocationWatchers.get(key) === watcher) {
            watcher.lastPosition = nextPosition;
            watcher.lastSentAt = now;
          }
        } catch (error) {
          if (!watcher.hasShownError) { watcher.hasShownError = true; showToast(`实时位置更新失败，将在下次定位时重试：${error.message}`, 'warn'); }
        } finally { watcher.inFlight = false; }
      }, error => {
        if (!watcher.hasShownError) { watcher.hasShownError = true; showToast(error.code === error.PERMISSION_DENIED ? '位置权限已撤销，实时位置将保留到共享时长结束' : '无法获取新的位置，实时位置将保留到共享时长结束', 'warn'); }
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
      if (isCurrent()) await loadClientMessages(Number(target.chatId), true);
      if (isCurrent()) window.ForumTopics?.refreshCurrentTopic?.();
      showToast(`已开始共享实时位置（${period / 60} 分钟）`, 'success');
    } catch (error) { showToast(`实时位置发送失败：${error.message}`, 'error'); }
  }, error => {
    const message = error.code === error.PERMISSION_DENIED ? '未获得位置权限' :
      error.code === error.TIMEOUT ? '读取位置超时，请重试' : '无法读取当前位置';
    showToast(message, 'warn');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

window.startClientLiveLocation = startClientLiveLocation;
window.stopClientLiveLocation = stopClientLiveLocation;

// Channel post comments
window.showComments = (msgId, chatId) => window.ChatComments.open(msgId, chatId);

// Spoiler reveal on click (delegated)
document.addEventListener('click', (e) => {
  const spoiler = e.target.closest('.tg-spoiler.hidden');
  if (spoiler) {
    e.stopPropagation();
    spoiler.classList.remove('hidden');
    spoiler.classList.add('revealed');
  }
});

let clientSearchRequest = 0;
let clientSearchOldestId = null;
let clientSearchHasMore = false;
let clientSearchPageLoading = false;

function toggleChatSearchBar(forceOpen, render = true) {
  const bar = document.getElementById('chat-search-bar');
  if (!bar) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : bar.style.display === 'none' || !bar.style.display;
  if (shouldOpen) {
    bar.style.display = 'flex';
    document.getElementById('chat-search-input')?.focus();
  } else {
    clientSearchRequest++;
    bar.style.display = 'none';
    state.clientSearchQuery = '';
    state.clientSearchFilter = '';
    state.searchMatchIds = [];
    state.searchMatchIdx = -1;
    clientSearchOldestId = null;
    clientSearchHasMore = false;
    clientSearchPageLoading = false;
    const input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    const filter = document.getElementById('chat-search-filter');
    if (filter) filter.value = '';
    const statsEl = document.getElementById('chat-search-stats');
    if (statsEl) statsEl.style.display = 'none';
    const prevBtn = document.getElementById('btn-chat-search-prev');
    if (prevBtn) prevBtn.style.display = 'none';
    const nextBtn = document.getElementById('btn-chat-search-next');
    if (nextBtn) nextBtn.style.display = 'none';
    if (render) renderClientMessages();
  }
}

async function executeChatServerSearch(query) {
  const filter = document.getElementById('chat-search-filter')?.value || '';
  if ((!query && !filter) || !state.clientActiveChatId) return;
  const request = ++clientSearchRequest;
  clientSearchOldestId = null;
  clientSearchHasMore = false;
  clientSearchPageLoading = true;
  state.searchMatchIds = [];
  state.searchMatchIdx = -1;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const isCurrent = () => request === clientSearchRequest &&
    state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) &&
    (state.clientSearchQuery || '').toLowerCase().trim() === query.toLowerCase().trim() &&
    (document.getElementById('chat-search-filter')?.value || '') === filter;
  const statsEl = document.getElementById('chat-search-stats');
  const prevBtn = document.getElementById('btn-chat-search-prev');
  const nextBtn = document.getElementById('btn-chat-search-next');

  try {
    let msgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      msgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 60, search: query, searchFilter: filter || undefined });
    } else {
      msgs = await api(`/api/instances/${instId}/account/messages?chatId=${chatId}&limit=60&search=${encodeURIComponent(query)}&searchFilter=${encodeURIComponent(filter)}`);
    }
    if (!isCurrent()) return;

    if (!Array.isArray(msgs) || msgs.length === 0) {
      clientSearchHasMore = false;
      if (statsEl) {
        statsEl.innerText = '0 / 0';
        statsEl.style.display = 'inline';
      }
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      showToast('未在当前会话记录中检索到匹配消息', 'info');
      return;
    }

    const existingIds = new Set(state.clientMessages.map((m) => String(m.id)));
    msgs.forEach((m) => {
      if (!existingIds.has(String(m.id))) {
        state.clientMessages.push(m);
        existingIds.add(String(m.id));
      }
    });
    state.clientMessages.sort((a, b) => (a.id || 0) - (b.id || 0));

    state.searchMatchIds = msgs.map((m) => m.id);
    state.searchMatchIdx = state.searchMatchIds.length - 1;
    clientSearchOldestId = Math.min(...msgs.map(message => Number(message.id)).filter(Number.isSafeInteger));
    clientSearchHasMore = Number.isSafeInteger(clientSearchOldestId) && msgs.length === 60;

    if (statsEl) {
      statsEl.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}${clientSearchHasMore ? '+' : ''}`;
      statsEl.style.display = 'inline';
    }
    if (prevBtn) prevBtn.style.display = 'inline-flex';
    if (nextBtn) nextBtn.style.display = 'inline-flex';

    renderClientMessages(true);
    scrollToMessage(state.searchMatchIds[state.searchMatchIdx]);
  } catch (err) {
    if (isCurrent()) showToast(`搜索失败: ${err.message}`, 'error');
  } finally {
    if (request === clientSearchRequest) clientSearchPageLoading = false;
  }
}

async function loadMoreChatSearchResults() {
  if (!clientSearchHasMore || clientSearchPageLoading || !Number.isSafeInteger(clientSearchOldestId)) return;
  const request = clientSearchRequest;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const query = document.getElementById('chat-search-input')?.value.trim() || '';
  const filter = document.getElementById('chat-search-filter')?.value || '';
  const oldestId = clientSearchOldestId;
  const isCurrent = () => request === clientSearchRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) &&
    (document.getElementById('chat-search-input')?.value.trim() || '').toLowerCase() === query.toLowerCase() &&
    (document.getElementById('chat-search-filter')?.value || '') === filter;
  clientSearchPageLoading = true;
  try {
    let msgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      msgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 60, search: query, searchFilter: filter || undefined, offsetId: oldestId });
    } else {
      msgs = await api(`/api/instances/${encodeURIComponent(instId)}/account/messages?chatId=${encodeURIComponent(chatId)}&limit=60&search=${encodeURIComponent(query)}&searchFilter=${encodeURIComponent(filter)}&offsetId=${oldestId}`);
    }
    if (!isCurrent()) return;
    if (!Array.isArray(msgs) || !msgs.length) {
      clientSearchHasMore = false;
      const stats = document.getElementById('chat-search-stats');
      if (stats) stats.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}`;
      return;
    }
    const priorMatches = new Set(state.searchMatchIds.map(String));
    const newMatches = msgs.filter(message => message && message.id != null && !priorMatches.has(String(message.id)));
    const nextOldestId = Math.min(...msgs.map(message => Number(message.id)).filter(Number.isSafeInteger));
    if (!newMatches.length || !Number.isSafeInteger(nextOldestId) || nextOldestId >= oldestId) {
      clientSearchHasMore = false;
      return;
    }
    const existingMessages = new Set(state.clientMessages.map(message => String(message.id)));
    for (const message of msgs) {
      if (!existingMessages.has(String(message.id))) {
        state.clientMessages.push(message);
        existingMessages.add(String(message.id));
      }
    }
    state.clientMessages.sort((a, b) => (a.id || 0) - (b.id || 0));
    const previousLength = state.searchMatchIds.length;
    state.searchMatchIds.push(...newMatches.map(message => message.id));
    state.searchMatchIdx = previousLength;
    clientSearchOldestId = nextOldestId;
    clientSearchHasMore = msgs.length === 60;
    const stats = document.getElementById('chat-search-stats');
    if (stats) stats.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}${clientSearchHasMore ? '+' : ''}`;
    renderClientMessages(true);
    scrollToMessage(state.searchMatchIds[state.searchMatchIdx]);
  } catch (error) {
    if (isCurrent()) showToast(`加载更多搜索结果失败: ${error.message}`, 'error');
  } finally {
    if (request === clientSearchRequest) clientSearchPageLoading = false;
  }
}

function navigateSearchMatch(direction) {
  if (!state.searchMatchIds || state.searchMatchIds.length === 0) return;
  if (direction === 'next' && state.searchMatchIdx === state.searchMatchIds.length - 1 && clientSearchHasMore) {
    void loadMoreChatSearchResults();
    return;
  }
  if (direction === 'prev') {
    state.searchMatchIdx = (state.searchMatchIdx - 1 + state.searchMatchIds.length) % state.searchMatchIds.length;
  } else {
    state.searchMatchIdx = (state.searchMatchIdx + 1) % state.searchMatchIds.length;
  }
  const statsEl = document.getElementById('chat-search-stats');
  if (statsEl) {
    statsEl.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}${clientSearchHasMore ? '+' : ''}`;
  }
  scrollToMessage(state.searchMatchIds[state.searchMatchIdx]);
}

// Multi-Selection Controller
function enterSelectionMode(initialMsgId) {
  state.isSelectionMode = true;
  state.selectedMsgIds.clear();
  if (initialMsgId) {
    state.selectedMsgIds.add(Number(initialMsgId));
  }
  const container = document.getElementById('client-messages-container');
  if (container) container.classList.add('selection-mode');
  const selBar = document.getElementById('chat-selection-bar');
  if (selBar) selBar.style.display = 'flex';
  updateSelectionCountUI();
  document.querySelectorAll('.chat-bubble-wrap').forEach((el) => {
    const id = Number(el.dataset.msgId);
    if (state.selectedMsgIds.has(id)) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}

function exitSelectionMode() {
  state.isSelectionMode = false;
  state.selectedMsgIds.clear();
  const container = document.getElementById('client-messages-container');
  if (container) container.classList.remove('selection-mode');
  const selBar = document.getElementById('chat-selection-bar');
  if (selBar) selBar.style.display = 'none';
  document.querySelectorAll('.chat-bubble-wrap.selected').forEach((el) => {
    el.classList.remove('selected');
  });
}

function toggleSelectMessage(msgId) {
  const numId = Number(msgId);
  if (state.selectedMsgIds.has(numId)) {
    state.selectedMsgIds.delete(numId);
  } else {
    state.selectedMsgIds.add(numId);
  }

  if (state.selectedMsgIds.size === 0) {
    exitSelectionMode();
    return;
  }

  updateSelectionCountUI();
  const wrap = document.getElementById(`chat-msg-${numId}`);
  if (wrap) {
    if (state.selectedMsgIds.has(numId)) {
      wrap.classList.add('selected');
    } else {
      wrap.classList.remove('selected');
    }
  }
}

function updateSelectionCountUI() {
  const countText = document.getElementById('selection-count-text');
  if (countText) {
    countText.innerText = `已选择 ${state.selectedMsgIds.size} 条消息`;
  }
}

// Forward Modal Controller
let pendingForwardContext = null;

function openForwardModal(msgIds) {
  if (!msgIds || msgIds.length === 0 || !state.clientSelectedInstance || state.clientActiveChatId == null) return;
  const requestedIds = new Set(msgIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0));
  const albumIds = new Set((state.clientMessages || [])
    .filter(message => requestedIds.has(Number(message.id)) && ['photo', 'video'].includes(message.media?.type) && message.groupedId)
    .map(message => String(message.groupedId)));
  const expandedIds = [];
  const includedIds = new Set();
  for (const message of state.clientMessages || []) {
    const id = Number(message.id);
    const isAlbumMate = albumIds.has(String(message.groupedId || '')) && ['photo', 'video'].includes(message.media?.type);
    if ((requestedIds.has(id) || isAlbumMate) && !includedIds.has(id)) {
      includedIds.add(id);
      expandedIds.push(id);
    }
  }
  for (const id of requestedIds) {
    if (!includedIds.has(id)) expandedIds.push(id);
  }
  pendingForwardContext = {
    instId: state.clientSelectedInstance,
    chatId: state.clientActiveChatId,
    selectionVersion: state.chatSelectionVersion,
    messageIds: expandedIds,
  };
  state.pendingForwardMsgIds = [...pendingForwardContext.messageIds];

  const modal = document.getElementById('modal-forward-message');
  const searchInput = document.getElementById('forward-dialogs-search');
  if (!modal) return;

  if (searchInput) searchInput.value = '';
  renderForwardDialogsList();

  modal.style.display = 'flex';
  setTimeout(() => searchInput?.focus(), 50);
}

function closeForwardModal() {
  const modal = document.getElementById('modal-forward-message');
  if (modal) modal.style.display = 'none';
  state.pendingForwardMsgIds = [];
  pendingForwardContext = null;
}

function renderForwardDialogsList(filter = '') {
  const listContainer = document.getElementById('forward-dialogs-list');
  if (!listContainer) return;

  const q = filter.toLowerCase().trim();
  let list = state.clientDialogs;
  if (q) {
    list = list.filter((d) =>
      (d.title && d.title.toLowerCase().includes(q)) ||
      (d.username && d.username.toLowerCase().includes(q)) ||
      String(d.id).includes(q)
    );
  }

  if (list.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">未搜索到匹配的目标会话</div>';
    return;
  }

  listContainer.innerHTML = '';
  for (const d of list) {
    const item = document.createElement('div');
    item.className = 'forward-dialog-item';
    const initials = (d.title || d.username || 'TG').slice(0, 2);
    const typeLabel = d.type === 'channel' ? '频道' : d.type === 'group' || d.type === 'supergroup' ? '群组' : d.type === 'bot' ? '机器人' : '私聊';

    item.innerHTML = `
      <div class="forward-dialog-avatar">${escapeHtml(initials)}</div>
      <div class="forward-dialog-info">
        <div class="forward-dialog-title">${escapeHtml(d.title || d.username || String(d.id))}</div>
        <div class="forward-dialog-sub">${typeLabel} ${d.username ? '@' + escapeHtml(d.username) : 'ID: ' + escapeHtml(d.id)}</div>
      </div>
    `;

    item.onclick = async () => {
      await executeForwardTo(d);
    };
    listContainer.appendChild(item);
  }
}

async function executeForwardTo(targetDialog) {
  const context = pendingForwardContext;
  if (!context || !context.messageIds.length) return;
  if (state.clientSelectedInstance !== context.instId || String(state.clientActiveChatId) !== String(context.chatId) || state.chatSelectionVersion !== context.selectionVersion) {
    closeForwardModal();
    return showToast('会话已切换，请重新选择要转发的消息', 'warn');
  }
  const msgIds = context.messageIds;
  const fromChatId = context.chatId;
  const toChatId = targetDialog.id;
  const instId = context.instId;

  closeForwardModal();
  showToast(`正在转发 ${msgIds.length} 条消息至 "${targetDialog.title || targetDialog.username}"...`, 'info');

  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('forward_messages', { instId, fromChatId, toChatId, messageIds: msgIds });
    } else {
      await api(`/api/instances/${instId}/account/forward`, 'POST', { fromChatId, toChatId, messageIds: msgIds });
    }
    showToast(`成功转发至 "${targetDialog.title || targetDialog.username}"`, 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(fromChatId) && state.chatSelectionVersion === context.selectionVersion) exitSelectionMode();
  } catch (err) {
    showToast(`转发失败: ${err.message}`, 'error');
  }
}

// Voice Recorder Controller
let voiceRecording = null;
let voicePermissionPending = false;
let voiceRequestGeneration = 0;

async function startVoiceRecording() {
  if (!state.clientSelectedInstance || state.clientActiveChatId == null) {
    return showToast('请先选择一个会话', 'warn');
  }
  if (voiceRecording || voicePermissionPending || videoNoteRecording || videoNotePermissionPending) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    return showToast('当前浏览器环境不支持麦克风音频采集', 'error');
  }

  // Bind recording to the conversation that requested the microphone, before
  // getUserMedia can yield to a permission prompt or an account switch.
  const context = {
    instId: state.clientSelectedInstance,
    chatId: state.clientActiveChatId,
    selectionVersion: state.chatSelectionVersion,
    replyTo: state.clientReplyingTo?.id,
    silent: Boolean(state.clientSilent),
  };
  const sameChat = () => state.clientSelectedInstance === context.instId &&
    String(state.clientActiveChatId) === String(context.chatId) &&
    state.chatSelectionVersion === context.selectionVersion;
  const generation = ++voiceRequestGeneration;
  voicePermissionPending = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (generation === voiceRequestGeneration && sameChat()) showToast(`获取麦克风失败: ${err.message}`, 'error');
    return;
  } finally {
    if (generation === voiceRequestGeneration) voicePermissionPending = false;
  }
  if (generation !== voiceRequestGeneration || !sameChat()) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  let options = {};
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      options = { mimeType: 'audio/ogg;codecs=opus' };
    } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options = { mimeType: 'audio/webm;codecs=opus' };
    }
  }

  let recorder;
  try {
    try { recorder = new MediaRecorder(stream, options); }
    catch { recorder = new MediaRecorder(stream); }
    const session = { ...context, recorder, stream, chunks: [], startedAt: Date.now(), timer: null };
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) session.chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (voiceRecording !== session) return;
      void stopVoiceRecording(false);
      showToast('录音失败，请检查麦克风后重试', 'error');
    };
    recorder.start(200);
    voiceRecording = session;
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    showToast(`无法开始录音: ${err.message}`, 'error');
    return;
  }

  const bar = document.getElementById('chat-voice-recording-bar');
  if (bar) bar.style.display = 'flex';

  const timerEl = document.getElementById('voice-rec-timer');
  if (timerEl) timerEl.innerText = '00:00';

  const session = voiceRecording;
  session.timer = setInterval(() => {
    if (voiceRecording !== session) return;
    const sec = Math.floor((Date.now() - session.startedAt) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    if (timerEl) timerEl.innerText = `${m}:${s}`;
    if (sec >= 120) {
      stopVoiceRecording(true);
    }
  }, 1000);
}

async function stopVoiceRecording(send = false) {
  // Also invalidate any microphone permission prompt that has not resolved.
  ++voiceRequestGeneration;
  voicePermissionPending = false;
  const session = voiceRecording;
  voiceRecording = null;
  if (session?.timer) clearInterval(session.timer);

  const bar = document.getElementById('chat-voice-recording-bar');
  if (bar) bar.style.display = 'none';

  if (!session) return;
  const { recorder, stream, instId, chatId, selectionVersion } = session;
  const sameChat = () => state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion;
  const shouldSend = send && sameChat();

  return new Promise((resolve) => {
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());

      if (!shouldSend || session.chunks.length === 0) return resolve();

      const mime = recorder.mimeType || session.chunks[0]?.type || 'application/octet-stream';
      const audioBlob = new Blob(session.chunks, { type: mime });
      const extension = mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : 'bin';
      const tempId = 'temp_voice_' + Date.now();
      const optimisticMsg = {
        id: tempId,
        outgoing: true,
        status: 'pending',
        media: { type: 'voice', duration: Math.max(1, Math.floor((Date.now() - session.startedAt) / 1000)) },
        date: Date.now(),
        from: { firstName: '我' },
      };
      if (sameChat() && state.clientHistoryOffsetDate == null) {
        state.clientMessages.push(optimisticMsg);
        renderClientMessages(false);
      }

      try {
        await sendMediaStream(`/api/instances/${encodeURIComponent(instId)}/account/send-media`, audioBlob, {
          chatId, mediaType: 'voice', fileName: `voice.${extension}`, replyTo: session.replyTo, silent: session.silent,
        }, () => {});
        showToast('语音消息已发送', 'success');
        if (sameChat()) await loadClientMessages(chatId, true);
      } catch (err) {
        const local = sameChat() && state.clientMessages.find((m) => m.id === tempId);
        if (local) {
          local.status = 'failed';
          renderClientMessages(true);
        }
        showToast(`语音发送未确认，请检查原会话后重试: ${err.message}`, 'error');
      }
      resolve();
    };

    if (recorder.state !== 'inactive') {
      try { recorder.stop(); }
      catch { stream.getTracks().forEach((track) => track.stop()); resolve(); }
    } else {
      stream.getTracks().forEach((track) => track.stop());
      resolve();
    }
  });
}

let videoNoteRecording = null;
let videoNotePermissionPending = false;
let videoNoteRequestGeneration = 0;

async function startVideoNoteRecording() {
  if (!state.clientSelectedInstance || state.clientActiveChatId == null) return showToast('请先选择一个会话', 'warn');
  if (state.clientStagedFile) return showToast('请先发送或移除当前附件，再录制圆形视频', 'warn');
  if (voiceRecording || voicePermissionPending || videoNoteRecording || videoNotePermissionPending) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return showToast('当前浏览器不支持相机视频录制', 'error');
  }
  const context = {
    instId: state.clientSelectedInstance, chatId: state.clientActiveChatId,
    selectionVersion: state.chatSelectionVersion, replyTo: state.clientReplyingTo?.id,
  };
  const sameChat = () => state.clientSelectedInstance === context.instId &&
    String(state.clientActiveChatId) === String(context.chatId) && state.chatSelectionVersion === context.selectionVersion;
  const generation = ++videoNoteRequestGeneration;
  videoNotePermissionPending = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    });
  } catch (err) {
    if (generation === videoNoteRequestGeneration && sameChat()) showToast(`无法访问相机或麦克风: ${err.message}`, 'error');
    return;
  } finally {
    if (generation === videoNoteRequestGeneration) videoNotePermissionPending = false;
  }
  if (generation !== videoNoteRequestGeneration || !sameChat()) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }
  let options = {};
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    if (MediaRecorder.isTypeSupported('video/mp4')) options = { mimeType: 'video/mp4', videoBitsPerSecond: 1_500_000 };
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) options = { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_500_000 };
    else if (MediaRecorder.isTypeSupported('video/webm')) options = { mimeType: 'video/webm', videoBitsPerSecond: 1_500_000 };
  }
  let recorder;
  try {
    try { recorder = new MediaRecorder(stream, options); }
    catch { recorder = new MediaRecorder(stream); }
    const session = { ...context, recorder, stream, chunks: [], startedAt: Date.now(), timer: null };
    recorder.ondataavailable = event => { if (event.data?.size > 0) session.chunks.push(event.data); };
    recorder.onerror = () => {
      if (videoNoteRecording !== session) return;
      void stopVideoNoteRecording(false);
      showToast('视频录制失败，请检查相机后重试', 'error');
    };
    recorder.start(200);
    videoNoteRecording = session;
    const preview = document.getElementById('chat-video-recording-preview');
    if (preview) {
      preview.srcObject = stream;
      try { const playing = preview.play?.(); playing?.catch?.(() => {}); } catch (_) {}
    }
    const bar = document.getElementById('chat-video-recording-bar');
    if (bar) bar.hidden = false;
    const timer = document.getElementById('video-rec-timer');
    if (timer) timer.textContent = '00:00';
    session.timer = setInterval(() => {
      if (videoNoteRecording !== session) return;
      const seconds = Math.floor((Date.now() - session.startedAt) / 1000);
      if (timer) timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= 60) void stopVideoNoteRecording(true);
    }, 1000);
  } catch (err) {
    stream.getTracks().forEach(track => track.stop());
    showToast(`无法开始视频录制: ${err.message}`, 'error');
  }
}

async function stopVideoNoteRecording(keepRecording = false) {
  ++videoNoteRequestGeneration;
  videoNotePermissionPending = false;
  const session = videoNoteRecording;
  videoNoteRecording = null;
  if (session?.timer) clearInterval(session.timer);
  const bar = document.getElementById('chat-video-recording-bar');
  if (bar) bar.hidden = true;
  const preview = document.getElementById('chat-video-recording-preview');
  if (preview) { try { preview.pause?.(); } catch (_) {} preview.srcObject = null; }
  if (!session) return;
  const { recorder, stream, instId, chatId, selectionVersion } = session;
  const sameChat = () => state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion;
  const shouldKeep = keepRecording && sameChat();
  return new Promise(resolve => {
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (!shouldKeep || !session.chunks.length) return resolve();
      const mime = String(recorder.mimeType || session.chunks[0]?.type || '').split(';')[0].toLowerCase();
      if (!['video/mp4', 'video/webm'].includes(mime)) {
        showToast('浏览器录制格式无法作为 Telegram 圆形视频发送', 'error');
        return resolve();
      }
      const blob = new Blob(session.chunks, { type: mime });
      if (!blob.size || blob.size > 2 * 1024 * 1024 * 1024 || typeof File !== 'function') {
        showToast('圆形视频为空、过大或当前浏览器无法创建附件', 'error');
        return resolve();
      }
      const extension = mime === 'video/mp4' ? 'mp4' : 'webm';
      const file = new File([blob], `round-video-${Date.now()}.${extension}`, { type: mime, lastModified: Date.now() });
      stageAttachmentFile(file);
      state.clientVideoNote = true;
      const option = document.getElementById('chat-video-note');
      if (option) option.checked = true;
      updatePaidMediaComposerControl();
      showToast('圆形视频已录制，请检查并发送', 'success');
      resolve();
    };
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); }
      catch { stream.getTracks().forEach(track => track.stop()); resolve(); }
    } else {
      stream.getTracks().forEach(track => track.stop());
      resolve();
    }
  });
}

let currentActiveVoiceAudio = null;
let currentVoiceBtn = null;
let currentVoiceMsgId = null;

function generateWaveformBarsHtml(msgId, seed = 0, realWaveform = null) {
  let barHeights;
  if (realWaveform && Array.isArray(realWaveform) && realWaveform.length > 0) {
    // Use real waveform data (0-31 normalized to pixel heights)
    barHeights = realWaveform.map((v) => Math.max(3, Math.min(22, Math.round((v / 31) * 22))));
    // Resample to ~28 bars if needed
    if (barHeights.length > 32) {
      const step = barHeights.length / 28;
      barHeights = Array.from({ length: 28 }, (_, i) => barHeights[Math.floor(i * step)]);
    }
  } else {
    // Fallback: pseudo-random waveform
    const baseHeights = [4, 6, 10, 16, 20, 14, 8, 12, 18, 22, 16, 10, 6, 12, 18, 24, 19, 12, 8, 15, 20, 14, 9, 14, 10, 7, 5, 3];
    barHeights = baseHeights.map((h, i) => Math.max(3, Math.min(22, Math.round(h * (0.8 + ((Math.abs(seed) + i * 7) % 5) * 0.1)))));
  }
  const bars = barHeights.map((h, i) => {
    return `<span class="voice-bar" data-idx="${i}" style="height:${h}px;"></span>`;
  }).join('');
  return `<div class="voice-waveform-bars" id="voice-bars-${escapeHtml(msgId)}" onclick="seekVoiceWaveform(event, ${inlineJsArg(msgId)})">${bars}</div>`;
}

function seekVoiceWaveform(event, msgId) {
  if (!currentActiveVoiceAudio || currentVoiceMsgId !== msgId || !currentActiveVoiceAudio.duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  currentActiveVoiceAudio.currentTime = ratio * currentActiveVoiceAudio.duration;
  updateVoiceWaveformActiveBars(msgId, ratio);
}

function updateVoiceWaveformActiveBars(msgId, ratio) {
  const container = document.getElementById(`voice-bars-${msgId}`);
  if (!container) return;
  const bars = container.querySelectorAll('.voice-bar');
  const activeCount = Math.floor(ratio * bars.length);
  bars.forEach((bar, idx) => {
    bar.classList.toggle('active', idx <= activeCount);
  });
}

function toggleVoicePlay(btn, url, msgId) {
  if (currentActiveVoiceAudio && currentVoiceBtn === btn) {
    if (currentActiveVoiceAudio.paused) {
      currentActiveVoiceAudio.play();
      btn.innerHTML = '<svg class="ui-icon-sm"><use href="#icon-pause"/></svg>';
    } else {
      currentActiveVoiceAudio.pause();
      btn.innerHTML = '<svg class="ui-icon-sm"><use href="#icon-play"/></svg>';
    }
    return;
  }

  if (currentActiveVoiceAudio) {
    currentActiveVoiceAudio.pause();
    if (currentVoiceBtn) currentVoiceBtn.innerHTML = '<svg class="ui-icon-sm"><use href="#icon-play"/></svg>';
    if (currentVoiceMsgId) updateVoiceWaveformActiveBars(currentVoiceMsgId, 0);
  }

  const audio = new Audio(url);
  currentActiveVoiceAudio = audio;
  currentVoiceBtn = btn;
  currentVoiceMsgId = msgId;
  btn.innerHTML = '<svg class="ui-icon-sm"><use href="#icon-pause"/></svg>';

  const timeEl = document.getElementById(`voice-time-${msgId}`);

  audio.ontimeupdate = () => {
    if (audio.duration) {
      const ratio = audio.currentTime / audio.duration;
      updateVoiceWaveformActiveBars(msgId, ratio);
    }
    if (timeEl) {
      timeEl.innerText = formatDurationSec(audio.currentTime);
    }
  };

  audio.onended = () => {
    btn.innerHTML = '<svg class="ui-icon-sm"><use href="#icon-play"/></svg>';
    updateVoiceWaveformActiveBars(msgId, 0);
    currentActiveVoiceAudio = null;
    currentVoiceBtn = null;
    currentVoiceMsgId = null;
  };

  audio.play().catch((err) => {
    showToast(`语音播放失败: ${err.message}`, 'error');
  });
}

function toggleVoiceSpeed(btn, msgId) {
  const speeds = [1.0, 1.5, 2.0];
  const current = parseFloat(btn.innerText) || 1.0;
  let nextIdx = speeds.indexOf(current) + 1;
  if (nextIdx >= speeds.length) nextIdx = 0;
  const newSpeed = speeds[nextIdx];
  btn.innerText = `${newSpeed.toFixed(1)}x`;
  if (currentActiveVoiceAudio) {
    currentActiveVoiceAudio.playbackRate = newSpeed;
  }
}

function voiceTranscriptionTargetIsCurrent(target) {
  return Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId &&
    (state.chatSelectionVersion || 0) === target.selectionVersion);
}

async function transcribeVoiceMessage(chatId, messageId) {
  const targetChatId = Number(chatId), msgId = Number(messageId);
  const target = { instId: state.clientSelectedInstance, chatId: targetChatId, selectionVersion: state.chatSelectionVersion || 0 };
  if (!target.instId || !Number.isSafeInteger(targetChatId) || targetChatId === 0 ||
      !Number.isSafeInteger(msgId) || msgId <= 0 || Number(state.clientActiveChatId) !== targetChatId) return;
  const container = document.getElementById(`voice-transcription-${msgId}`);
  const button = container?.querySelector('[data-transcribe-action]');
  const status = container?.querySelector('[data-transcription-status]');
  const text = container?.querySelector('[data-transcription-text]');
  const rating = container?.querySelector('[data-transcription-rating]');
  if (!container || !button || !status || !text || button.disabled || !voiceTranscriptionTargetIsCurrent(target)) return;
  button.disabled = true; button.textContent = '正在转写…'; status.hidden = false; status.textContent = '正在请求 Telegram 语音转写…';
  try {
    const result = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/transcribe`, 'POST', {
      chatId: target.chatId, messageId: msgId,
    });
    if (!voiceTranscriptionTargetIsCurrent(target) || !container.isConnected) return;
    if (result?.pending) {
      status.textContent = 'Telegram 正在处理，请稍后重试。';
      button.disabled = false; button.textContent = '重试转写';
      return;
    }
    if (typeof result?.text !== 'string' || !result.text) {
      status.textContent = 'Telegram 没有返回转写文本。';
      button.disabled = false; button.textContent = '重试转写';
      return;
    }
    text.textContent = result.text; text.hidden = false; status.hidden = true;
    button.hidden = true; rating.hidden = false;
    rating.querySelector('[data-transcription-good]').onclick = () => { void rateVoiceTranscription(target, msgId, result.transcriptionId, true, rating); };
    rating.querySelector('[data-transcription-bad]').onclick = () => { void rateVoiceTranscription(target, msgId, result.transcriptionId, false, rating); };
  } catch (error) {
    if (!voiceTranscriptionTargetIsCurrent(target) || !container.isConnected) return;
    status.textContent = `转写失败：${error.message}`;
    button.disabled = false; button.textContent = '重试转写';
  }
}

async function rateVoiceTranscription(target, messageId, transcriptionId, good, container) {
  if (!voiceTranscriptionTargetIsCurrent(target) || !container?.isConnected || container.dataset.pending === 'true') return;
  container.dataset.pending = 'true';
  const buttons = container.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/transcribe/rate`, 'POST', {
      chatId: target.chatId, messageId, transcriptionId: String(transcriptionId), good,
    });
    if (!voiceTranscriptionTargetIsCurrent(target) || !container.isConnected) return;
    container.textContent = '感谢反馈';
  } catch (error) {
    if (!voiceTranscriptionTargetIsCurrent(target) || !container.isConnected) return;
    container.dataset.pending = 'false';
    buttons.forEach(button => { button.disabled = false; });
    showToast(`反馈提交失败：${error.message}`, 'error');
  }
}

function handleSendAttachment(fileOrFiles) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : fileOrFiles ? [fileOrFiles] : [];
  if (!files.length) return;
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  stageAttachmentFile(files);
}

function updatePaidMediaComposerControl() {
  const button = document.getElementById('btn-chat-paid-media');
  if (!button) return;
  const dialog = state.clientActiveDialog || (state.clientDialogs || []).find(item => String(item.id) === String(state.clientActiveChatId));
  const files = Array.isArray(state.clientStagedFiles) ? state.clientStagedFiles : [];
  const supported = files.length > 0 && files.length <= 10 && files.every(file =>
    /^(?:image\/(?:jpeg|png|webp|heic|heif)|video\/(?:mp4|webm|quicktime|x-m4v|3gpp))$/i.test(file.type || ''));
  button.hidden = !(dialog?.type === 'channel' && dialog?.isBroadcast && supported) || state.clientVideoNote === true;
  button.textContent = state.clientPaidMediaStars
    ? `每项 ${state.clientPaidMediaStars} ⭐ · 付费媒体`
    : '设置付费媒体价格';
}

function editStagedPaidMediaPrice() {
  const raw = window.prompt('为每项照片或视频设置 Stars 价格（1–1000000）；留空可关闭付费媒体',
    state.clientPaidMediaStars ? String(state.clientPaidMediaStars) : '');
  if (raw === null) return;
  if (!raw.trim()) state.clientPaidMediaStars = null;
  else {
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) return showToast('请输入 1 到 1000000 之间的 Stars 整数', 'error');
    state.clientPaidMediaStars = value;
  }
  updatePaidMediaComposerControl();
}

// Lightbox Modal
let lightboxRotation = 0;

function openLightbox(src, title) {
  const modal = document.getElementById('modal-lightbox');
  const img = document.getElementById('lightbox-img');
  const titleEl = document.getElementById('lightbox-title');
  const dlBtn = document.getElementById('btn-lightbox-download');
  const prevBtn = document.getElementById('btn-lightbox-prev');
  const nextBtn = document.getElementById('btn-lightbox-next');
  if (!modal || !img) return;

  // Collect all photos in current chat
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  state.lightboxImages = [];
  if (Array.isArray(state.clientMessages)) {
    for (const m of state.clientMessages) {
      if (m.media && m.media.type === 'photo') {
        const fullUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const sender = m.outgoing ? '我' : m.from?.firstName || m.from?.username || `ID:${m.from?.id || '?'}`;
        state.lightboxImages.push({ url: fullUrl, title: `${sender} 的图片 (#${m.id})` });
      }
    }
  }

  state.lightboxCurrentIdx = state.lightboxImages.findIndex((item) => item.url === src);
  if (state.lightboxCurrentIdx === -1 && src) {
    state.lightboxImages.unshift({ url: src, title: title || '图片查看' });
    state.lightboxCurrentIdx = 0;
  }

  lightboxRotation = 0;
  img.style.transform = 'scale(1) rotate(0deg)';
  img.src = src;
  if (titleEl) titleEl.innerText = title || '图片查看';
  if (dlBtn) dlBtn.href = src;

  const hasMultiple = state.lightboxImages.length > 1;
  if (prevBtn) prevBtn.style.display = hasMultiple ? 'flex' : 'none';
  if (nextBtn) nextBtn.style.display = hasMultiple ? 'flex' : 'none';

  modal.classList.add('active');
}

function navigateLightbox(direction) {
  if (!state.lightboxImages || state.lightboxImages.length <= 1) return;
  if (direction === 'prev') {
    state.lightboxCurrentIdx = (state.lightboxCurrentIdx - 1 + state.lightboxImages.length) % state.lightboxImages.length;
  } else {
    state.lightboxCurrentIdx = (state.lightboxCurrentIdx + 1) % state.lightboxImages.length;
  }

  const item = state.lightboxImages[state.lightboxCurrentIdx];
  if (!item) return;

  const img = document.getElementById('lightbox-img');
  const titleEl = document.getElementById('lightbox-title');
  const dlBtn = document.getElementById('btn-lightbox-download');

  lightboxRotation = 0;
  if (img) {
    img.style.transform = 'scale(1) rotate(0deg)';
    img.src = item.url;
  }
  if (titleEl) titleEl.innerText = `${item.title} (${state.lightboxCurrentIdx + 1}/${state.lightboxImages.length})`;
  if (dlBtn) dlBtn.href = item.url;
}

function closeLightbox() {
  const modal = document.getElementById('modal-lightbox');
  if (modal) modal.classList.remove('active');
  const img = document.getElementById('lightbox-img');
  if (img) img.src = '';
  state.lightboxImages = [];
  state.lightboxCurrentIdx = -1;
}

// Right Drawer: Profile & Stories & Shared Media
let profileRequestId = 0;
let sharedMediaRequestId = 0;
let storyViewer = null;
let storyViewerSequence = 0;
let sharedStoryRequestId = 0;
let storyArchiveState = null;
let profileStoryAlbumsState = null;
let storyFeedRequestId = 0;
let storyFeedEpoch = 0;
let storyFeedState = '';
let storyFeedHasMore = false;
let storyFeedLoading = false;
let storyFeedHiddenView = false;
let storyFeedPeers = [];

function renderClientStoriesFeed() {
  const list = document.getElementById('client-stories-list');
  const more = document.getElementById('btn-client-stories-more');
  if (!list) return;
  list.replaceChildren();
  if (!storyFeedPeers.length) {
    const empty = document.createElement('div');
    empty.className = 'story-feed-status';
    empty.textContent = !state.clientSelectedInstance ? '请先选择账号' : storyFeedHiddenView ? '没有已隐藏的动态' : '暂无好友动态';
    list.appendChild(empty);
  }
  for (const peer of storyFeedPeers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `story-feed-peer${peer.isRead ? '' : ' unread'}`;
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-label', `${peer.title}${peer.isRead ? '' : '，有未读动态'}，${peer.stories.length} 条`);
    const avatar = document.createElement('span');
    avatar.className = 'story-feed-avatar';
    const initials = String(peer.title || '?').trim().split(/\s+/).map(part => part[0]).filter(Boolean).slice(0, 2).join('');
    avatar.textContent = initials || '?';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/instances/${encodeURIComponent(state.clientSelectedInstance)}/account/avatar?chatId=${encodeURIComponent(peer.id)}&isBig=0`;
    img.onerror = () => img.remove();
    avatar.appendChild(img);
    const label = document.createElement('span');
    label.className = 'story-feed-peer-name';
    label.textContent = peer.title || `用户 ${peer.id}`;
    button.append(avatar, label);
    button.onclick = () => openStoryViewer(peer.id, peer.stories, 0, {
      source: 'feed', isSelf: Boolean(peer.isSelf), storiesHidden: Boolean(peer.isHidden),
    });
    list.appendChild(button);
  }
  if (more) {
    more.hidden = !storyFeedHasMore;
    more.disabled = storyFeedLoading;
    more.textContent = storyFeedLoading && storyFeedPeers.length ? '正在加载…' : '加载更多';
  }
}

async function loadClientStoriesFeed(reset = true, preserveViewer = false) {
  if (storyFeedLoading && !reset) return;
  const instId = state.clientSelectedInstance;
  if (reset) {
    storyFeedEpoch++;
    if (preserveViewer && storyViewer?.session?.source === 'feed') storyViewer.session.feedEpoch = storyFeedEpoch;
    storyFeedState = '';
    storyFeedHasMore = false;
    storyFeedPeers = [];
    storyFeedLoading = false;
  }
  const epoch = storyFeedEpoch;
  const request = ++storyFeedRequestId;
  const current = () => request === storyFeedRequestId && epoch === storyFeedEpoch && state.clientSelectedInstance === instId;
  const list = document.getElementById('client-stories-list');
  const status = document.getElementById('client-stories-status');
  const more = document.getElementById('btn-client-stories-more');
  if (!instId) {
    if (list) { list.replaceChildren(); const empty = document.createElement('div'); empty.className = 'story-feed-status'; empty.textContent = '请先选择账号'; list.appendChild(empty); }
    if (status) status.textContent = '';
    if (more) { more.hidden = true; more.disabled = false; }
    return;
  }
  const instance = state.instances.find(item => item.config.id === instId);
  if (!instance || instance.status !== 'ONLINE') {
    if (list) { list.replaceChildren(); const empty = document.createElement('div'); empty.className = 'story-feed-status'; empty.textContent = '账号在线后显示动态'; list.appendChild(empty); }
    if (status) status.textContent = '';
    if (more) { more.hidden = true; more.disabled = false; }
    return;
  }
  if (storyFeedLoading) return;
  storyFeedLoading = true;
  if (status) status.textContent = '';
  if (reset && list) { list.replaceChildren(); const loading = document.createElement('div'); loading.className = 'story-feed-status'; loading.textContent = '正在加载动态…'; list.appendChild(loading); }
  if (more) more.disabled = true;
  const cursor = reset ? '' : storyFeedState;
  try {
    const query = new URLSearchParams();
    if (cursor) query.set('state', cursor);
    if (!reset) query.set('next', '1');
    if (storyFeedHiddenView) query.set('hidden', '1');
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/stories/feed?${query}`);
    if (!current()) return;
    const entries = Array.isArray(result?.peers) ? result.peers : [];
    const combined = reset ? [] : [...storyFeedPeers];
    const indexes = new Map(combined.map((peer, index) => [String(peer.id), index]));
    for (const peer of entries) {
      const key = String(peer.id);
      if (indexes.has(key)) combined[indexes.get(key)] = peer;
      else { indexes.set(key, combined.length); combined.push(peer); }
    }
    storyFeedPeers = combined;
    storyFeedState = typeof result?.state === 'string' ? result.state : '';
    storyFeedHasMore = Boolean(result?.hasMore && storyFeedState);
    renderClientStoriesFeed();
    if (status) {
      status.textContent = result?.hasMore && !storyFeedState ? 'Telegram 暂未返回后续页游标，请刷新后重试。' :
        `${storyFeedPeers.length}${Number(result?.count) > storyFeedPeers.length ? ` / ${Number(result.count)}` : ''} 位${storyFeedHiddenView ? '已隐藏联系人' : '联系人'}`;
    }
  } catch (error) {
    if (current() && status) status.textContent = `无法加载动态：${error.message}`;
    if (current() && reset && list) { list.replaceChildren(); const empty = document.createElement('div'); empty.className = 'story-feed-status'; empty.textContent = '加载失败'; list.appendChild(empty); }
  } finally {
    if (current()) {
      storyFeedLoading = false;
      renderClientStoriesFeed();
      if (more) more.disabled = false;
    }
  }
}

function ensureStoryViewer() {
  if (storyViewer) return storyViewer;
  const overlay = document.createElement('div');
  overlay.className = 'story-viewer-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<section class="story-viewer" role="dialog" aria-modal="true" aria-label="Telegram 动态">
    <header class="story-viewer-header"><span class="story-viewer-position"></span><div class="story-viewer-controls"><button type="button" class="btn btn-secondary btn-sm" data-story-stealth title="隐藏最近和接下来一段时间的动态浏览记录" hidden>隐身浏览</button><button type="button" class="btn btn-secondary btn-sm" data-story-notifications hidden>静音动态提醒</button><button type="button" class="btn btn-secondary btn-sm" data-story-hide hidden></button><button type="button" class="btn btn-secondary btn-sm" data-story-pin hidden></button><button type="button" class="btn btn-secondary btn-sm" data-story-copy-link>复制动态链接</button><button type="button" class="btn btn-secondary btn-sm" data-story-close aria-label="关闭动态">关闭</button></div></header>
    <div class="story-viewer-stage"><button type="button" class="story-viewer-nav" data-story-prev aria-label="上一条动态">‹</button><div class="story-viewer-media"></div><button type="button" class="story-viewer-nav" data-story-next aria-label="下一条动态">›</button></div>
    <p class="story-viewer-caption"></p><div class="story-viewer-reply" data-story-reply hidden><input type="text" maxlength="4096" autocomplete="off" aria-label="回复此动态" placeholder="发送回复…"><button type="button" class="btn btn-primary btn-sm">发送</button></div>
    <div class="story-viewer-reactions" role="group" aria-label="动态反应">
      <button type="button" data-story-emoji="❤️" aria-label="爱心反应">❤️</button><button type="button" data-story-emoji="👍" aria-label="赞反应">👍</button>
      <button type="button" data-story-emoji="👎" aria-label="踩反应">👎</button><button type="button" data-story-emoji="😂" aria-label="笑哭反应">😂</button>
      <button type="button" data-story-emoji="🔥" aria-label="火焰反应">🔥</button><button type="button" data-story-emoji="🎉" aria-label="庆祝反应">🎉</button>
    </div><div class="story-viewer-status" role="status"></div>
  </section>`;
  document.body.appendChild(overlay);
  storyViewer = {
    overlay, header: overlay.querySelector('.story-viewer-position'), media: overlay.querySelector('.story-viewer-media'),
    caption: overlay.querySelector('.story-viewer-caption'), status: overlay.querySelector('.story-viewer-status'),
    reply: overlay.querySelector('[data-story-reply]'), replyInput: overlay.querySelector('[data-story-reply] input'),
    replyButton: overlay.querySelector('[data-story-reply] button'),
    previous: overlay.querySelector('[data-story-prev]'), next: overlay.querySelector('[data-story-next]'), session: null,
    mediaPointer: null,
    stealth: overlay.querySelector('[data-story-stealth]'),
    notifications: overlay.querySelector('[data-story-notifications]'),
    hideStories: overlay.querySelector('[data-story-hide]'),
    pin: overlay.querySelector('[data-story-pin]'),
    copyLink: overlay.querySelector('[data-story-copy-link]'),
    reactions: Array.from(overlay.querySelectorAll('[data-story-emoji]')),
  };
  overlay.querySelector('[data-story-close]').onclick = closeStoryViewer;
  overlay.onclick = event => { if (event.target === overlay) closeStoryViewer(); };
  storyViewer.previous.onclick = () => showStoryAt(storyViewer.session?.index - 1);
  storyViewer.next.onclick = () => showStoryAt(storyViewer.session?.index + 1);
  storyViewer.stealth.onclick = () => { void activateStoryStealth(); };
  storyViewer.notifications.onclick = () => { void toggleStoryNotificationSetting(); };
  storyViewer.hideStories.onclick = () => { void toggleStoryPeerHidden(); };
  storyViewer.pin.onclick = () => { void toggleStoryPinned(); };
  storyViewer.copyLink.onclick = () => { void copyStoryLink(); };
  storyViewer.replyButton.onclick = () => { void replyToStory(); };
  storyViewer.replyInput.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void replyToStory(); }
  };
  storyViewer.reactions.forEach(button => { button.onclick = () => { void reactToStory(button.dataset.storyEmoji); }; });
  const isInteractiveMediaTarget = target => Boolean(target?.closest?.('button, a, input, textarea, select, video, audio'));
  storyViewer.media.addEventListener('pointerdown', event => {
    if (!storyViewer || storyViewer.overlay.hidden || event.isPrimary === false || event.button > 0 || isInteractiveMediaTarget(event.target)) return;
    storyViewer.mediaPointer = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, time: Date.now() };
  });
  storyViewer.media.addEventListener('pointercancel', () => { if (storyViewer) storyViewer.mediaPointer = null; });
  storyViewer.media.addEventListener('pointerup', event => {
    const pointer = storyViewer?.mediaPointer;
    if (!pointer) return;
    storyViewer.mediaPointer = null;
    const session = storyViewer?.session;
    if (!session || storyViewer.overlay.hidden || pointer.pointerId !== event.pointerId || isInteractiveMediaTarget(event.target)) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (Math.abs(dx) >= 52 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      const next = session.index + (dx < 0 ? 1 : -1);
      if (next >= 0 && next < session.stories.length) { event.preventDefault(); showStoryAt(next); }
      return;
    }
    if (Math.hypot(dx, dy) > 12 || Date.now() - pointer.time > 600) return;
    const box = storyViewer.media.getBoundingClientRect();
    if (!box.width) return;
    const position = (event.clientX - box.left) / box.width;
    const next = position < 1 / 3 ? session.index - 1 : position > 2 / 3 ? session.index + 1 : session.index;
    if (next !== session.index && next >= 0 && next < session.stories.length) { event.preventDefault(); showStoryAt(next); }
  });
  window.addEventListener('keydown', event => {
    if (!storyViewer || storyViewer.overlay.hidden) return;
    if (event.key === 'Escape') closeStoryViewer();
    else {
      const target = event.target;
      const editingText = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')));
      if (editingText || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); showStoryAt(storyViewer.session?.index - 1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); showStoryAt(storyViewer.session?.index + 1); }
    }
  });
  return storyViewer;
}

function closeStoryViewer() {
  if (!storyViewer) return;
  storyViewer.session?.areaObserver?.disconnect();
  storyViewerSequence++;
  storyViewer.mediaPointer = null;
  storyViewer.session = null;
  storyViewer.overlay.hidden = true;
  const video = storyViewer.media.querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  storyViewer.media.replaceChildren();
}

function storyViewerIsCurrent(session, sequence) {
  return storyViewer?.session === session && storyViewerSequence === sequence &&
    storyPeerTargetIsCurrent(session);
}

function storyPeerTargetIsCurrent(session) {
  if (!session || state.clientSelectedInstance !== session.instId || state.chatSelectionVersion !== session.selectionVersion) return false;
  if (session.source === 'feed') return session.feedEpoch === storyFeedEpoch;
  if (session.source === 'message') return Number(state.clientActiveChatId) === Number(session.originChatId);
  return profileRequestId === session.profileRequestId && String(state.currentProfileChatId) === String(session.chatId);
}

async function refreshStoryViewerForUpdate(instId, chatId, storyId) {
  const viewer = storyViewer;
  const session = viewer?.session;
  if (Number(state.currentProfileChatId) === Number(chatId)) void loadPeerStories(chatId);
  if (!session || !storyId || session.instId !== instId ||
      String(session.chatId) !== String(chatId) || !storyPeerTargetIsCurrent(session)) return;
  const targetIndex = session.stories.findIndex(story => Number(story.id) === Number(storyId));
  if (targetIndex < 0) return;
  const requestId = (session.refreshRequestId || 0) + 1;
  session.refreshRequestId = requestId;
  try {
    const story = await api(`/api/instances/${encodeURIComponent(instId)}/account/story?chatId=${encodeURIComponent(chatId)}&storyId=${encodeURIComponent(storyId)}`);
    if (viewer.session !== session || session.refreshRequestId !== requestId || !storyPeerTargetIsCurrent(session)) return;
    const currentIndex = session.index;
    if (!story || !Number.isSafeInteger(Number(story.id)) || Number(story.id) !== Number(storyId)) {
      session.stories.splice(targetIndex, 1);
      if (!session.stories.length) {
        if (session.source !== 'feed' || (!navigateStoryFeedPeer(1) && !navigateStoryFeedPeer(-1))) closeStoryViewer();
        return;
      }
      session.index = targetIndex < currentIndex ? currentIndex - 1 : Math.min(currentIndex, session.stories.length - 1);
      showStoryAt(session.index);
      return;
    }
    session.stories[targetIndex] = story;
    if (targetIndex === currentIndex) showStoryAt(targetIndex);
  } catch (error) {
    if (viewer.session === session && session.refreshRequestId === requestId && storyPeerTargetIsCurrent(session)) {
      viewer.status.textContent = `动态已更新，但无法同步当前查看器：${error.message}`;
    }
  }
}

function storyStealthTargetIsCurrent(session) {
  return Boolean(session && storyViewer?.session === session && storyPeerTargetIsCurrent(session));
}

async function loadStoryStealthStatus(session) {
  if (!storyStealthTargetIsCurrent(session) || session.isSelf) return;
  try {
    const status = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/stealth`);
    if (!storyStealthTargetIsCurrent(session)) return;
    const activeUntil = Number(status?.activeUntilDate) || 0;
    const cooldownUntil = Number(status?.cooldownUntilDate) || 0;
    const now = Math.floor(Date.now() / 1000);
    session.stealthActive = activeUntil > now;
    session.stealthCoolingDown = !session.stealthActive && cooldownUntil > now;
    if (session.stealthActive) {
      storyViewer.stealth.textContent = '隐身浏览中';
      storyViewer.stealth.title = `隐身浏览至 ${new Date(activeUntil * 1000).toLocaleTimeString()}`;
      storyViewer.stealth.disabled = true;
    } else if (session.stealthCoolingDown) {
      storyViewer.stealth.textContent = '隐身浏览冷却中';
      storyViewer.stealth.title = `可于 ${new Date(cooldownUntil * 1000).toLocaleTimeString()} 再次使用`;
      storyViewer.stealth.disabled = true;
    } else {
      storyViewer.stealth.textContent = '隐身浏览';
      storyViewer.stealth.title = '隐藏最近和接下来一段时间的动态浏览记录';
      storyViewer.stealth.disabled = false;
    }
  } catch {
    // The viewer remains usable if Telegram cannot return the optional status.
    if (storyStealthTargetIsCurrent(session)) storyViewer.stealth.disabled = false;
  } finally {
    session.stealthStatusPending = false;
  }
}

async function loadStoryNotificationSetting(session) {
  if (!storyPeerTargetIsCurrent(session) || session.isSelf) return;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/notifications?chatId=${encodeURIComponent(session.chatId)}`);
    if (!storyStealthTargetIsCurrent(session)) return;
    session.storyNotificationsMuted = Boolean(result?.muted);
    storyViewer.notifications.textContent = session.storyNotificationsMuted ? '恢复动态提醒' : '静音动态提醒';
    storyViewer.notifications.disabled = false;
  } catch {
    if (storyStealthTargetIsCurrent(session)) {
      storyViewer.notifications.disabled = true;
      storyViewer.notifications.textContent = '提醒状态不可用';
      storyViewer.notifications.title = '无法从 Telegram 读取此联系人的动态提醒设置';
    }
  } finally { session.storyNotificationsPending = false; }
}

async function toggleStoryNotificationSetting() {
  const viewer = storyViewer;
  const session = viewer?.session;
  if (!session || session.isSelf || session.storyNotificationsPending || typeof session.storyNotificationsMuted !== 'boolean') return;
  const muted = !session.storyNotificationsMuted;
  session.storyNotificationsPending = true;
  viewer.notifications.disabled = true;
  viewer.notifications.textContent = '正在保存…';
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/notifications`, 'POST', { chatId: session.chatId, muted });
    if (!storyStealthTargetIsCurrent(session)) return;
    session.storyNotificationsMuted = muted;
    viewer.notifications.textContent = muted ? '恢复动态提醒' : '静音动态提醒';
    viewer.status.textContent = muted ? '已静音此联系人的动态提醒。' : '已恢复此联系人的动态提醒。';
  } catch (error) {
    if (storyStealthTargetIsCurrent(session)) {
      viewer.notifications.textContent = session.storyNotificationsMuted ? '恢复动态提醒' : '静音动态提醒';
      viewer.status.textContent = `动态提醒设置失败：${error.message}`;
    }
  } finally {
    session.storyNotificationsPending = false;
    if (storyStealthTargetIsCurrent(session)) viewer.notifications.disabled = false;
  }
}

async function activateStoryStealth() {
  const viewer = storyViewer;
  const session = viewer?.session;
  if (!session || session.isSelf || session.stealthPending || session.stealthStatusPending ||
      session.stealthActive || session.stealthCoolingDown) return;
  session.stealthPending = true;
  viewer.stealth.disabled = true;
  viewer.stealth.textContent = '正在启用…';
  try {
    const status = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/stealth`, 'POST', {});
    if (!storyStealthTargetIsCurrent(session)) return;
    session.stealthActive = true;
    session.stealthCoolingDown = false;
    viewer.stealth.textContent = '隐身浏览已启用';
    const activeUntil = Number(status?.activeUntilDate) || 0;
    if (activeUntil > Math.floor(Date.now() / 1000)) {
      viewer.stealth.textContent = '隐身浏览中';
      viewer.stealth.title = `隐身浏览至 ${new Date(activeUntil * 1000).toLocaleTimeString()}`;
    }
    viewer.status.textContent = '已请求 Telegram 隐藏最近和接下来一段时间的动态浏览记录。';
  } catch (error) {
    if (storyStealthTargetIsCurrent(session)) {
      viewer.stealth.disabled = false;
      viewer.stealth.textContent = '隐身浏览';
      viewer.status.textContent = `启用隐身浏览失败：${error.message}`;
    }
  } finally {
    session.stealthPending = false;
  }
}

async function setStoryPeerHidden(session, hidden) {
  if (!storyPeerTargetIsCurrent(session) || session.isSelf || session.visibilityPending) return;
  session.visibilityPending = true;
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/hidden`, 'POST', {
      chatId: session.chatId, hidden,
    });
    if (!storyPeerTargetIsCurrent(session)) return;
    if (session.source !== 'feed') state.currentProfileStoriesHidden = hidden;
    session.storiesHidden = hidden;
    if (storyViewer?.session?.chatId === session.chatId && storyViewer.session.instId === session.instId) {
      storyViewer.hideStories.textContent = hidden ? '取消隐藏动态' : '隐藏动态';
      storyViewer.hideStories.disabled = false;
    }
    showToast(hidden ? '已隐藏此用户的动态' : '已取消隐藏此用户的动态', 'success');
    if (session.source === 'feed') {
      const peer = storyFeedPeers.find(item => String(item.id) === String(session.chatId));
      if (peer) peer.isHidden = hidden;
      void loadClientStoriesFeed(true, true);
    } else loadPeerStories(session.chatId);
  } catch (error) {
    if (storyPeerTargetIsCurrent(session)) {
      if (storyViewer?.session?.chatId === session.chatId) storyViewer.status.textContent = `动态设置失败：${error.message}`;
      else showToast(`动态设置失败：${error.message}`, 'error');
    }
  } finally {
    session.visibilityPending = false;
    if (storyViewer?.session === session) {
      storyViewer.hideStories.disabled = false;
      storyViewer.hideStories.textContent = session.storiesHidden ? '取消隐藏动态' : '隐藏动态';
    }
  }
}

function toggleStoryPeerHidden() {
  const session = storyViewer?.session;
  if (!session || session.isSelf) return;
  storyViewer.hideStories.disabled = true;
  storyViewer.hideStories.textContent = '正在保存…';
  return setStoryPeerHidden(session, !session.storiesHidden);
}

async function toggleStoryPinned() {
  const viewer = storyViewer, session = viewer?.session, story = session?.stories?.[session.index];
  if (!session || session.chatId >= 0 || !story || viewer.pin.hidden || viewer.pin.disabled || !storyViewerIsCurrent(session)) return;
  const pinned = !Boolean(story.isPinned);
  viewer.pin.disabled = true;
  viewer.pin.textContent = '正在保存…';
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/pin`, 'POST', {
      chatId: session.chatId, storyId: story.id, pinned,
    });
    if (!storyViewerIsCurrent(session) || session.stories[session.index] !== story) return;
    story.isPinned = pinned;
    viewer.pin.textContent = pinned ? '从主页移除' : '固定到主页';
    viewer.status.textContent = pinned ? '动态已固定到主页' : '动态已从主页移除';
  } catch (error) {
    if (storyViewerIsCurrent(session)) viewer.status.textContent = `动态设置失败：${error.message}`;
  } finally {
    if (viewer.session === session) {
      viewer.pin.disabled = false;
      viewer.pin.textContent = story?.isPinned ? '从主页移除' : '固定到主页';
    }
  }
}

async function openSharedTelegramStory(storyChatId, storyId, storyIsSelf = false) {
  const instId = state.clientSelectedInstance;
  const originChatId = Number(state.clientActiveChatId);
  const selectionVersion = state.chatSelectionVersion;
  const peerId = Number(storyChatId), id = Number(storyId);
  if (!instId || !Number.isSafeInteger(originChatId) || originChatId === 0 ||
      !Number.isSafeInteger(peerId) || peerId === 0 || !Number.isSafeInteger(id) || id <= 0) {
    showToast('此动态链接无效', 'warn');
    return;
  }
  const request = ++sharedStoryRequestId;
  const isCurrent = () => request === sharedStoryRequestId && state.clientSelectedInstance === instId &&
    Number(state.clientActiveChatId) === originChatId && state.chatSelectionVersion === selectionVersion;
  try {
    const story = await api(`/api/instances/${encodeURIComponent(instId)}/account/story?chatId=${encodeURIComponent(peerId)}&storyId=${encodeURIComponent(id)}`);
    if (!isCurrent()) return;
    if (!story || Number(story.id) !== id) throw new Error('动态已删除或不可用');
    openStoryViewer(peerId, [story], 0, {
      source: 'message', originChatId, isSelf: storyIsSelf === true, storiesHidden: false,
    });
  } catch (error) {
    if (isCurrent()) showToast(`无法打开动态：${error.message}`, 'error');
  }
}

function openStoryViewer(chatId, stories, index, options = {}) {
  if (!Array.isArray(stories) || !stories[index]) return;
  const viewer = ensureStoryViewer();
  const ownStory = options.isSelf == null ? Boolean(state.currentProfileIsSelf) : Boolean(options.isSelf);
  const session = {
    instId: state.clientSelectedInstance, chatId, selectionVersion: state.chatSelectionVersion, profileRequestId, stories, index,
    source: ['feed', 'archive', 'message'].includes(options.source) ? options.source : 'profile',
    originChatId: options.source === 'message' ? Number(options.originChatId) : undefined,
    feedEpoch: options.source === 'feed' ? storyFeedEpoch : undefined,
    readReceipt: options.readReceipt ?? !ownStory,
    allowReaction: options.allowReaction ?? !ownStory,
    isSelf: ownStory,
    storiesHidden: options.storiesHidden == null ? Boolean(state.currentProfileStoriesHidden) : Boolean(options.storiesHidden),
    stealthStatusPending: !ownStory,
    storyNotificationsPending: !ownStory,
    replyPending: false,
  };
  viewer.session = session;
  viewer.overlay.hidden = false;
  viewer.stealth.hidden = ownStory;
  viewer.stealth.disabled = !ownStory;
  viewer.stealth.textContent = '读取状态…';
  viewer.notifications.hidden = ownStory;
  viewer.notifications.disabled = !ownStory;
  viewer.notifications.textContent = '读取提醒…';
  viewer.hideStories.hidden = ownStory;
  viewer.hideStories.disabled = false;
  viewer.hideStories.textContent = session.storiesHidden ? '取消隐藏动态' : '隐藏动态';
  viewer.pin.hidden = !(Number(chatId) < 0);
  viewer.pin.disabled = false;
  viewer.pin.textContent = stories[index]?.isPinned ? '从主页移除' : '固定到主页';
  viewer.reply.hidden = ownStory;
  viewer.replyInput.disabled = ownStory;
  viewer.replyButton.disabled = ownStory;
  viewer.replyInput.value = '';
  showStoryAt(index);
  if (!ownStory) {
    void loadStoryStealthStatus(session);
    void loadStoryNotificationSetting(session);
  }
}

function canNavigateStoryFeedPeer(session, direction) {
  if (!session || session.source !== 'feed' || (direction !== -1 && direction !== 1) || !storyPeerTargetIsCurrent(session)) return false;
  const current = storyFeedPeers.findIndex(peer => String(peer.id) === String(session.chatId));
  if (current < 0) return false;
  for (let index = current + direction; index >= 0 && index < storyFeedPeers.length; index += direction) {
    if (Array.isArray(storyFeedPeers[index]?.stories) && storyFeedPeers[index].stories.length) return true;
  }
  return false;
}

function navigateStoryFeedPeer(direction) {
  const session = storyViewer?.session;
  if (!canNavigateStoryFeedPeer(session, direction)) return false;
  const current = storyFeedPeers.findIndex(peer => String(peer.id) === String(session.chatId));
  for (let index = current + direction; index >= 0 && index < storyFeedPeers.length; index += direction) {
    const peer = storyFeedPeers[index];
    if (!Array.isArray(peer?.stories) || !peer.stories.length) continue;
    openStoryViewer(peer.id, peer.stories, direction > 0 ? 0 : peer.stories.length - 1, {
      source: 'feed', isSelf: Boolean(peer.isSelf), storiesHidden: Boolean(peer.isHidden),
    });
    return true;
  }
  return false;
}

function showStoryAt(index) {
  const viewer = storyViewer;
  const session = viewer?.session;
  if (!session || !Number.isInteger(index)) return;
  if (index < 0 || index >= session.stories.length) {
    navigateStoryFeedPeer(index < 0 ? -1 : 1);
    return;
  }
  const previousStory = session.stories[session.index];
  session.index = index;
  const story = session.stories[index];
  session.areaObserver?.disconnect();
  session.areaObserver = undefined;
  if (viewer.replyInput && previousStory?.id !== story.id) viewer.replyInput.value = '';
  const sequence = ++storyViewerSequence;
  viewer.media.replaceChildren();
  viewer.status.textContent = '正在加载动态…';
  viewer.header.textContent = `${index + 1} / ${session.stories.length}`;
  viewer.caption.textContent = story.caption || '';
  viewer.previous.disabled = index === 0 && !canNavigateStoryFeedPeer(session, -1);
  viewer.next.disabled = index === session.stories.length - 1 && !canNavigateStoryFeedPeer(session, 1);
  viewer.pin.textContent = story.isPinned ? '从主页移除' : '固定到主页';
  viewer.reactions.forEach(button => {
    button.classList.toggle('active', button.dataset.storyEmoji === story.sentReaction);
    button.hidden = session.allowReaction === false;
    button.disabled = session.allowReaction === false || Boolean(session.reactionPending);
  });
  const url = `/api/instances/${encodeURIComponent(session.instId)}/account/story-media?chatId=${encodeURIComponent(session.chatId)}&storyId=${encodeURIComponent(story.id)}`;
  const media = story.mediaType === 'video' ? document.createElement('video') : document.createElement('img');
  if (media.tagName === 'VIDEO') {
    media.controls = true; media.autoplay = true; media.playsInline = true;
    media.onended = () => { if (storyViewerIsCurrent(session, sequence)) showStoryAt(index + 1); };
  } else {
    media.alt = story.caption || 'Telegram 动态';
  }
  media.className = 'story-viewer-content';
  const areaLayer = document.createElement('div');
  areaLayer.className = 'story-viewer-area-layer';
  areaLayer.setAttribute('aria-label', '动态互动区域');
  const layoutAreas = () => {
    if (!storyViewerIsCurrent(session, sequence)) return;
    layoutStoryMediaAreas(session, sequence, media, areaLayer, story.mediaAreas || []);
  };
  media.onload = () => { if (storyViewerIsCurrent(session, sequence)) { viewer.status.textContent = ''; layoutAreas(); } };
  media.onerror = () => { if (storyViewerIsCurrent(session, sequence)) viewer.status.textContent = '无法加载动态媒体'; };
  if (media.tagName === 'VIDEO') media.onloadeddata = () => { if (storyViewerIsCurrent(session, sequence)) { viewer.status.textContent = ''; layoutAreas(); } };
  media.src = url;
  viewer.media.appendChild(media);
  viewer.media.appendChild(areaLayer);
  layoutAreas();
  if (typeof ResizeObserver === 'function') {
    session.areaObserver = new ResizeObserver(layoutAreas);
    session.areaObserver.observe(viewer.media);
  }
  if (session.readReceipt) {
    void api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/read`, 'POST', { chatId: session.chatId, storyId: story.id })
      .then(() => {
        if (!storyPeerTargetIsCurrent(session) || session.source !== 'feed') return;
        const newestId = Math.max(...session.stories.map(item => Number(item.id) || 0));
        if (Number(story.id) >= newestId) {
          const peer = storyFeedPeers.find(item => String(item.id) === String(session.chatId));
          if (peer) { peer.isRead = true; renderClientStoriesFeed(); }
        }
      })
      .catch(() => { if (storyViewerIsCurrent(session, sequence)) viewer.status.textContent = '动态已打开，但已读状态尚未确认'; });
  }
}

function layoutStoryMediaAreas(session, sequence, media, layer, areas) {
  const box = storyViewer?.media?.getBoundingClientRect();
  if (!box?.width || !box?.height) return;
  const mediaWidth = Number(media.naturalWidth || media.videoWidth || 0);
  const mediaHeight = Number(media.naturalHeight || media.videoHeight || 0);
  const ratio = mediaWidth > 0 && mediaHeight > 0 ? mediaWidth / mediaHeight : box.width / box.height;
  const boxRatio = box.width / box.height;
  const contentWidth = ratio > boxRatio ? box.width : box.height * ratio;
  const contentHeight = ratio > boxRatio ? box.width / ratio : box.height;
  layer.style.left = `${(box.width - contentWidth) / 2}px`;
  layer.style.top = `${(box.height - contentHeight) / 2}px`;
  layer.style.width = `${contentWidth}px`;
  layer.style.height = `${contentHeight}px`;
  layer.replaceChildren();
  (Array.isArray(areas) ? areas : []).slice(0, 100).forEach(area => {
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y) || !Number.isFinite(area.w) || !Number.isFinite(area.h)) return;
    const action = area.type === 'url' || area.type === 'geo' || area.type === 'venue' || area.type === 'channel_post' || area.type === 'star_gift' || (area.type === 'reaction' && session.allowReaction !== false);
    const control = document.createElement(action ? 'button' : 'span');
    if (action) { control.type = 'button'; control.addEventListener('click', () => activateStoryMediaArea(session, sequence, area)); }
    control.className = `story-viewer-area story-viewer-area-${String(area.type).replace(/[^a-z_]/g, '')}`;
    control.style.left = `${area.x}%`;
    control.style.top = `${area.y}%`;
    control.style.width = `${area.w}%`;
    control.style.height = `${area.h}%`;
    control.style.transform = `translate(-50%, -50%) rotate(${area.rotation || 0}deg)`;
    const label = area.type === 'reaction' ? area.emoji : area.type === 'weather' ? `${area.emoji} ${Math.round(area.temperatureC)}°` :
      area.type === 'venue' ? '⌖' : area.type === 'geo' ? '⌖' : area.type === 'star_gift' ? '🎁' : '↗';
    control.textContent = label;
    control.setAttribute('aria-label', area.type === 'venue' ? [area.title, area.address].filter(Boolean).join('，') || '打开地点' :
      area.type === 'reaction' ? `发送 ${area.emoji} 动态反应` : area.type === 'weather' ? `${area.emoji} ${area.temperatureC}°C` :
        area.type === 'star_gift' ? '查看 Telegram 礼物' : area.type === 'url' ? `打开链接 ${area.url}` : area.type === 'channel_post' ? '打开相关频道帖子' : '打开地点');
    if (area.type === 'venue' && area.title) control.title = area.title;
    layer.appendChild(control);
  });
}

function activateStoryMediaArea(session, sequence, area) {
  if (!storyViewerIsCurrent(session, sequence)) return;
  if (area.type === 'reaction') { if (session.allowReaction !== false) void reactToStory(area.emoji); return; }
  let url;
  if (area.type === 'url') {
    try {
      const parsed = new URL(area.url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
      url = parsed.href;
    } catch { return; }
  } else if (area.type === 'geo' || area.type === 'venue') {
    const latitude = Number(area.latitude), longitude = Number(area.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    const query = [area.title, area.address, `${latitude},${longitude}`].filter(Boolean).join(' ');
    url = `https://maps.google.com/?q=${encodeURIComponent(query)}`;
  } else if (area.type === 'channel_post' && /^\d{1,20}$/.test(String(area.channelId)) && Number.isSafeInteger(Number(area.messageId)) && Number(area.messageId) > 0) {
    url = `https://t.me/c/${area.channelId}/${Number(area.messageId)}`;
  } else if (area.type === 'star_gift' && /^[a-zA-Z0-9_-]{1,128}$/.test(String(area.slug))) {
    url = `https://t.me/nft/${encodeURIComponent(area.slug)}`;
  }
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

async function reactToStory(emoji) {
  const viewer = storyViewer;
  const session = viewer?.session;
  const story = session?.stories[session.index];
  if (!session || session.allowReaction === false || !story || session.reactionPending || !isSingleEmojiQuery(emoji)) return;
  const storyIndex = session.index;
  const remove = story.sentReaction === emoji;
  session.reactionPending = true;
  viewer.reactions.forEach(button => { button.disabled = true; });
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/reaction`, 'POST', {
      chatId: session.chatId, storyId: story.id, emoji: remove ? null : emoji,
    });
    if (viewer.session !== session) return;
    story.sentReaction = remove ? undefined : emoji;
    if (session.index === storyIndex) {
      viewer.reactions.forEach(button => button.classList.toggle('active', button.dataset.storyEmoji === story.sentReaction));
      viewer.status.textContent = '';
    }
  } catch (error) {
    if (viewer.session === session && session.index === storyIndex) viewer.status.textContent = `动态反应失败：${error.message}`;
  } finally {
    if (viewer.session === session) {
      session.reactionPending = false;
      viewer.reactions.forEach(button => { button.disabled = false; });
    }
  }
}

async function replyToStory() {
  const viewer = storyViewer;
  const session = viewer?.session;
  const story = session?.stories[session.index];
  const text = String(viewer?.replyInput?.value || '');
  if (!session || session.isSelf || !story || session.replyPending || !text.trim() || text.length > 4096) return;
  const storyId = story.id;
  const parseMode = ['plain', 'markdown', 'html'].includes(state.clientParseMode) ? state.clientParseMode : 'plain';
  session.replyPending = true;
  viewer.replyButton.disabled = true;
  viewer.status.textContent = '正在发送动态回复…';
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/reply`, 'POST', {
      chatId: session.chatId, storyId, text, parseMode,
    });
    if (viewer.session !== session || Number(session.stories[session.index]?.id) !== Number(storyId)) return;
    if (viewer.replyInput.value === text) viewer.replyInput.value = '';
    viewer.status.textContent = '回复已发送';
  } catch (error) {
    if (viewer.session === session && Number(session.stories[session.index]?.id) === Number(storyId)) {
      viewer.status.textContent = `动态回复失败：${error.message}`;
    }
  } finally {
    if (viewer.session === session) {
      session.replyPending = false;
      viewer.replyButton.disabled = false;
    }
  }
}

async function copyStoryLink() {
  const viewer = storyViewer;
  const session = viewer?.session;
  const story = session?.stories?.[session.index];
  if (!session || !story || viewer.copyLink.disabled) return;
  viewer.copyLink.disabled = true;
  viewer.status.textContent = '正在获取动态链接…';
  let generatedLink = '';
  try {
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/link`, 'POST', {
      chatId: session.chatId, storyId: story.id,
    });
    if (viewer.session !== session || Number(session.stories[session.index]?.id) !== Number(story.id)) return;
    generatedLink = typeof result?.link === 'string' ? result.link : '';
    if (!generatedLink) throw new Error('Telegram 未提供公开动态链接');
    if (!navigator.clipboard?.writeText) {
      viewer.status.textContent = `浏览器不支持复制，请手动复制：${generatedLink}`;
      return;
    }
    await navigator.clipboard.writeText(generatedLink);
    if (viewer.session === session && Number(session.stories[session.index]?.id) === Number(story.id)) viewer.status.textContent = '动态链接已复制';
  } catch (error) {
    if (viewer.session === session && Number(session.stories[session.index]?.id) === Number(story.id)) viewer.status.textContent = generatedLink
      ? `无法复制，请手动复制：${generatedLink}` : `无法获取动态链接：${error.message}`;
  } finally {
    if (viewer.session === session) viewer.copyLink.disabled = false;
  }
}

async function setPeerHistoryTtl(chatId, period, context) {
  const { instId, request, selectionVersion } = context;
  const select = document.getElementById('profile-history-ttl');
  const status = document.getElementById('profile-history-ttl-status');
  const isCurrent = () => request === profileRequestId && state.chatSelectionVersion === selectionVersion &&
    state.clientSelectedInstance === instId && String(state.currentProfileChatId) === String(chatId);
  if (!select || !isCurrent() || !Number.isSafeInteger(period) || period < 0 || period > 31536000) return;
  const previous = select.dataset?.savedPeriod ?? '0';
  select.disabled = true;
  if (status) status.textContent = '正在更新 Telegram 自动删除计时器…';
  try {
    const result = await api('/api/instances/' + encodeURIComponent(instId) + '/account/chat-history-ttl', 'POST', { chatId, period });
    if (!isCurrent()) return;
    const savedPeriod = Number(result?.period);
    if (!Number.isSafeInteger(savedPeriod) || savedPeriod < 0 || savedPeriod > 31536000) throw new Error('Telegram 未确认计时器');
    select.value = String(savedPeriod);
    if (select.dataset) select.dataset.savedPeriod = String(savedPeriod);
    if (status) status.textContent = savedPeriod ? '计时器已更新，仅影响之后发送的消息。' : '自动删除已关闭。';
  } catch (error) {
    if (!isCurrent()) return;
    select.value = previous;
    if (status) status.textContent = '更新失败：' + error.message;
  } finally {
    if (isCurrent()) select.disabled = false;
  }
}

function applyPeerHistoryTtlUpdate(chatId, period) {
  if (String(state.currentProfileChatId) !== String(chatId) || !Number.isSafeInteger(period) || period < 0 || period > 31536000) return;
  const select = document.getElementById('profile-history-ttl');
  if (!select) return;
  const supportedPeriods = [0, 86400, 172800, 259200, 345600, 432000, 518400, 604800, 1209600,
    1814400, 2592000, 5184000, 7776000, 10368000, 12960000, 15552000, 31536000];
  select.querySelectorAll?.('option[data-telegram-custom]')?.forEach(option => option.remove());
  if (period && !supportedPeriods.includes(period)) {
    const custom = document.createElement('option');
    custom.value = String(period);
    custom.textContent = '自定义（' + period + ' 秒）';
    custom.dataset.telegramCustom = 'true';
    select.appendChild(custom);
  }
  select.value = String(period);
  if (select.dataset) select.dataset.savedPeriod = String(period);
  const status = document.getElementById('profile-history-ttl-status');
  if (status) status.textContent = period ? '计时器已在其他 Telegram 客户端更新。' : '自动删除已在其他 Telegram 客户端关闭。';
}

async function loadPeerProfile(chatId) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId) return;
  if (storyViewer && !storyViewer.overlay.hidden) closeStoryViewer();
  const request = ++profileRequestId;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => request === profileRequestId &&
    state.chatSelectionVersion === selectionVersion && state.clientSelectedInstance === instId &&
    String(state.currentProfileChatId) === String(chatId);

  const drawer = document.getElementById('client-drawer');
  if (drawer) {
    drawer.style.display = 'flex';
    drawer.classList.add('open');
  }

  state.currentProfileChatId = chatId;
  state.currentPeerProfile = null;
  state.currentProfileIsSelf = false;
  state.currentProfileStoriesHidden = false;
  storyArchiveState = null;
  profileStoryAlbumsState = null;
  document.getElementById('profile-story-albums')?.setAttribute?.('hidden', '');
  document.getElementById('profile-story-albums-select')?.replaceChildren?.();
  document.getElementById('profile-story-albums-list')?.replaceChildren?.();
  document.getElementById('profile-story-albums-status')?.replaceChildren?.();
  const peerAlbumsMore = document.getElementById('btn-profile-story-albums-more');
  if (peerAlbumsMore) peerAlbumsMore.hidden = true;
  const archiveButton = document.getElementById('btn-profile-stories-archive');
  const archivePane = document.getElementById('profile-stories-archive');
  const activeStoriesPane = document.getElementById('profile-stories-container');
  if (archiveButton) { archiveButton.hidden = true; archiveButton.textContent = '查看动态档案'; archiveButton.setAttribute?.('aria-expanded', 'false'); }
  if (archivePane) archivePane.hidden = true;
  if (activeStoriesPane) activeStoriesPane.hidden = false;

  const displayNameEl = document.getElementById('profile-display-name');
  const usernameEl = document.getElementById('profile-username');
  const statusEl = document.getElementById('profile-status-badge');
  const bioEl = document.getElementById('profile-val-bio');
  const idEl = document.getElementById('profile-val-id');
  const phoneItem = document.getElementById('profile-item-phone');
  const phoneEl = document.getElementById('profile-val-phone');
  const membersItem = document.getElementById('profile-item-members');
  const membersEl = document.getElementById('profile-val-members');
  const historyTtlItem = document.getElementById('profile-item-history-ttl');
  const historyTtlSelect = document.getElementById('profile-history-ttl');
  const historyTtlStatus = document.getElementById('profile-history-ttl-status');
  if (historyTtlItem) historyTtlItem.hidden = true;
  if (historyTtlSelect) historyTtlSelect.disabled = true;
  if (historyTtlStatus) historyTtlStatus.textContent = '正在读取 Telegram 计时器…';
  const heroPlaceholder = document.getElementById('profile-hero-placeholder');

  const activeChat = state.clientDialogs.find((d) => String(d.id) === String(chatId)) ||
    (String(state.clientActiveChatId) === String(chatId) && String(state.clientActiveDialog?.id) === String(chatId)
      ? state.clientActiveDialog : null);
  const tabMembersBtn = document.getElementById('tab-btn-members');
  const isActiveGroupOrChannel = String(state.clientActiveChatId) === String(chatId) &&
    ['group', 'supergroup', 'channel'].includes(activeChat?.type);
  if (tabMembersBtn) {
    tabMembersBtn.style.display = isActiveGroupOrChannel ? 'inline-flex' : 'none';
    if (isActiveGroupOrChannel) {
      const count = activeChat.participantsCount ?? activeChat.membersCount ?? activeChat.subscribersCount ?? 0;
      tabMembersBtn.innerText = `成员 (${count})`;
      if (tabMembersBtn.classList?.contains?.('active')) void loadGroupMembers(chatId);
    } else if (tabMembersBtn.classList?.contains?.('active')) {
      const membersPane = document.getElementById('drawer-tab-members');
      if (membersPane) membersPane.style.display = 'none';
      const profilePane = document.getElementById('drawer-tab-profile');
      if (profilePane) profilePane.style.display = 'block';
      document.getElementById('tab-btn-profile')?.classList?.add?.('active');
      tabMembersBtn.classList.remove('active');
    }
  }
  const initials = (activeChat?.title || activeChat?.username || 'TG').slice(0, 2);
  if (heroPlaceholder) heroPlaceholder.innerText = initials;

  if (displayNameEl) displayNameEl.innerText = activeChat?.title || activeChat?.username || `Chat #${chatId}`;
  if (usernameEl) usernameEl.innerText = activeChat?.username ? `@${activeChat.username}` : '@未设置用户名';
  if (idEl) idEl.innerText = String(chatId);
  if (bioEl) bioEl.innerText = '正在加载资料...';
  if (phoneItem) phoneItem.style.display = 'none';
  if (membersItem) membersItem.style.display = 'none';
  const editGroupInfoButton = document.getElementById('btn-edit-group-info');
  if (editGroupInfoButton) editGroupInfoButton.hidden = true;
  const changeGroupPhotoButton = document.getElementById('btn-change-group-photo');
  if (changeGroupPhotoButton) changeGroupPhotoButton.hidden = true;
  const permissionsButton = document.getElementById('btn-edit-chat-permissions');
  if (permissionsButton) permissionsButton.hidden = true;

  try {
    const p = await api(`/api/instances/${instId}/account/peer-profile?chatId=${chatId}`);
    if (!isCurrent()) return;
    state.currentPeerProfile = p;
    state.currentProfileIsSelf = Boolean(p.isSelf);
    state.currentProfileStoriesHidden = Boolean(p.storiesHidden);
    if (historyTtlItem) historyTtlItem.hidden = Boolean(p.isSelf);
    if (historyTtlSelect) {
      const supportedPeriods = [0, 86400, 172800, 259200, 345600, 432000, 518400, 604800, 1209600,
        1814400, 2592000, 5184000, 7776000, 10368000, 12960000, 15552000, 31536000];
      const rawPeriod = Number(p.ttlPeriod);
      const period = Number.isSafeInteger(rawPeriod) && rawPeriod >= 0 && rawPeriod <= 31536000 ? rawPeriod : 0;
      historyTtlSelect.querySelectorAll?.('option[data-telegram-custom]')?.forEach(option => option.remove());
      if (period && !supportedPeriods.includes(period)) {
        const custom = document.createElement('option');
        custom.value = String(period);
        custom.textContent = '自定义（' + period + ' 秒）';
        custom.dataset.telegramCustom = 'true';
        historyTtlSelect.appendChild(custom);
      }
      historyTtlSelect.value = String(period);
      if (historyTtlSelect.dataset) historyTtlSelect.dataset.savedPeriod = String(period);
      historyTtlSelect.disabled = Boolean(p.isSelf);
      historyTtlSelect.onchange = () => {
        void setPeerHistoryTtl(chatId, Number(historyTtlSelect.value), { instId, request, selectionVersion });
      };
    }
    if (historyTtlStatus) historyTtlStatus.textContent = p.isSelf ? '' : '计时器仅影响启用后的新消息；可用权限由 Telegram 决定。';
    if (archiveButton) archiveButton.hidden = !state.currentProfileIsSelf;
    if (displayNameEl) displayNameEl.innerText = p.title || `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.username || `Chat #${chatId}`;
    if (usernameEl) usernameEl.innerText = p.username ? `@${p.username}` : '@未设置用户名';
    if (bioEl) bioEl.innerText = p.bio || p.about || '暂无简介说明';
    if (idEl) idEl.innerText = String(p.id || chatId);

    if (p.phone && phoneItem && phoneEl) {
      phoneItem.style.display = 'flex';
      phoneEl.innerText = p.phone;
    } else if (phoneItem) {
      phoneItem.style.display = 'none';
    }

    const participantCount = p.participantsCount ?? p.memberCount;
    if (editGroupInfoButton) editGroupInfoButton.hidden = !['group', 'supergroup', 'channel'].includes(p.type);
    if (changeGroupPhotoButton) changeGroupPhotoButton.hidden = !['group', 'supergroup', 'channel'].includes(p.type);
    if (permissionsButton) permissionsButton.hidden = !(['group', 'supergroup', 'channel'].includes(p.type) && p.defaultBannedRights);
    if (participantCount && membersItem && membersEl) {
      membersItem.style.display = 'flex';
      membersEl.innerText = `${participantCount.toLocaleString()} 位成员`;
    } else if (membersItem) {
      membersItem.style.display = 'none';
    }

    const tabMembersBtn = document.getElementById('tab-btn-members');
    const profileIsGroupOrChannel = Boolean(p.isGroup || p.isChannel || ['group', 'supergroup', 'channel'].includes(p.type));
    const activeChatMatchesProfile = String(activeChat?.id) === String(chatId);
    const isGroupOrChannel = profileIsGroupOrChannel ||
      (activeChatMatchesProfile && ['group', 'supergroup', 'channel'].includes(activeChat?.type));
    if (tabMembersBtn) {
      if (isGroupOrChannel) {
        tabMembersBtn.style.display = 'inline-flex';
        const count = participantCount ?? (activeChatMatchesProfile
          ? activeChat.participantsCount ?? activeChat.membersCount ?? activeChat.subscribersCount
          : undefined) ?? 0;
        tabMembersBtn.innerText = `成员 (${count})`;
      } else {
        tabMembersBtn.style.display = 'none';
        const mbPane = document.getElementById('drawer-tab-members');
        if (mbPane && mbPane.style.display !== 'none') {
          mbPane.style.display = 'none';
          document.getElementById('drawer-tab-profile').style.display = 'block';
          document.getElementById('tab-btn-profile')?.classList.add('active');
          tabMembersBtn.classList.remove('active');
        }
      }
    }

    if (statusEl) {
      if (p.isChannel || p.type === 'channel') statusEl.innerText = '广播频道';
      else if (p.isGroup || p.type === 'group' || p.type === 'supergroup') statusEl.innerText = '群组';
      else statusEl.innerText = p.status || '私聊联系人';
    }

    const pinnedBar = document.getElementById('chat-pinned-bar');
    const pinnedText = document.getElementById('chat-pinned-text');
    if (pinnedBar && pinnedText && String(state.clientActiveChatId) === String(chatId)) {
      if (p.pinnedMsgId) {
        pinnedText.innerText = `置顶消息 #${p.pinnedMsgId} (查看置顶列表)`;
        pinnedBar.style.display = 'flex';
        pinnedBar.onclick = (e) => {
          if (e.target.closest('#btn-pinned-close')) {
            pinnedBar.style.display = 'none';
            return;
          }
          window.PinnedMessages?.open();
        };
      } else {
        pinnedBar.style.display = 'none';
      }
    }
  } catch (err) {
    if (!isCurrent()) return;
    if (bioEl) bioEl.innerText = '无法获取详细资料';
  }

  if (!isCurrent()) return;
  loadUserPhotos(chatId);
  loadPeerStories(chatId);
  if (!state.currentProfileIsSelf && !state.currentProfileStoriesHidden) void loadPeerStoryAlbums(chatId);
  loadSharedMedia(state.sharedMediaTab || 'photos');
}

async function loadUserPhotos(chatId) {
  const instId = state.clientSelectedInstance;
  const request = profileRequestId;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => request === profileRequestId && state.chatSelectionVersion === selectionVersion && state.clientSelectedInstance === instId &&
    String(state.currentProfileChatId) === String(chatId);
  const heroImg = document.getElementById('profile-hero-img');
  const heroPlaceholder = document.getElementById('profile-hero-placeholder');
  const counterBadge = document.getElementById('profile-photo-counter');
  const prevBtn = document.getElementById('btn-profile-photo-prev');
  const nextBtn = document.getElementById('btn-profile-photo-next');

  state.profilePhotos = [];
  state.currentPhotoIndex = 0;

  try {
    const photos = await api(`/api/instances/${instId}/account/user-photos?userId=${chatId}&limit=20`);
    if (!isCurrent()) return;
    state.profilePhotos = Array.isArray(photos) ? photos : [];

    if (state.profilePhotos.length > 0) {
      updateHeroPhotoDisplay(chatId);
      if (counterBadge) counterBadge.style.display = 'block';
      if (prevBtn) prevBtn.style.display = state.profilePhotos.length > 1 ? 'flex' : 'none';
      if (nextBtn) nextBtn.style.display = state.profilePhotos.length > 1 ? 'flex' : 'none';
    } else {
      if (counterBadge) counterBadge.style.display = 'none';
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      if (heroImg && heroPlaceholder) {
        heroImg.src = `/api/instances/${instId}/account/avatar?chatId=${chatId}&isBig=1`;
        heroImg.onload = () => {
          if (!isCurrent()) return;
          heroImg.style.display = 'block';
          heroPlaceholder.style.display = 'none';
        };
        heroImg.onerror = () => {
          if (!isCurrent()) return;
          heroImg.style.display = 'none';
          heroPlaceholder.style.display = 'flex';
        };
      }
    }
  } catch (err) {
    if (!isCurrent()) return;
    if (counterBadge) counterBadge.style.display = 'none';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    if (heroImg && heroPlaceholder) {
      heroImg.src = `/api/instances/${instId}/account/avatar?chatId=${chatId}&isBig=1`;
      heroImg.onload = () => {
        if (!isCurrent()) return;
        heroImg.style.display = 'block';
        heroPlaceholder.style.display = 'none';
      };
      heroImg.onerror = () => {
        if (!isCurrent()) return;
        heroImg.style.display = 'none';
        heroPlaceholder.style.display = 'flex';
      };
    }
  }
}

function updateHeroPhotoDisplay(chatId) {
  const heroImg = document.getElementById('profile-hero-img');
  const heroPlaceholder = document.getElementById('profile-hero-placeholder');
  const counterBadge = document.getElementById('profile-photo-counter');
  const instId = state.clientSelectedInstance;
  const request = profileRequestId;
  const selectionVersion = state.chatSelectionVersion;

  if (state.profilePhotos.length === 0) return;
  const idx = state.currentPhotoIndex;
  const isCurrent = () => request === profileRequestId && state.chatSelectionVersion === selectionVersion &&
    state.clientSelectedInstance === instId && String(state.currentProfileChatId) === String(chatId) &&
    state.currentPhotoIndex === idx;
  if (counterBadge) {
    counterBadge.innerText = `${idx + 1} / ${state.profilePhotos.length}`;
  }

  if (heroImg && heroPlaceholder) {
    heroImg.src = `/api/instances/${instId}/account/user-photo-file?userId=${chatId}&index=${idx}`;
    heroImg.onload = () => {
      if (!isCurrent()) return;
      heroImg.style.display = 'block';
      heroPlaceholder.style.display = 'none';
    };
    heroImg.onerror = () => {
      if (!isCurrent()) return;
      heroImg.style.display = 'none';
      heroPlaceholder.style.display = 'flex';
    };
    heroImg.onclick = () => {
      if (!isCurrent()) return;
      openLightbox(heroImg.src, `头像 ${idx + 1} / ${state.profilePhotos.length}`);
    };
  }
}

async function loadPeerStories(chatId) {
  const instId = state.clientSelectedInstance;
  const request = profileRequestId;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => request === profileRequestId && state.chatSelectionVersion === selectionVersion && state.clientSelectedInstance === instId &&
    String(state.currentProfileChatId) === String(chatId);
  const container = document.getElementById('profile-stories-container');
  const countBadge = document.getElementById('profile-stories-count');
  if (!container) return;

  if (state.currentProfileStoriesHidden) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.appendChild(document.createTextNode('已隐藏此用户的动态。'));
    const restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'btn btn-secondary btn-sm'; restore.textContent = '取消隐藏动态';
    restore.onclick = () => { void setStoryPeerHidden({
      instId, chatId: Number(chatId), selectionVersion, profileRequestId: request, isSelf: false,
    }, false); };
    hint.appendChild(restore);
    container.replaceChildren(hint);
    if (countBadge) countBadge.innerText = '隐藏';
    return;
  }

  try {
    const stories = await api(`/api/instances/${instId}/account/stories?chatId=${chatId}`);
    if (!isCurrent()) return;
    const list = Array.isArray(stories) ? stories : [];
    if (countBadge) countBadge.innerText = String(list.length);

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无活跃动态发布</div>';
      return;
    }

    container.innerHTML = '';
    for (let index = 0; index < list.length; index++) {
      const s = list[index];
      const card = document.createElement('div');
      card.className = 'story-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `查看动态 ${index + 1} / ${list.length}`);
      const dateStr = s.date ? new Date(s.date * 1000).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) : '';
      card.innerHTML = `
        <div class="story-thumb-icon">
          <svg class="ui-icon"><use href="#icon-story"/></svg>
        </div>
        <div class="story-meta">
          <div class="story-caption">${escapeHtml(s.caption || '动态故事')}</div>
          <div class="story-time">${dateStr} · 24小时快拍</div>
        </div>
      `;
      const open = () => openStoryViewer(chatId, list, index);
      card.onclick = open;
      card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
      container.appendChild(card);
    }
  } catch (err) {
    if (!isCurrent()) return;
    if (countBadge) countBadge.innerText = '0';
    container.innerHTML = '<div class="empty-hint">该实体不支持或未发布动态</div>';
  }
}

function peerStoryAlbumsAreCurrent(session) {
  return Boolean(session && session === profileStoryAlbumsState && !state.currentProfileIsSelf &&
    session.profileRequestId === profileRequestId && session.selectionVersion === state.chatSelectionVersion &&
    session.instId === state.clientSelectedInstance && String(session.chatId) === String(state.currentProfileChatId));
}

async function loadPeerStoryAlbums(chatId) {
  const instId = state.clientSelectedInstance;
  const session = {
    instId, chatId: Number(chatId), selectionVersion: state.chatSelectionVersion, profileRequestId,
    albums: [], selectedAlbumId: null, stories: [], count: 0, nextOffset: undefined, loading: false, request: 0,
  };
  profileStoryAlbumsState = session;
  const section = document.getElementById('profile-story-albums');
  const select = document.getElementById('profile-story-albums-select');
  const cover = document.getElementById('profile-story-albums-cover');
  const list = document.getElementById('profile-story-albums-list');
  const status = document.getElementById('profile-story-albums-status');
  const more = document.getElementById('btn-profile-story-albums-more');
  if (section) section.hidden = true;
  if (select) select.replaceChildren();
  if (cover) { cover.hidden = true; cover.src = ''; cover.alt = ''; }
  if (list) list.replaceChildren();
  if (status) status.textContent = '';
  if (more) more.hidden = true;
  try {
    const albums = await api(`/api/instances/${encodeURIComponent(instId)}/account/stories/albums?chatId=${encodeURIComponent(session.chatId)}`);
    if (!peerStoryAlbumsAreCurrent(session)) return;
    session.albums = Array.isArray(albums) ? albums.filter(album => Number.isSafeInteger(Number(album?.id)) && Number(album.id) > 0 && typeof album.title === 'string')
      .map(album => ({ ...album, id: Number(album.id), coverType: ['photo', 'video'].includes(album.coverType) ? album.coverType : undefined })) : [];
    if (!session.albums.length) return;
    if (select) {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择相册'; select.appendChild(placeholder);
      for (const album of session.albums) {
        const option = document.createElement('option'); option.value = String(album.id); option.textContent = album.title; select.appendChild(option);
      }
    }
    if (section) section.hidden = false;
    if (status) status.textContent = `${session.albums.length} 个固定动态相册`;
  } catch (error) {
    if (peerStoryAlbumsAreCurrent(session) && status) status.textContent = `无法读取故事相册：${error.message}`;
  }
}

async function selectPeerStoryAlbum() {
  const session = profileStoryAlbumsState;
  const select = document.getElementById('profile-story-albums-select');
  if (!peerStoryAlbumsAreCurrent(session)) return;
  const albumId = Number(select?.value);
  session.request++; session.loading = false;
  session.selectedAlbumId = Number.isSafeInteger(albumId) && session.albums.some(album => Number(album.id) === albumId) ? albumId : null;
  session.stories = []; session.count = 0; session.nextOffset = undefined;
  document.getElementById('profile-story-albums-list')?.replaceChildren();
  const cover = document.getElementById('profile-story-albums-cover');
  const selectedAlbum = session.albums.find(album => Number(album.id) === session.selectedAlbumId);
  if (cover) {
    cover.hidden = !selectedAlbum?.coverType;
    cover.alt = selectedAlbum?.coverType ? `相册封面：${selectedAlbum.title}` : '';
    cover.onerror = () => { cover.hidden = true; };
    cover.src = selectedAlbum?.coverType
      ? `/api/instances/${encodeURIComponent(session.instId)}/account/story-album-cover?chatId=${encodeURIComponent(session.chatId)}&albumId=${encodeURIComponent(session.selectedAlbumId)}`
      : '';
  }
  const more = document.getElementById('btn-profile-story-albums-more');
  if (more) more.hidden = true;
  if (!session.selectedAlbumId) {
    const status = document.getElementById('profile-story-albums-status');
    if (status) status.textContent = `${session.albums.length} 个固定动态相册`;
    return;
  }
  await loadPeerStoryAlbumStories(false);
}

async function loadPeerStoryAlbumStories(append = false) {
  const session = profileStoryAlbumsState;
  if (!peerStoryAlbumsAreCurrent(session) || !session.selectedAlbumId || session.loading || (append && session.nextOffset == null)) return;
  session.loading = true;
  const request = ++session.request;
  const offset = append ? session.nextOffset : 0;
  const status = document.getElementById('profile-story-albums-status');
  const more = document.getElementById('btn-profile-story-albums-more');
  if (!append && status) status.textContent = '正在加载相册动态…';
  if (more) more.disabled = true;
  try {
    const query = new URLSearchParams({ chatId: String(session.chatId), albumId: String(session.selectedAlbumId), offset: String(offset), limit: '20' });
    const page = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/stories?${query}`);
    if (!peerStoryAlbumsAreCurrent(session) || request !== session.request || session.selectedAlbumId !== Number(query.get('albumId'))) return;
    const items = Array.isArray(page?.stories) ? page.stories.filter(story => Number.isSafeInteger(Number(story?.id)) && Number(story.id) > 0) : [];
    const known = new Set(session.stories.map(story => String(story.id)));
    session.stories.push(...items.filter(story => !known.has(String(story.id))));
    session.count = Math.max(session.stories.length, Number(page?.count) || 0);
    const nextOffset = Number(page?.nextOffset);
    session.nextOffset = Number.isSafeInteger(nextOffset) && nextOffset > offset && nextOffset < session.count ? nextOffset : undefined;
    renderPeerStoryAlbumStories(session);
    if (status) status.textContent = session.stories.length ? `${session.count} 条动态` : '此相册没有可查看的动态';
    if (more) more.hidden = session.nextOffset == null;
  } catch (error) {
    if (peerStoryAlbumsAreCurrent(session) && request === session.request && status) status.textContent = `加载故事相册失败：${error.message}`;
  } finally {
    if (peerStoryAlbumsAreCurrent(session) && request === session.request) {
      session.loading = false;
      if (more) more.disabled = false;
    }
  }
}

function renderPeerStoryAlbumStories(session) {
  if (!peerStoryAlbumsAreCurrent(session)) return;
  const container = document.getElementById('profile-story-albums-list');
  if (!container) return;
  container.replaceChildren();
  session.stories.forEach((story, index) => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'story-card story-archive-card';
    const meta = document.createElement('span'); meta.className = 'story-meta';
    const caption = document.createElement('span'); caption.className = 'story-caption'; caption.textContent = story.caption || `动态 #${story.id}`;
    const date = document.createElement('span'); date.className = 'story-time';
    date.textContent = story.date ? new Date(Number(story.date) * 1000).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) : '';
    meta.append(caption, date); card.appendChild(meta);
    card.onclick = () => { if (peerStoryAlbumsAreCurrent(session)) openStoryViewer(session.chatId, session.stories, index, { source: 'profile' }); };
    container.appendChild(card);
  });
}

function toggleStoryArchive(forceOpen) {
  const button = document.getElementById('btn-profile-stories-archive');
  const archivePane = document.getElementById('profile-stories-archive');
  const activePane = document.getElementById('profile-stories-container');
  if (!button || !archivePane || !activePane || !state.currentProfileIsSelf) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : archivePane.hidden;
  archivePane.hidden = !open;
  activePane.hidden = open;
  button.textContent = open ? '返回活跃动态' : '查看动态档案';
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    const session = {
      instId: state.clientSelectedInstance,
      chatId: Number(state.currentProfileChatId),
      selectionVersion: state.chatSelectionVersion,
      profileRequestId,
      cursor: 0,
      stories: [],
      count: 0,
      loading: false,
      albums: [],
      selectedAlbumId: null,
      albumCursor: 0,
      albumRequest: 0,
      selectedStoryIds: new Set(),
    };
    storyArchiveState = session;
    void loadStoryAlbums(session);
    void loadStoryArchive(true);
  } else {
    storyArchiveState = null;
    document.getElementById('profile-stories-archive-container')?.replaceChildren();
  }
}

function storyArchiveIsCurrent(session) {
  return Boolean(session && storyArchiveState === session && state.currentProfileIsSelf &&
    state.clientSelectedInstance === session.instId && Number(state.currentProfileChatId) === session.chatId &&
    state.chatSelectionVersion === session.selectionVersion && profileRequestId === session.profileRequestId);
}

async function loadStoryArchive(reset = false) {
  const session = storyArchiveState;
  if (!storyArchiveIsCurrent(session) || session.loading) return;
  const container = document.getElementById('profile-stories-archive-container');
  const status = document.getElementById('profile-stories-archive-status');
  const more = document.getElementById('btn-profile-stories-archive-more');
  if (!container || !status || !more) return;
  if (reset) {
    session.cursor = 0;
    session.albumCursor = 0;
    session.stories = [];
    container.replaceChildren();
  }
  session.loading = true;
  renderStoryAlbumControls(session);
  more.disabled = true;
  const selectedAlbum = session.albums.find(album => album.id === session.selectedAlbumId);
  status.textContent = selectedAlbum ? `正在读取“${selectedAlbum.title}”中的动态…` : '正在读取已归档动态…';
  try {
    let result;
    if (session.selectedAlbumId != null) {
      const query = new URLSearchParams({ chatId: String(session.chatId), albumId: String(session.selectedAlbumId), limit: '20', offset: String(session.albumCursor || 0) });
      result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/stories?${query}`);
    } else {
      const query = new URLSearchParams({ limit: '20' });
      if (session.cursor > 0) query.set('offsetId', String(session.cursor));
      result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/archive?${query}`);
    }
    if (!storyArchiveIsCurrent(session)) return;
    const stories = Array.isArray(result?.stories) ? result.stories : [];
    const known = new Set(session.stories.map(story => Number(story.id)));
    for (const story of stories) {
      if (Number.isSafeInteger(Number(story.id)) && Number(story.id) > 0 && !known.has(Number(story.id))) {
        session.stories.push(story);
        known.add(Number(story.id));
      }
    }
    session.count = Number(result?.count) || session.stories.length;
    if (session.selectedAlbumId != null) {
      session.albumCursor = Number.isSafeInteger(Number(result?.nextOffset)) ? Number(result.nextOffset) : 0;
    } else {
      session.cursor = Number.isSafeInteger(Number(result?.nextOffsetId)) ? Number(result.nextOffsetId) : 0;
    }
    renderStoryArchiveCards(session);
    more.hidden = session.selectedAlbumId != null ? session.albumCursor <= 0 : session.cursor <= 0;
    status.textContent = session.stories.length
      ? `已显示 ${session.stories.length} / ${session.count} 条${selectedAlbum ? `“${selectedAlbum.title}”中的动态` : '已归档动态'}`
      : selectedAlbum ? '此相册暂无动态' : '暂无已归档动态';
  } catch (error) {
    if (storyArchiveIsCurrent(session)) status.textContent = `无法读取动态档案：${error.message}`;
  } finally {
    if (storyArchiveIsCurrent(session)) {
      session.loading = false;
      more.disabled = false;
      renderStoryAlbumControls(session);
    }
  }
}

async function loadStoryAlbums(session) {
  if (!storyArchiveIsCurrent(session)) return;
  const request = ++session.albumRequest;
  const filter = document.getElementById('profile-story-album-filter');
  const target = document.getElementById('profile-story-album-target');
  try {
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums?chatId=${encodeURIComponent(session.chatId)}`);
    if (!storyArchiveIsCurrent(session) || request !== session.albumRequest) return;
    session.albums = Array.isArray(result) ? result.filter(album => Number.isSafeInteger(Number(album?.id)) && Number(album.id) > 0 && typeof album.title === 'string')
      .map(album => ({ id: Number(album.id), title: album.title,
        coverType: ['photo', 'video'].includes(album.coverType) ? album.coverType : undefined })) : [];
    const oldFilter = filter?.value || (session.selectedAlbumId == null ? '' : String(session.selectedAlbumId));
    const oldTarget = target?.value || '';
    for (const select of [filter, target]) {
      if (!select) continue;
      select.replaceChildren();
      const empty = document.createElement('option'); empty.value = '';
      empty.textContent = select === filter ? '全部动态' : '选择相册'; select.appendChild(empty);
      for (const album of session.albums) {
        const option = document.createElement('option'); option.value = String(album.id); option.textContent = album.title; select.appendChild(option);
      }
    }
    if (filter && session.albums.some(album => String(album.id) === oldFilter)) filter.value = oldFilter;
    if (target && session.albums.some(album => String(album.id) === oldTarget)) target.value = oldTarget;
    renderStoryAlbumControls(session);
  } catch (error) {
    if (storyArchiveIsCurrent(session) && request === session.albumRequest) setStoryAlbumStatus(`读取故事相册失败：${error.message}`, true);
  }
}

function setStoryAlbumStatus(message, error = false) {
  const status = document.getElementById('profile-story-album-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
}

function renderStoryAlbumControls(session) {
  if (!session || !storyArchiveIsCurrent(session)) return;
  const target = Number(document.getElementById('profile-story-album-target')?.value) || 0;
  const selected = session.albums.find(album => album.id === target);
  const busy = Boolean(session.loading);
  const rename = document.getElementById('btn-rename-story-album');
  const remove = document.getElementById('btn-delete-story-album');
  const moveUp = document.getElementById('btn-move-story-album-up');
  const moveDown = document.getElementById('btn-move-story-album-down');
  const add = document.getElementById('btn-add-stories-to-album');
  const removeStories = document.getElementById('btn-remove-stories-from-album');
  const create = document.getElementById('btn-create-story-album');
  const filter = document.getElementById('profile-story-album-filter');
  const targetControl = document.getElementById('profile-story-album-target');
  const filterControl = document.getElementById('profile-story-album-filter');
  const cover = document.getElementById('profile-story-album-cover');
  const filterId = Number(filterControl?.value) || 0;
  const coverAlbum = session.albums.find(album => album.id === filterId) || selected;
  if (cover) {
    cover.hidden = !coverAlbum?.coverType;
    cover.alt = coverAlbum?.coverType ? `相册封面：${coverAlbum.title}` : '';
    cover.onerror = () => { cover.hidden = true; };
    cover.src = coverAlbum?.coverType
      ? `/api/instances/${encodeURIComponent(session.instId)}/account/story-album-cover?chatId=${encodeURIComponent(session.chatId)}&albumId=${encodeURIComponent(coverAlbum.id)}`
      : '';
  }
  const albumIndex = session.albums.findIndex(album => album.id === target);
  if (rename) rename.disabled = busy || !selected;
  if (remove) remove.disabled = busy || !selected;
  if (moveUp) moveUp.disabled = busy || albumIndex <= 0;
  if (moveDown) moveDown.disabled = busy || albumIndex < 0 || albumIndex >= session.albums.length - 1;
  if (add) add.disabled = busy || !selected || !session.selectedStoryIds.size;
  if (removeStories) removeStories.disabled = busy || !selected || !session.selectedStoryIds.size;
  if (create) create.disabled = busy;
  if (filter) filter.disabled = busy;
  if (targetControl) targetControl.disabled = busy;
  const status = document.getElementById('profile-story-album-status');
  if (status && (!status.textContent || /^\d+ 条动态已选择。$/.test(status.textContent))) status.textContent = `${session.selectedStoryIds.size} 条动态已选择。`;
}

async function selectStoryAlbumFilter() {
  const session = storyArchiveState;
  if (!storyArchiveIsCurrent(session) || session.loading) return;
  const value = document.getElementById('profile-story-album-filter')?.value || '';
  const albumId = value ? Number(value) : null;
  if (albumId != null && !session.albums.some(album => album.id === albumId)) return;
  session.selectedAlbumId = albumId;
  session.selectedStoryIds.clear();
  const target = document.getElementById('profile-story-album-target');
  if (target && albumId != null) target.value = String(albumId);
  renderStoryAlbumControls(session);
  await loadStoryArchive(true);
}

async function createArchivedStoryAlbum() {
  const session = storyArchiveState;
  if (!storyArchiveIsCurrent(session) || session.loading) return;
  const title = prompt('新故事相册名称（最多 64 个字符）', '');
  if (title === null) return;
  try {
    const album = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums`, 'POST', {
      chatId: session.chatId, title, storyIds: [...session.selectedStoryIds],
    });
    if (!storyArchiveIsCurrent(session)) return;
    session.selectedStoryIds.clear();
    session.selectedAlbumId = Number(album.id);
    await loadStoryAlbums(session);
    const filter = document.getElementById('profile-story-album-filter');
    const target = document.getElementById('profile-story-album-target');
    if (filter) filter.value = String(album.id);
    if (target) target.value = String(album.id);
    renderStoryAlbumControls(session);
    await loadStoryArchive(true);
    setStoryAlbumStatus(`相册“${album.title}”已创建。`);
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`创建相册失败：${error.message}`, true); }
}

async function renameArchivedStoryAlbum() {
  const session = storyArchiveState;
  const albumId = Number(document.getElementById('profile-story-album-target')?.value);
  const album = session?.albums.find(item => item.id === albumId);
  if (!storyArchiveIsCurrent(session) || session.loading || !album) return;
  const title = prompt('故事相册名称', album.title);
  if (title === null) return;
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/edit`, 'POST', {
      chatId: session.chatId, albumId, update: { title },
    });
    if (!storyArchiveIsCurrent(session)) return;
    await loadStoryAlbums(session);
    setStoryAlbumStatus('故事相册名称已更新。');
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`重命名失败：${error.message}`, true); }
}

async function deleteArchivedStoryAlbum() {
  const session = storyArchiveState;
  const albumId = Number(document.getElementById('profile-story-album-target')?.value);
  const album = session?.albums.find(item => item.id === albumId);
  if (!storyArchiveIsCurrent(session) || session.loading || !album || !confirm(`删除故事相册“${album.title}”？相册中的动态不会被删除。`)) return;
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums`, 'DELETE', { chatId: session.chatId, albumId });
    if (!storyArchiveIsCurrent(session)) return;
    if (session.selectedAlbumId === albumId) session.selectedAlbumId = null;
    const target = document.getElementById('profile-story-album-target'); if (target) target.value = '';
    const filter = document.getElementById('profile-story-album-filter'); if (filter) filter.value = '';
    await loadStoryAlbums(session);
    await loadStoryArchive(true);
    setStoryAlbumStatus('故事相册已删除；动态仍保留在档案中。');
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`删除相册失败：${error.message}`, true); }
}

async function moveArchivedStoryAlbum(delta) {
  const session = storyArchiveState;
  const target = document.getElementById('profile-story-album-target');
  const albumId = Number(target?.value);
  const index = session?.albums.findIndex(album => album.id === albumId) ?? -1;
  const next = index + delta;
  if (!storyArchiveIsCurrent(session) || session.loading || index < 0 || next < 0 || next >= session.albums.length) return;
  const albumIds = session.albums.map(album => album.id);
  [albumIds[index], albumIds[next]] = [albumIds[next], albumIds[index]];
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/order`, 'POST', { chatId: session.chatId, albumIds });
    if (!storyArchiveIsCurrent(session)) return;
    await loadStoryAlbums(session);
    if (target) target.value = String(albumId);
    setStoryAlbumStatus('故事相册顺序已更新。');
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`调整相册顺序失败：${error.message}`, true); }
}

async function moveArchivedStoryWithinAlbum(storyId, delta) {
  const session = storyArchiveState;
  if (!storyArchiveIsCurrent(session) || session.loading || session.selectedAlbumId == null) return;
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/stories/order`, 'POST', {
      chatId: session.chatId, albumId: session.selectedAlbumId, storyId: Number(storyId), delta,
    });
    if (!storyArchiveIsCurrent(session)) return;
    await loadStoryArchive(true);
    setStoryAlbumStatus('相册内动态顺序已更新。');
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`调整动态顺序失败：${error.message}`, true); }
}

async function updateArchivedStoryAlbumMembers(action) {
  const session = storyArchiveState;
  const albumId = Number(document.getElementById('profile-story-album-target')?.value);
  const storyIds = [...(session?.selectedStoryIds || [])];
  if (!storyArchiveIsCurrent(session) || session.loading || !albumId || !storyIds.length) return;
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/albums/edit`, 'POST', {
      chatId: session.chatId, albumId,
      update: action === 'add' ? { addStoryIds: storyIds } : { removeStoryIds: storyIds },
    });
    if (!storyArchiveIsCurrent(session)) return;
    session.selectedStoryIds.clear();
    await loadStoryAlbums(session);
    if (session.selectedAlbumId === albumId) await loadStoryArchive(true);
    else renderStoryArchiveCards(session);
    setStoryAlbumStatus(action === 'add' ? '所选动态已加入相册。' : '所选动态已从相册移除。');
  } catch (error) { if (storyArchiveIsCurrent(session)) setStoryAlbumStatus(`更新相册内容失败：${error.message}`, true); }
}

function renderStoryArchiveCards(session) {
  const container = document.getElementById('profile-stories-archive-container');
  if (!container || !storyArchiveIsCurrent(session)) return;
  container.replaceChildren();
  session.stories.forEach((story, index) => {
    const card = document.createElement('div');
    card.className = 'story-card story-archive-card';
    card.setAttribute('role', 'group');
    const meta = document.createElement('div');
    meta.className = 'story-meta';
    const caption = document.createElement('div');
    caption.className = 'story-caption';
    caption.textContent = story.caption || '动态故事';
    const date = document.createElement('div');
    date.className = 'story-time';
    date.textContent = `${story.date ? new Date(story.date * 1000).toLocaleDateString() : ''}${story.isPinned ? ' · 已置顶' : ''}`;
    meta.append(caption, date);
    const select = document.createElement('label'); select.className = 'story-archive-selection';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = session.selectedStoryIds.has(Number(story.id));
    checkbox.setAttribute('aria-label', `选择动态 ${story.caption || story.id}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) session.selectedStoryIds.add(Number(story.id));
      else session.selectedStoryIds.delete(Number(story.id));
      renderStoryAlbumControls(session);
    });
    select.append(checkbox, document.createTextNode('选择'));
    if (session.selectedAlbumId != null) {
      const moveUp = document.createElement('button'); moveUp.type = 'button'; moveUp.className = 'btn btn-secondary btn-xs'; moveUp.textContent = '上移';
      moveUp.setAttribute('aria-label', `将动态 ${story.caption || story.id} 上移`);
      moveUp.onclick = () => { void moveArchivedStoryWithinAlbum(story.id, -1); };
      const moveDown = document.createElement('button'); moveDown.type = 'button'; moveDown.className = 'btn btn-secondary btn-xs'; moveDown.textContent = '下移';
      moveDown.setAttribute('aria-label', `将动态 ${story.caption || story.id} 下移`);
      moveDown.onclick = () => { void moveArchivedStoryWithinAlbum(story.id, 1); };
      card.append(meta, select, moveUp, moveDown);
    } else {
      card.append(meta, select);
    }
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'btn btn-secondary btn-sm'; open.textContent = '查看';
    open.onclick = () => openStoryViewer(session.chatId, session.stories, index, { source: 'archive', readReceipt: false, allowReaction: false });
    const viewers = document.createElement('button');
    viewers.type = 'button'; viewers.className = 'btn btn-secondary btn-sm';
    viewers.textContent = `观看者 ${Number(story.viewsCount) || 0}`;
    viewers.title = `反应 ${Number(story.reactionsCount) || 0} · 转发 ${Number(story.forwardsCount) || 0}`;
    viewers.onclick = () => { void toggleArchivedStoryViewers(session, story, card, viewers); };
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'btn btn-secondary btn-sm'; edit.textContent = '编辑说明';
    edit.onclick = () => { void editArchivedStoryCaption(session, story, card); };
    const privacy = document.createElement('button');
    privacy.type = 'button'; privacy.className = 'btn btn-secondary btn-sm'; privacy.textContent = '隐私设置';
    privacy.onclick = () => { void editArchivedStoryPrivacySettings(session, story, card); };
    const pin = document.createElement('button');
    pin.type = 'button'; pin.className = 'btn btn-secondary btn-sm'; pin.textContent = story.isPinned ? '取消置顶' : '置顶';
    pin.onclick = () => { void toggleArchivedStoryPinned(session, story); };
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'btn btn-danger btn-sm'; remove.textContent = '删除';
    remove.onclick = () => { void deleteArchivedStory(session, story); };
    card.append(open, viewers, edit, privacy, pin, remove);
    container.appendChild(card);
  });
}

async function editArchivedStoryPrivacySettings(session, story, card) {
  if (!storyArchiveIsCurrent(session) || card.querySelector('.story-privacy-editor')) return;
  const editor = document.createElement('section'); editor.className = 'story-privacy-editor';
  const title = document.createElement('strong'); title.textContent = '动态可见范围';
  const note = document.createElement('div'); note.className = 'story-privacy-note';
  note.textContent = '保存后会同步修改动态受众、账号密友名单和禁止查看名单。';
  const audienceLabel = document.createElement('label'); audienceLabel.className = 'story-privacy-audience-label';
  audienceLabel.textContent = '谁可以查看';
  const audience = document.createElement('select'); audience.className = 'form-input'; audience.setAttribute('aria-label', '动态可见范围');
  for (const [value, text] of [['public', '所有人'], ['contacts', '我的联系人'], ['close', '密友'], ['selected', '指定联系人']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; audience.appendChild(option);
  }
  const searchLabel = document.createElement('label'); searchLabel.className = 'story-privacy-search-label';
  searchLabel.textContent = '筛选联系人';
  const search = document.createElement('input'); search.type = 'search'; search.className = 'form-input';
  search.setAttribute('aria-label', '筛选故事隐私联系人'); search.placeholder = '按姓名或用户名搜索';
  const audienceSection = document.createElement('div'); audienceSection.className = 'story-privacy-list-section';
  const friendsSection = document.createElement('div'); friendsSection.className = 'story-privacy-list-section';
  const hiddenSection = document.createElement('div'); hiddenSection.className = 'story-privacy-list-section';
  const status = document.createElement('div'); status.className = 'story-privacy-status'; status.setAttribute('role', 'status');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = '保存隐私设置';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
  const actions = document.createElement('div'); actions.className = 'story-privacy-actions'; actions.append(save, cancel);
  editor.append(title, note, audienceLabel, audience, searchLabel, search, audienceSection, friendsSection, hiddenSection, status, actions);
  card.appendChild(editor);
  save.disabled = true;
  cancel.onclick = () => { if (storyArchiveIsCurrent(session)) renderStoryArchiveCards(session); };
  audience.addEventListener('change', () => { if (settings) { settings.privacyType = audience.value; renderLists(); } });
  search.addEventListener('input', renderLists);

  let settings;
  let people = [];
  function renderContactList(container, field, heading, emptyText, allowList = false) {
    container.replaceChildren();
    const label = document.createElement('strong'); label.textContent = `${heading} (${settings[field].length})`;
    const description = document.createElement('div'); description.className = 'story-privacy-note'; description.textContent = emptyText;
    const list = document.createElement('div'); list.className = 'story-privacy-contacts';
    const selected = new Set(settings[field]);
    const query = search.value.trim().toLocaleLowerCase();
    const matching = people.filter(person => (person.isContact || selected.has(person.id)) &&
      (!query || `${person.title} ${person.username || ''}`.toLocaleLowerCase().includes(query)));
    const selectedPeople = matching.filter(person => selected.has(person.id));
    const visible = [...selectedPeople, ...matching.filter(person => !selected.has(person.id)).slice(0, Math.max(0, 100 - selectedPeople.length))];
    for (const person of visible) {
      const row = document.createElement('label'); row.className = 'story-privacy-contact';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(person.id);
      checkbox.addEventListener('change', () => {
        const next = new Set(settings[field]);
        if (checkbox.checked) next.add(person.id); else next.delete(person.id);
        settings[field] = [...next];
        renderLists();
      });
      const name = document.createElement('span'); name.textContent = person.title;
      row.append(checkbox, name);
      if (person.username && !String(person.title).includes(person.username)) { const username = document.createElement('small'); username.textContent = `@${person.username}`; row.appendChild(username); }
      list.appendChild(row);
    }
    if (!visible.length) {
      const empty = document.createElement('div'); empty.className = 'story-privacy-empty';
      empty.textContent = matching.length ? '没有匹配的联系人。' : '没有可显示的联系人。'; list.appendChild(empty);
    } else if (!query && matching.length > visible.length) {
      const more = document.createElement('div'); more.className = 'story-privacy-empty';
      more.textContent = `显示 ${visible.length} / ${matching.length} 位联系人；使用上方搜索查找其余联系人。`; list.appendChild(more);
    }
    container.append(label, description, list);
  }
  function renderLists() {
    if (!settings || !storyArchiveIsCurrent(session)) return;
    const audienceCopy = {
      public: ['everyoneExcept', '例外联系人', '选中的联系人不能查看此动态。'],
      contacts: ['contactsExcept', '例外联系人', '选中的联系人不能查看此动态。'],
      selected: ['selectedContacts', '指定联系人', '只有选中的联系人可以查看此动态。'],
    };
    if (settings.privacyType === 'close') {
      audienceSection.replaceChildren();
      const text = document.createElement('div'); text.className = 'story-privacy-note';
      text.textContent = '此动态只对下方密友名单中的联系人开放。'; audienceSection.appendChild(text);
    } else {
      const [field, heading, explanation] = audienceCopy[settings.privacyType] || audienceCopy.public;
      renderContactList(audienceSection, field, heading, explanation);
    }
    renderContactList(friendsSection, 'closeFriends', '密友名单', '加入密友名单会影响所有故事，而不只当前动态。');
    renderContactList(hiddenSection, 'hideFrom', '禁止查看动态', '名单中的联系人无法查看你的任何动态。');
  }
  const targetUrl = `/api/instances/${encodeURIComponent(session.instId)}/account/stories/settings`;
  try {
    const loaded = await api(`${targetUrl}?chatId=${encodeURIComponent(session.chatId)}&storyId=${encodeURIComponent(story.id)}`);
    if (!storyArchiveIsCurrent(session) || !editor.isConnected) return;
    if (loaded?.editable === false) {
      status.textContent = '此动态含有本界面无法安全保留的隐私规则，设置保持未更改。';
      audience.disabled = true; search.disabled = true; save.disabled = true;
      return;
    }
    settings = {
      privacyType: loaded.privacyType || 'public',
      everyoneExcept: (loaded.everyoneExcept || []).map(String),
      contactsExcept: (loaded.contactsExcept || []).map(String),
      selectedContacts: (loaded.selectedContacts || []).map(String),
      closeFriends: (loaded.closeFriends || []).map(String),
      hideFrom: (loaded.hideFrom || []).map(String),
    };
    const map = new Map((loaded.people || []).map(person => [String(person.id), { ...person, id: String(person.id) }]));
    for (const field of ['everyoneExcept', 'contactsExcept', 'selectedContacts', 'closeFriends', 'hideFrom']) {
      for (const id of settings[field]) if (!map.has(id)) map.set(id, { id, title: `Telegram 用户 ${id}` });
    }
    people = [...map.values()].filter(person => !person.isBot && !person.deleted)
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    audience.value = settings.privacyType;
    renderLists();
    save.disabled = false;
  } catch (error) {
    if (storyArchiveIsCurrent(session) && editor.isConnected) {
      status.textContent = `读取动态隐私设置失败：${error.message}`;
      audience.disabled = true; search.disabled = true; save.disabled = true;
    }
    return;
  }
  save.onclick = async () => {
    if (!storyArchiveIsCurrent(session) || save.disabled) return;
    save.disabled = true; audience.disabled = true; search.disabled = true;
    status.textContent = '正在保存…';
    try {
      await api(targetUrl, 'POST', { chatId: session.chatId, storyId: story.id, settings });
      if (!storyArchiveIsCurrent(session)) return;
      renderStoryArchiveCards(session);
      const archiveStatus = document.getElementById('profile-stories-archive-status');
      if (archiveStatus) archiveStatus.textContent = '动态隐私设置已更新。';
    } catch (error) {
      if (storyArchiveIsCurrent(session) && editor.isConnected) {
        status.textContent = `保存动态隐私设置失败：${error.message}`;
        save.disabled = false; audience.disabled = false; search.disabled = false;
      }
    }
  };
}

async function editArchivedStoryCaption(session, story, card) {
  if (!storyArchiveIsCurrent(session)) return;
  if (card.querySelector('.story-caption-editor')) return;
  const editor = document.createElement('div'); editor.className = 'story-caption-editor';
  const input = document.createElement('textarea'); input.className = 'form-input'; input.maxLength = 2048; input.rows = 3;
  input.value = story.caption || ''; input.setAttribute('aria-label', '动态说明');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = '保存说明';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
  editor.append(input, save, cancel); card.appendChild(editor); input.focus();
  cancel.onclick = () => { if (storyArchiveIsCurrent(session)) renderStoryArchiveCards(session); };
  save.onclick = async () => {
    if (!storyArchiveIsCurrent(session) || save.disabled) return;
    const captionText = input.value;
    if (captionText.length > 2048) return;
    save.disabled = true;
    const status = document.getElementById('profile-stories-archive-status');
    try {
      await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/edit`, 'POST', {
        chatId: session.chatId, storyId: story.id, caption: captionText,
      });
      if (!storyArchiveIsCurrent(session)) return;
      story.caption = captionText;
      renderStoryArchiveCards(session);
      if (status) status.textContent = '动态说明已更新。';
    } catch (error) {
      if (storyArchiveIsCurrent(session)) {
        if (status) status.textContent = `编辑动态说明失败：${error.message}`;
        save.disabled = false;
      }
    }
  };
}

async function toggleArchivedStoryViewers(session, story, card, button) {
  if (!storyArchiveIsCurrent(session)) return;
  const existing = card.querySelector('.story-viewers');
  if (existing) { existing.remove(); button.setAttribute('aria-expanded', 'false'); return; }
  const panel = document.createElement('div'); panel.className = 'story-viewers';
  const summary = document.createElement('div'); summary.className = 'story-viewers-summary';
  const filters = document.createElement('div'); filters.className = 'story-viewers-filters';
  const filterButtons = new Map();
  for (const [kind, label] of [['viewers', '访客'], ['reactions', '反应'], ['forwards', '公开转发']]) {
    const filter = document.createElement('button'); filter.type = 'button'; filter.className = 'btn btn-secondary btn-xs';
    filter.textContent = label; filter.setAttribute('aria-pressed', String(kind === 'viewers'));
    filter.onclick = () => {
      if (!storyArchiveIsCurrent(session) || activeKind === kind) return;
      activeKind = kind;
      for (const [buttonKind, button] of filterButtons) button.setAttribute('aria-pressed', String(buttonKind === kind));
      return load(true);
    };
    filters.appendChild(filter); filterButtons.set(kind, filter);
  }
  const rows = document.createElement('div'); rows.className = 'story-viewers-list';
  const status = document.createElement('div'); status.className = 'story-viewers-status'; status.setAttribute('role', 'status');
  const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-secondary btn-sm'; more.textContent = '加载更多'; more.hidden = true;
  panel.append(summary, filters, rows, more, status); card.appendChild(panel); button.setAttribute('aria-expanded', 'true');
  let offset = '', loading = false, ended = false, activeKind = 'viewers', loadRequest = 0;
  const load = async (reset = false) => {
    if (!storyArchiveIsCurrent(session) || (!reset && (loading || ended))) return;
    const requestId = ++loadRequest;
    loading = true; more.disabled = true; status.textContent = activeKind === 'forwards' ? '正在加载公开转发…' : activeKind === 'reactions' ? '正在加载反应…' : '正在加载观看者…';
    if (reset) { offset = ''; ended = false; rows.replaceChildren(); }
    try {
      const query = new URLSearchParams({ chatId: String(session.chatId), storyId: String(story.id), limit: '50', kind: activeKind });
      if (offset) query.set('offset', offset);
      const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/views?${query}`);
      if (!storyArchiveIsCurrent(session) || !panel.isConnected || requestId !== loadRequest) return;
      summary.textContent = `${Number(result?.viewsCount) || 0} 次观看 · ${Number(result?.reactionsCount) || 0} 个反应 · ${Number(result?.forwardsCount) || 0} 次转发`;
      if (activeKind === 'forwards') {
        for (const entry of Array.isArray(result?.forwards) ? result.forwards : []) {
          const row = document.createElement('div'); row.className = 'story-viewer-row story-forward-row';
          const name = document.createElement('strong'); name.textContent = entry.title || (entry.type === 'repost' ? '公开转发动态' : '公开转发');
          const detail = document.createElement('span');
          const type = entry.type === 'repost' ? `动态 ${entry.storyId || ''}` : `消息 ${entry.messageId || ''}`;
          const date = entry.date ? new Date(entry.date * 1000).toLocaleString() : '';
          detail.textContent = [entry.text, type, date].filter(Boolean).join(' · ');
          row.append(name, detail); rows.appendChild(row);
        }
      } else {
        const users = (Array.isArray(result?.viewers) ? result.viewers : []).filter(entry => activeKind !== 'reactions' || entry.reaction);
        for (const entry of users) {
          const row = document.createElement('div'); row.className = 'story-viewer-row';
          const name = document.createElement('span');
          name.textContent = [entry.user?.firstName, entry.user?.lastName].filter(Boolean).join(' ') || entry.user?.username || `用户 ${entry.user?.id || ''}`;
          const detail = document.createElement('span');
          const date = entry.date ? new Date(entry.date * 1000).toLocaleString() : '';
          detail.textContent = [date, entry.reaction].filter(Boolean).join(' · ');
          row.append(name, detail); rows.appendChild(row);
        }
      }
      offset = typeof result?.nextOffset === 'string' ? result.nextOffset : '';
      ended = !offset; more.hidden = ended;
      status.textContent = rows.children.length ? '' : activeKind === 'forwards' && Number(result?.forwardsCount) > 0
        ? 'Telegram 未返回可显示的公开转发详情。' : activeKind === 'reactions' && Number(result?.reactionsCount) > 0
          ? 'Telegram 未返回可显示的反应者资料。' : activeKind === 'viewers' && Number(result?.count) > 0
            ? 'Telegram 未返回可显示的访客资料。' : '没有可显示的记录。';
    } catch (error) {
      if (storyArchiveIsCurrent(session) && panel.isConnected && requestId === loadRequest) status.textContent = `无法加载动态互动：${error.message}`;
    } finally {
      if (requestId === loadRequest) {
        loading = false;
        if (panel.isConnected) more.disabled = false;
      }
    }
  };
  more.onclick = () => { void load(); };
  await load(true);
}

async function toggleArchivedStoryPinned(session, story) {
  if (!storyArchiveIsCurrent(session)) return;
  const pinned = !story.isPinned;
  const status = document.getElementById('profile-stories-archive-status');
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/pin`, 'POST', {
      chatId: session.chatId, storyId: story.id, pinned,
    });
    if (!storyArchiveIsCurrent(session)) return;
    story.isPinned = pinned;
    renderStoryArchiveCards(session);
    if (status) status.textContent = pinned ? '动态已置顶到个人主页。' : '动态已从个人主页取消置顶。';
  } catch (error) {
    if (storyArchiveIsCurrent(session) && status) status.textContent = `动态置顶失败：${error.message}`;
  }
}

async function deleteArchivedStory(session, story) {
  if (!storyArchiveIsCurrent(session) || !window.confirm('删除这条动态？此操作无法撤销。')) return;
  const status = document.getElementById('profile-stories-archive-status');
  try {
    await api(`/api/instances/${encodeURIComponent(session.instId)}/account/stories/delete`, 'POST', {
      chatId: session.chatId, storyIds: [story.id],
    });
    if (!storyArchiveIsCurrent(session)) return;
    session.stories = session.stories.filter(item => item.id !== story.id);
    session.count = Math.max(0, session.count - 1);
    renderStoryArchiveCards(session);
    if (status) status.textContent = `已显示 ${session.stories.length} / ${session.count} 条动态`;
  } catch (error) {
    if (storyArchiveIsCurrent(session) && status) status.textContent = `删除动态失败：${error.message}`;
  }
}

async function loadSharedMedia(type = 'photos') {
  const request = ++sharedMediaRequestId;
  state.sharedMediaTab = type;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const isCurrent = () => request === sharedMediaRequestId && state.chatSelectionVersion === selectionVersion && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId);
  const container = document.getElementById('shared-media-container');
  if (!container) return;

  if (!chatId) {
    container.innerHTML = '<div class="empty-hint">请先在左侧选择一个会话</div>';
    return;
  }

  document.querySelectorAll('.shared-subtab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.type === type);
  });

  container.innerHTML = '<div class="empty-hint">正在加载媒体资源...</div>';

  try {
    const list = await api(`/api/instances/${instId}/account/chat-media?chatId=${chatId}&type=${type}&limit=40`);
    if (!isCurrent()) return;
    state.sharedMediaList = Array.isArray(list) ? list : [];

    if (state.sharedMediaList.length === 0) {
      container.innerHTML = `<div class="empty-hint">当前会话暂无共享${type === 'photos' ? '图片' : type === 'videos' ? '视频' : type === 'files' ? '文件' : '音乐'}</div>`;
      return;
    }

    if (type === 'photos') {
      let gridHtml = '<div class="shared-photos-grid">';
      for (const m of state.sharedMediaList) {
        const thumbUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
        const fullUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        gridHtml += `
          <div class="shared-photo-item" onclick="openLightbox(${inlineJsArg(fullUrl)}, ${inlineJsArg('共享照片 #' + m.id)})">
            <img data-network-src="${escapeHtml(thumbUrl)}" alt="Photo" loading="lazy">
          </div>
        `;
      }
      gridHtml += '</div>';
      container.innerHTML = gridHtml;
    } else if (type === 'videos') {
      let gridHtml = '<div class="shared-videos-grid">';
      for (const m of state.sharedMediaList) {
        const videoUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const thumbUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
        const durStr = m.media?.duration ? formatDurationSec(m.media.duration) : '';
        const timeStr = m.date ? new Date(m.date).toLocaleDateString() : '';
        const titleStr = '共享视频 #' + m.id;
        gridHtml += `
          <div class="shared-video-item" onclick="openCinemaVideo(${inlineJsArg(videoUrl)}, ${inlineJsArg(titleStr)}, ${inlineJsArg(timeStr)}, ${inlineJsArg(durStr)})" title="点击在影院播放器中播放">
            <video preload="none" playsinline data-network-poster="${escapeHtml(thumbUrl)}" src="${escapeHtml(videoUrl)}"></video>
            <div class="shared-video-play-overlay">
              <div class="shared-video-play-badge">
                <svg class="ui-icon" style="transform: translateX(1px);"><use href="#icon-play"/></svg>
              </div>
            </div>
            ${durStr ? `<div class="video-card-dur-badge">${durStr}</div>` : ''}
          </div>
        `;
      }
      gridHtml += '</div>';
      container.innerHTML = gridHtml;
    } else if (type === 'files') {
      let listHtml = '<div class="shared-files-list">';
      for (const m of state.sharedMediaList) {
        const docUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&download=1`;
        const fName = m.media?.fileName || `File_${m.id}`;
        const fSize = m.media?.fileSize ? formatBytes(m.media.fileSize) : '';
        listHtml += `
          <div class="shared-file-item">
            <svg class="ui-icon file-icon"><use href="#icon-file"/></svg>
            <div class="file-text-wrap">
              <div class="file-name" title="${escapeHtml(fName)}">${escapeHtml(fName)}</div>
              <div class="file-meta">${fSize} · ${new Date(m.date).toLocaleDateString()}</div>
            </div>
            <a class="btn btn-secondary btn-xs" href="${escapeHtml(docUrl)}" download="${escapeHtml(fName)}" target="_blank" title="下载原文件">
              <svg class="ui-icon-sm"><use href="#icon-download"/></svg>
            </a>
          </div>
        `;
      }
      listHtml += '</div>';
      container.innerHTML = listHtml;
    } else if (type === 'music') {
      let listHtml = '<div class="shared-music-list">';
      for (const m of state.sharedMediaList) {
        const audioUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const tTitle = m.media?.title || m.media?.fileName || `Track_${m.id}`;
        const tArtist = m.media?.performer || '未知艺术家';
        const durStr = m.media?.duration ? formatDurationSec(m.media.duration) : '';
        listHtml += `
          <div class="shared-music-item">
            <div class="music-track-icon"><svg class="ui-icon"><use href="#icon-music"/></svg></div>
            <div class="music-track-info">
              <div class="track-title" title="${escapeHtml(tTitle)}">${escapeHtml(tTitle)}</div>
              <div class="track-artist">${escapeHtml(tArtist)}${durStr ? ' · ' + durStr : ''}</div>
            </div>
            <div class="music-item-actions">
              <button class="btn btn-primary btn-xs" onclick="playTrackDirect(${inlineJsArg(tTitle)}, ${inlineJsArg(tArtist)}, ${inlineJsArg(audioUrl)}, ${inlineJsArg(m.id)})">播放</button>
              <button class="btn btn-secondary btn-xs" onclick="addTrackToPlaylist(${inlineJsArg(tTitle)}, ${inlineJsArg(tArtist)}, ${inlineJsArg(audioUrl)}, ${inlineJsArg(m.id)})">加歌单</button>
            </div>
          </div>
        `;
      }
      listHtml += '</div>';
      container.innerHTML = listHtml;
    }
  } catch (err) {
    if (!isCurrent()) return;
    container.innerHTML = '<div class="empty-hint error"></div>';
    container.firstElementChild.textContent = `加载共享媒体失败: ${err.message}`;
  }
}

// ==========================================
// Group & Channel Members Controller
// ==========================================
state.groupMembers = [];
let groupMembersRequest = 0;
let groupMembersContext = null;
let groupMemberSearchTimer = null;
let groupInviteSession = null;
let groupInviteSearchTimer = null;
let createChatSession = null;
let createChatSearchTimer = null;
let groupMuteTarget = null;
let joinRequestSession = null;
let joinRequestSearchTimer = null;
let bannedMemberSession = null;
let bannedMemberSearchTimer = null;
let inviteLinkSession = null;

function closeJoinRequestsModal() {
  if (joinRequestSession) joinRequestSession.requestVersion++;
  joinRequestSession = null;
  if (joinRequestSearchTimer) clearTimeout(joinRequestSearchTimer);
  joinRequestSearchTimer = null;
  const modal = document.getElementById('modal-join-requests');
  if (modal) modal.style.display = 'none';
  document.getElementById('join-requests-list')?.replaceChildren();
}

function isCurrentJoinRequestSession(session = joinRequestSession) {
  return Boolean(session && session === joinRequestSession && isCurrentGroupMembersContext(session.context));
}

function openJoinRequestsModal() {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('请先加载当前群成员', 'warn');
  const modal = document.getElementById('modal-join-requests');
  if (!modal) return showToast('入群申请窗口不可用', 'error');
  closeJoinRequestsModal();
  joinRequestSession = { context, requestVersion: 0, loading: false, cursor: null, count: 0, query: '', ids: new Set() };
  const search = document.getElementById('join-request-search');
  if (search) search.value = '';
  modal.style.display = 'flex';
  updateJoinRequestBulkActions();
  void loadJoinRequests(true);
}

function updateJoinRequestBulkActions() {
  const session = joinRequestSession;
  const disabled = !session || !session.count || Boolean(session.query) || session.loading || session.bulkBusy;
  const approve = document.getElementById('btn-approve-all-join-requests');
  const reject = document.getElementById('btn-reject-all-join-requests');
  if (approve) approve.disabled = disabled;
  if (reject) reject.disabled = disabled;
}

async function loadJoinRequests(reset = false) {
  const session = joinRequestSession;
  if (!isCurrentJoinRequestSession(session)) { closeJoinRequestsModal(); return; }
  if (reset) {
    session.requestVersion++;
    session.loading = false;
    session.cursor = null;
    session.ids = new Set();
    document.getElementById('join-requests-list')?.replaceChildren();
  }
  if (session.loading) return;
  session.loading = true;
  updateJoinRequestBulkActions();
  const requestVersion = session.requestVersion;
  const cursor = reset ? null : session.cursor;
  const status = document.getElementById('join-requests-status');
  const more = document.getElementById('btn-more-join-requests');
  if (more) more.disabled = true;
  if (status) status.textContent = reset ? '正在读取待审核申请…' : '正在加载更多申请…';
  try {
    let result;
    if (window.chatWs && window.chatWs.isConnected()) {
      result = await window.chatWs.sendRpc('get_join_requests', {
        instId: session.context.instId, chatId: session.context.chatId, cursor, limit: 50, query: session.query,
      });
    } else {
      const params = new URLSearchParams({ chatId: String(session.context.chatId), limit: '50' });
      if (cursor) { params.set('date', String(cursor.date)); params.set('userId', String(cursor.userId)); }
      if (session.query) params.set('query', session.query);
      result = await api(`/api/instances/${encodeURIComponent(session.context.instId)}/account/join-requests?${params}`);
    }
    if (!isCurrentJoinRequestSession(session) || requestVersion !== session.requestVersion) return;
    session.count = Number(result?.count) || 0;
    updateJoinRequestBulkActions();
    const list = document.getElementById('join-requests-list');
    for (const request of Array.isArray(result?.requests) ? result.requests : []) {
      const user = request.user || {};
      const userId = Number(user.id);
      if (!Number.isSafeInteger(userId) || userId <= 0 || session.ids.has(userId)) continue;
      session.ids.add(userId);
      const card = document.createElement('article'); card.className = 'join-request-card'; card.dataset.userId = String(userId);
      const info = document.createElement('div'); info.className = 'join-request-info';
      const name = document.createElement('div'); name.className = 'join-request-name';
      name.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `用户 ${userId}`;
      const meta = document.createElement('div'); meta.className = 'join-request-meta';
      meta.textContent = `${user.username ? `@${user.username} · ` : ''}申请时间 ${request.date ? new Date(request.date * 1000).toLocaleString() : '未知'}`;
      info.append(name, meta);
      if (request.about) { const about = document.createElement('div'); about.className = 'join-request-about'; about.textContent = request.about; info.appendChild(about); }
      const actions = document.createElement('div'); actions.className = 'join-request-actions';
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn btn-primary btn-xs'; approve.textContent = '批准';
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn btn-secondary btn-xs'; dismiss.textContent = '拒绝';
      approve.onclick = () => { void decideJoinRequest(session, userId, true, card); };
      dismiss.onclick = () => { void decideJoinRequest(session, userId, false, card); };
      actions.append(approve, dismiss); card.append(info, actions); list?.appendChild(card);
    }
    session.cursor = result?.nextCursor && Number.isSafeInteger(Number(result.nextCursor.date)) && Number.isSafeInteger(Number(result.nextCursor.userId))
      ? { date: Number(result.nextCursor.date), userId: Number(result.nextCursor.userId) } : null;
    if (more) { more.hidden = !session.cursor; more.textContent = '加载更多'; }
    if (status) status.textContent = session.count ? `${session.query ? '匹配' : '待审核'} ${session.count} 项，已显示 ${session.ids.size} 项` : (session.query ? '没有匹配的入群申请' : '暂无待审核入群申请');
  } catch (error) {
    if (isCurrentJoinRequestSession(session) && requestVersion === session.requestVersion && status) status.textContent = `读取入群申请失败：${error.message}`;
    if (more) { more.hidden = false; more.textContent = '重试'; }
  } finally {
    if (isCurrentJoinRequestSession(session) && requestVersion === session.requestVersion) {
      session.loading = false;
      if (more) more.disabled = false;
      updateJoinRequestBulkActions();
    }
  }
}

async function decideAllJoinRequests(approved) {
  const session = joinRequestSession;
  if (!isCurrentJoinRequestSession(session) || session.query || session.loading || !session.count || session.bulkBusy) return;
  const operation = approved ? '批准' : '拒绝';
  if (!confirm(`${operation}当前群全部 ${session.count} 项待审核申请？`)) return;
  session.bulkBusy = true;
  updateJoinRequestBulkActions();
  const status = document.getElementById('join-requests-status');
  if (status) status.textContent = `正在${operation}全部申请…`;
  try {
    const { instId, chatId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('decide_all_join_requests', { instId, chatId, approved });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/join-requests/all`, 'POST', { chatId, approved });
    }
    if (!isCurrentJoinRequestSession(session)) return;
    session.requestVersion++;
    session.count = 0; session.cursor = null; session.ids.clear();
    document.getElementById('join-requests-list')?.replaceChildren();
    const more = document.getElementById('btn-more-join-requests');
    if (more) more.hidden = true;
    if (status) status.textContent = approved ? '已批准全部待审核申请。' : '已拒绝全部待审核申请。';
  } catch (error) {
    if (isCurrentJoinRequestSession(session) && status) status.textContent = `批量${operation}失败：${error.message}`;
  } finally {
    if (isCurrentJoinRequestSession(session)) { session.bulkBusy = false; updateJoinRequestBulkActions(); }
  }
}

async function decideJoinRequest(session, userId, approved, card) {
  if (!isCurrentJoinRequestSession(session)) return closeJoinRequestsModal();
  const actions = card.querySelectorAll('button');
  actions.forEach(button => { button.disabled = true; });
  try {
    const { instId, chatId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('decide_join_request', { instId, chatId, userId, approved });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/join-requests`, 'POST', { chatId, userId, approved });
    }
    if (!isCurrentJoinRequestSession(session) || !card.isConnected) return;
    session.ids.delete(userId); card.remove();
    session.count = Math.max(0, session.count - 1);
    const status = document.getElementById('join-requests-status');
    if (status) status.textContent = approved ? `已批准申请 · 剩余 ${session.count} 项` : `已拒绝申请 · 剩余 ${session.count} 项`;
  } catch (error) {
    if (isCurrentJoinRequestSession(session)) {
      actions.forEach(button => { button.disabled = false; });
      const status = document.getElementById('join-requests-status');
      if (status) status.textContent = `处理申请失败：${error.message}`;
    }
  }
}

function closeBannedMembersModal() {
  if (bannedMemberSession) bannedMemberSession.requestVersion++;
  bannedMemberSession = null;
  if (bannedMemberSearchTimer) clearTimeout(bannedMemberSearchTimer);
  bannedMemberSearchTimer = null;
  const modal = document.getElementById('modal-banned-members');
  if (modal) modal.style.display = 'none';
  document.getElementById('banned-members-list')?.replaceChildren();
}

function isCurrentBannedMemberSession(session = bannedMemberSession) {
  return Boolean(session && session === bannedMemberSession && isCurrentGroupMembersContext(session.context));
}

function openBannedMembersModal() {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context) || Number(context.chatId) >= 0) {
    return showToast('封禁名单仅适用于超级群和频道，请重新加载当前会话成员', 'warn');
  }
  const modal = document.getElementById('modal-banned-members');
  if (!modal) return showToast('封禁名单窗口不可用', 'error');
  closeBannedMembersModal();
  bannedMemberSession = { context, requestVersion: 0, loading: false, offset: 0, nextOffset: null, count: 0, query: '', ids: new Set() };
  const search = document.getElementById('banned-member-search');
  if (search) search.value = '';
  modal.style.display = 'flex';
  void loadBannedMembers(true);
}

async function loadBannedMembers(reset = false) {
  const session = bannedMemberSession;
  if (!isCurrentBannedMemberSession(session)) { closeBannedMembersModal(); return; }
  if (reset) {
    session.requestVersion++;
    session.loading = false;
    session.offset = 0;
    session.nextOffset = null;
    session.ids = new Set();
    document.getElementById('banned-members-list')?.replaceChildren();
  }
  if (session.loading || (!reset && session.nextOffset == null && session.ids.size > 0)) return;
  session.loading = true;
  const requestVersion = session.requestVersion;
  const offset = reset ? 0 : (session.nextOffset ?? 0);
  const status = document.getElementById('banned-members-status');
  const more = document.getElementById('btn-more-banned-members');
  if (more) more.disabled = true;
  if (status) status.textContent = reset ? '正在读取封禁名单…' : '正在加载更多用户…';
  try {
    let result;
    if (window.chatWs && window.chatWs.isConnected()) {
      result = await window.chatWs.sendRpc('get_banned_participants', {
        instId: session.context.instId, chatId: session.context.chatId, offset, limit: 50, query: session.query,
      });
    } else {
      const params = new URLSearchParams({ chatId: String(session.context.chatId), offset: String(offset), limit: '50', query: session.query });
      result = await api(`/api/instances/${encodeURIComponent(session.context.instId)}/account/banned-participants?${params}`);
    }
    if (!isCurrentBannedMemberSession(session) || requestVersion !== session.requestVersion) return;
    session.count = Math.max(0, Number(result?.count) || 0);
    const list = document.getElementById('banned-members-list');
    for (const participant of Array.isArray(result?.participants) ? result.participants : []) {
      const user = participant?.user || {};
      const userId = Number(user.id);
      if (!Number.isSafeInteger(userId) || userId <= 0 || session.ids.has(userId)) continue;
      session.ids.add(userId);
      const card = document.createElement('article'); card.className = 'join-request-card'; card.dataset.userId = String(userId);
      const info = document.createElement('div'); info.className = 'join-request-info';
      const name = document.createElement('div'); name.className = 'join-request-name';
      name.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `用户 ${userId}`;
      const meta = document.createElement('div'); meta.className = 'join-request-meta';
      const untilDate = Number(participant.untilDate) || 0;
      const expiry = untilDate > 0 ? `封禁至 ${new Date(untilDate * 1000).toLocaleString()}` : '永久封禁';
      meta.textContent = `${user.username ? `@${user.username} · ` : ''}${expiry}`;
      info.append(name, meta);
      const actions = document.createElement('div'); actions.className = 'join-request-actions';
      const unban = document.createElement('button'); unban.type = 'button'; unban.className = 'btn btn-secondary btn-xs'; unban.textContent = '解除封禁';
      unban.onclick = () => { void unbanBannedMember(session, userId, name.textContent, card, unban); };
      actions.appendChild(unban); card.append(info, actions); list?.appendChild(card);
    }
    const nextOffset = Number(result?.nextOffset);
    session.nextOffset = Number.isSafeInteger(nextOffset) && nextOffset > offset ? nextOffset : null;
    if (more) { more.hidden = session.nextOffset == null; more.textContent = '加载更多'; }
    if (status) status.textContent = session.count ? `封禁用户 ${session.count} 人，已显示 ${session.ids.size} 人` : '当前没有被封禁的用户';
  } catch (error) {
    if (isCurrentBannedMemberSession(session) && requestVersion === session.requestVersion && status) status.textContent = `读取封禁名单失败：${error.message}`;
    if (more) { more.hidden = false; more.textContent = '重试'; }
  } finally {
    if (isCurrentBannedMemberSession(session) && requestVersion === session.requestVersion) {
      session.loading = false;
      if (more) more.disabled = false;
    }
  }
}

async function unbanBannedMember(session, userId, name, card, button) {
  if (!isCurrentBannedMemberSession(session) || !card.isConnected || button.disabled) return;
  if (!confirm(`解除【${name}】在当前群组中的封禁？`)) return;
  if (!isCurrentBannedMemberSession(session)) return;
  button.disabled = true;
  try {
    const { instId, chatId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('unban_user', { instId, chatId, userId });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/unban`, 'POST', { chatId, userId });
    }
    if (!isCurrentBannedMemberSession(session) || !card.isConnected) return;
    session.ids.delete(userId);
    session.count = Math.max(0, session.count - 1);
    card.remove();
    const status = document.getElementById('banned-members-status');
    if (status) status.textContent = `已解除封禁 · 剩余 ${session.count} 人`;
  } catch (error) {
    if (isCurrentBannedMemberSession(session) && card.isConnected) {
      button.disabled = false;
      const status = document.getElementById('banned-members-status');
      if (status) status.textContent = `解除封禁失败：${error.message}`;
    }
  }
}

function closeInviteLinksModal() {
  if (inviteLinkSession) inviteLinkSession.requestVersion++;
  inviteLinkSession = null;
  const modal = document.getElementById('modal-invite-links');
  if (modal) modal.style.display = 'none';
  document.getElementById('invite-links-list')?.replaceChildren();
}

function isCurrentInviteLinkSession(session = inviteLinkSession) {
  return Boolean(session && session === inviteLinkSession && isCurrentGroupMembersContext(session.context));
}

function openInviteLinksModal() {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context) || Number(context.chatId) >= 0) {
    return showToast('邀请链接仅适用于群组和频道，请重新加载当前会话成员', 'warn');
  }
  const modal = document.getElementById('modal-invite-links');
  if (!modal) return showToast('邀请链接窗口不可用', 'error');
  closeInviteLinksModal();
  inviteLinkSession = { context, requestVersion: 0, loading: false, cursor: null, count: 0, links: new Set() };
  const title = document.getElementById('invite-link-title');
  const expiry = document.getElementById('invite-link-expiry');
  const limit = document.getElementById('invite-link-limit');
  const requestNeeded = document.getElementById('invite-link-request-needed');
  if (title) title.value = '';
  if (expiry) expiry.value = '0';
  if (limit) limit.value = '';
  if (requestNeeded) requestNeeded.checked = false;
  modal.style.display = 'flex';
  void loadInviteLinks(true);
}

function safeTelegramInviteLink(value) {
  return typeof value === 'string' && /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(value);
}

async function loadInviteLinks(reset = false) {
  const session = inviteLinkSession;
  if (!isCurrentInviteLinkSession(session)) { closeInviteLinksModal(); return; }
  if (reset) {
    session.requestVersion++;
    session.loading = false;
    session.cursor = null;
    session.links = new Set();
    document.getElementById('invite-links-list')?.replaceChildren();
  }
  if (session.loading) return;
  session.loading = true;
  const requestVersion = session.requestVersion;
  const cursor = reset ? null : session.cursor;
  const status = document.getElementById('invite-links-status');
  const more = document.getElementById('btn-more-invite-links');
  if (more) more.disabled = true;
  if (status) status.textContent = reset ? '正在读取邀请链接…' : '正在加载更多链接…';
  try {
    let result;
    if (window.chatWs && window.chatWs.isConnected()) {
      result = await window.chatWs.sendRpc('get_chat_invite_links', {
        instId: session.context.instId, chatId: session.context.chatId, cursor, limit: 50,
      });
    } else {
      const params = new URLSearchParams({ chatId: String(session.context.chatId), limit: '50' });
      if (cursor) { params.set('date', String(cursor.date)); params.set('link', cursor.link); }
      result = await api(`/api/instances/${encodeURIComponent(session.context.instId)}/account/invite-links?${params}`);
    }
    if (!isCurrentInviteLinkSession(session) || requestVersion !== session.requestVersion) return;
    session.count = Math.max(0, Number(result?.count) || 0);
    const list = document.getElementById('invite-links-list');
    const page = Array.isArray(result?.links) ? result.links : [];
    for (const invite of page) {
      if (!invite || !safeTelegramInviteLink(invite.link) || session.links.has(invite.link)) continue;
      session.links.add(invite.link);
      const card = document.createElement('article'); card.className = 'join-request-card invite-link-card';
      const info = document.createElement('div'); info.className = 'join-request-info';
      const name = document.createElement('div'); name.className = 'join-request-name';
      name.textContent = invite.title || '邀请链接';
      const anchor = document.createElement('a'); anchor.className = 'invite-link-url'; anchor.href = invite.link;
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = invite.link;
      const created = Number(invite.date) || 0;
      const expires = Number(invite.expireDate) || 0;
      const limit = Number(invite.usageLimit) || 0;
      const usage = Number(invite.usage) || 0;
      const meta = document.createElement('div'); meta.className = 'join-request-meta';
      meta.textContent = `${created ? `创建于 ${new Date(created * 1000).toLocaleString()} · ` : ''}${expires ? `有效至 ${new Date(expires * 1000).toLocaleString()}` : '永久有效'} · ${limit ? `已使用 ${usage}/${limit}` : `已使用 ${usage} 次`}${invite.requestNeeded ? ' · 需管理员批准' : ''}`;
      info.append(name, anchor, meta);
      const actions = document.createElement('div'); actions.className = 'join-request-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-secondary btn-xs'; copy.textContent = '复制';
      copy.onclick = async () => {
        if (!isCurrentInviteLinkSession(session) || !card.isConnected) return;
        try {
          await navigator.clipboard.writeText(invite.link);
          if (isCurrentInviteLinkSession(session) && card.isConnected && status) status.textContent = '邀请链接已复制。';
        } catch (error) {
          if (isCurrentInviteLinkSession(session) && card.isConnected && status) status.textContent = `复制失败：${error.message || '浏览器未授权剪贴板'}`;
        }
      };
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'btn btn-secondary btn-xs'; rename.textContent = '改名';
      rename.onclick = () => { void editInviteLinkTitle(session, invite.link, String(invite.title || ''), name); };
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-danger btn-xs'; revoke.textContent = '撤销';
      revoke.onclick = () => { void revokeInviteLink(session, invite.link, name.textContent, card, revoke); };
      actions.append(copy, rename, revoke); card.append(info, actions); list?.appendChild(card);
    }
    const next = result?.nextCursor;
    session.cursor = next && Number.isSafeInteger(Number(next.date)) && Number(next.date) >= 0 && safeTelegramInviteLink(next.link)
      ? { date: Number(next.date), link: next.link } : null;
    if (more) { more.hidden = !session.cursor; more.textContent = '加载更多'; }
    if (status) status.textContent = session.count ? `有效邀请链接 ${session.count} 条，已显示 ${session.links.size} 条` : '当前没有有效的邀请链接';
  } catch (error) {
    if (isCurrentInviteLinkSession(session) && requestVersion === session.requestVersion && status) status.textContent = `读取邀请链接失败：${error.message}`;
    if (more) { more.hidden = false; more.textContent = '重试'; }
  } finally {
    if (isCurrentInviteLinkSession(session) && requestVersion === session.requestVersion) {
      session.loading = false;
      if (more) more.disabled = false;
    }
  }
}

async function createInviteLink() {
  const session = inviteLinkSession;
  if (!isCurrentInviteLinkSession(session) || session.creating) return;
  const titleInput = document.getElementById('invite-link-title');
  const expiryInput = document.getElementById('invite-link-expiry');
  const limitInput = document.getElementById('invite-link-limit');
  const requestInput = document.getElementById('invite-link-request-needed');
  const status = document.getElementById('invite-links-status');
  const button = document.getElementById('btn-create-invite-link');
  const title = titleInput?.value.trim() || '';
  const expirySeconds = Number(expiryInput?.value || 0);
  const usageLimit = limitInput?.value.trim() ? Number(limitInput.value) : undefined;
  if (title.length > 32 || (expirySeconds !== 0 && ![86400, 604800, 2592000].includes(expirySeconds)) ||
      (usageLimit !== undefined && (!Number.isSafeInteger(usageLimit) || usageLimit < 1 || usageLimit > 99999))) {
    if (status) status.textContent = '请检查名称、有效期和人数上限。';
    return;
  }
  const payload = {
    chatId: session.context.chatId, title: title || undefined,
    expireDate: expirySeconds ? Math.floor(Date.now() / 1000) + expirySeconds : undefined,
    usageLimit, requestNeeded: Boolean(requestInput?.checked),
  };
  session.creating = true;
  if (button) button.disabled = true;
  if (status) status.textContent = '正在创建邀请链接…';
  try {
    const { instId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('create_chat_invite_link', { instId, ...payload });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/invite-links`, 'POST', { action: 'create', ...payload });
    }
    if (!isCurrentInviteLinkSession(session)) return;
    if (titleInput) titleInput.value = '';
    if (expiryInput) expiryInput.value = '0';
    if (limitInput) limitInput.value = '';
    if (requestInput) requestInput.checked = false;
    await loadInviteLinks(true);
    if (isCurrentInviteLinkSession(session) && status) status.textContent = `已创建邀请链接 · 当前显示 ${session.links.size} 条`;
  } catch (error) {
    if (isCurrentInviteLinkSession(session) && status) status.textContent = `创建邀请链接失败：${error.message}`;
  } finally {
    session.creating = false;
    if (button && isCurrentInviteLinkSession(session)) button.disabled = false;
  }
}

async function revokeInviteLink(session, link, title, card, button) {
  if (!isCurrentInviteLinkSession(session) || !card.isConnected || button.disabled) return;
  if (!confirm(`撤销「${title}」？撤销后此邀请链接将无法继续使用。`)) return;
  if (!isCurrentInviteLinkSession(session)) return;
  button.disabled = true;
  try {
    const { instId, chatId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('revoke_chat_invite_link', { instId, chatId, link });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/invite-links`, 'POST', { action: 'revoke', chatId, link });
    }
    if (!isCurrentInviteLinkSession(session) || !card.isConnected) return;
    session.links.delete(link);
    session.count = Math.max(0, session.count - 1);
    card.remove();
    const status = document.getElementById('invite-links-status');
    if (status) status.textContent = `已撤销邀请链接 · 剩余 ${session.count} 条`;
  } catch (error) {
    if (isCurrentInviteLinkSession(session) && card.isConnected) {
      button.disabled = false;
      const status = document.getElementById('invite-links-status');
      if (status) status.textContent = `撤销邀请链接失败：${error.message}`;
    }
  }
}

async function editInviteLinkTitle(session, link, currentTitle, nameElement) {
  if (!isCurrentInviteLinkSession(session)) return;
  const nextTitle = window.prompt('设置邀请链接名称（最多 32 个字符；留空可移除名称）', currentTitle);
  if (nextTitle === null) return;
  if (nextTitle.trim().length > 32 || /[\u0000-\u001f]/.test(nextTitle)) {
    const status = document.getElementById('invite-links-status');
    if (status) status.textContent = '邀请链接名称不能超过 32 个字符。';
    return;
  }
  if (!isCurrentInviteLinkSession(session)) return;
  const status = document.getElementById('invite-links-status');
  try {
    let updated;
    const { instId, chatId } = session.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      updated = await window.chatWs.sendRpc('edit_chat_invite_link', { instId, chatId, link, title: nextTitle.trim() });
    } else {
      updated = await api(`/api/instances/${encodeURIComponent(instId)}/account/invite-links`, 'POST', {
        action: 'edit', chatId, link, title: nextTitle.trim(),
      });
    }
    if (!isCurrentInviteLinkSession(session)) return;
    nameElement.textContent = updated?.title || '邀请链接';
    if (status) status.textContent = '邀请链接名称已更新。';
  } catch (error) {
    if (isCurrentInviteLinkSession(session) && status) status.textContent = `修改邀请链接名称失败：${error.message}`;
  }
}

function invalidateGroupMembers() {
  closeGroupMuteModal();
  closeJoinRequestsModal();
  closeBannedMembersModal();
  closeInviteLinksModal();
  closeGroupInviteModal();
  const addButton = document.getElementById('btn-add-group-members');
  if (addButton) addButton.hidden = true;
  const bannedButton = document.getElementById('btn-view-banned-members');
  if (bannedButton) bannedButton.hidden = true;
  const inviteButton = document.getElementById('btn-view-invite-links');
  if (inviteButton) inviteButton.hidden = true;
  if (groupMemberSearchTimer) clearTimeout(groupMemberSearchTimer);
  groupMemberSearchTimer = null;
  groupMembersRequest++;
  groupMembersContext = null;
  state.groupMembers = [];
  const container = document.getElementById('members-list-container');
  if (container) container.innerHTML = '<div class="empty-hint">请先加载当前群成员</div>';
}

function normalizeGroupSelfPermissions(value) {
  return {
    isCreator: Boolean(value?.isCreator),
    canInviteUsers: Boolean(value?.canInviteUsers),
    canBanUsers: Boolean(value?.canBanUsers),
    canAddAdmins: Boolean(value?.canAddAdmins),
  };
}

function canManageGroupMemberTarget(member, action) {
  const permissions = groupMembersContext?.selfPermissions || normalizeGroupSelfPermissions();
  const targetIsOwner = member?.role === 'owner';
  const targetIsAdmin = member?.role === 'admin';
  const targetCanBeManaged = !member?.isLeft && (targetIsAdmin || member?.role === 'member');
  const targetCanBeModerated = !member?.isLeft && (targetCanBeManaged || member?.role === 'banned');
  if (action === 'admin') return permissions.canAddAdmins && targetCanBeManaged;
  if (action === 'moderate') return permissions.canBanUsers && targetCanBeModerated && (!targetIsAdmin || permissions.isCreator);
  return false;
}

function isCurrentGroupMembersContext(context) {
  return Boolean(context && context === groupMembersContext &&
    state.clientSelectedInstance === context.instId &&
    String(state.clientActiveChatId) === String(context.chatId) &&
    state.chatSelectionVersion === context.selectionVersion);
}

function closeCreateChatModal() {
  if (createChatSession) createChatSession.requestVersion++;
  createChatSession = null;
  if (createChatSearchTimer) clearTimeout(createChatSearchTimer);
  createChatSearchTimer = null;
  const modal = document.getElementById('modal-create-chat');
  if (modal) modal.style.display = 'none';
  document.getElementById('create-chat-member-list')?.replaceChildren();
  const submit = document.getElementById('btn-submit-create-chat');
  if (submit) submit.disabled = true;
}

function isCurrentCreateChatSession(session = createChatSession) {
  return Boolean(session && session === createChatSession && state.clientSelectedInstance === session.instId);
}

function openCreateChatModal() {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('请先选择 Telegram 账号', 'warn');
  const modal = document.getElementById('modal-create-chat');
  if (!modal) return showToast('新建群组窗口不可用', 'error');
  closeCreateChatModal();
  createChatSession = { instId, requestVersion: 0, selected: new Map(), loading: false };
  const type = document.getElementById('create-chat-type');
  if (type) type.value = 'group';
  const title = document.getElementById('create-chat-name');
  if (title) title.value = '';
  const about = document.getElementById('create-chat-about');
  if (about) about.value = '';
  const forum = document.getElementById('create-chat-forum');
  if (forum) forum.checked = false;
  const search = document.getElementById('create-chat-member-search');
  if (search) search.value = '';
  const status = document.getElementById('create-chat-member-status');
  if (status) status.textContent = '输入至少一个字符以搜索 Telegram 用户。';
  const createStatus = document.getElementById('create-chat-status');
  if (createStatus) createStatus.textContent = '';
  modal.style.display = 'flex';
  updateCreateChatType();
  title?.focus();
}

function updateCreateChatType() {
  const type = document.getElementById('create-chat-type')?.value || 'group';
  const members = document.getElementById('create-chat-members-wrap');
  const about = document.getElementById('create-chat-about-wrap');
  const forum = document.getElementById('create-chat-forum-wrap');
  if (type !== 'group' && createChatSession) {
    createChatSession.requestVersion++;
    createChatSession.selected.clear();
    createChatSession.loading = false;
    document.getElementById('create-chat-member-list')?.replaceChildren();
  }
  if (members) members.hidden = type !== 'group';
  if (about) about.hidden = type === 'group';
  if (forum) forum.hidden = type !== 'supergroup';
  updateCreateChatSubmitState();
}

function updateCreateChatSubmitState() {
  const session = createChatSession;
  const type = document.getElementById('create-chat-type')?.value || 'group';
  const title = document.getElementById('create-chat-name')?.value.trim() || '';
  const submit = document.getElementById('btn-submit-create-chat');
  if (submit) submit.disabled = !isCurrentCreateChatSession(session) || session.loading || !title || (type === 'group' && !session.selected.size);
}

async function searchCreateChatCandidates(query) {
  const session = createChatSession;
  if (!isCurrentCreateChatSession(session)) { closeCreateChatModal(); return; }
  const normalizedQuery = String(query || '').trim();
  const requestVersion = ++session.requestVersion;
  session.selected.clear();
  const status = document.getElementById('create-chat-member-status');
  const list = document.getElementById('create-chat-member-list');
  list?.replaceChildren();
  updateCreateChatSubmitState();
  if (!normalizedQuery) {
    if (status) status.textContent = '输入至少一个字符以搜索 Telegram 用户。';
    return;
  }
  session.loading = true;
  if (status) status.textContent = '正在搜索 Telegram 用户…';
  updateCreateChatSubmitState();
  try {
    let results;
    if (window.chatWs && window.chatWs.isConnected()) {
      results = await window.chatWs.sendRpc('search_dialogs', { instId: session.instId, query: normalizedQuery });
    } else {
      results = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/search-dialogs?query=${encodeURIComponent(normalizedQuery)}`);
    }
    if (!isCurrentCreateChatSession(session) || requestVersion !== session.requestVersion) return;
    const seen = new Set();
    const candidates = (Array.isArray(results) ? results : []).filter(candidate => {
      const id = Number(candidate?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || candidate.type !== 'private' || candidate.isSelf || seen.has(String(id))) return false;
      seen.add(String(id)); return true;
    });
    for (const candidate of candidates) {
      const row = document.createElement('label'); row.className = 'group-invite-candidate';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(candidate.id);
      const info = document.createElement('span'); info.className = 'group-invite-candidate-info';
      const name = document.createElement('span'); name.className = 'group-invite-candidate-name'; name.textContent = candidate.title || `ID: ${candidate.id}`;
      const meta = document.createElement('span'); meta.className = 'group-invite-candidate-meta';
      meta.textContent = candidate.username ? `@${candidate.username}${candidate.isBot ? ' · Bot' : ''}` : `ID: ${candidate.id}${candidate.isBot ? ' · Bot' : ''}`;
      info.append(name, meta); row.append(checkbox, info); list?.appendChild(row);
      checkbox.onchange = () => {
        if (!isCurrentCreateChatSession(session) || requestVersion !== session.requestVersion) return;
        if (checkbox.checked && session.selected.size >= 50) {
          checkbox.checked = false;
          if (status) status.textContent = '初始成员最多选择 50 位。';
          return;
        }
        if (checkbox.checked) session.selected.set(String(candidate.id), candidate);
        else session.selected.delete(String(candidate.id));
        updateCreateChatSubmitState();
      };
    }
    if (status) status.textContent = candidates.length ? `找到 ${candidates.length} 位用户，已选 ${session.selected.size} 位。` : '没有找到可添加的 Telegram 用户。';
  } catch (error) {
    if (isCurrentCreateChatSession(session) && requestVersion === session.requestVersion && status) status.textContent = `搜索失败：${error.message}`;
  } finally {
    if (isCurrentCreateChatSession(session) && requestVersion === session.requestVersion) {
      session.loading = false;
      updateCreateChatSubmitState();
    }
  }
}

async function createTelegramChat(event) {
  event.preventDefault();
  const session = createChatSession;
  if (!isCurrentCreateChatSession(session) || session.loading) return;
  const type = document.getElementById('create-chat-type')?.value || 'group';
  const title = document.getElementById('create-chat-name')?.value.trim() || '';
  const about = document.getElementById('create-chat-about')?.value || '';
  const forum = Boolean(document.getElementById('create-chat-forum')?.checked);
  const userIds = [...session.selected.keys()].map(Number);
  if (!title || title.length > 128 || (type === 'group' && !userIds.length)) {
    const status = document.getElementById('create-chat-status');
    if (status) status.textContent = type === 'group' && !userIds.length ? '群组至少需要选择一位初始成员。' : '请输入有效的群组名称。';
    return;
  }
  session.loading = true;
  const submit = document.getElementById('btn-submit-create-chat');
  if (submit) submit.disabled = true;
  const status = document.getElementById('create-chat-status');
  if (status) status.textContent = '正在通过 Telegram 创建…';
  try {
    const options = { type, title, about, userIds, forum };
    let created;
    if (window.chatWs && window.chatWs.isConnected()) {
      created = await window.chatWs.sendRpc('create_chat', { instId: session.instId, ...options });
    } else {
      created = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/create-chat`, 'POST', options);
    }
    if (!isCurrentCreateChatSession(session)) return;
    if (!Number.isSafeInteger(Number(created?.id)) || !Number(created.id)) throw new Error('Telegram 未返回新会话');
    const dialog = { ...created, id: Number(created.id), type: created.type || type, title: created.title || title, unreadCount: 0 };
    closeCreateChatModal();
    state.clientDialogs = [dialog, ...state.clientDialogs.filter(item => String(item.id) !== String(dialog.id))];
    renderClientDialogs();
    selectClientChat(dialog);
    showToast(`已创建${type === 'channel' ? '频道' : type === 'supergroup' ? '超级群' : '群组'}「${dialog.title}」`, 'success');
  } catch (error) {
    if (isCurrentCreateChatSession(session) && status) status.textContent = `创建失败：${error.message}`;
  } finally {
    if (isCurrentCreateChatSession(session)) {
      session.loading = false;
      updateCreateChatSubmitState();
    }
  }
}

function closeGroupInviteModal() {
  if (groupInviteSession) groupInviteSession.requestVersion++;
  groupInviteSession = null;
  if (groupInviteSearchTimer) clearTimeout(groupInviteSearchTimer);
  groupInviteSearchTimer = null;
  const modal = document.getElementById('modal-add-group-members');
  if (modal) modal.style.display = 'none';
  document.getElementById('group-invite-list')?.replaceChildren();
  const add = document.getElementById('btn-add-selected-group-members');
  if (add) add.disabled = true;
}

function isCurrentGroupInviteSession(session = groupInviteSession) {
  return Boolean(session && session === groupInviteSession && isCurrentGroupMembersContext(session.context));
}

function openGroupInviteModal() {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('请先加载当前群成员', 'warn');
  if (!context.selfPermissions?.canInviteUsers) return showToast('当前账号没有邀请成员的权限', 'warn');
  const modal = document.getElementById('modal-add-group-members');
  if (!modal) return showToast('添加成员窗口不可用', 'error');
  closeGroupInviteModal();
  groupInviteSession = { context, requestVersion: 0, selected: new Map(), loading: false };
  const input = document.getElementById('group-invite-search');
  if (input) input.value = '';
  const status = document.getElementById('group-invite-status');
  if (status) status.textContent = '输入至少一个字符以搜索 Telegram 用户。';
  modal.style.display = 'flex';
  input?.focus();
}

function updateGroupInviteSelection(session = groupInviteSession) {
  const add = document.getElementById('btn-add-selected-group-members');
  if (!add) return;
  const count = session?.selected.size || 0;
  add.disabled = !isCurrentGroupInviteSession(session) || !count || Boolean(session?.loading);
  add.textContent = count ? `添加所选成员 (${count})` : '添加所选成员';
}

async function searchGroupInviteCandidates(query) {
  const session = groupInviteSession;
  if (!isCurrentGroupInviteSession(session)) { closeGroupInviteModal(); return; }
  const normalizedQuery = String(query || '').trim();
  const requestVersion = ++session.requestVersion;
  session.loading = false;
  session.selected.clear();
  const status = document.getElementById('group-invite-status');
  const list = document.getElementById('group-invite-list');
  list?.replaceChildren();
  updateGroupInviteSelection(session);
  if (!normalizedQuery) {
    if (status) status.textContent = '输入至少一个字符以搜索 Telegram 用户。';
    return;
  }
  if (normalizedQuery.length > 128) {
    if (status) status.textContent = '搜索内容不能超过 128 个字符。';
    return;
  }
  session.loading = true;
  if (status) status.textContent = '正在搜索 Telegram 用户…';
  updateGroupInviteSelection(session);
  try {
    let results;
    if (window.chatWs && window.chatWs.isConnected()) {
      results = await window.chatWs.sendRpc('search_dialogs', { instId: session.context.instId, query: normalizedQuery });
    } else {
      results = await api(`/api/instances/${encodeURIComponent(session.context.instId)}/account/search-dialogs?query=${encodeURIComponent(normalizedQuery)}`);
    }
    if (!isCurrentGroupInviteSession(session) || requestVersion !== session.requestVersion) return;
    const knownMembers = new Set(state.groupMembers.map(member => String(member.user?.id)));
    const seen = new Set();
    const candidates = (Array.isArray(results) ? results : []).filter(candidate => {
      const id = Number(candidate?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || candidate.type !== 'private' || candidate.isSelf || knownMembers.has(String(id)) || seen.has(String(id))) return false;
      seen.add(String(id));
      return true;
    });
    for (const candidate of candidates) {
      const row = document.createElement('label'); row.className = 'group-invite-candidate';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(candidate.id);
      const info = document.createElement('span'); info.className = 'group-invite-candidate-info';
      const name = document.createElement('span'); name.className = 'group-invite-candidate-name';
      name.textContent = candidate.title || `ID: ${candidate.id}`;
      const meta = document.createElement('span'); meta.className = 'group-invite-candidate-meta';
      meta.textContent = candidate.username ? `@${candidate.username}${candidate.isBot ? ' · Bot' : ''}` : `ID: ${candidate.id}${candidate.isBot ? ' · Bot' : ''}`;
      info.append(name, meta); row.append(checkbox, info); list?.appendChild(row);
      checkbox.onchange = () => {
        if (!isCurrentGroupInviteSession(session) || requestVersion !== session.requestVersion) return;
        const id = String(candidate.id);
        if (checkbox.checked && session.selected.size >= 10) {
          checkbox.checked = false;
          if (status) status.textContent = '一次最多添加 10 位成员。';
          return;
        }
        if (checkbox.checked) session.selected.set(id, candidate);
        else session.selected.delete(id);
        updateGroupInviteSelection(session);
      };
    }
    if (status) status.textContent = candidates.length ? `找到 ${candidates.length} 位 Telegram 用户，可选择最多 10 位。` : '没有找到可邀请的 Telegram 用户。';
  } catch (error) {
    if (isCurrentGroupInviteSession(session) && requestVersion === session.requestVersion && status) status.textContent = `搜索 Telegram 用户失败：${error.message}`;
  } finally {
    if (isCurrentGroupInviteSession(session) && requestVersion === session.requestVersion) {
      session.loading = false;
      updateGroupInviteSelection(session);
    }
  }
}

async function inviteSelectedGroupMembers() {
  const session = groupInviteSession;
  if (!isCurrentGroupInviteSession(session) || !session.selected.size || session.loading) return;
  if (!session.context.selfPermissions?.canInviteUsers) return showToast('当前账号没有邀请成员的权限', 'warn');
  const selected = [...session.selected.values()].slice(0, 10);
  session.loading = true;
  const status = document.getElementById('group-invite-status');
  if (status) status.textContent = `正在邀请 ${selected.length} 位成员…`;
  updateGroupInviteSelection(session);
  const added = [], failed = [];
  try {
    for (const candidate of selected) {
      if (!isCurrentGroupInviteSession(session)) return;
      try {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('invite_user', {
            instId: session.context.instId, chatId: session.context.chatId, userId: Number(candidate.id),
          });
        } else {
          await api(`/api/instances/${encodeURIComponent(session.context.instId)}/account/invite-user`, 'POST', {
            chatId: session.context.chatId, userId: Number(candidate.id),
          });
        }
        added.push(candidate.title || `ID: ${candidate.id}`);
      } catch (error) {
        failed.push(`${candidate.title || `ID: ${candidate.id}`}: ${error.message}`);
      }
    }
    if (!isCurrentGroupInviteSession(session)) return;
    const targetChatId = session.context.chatId;
    if (added.length) {
      closeGroupInviteModal();
      await loadGroupMembers(targetChatId);
      showToast(`已邀请 ${added.length} 位成员${failed.length ? `；失败 ${failed.length} 位` : ''}`, failed.length ? 'warn' : 'success');
      if (failed.length) showToast(failed.slice(0, 3).join('；'), 'error');
    } else if (status) {
      status.textContent = `邀请失败：${failed.slice(0, 3).join('；') || 'Telegram 未确认操作'}`;
    }
  } finally {
    if (isCurrentGroupInviteSession(session)) {
      session.loading = false;
      updateGroupInviteSelection(session);
    }
  }
}

async function loadGroupMembers(chatId, reset = true) {
  const addButton = document.getElementById('btn-add-group-members');
  if (addButton) addButton.hidden = true;
  const bannedButton = document.getElementById('btn-view-banned-members');
  if (bannedButton) bannedButton.hidden = true;
  const inviteButton = document.getElementById('btn-view-invite-links');
  if (inviteButton) inviteButton.hidden = true;
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId || String(state.clientActiveChatId) !== String(chatId)) return;
  if (reset) {
    closeGroupMuteModal();
    closeGroupInviteModal();
    closeJoinRequestsModal();
    closeBannedMembersModal();
    closeInviteLinksModal();
  }
  const selectionVersion = state.chatSelectionVersion;
  let context = groupMembersContext;
  if (reset || !context || context.instId !== instId || String(context.chatId) !== String(chatId) || context.selectionVersion !== selectionVersion) {
    context = {
      instId, chatId, selectionVersion,
      query: document.getElementById('member-search-input')?.value.trim() || '',
      nextOffset: 0, count: 0, loading: false, error: '',
    };
    groupMembersContext = context;
    state.groupMembers = [];
  } else if (context.loading || context.nextOffset == null) {
    return;
  }
  if (context.loading) return;
  const offset = reset ? 0 : context.nextOffset;
  const request = ++groupMembersRequest;
  context.loading = true;
  context.error = '';
  const current = () => request === groupMembersRequest && groupMembersContext === context &&
    state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) &&
    state.chatSelectionVersion === selectionVersion;
  const container = document.getElementById('members-list-container');
  if (reset && container) container.innerHTML = '<div class="empty-hint">正在加载群成员...</div>';

  try {
    let page;
    if (window.chatWs && window.chatWs.isConnected()) {
      page = await window.chatWs.sendRpc('get_participants', { instId, chatId, offset, limit: 50, query: context.query });
    } else {
      const params = new URLSearchParams({ chatId: String(chatId), offset: String(offset), limit: '50', query: context.query });
      page = await api(`/api/instances/${encodeURIComponent(instId)}/account/participants?${params}`);
    }

    if (!current()) return;
    const normalizedPage = Array.isArray(page) ? { count: page.length, participants: page } : (page || {});
    context.selfPermissions = normalizeGroupSelfPermissions(normalizedPage.selfPermissions);
    if (bannedButton) bannedButton.hidden = !context.selfPermissions.canBanUsers;
    if (inviteButton) inviteButton.hidden = !context.selfPermissions.canInviteUsers;
    if (addButton) addButton.hidden = !context.selfPermissions.canInviteUsers;
    const participants = Array.isArray(normalizedPage.participants) ? normalizedPage.participants : [];
    const members = reset ? [] : state.groupMembers.slice();
    const seen = new Set(members.map(item => String(item.user?.id)));
    for (const item of participants) {
      const userId = String(item?.user?.id || '');
      if (userId && !seen.has(userId)) { seen.add(userId); members.push(item); }
    }
    state.groupMembers = members;
    context.count = Math.max(0, Number(normalizedPage.count) || 0);
    context.nextOffset = Number.isSafeInteger(Number(normalizedPage.nextOffset)) && Number(normalizedPage.nextOffset) > offset
      ? Number(normalizedPage.nextOffset) : null;
    context.error = '';
    renderGroupMembers();
  } catch (err) {
    if (current()) {
      context.error = err.message || '未知错误';
      renderGroupMembers();
    }
  } finally {
    if (current()) { context.loading = false; renderGroupMembers(); }
  }
}

function loadMoreGroupMembers() {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context) || context.loading || context.nextOffset == null) return;
  return loadGroupMembers(context.chatId, false);
}

function renderGroupMembers() {
  const container = document.getElementById('members-list-container');
  const searchInput = document.getElementById('member-search-input');
  if (!container) return;
  if (!isCurrentGroupMembersContext(groupMembersContext)) {
    container.innerHTML = '<div class="empty-hint">请先加载当前群成员</div>';
    return;
  }

  const list = state.groupMembers;

  if (list.length === 0) {
    const message = groupMembersContext.loading ? '正在加载群成员…' : groupMembersContext.error
      ? `获取群成员失败：${escapeHtml(groupMembersContext.error)}`
      : groupMembersContext.query ? '未检索到匹配的群成员' : '当前没有可显示的群成员';
    container.innerHTML = `<div class="empty-hint${groupMembersContext.error ? ' error' : ''}">${message}</div>`;
    if (groupMembersContext.error) container.innerHTML += '<button class="btn btn-secondary btn-xs member-list-more" type="button" onclick="loadGroupMembers(state.clientActiveChatId)">重试</button>';
    return;
  }

  let html = '';
  for (const item of list) {
    const u = item.user || {};
    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || `UID:${u.id}`;
    const initials = Array.from(u.firstName || u.username || 'U').slice(0, 2).join('');
    const usernameStr = u.username ? `@${u.username}` : `ID: ${u.id}`;
    const avatarUrl = `/api/instances/${encodeURIComponent(state.clientSelectedInstance)}/account/avatar?chatId=${encodeURIComponent(u.id)}`;
    const canManageAdmin = canManageGroupMemberTarget(item, 'admin');
    const canModerate = canManageGroupMemberTarget(item, 'moderate');

    let roleBadgeHtml = '';
    if (item.role === 'owner') {
      roleBadgeHtml = '<span class="member-badge owner" title="群主">群主</span>';
    } else if (item.role === 'admin') {
      roleBadgeHtml = '<span class="member-badge admin" title="管理员">管理员</span>';
    } else if (u.isBot) {
      roleBadgeHtml = '<span class="member-badge bot" title="机器人">Bot</span>';
    }

    html += `
      <div class="member-item-card">
        <button class="member-main" type="button" onclick="loadPeerProfile(${inlineJsArg(u.id)})" title="查看 ${escapeHtml(fullName)} 的资料">
          <span class="member-avatar">
            <img data-network-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()">
            <span class="member-avatar-initials">${escapeHtml(initials)}</span>
          </span>
          <span class="member-text-meta">
            <span class="member-name-row">
              <span class="member-name" title="${escapeHtml(fullName)}">${escapeHtml(fullName)}</span>
              ${roleBadgeHtml}
            </span>
            <span class="member-subtext">${escapeHtml(usernameStr)}</span>
          </span>
        </button>
        <details class="member-actions-menu">
          <summary aria-label="${escapeHtml(`管理 ${fullName}`)}" title="成员操作"><svg class="ui-icon-sm"><use href="#icon-dots-vertical"/></svg></summary>
          <div class="member-actions-menu-list">
            <button type="button" class="member-menu-action" onclick="startDirectChat(${inlineJsArg(u.id)}, ${inlineJsArg(fullName)})">发起私聊</button>
            ${canManageAdmin ? `<button type="button" class="member-menu-action" onclick="manageGroupAdmin(${inlineJsArg(u.id)}, ${inlineJsArg(fullName)})">${item.role === 'admin' ? (item.supportsCustomAdminRights ? '管理管理员权限' : '撤销管理员') : '设为管理员'}</button>` : ''}
            ${canModerate && item.supportsCustomAdminRights ? `<button type="button" class="member-menu-action" onclick="openGroupMuteModal(${inlineJsArg(u.id)}, ${inlineJsArg(fullName)})">设置禁言时长</button>` : ''}
            ${canModerate && item.supportsCustomAdminRights ? `<button type="button" class="member-menu-action danger" onclick="openGroupBanModal(${inlineJsArg(u.id)}, ${inlineJsArg(fullName)})">封禁此成员</button>` : ''}
            ${canModerate ? `<button type="button" class="member-menu-action danger" onclick="kickGroupMember(${inlineJsArg(u.id)}, ${inlineJsArg(fullName)})">移出群组</button>` : ''}
          </div>
        </details>
      </div>
    `;
  }
  const loadedLabel = groupMembersContext.query
    ? `匹配 ${groupMembersContext.count} 位 · 已加载 ${state.groupMembers.length} 位`
    : `共 ${groupMembersContext.count} 位成员 · 已加载 ${state.groupMembers.length} 位`;
  const more = groupMembersContext.error
    ? `<button class="btn btn-secondary btn-xs" type="button" onclick="loadMoreGroupMembers()">加载失败，重试</button>`
    : groupMembersContext.nextOffset != null
      ? `<button class="btn btn-secondary btn-xs" type="button" onclick="loadMoreGroupMembers()" ${groupMembersContext.loading ? 'disabled' : ''}>${groupMembersContext.loading ? '正在加载…' : '加载更多'}</button>`
      : '';
  const loading = groupMembersContext.loading && list.length ? '<span>正在加载…</span>' : '';
  container.innerHTML = `${html}<div class="member-list-footer"><span>${loadedLabel}</span>${loading}${more}</div>`;
}

let groupInfoTarget = null;

async function uploadGroupPhoto(event) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;
  const profile = state.currentPeerProfile;
  const chatId = Number(state.clientActiveChatId);
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  if (!instId || !profile || !['group', 'supergroup', 'channel'].includes(profile.type) ||
      String(state.currentProfileChatId) !== String(chatId)) {
    if (input) input.value = '';
    return showToast('请先打开当前群组或频道资料', 'warn');
  }
  if (!file.size || file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    if (input) input.value = '';
    return showToast('请选择 10 MiB 以内的 JPEG、PNG 或 WebP 图片', 'warn');
  }
  const current = () => state.clientSelectedInstance === instId && Number(state.clientActiveChatId) === chatId &&
    state.chatSelectionVersion === selectionVersion && state.currentPeerProfile === profile && String(state.currentProfileChatId) === String(chatId);
  const status = document.getElementById('group-photo-status');
  if (status) status.textContent = '正在上传群组头像…';
  try {
    await sendMediaStream(`/api/instances/${encodeURIComponent(instId)}/account/chat-photo`, file, {
      chatId, fileName: file.name, mimeType: file.type,
    }, (phase, progress) => {
      if (!current() || !status) return;
      status.textContent = phase === 'upload' ? `上传头像 ${progress}%…` : 'Telegram 正在处理头像…';
    });
    if (!current()) return;
    profile.hasPhoto = true;
    if (state.clientActiveDialog) state.clientActiveDialog.hasPhoto = true;
    const version = Date.now();
    const hero = document.getElementById('profile-hero-img');
    if (hero) { hero.src = `/api/instances/${encodeURIComponent(instId)}/account/avatar?chatId=${chatId}&isBig=1&v=${version}`; hero.style.display = 'block'; }
    const header = document.getElementById('client-chat-avatar-img');
    if (header) {
      const url = `/api/instances/${encodeURIComponent(instId)}/account/avatar?chatId=${chatId}&v=${version}`;
      if (typeof scheduler?.loadImage === 'function') void scheduler.loadImage(header, url);
      else header.src = url;
    }
    if (status) status.textContent = '群组头像已更新。';
    void loadUserPhotos(chatId);
  } catch (error) {
    if (current() && status) status.textContent = `更换群组头像失败：${error.message}`;
  } finally {
    if (input) input.value = '';
  }
}

function isCurrentGroupInfoTarget(target = groupInfoTarget) {
  return Boolean(target && target === groupInfoTarget && state.clientSelectedInstance === target.instId &&
    String(state.clientActiveChatId) === String(target.chatId) && state.chatSelectionVersion === target.selectionVersion &&
    String(state.currentProfileChatId) === String(target.chatId) && state.currentPeerProfile === target.profile);
}

function openGroupInfoModal() {
  const profile = state.currentPeerProfile;
  const dialog = state.clientActiveDialog;
  if (!profile || !dialog || String(dialog.id) !== String(state.clientActiveChatId) ||
      !['group', 'supergroup', 'channel'].includes(profile.type)) {
    return showToast('请先打开当前群组或频道资料', 'warn');
  }
  const modal = document.getElementById('modal-group-info');
  if (!modal) return showToast('群组资料编辑窗口不可用', 'error');
  groupInfoTarget = {
    instId: state.clientSelectedInstance, chatId: Number(state.clientActiveChatId),
    selectionVersion: state.chatSelectionVersion, profile,
  };
  const title = document.getElementById('group-info-title');
  const username = document.getElementById('group-info-username');
  const usernameRow = document.getElementById('group-info-username-row');
  const description = document.getElementById('group-info-description');
  const status = document.getElementById('group-info-status');
  if (title) title.value = profile.title || dialog.title || '';
  if (username) { username.value = profile.username || ''; username.disabled = !['supergroup', 'channel'].includes(dialog.type); }
  if (usernameRow) usernameRow.hidden = !['supergroup', 'channel'].includes(dialog.type);
  if (description) description.value = profile.bio || '';
  if (status) status.textContent = '保存时只提交发生变化的字段。';
  modal.style.display = 'flex';
}

function closeGroupInfoModal() {
  groupInfoTarget = null;
  const modal = document.getElementById('modal-group-info');
  if (modal) modal.style.display = 'none';
}

async function saveGroupInfo(event) {
  event.preventDefault();
  const target = groupInfoTarget;
  if (!isCurrentGroupInfoTarget(target)) {
    closeGroupInfoModal();
    return showToast('会话已切换，请重新打开群组资料', 'warn');
  }
  const titleInput = document.getElementById('group-info-title');
  const usernameInput = document.getElementById('group-info-username');
  const descriptionInput = document.getElementById('group-info-description');
  const status = document.getElementById('group-info-status');
  const save = document.getElementById('btn-save-group-info');
  const title = titleInput?.value.trim() || '';
  const canEditUsername = ['supergroup', 'channel'].includes(state.clientActiveDialog?.type);
  const username = canEditUsername ? (usernameInput?.value.trim() || '') : (target.profile.username || '');
  const description = descriptionInput?.value ?? '';
  const oldTitle = target.profile.title || '';
  const oldUsername = target.profile.username || '';
  const oldDescription = target.profile.bio || '';
  if (!title || title.length > 128 || /[\u0000-\u001f]/.test(title) ||
      (canEditUsername && username !== '' && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) ||
      description.length > 255 || description.includes('\u0000')) {
    if (status) status.textContent = '名称不能为空且最多 128 个字符；公开用户名须为 5 至 32 位字母、数字或下划线，并以字母开头；简介最多 255 个字符。';
    return;
  }
  const changeTitle = title !== oldTitle;
  const changeUsername = canEditUsername && username !== oldUsername;
  const changeDescription = description !== oldDescription;
  if (!changeTitle && !changeUsername && !changeDescription) {
    closeGroupInfoModal();
    return;
  }
  if (changeDescription && !description && oldDescription && !confirm('清空简介会删除当前群组说明，继续吗？')) return;
  if (changeUsername && oldUsername && !confirm(username ? `更改公开用户名 @${oldUsername} 后，旧链接将失效。继续吗？` : `移除公开用户名 @${oldUsername} 会使旧链接失效，继续吗？`)) return;
  if (!isCurrentGroupInfoTarget(target)) return;
  if (save) save.disabled = true;
  if (status) status.textContent = '正在保存群组资料…';
  const call = async (action, route, payload) => {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc(action, { instId: target.instId, chatId: target.chatId, ...payload });
    } else {
      await api(`/api/instances/${encodeURIComponent(target.instId)}/account/${route}`, 'POST', { chatId: target.chatId, ...payload });
    }
  };
  try {
    if (changeTitle) {
      await call('set_chat_title', 'chat-title', { title });
      if (!isCurrentGroupInfoTarget(target)) return;
      target.profile.title = title;
      if (state.clientActiveDialog) state.clientActiveDialog.title = title;
      const dialog = state.clientDialogs.find(item => String(item.id) === String(target.chatId));
      if (dialog) dialog.title = title;
      const displayName = document.getElementById('profile-display-name');
      const chatTitle = document.getElementById('client-chat-title');
      if (displayName) displayName.textContent = title;
      if (chatTitle) chatTitle.textContent = title;
      renderClientDialogs();
    }
    if (changeDescription) {
      await call('set_chat_description', 'chat-description', { description });
      if (!isCurrentGroupInfoTarget(target)) return;
      target.profile.bio = description;
      const bio = document.getElementById('profile-val-bio');
      if (bio) bio.textContent = description || '暂无简介说明';
    }
    if (changeUsername) {
      await call('set_chat_username', 'chat-username', { username });
      if (!isCurrentGroupInfoTarget(target)) return;
      target.profile.username = username || undefined;
      if (state.clientActiveDialog) state.clientActiveDialog.username = username || undefined;
      const dialog = state.clientDialogs.find(item => String(item.id) === String(target.chatId));
      if (dialog) dialog.username = username || undefined;
      const usernameLabel = document.getElementById('profile-username');
      if (usernameLabel) usernameLabel.textContent = username ? `@${username}` : '@未设置用户名';
      const subtitle = document.getElementById('client-chat-subtitle');
      if (subtitle) {
        const oldTag = oldUsername ? ` | @${oldUsername}` : '';
        subtitle.textContent = `${subtitle.textContent.replace(oldTag, '')}${username ? ` | @${username}` : ''}`;
      }
      renderClientDialogs();
    }
    if (!isCurrentGroupInfoTarget(target)) return;
    closeGroupInfoModal();
    showToast('群组资料已更新', 'success');
  } catch (error) {
    if (isCurrentGroupInfoTarget(target) && status) status.textContent = `保存失败：${error.message}`;
  } finally {
    if (save && isCurrentGroupInfoTarget(target)) save.disabled = false;
  }
}

const CHAT_DEFAULT_RIGHT_KEYS = [
  'viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
  'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline', 'embedLinks',
  'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics',
];
let chatPermissionsTarget = null;

function isCurrentChatPermissionsTarget(target = chatPermissionsTarget) {
  return Boolean(target && target === chatPermissionsTarget && state.clientSelectedInstance === target.instId &&
    String(state.clientActiveChatId) === String(target.chatId) && state.chatSelectionVersion === target.selectionVersion &&
    String(state.currentProfileChatId) === String(target.chatId) && state.currentPeerProfile === target.profile);
}

function openChatPermissionsModal() {
  const profile = state.currentPeerProfile;
  const dialog = state.clientActiveDialog;
  if (!profile || !profile.defaultBannedRights || !dialog || String(dialog.id) !== String(state.clientActiveChatId)) {
    return showToast('Telegram 尚未返回当前群组的完整默认权限', 'warn');
  }
  const modal = document.getElementById('modal-chat-permissions');
  if (!modal) return showToast('群组权限窗口不可用', 'error');
  chatPermissionsTarget = { instId: state.clientSelectedInstance, chatId: Number(state.clientActiveChatId), selectionVersion: state.chatSelectionVersion, profile };
  const rights = profile.defaultBannedRights;
  document.querySelectorAll('[data-chat-right]').forEach(input => { input.checked = Boolean(rights[input.dataset.chatRight]); });
  const supergroupSettings = document.getElementById('supergroup-advanced-settings');
  const canEditSupergroupSettings = dialog.type === 'supergroup';
  if (supergroupSettings) supergroupSettings.hidden = !canEditSupergroupSettings;
  document.querySelectorAll('[data-supergroup-setting]').forEach(input => {
    const setting = input.dataset.supergroupSetting;
    input.checked = Boolean(profile[setting]);
    input.disabled = !canEditSupergroupSettings || typeof profile[setting] !== 'boolean';
  });
  const slowModeRow = document.getElementById('chat-slow-mode-row');
  const slowModeSelect = document.getElementById('chat-slow-mode');
  const slowMode = Number(profile.slowmodeSeconds) || 0;
  const canEditSlowMode = dialog.type === 'supergroup';
  if (slowModeRow) slowModeRow.hidden = !canEditSlowMode;
  if (slowModeSelect) {
    slowModeSelect.querySelectorAll('option[data-telegram-custom]')?.forEach(option => option.remove());
    if (canEditSlowMode && ![0, 10, 30, 60, 300, 900, 3600].includes(slowMode)) {
      const custom = document.createElement('option'); custom.value = String(slowMode); custom.textContent = `当前设置（${slowMode} 秒）`;
      custom.dataset.telegramCustom = 'true'; slowModeSelect.appendChild(custom);
    }
    slowModeSelect.value = String(slowMode);
  }
  const status = document.getElementById('chat-permissions-status');
  if (status) status.textContent = '勾选项目表示禁止普通成员执行；Telegram 会校验当前账号的管理权限。';
  modal.style.display = 'flex';
}

function closeChatPermissionsModal() {
  chatPermissionsTarget = null;
  const modal = document.getElementById('modal-chat-permissions');
  if (modal) modal.style.display = 'none';
}

async function saveChatPermissions(event) {
  event.preventDefault();
  const target = chatPermissionsTarget;
  if (!isCurrentChatPermissionsTarget(target)) {
    closeChatPermissionsModal();
    return showToast('会话已切换，请重新打开群组权限', 'warn');
  }
  const rights = Object.fromEntries(CHAT_DEFAULT_RIGHT_KEYS.map(key => [key, false]));
  document.querySelectorAll('[data-chat-right]').forEach(input => { rights[input.dataset.chatRight] = Boolean(input.checked); });
  if (Object.keys(rights).length !== CHAT_DEFAULT_RIGHT_KEYS.length) return showToast('权限表单字段不完整，请刷新页面', 'error');
  const original = target.profile.defaultBannedRights;
  const rightsChanged = CHAT_DEFAULT_RIGHT_KEYS.some(key => Boolean(original[key]) !== rights[key]);
  const slowModeSelect = document.getElementById('chat-slow-mode');
  const canEditSlowMode = state.clientActiveDialog?.type === 'supergroup';
  const oldSlowMode = Number(target.profile.slowmodeSeconds) || 0;
  const slowMode = Number(slowModeSelect?.value || 0);
  const slowModeChanged = canEditSlowMode && slowMode !== oldSlowMode;
  const settingChanges = [];
  if (canEditSlowMode) document.querySelectorAll('[data-supergroup-setting]').forEach(input => {
    const setting = input.dataset.supergroupSetting;
    if (!input.disabled && typeof target.profile[setting] === 'boolean' && Boolean(target.profile[setting]) !== Boolean(input.checked)) {
      settingChanges.push({ setting, enabled: Boolean(input.checked) });
    }
  });
  if (!rightsChanged && !slowModeChanged && !settingChanges.length) return closeChatPermissionsModal();
  const save = document.getElementById('btn-save-chat-permissions');
  const status = document.getElementById('chat-permissions-status');
  if (save) save.disabled = true;
  if (status) status.textContent = '正在保存群组权限…';
  try {
    if (rightsChanged) {
      if (window.chatWs && window.chatWs.isConnected()) {
        await window.chatWs.sendRpc('set_chat_permissions', { instId: target.instId, chatId: target.chatId, rights });
      } else {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/chat-permissions`, 'POST', { chatId: target.chatId, rights });
      }
      if (!isCurrentChatPermissionsTarget(target)) return;
      target.profile.defaultBannedRights = rights;
    }
    for (const change of settingChanges) {
      if (window.chatWs && window.chatWs.isConnected()) {
        await window.chatWs.sendRpc('set_supergroup_setting', { instId: target.instId, chatId: target.chatId, ...change });
      } else {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/supergroup-setting`, 'POST', { chatId: target.chatId, ...change });
      }
      if (!isCurrentChatPermissionsTarget(target)) return;
      target.profile[change.setting] = change.enabled;
    }
    if (slowModeChanged) {
      if (!Number.isSafeInteger(slowMode) || ![0, 10, 30, 60, 300, 900, 3600].includes(slowMode)) {
        throw new Error('请选择 Telegram 支持的慢速模式时长');
      }
      if (window.chatWs && window.chatWs.isConnected()) {
        await window.chatWs.sendRpc('set_chat_slow_mode', { instId: target.instId, chatId: target.chatId, seconds: slowMode });
      } else {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/chat-slow-mode`, 'POST', { chatId: target.chatId, seconds: slowMode });
      }
      if (!isCurrentChatPermissionsTarget(target)) return;
      target.profile.slowmodeSeconds = slowMode;
    }
    if (!isCurrentChatPermissionsTarget(target)) return;
    closeChatPermissionsModal();
    showToast('群组默认权限已更新', 'success');
  } catch (error) {
    if (isCurrentChatPermissionsTarget(target) && status) status.textContent = `保存权限失败：${error.message}`;
  } finally {
    if (save && isCurrentChatPermissionsTarget(target)) save.disabled = false;
  }
}

let groupAdminRightsTarget = null;

function manageGroupAdmin(userId, name) {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const member = state.groupMembers.find((item) => String(item.user?.id) === String(userId));
  if (!member || member.role === 'owner') return showToast('无法修改该成员的管理员身份', 'warn');
  if (!canManageGroupMemberTarget(member, 'admin')) return showToast('当前账号没有管理管理员的权限', 'warn');
  if (!member.supportsCustomAdminRights) {
    return member.role === 'admin' ? demoteGroupAdmin(userId, name) : promoteBasicGroupAdmin(userId, name);
  }
  groupAdminRightsTarget = { context, userId: Number(userId), name, wasAdmin: member.role === 'admin' };
  const modal = document.getElementById('modal-admin-rights');
  const form = document.getElementById('form-admin-rights');
  if (!modal || !form) return showToast('管理员权限表单不可用', 'error');
  form.reset();
  const rights = member.adminPermissions || {};
  document.querySelectorAll('[data-admin-perm]').forEach((input) => {
    input.checked = Boolean(rights[input.dataset.adminPerm]);
  });
  const title = modal.querySelector('.modal-title');
  if (title) title.textContent = member.role === 'admin' ? '编辑管理员权限' : '设置管理员权限';
  const target = document.getElementById('admin-rights-target');
  if (target) target.textContent = `${name} · 选择此管理员可执行的操作。Telegram 会校验当前账号是否有权执行。`;
  const save = document.getElementById('btn-save-admin-rights');
  if (save) save.textContent = member.role === 'admin' ? '保存权限' : '设为管理员';
  const demote = document.getElementById('btn-demote-admin-rights');
  if (demote) demote.hidden = member.role !== 'admin';
  modal.style.display = 'flex';
}

function closeGroupAdminRights() {
  const modal = document.getElementById('modal-admin-rights');
  const form = document.getElementById('form-admin-rights');
  if (modal) modal.style.display = 'none';
  form?.reset();
  groupAdminRightsTarget = null;
  const save = document.getElementById('btn-save-admin-rights');
  if (save) save.disabled = false;
}

async function saveGroupAdminRights(event) {
  event.preventDefault();
  const target = groupAdminRightsTarget;
  if (!target || !isCurrentGroupMembersContext(target.context)) {
    closeGroupAdminRights();
    return showToast('群组已切换，请重新加载成员后再操作', 'warn');
  }
  const perms = {};
  document.querySelectorAll('[data-admin-perm]').forEach((input) => { perms[input.dataset.adminPerm] = input.checked; });
  if (!Object.values(perms).some(Boolean)) return showToast('至少选择一项管理员权限；撤销管理员请使用单独的撤销操作', 'warn');
  const save = document.getElementById('btn-save-admin-rights');
  if (save) save.disabled = true;
  try {
    const { instId, chatId } = target.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('promote_user', { instId, chatId, userId: target.userId, perms });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/promote`, 'POST', { chatId, userId: target.userId, perms });
    }
    closeGroupAdminRights();
    showToast(target.wasAdmin ? `已更新 ${target.name} 的管理员权限` : `已将 ${target.name} 设为管理员`, 'success');
    if (isCurrentGroupMembersContext(target.context)) await loadGroupMembers(chatId);
  } catch (err) {
    if (save) save.disabled = false;
    showToast(`设置管理员失败: ${err.message}`, 'error');
  }
}

async function demoteGroupAdmin(userId, name) {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const member = state.groupMembers.find(item => String(item.user?.id) === String(userId));
  if (!member || !canManageGroupMemberTarget(member, 'admin')) return showToast('当前账号没有管理管理员的权限', 'warn');
  if (!confirm(`确定撤销【${name}】的管理员身份吗？`)) return;
  if (!isCurrentGroupMembersContext(context)) return;
  const { instId, chatId } = context;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('demote_user', { instId, chatId, userId: Number(userId) });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/demote`, 'POST', { chatId, userId: Number(userId) });
    }
    showToast(`已撤销 ${name} 的管理员身份`, 'success');
    if (isCurrentGroupMembersContext(context)) await loadGroupMembers(chatId);
  } catch (err) {
    showToast(`撤销管理员失败: ${err.message}`, 'error');
  }
}

async function promoteBasicGroupAdmin(userId, name) {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const member = state.groupMembers.find(item => String(item.user?.id) === String(userId));
  if (!member || !canManageGroupMemberTarget(member, 'admin')) return showToast('当前账号没有管理管理员的权限', 'warn');
  if (!confirm(`确定将【${name}】设为群管理员吗？`)) return;
  if (!isCurrentGroupMembersContext(context)) return;
  const { instId, chatId } = context;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('promote_user', { instId, chatId, userId: Number(userId) });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/promote`, 'POST', { chatId, userId: Number(userId) });
    }
    showToast(`已将 ${name} 设为管理员`, 'success');
    if (isCurrentGroupMembersContext(context)) await loadGroupMembers(chatId);
  } catch (err) {
    showToast(`设置管理员失败: ${err.message}`, 'error');
  }
}

async function revokeGroupAdminRights() {
  const target = groupAdminRightsTarget;
  if (!target || !isCurrentGroupMembersContext(target.context)) {
    closeGroupAdminRights();
    return showToast('群组已切换，请重新加载成员后再操作', 'warn');
  }
  if (!target.wasAdmin) return;
  if (!confirm(`确定撤销【${target.name}】的管理员身份吗？`)) return;
  const button = document.getElementById('btn-demote-admin-rights');
  if (button) button.disabled = true;
  try {
    const { instId, chatId } = target.context;
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('demote_user', { instId, chatId, userId: target.userId });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/demote`, 'POST', { chatId, userId: target.userId });
    }
    closeGroupAdminRights();
    showToast(`已撤销 ${target.name} 的管理员身份`, 'success');
    if (isCurrentGroupMembersContext(target.context)) await loadGroupMembers(chatId);
  } catch (err) {
    if (button) button.disabled = false;
    showToast(`撤销管理员失败: ${err.message}`, 'error');
  }
}

async function kickGroupMember(userId, name) {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const member = state.groupMembers.find(item => String(item.user?.id) === String(userId));
  if (!member || !canManageGroupMemberTarget(member, 'moderate')) return showToast('当前账号没有移除该成员的权限', 'warn');
  if (!confirm(`确定要将【${name}】移出当前群聊吗？`)) return;
  if (!isCurrentGroupMembersContext(context)) return;
  const { instId, chatId } = context;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('kick_user', { instId, chatId, userId });
    } else {
      await api(`/api/instances/${instId}/account/kick`, 'POST', { chatId, userId });
    }
    showToast(`已将 ${name} 移出群聊`, 'success');
    if (isCurrentGroupMembersContext(context)) loadGroupMembers(chatId);
  } catch (err) {
    showToast(`移出失败: ${err.message}`, 'error');
  }
}

function openGroupMuteModal(userId, name, action = 'mute') {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const member = state.groupMembers.find(item => String(item.user?.id) === String(userId));
  if (!member || member.role === 'owner') return showToast('无法管理该成员', 'warn');
  if (!canManageGroupMemberTarget(member, 'moderate')) return showToast('当前账号没有限制该成员的权限', 'warn');
  if (!member.supportsCustomAdminRights) return showToast('Telegram 仅允许在超级群或频道中管理单个成员限制', 'warn');
  const modal = document.getElementById('modal-group-member-mute');
  if (!modal) return showToast('成员限制窗口不可用', 'error');
  groupMuteTarget = { context, userId: Number(userId), name: String(name || member.user?.firstName || '成员'), action };
  const title = document.getElementById('group-member-mute-title');
  if (title) title.textContent = action === 'ban' ? '封禁群成员' : '限制成员发言';
  const target = document.getElementById('group-member-mute-target');
  if (target) target.textContent = action === 'ban'
    ? `封禁「${groupMuteTarget.name}」后，此成员将无法重新加入；Telegram 会再次校验权限。`
    : `设置对「${groupMuteTarget.name}」的发言限制；Telegram 会再次校验权限。`;
  const saveButton = document.getElementById('btn-save-group-member-mute');
  if (saveButton) saveButton.textContent = action === 'ban' ? '确认封禁' : '限制发言';
  const duration = document.getElementById('group-member-mute-duration');
  if (duration) duration.value = action === 'ban' ? '86400' : '3600';
  const status = document.getElementById('group-member-mute-status');
  if (status) status.textContent = '';
  modal.style.display = 'flex';
}

function openGroupBanModal(userId, name) {
  return openGroupMuteModal(userId, name, 'ban');
}

function closeGroupMuteModal() {
  groupMuteTarget = null;
  const modal = document.getElementById('modal-group-member-mute');
  if (modal) modal.style.display = 'none';
}

async function saveGroupMute(event) {
  event.preventDefault();
  const target = groupMuteTarget;
  if (!target || !isCurrentGroupMembersContext(target.context)) {
    closeGroupMuteModal();
    return showToast('会话已切换，请重新打开成员禁言设置', 'warn');
  }
  const seconds = Number(document.getElementById('group-member-mute-duration')?.value);
  if (![0, 3600, 28800, 86400, 604800, 2592000, 31536000].includes(seconds)) {
    const status = document.getElementById('group-member-mute-status');
    if (status) status.textContent = '请选择 Telegram 支持的限制时长。';
    return;
  }
  const button = document.getElementById('btn-save-group-member-mute');
  const status = document.getElementById('group-member-mute-status');
  if (button) button.disabled = true;
  if (status) status.textContent = '正在更新成员限制…';
  const succeeded = target.action === 'ban'
    ? await banGroupMember(target.userId, target.name, seconds)
    : await muteGroupMember(target.userId, target.name, seconds);
  if (succeeded && groupMuteTarget === target) {
    closeGroupMuteModal();
    if (target.action === 'ban' && isCurrentGroupMembersContext(target.context)) await loadGroupMembers(target.context.chatId);
  }
  else if (groupMuteTarget === target) {
    if (button) button.disabled = false;
    if (status) status.textContent = '限制未完成，请确认当前账号权限后重试。';
  }
}

async function muteGroupMember(userId, name, seconds) {
  if (seconds === undefined) return openGroupMuteModal(userId, name);
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31536000) return showToast('禁言时长无效', 'warn');
  const { instId, chatId } = context;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('mute_user', { instId, chatId, userId, seconds });
    } else {
      await api(`/api/instances/${instId}/account/mute`, 'POST', { chatId, userId, seconds });
    }
    const duration = new Map([[0, '永久'], [3600, '1 小时'], [28800, '8 小时'], [86400, '1 天'], [604800, '1 周'], [2592000, '30 天'], [31536000, '1 年']]).get(seconds) || `${seconds} 秒`;
    showToast(`已将 ${name} 限制发言 ${duration}`, 'success');
    return true;
  } catch (err) {
    showToast(`禁言失败: ${err.message}`, 'error');
    return false;
  }
}

async function banGroupMember(userId, name, seconds) {
  const context = groupMembersContext;
  if (!isCurrentGroupMembersContext(context)) return showToast('群成员列表已过期，请重新加载', 'warn');
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31536000) return showToast('封禁时长无效', 'warn');
  if (!confirm(`确认封禁「${name}」${seconds === 0 ? '，直到管理员解除' : `，时长 ${Math.round(seconds / 86400)} 天`}？`)) return false;
  if (!isCurrentGroupMembersContext(context)) return false;
  const { instId, chatId } = context;
  const untilDate = seconds ? Math.floor(Date.now() / 1000) + seconds : 0;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('ban_user', { instId, chatId, userId, untilDate });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/ban`, 'POST', { chatId, userId, untilDate });
    }
    if (!isCurrentGroupMembersContext(context)) return false;
    showToast(`已封禁 ${name}`, 'success');
    return true;
  } catch (error) {
    showToast(`封禁失败：${error.message}`, 'error');
    return false;
  }
}

function startDirectChat(userId, name) {
  if (!isCurrentGroupMembersContext(groupMembersContext)) return showToast('群成员列表已过期，请重新加载', 'warn');
  const existing = state.clientDialogs.find((d) => String(d.id) === String(userId));
  selectClientChat(existing || { id: Number(userId), title: name, type: 'private' });
}

// ==========================================
// Jump to Date Calendar Controller
// ==========================================
function initJumpToDate() {
  const btnToggle = document.getElementById('btn-chat-search-calendar');
  const modal = document.getElementById('modal-jump-date');
  const btnClose = document.getElementById('btn-jump-date-close');
  const btnCancel = document.getElementById('btn-jump-date-cancel');
  const btnConfirm = document.getElementById('btn-jump-date-confirm');
  const dateInput = document.getElementById('jump-date-input');

  if (!btnToggle || !modal) return;

  const localDateValue = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const openModal = () => {
    if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
    modal.style.display = 'flex';
    if (dateInput) {
      dateInput.value = localDateValue(new Date());
    }
  };

  const closeModal = () => {
    modal.style.display = 'none';
  };

  btnToggle.onclick = openModal;
  btnClose.onclick = closeModal;
  btnCancel.onclick = closeModal;

  document.querySelectorAll('.jump-date-presets .preset-pill').forEach((pill) => {
    pill.onclick = () => {
      const days = parseInt(pill.dataset.days, 10);
      if (!isNaN(days) && dateInput) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        dateInput.value = localDateValue(d);
      }
    };
  });

  btnConfirm.onclick = async () => {
    if (!dateInput || !dateInput.value) return showToast('请选择目标日期', 'warn');
    const [year, month, day] = dateInput.value.split('-').map(Number);
    // Telegram's offsetDate is exclusive; local midnight on the next day
    // includes all messages from the selected day, including 23:59:59.
    const offsetDate = Math.floor(new Date(year, month - 1, day + 1).getTime() / 1000);
    closeModal();
    showToast(`正在跳转至 ${dateInput.value} 历史消息...`, 'info');
    await loadClientMessagesWithDate(state.clientActiveChatId, offsetDate);
  };
}

async function loadClientMessagesAround(chatId, messageId, historyDate, silent = false) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId || !messageId) return false;
  const request = ++clientMessagesRequest;
  const ws = window.chatWs;
  const snapshot = ws ? ws.beginMessageSnapshot(instId, chatId) : null;
  isLoadingEarlierMessages = false;
  try {
    const params = new URLSearchParams({ chatId: String(chatId), messageId: String(messageId) });
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/message-context?${params}`);
    if (!isCurrentMessagesRequest(request, instId, chatId)) return false;
    let messages = Array.isArray(result) ? [...result].reverse() : [];
    messages = await completeLeadingAlbumMessages(messages, instId, chatId, request);
    if (!isCurrentMessagesRequest(request, instId, chatId)) return false;
    if (!messages.some((message) => String(message.id) === String(messageId))) {
      if (!silent) showToast('该消息不可用或已被删除', 'info');
      return false;
    }
    state.clientHistoryOffsetDate = historyDate || Math.floor(Date.now() / 1000);
    state.clientHistoryAnchorId = messageId;
    updateClientHistoryBanner();
    state.clientMessages = snapshot ? ws.finishMessageSnapshot(snapshot, messages, false) : messages;
    hasReachedEarliestMessage = false;
    renderClientMessages(true);
    if (!silent) scrollToMessage(messageId);
    return true;
  } catch (err) {
    if (isCurrentMessagesRequest(request, instId, chatId) && !silent) showToast(`定位消息失败: ${err.message}`, 'error');
    return false;
  } finally {
    if (snapshot) ws.finishMessageSnapshot(snapshot);
  }
}
window.loadClientMessagesAround = loadClientMessagesAround;

async function loadClientMessagesWithDate(chatId, offsetDate, silent = false) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId) return;
  const request = ++clientMessagesRequest;
  const ws = window.chatWs;
  const snapshot = ws ? ws.beginMessageSnapshot(instId, chatId) : null;
  isLoadingEarlierMessages = false;
  document.getElementById('chat-top-loader')?.remove();

  try {
    let msgs;
    if (ws && ws.isConnected()) {
      try {
        msgs = await ws.sendRpc('get_messages', { instId, chatId, limit: 40, offsetDate });
      } catch (_) { /* Fall back to HTTP if the RPC connection dropped. */ }
    }
    if (!msgs) msgs = await api(`/api/instances/${encodeURIComponent(instId)}/account/messages?chatId=${encodeURIComponent(chatId)}&limit=40&offsetDate=${encodeURIComponent(offsetDate)}`);

    if (!isCurrentMessagesRequest(request, instId, chatId)) return;
    let messages = Array.isArray(msgs) ? [...msgs].reverse() : [];
    messages = await completeLeadingAlbumMessages(messages, instId, chatId, request);
    if (!isCurrentMessagesRequest(request, instId, chatId)) return;
    state.clientHistoryOffsetDate = offsetDate;
    state.clientHistoryAnchorId = null;
    updateClientHistoryBanner();
    state.clientMessages = snapshot ? ws.finishMessageSnapshot(snapshot, messages, false) : messages;
    hasReachedEarliestMessage = false;
    renderClientMessages(silent);
    if (!silent) showToast(messages.length ? '已定位到指定日期的历史消息' : '该日期之前没有找到历史消息', messages.length ? 'success' : 'info');
  } catch (err) {
    if (isCurrentMessagesRequest(request, instId, chatId)) showToast(`日期跳转失败: ${err.message}`, 'error');
  } finally {
    if (snapshot) ws.finishMessageSnapshot(snapshot);
  }
}

// ==========================================
// Scheduled Messages Controller
// ==========================================
function initScheduleMessage() {
  const btnToggle = document.getElementById('btn-chat-schedule');
  const modal = document.getElementById('modal-schedule-message');
  const btnClose = document.getElementById('btn-schedule-close');
  const btnCancel = document.getElementById('btn-schedule-cancel');
  const btnConfirm = document.getElementById('btn-schedule-confirm');
  const dtInput = document.getElementById('schedule-datetime-input');
  const repeatInput = document.getElementById('schedule-repeat-period');

  if (!btnToggle || !modal) return;

  const openModal = () => {
    const textInput = document.getElementById('client-message-textarea');
    if (!textInput?.value.trim() && !state.clientStagedFile) {
      return showToast('请先在输入框中输入消息内容或选择附件', 'warn');
    }
    modal.style.display = 'flex';
    if (repeatInput) repeatInput.value = '0';
    if (dtInput) {
      const d = new Date(Date.now() + 3600000);
      const pad = (n) => String(n).padStart(2, '0');
      dtInput.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  };

  const closeModal = () => {
    modal.style.display = 'none';
  };

  btnToggle.onclick = openModal;
  btnClose.onclick = closeModal;
  btnCancel.onclick = closeModal;

  document.querySelectorAll('.schedule-preset-btn').forEach((btn) => {
    btn.onclick = () => {
      const minutes = parseInt(btn.dataset.minutes, 10);
      const preset = btn.dataset.preset;
      const now = new Date();
      if (!isNaN(minutes)) {
        now.setMinutes(now.getMinutes() + minutes);
      } else if (preset === 'tonight') {
        now.setHours(21, 0, 0, 0);
        if (now.getTime() <= Date.now()) now.setDate(now.getDate() + 1);
      } else if (preset === 'tomorrow') {
        now.setDate(now.getDate() + 1);
        now.setHours(9, 0, 0, 0);
      }
      const pad = (n) => String(n).padStart(2, '0');
      if (dtInput) {
        dtInput.value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      }
    };
  });

  btnConfirm.onclick = () => {
    if (!dtInput || !dtInput.value) return showToast('请指定发送时间', 'warn');
    const targetTime = new Date(dtInput.value).getTime();
    if (isNaN(targetTime) || targetTime <= Date.now()) {
      return showToast('设定时间必须晚于当前时间', 'warn');
    }
    const unixSec = Math.floor(targetTime / 1000);
    const repeatPeriod = Number(repeatInput?.value || 0) || null;
    const stagedFiles = Array.isArray(state.clientStagedFiles) ? state.clientStagedFiles : [];
    if (repeatPeriod && stagedFiles.length > 1) return showToast('Telegram 暂不支持重复定时发送相册', 'warn');
    if (repeatPeriod && state.clientPaidMediaStars != null) return showToast('付费媒体暂不支持重复定时发送', 'warn');
    closeModal();
    sendClientMessage(unixSec, repeatPeriod);
  };
}

// Cinema-Grade Video Lightbox Player Controller
const cinemaVideoPlayer = {
  isOpen: false,
  isSeeking: false,
  isVolDragging: false,
  idleTimer: null,
  lastVolume: 1.0,
  currentSpeed: 1.0,
  clickTimeout: null,

  get video() { return document.getElementById('video-cinema-element'); },
  get modal() { return document.getElementById('modal-video-player'); },
  get dock() { return document.getElementById('video-cinema-dock'); },

  open(src, senderName = '视频播放', timeStr = '', durStr = '') {
    const video = this.video;
    const modal = this.modal;
    if (!video || !modal) return;

    this.isOpen = true;
    modal.style.display = 'flex';
    void modal.offsetWidth;
    modal.classList.add('active');

    const senderEl = document.getElementById('video-cinema-sender');
    if (senderEl) senderEl.innerText = senderName || '视频播放';
    const timeEl = document.getElementById('video-cinema-time');
    if (timeEl) timeEl.innerText = timeStr || '';
    const totEl = document.getElementById('video-total-time');
    if (totEl && durStr) totEl.innerText = durStr;

    const downloadBtn = document.getElementById('btn-video-download');
    if (downloadBtn) {
      downloadBtn.href = src + (src.includes('?') ? '&download=1' : '?download=1');
      downloadBtn.download = `video_${Date.now()}.mp4`;
    }

    if (video.src !== src) {
      video.src = src;
      video.load();
    }
    video.currentTime = 0;
    this.updateTimeline(0, 0);
    this.setSpeed(1.0);
    this.resetIdleTimer();

    video.play().catch(() => {
      this.updatePlayPauseBtn(false);
    });
  },

  close() {
    const video = this.video;
    const modal = this.modal;
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    if (video) {
      video.pause();
      video.src = '';
    }
    if (modal) {
      modal.classList.remove('active');
      modal.classList.remove('controls-hidden');
      setTimeout(() => {
        if (!this.isOpen) modal.style.display = 'none';
      }, 280);
    }
  },

  togglePlay() {
    const video = this.video;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      this.flashCenterIndicator('play');
    } else {
      video.pause();
      this.flashCenterIndicator('pause');
    }
  },

  seekRelative(sec) {
    const video = this.video;
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
    if (sec > 0) {
      this.flashRipple('right');
    } else {
      this.flashRipple('left');
    }
    this.resetIdleTimer();
  },

  setVolume(vol) {
    const video = this.video;
    if (!video) return;
    vol = Math.max(0, Math.min(1, vol));
    video.volume = vol;
    video.muted = vol === 0;
    this.updateVolumeUI(vol);
  },

  toggleMute() {
    const video = this.video;
    if (!video) return;
    if (video.volume > 0 && !video.muted) {
      this.lastVolume = video.volume;
      this.setVolume(0);
    } else {
      this.setVolume(this.lastVolume > 0 ? this.lastVolume : 1.0);
    }
  },

  updateVolumeUI(vol) {
    const fill = document.getElementById('video-vol-fill');
    const thumb = document.getElementById('video-vol-thumb');
    const icon = document.getElementById('video-vol-icon');
    const pct = Math.round(vol * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (thumb) thumb.style.left = `${pct}%`;
    if (icon) {
      const iconId = vol === 0 ? '#icon-volume-mute' : '#icon-volume';
      icon.innerHTML = `<use href="${iconId}"/>`;
    }
  },

  setSpeed(speed) {
    const video = this.video;
    if (!video) return;
    this.currentSpeed = speed;
    video.playbackRate = speed;
    const badge = document.getElementById('btn-video-speed');
    if (badge) badge.innerText = `${speed}x`;
    document.querySelectorAll('.video-speed-popover .speed-opt').forEach((opt) => {
      const s = parseFloat(opt.dataset.speed);
      opt.classList.toggle('active', s === speed);
    });
    document.getElementById('video-speed-popover')?.classList.remove('open');
  },

  togglePip() {
    const video = this.video;
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else if (document.pictureInPictureEnabled) {
      video.requestPictureInPicture().catch((err) => {
        showToast('画中画启动失败: ' + err.message, 'info');
      });
    } else {
      showToast('当前浏览器不支持画中画', 'info');
    }
  },

  toggleFullscreen() {
    const modal = this.modal;
    if (!modal) return;
    if (!document.fullscreenElement) {
      modal.requestFullscreen?.().catch(() => {
        modal.webkitRequestFullscreen?.();
      });
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  },

  flashCenterIndicator(type) {
    const indicator = document.getElementById('video-center-indicator');
    if (!indicator) return;
    const iconId = type === 'play' ? '#icon-play' : '#icon-pause';
    indicator.innerHTML = `<svg class="ui-icon-lg"><use href="${iconId}"/></svg>`;
    indicator.classList.remove('flash');
    void indicator.offsetWidth;
    indicator.classList.add('flash');
    setTimeout(() => indicator.classList.remove('flash'), 500);
  },

  flashRipple(side) {
    const ripple = document.getElementById(side === 'left' ? 'video-ripple-left' : 'video-ripple-right');
    if (!ripple) return;
    ripple.classList.remove('flash');
    void ripple.offsetWidth;
    ripple.classList.add('flash');
    setTimeout(() => ripple.classList.remove('flash'), 450);
  },

  updatePlayPauseBtn(isPlaying) {
    const btn = document.getElementById('btn-video-play-pause');
    if (!btn) return;
    const iconId = isPlaying ? '#icon-pause' : '#icon-play';
    btn.innerHTML = `<svg class="ui-icon"><use href="${iconId}"/></svg>`;
  },

  updateTimeline(cur, dur) {
    const curEl = document.getElementById('video-cur-time');
    const totEl = document.getElementById('video-total-time');
    const progressFill = document.getElementById('video-progress-fill');
    const thumb = document.getElementById('video-scrubber-thumb');

    if (curEl) curEl.innerText = formatDurationSec(cur);
    if (totEl && dur > 0) totEl.innerText = formatDurationSec(dur);

    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (thumb) thumb.style.left = `${pct}%`;
  },

  updateBuffered() {
    const video = this.video;
    const bufFill = document.getElementById('video-buffered-fill');
    if (!video || !bufFill || !video.duration) return;
    const buf = video.buffered;
    if (buf && buf.length > 0) {
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf.start(i) <= video.currentTime) {
          const end = buf.end(i);
          const pct = Math.min(100, (end / video.duration) * 100);
          bufFill.style.width = `${pct}%`;
          break;
        }
      }
    }
  },

  resetIdleTimer() {
    const modal = this.modal;
    if (!modal) return;
    modal.classList.remove('controls-hidden');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.isOpen && this.video && !this.video.paused) {
      this.idleTimer = setTimeout(() => {
        if (this.isOpen && this.video && !this.video.paused && !this.isSeeking && !this.isVolDragging) {
          modal.classList.add('controls-hidden');
        }
      }, 2500);
    }
  },

  init() {
    const video = this.video;
    const modal = this.modal;
    if (!video || !modal) return;

    // Video Lifecycle Events
    video.ontimeupdate = () => {
      if (!this.isSeeking) {
        this.updateTimeline(video.currentTime, video.duration || 0);
      }
      this.updateBuffered();
    };

    video.onprogress = () => {
      this.updateBuffered();
    };

    video.onloadedmetadata = () => {
      const totEl = document.getElementById('video-total-time');
      if (totEl) totEl.innerText = formatDurationSec(video.duration);
      this.updateBuffered();
    };

    video.onplay = () => {
      this.updatePlayPauseBtn(true);
      this.resetIdleTimer();
    };

    video.onpause = () => {
      this.updatePlayPauseBtn(false);
      this.resetIdleTimer();
    };

    video.onended = () => {
      this.updatePlayPauseBtn(false);
      modal.classList.remove('controls-hidden');
    };

    // Close & Top buttons
    document.getElementById('btn-video-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    document.getElementById('btn-video-pip')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePip();
    });

    // Control buttons
    document.getElementById('btn-video-play-pause')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlay();
    });

    document.getElementById('btn-video-rw')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.seekRelative(-10);
    });

    document.getElementById('btn-video-ff')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.seekRelative(10);
    });

    document.getElementById('btn-video-fullscreen')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFullscreen();
    });

    // Speed Popover Toggle
    const speedBadge = document.getElementById('btn-video-speed');
    const speedPopover = document.getElementById('video-speed-popover');
    if (speedBadge && speedPopover) {
      speedBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        speedPopover.classList.toggle('open');
      });
      document.querySelectorAll('.video-speed-popover .speed-opt').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const s = parseFloat(opt.dataset.speed);
          if (!isNaN(s)) this.setSpeed(s);
        });
      });
    }

    // Volume Slider & Mute
    document.getElementById('btn-video-volume')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });

    const volSliderWrap = document.getElementById('video-vol-slider-wrap');
    if (volSliderWrap) {
      const handleVolMove = (clientX) => {
        const rect = volSliderWrap.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        this.setVolume(ratio);
      };
      volSliderWrap.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.isVolDragging = true;
        volSliderWrap.setPointerCapture(e.pointerId);
        handleVolMove(e.clientX);
      });
      volSliderWrap.addEventListener('pointermove', (e) => {
        if (this.isVolDragging) handleVolMove(e.clientX);
      });
      const endVolDrag = (e) => {
        if (this.isVolDragging) {
          this.isVolDragging = false;
          try { volSliderWrap.releasePointerCapture(e.pointerId); } catch {}
        }
      };
      volSliderWrap.addEventListener('pointerup', endVolDrag);
      volSliderWrap.addEventListener('pointercancel', endVolDrag);
    }

    // High Precision Scrubber Timeline
    const timelineWrap = document.getElementById('video-timeline-wrap');
    const tooltip = document.getElementById('video-time-tooltip');
    if (timelineWrap) {
      const getTimelineRatio = (clientX) => {
        const rect = timelineWrap.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      };

      const handleTimelineHover = (e) => {
        if (!video.duration || !tooltip) return;
        const ratio = getTimelineRatio(e.clientX);
        const timeAtCursor = ratio * video.duration;
        tooltip.innerText = formatDurationSec(timeAtCursor);
        tooltip.style.left = `${ratio * 100}%`;
      };

      timelineWrap.addEventListener('mousemove', handleTimelineHover);

      timelineWrap.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.isSeeking = true;
        timelineWrap.classList.add('seeking');
        timelineWrap.setPointerCapture(e.pointerId);
        const ratio = getTimelineRatio(e.clientX);
        if (video.duration) {
          video.currentTime = ratio * video.duration;
          this.updateTimeline(video.currentTime, video.duration);
        }
      });

      timelineWrap.addEventListener('pointermove', (e) => {
        if (this.isSeeking && video.duration) {
          const ratio = getTimelineRatio(e.clientX);
          video.currentTime = ratio * video.duration;
          this.updateTimeline(video.currentTime, video.duration);
        }
      });

      const endSeek = (e) => {
        if (this.isSeeking) {
          this.isSeeking = false;
          timelineWrap.classList.remove('seeking');
          try { timelineWrap.releasePointerCapture(e.pointerId); } catch {}
        }
      };
      timelineWrap.addEventListener('pointerup', endSeek);
      timelineWrap.addEventListener('pointercancel', endSeek);
    }

    // Viewport Interactions (Click to play/pause, Double-click to fullscreen, Idle wake up)
    const viewport = document.getElementById('video-cinema-viewport');
    if (viewport) {
      viewport.addEventListener('click', (e) => {
        if (e.target !== viewport && e.target !== video) return;
        if (this.clickTimeout) {
          clearTimeout(this.clickTimeout);
          this.clickTimeout = null;
          this.toggleFullscreen();
        } else {
          this.clickTimeout = setTimeout(() => {
            this.clickTimeout = null;
            this.togglePlay();
          }, 240);
        }
      });
    }

    // Modal Mouse Move & Idle Timer
    modal.addEventListener('mousemove', () => {
      this.resetIdleTimer();
    });
    modal.addEventListener('click', (e) => {
      if (!e.target.closest('#video-speed-menu-wrap')) {
        document.getElementById('video-speed-popover')?.classList.remove('open');
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;

      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        this.seekRelative(-10);
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        this.seekRelative(10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setVolume((video.volume || 0) + 0.1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.setVolume((video.volume || 0) - 0.1);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        this.toggleMute();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        this.toggleFullscreen();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        this.togglePip();
      }
    });
  }
};

function openCinemaVideo(src, title, time, dur) {
  cinemaVideoPlayer.open(src, title, time, dur);
}

// Global Music Player Controller
const musicPlayer = {
  audio: new Audio(),
  currentTrack: null,
  isSeeking: false,
};

function initMusicPlayer() {
  const audio = musicPlayer.audio;

  audio.ontimeupdate = () => {
    if (musicPlayer.isSeeking) return;
    const curEl = document.getElementById('music-current-time');
    const seekEl = document.getElementById('music-seek-bar');
    if (curEl) curEl.innerText = formatDurationSec(audio.currentTime);
    if (seekEl && audio.duration) {
      seekEl.value = (audio.currentTime / audio.duration) * 100;
    }
  };

  audio.onloadedmetadata = () => {
    const durEl = document.getElementById('music-duration');
    if (durEl) durEl.innerText = formatDurationSec(audio.duration);
  };

  audio.onplay = () => {
    state.isPlaying = true;
    updatePlayPauseButton();
    document.getElementById('music-disc-icon')?.classList.add('playing');
  };

  audio.onpause = () => {
    state.isPlaying = false;
    updatePlayPauseButton();
    document.getElementById('music-disc-icon')?.classList.remove('playing');
  };

  audio.onended = () => {
    playNextTrack();
  };

  const seekEl = document.getElementById('music-seek-bar');
  if (seekEl) {
    seekEl.oninput = () => {
      musicPlayer.isSeeking = true;
      const curEl = document.getElementById('music-current-time');
      if (curEl && audio.duration) {
        curEl.innerText = formatDurationSec((seekEl.value / 100) * audio.duration);
      }
    };
    seekEl.onchange = () => {
      if (audio.duration) {
        audio.currentTime = (seekEl.value / 100) * audio.duration;
      }
      musicPlayer.isSeeking = false;
    };
  }

  const volEl = document.getElementById('music-volume-bar');
  if (volEl) {
    volEl.oninput = () => {
      audio.volume = volEl.value / 100;
    };
  }

  const btnPlayPause = document.getElementById('btn-music-play-pause');
  if (btnPlayPause) {
    btnPlayPause.onclick = () => toggleMusicPlay();
  }

  const btnPrev = document.getElementById('btn-music-prev');
  if (btnPrev) {
    btnPrev.onclick = () => playPrevTrack();
  }

  const btnNext = document.getElementById('btn-music-next');
  if (btnNext) {
    btnNext.onclick = () => playNextTrack();
  }

  const btnClose = document.getElementById('btn-music-close');
  if (btnClose) {
    btnClose.onclick = () => {
      audio.pause();
      document.getElementById('global-music-player').style.display = 'none';
      document.getElementById('music-playlist-drawer')?.classList.remove('open');
    };
  }

  const btnPlaylistToggle = document.getElementById('btn-music-playlist-toggle');
  if (btnPlaylistToggle) {
    btnPlaylistToggle.onclick = () => {
      document.getElementById('music-playlist-drawer')?.classList.toggle('open');
    };
  }

  const btnPlaylistClose = document.getElementById('btn-playlist-close');
  if (btnPlaylistClose) {
    btnPlaylistClose.onclick = () => {
      document.getElementById('music-playlist-drawer')?.classList.remove('open');
    };
  }

  const btnPlaylistImport = document.getElementById('btn-playlist-import-chat');
  if (btnPlaylistImport) {
    btnPlaylistImport.onclick = () => importChatMusicToPlaylist();
  }

  const playlistSearch = document.getElementById('playlist-search-input');
  if (playlistSearch) {
    playlistSearch.oninput = () => renderPlaylistDrawer();
  }
}

function updatePlayPauseButton() {
  const btn = document.getElementById('btn-music-play-pause');
  if (!btn) return;
  const iconId = state.isPlaying ? '#icon-pause' : '#icon-play';
  btn.innerHTML = `<svg class="ui-icon"><use href="${iconId}"/></svg>`;
}

function toggleMusicPlay() {
  if (!musicPlayer.audio.src) {
    if (state.playlist.length > 0) {
      playTrackByIndex(0);
    }
    return;
  }
  if (musicPlayer.audio.paused) {
    musicPlayer.audio.play();
  } else {
    musicPlayer.audio.pause();
  }
}

function playTrackDirect(title, artist, src, id) {
  let idx = state.playlist.findIndex((t) => t.src === src);
  if (idx === -1) {
    state.playlist.push({ title, artist, src, id });
    idx = state.playlist.length - 1;
    updatePlaylistBadge();
  }
  playTrackByIndex(idx);
}

function addTrackToPlaylist(title, artist, src, id) {
  const exists = state.playlist.some((t) => t.src === src);
  if (!exists) {
    state.playlist.push({ title, artist, src, id });
    updatePlaylistBadge();
    renderPlaylistDrawer();
    showToast(`已将《${title}》添加到歌单`, 'success');
  } else {
    showToast(`该曲目已在歌单中`, 'info');
  }
}

function playTrackByIndex(idx) {
  if (idx < 0 || idx >= state.playlist.length) return;
  state.currentTrackIndex = idx;
  const track = state.playlist[idx];
  musicPlayer.currentTrack = track;

  const playerDock = document.getElementById('global-music-player');
  if (playerDock) playerDock.style.display = 'flex';

  document.getElementById('music-title').innerText = track.title;
  document.getElementById('music-artist').innerText = track.artist;

  musicPlayer.audio.src = track.src;
  musicPlayer.audio.play().catch((err) => {
    showToast(`播放失败: ${err.message}`, 'error');
  });

  renderPlaylistDrawer();
}

function playNextTrack() {
  if (state.playlist.length === 0) return;
  let nextIdx = state.currentTrackIndex + 1;
  if (nextIdx >= state.playlist.length) nextIdx = 0;
  playTrackByIndex(nextIdx);
}

function playPrevTrack() {
  if (state.playlist.length === 0) return;
  let prevIdx = state.currentTrackIndex - 1;
  if (prevIdx < 0) prevIdx = state.playlist.length - 1;
  playTrackByIndex(prevIdx);
}

function updatePlaylistBadge() {
  const countEl = document.getElementById('music-playlist-count');
  if (countEl) countEl.innerText = `歌单 (${state.playlist.length})`;
}

function renderPlaylistDrawer() {
  const body = document.getElementById('playlist-body');
  if (!body) return;
  const search = (document.getElementById('playlist-search-input')?.value || '').toLowerCase().trim();

  let list = state.playlist;
  if (search) {
    list = list.filter((t) => t.title.toLowerCase().includes(search) || t.artist.toLowerCase().includes(search));
  }

  if (list.length === 0) {
    body.innerHTML = '<div class="empty-state">歌单暂无匹配曲目</div>';
    return;
  }

  body.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const isCurrent = state.currentTrackIndex >= 0 && state.playlist[state.currentTrackIndex]?.src === t.src;
    const item = document.createElement('div');
    item.className = `playlist-item ${isCurrent ? 'active' : ''}`;
    item.innerHTML = `
      <div class="playlist-item-left">
        <svg class="ui-icon-sm ${isCurrent ? 'playing-icon' : ''}"><use href="${isCurrent && state.isPlaying ? '#icon-pause' : '#icon-music'}"/></svg>
        <div class="playlist-item-meta">
          <div class="playlist-item-title">${escapeHtml(t.title)}</div>
          <div class="playlist-item-artist">${escapeHtml(t.artist)}</div>
        </div>
      </div>
      <div class="playlist-item-actions">
        <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); removeTrackFromPlaylist(${i})">移除</button>
      </div>
    `;
    item.onclick = () => {
      const realIdx = state.playlist.indexOf(t);
      playTrackByIndex(realIdx);
    };
    body.appendChild(item);
  }
}

function removeTrackFromPlaylist(idx) {
  if (idx < 0 || idx >= state.playlist.length) return;
  state.playlist.splice(idx, 1);
  if (state.currentTrackIndex === idx) {
    musicPlayer.audio.pause();
    state.currentTrackIndex = -1;
  } else if (state.currentTrackIndex > idx) {
    state.currentTrackIndex--;
  }
  updatePlaylistBadge();
  renderPlaylistDrawer();
}

async function importChatMusicToPlaylist() {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  if (!chatId) return showToast('请先选择一个会话', 'warn');

  showToast('正在获取会话全部音频...', 'info');
  try {
    const list = await api(`/api/instances/${instId}/account/chat-media?chatId=${chatId}&type=music&limit=100`);
    if (!list || list.length === 0) {
      return showToast('当前会话中未检索到音乐或音频文件', 'info');
    }
    let addedCount = 0;
    for (const m of list) {
      const src = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
      const title = m.media?.title || m.media?.fileName || `音频_${m.id}`;
      const artist = m.media?.performer || '未知艺术家';
      if (!state.playlist.some((t) => t.src === src)) {
        state.playlist.push({ title, artist, src, id: m.id });
        addedCount++;
      }
    }
    updatePlaylistBadge();
    renderPlaylistDrawer();
    showToast(`成功将 ${addedCount} 首曲目加入歌单`, 'success');
  } catch (err) {
    showToast(`导入失败: ${err.message}`, 'error');
  }
}

async function deleteSingleMsg(msgId) {
  if (!confirm(`确定撤回此消息 (#${msgId}) 吗？`)) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('delete_messages', { instId, chatId, messageIds: [msgId], revoke: true });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/delete-messages`, 'POST', { chatId, messageIds: [msgId], revoke: true });
    }
    showToast('已撤回消息', 'success');
    if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId) || state.chatSelectionVersion !== selectionVersion) return;
    state.clientMessages = state.clientMessages.filter((m) => String(m.id) !== String(msgId));
    renderClientMessages();
  } catch (err) {
    showToast(`撤回失败: ${err.message}`, 'error');
  }
}

async function quickPurge(count) {
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  if (!confirm(`确定清理当前会话最近 ${count} 条消息吗？`)) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  try {
    const res = await api(`/api/instances/${instId}/account/purge`, 'POST', {
      chatId,
      count,
    });
    showToast(`已成功批量撤回 ${res.deletedCount ?? count} 条消息`, 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) await loadClientMessages(chatId);
  } catch (err) {
    showToast(`批量撤回失败: ${err.message}`, 'error');
  }
}

async function quickLeaveChat() {
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  if (!confirm(`确定退出当前群聊/频道 (${state.clientActiveChatId}) 吗？`)) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  try {
    await api(`/api/instances/${instId}/account/leave`, 'POST', {
      chatId,
    });
    showToast('已成功退出该会话', 'success');
    if (state.clientSelectedInstance !== instId || String(state.clientActiveChatId) !== String(chatId) || state.chatSelectionVersion !== selectionVersion) return;
    void stopVoiceRecording(false);
    void stopVideoNoteRecording(false);
    window.PinnedMessages?.close();
    window.ForumTopics?.setDialog(null);
    if (typeof invalidateGroupMembers === 'function') invalidateGroupMembers();
    state.chatSelectionVersion = (state.chatSelectionVersion || 0) + 1;
    state.clientActiveChatId = null;
    state.clientActiveDialog = null;
    state.clientSavedReactionFilter = null;
    state.clientMessageEffectId = null;
    const effectSelect = document.getElementById('chat-message-effect'); if (effectSelect) effectSelect.value = '';
    document.getElementById('modal-saved-message-tags')?.classList.remove('active');
    if (document.getElementById('saved-message-tags-bar')) document.getElementById('saved-message-tags-bar').hidden = true;
    document.getElementById('client-chat-title').innerText = '请选择左侧会话';
    document.getElementById('client-chat-subtitle').innerText = '会话已退出';
    document.getElementById('client-chat-actions').style.display = 'none';
    document.getElementById('client-messages-container').innerHTML = '<div class="chat-placeholder"><p>已退出该会话</p></div>';
    await loadClientDialogs();
  } catch (err) {
    showToast(`退出会话失败: ${err.message}`, 'error');
  }
}

async function quickSendTyping() {
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  const instId = state.clientSelectedInstance;
  try {
    await api(`/api/instances/${instId}/account/typing`, 'POST', {
      chatId: state.clientActiveChatId,
    });
    showToast('已在当前会话触发 正在输入... 状态', 'success');
  } catch (err) {
    showToast(`触发失败: ${err.message}`, 'error');
  }
}

async function quickToggleOnline(online) {
  const instId = state.clientSelectedInstance;
  if (!instId) return;
  try {
    await api(`/api/instances/${instId}/account/status`, 'POST', { online });
    showToast(online ? '已将账号设置为在线状态' : '已将账号设置为隐身/离线状态', 'success');
    const txt = document.getElementById('client-online-text');
    if (txt) txt.innerText = online ? '设为隐身' : '设为在线';
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
}

let profileEditorVersion = 0;
let profileEditor = null;
let profileEmojiStatusState = null;

function isCurrentProfileEmojiStatusTarget(target) {
  return Boolean(target && profileEditor && profileEditor.version === target.version && profileEditor.instId === target.instId &&
    profileEditor.selectionVersion === target.selectionVersion && state.clientSelectedInstance === target.instId &&
    state.chatSelectionVersion === target.selectionVersion && document.getElementById('modal-profile')?.classList.contains('active'));
}

async function loadProfileEmojiStatus(instId, version, selectionVersion) {
  const target = { instId, version, selectionVersion };
  const current = document.getElementById('profile-emoji-status-current');
  const options = document.getElementById('profile-emoji-status-options');
  const hint = document.getElementById('profile-emoji-status-hint');
  const clear = document.getElementById('btn-profile-emoji-status-clear');
  if (!current || !options) return;
  current.textContent = '正在读取 Emoji 状态…';
  options.replaceChildren();
  if (clear) clear.hidden = true;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/emoji-status`);
    if (!isCurrentProfileEmojiStatusTarget(target)) return;
    const currentId = /^[1-9]\d{0,19}$/.test(String(result?.currentDocumentId || '')) ? String(result.currentDocumentId) : '';
    const until = Number.isSafeInteger(Number(result?.until)) && Number(result.until) > 0 ? Number(result.until) : 0;
    const statuses = Array.isArray(result?.options) ? result.options.filter(item => /^[1-9]\d{0,19}$/.test(String(item?.documentId || ''))).slice(0, 200) : [];
    profileEmojiStatusState = { ...target, currentId, until, statuses, busy: false };
    current.replaceChildren();
    if (currentId) {
      const selected = statuses.find(item => item.documentId === currentId);
      const image = document.createElement('img'); image.alt = selected?.emoji || '当前 Emoji 状态';
      image.src = `/api/instances/${encodeURIComponent(instId)}/account/custom-emoji?documentId=${encodeURIComponent(currentId)}`;
      current.appendChild(image);
      const label = document.createElement('span');
      label.textContent = `${selected?.emoji || '已设置'}${until ? ` · 截止 ${new Date(until * 1000).toLocaleString()}` : ' · 一直显示'}`;
      current.appendChild(label);
      if (clear) clear.hidden = false;
    } else current.textContent = '未设置 Emoji 状态';

    for (const status of statuses) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'profile-emoji-status-option';
      const emoji = typeof status.emoji === 'string' ? status.emoji : '';
      button.title = emoji || `Emoji 状态 ${status.documentId}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', status.documentId === currentId ? 'true' : 'false');
      const image = document.createElement('img'); image.alt = emoji || '';
      image.src = `/api/instances/${encodeURIComponent(instId)}/account/custom-emoji?documentId=${encodeURIComponent(status.documentId)}`;
      image.loading = 'lazy';
      image.onerror = () => { image.remove(); const fallback = document.createElement('span'); fallback.className = 'profile-emoji-status-option-fallback'; fallback.textContent = status.documentId.slice(-4); button.appendChild(fallback); };
      button.appendChild(image);
      button.onclick = () => { void saveProfileEmojiStatus(target, status.documentId); };
      options.appendChild(button);
    }
    if (hint) hint.textContent = statuses.length
      ? `${statuses.length} 个 Telegram 状态可选。有效期和账号权限由 Telegram 校验。`
      : '此账号当前没有可用的默认 Emoji 状态。';
  } catch (error) {
    if (!isCurrentProfileEmojiStatusTarget(target)) return;
    profileEmojiStatusState = { ...target, currentId: '', until: 0, statuses: [], busy: false };
    current.textContent = `读取 Emoji 状态失败：${error.message}`;
    if (hint) hint.textContent = '请检查账号连接后重试。';
  }
}

async function saveProfileEmojiStatus(target, documentId) {
  const status = profileEmojiStatusState;
  if (!status || status.busy || !isCurrentProfileEmojiStatusTarget(target) ||
      (documentId !== null && !status.statuses.some(item => item.documentId === documentId))) return;
  status.busy = true;
  const clear = document.getElementById('btn-profile-emoji-status-clear');
  if (clear) clear.disabled = true;
  document.querySelectorAll('#profile-emoji-status-options button').forEach(button => { button.disabled = true; });
  try {
    const durationSeconds = Number(document.getElementById('profile-emoji-status-duration')?.value || 0);
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/emoji-status`, 'POST', {
      documentId, ...(documentId === null ? {} : { durationSeconds }),
    });
    if (!isCurrentProfileEmojiStatusTarget(target)) return;
    showToast(documentId === null ? 'Emoji 状态已清除' : 'Emoji 状态已更新', 'success');
    await loadProfileEmojiStatus(target.instId, target.version, target.selectionVersion);
  } catch (error) {
    if (isCurrentProfileEmojiStatusTarget(target)) showToast(`更新 Emoji 状态失败：${error.message}`, 'error');
  } finally {
    if (isCurrentProfileEmojiStatusTarget(target)) {
      status.busy = false;
      if (clear) clear.disabled = false;
      document.querySelectorAll('#profile-emoji-status-options button').forEach(button => { button.disabled = false; });
    }
  }
}

function closeProfileModal() {
  profileEditorVersion++;
  profileEditor = null;
  profileEmojiStatusState = null;
  if (typeof closeStoryViewer === 'function') closeStoryViewer();
  document.getElementById('modal-profile').classList.remove('active');
}

async function openProfileModal() {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('请先选择一个账号', 'warn');
  const modal = document.getElementById('modal-profile');
  const save = document.getElementById('btn-save-profile');
  const version = ++profileEditorVersion;
  const selectionVersion = state.chatSelectionVersion;
  profileEditor = null;
  profileEmojiStatusState = null;
  save.disabled = true;
  for (const id of ['profile-input-firstname', 'profile-input-lastname', 'profile-input-bio']) {
    const input = document.getElementById(id);
    input.value = '';
    input.disabled = true;
  }
  document.getElementById('profile-editor-display-name').innerText = '正在加载…';
  document.getElementById('profile-display-username').innerText = '';
  document.getElementById('profile-display-id').innerText = '';
  document.getElementById('profile-display-phone').innerText = '';
  document.getElementById('profile-avatar-large').innerText = 'TG';
  modal.classList.add('active');

  try {
    const p = await api(`/api/instances/${instId}/account/profile`);
    if (version !== profileEditorVersion || state.clientSelectedInstance !== instId || state.chatSelectionVersion !== selectionVersion || !modal.classList.contains('active')) return;
    if (!p || typeof p.bio !== 'string') throw new Error('未能读取完整个人简介');
    document.getElementById('profile-avatar-large').innerText = (p.firstName || p.username || 'TG').slice(0, 2);
    document.getElementById('profile-editor-display-name').innerText = `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.username || 'Telegram User';
    document.getElementById('profile-display-username').innerText = p.username ? `@${p.username}` : '@未设置用户名';
    document.getElementById('profile-display-id').innerText = `ID: ${p.id || '--'}`;
    document.getElementById('profile-display-phone').innerText = `Phone: ${p.phone || '--'}`;

    document.getElementById('profile-input-firstname').value = p.firstName || '';
    document.getElementById('profile-input-lastname').value = p.lastName || '';
    document.getElementById('profile-input-bio').value = p.bio;
    profileEditor = { instId, version, selectionVersion, firstName: p.firstName || '', lastName: p.lastName || '', bio: p.bio };
    if (document.getElementById('profile-emoji-status-group')) void loadProfileEmojiStatus(instId, version, selectionVersion);
    for (const id of ['profile-input-firstname', 'profile-input-lastname', 'profile-input-bio']) {
      document.getElementById(id).disabled = false;
    }
    save.disabled = false;
  } catch (err) {
    if (version === profileEditorVersion && state.clientSelectedInstance === instId && state.chatSelectionVersion === selectionVersion && modal.classList.contains('active')) {
      document.getElementById('profile-editor-display-name').innerText = '加载失败';
      showToast(`加载账号资料失败: ${err.message}`, 'error');
    }
  }
}

async function saveProfileModal() {
  const editor = profileEditor;
  const instId = editor?.instId;
  if (!editor || state.clientSelectedInstance !== instId || state.chatSelectionVersion !== editor.selectionVersion) return showToast('账号或会话已切换，请重新打开资料', 'warn');
  const save = document.getElementById('btn-save-profile');
  if (save.disabled) return;
  const firstName = document.getElementById('profile-input-firstname').value;
  const lastName = document.getElementById('profile-input-lastname').value;
  const bio = document.getElementById('profile-input-bio').value;

  if (!firstName.trim()) return showToast('First Name 不能为空', 'warn');

  const changes = {};
  if (firstName !== editor.firstName) changes.firstName = firstName;
  if (lastName !== editor.lastName) changes.lastName = lastName;
  if (bio !== editor.bio) changes.bio = bio;
  if (!Object.keys(changes).length) { closeProfileModal(); return; }

  save.disabled = true;
  for (const id of ['profile-input-firstname', 'profile-input-lastname', 'profile-input-bio']) document.getElementById(id).disabled = true;
  try {
    await api(`/api/instances/${instId}/account/profile`, 'POST', changes);
    showToast('个人资料已成功更新', 'success');
    if (profileEditor === editor && state.clientSelectedInstance === instId && state.chatSelectionVersion === editor.selectionVersion) closeProfileModal();
    await loadInstances();
  } catch (err) {
    showToast(`更新资料失败: ${err.message}`, 'error');
  } finally {
    if (profileEditor === editor && state.clientSelectedInstance === instId && state.chatSelectionVersion === editor.selectionVersion) {
      save.disabled = false;
      for (const id of ['profile-input-firstname', 'profile-input-lastname', 'profile-input-bio']) document.getElementById(id).disabled = false;
    }
  }
}

async function doPeerLookup() {
  const q = document.getElementById('tool-lookup-input').value.trim();
  if (!q) return showToast('请输入查询内容', 'warn');
  const instId = state.clientSelectedInstance;
  const resBox = document.getElementById('tool-lookup-result');
  resBox.style.display = 'block';
  resBox.innerText = '正在解析对象信息...';

  try {
    const data = await api(`/api/instances/${instId}/account/resolve?query=${encodeURIComponent(q)}`);
    resBox.innerText = JSON.stringify(data, null, 2);
  } catch (err) {
    resBox.innerText = `查询失败: ${err.message}`;
  }
}

function openBroadcastModal() {
  const modal = document.getElementById('modal-broadcast');
  modal.classList.add('active');
}

async function submitBroadcast() {
  const targetsRaw = document.getElementById('broadcast-input-targets').value;
  const text = document.getElementById('broadcast-input-text').value.trim();
  const intervalMs = Number(document.getElementById('broadcast-input-interval').value) || 800;

  const chatIds = targetsRaw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (chatIds.length === 0 || !text) {
    return showToast('请填写目标会话列表与广播内容', 'warn');
  }

  const instId = state.clientSelectedInstance;
  showToast(`正在向 ${chatIds.length} 个会话群发广播...`, 'info');
  document.getElementById('modal-broadcast').classList.remove('active');

  try {
    const res = await api(`/api/instances/${instId}/account/broadcast`, 'POST', {
      chatIds,
      text,
      intervalMs,
    });
    showToast(`群发完成！共成功发送 ${res.results?.filter((r) => r.success).length} 个`, 'success');
  } catch (err) {
    showToast(`群发失败: ${err.message}`, 'error');
  }
}

function populateQuickChatOptions() {
  const select = document.getElementById('sched-quick-chat-select');
  if (!select) return;
  select.innerHTML = '<option value="">快捷选择最近对话...</option>';
  for (const d of state.clientDialogs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.innerText = `${d.title || d.username || d.id} (${d.type})`;
    select.appendChild(opt);
  }
  select.onchange = () => {
    if (select.value) {
      document.getElementById('sched-input-chat').value = select.value;
    }
  };
}

// ==========================================
// Scheduler: Daily at Specific Time & Auto-Repeat
// ==========================================
let serverClockInterval = null;

async function initSchedulerView() {
  const select = document.getElementById('scheduler-account-select');
  if (!select) return;
  select.innerHTML = '';

  if (state.instances.length === 0) {
    select.innerHTML = '<option value="">无可用实例</option>';
    return;
  }

  for (const inst of state.instances) {
    const opt = document.createElement('option');
    opt.value = inst.config.id;
    opt.innerText = `${inst.config.name} (${inst.config.id})`;
    select.appendChild(opt);
  }

  if (!state.schedulerSelectedInstance || !state.instances.find((i) => i.config.id === state.schedulerSelectedInstance)) {
    state.schedulerSelectedInstance = state.instances[0].config.id;
  }
  select.value = state.schedulerSelectedInstance;

  startServerClock();
  await loadScheduledTasks();
}

function startServerClock() {
  if (serverClockInterval) clearInterval(serverClockInterval);
  const updateClock = () => {
    const now = new Date();
    const str = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const elClock = document.getElementById('scheduler-server-time');
    if (elClock) elClock.innerText = str;
    updateDailyLivePreview();
  };
  updateClock();
  serverClockInterval = setInterval(updateClock, 1000);
}

function updateDailyLivePreview() {
  const timeInput = document.getElementById('sched-input-daily-time');
  const previewBox = document.getElementById('sched-daily-preview-text');
  if (!timeInput || !previewBox) return;

  const tVal = timeInput.value || '00:01';
  const m = tVal.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    previewBox.innerText = '请输入有效的时间格式 (HH:mm)';
    return;
  }

  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const diffMs = target.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / 3600000);
  const diffMins = Math.floor((diffMs % 3600000) / 60000);
  const nextTargetStr = target.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  previewBox.innerText = `将于每天服务器时间 ${tVal} 准时发送 | 下次触发: ${nextTargetStr} (距今约 ${diffHours} 小时 ${diffMins} 分钟)`;
}

async function loadScheduledTasks() {
  const instId = state.schedulerSelectedInstance;
  if (!instId) return;

  const tbody = document.getElementById('scheduler-tasks-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="table-empty">正在加载调度任务...</td></tr>';

  try {
    const data = await api(`/api/instances/${instId}/schedule`);
    state.schedulerTasks = data.tasks || [];
    renderScheduledTasks();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty error">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderScheduledTasks() {
  const tbody = document.getElementById('scheduler-tasks-tbody');
  const viewsContainer = document.querySelector('.views-container');
  if (viewsContainer && document.getElementById('view-scheduler')?.classList.contains('active')) {
    viewsContainer.scrollTop = 0;
  }

  // Update Scheduler Dashboard Stats
  const total = state.schedulerTasks.length;
  const enabled = state.schedulerTasks.filter((t) => t.enabled === 1).length;
  const daily = state.schedulerTasks.filter((t) => t.time_spec && t.time_spec.startsWith('daily:')).length;
  const repeat = state.schedulerTasks.filter((t) => t.repeat === 1 && (!t.time_spec || !t.time_spec.startsWith('daily:'))).length;

  const elTotal = document.getElementById('sched-stat-total');
  const elEnabled = document.getElementById('sched-stat-enabled');
  const elDaily = document.getElementById('sched-stat-daily');
  const elRepeat = document.getElementById('sched-stat-repeat');
  if (elTotal) elTotal.innerText = total;
  if (elEnabled) elEnabled.innerText = enabled;
  if (elDaily) elDaily.innerText = daily;
  if (elRepeat) elRepeat.innerText = repeat;

  if (state.schedulerTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">暂无定时广播或自动重复任务，点击右上角新建任务。</td></tr>';
    return;
  }

  const now = Date.now();
  tbody.innerHTML = '';
  for (const t of state.schedulerTasks) {
    const tr = document.createElement('tr');

    let ruleStr = '';
    if (t.time_spec && t.time_spec.startsWith('daily:')) {
      ruleStr = `<span class="status-pill starting"><svg class="ui-icon-xs"><use href="#icon-calendar"/></svg><span>每天固定 ${escapeHtml(t.time_spec.slice(6))}</span></span>`;
    } else if (t.repeat === 1) {
      ruleStr = `<span class="status-pill online"><svg class="ui-icon-xs"><use href="#icon-refresh"/></svg><span>循环每隔 ${formatDuration(t.interval_ms)}</span></span>`;
    } else {
      ruleStr = `<span class="status-pill stopped"><svg class="ui-icon-xs"><use href="#icon-clock"/></svg><span>单次延时</span></span>`;
    }

    const diffMs = Math.max(0, t.next_run_at - now);
    const nextTimeStr = new Date(t.next_run_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const countdownStr = diffMs > 0 ? `约 ${formatDuration(diffMs)} 后` : '<span style="color:var(--color-warning);">等待触发</span>';

    const statusBadge = t.enabled === 1
      ? '<span class="status-pill online"><span class="pill-dot"></span><span>已启用</span></span>'
      : '<span class="status-pill stopped"><span class="pill-dot"></span><span>已禁用</span></span>';

    const snippet = t.content.length > 32 ? t.content.slice(0, 32) + '...' : t.content;

    tr.innerHTML = `
      <td><b>#${escapeHtml(t.id)}</b></td>
      <td><code>${escapeHtml(String(t.chat_id))}</code></td>
      <td>${ruleStr}</td>
      <td title="${escapeHtml(t.content)}"><i>${escapeHtml(snippet)}</i></td>
      <td>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${countdownStr}</div>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">${nextTimeStr}</div>
      </td>
      <td>${statusBadge}</td>
      <td style="text-align: right;">
        <button class="btn btn-secondary btn-xs" onclick="runTaskNow(${inlineJsArg(t.id)})" title="立即测试发送一次">执行一次</button>
        <button class="btn btn-secondary btn-xs" onclick="toggleTask(${inlineJsArg(t.id)})">${t.enabled === 1 ? '禁用' : '启用'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteTask(${inlineJsArg(t.id)})" title="永久删除任务">删除</button>
      </td>
    `;

    tbody.appendChild(tr);
  }
}

async function runTaskNow(taskId) {
  const instId = state.schedulerSelectedInstance;
  try {
    await api(`/api/instances/${instId}/schedule/${taskId}/run`, 'POST');
    showToast(`定时任务 #${taskId} 已立即发送一次`, 'success');
  } catch (err) {
    showToast(`发送失败: ${err.message}`, 'error');
  }
}

async function toggleTask(taskId) {
  const instId = state.schedulerSelectedInstance;
  try {
    await api(`/api/instances/${instId}/schedule/${taskId}/toggle`, 'POST');
    showToast(`已切换任务 #${taskId} 启用状态`, 'success');
    await loadScheduledTasks();
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
}

async function deleteTask(taskId) {
  if (!confirm(`确定删除定时任务 #${taskId} 吗？`)) return;
  const instId = state.schedulerSelectedInstance;
  try {
    await api(`/api/instances/${instId}/schedule/${taskId}`, 'DELETE');
    showToast(`任务 #${taskId} 已删除`, 'success');
    await loadScheduledTasks();
  } catch (err) {
    showToast(`删除失败: ${err.message}`, 'error');
  }
}

function openCreateScheduleModal() {
  populateQuickChatOptions();
  document.getElementById('modal-create-schedule').classList.add('active');
  updateDailyLivePreview();
}

async function saveScheduleTask() {
  const chatId = document.getElementById('sched-input-chat').value.trim();
  const content = document.getElementById('sched-input-content').value.trim();
  if (!chatId || !content) {
    return showToast('请填写目标会话与消息正文', 'warn');
  }

  const activeModeCard = document.querySelector('.repeat-mode-card.active');
  const mode = activeModeCard ? activeModeCard.dataset.mode : 'daily';

  let type = mode;
  let timeSpec = undefined;
  let intervalMs = 60000;
  let repeat = 1;

  if (mode === 'daily') {
    const dailyTime = document.getElementById('sched-input-daily-time').value.trim() || '00:01';
    timeSpec = dailyTime;
    intervalMs = 86400000;
    repeat = 1;
  } else if (mode === 'interval') {
    const val = Number(document.getElementById('sched-input-interval-val').value) || 30;
    const unit = document.getElementById('sched-input-interval-unit').value;
    const unitMult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    intervalMs = val * (unitMult[unit] || 60000);
    repeat = 1;
  } else if (mode === 'once') {
    const val = Number(document.getElementById('sched-input-once-val').value) || 10;
    const unit = document.getElementById('sched-input-once-unit').value;
    const unitMult = { m: 60000, h: 3600000, d: 86400000 };
    intervalMs = val * (unitMult[unit] || 60000);
    repeat = 0;
  }

  const instId = state.schedulerSelectedInstance;
  try {
    await api(`/api/instances/${instId}/schedule`, 'POST', {
      chatId,
      content,
      type,
      timeSpec,
      intervalMs,
      repeat,
    });

    showToast('定时任务创建成功', 'success');
    document.getElementById('modal-create-schedule').classList.remove('active');
    document.getElementById('sched-input-content').value = '';
    await loadScheduledTasks();
  } catch (err) {
    showToast(`创建失败: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   Telegram Desktop PC Expression Drawer & Markdown Rich Text Implementation
   ========================================================================== */

function insertMarkdown(format) {
  const textarea = document.getElementById('client-message-textarea');
  if (!textarea) return;

  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;
  const selected = val.substring(start, end);

  if (format === 'blockquote') {
    const content = selected || '引用文字';
    const replacement = content.split(/\r?\n/).map(line => `> ${line}`).join('\n');
    textarea.value = val.substring(0, start) + replacement + val.substring(end);
    autoResizeTextarea(textarea);
    notifyCurrentDraftChanged();
    textarea.focus();
    const caret = start + replacement.length;
    textarea.setSelectionRange(caret, caret);
    return;
  }

  let prefix = '';
  let suffix = '';
  let placeholder = '';

  switch (format) {
    case 'bold':
      prefix = '**';
      suffix = '**';
      placeholder = '加粗文字';
      break;
    case 'italic':
      prefix = '__';
      suffix = '__';
      placeholder = '斜体文字';
      break;
    case 'underline':
      prefix = '<u>';
      suffix = '</u>';
      placeholder = '下划线文字';
      break;
    case 'strike':
      prefix = '~~';
      suffix = '~~';
      placeholder = '删除线文字';
      break;
    case 'code':
      if (selected.includes('\n')) {
        prefix = '```\n';
        suffix = '\n```';
        placeholder = '代码块';
      } else {
        prefix = '`';
        suffix = '`';
        placeholder = '代码';
      }
      break;
    case 'spoiler':
      prefix = '||';
      suffix = '||';
      placeholder = '剧透内容';
      break;
    case 'link': {
      openInsertLinkModal();
      return;
    }
  }

  const content = selected || placeholder;
  const replacement = prefix + content + suffix;
  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  autoResizeTextarea(textarea);
  notifyCurrentDraftChanged();
  textarea.focus();

  if (selected) {
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
  } else {
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + placeholder.length);
  }
}

function openInsertLinkModal() {
  const textarea = document.getElementById('client-message-textarea');
  const modal = document.getElementById('modal-insert-link');
  const textInput = document.getElementById('link-text-input');
  const urlInput = document.getElementById('link-url-input');
  if (!modal || !textInput || !urlInput) return;

  let selectedText = '';
  if (textarea) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    selectedText = textarea.value.substring(start, end).trim();
  }

  textInput.value = selectedText || '';
  urlInput.value = '';
  modal.style.display = 'flex';
  setTimeout(() => {
    if (selectedText) {
      urlInput.focus();
    } else {
      textInput.focus();
    }
  }, 60);
}

function closeInsertLinkModal() {
  const modal = document.getElementById('modal-insert-link');
  if (modal) modal.style.display = 'none';
  document.getElementById('client-message-textarea')?.focus();
}

function confirmInsertLink() {
  const textarea = document.getElementById('client-message-textarea');
  const textInput = document.getElementById('link-text-input');
  const urlInput = document.getElementById('link-url-input');
  if (!textarea || !textInput || !urlInput) return;

  const text = textInput.value.trim() || '链接';
  let url = urlInput.value.trim();
  if (!url) {
    showToast('请输入有效的超链接地址', 'warn');
    urlInput.focus();
    return;
  }
  if (!/^(https?:\/\/|tg:\/\/|mailto:)/i.test(url)) {
    url = 'https://' + url;
  }

  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;
  const replacement = `[${text}](${url})`;

  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  closeInsertLinkModal();
  autoResizeTextarea(textarea);
  notifyCurrentDraftChanged();
  textarea.focus();
  textarea.setSelectionRange(start + replacement.length, start + replacement.length);
}

/**
 * Auto-elastic textarea height resizer
 */
function autoResizeTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  const newHeight = Math.min(Math.max(ta.scrollHeight, 36), 160);
  ta.style.height = `${newHeight}px`;
}

/**
 * Update chat send mode hint label
 */
function updateChatSendHint() {
  const mode = state.chatSendKeyMode || 'enter';
  const hintEl = document.getElementById('client-input-hint');
  const selEl = document.getElementById('client-input-sendmode');
  if (selEl) selEl.value = mode;
  if (hintEl) {
    hintEl.textContent = mode === 'ctrlEnter'
      ? 'Ctrl + Enter 发送 / Enter 换行'
      : 'Enter 发送 / Shift + Enter 换行';
  }
}

/**
 * Automatic debounced typing indicator dispatch
 */
let typingThrottleTimer = 0;
function triggerAutoTyping() {
  const chatId = state.clientActiveChatId;
  const instId = state.clientSelectedInstance;
  if (!chatId || !instId) return;

  const now = Date.now();
  if (now - typingThrottleTimer < 4000) return;
  typingThrottleTimer = now;

  api(`/api/instances/${instId}/account/typing`, 'POST', { chatId }).catch(() => {});
}

/**
 * Chat attachment file staging and drag & drop support
 */
function stageAttachmentFile(fileOrFiles) {
  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : fileOrFiles ? [fileOrFiles] : []).filter(Boolean);
  if (!files.length) return;
  if (files.length > 10) return showToast('Telegram 相册最多包含 10 个照片或视频', 'error');
  const isAlbumMedia = file => /^(?:image\/(?:jpeg|png|webp|heic|heif)|video\/(?:mp4|webm|quicktime|x-m4v|3gpp))$/i.test(file.type || '');
  if (files.length > 1 && files.some(file => !isAlbumMedia(file))) {
    return showToast('多选仅支持照片和视频，请分开发送其他附件', 'error');
  }
  state.clientPaidMediaStars = null;
  state.clientCaptionAboveMedia = false;
  state.clientVideoNote = false;
  state.clientStagedFiles = files;
  state.clientStagedFile = files[0];
  const captionAboveOption = document.getElementById('chat-caption-above-option');
  const captionAboveInput = document.getElementById('chat-caption-above');
  const videoNoteOption = document.getElementById('chat-video-note-option');
  const videoNoteInput = document.getElementById('chat-video-note');
  if (captionAboveOption) captionAboveOption.hidden = !files.every(isAlbumMedia);
  if (captionAboveInput) captionAboveInput.checked = false;
  if (videoNoteOption) videoNoteOption.hidden = files.length !== 1 || !/^video\//i.test(files[0].type || '');
  if (videoNoteInput) videoNoteInput.checked = false;
  const strip = document.getElementById('chat-attachment-strip');
  const nameEl = document.getElementById('attachment-chip-name');
  const sizeEl = document.getElementById('attachment-chip-size');
  if (strip && nameEl && sizeEl) {
    const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    nameEl.textContent = files.length > 1 ? `${files.length} 张照片或视频` : files[0].name;
    sizeEl.textContent = files.length > 1 ? `(${files.length} 个文件，${formatBytes(totalSize)})` : `(${formatBytes(totalSize)})`;
    strip.style.display = 'flex';
  }
  updatePaidMediaComposerControl();
  document.getElementById('client-message-textarea')?.focus();
}

function clearStagedAttachment() {
  state.clientStagedFile = null;
  state.clientStagedFiles = [];
  state.clientPaidMediaStars = null;
  state.clientCaptionAboveMedia = false;
  state.clientVideoNote = false;
  const captionAboveInput = document.getElementById('chat-caption-above');
  const videoNoteInput = document.getElementById('chat-video-note');
  if (captionAboveInput) captionAboveInput.checked = false;
  if (videoNoteInput) videoNoteInput.checked = false;
  const strip = document.getElementById('chat-attachment-strip');
  if (strip) strip.style.display = 'none';
  const fileInput = document.getElementById('chat-file-input');
  if (fileInput) fileInput.value = '';
  updatePaidMediaComposerControl();
}

function cancelStagedAttachment() {
  const file = state.clientStagedFile;
  const active = file && activeMediaUploads.get(file);
  if (active?.phase === 'sending') {
    showToast('附件正在发送至 Telegram，请等待发送结果', 'info');
    return;
  }
  if (active) active.xhr.abort();
  clearStagedAttachment();
}

// Swipe-to-reply gesture (mobile)
function initSwipeToReply() {
  const container = document.getElementById('client-messages-container');
  if (!container) return;

  let startX = 0, startY = 0, startMsgX = 0;
  let currentWrap = null;
  let isSwiping = false;

  container.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    currentWrap = e.target.closest('.chat-bubble-wrap');
    if (currentWrap) {
      startMsgX = 0;
      isSwiping = false;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!currentWrap) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);

    // Only swipe horizontally, max 80px
    if (Math.abs(dx) > 15 && dy < 30) {
      isSwiping = true;
      startMsgX = Math.min(Math.max(dx, 0), 80);
      currentWrap.style.transform = `translateX(${startMsgX}px)`;
      currentWrap.style.transition = 'none';
    }
  }, { passive: true });

  container.addEventListener('touchend', () => {
    if (!currentWrap) return;
    currentWrap.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.4, 1.1)';
    currentWrap.style.transform = '';

    if (isSwiping && startMsgX >= 55) {
      const msgId = Number(currentWrap.dataset.msgId);
      if (msgId) setReplyingMessage(msgId);
    }
    currentWrap = null;
    isSwiping = false;
    startMsgX = 0;
  }, { passive: true });
}

function initChatDragAndDrop() {
  const dropZone = document.getElementById('client-input-bar');
  const chatPane = document.getElementById('client-chat-pane');

  [dropZone, chatPane].filter(Boolean).forEach((target) => {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone?.classList.add('drag-active');
    });
    target.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone?.classList.remove('drag-active');
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone?.classList.remove('drag-active');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSendAttachment(Array.from(e.dataTransfer.files));
      }
    });
  });

  const btnAttach = document.getElementById('btn-chat-attach');
  const fileInput = document.getElementById('chat-file-input');
  if (btnAttach && fileInput) {
    btnAttach.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (files.length) handleSendAttachment(files);
    };
  }
  const paidMediaButton = document.getElementById('btn-chat-paid-media');
  if (paidMediaButton) paidMediaButton.onclick = editStagedPaidMediaPrice;
  const captionAboveInput = document.getElementById('chat-caption-above');
  if (captionAboveInput) captionAboveInput.onchange = () => { state.clientCaptionAboveMedia = captionAboveInput.checked === true; };
  const videoNoteInput = document.getElementById('chat-video-note');
  if (videoNoteInput) videoNoteInput.onchange = () => {
    if (videoNoteInput.checked && state.clientPaidMediaStars != null) {
      videoNoteInput.checked = false;
      showToast('付费媒体不能发送为圆形视频消息', 'warn');
      return;
    }
    state.clientVideoNote = videoNoteInput.checked === true;
    updatePaidMediaComposerControl();
  };
  const todoButton = document.getElementById('btn-chat-todo');
  if (todoButton) todoButton.onclick = () => { void createTelegramTodoList(); };
  const diceButton = document.getElementById('btn-chat-dice');
  const dicePicker = document.getElementById('chat-dice-picker');
  if (diceButton && dicePicker) {
    const closeDicePicker = () => {
      dicePicker.hidden = true;
      diceButton.setAttribute('aria-expanded', 'false');
    };
    diceButton.onclick = () => {
      const open = dicePicker.hidden;
      dicePicker.hidden = !open;
      diceButton.setAttribute('aria-expanded', String(open));
      if (open) dicePicker.querySelector('[data-dice-emoji]')?.focus();
    };
    dicePicker.querySelectorAll('[data-dice-emoji]').forEach(button => {
      button.onclick = () => {
        const chatId = Number(state.clientActiveChatId);
        closeDicePicker();
        diceButton.focus();
        void sendTelegramDice(chatId, button.dataset.diceEmoji);
      };
    });
    document.addEventListener('click', event => {
      if (!dicePicker.hidden && !dicePicker.contains(event.target) && !diceButton.contains(event.target)) closeDicePicker();
    });
    dicePicker.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeDicePicker(); diceButton.focus(); }
    });
  }

  const btnCancelAttach = document.getElementById('btn-cancel-attachment');
  if (btnCancelAttach) {
    btnCancelAttach.onclick = () => cancelStagedAttachment();
  }
}

/**
 * Initializes Miuix one-click popup menu and right-click context menu
 */
function initChatContextMenu() {
  const menu = document.getElementById('chat-context-menu');
  const btnMore = document.getElementById('btn-chat-more-menu');
  const textarea = document.getElementById('client-message-textarea');
  const inputBar = document.getElementById('client-input-bar');
  if (!menu) return;

  const toggleMenu = (e) => {
    e.stopPropagation();
    if (menu.style.display === 'flex') {
      menu.style.display = 'none';
    } else {
      menu.style.display = 'flex';
      updateChatMenuVisuals();
    }
  };

  if (btnMore) {
    btnMore.onclick = toggleMenu;
  }

  menu.querySelector?.('.chat-extra-actions')?.addEventListener('click', (event) => {
    if (event.target?.closest?.('button')) menu.style.display = 'none';
  });

  const captureChatTarget = () => {
    const instId = state.clientSelectedInstance;
    const chatId = state.clientActiveChatId;
    if (!instId || !chatId || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0) return null;
    return { instId, chatId: Number(chatId), selectionVersion: state.chatSelectionVersion || 0 };
  };
  const isTargetCurrent = (target) => Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && (state.chatSelectionVersion || 0) === target.selectionVersion);

  const shareLocationBtn = document.getElementById('menu-share-location');
  if (shareLocationBtn) {
    shareLocationBtn.onclick = () => {
      menu.style.display = 'none';
      const target = captureChatTarget();
      if (!target) return showToast('请先打开要发送位置的会话', 'warn');
      if (!navigator.geolocation) return showToast('当前浏览器不支持位置服务', 'error');
      if (window.isSecureContext === false) return showToast('浏览器仅允许在 HTTPS 或本机环境下读取位置', 'error');
      navigator.geolocation.getCurrentPosition(async (position) => {
        if (!isTargetCurrent(target)) return showToast('会话已切换，位置未发送', 'warn');
        try {
          await api(`/api/instances/${encodeURIComponent(target.instId)}/account/location`, 'POST', {
            chatId: target.chatId,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
          if (isTargetCurrent(target)) await loadClientMessages(target.chatId, true);
          showToast('当前位置已发送', 'success');
        } catch (err) {
          showToast(`位置发送失败: ${err.message}`, 'error');
        }
      }, (error) => {
        const message = error.code === error.PERMISSION_DENIED ? '未获得位置权限' :
          error.code === error.TIMEOUT ? '读取位置超时，请重试' : '无法读取当前位置';
        showToast(message, 'warn');
      }, { enableHighAccuracy: false, maximumAge: 0, timeout: 12000 });
    };
  }

  const shareLiveLocationBtn = document.getElementById('menu-share-live-location');
  if (shareLiveLocationBtn) {
    shareLiveLocationBtn.onclick = () => {
      menu.style.display = 'none';
      const target = captureChatTarget();
      if (!target) return showToast('请先打开要发送位置的会话', 'warn');
      target.isCurrent = () => isTargetCurrent(target);
      startClientLiveLocation(target);
    };
  }

  document.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-stop-live-location]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    const instId = state.clientSelectedInstance;
    const chatId = Number(button.dataset.chatId), messageId = Number(button.dataset.messageId);
    if (!instId || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return;
    button.disabled = true;
    void stopClientLiveLocation(instId, chatId, messageId).finally(() => { if (button.isConnected) button.disabled = false; });
  });

  const contactModal = document.getElementById('modal-contact-share');
  const contactForm = document.getElementById('form-contact-share');
  const contactFirst = document.getElementById('contact-share-first');
  const contactLast = document.getElementById('contact-share-last');
  const contactPhone = document.getElementById('contact-share-phone');
  const contactSubmit = document.getElementById('btn-submit-contact-share');
  const contactPickerButton = document.getElementById('btn-load-share-contacts');
  const contactPicker = document.getElementById('contact-share-picker');
  const contactSearch = document.getElementById('contact-share-search');
  const contactPickerStatus = document.getElementById('contact-share-picker-status');
  const contactPickerList = document.getElementById('contact-share-picker-list');
  let contactTarget = null;
  let contactPickerRequest = 0;
  let shareableContacts = [];
  const renderShareableContacts = () => {
    if (!contactPickerList || !contactPickerStatus) return;
    const query = String(contactSearch?.value || '').trim().toLocaleLowerCase();
    const filtered = shareableContacts.filter((contact) => {
      const label = `${contact.firstName || ''} ${contact.lastName || ''} ${contact.phone || ''} ${contact.username || ''}`.toLocaleLowerCase();
      return !query || label.includes(query);
    });
    const visible = filtered.slice(0, 100);
    contactPickerList.replaceChildren();
    for (const contact of visible) {
      const button = document.createElement('button'); button.type = 'button';
      const name = document.createElement('span'); name.textContent = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.username || contact.phone;
      const phone = document.createElement('span'); phone.textContent = contact.phone;
      button.append(name, phone);
      button.onclick = () => {
        if (!isTargetCurrent(contactTarget)) return;
        if (contactFirst) contactFirst.value = String(contact.firstName || '');
        if (contactLast) contactLast.value = String(contact.lastName || '');
        if (contactPhone) contactPhone.value = String(contact.phone || '');
        if (contactPicker) contactPicker.hidden = true;
        contactFirst?.focus();
      };
      contactPickerList.appendChild(button);
    }
    contactPickerStatus.textContent = filtered.length > visible.length
      ? `匹配 ${filtered.length} 位联系人，当前显示前 ${visible.length} 位。`
      : `${filtered.length} 位联系人`;
  };
  const closeContactModal = () => {
    contactPickerRequest++;
    if (contactPickerButton) contactPickerButton.disabled = false;
    if (contactModal) contactModal.style.display = 'none';
    contactTarget = null;
    shareableContacts = [];
    if (contactPicker) contactPicker.hidden = true;
    contactPickerList?.replaceChildren();
    contactForm?.reset();
    if (contactSubmit) contactSubmit.disabled = false;
  };
  const shareContactBtn = document.getElementById('menu-share-contact');
  if (shareContactBtn) {
    shareContactBtn.onclick = () => {
      menu.style.display = 'none';
      contactTarget = captureChatTarget();
      if (!contactTarget) return showToast('请先打开要发送联系人的会话', 'warn');
      if (!contactModal) return showToast('联系人表单不可用', 'error');
      contactPickerRequest++;
      contactForm?.reset();
      shareableContacts = [];
      if (contactPicker) contactPicker.hidden = true;
      contactPickerList?.replaceChildren();
      if (contactSubmit) contactSubmit.disabled = false;
      contactModal.style.display = 'flex';
      contactFirst?.focus();
    };
  }
  if (contactPickerButton) {
    contactPickerButton.onclick = async () => {
      const target = contactTarget;
      if (!isTargetCurrent(target)) return showToast('账号或会话已切换，请重新打开联系人表单', 'warn');
      const request = ++contactPickerRequest;
      if (contactPicker) contactPicker.hidden = false;
      if (contactPickerStatus) contactPickerStatus.textContent = '正在读取 Telegram 联系人…';
      if (contactPickerList) contactPickerList.replaceChildren();
      contactPickerButton.disabled = true;
      try {
        const contacts = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/contacts`);
        if (request !== contactPickerRequest || contactTarget !== target || !isTargetCurrent(target)) return;
        shareableContacts = (Array.isArray(contacts) ? contacts : []).filter(contact =>
          !contact?.isBot && typeof contact?.phone === 'string' && contact.phone.trim() &&
          (String(contact.firstName || '').trim() || String(contact.lastName || '').trim() || String(contact.username || '').trim()));
        renderShareableContacts();
        if (!shareableContacts.length && contactPickerStatus) contactPickerStatus.textContent = '没有可分享的 Telegram 联系人，可手动填写联系人信息。';
      } catch (error) {
        if (request === contactPickerRequest && contactTarget === target && isTargetCurrent(target) && contactPickerStatus) {
          contactPickerStatus.textContent = `无法读取联系人：${error.message}`;
        }
      } finally {
        if (request === contactPickerRequest) contactPickerButton.disabled = false;
      }
    };
  }
  contactSearch?.addEventListener('input', renderShareableContacts);
  const closeContactBtn = document.getElementById('btn-close-contact-share');
  const cancelContactBtn = document.getElementById('btn-cancel-contact-share');
  if (closeContactBtn) closeContactBtn.onclick = closeContactModal;
  if (cancelContactBtn) cancelContactBtn.onclick = closeContactModal;
  if (contactModal) contactModal.onclick = (event) => { if (event.target === contactModal) closeContactModal(); };
  if (contactForm) {
    contactForm.onsubmit = async (event) => {
      event.preventDefault();
      const target = contactTarget;
      if (!isTargetCurrent(target)) return showToast('账号或会话已切换，请重新打开联系人表单', 'warn');
      const firstName = contactFirst?.value.trim() || '';
      const lastName = contactLast?.value.trim() || '';
      const phoneNumber = contactPhone?.value.trim() || '';
      if (!firstName || lastName.length > 64 || !/^\+?[0-9 ()-]{3,32}$/.test(phoneNumber) || phoneNumber.replace(/\D/g, '').length < 3) {
        return showToast('请填写有效的姓名和电话号码', 'warn');
      }
      if (contactSubmit) contactSubmit.disabled = true;
      try {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/contact`, 'POST', {
          chatId: target.chatId, firstName, lastName, phoneNumber,
        });
        closeContactModal();
        if (isTargetCurrent(target)) await loadClientMessages(target.chatId, true);
        showToast('联系人已发送', 'success');
      } catch (err) {
        if (contactSubmit) contactSubmit.disabled = false;
        showToast(`联系人发送失败: ${err.message}`, 'error');
      }
    };
  }

  // Right-click context menu on textarea or input bar
  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu.style.display = 'flex';
    updateChatMenuVisuals();
  };

  textarea?.addEventListener('contextmenu', handleContextMenu);
  inputBar?.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('button') && !e.target.closest('input')) {
      handleContextMenu(e);
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btnMore && !btnMore?.contains(e.target)) {
      menu.style.display = 'none';
    }
  });

  // Formatting pills inside menu (keeps shortcuts intact)
  menu.querySelectorAll('.fmt-pill').forEach((pill) => {
    pill.onclick = (e) => {
      e.stopPropagation();
      const fmt = pill.dataset.fmt;
      if (fmt) insertMarkdown(fmt);
      menu.style.display = 'none';
    };
  });

  // Silent toggle row & switch
  const silentRow = document.getElementById('row-toggle-silent');
  if (silentRow) {
    silentRow.onclick = (e) => {
      e.stopPropagation();
      state.clientSilent = !state.clientSilent;
      localStorage.setItem('tgbot_chat_silent', String(state.clientSilent));
      updateChatMenuVisuals();
    };
  }

  // Parse mode segmented pills
  document.querySelectorAll('#seg-parsemode .seg-item').forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      const val = item.dataset.val || 'markdown';
      state.clientParseMode = val;
      localStorage.setItem('tgbot_chat_parse_mode', val);
      updateChatMenuVisuals();
    };
  });

  // Send mode segmented pills
  document.querySelectorAll('#seg-sendmode .seg-item').forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      const val = item.dataset.val || 'enter';
      state.chatSendKeyMode = val;
      localStorage.setItem('tgbot_chat_send_mode', val);
      updateChatMenuVisuals();
      updateChatSendHint();
    };
  });

  // Clear input content
  const btnClear = document.getElementById('menu-btn-clear-input');
  if (btnClear) {
    btnClear.onclick = (e) => {
      e.stopPropagation();
      if (textarea) {
        textarea.value = '';
        autoResizeTextarea(textarea);
        if (state.clientActiveChatId && state.clientDrafts) {
          delete state.clientDrafts[clientDraftKey(state.clientActiveChatId)];
          renderClientDialogs();
        }
        notifyCurrentDraftChanged();
      }
      menu.style.display = 'none';
      textarea?.focus();
    };
  }

  updateChatMenuVisuals();
}

function updateChatMenuVisuals() {
  // 1. Silent toggle
  const miSwitch = document.getElementById('mi-switch-silent');
  const badgeSilent = document.getElementById('badge-silent');
  const chkSilent = document.getElementById('client-input-silent');
  if (miSwitch) miSwitch.classList.toggle('checked', Boolean(state.clientSilent));
  if (badgeSilent) badgeSilent.style.display = state.clientSilent ? 'inline-flex' : 'none';
  if (chkSilent) chkSilent.checked = Boolean(state.clientSilent);

  // 2. Parse mode pills
  const currentParse = state.clientParseMode || 'markdown';
  document.querySelectorAll('#seg-parsemode .seg-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.val === currentParse);
  });
  const badgeParse = document.getElementById('badge-parsemode');
  if (badgeParse) {
    if (currentParse === 'html') {
      badgeParse.textContent = 'HTML 模式';
      badgeParse.style.display = 'inline-flex';
    } else if (currentParse === 'plain') {
      badgeParse.textContent = '纯文本';
      badgeParse.style.display = 'inline-flex';
    } else {
      badgeParse.style.display = 'none';
    }
  }
  const selParse = document.getElementById('client-input-parsemode');
  if (selParse) selParse.value = currentParse;

  // 3. Send mode pills
  const currentSendMode = state.chatSendKeyMode || 'enter';
  document.querySelectorAll('#seg-sendmode .seg-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.val === currentSendMode);
  });
  const badgeSend = document.getElementById('badge-sendmode');
  if (badgeSend) {
    badgeSend.style.display = currentSendMode === 'ctrlEnter' ? 'inline-flex' : 'none';
  }
  const selSend = document.getElementById('client-input-sendmode');
  if (selSend) selSend.value = currentSendMode;
}

const EMOJI_CATEGORIES = {
  smileys: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬'],
  gestures: ['👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦵','🦶','👂','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵'],
  animals: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🐙','🦑','🦐','🦀','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐫','🦒'],
  food: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🥦','🥒','🌶️','🌽','🥕','🥐','🍞','🥨','🧀','🍳','🥞','🥓','🍔','🍟','🍕','🥪','🌮','🌯','🥗','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍧','🍨','🍦','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🥜'],
  activities: ['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🏸','🏒','🏏','🪃','⛳','🪁','🎣','🥊','🥋','🎽','🛹','🛼','🎿','🏂','🏋️','🤼','🤸','⛹️','🤺','🏄','🏊','🧗','🚴','🏇','🏆','🥇','🥈','🥉','🎖️','🎪','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎲','🎯','🎮'],
  travel: ['🚗','🚕','🚙','🚌','🏎️','🚓','🚑','🚒','🚐','🚚','🚜','🛴','🚲','🛵','🏍️','🚨','✈️','🛫','🛬','🚀','🛸','🚁','⛵','🚤','🛳️','🚢','⚓','⛽','🚥','🛑','🚧','🏕️','🏠','🏡','🏢','🏬','🏥','🏦','🏨','🏪','🏫','🏛️'],
  objects: ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🕹️','💿','📼','📷','📹','🎥','📞','☎️','📺','📻','🎙️','⏱️','⏰','🕰️','💡','🔦','🕯️','🧯','💸','💵','💰','💳','💎','⚖️','🔧','🔨','🛠️','🔫','💣','🗡️','🛡️','🔮','💈'],
  symbols: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❣️','💕','💞','💓','💗','💖','💘','💝','☮️','✝️','☪️','🕉️','☸️','✡️','⚡','🔥','💥','✨','🌟','⭐','🌈','☀️','🌤️','⛅','🌧️','⛈️','❄️','☃️','💨','💧','🫧','💤','💢','🛑','⛔','⭕','❌','❓','❗'],
  flags: ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏴‍☠️','🇨🇳','🇭🇰','🇲🇴','🇹🇼','🇺🇸','🇬🇧','🇯🇵','🇰🇷','🇩🇪','🇫🇷','🇮🇹','🇪🇸','🇷🇺','🇨🇦','🇦🇺']
};

let customEmojiSearchRequest = 0;
let emojiKeywordSearchRequest = 0;
let emojiKeywordSearchTimer;
let emojiCatalogInstance = '';
let emojiCatalogGroups = [];
let emojiCatalogRequest = 0;
function isSingleEmojiQuery(value) {
  if (typeof value !== 'string' || !value || value.length > 32 || /\s/u.test(value) ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) return false;
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1; }
  catch { return [...value].length <= 8; }
}

function getEmojiPickerGroups() {
  const remote = emojiCatalogInstance && emojiCatalogInstance === String(state.clientSelectedInstance || '') ? emojiCatalogGroups : [];
  const groups = remote.length ? remote.map((group, index) => ({
    id: `telegram-${index}`, icon: group.emoticons[0] || '😀', name: group.title, emoticons: group.emoticons,
  })) : [
    { id: 'smileys', icon: '😀', name: '人物与表情', emoticons: EMOJI_CATEGORIES.smileys },
    { id: 'gestures', icon: '👍', name: '手势', emoticons: EMOJI_CATEGORIES.gestures },
    { id: 'animals', icon: '🐱', name: '动物', emoticons: EMOJI_CATEGORIES.animals },
    { id: 'food', icon: '🍎', name: '食物', emoticons: EMOJI_CATEGORIES.food },
    { id: 'activities', icon: '⚽', name: '活动', emoticons: EMOJI_CATEGORIES.activities },
    { id: 'travel', icon: '🚗', name: '旅行', emoticons: EMOJI_CATEGORIES.travel },
    { id: 'objects', icon: '💡', name: '物品', emoticons: EMOJI_CATEGORIES.objects },
    { id: 'symbols', icon: '❤️', name: '符号', emoticons: EMOJI_CATEGORIES.symbols },
    { id: 'flags', icon: '🚩', name: '旗帜', emoticons: EMOJI_CATEGORIES.flags },
  ];
  return [{ id: 'recent', icon: '🕒', name: '最近使用', emoticons: getRecentEmoji() }, ...groups];
}

async function loadTelegramEmojiGroups() {
  const instId = String(state.clientSelectedInstance || '');
  if (!instId || emojiCatalogInstance === instId && emojiCatalogGroups.length) return;
  const request = ++emojiCatalogRequest;
  const epoch = expressionAccountEpoch;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/emoji-groups`);
    if (request !== emojiCatalogRequest || epoch !== expressionAccountEpoch || state.clientSelectedInstance !== instId) return;
    const groups = (Array.isArray(result) ? result : []).flatMap(group => {
      if (typeof group?.title !== 'string' || !Array.isArray(group.emoticons)) return [];
      const emoticons = [...new Set(group.emoticons.filter(value => isSingleEmojiQuery(value)))].slice(0, 400);
      return emoticons.length ? [{ title: group.title.slice(0, 80), emoticons }] : [];
    }).slice(0, 24);
    if (!groups.length) return;
    emojiCatalogInstance = instId;
    emojiCatalogGroups = groups;
    const query = String(document.getElementById('emoji-search-input')?.value || '').trim();
    if (!query && state.clientActiveExprTab === 'emoji') renderEmojiPicker(`telegram-0`);
  } catch { /* keep the bundled picker available when Telegram cannot load its catalog */ }
}

function updateEmojiPickerSearch(value = '', category) {
  const query = String(value || '').trim();
  const categoryBar = document.getElementById('emoji-category-bar');
  const results = document.getElementById('emoji-grid');
  const status = document.getElementById('emoji-keyword-search-status');
  const input = document.getElementById('emoji-search-input');
  if (!results) return;
  if (emojiKeywordSearchTimer) clearTimeout(emojiKeywordSearchTimer);
  emojiKeywordSearchTimer = undefined;
  const request = ++emojiKeywordSearchRequest;
  if (!query || isSingleEmojiQuery(query)) {
    if (categoryBar) categoryBar.hidden = false;
    if (status) { status.hidden = true; status.textContent = ''; }
    const active = category || document.querySelector('.emoji-cat-btn.active')?.dataset.cat;
    const groups = getEmojiPickerGroups();
    const selected = groups.some(group => group.id === active) ? active : (groups.find(group => group.id !== 'recent')?.id || 'recent');
    renderEmojiPicker(selected, query);
    return;
  }

  if (categoryBar) categoryBar.hidden = true;
  results.replaceChildren();
  if (status) { status.hidden = false; status.textContent = '正在搜索 Telegram Emoji…'; }
  const instId = state.clientSelectedInstance;
  if (!instId) {
    if (status) status.textContent = '选择 Telegram 账号后可按名称搜索 Emoji。';
    return;
  }
  const epoch = expressionAccountEpoch;
  emojiKeywordSearchTimer = setTimeout(() => {
    emojiKeywordSearchTimer = undefined;
    void loadEmojiKeywordResults(query, String(instId), epoch, request, input);
  }, 180);
}

async function loadEmojiKeywordResults(query, instId, epoch, request, input) {
  const status = document.getElementById('emoji-keyword-search-status');
  const isCurrent = () => request === emojiKeywordSearchRequest && epoch === expressionAccountEpoch &&
    state.clientSelectedInstance === instId && String(input?.value || '').trim() === query;
  try {
    const values = await api(`/api/instances/${encodeURIComponent(instId)}/account/emoji-search?q=${encodeURIComponent(query)}`);
    if (!isCurrent()) return;
    const emojis = Array.isArray(values) ? values : [];
    const container = document.getElementById('emoji-grid');
    if (!container) return;
    container.replaceChildren();
    let rendered = 0;
    for (const value of emojis) {
      if (!isSingleEmojiQuery(value) || rendered >= 80) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'emoji-btn';
      button.title = value; button.setAttribute('aria-label', value);
      const image = document.createElement('img'); image.className = 'emoji-img'; image.alt = value;
      image.src = getEmojiSvgUrl(value); image.loading = 'lazy';
      button.appendChild(image); button.onclick = () => insertEmoji(value);
      container.appendChild(button); rendered++;
    }
    if (status) { status.hidden = false; status.textContent = rendered ? `${rendered} 个 Emoji` : 'Telegram 没有匹配的 Emoji。'; }
  } catch (error) {
    if (isCurrent() && status) { status.hidden = false; status.textContent = `Emoji 搜索失败：${error.message}`; }
  }
}

async function searchCustomEmoji() {
  const input = document.getElementById('emoji-search-input');
  const results = document.getElementById('custom-emoji-search-results');
  const status = document.getElementById('custom-emoji-search-status');
  if (!input || !results || !status) return;
  const emoticon = String(input.value || '').trim();
  const target = { instId: state.clientSelectedInstance, chatId: Number(state.clientActiveChatId), selectionVersion: state.chatSelectionVersion };
  const request = ++customEmojiSearchRequest;
  const current = () => request === customEmojiSearchRequest && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && state.chatSelectionVersion === target.selectionVersion;
  results.replaceChildren(); status.hidden = false;
  if (!target.instId || !Number.isSafeInteger(target.chatId) || target.chatId === 0) { status.textContent = '请先打开一个聊天。'; return; }
  if (!isSingleEmojiQuery(emoticon)) { status.textContent = '请输入一个 Emoji，再搜索该表情对应的动态自定义表情。'; return; }
  status.textContent = '正在搜索当前账号可发送的自定义表情…';
  try {
    const items = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/custom-emoji-search?emoticon=${encodeURIComponent(emoticon)}`);
    if (!current()) return;
    const emojis = Array.isArray(items) ? items : [];
    let rendered = 0;
    for (const item of emojis) {
      if (!/^\d{1,20}$/.test(String(item?.id || '')) || /^0+$/.test(String(item.id))) continue;
      const emoji = typeof item.emoji === 'string' && isSingleEmojiQuery(item.emoji) ? item.emoji : emoticon;
      const entry = document.createElement('div'); entry.className = 'custom-emoji-search-entry';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'custom-emoji-search-result';
      button.title = `单独发送动态自定义表情 ${emoji}`;
      const image = document.createElement('img'); image.loading = 'lazy'; image.alt = emoji;
      image.src = `/api/instances/${encodeURIComponent(target.instId)}/account/custom-emoji?documentId=${encodeURIComponent(item.id)}`;
      button.appendChild(image); button.onclick = () => { void sendCustomEmojiSearchResult(target, request, item.id, emoji, button); };
      const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'custom-emoji-insert-result';
      insert.textContent = '+'; insert.title = `插入动态表情 ${emoji} 到消息文本`;
      insert.setAttribute('aria-label', insert.title);
      insert.onclick = event => { event.stopPropagation(); insertCustomEmojiMarkup(target, request, item.id, emoji); };
      entry.append(button, insert); results.appendChild(entry); rendered++;
    }
    status.textContent = rendered ? `找到 ${rendered} 个结果；点击表情可单独发送，点击 + 可插入消息文本。预览为静态图。` : 'Telegram 没有返回匹配的自定义表情。';
  } catch (error) { if (current()) status.textContent = `无法搜索自定义表情：${error.message}`; }
}

function insertCustomEmojiMarkup(target, request, documentId, emoji) {
  if (request !== customEmojiSearchRequest || state.clientSelectedInstance !== target.instId ||
      Number(state.clientActiveChatId) !== target.chatId || state.chatSelectionVersion !== target.selectionVersion) return;
  const textarea = document.getElementById('client-message-textarea');
  if (!textarea || state.clientParseMode === 'html') {
    showToast('请切换到 Markdown 或纯文本模式后插入动态表情', 'warn');
    return;
  }
  const token = `[${emoji}](tg://emoji?id=${encodeURIComponent(String(documentId))})`;
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const value = textarea.value || '';
  textarea.value = value.slice(0, start) + token + value.slice(end);
  const cursor = start + token.length;
  textarea.focus(); textarea.setSelectionRange(cursor, cursor);
  autoResizeTextarea(textarea);
  notifyCurrentDraftChanged();
  toggleExpressionDrawer(false);
  showToast('动态自定义表情已插入消息文本', 'success');
}

async function sendCustomEmojiSearchResult(target, request, documentId, emoticon, button) {
  const current = () => request === customEmojiSearchRequest && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && state.chatSelectionVersion === target.selectionVersion;
  if (!current() || button.disabled) return;
  button.disabled = true;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/send-custom-emoji`, 'POST', {
      chatId: target.chatId, emoticon, documentId: String(documentId),
    });
    if (!current()) return;
    toggleExpressionDrawer(false);
    showToast('动态自定义表情已发送', 'success');
  } catch (error) { if (current()) showToast(`自定义表情发送失败：${error.message}`, 'error'); }
  finally { if (current()) button.disabled = false; }
}

function renderEmojiPicker(cat = 'smileys', filter = '') {
  const container = document.getElementById('emoji-grid');
  if (!container) return;
  const cats = getEmojiPickerGroups();
  if (!cats.some(group => group.id === cat)) cat = cats.find(group => group.id !== 'recent')?.id || 'recent';

  const catBar = document.getElementById('emoji-category-bar');
  if (catBar) {
    catBar.hidden = false;
    catBar.innerHTML = '';
    for (const c of cats) {
      const catBtn = document.createElement('button');
      catBtn.type = 'button';
      catBtn.className = `emoji-cat-btn ${c.id === cat ? 'active' : ''}`;
      catBtn.dataset.cat = c.id;
      catBtn.title = c.name;
      catBtn.innerHTML = `<img class="emoji-cat-img" src="${getEmojiSvgUrl(c.icon)}" alt="${c.name}" />`;
      catBtn.onclick = () => {
        document.querySelectorAll('.emoji-cat-btn').forEach((b) => b.classList.remove('active'));
        catBtn.classList.add('active');
        updateEmojiPickerSearch(document.getElementById('emoji-search-input')?.value.trim(), c.id);
      };
      catBar.appendChild(catBtn);
    }
  }

  let emojis = [];
  if (filter) {
    const all = cats.filter(group => group.id !== 'recent').flatMap(group => group.emoticons);
    emojis = isSingleEmojiQuery(filter) ? [filter] : all.filter(emoji => emoji.includes(filter));
  } else {
    emojis = cats.find(group => group.id === cat)?.emoticons || [];
  }

  container.innerHTML = '';
  if (cat === 'recent' && emojis.length === 0) {
    const empty = document.createElement('div'); empty.className = 'emoji-empty-hint';
    empty.textContent = '从面板选择 Emoji 后，会显示在最近使用中。';
    container.appendChild(empty);
    return;
  }
  for (const em of emojis) {
    if (!em.trim()) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn';
    btn.title = em;
    btn.innerHTML = `<img class="emoji-img" src="${getEmojiSvgUrl(em)}" alt="${em}" loading="lazy" />`;
    btn.onclick = () => insertEmoji(em);
    container.appendChild(btn);
  }
}

function recentEmojiStorageKey() {
  const instanceId = String(state.clientSelectedInstance || '');
  return instanceId ? `tguserbot:recent-emoji:v1:${encodeURIComponent(instanceId)}` : '';
}

function getRecentEmoji() {
  const key = recentEmojiStorageKey();
  if (!key) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? [...new Set(stored.filter(value => isSingleEmojiQuery(value)))].slice(0, 36) : [];
  } catch { return []; }
}

function recordRecentEmoji(emoji) {
  const key = recentEmojiStorageKey();
  if (!key || !isSingleEmojiQuery(emoji)) return;
  const recent = [emoji, ...getRecentEmoji().filter(value => value !== emoji)].slice(0, 36);
  try { localStorage.setItem(key, JSON.stringify(recent)); } catch { /* recent emoji remain optional if local storage is unavailable */ }
  if (document.querySelector('.emoji-cat-btn.active')?.dataset.cat === 'recent') renderEmojiPicker('recent');
}

function insertEmoji(emoji) {
  const textarea = document.getElementById('client-message-textarea');
  if (!textarea) return;
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const val = textarea.value;
  textarea.value = val.substring(0, start) + emoji + val.substring(end);
  const newPos = start + emoji.length;
  textarea.focus();
  textarea.setSelectionRange(newPos, newPos);
  recordRecentEmoji(emoji);
}

function toggleExpressionDrawer(open) {
  const drawer = document.getElementById('client-expression-drawer');
  const toggleBtn = document.getElementById('btn-chat-expression-toggle');
  const profileDrawer = document.getElementById('client-drawer');
  if (!drawer) return;

  const willOpen = typeof open === 'boolean' ? open : (drawer.style.display === 'none' || !drawer.classList.contains('open'));

  if (willOpen) {
    if (profileDrawer) {
      profileDrawer.style.display = 'none';
      profileDrawer.classList.remove('open');
    }
    drawer.style.display = 'flex';
    drawer.classList.add('open');
    toggleBtn?.classList.add('active');

    switchExpressionTab(state.clientActiveExprTab || 'emoji');
  } else {
    drawer.style.display = 'none';
    drawer.classList.remove('open');
    toggleBtn?.classList.remove('active');
  }
}

function switchExpressionTab(tabName) {
  state.clientActiveExprTab = tabName;
  document.querySelectorAll('#client-expression-drawer .drawer-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });

  const emojiPane = document.getElementById('drawer-tab-emoji');
  const stickersPane = document.getElementById('drawer-tab-stickers');
  const gifsPane = document.getElementById('drawer-tab-gifs');

  if (emojiPane) emojiPane.style.display = tabName === 'emoji' ? 'flex' : 'none';
  if (stickersPane) stickersPane.style.display = tabName === 'stickers' ? 'flex' : 'none';
  if (gifsPane) gifsPane.style.display = tabName === 'gifs' ? 'flex' : 'none';

  if (tabName === 'emoji') {
    void loadTelegramEmojiGroups();
    updateEmojiPickerSearch(document.getElementById('emoji-search-input')?.value.trim());
  } else if (tabName === 'stickers') {
    loadClientStickers();
  } else if (tabName === 'gifs') {
    loadClientGifs();
  }
}

let expressionAccountEpoch = 0;
let stickerLoadRequest = 0;
let stickerSearchRequest = 0;
let gifLoadRequest = 0;
let gifSearchRequest = 0;
let gifSearchTimer;
let gifSearchNextOffset = '';
let gifSearchHasMore = false;
let stickerModalRequest = 0;

function resetClientExpressions() {
  expressionAccountEpoch++;
  emojiKeywordSearchRequest++;
  emojiCatalogRequest++;
  emojiCatalogInstance = '';
  emojiCatalogGroups = [];
  if (emojiKeywordSearchTimer) clearTimeout(emojiKeywordSearchTimer);
  emojiKeywordSearchTimer = undefined;
  stickerLoadRequest++;
  stickerSearchRequest++;
  gifLoadRequest++;
  gifSearchRequest++;
  if (gifSearchTimer) clearTimeout(gifSearchTimer);
  gifSearchTimer = undefined;
  gifSearchNextOffset = '';
  gifSearchHasMore = false;
  stickerModalRequest++;
  state.clientStickerPacks = null;
  state.clientStickerCollections = null;
  state.clientGifs = null;
  state.activeStickerPackDetails = null;
  const modal = document.getElementById('modal-sticker-pack');
  if (modal) modal.style.display = 'none';
  for (const id of ['emoji-grid', 'emoji-keyword-search-status', 'stickers-stream-container', 'stickers-bottom-switcher', 'sticker-search-results', 'sticker-search-status', 'gifs-stream-container', 'gif-search-results', 'gif-search-status']) {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.replaceChildren?.(); el.hidden = id === 'emoji-keyword-search-status' || id === 'sticker-search-status' || id === 'gif-search-status'; }
  }
  const emojiCategoryBar = document.getElementById('emoji-category-bar'); if (emojiCategoryBar) emojiCategoryBar.hidden = false;
  const emojiKeywordStatus = document.getElementById('emoji-keyword-search-status'); if (emojiKeywordStatus) emojiKeywordStatus.textContent = '';
  const emojiSearch = document.getElementById('emoji-search-input'); if (emojiSearch) emojiSearch.value = '';
  if (state.clientActiveExprTab === 'emoji') { renderEmojiPicker(); void loadTelegramEmojiGroups(); }
  const gifSearch = document.getElementById('gif-search-input'); if (gifSearch) gifSearch.value = '';
  const gifMore = document.getElementById('btn-more-gif-search'); if (gifMore) gifMore.hidden = true;
  const stickerSearchButton = document.getElementById('btn-search-telegram-stickers');
  if (stickerSearchButton) stickerSearchButton.disabled = false;
}

function reloadClientExpressionsIfOpen() {
  const drawer = document.getElementById('client-expression-drawer');
  if (!drawer || drawer.style.display === 'none' || !drawer.classList.contains('open')) return;
  if (state.clientActiveExprTab === 'emoji') void loadTelegramEmojiGroups();
  else if (state.clientActiveExprTab === 'stickers') void loadClientStickers();
  else if (state.clientActiveExprTab === 'gifs') void loadClientGifs();
}

async function loadClientStickers() {
  const instId = state.clientSelectedInstance;
  const container = document.getElementById('stickers-stream-container');
  const switcher = document.getElementById('stickers-bottom-switcher');
  if (!instId || !container || !switcher) return;
  const request = ++stickerLoadRequest;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch && request === stickerLoadRequest;

  if (Array.isArray(state.clientStickerPacks) && state.clientStickerCollections) {
    renderStickerStream();
    return;
  }

  container.innerHTML = '<div class="empty-hint">正在加载 Telegram 表情包...</div>';
  switcher.innerHTML = '';

  try {
    const [packs, collections] = await Promise.all([
      api(`/api/instances/${encodeURIComponent(instId)}/account/stickers`),
      api(`/api/instances/${encodeURIComponent(instId)}/account/sticker-collections`),
    ]);
    if (!isCurrent()) return;

    const detailedPacks = [];
    for (const pack of (Array.isArray(packs) ? packs : []).slice(0, 16)) {
      try {
        const details = await api(`/api/instances/${instId}/account/sticker-set?setId=${pack.id}&accessHash=${pack.accessHash}`);
        if (!isCurrent()) return;
        if (details && details.stickers && details.stickers.length > 0) {
          detailedPacks.push(details);
        }
      } catch (err) {
        if (!isCurrent()) return;
        console.warn('Failed to load pack details:', pack.title, err);
      }
    }

    state.clientStickerPacks = detailedPacks;
    state.clientStickerCollections = {
      favorites: Array.isArray(collections?.favorites) ? collections.favorites : [],
      recent: Array.isArray(collections?.recent) ? collections.recent : [],
    };
    renderStickerStream();
  } catch (err) {
    if (!isCurrent()) return;
    container.innerHTML = '<div class="empty-hint"></div>';
    container.firstElementChild.textContent = `加载表情包失败: ${err.message}`;
  }
}

function createStickerTile(sticker, instId, favorites) {
  const tile = document.createElement('div'); tile.className = 'sticker-tile';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'sticker-item-btn';
  button.title = sticker.emoji ? `${sticker.emoji} · 点击发送` : '点击发送贴纸';
  const image = document.createElement('img');
  image.className = 'sticker-item-img'; image.alt = sticker.emoji || 'Sticker'; image.loading = 'lazy';
  if (sticker.thumbDataUri) image.src = sticker.thumbDataUri;
  else {
    const thumbUrl = `/api/instances/${encodeURIComponent(instId)}/account/sticker-thumb?docId=${encodeURIComponent(sticker.id)}&accessHash=${encodeURIComponent(sticker.accessHash || '')}&fileRef=${encodeURIComponent(sticker.fileReference || '')}`;
    image.dataset.networkSrc = thumbUrl;
    image.dataset.networkSticker = '1';
  }
  button.appendChild(image);
  button.onclick = () => sendSticker(sticker);
  tile.appendChild(button);
  const favorited = favorites.has(String(sticker.id));
  const favorite = document.createElement('button');
  favorite.type = 'button'; favorite.className = `sticker-favorite-btn${favorited ? ' active' : ''}`;
  favorite.textContent = favorited ? '★' : '☆';
  favorite.title = favorited ? '从收藏贴纸中移除' : '添加到收藏贴纸';
  favorite.setAttribute('aria-label', favorite.title);
  favorite.onclick = event => { event.preventDefault(); event.stopPropagation(); void toggleFavoriteSticker(sticker, !favorited); };
  tile.appendChild(favorite);
  return tile;
}

async function toggleFavoriteSticker(sticker, favorite) {
  const instId = state.clientSelectedInstance;
  const epoch = expressionAccountEpoch;
  if (!instId || !state.clientStickerCollections || !/^[1-9]\d{0,19}$/.test(String(sticker?.id || '')) ||
      !/^-?\d{1,20}$/.test(String(sticker?.accessHash || ''))) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/sticker-favorite`, 'POST', {
      docId: String(sticker.id), accessHash: String(sticker.accessHash), fileReference: String(sticker.fileReference || ''), favorite,
    });
    if (instId !== state.clientSelectedInstance || epoch !== expressionAccountEpoch) return;
    const current = state.clientStickerCollections.favorites || [];
    state.clientStickerCollections.favorites = favorite
      ? [sticker, ...current.filter(item => String(item.id) !== String(sticker.id))].slice(0, 200)
      : current.filter(item => String(item.id) !== String(sticker.id));
    renderStickerStream();
    showToast(favorite ? '已加入收藏贴纸' : '已从收藏贴纸移除', 'success');
  } catch (error) {
    if (instId === state.clientSelectedInstance && epoch === expressionAccountEpoch) showToast(`更新收藏贴纸失败：${error.message}`, 'error');
  }
}

async function searchTelegramStickers(offset = 0, append = false) {
  const input = document.getElementById('stickers-search-input');
  const status = document.getElementById('sticker-search-status');
  const results = document.getElementById('sticker-search-results');
  const searchButton = document.getElementById('btn-search-telegram-stickers');
  const query = String(input?.value || '').trim();
  const instId = state.clientSelectedInstance;
  if (!instId || !status || !results || !query || query.length > 128) {
    if (status) { status.hidden = false; status.textContent = query ? '请输入 1 到 128 个字符。' : '请输入贴纸关键词后搜索 Telegram。'; }
    return;
  }
  const request = ++stickerSearchRequest;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch && request === stickerSearchRequest;
  const oldItems = append ? Array.from(results.children).filter(item => !item.dataset.loadMore) : [];
  if (!append) results.replaceChildren();
  status.hidden = false;
  status.textContent = append ? '正在加载更多贴纸…' : '正在搜索 Telegram 贴纸…';
  if (searchButton) searchButton.disabled = true;
  try {
    const page = await api(`/api/instances/${encodeURIComponent(instId)}/account/sticker-search?q=${encodeURIComponent(query)}&offset=${encodeURIComponent(offset)}&limit=40`);
    if (!isCurrent()) return;
    results.replaceChildren(...oldItems);
    const stickers = Array.isArray(page?.stickers) ? page.stickers : [];
    for (const sticker of stickers) {
      if (!/^\d{1,20}$/.test(String(sticker?.id || '')) || !/^\d{1,20}$/.test(String(sticker?.accessHash || ''))) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'sticker-item-btn';
      button.title = `${sticker.emoji || '贴纸'} · 点击发送`;
      const image = document.createElement('img');
      image.className = 'sticker-item-img'; image.alt = sticker.emoji || 'Sticker'; image.loading = 'lazy';
      if (sticker.thumbDataUri) image.src = sticker.thumbDataUri;
      else {
        const thumbUrl = `/api/instances/${encodeURIComponent(instId)}/account/sticker-thumb?docId=${encodeURIComponent(sticker.id)}&accessHash=${encodeURIComponent(sticker.accessHash)}&fileRef=${encodeURIComponent(sticker.fileReference || '')}`;
        image.dataset.networkSrc = thumbUrl;
        image.dataset.networkSticker = '1';
      }
      button.appendChild(image);
      button.onclick = () => sendSticker(sticker);
      results.appendChild(button);
    }
    const nextOffset = Number(page?.nextOffset);
    if (Number.isSafeInteger(nextOffset) && nextOffset > offset) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'btn btn-secondary btn-xs'; more.textContent = '加载更多 Telegram 贴纸'; more.dataset.loadMore = '1';
      more.onclick = () => void searchTelegramStickers(nextOffset, true);
      results.appendChild(more);
    }
    status.textContent = stickers.length ? `Telegram 搜索返回 ${stickers.length} 张贴纸。点击即可发送。` : '没有找到匹配的 Telegram 贴纸。';
  } catch (error) {
    if (isCurrent()) status.textContent = `Telegram 贴纸搜索失败：${error.message}`;
  } finally {
    if (isCurrent() && searchButton) searchButton.disabled = false;
  }
}

function renderStickerStream() {
  const container = document.getElementById('stickers-stream-container');
  const switcher = document.getElementById('stickers-bottom-switcher');
  if (!container || !switcher) return;

  const instId = state.clientSelectedInstance;
  const search = (document.getElementById('stickers-search-input')?.value || '').toLowerCase().trim();

  let packs = state.clientStickerPacks || [];
  if (search) {
    packs = packs.filter((p) => (p.set.title && p.set.title.toLowerCase().includes(search)) || (p.set.shortName && p.set.shortName.toLowerCase().includes(search)));
  }

  const collections = state.clientStickerCollections || { favorites: [], recent: [] };
  const favorites = Array.isArray(collections.favorites) ? collections.favorites : [];
  const recent = Array.isArray(collections.recent) ? collections.recent : [];
  if (packs.length === 0 && favorites.length === 0 && recent.length === 0) {
    container.innerHTML = '<div class="empty-hint">未找到匹配的表情包</div>';
    switcher.innerHTML = '';
    return;
  }

  container.innerHTML = '';
  switcher.innerHTML = '';

  const favoriteIds = new Set(favorites.map(sticker => String(sticker.id)));
  let hasActiveSwitcher = false;
  const appendCollection = (id, title, glyph, stickers) => {
    if (!stickers.length) return;
    const section = document.createElement('div'); section.className = 'sticker-pack-section'; section.id = `sticker-collection-${id}`;
    const header = document.createElement('div'); header.className = 'sticker-pack-header';
    const heading = document.createElement('span'); heading.className = 'sticker-pack-title'; heading.textContent = title;
    const count = document.createElement('span'); count.className = 'sticker-pack-count'; count.textContent = `${stickers.length} 张`;
    header.append(heading, count); section.appendChild(header);
    const grid = document.createElement('div'); grid.className = 'sticker-pack-grid';
    stickers.slice(0, 200).forEach(sticker => grid.appendChild(createStickerTile(sticker, instId, favoriteIds)));
    section.appendChild(grid); container.appendChild(section);
    const switchItem = document.createElement('button');
    switchItem.type = 'button'; switchItem.className = `pack-switcher-item${hasActiveSwitcher ? '' : ' active'}`;
    switchItem.title = title; switchItem.setAttribute('aria-label', title);
    switchItem.textContent = glyph; hasActiveSwitcher = true;
    switchItem.onclick = () => {
      document.querySelectorAll('.pack-switcher-item').forEach(item => item.classList.remove('active'));
      switchItem.classList.add('active');
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    switcher.appendChild(switchItem);
  };
  appendCollection('favorites', '收藏贴纸', '★', favorites);
  appendCollection('recent', '最近使用', '◷', recent);

  packs.forEach((p, idx) => {
    const packSection = document.createElement('div');
    packSection.className = 'sticker-pack-section';
    packSection.id = `sticker-pack-${p.set.id}`;

    const header = document.createElement('div');
    header.className = 'sticker-pack-header';
    header.style.cursor = 'pointer';
    header.title = '点击查看/管理此贴纸包';
    header.innerHTML = `
      <span class="sticker-pack-title">${escapeHtml(p.set.title)}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="sticker-pack-count">${p.stickers.length} 张</span>
        <span style="font-size:11px;color:var(--color-primary);font-weight:600;">详情 ➔</span>
      </div>
    `;
    header.onclick = () => openStickerPackModal(p.set.id, p.set.accessHash, p.set.shortName);
    packSection.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'sticker-pack-grid';

    for (const sticker of p.stickers) grid.appendChild(createStickerTile(sticker, instId, favoriteIds));

    packSection.appendChild(grid);
    container.appendChild(packSection);

    // Bottom Switcher Thumbnail (Telegram PC Desktop Horizontal Strip)
    const switchItem = document.createElement('button');
    switchItem.type = 'button';
    switchItem.className = `pack-switcher-item${!hasActiveSwitcher && idx === 0 ? ' active' : ''}`;
    if (!hasActiveSwitcher && idx === 0) hasActiveSwitcher = true;
    switchItem.title = p.set.title;

    if (p.stickers.length > 0) {
      const firstSticker = p.stickers[0];
      if (firstSticker.thumbDataUri) {
        const img = document.createElement('img');
        img.className = 'pack-switcher-img';
        img.alt = 'pack';
        img.src = firstSticker.thumbDataUri;
        switchItem.appendChild(img);
      } else {
        const thumbUrl = `/api/instances/${instId}/account/sticker-thumb?docId=${firstSticker.id}&accessHash=${firstSticker.accessHash}&fileRef=${encodeURIComponent(firstSticker.fileReference || '')}`;
        const img = document.createElement('img');
        img.className = 'pack-switcher-img';
        img.alt = 'pack';
        img.dataset.networkSrc = thumbUrl;
        img.dataset.networkSticker = '1';
        switchItem.appendChild(img);
      }
    } else {
      switchItem.innerHTML = `<span class="pack-switcher-txt">${escapeHtml(p.set.title.slice(0, 2))}</span>`;
    }

    switchItem.onclick = () => {
      document.querySelectorAll('.pack-switcher-item').forEach((item) => item.classList.remove('active'));
      switchItem.classList.add('active');
      const target = document.getElementById(`sticker-pack-${p.set.id}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    switcher.appendChild(switchItem);
  });
}

async function sendSticker(sticker) {
  if (!state.clientActiveChatId) {
    return showToast('请先在左侧选择会话', 'warn');
  }
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const reply = state.clientReplyingTo;
  const replyTo = reply ? reply.id : undefined;

  try {
    await api(`/api/instances/${instId}/account/send-sticker`, 'POST', {
      chatId,
      docId: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
      replyTo,
    });
    showToast('贴纸已发送', 'success');
    if (state.clientSelectedInstance === instId && state.clientStickerCollections) {
      const recent = state.clientStickerCollections.recent || [];
      state.clientStickerCollections.recent = [sticker, ...recent.filter(item => String(item.id) !== String(sticker.id))].slice(0, 200);
      renderStickerStream();
    }
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
      if (state.clientReplyingTo === reply) cancelReplyBanner();
      await loadClientMessages(chatId, true);
    }
  } catch (err) {
    showToast(`发送贴纸失败: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   Clipboard Image Paste & Description/Caption Handler
   ========================================================================== */

function initPasteImageSupport() {
  const textarea = document.getElementById('client-message-textarea');
  const chatPane = document.getElementById('client-chat-pane');

  const handlePaste = (e) => {
    if (!state.clientActiveChatId) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type && item.type.indexOf('image') !== -1) {
        e.preventDefault();
        e.stopPropagation();
        const file = item.getAsFile();
        if (!file) continue;
        openPasteImageModal(file);
        break;
      }
    }
  };

  if (textarea) textarea.addEventListener('paste', handlePaste);
  if (chatPane) chatPane.addEventListener('paste', handlePaste);
}

function openPasteImageModal(file) {
  const previous = state.pendingPasteFile;
  if (previous?.file && activeMediaUploads.has(previous.file)) {
    showToast('图片正在发送，请等待发送结果', 'info');
    return;
  }
  if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
  const previewUrl = URL.createObjectURL(file);
  state.pendingPasteFile = {
    file,
    previewUrl,
    fileName: file.name || `pasted_image_${Date.now()}.png`,
    size: file.size,
    type: file.type || 'image/png',
  };

  const modal = document.getElementById('modal-paste-image');
  const img = document.getElementById('paste-image-preview');
  const info = document.getElementById('paste-image-info');
  const caption = document.getElementById('paste-image-caption');
  const textarea = document.getElementById('client-message-textarea');

  if (img) img.src = previewUrl;
  if (info) info.textContent = `${(file.size / 1024).toFixed(1)} KB · ${file.type || 'image/png'}`;
  if (caption) {
    caption.value = textarea?.value?.trim() || '';
    if (textarea) textarea.value = '';
    setTimeout(() => caption.focus(), 100);
  }
  if (modal) modal.style.display = 'flex';
}

function closePasteImageModal() {
  const pending = state.pendingPasteFile;
  const active = pending?.file && activeMediaUploads.get(pending.file);
  if (active?.phase === 'sending') {
    showToast('图片正在发送至 Telegram，请等待发送结果', 'info');
    return;
  }
  if (active) active.xhr.abort();
  if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl);
  state.pendingPasteFile = null;
  const modal = document.getElementById('modal-paste-image');
  if (modal) modal.style.display = 'none';
  const img = document.getElementById('paste-image-preview');
  if (img) img.src = '';
  const caption = document.getElementById('paste-image-caption');
  if (caption) caption.value = '';
}

async function sendPastedImage() {
  if (!state.pendingPasteFile || !state.clientActiveChatId) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const file = state.pendingPasteFile;
  const caption = (document.getElementById('paste-image-caption')?.value || '').trim();
  const reply = state.clientReplyingTo;
  const replyTo = reply ? reply.id : undefined;
  const parseMode = state.clientParseMode;
  const silent = Boolean(state.clientSilent);

  const btn = document.getElementById('btn-paste-image-send');
  if (file.size > 2 * 1024 * 1024 * 1024) return showToast('图片超过 2 GiB，请选择较小的图片', 'error');
  if (pendingMediaSends.has(file.file)) return;
  pendingMediaSends.add(file.file);
  if (btn) btn.disabled = true;

  try {
    showToast('正在发送图片...', 'info');
    await sendMediaStream(`/api/instances/${encodeURIComponent(instId)}/account/send-media`, file.file, {
      chatId,
      mediaType: 'photo',
      fileName: file.fileName,
      caption,
      replyTo,
      parseMode,
      silent,
    }, (phase, percent) => {
      if (state.pendingPasteFile !== file) return;
      const info = document.getElementById('paste-image-info');
      if (info) info.textContent = phase === 'sending' ? '正在发送至 Telegram…' : `上传到服务器 ${percent}%`;
    });

    showToast('图片发送成功', 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
      if (state.pendingPasteFile === file) closePasteImageModal();
      if (state.clientReplyingTo === reply) cancelReplyBanner();
      await loadClientMessages(chatId, true);
    }
  } catch (err) {
    showToast(`发送图片失败: ${err.message}`, 'error');
  } finally {
    pendingMediaSends.delete(file.file);
    if (btn) btn.disabled = false;
  }
}

/* ==========================================================================
   Sticker Pack Preview & Install / Uninstall Modal
   ========================================================================== */

async function openStickerPackModal(setId, accessHash, shortName) {
  const instId = state.clientSelectedInstance;
  if (!instId) return;
  const request = ++stickerModalRequest;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch && request === stickerModalRequest;

  const modal = document.getElementById('modal-sticker-pack');
  const titleEl = document.getElementById('sticker-pack-modal-title');
  const nameEl = document.getElementById('sticker-pack-name');
  const subtextEl = document.getElementById('sticker-pack-subtext');
  const badgeEl = document.getElementById('sticker-pack-modal-badge');
  const actionBtn = document.getElementById('btn-sticker-pack-action');
  const gridEl = document.getElementById('sticker-pack-grid');

  if (modal) modal.style.display = 'flex';
  if (actionBtn) actionBtn.disabled = false;
  if (nameEl) nameEl.textContent = '加载贴纸包详情中...';
  if (subtextEl) subtextEl.textContent = '';
  if (gridEl) gridEl.innerHTML = '<div class="empty-hint" style="grid-column: 1/-1;">正在加载贴纸...</div>';

  try {
    let url = `/api/instances/${instId}/account/sticker-set?`;
    if (setId && accessHash) {
      url += `setId=${setId}&accessHash=${accessHash}`;
    } else if (shortName) {
      url += `shortName=${encodeURIComponent(shortName)}`;
    } else {
      throw new Error('未提供贴纸包标识');
    }

    const details = await api(url);
    if (!isCurrent()) return;
    state.activeStickerPackDetails = details;

    const packSet = details.set || details;
    if (nameEl) nameEl.textContent = packSet.title || shortName || '贴纸包';
    if (subtextEl) subtextEl.textContent = `@${packSet.shortName || shortName || 'pack'} · ${(details.stickers || []).length} 个表情`;

    const isInstalled = Boolean(packSet.installed || packSet.isInstalled);
    state.activeStickerPackIsInstalled = isInstalled;
    updateStickerPackModalAction(isInstalled);

    if (gridEl) {
      gridEl.innerHTML = '';
      const stickers = details.stickers || [];
      stickers.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'sticker-pack-grid-item';
        item.title = s.emoji ? `${s.emoji} (点击快捷发送)` : '点击快捷发送';

        const img = document.createElement('img');
        img.alt = s.emoji || 'Sticker';
        img.loading = 'lazy';
        if (s.thumbDataUri) {
          img.src = s.thumbDataUri;
        } else {
          const thumbUrl = `/api/instances/${instId}/account/sticker-thumb?docId=${s.id}&accessHash=${s.accessHash}&fileRef=${encodeURIComponent(s.fileReference || '')}`;
          img.dataset.networkSrc = thumbUrl;
          img.dataset.networkSticker = '1';
        }
        item.appendChild(img);

        item.onclick = async () => {
          if (state.clientActiveChatId) {
            await sendSticker(s);
            if (isCurrent()) closeStickerPackModal();
          }
        };

        gridEl.appendChild(item);
      });
    }
  } catch (err) {
    if (!isCurrent()) return;
    if (nameEl) nameEl.textContent = '加载失败';
    if (gridEl) {
      gridEl.innerHTML = '<div class="empty-hint" style="grid-column: 1/-1;"></div>';
      gridEl.firstElementChild.textContent = err.message;
    }
  }
}

function updateStickerPackModalAction(isInstalled) {
  const badgeEl = document.getElementById('sticker-pack-modal-badge');
  const actionBtn = document.getElementById('btn-sticker-pack-action');

  if (badgeEl) {
    if (isInstalled) {
      badgeEl.className = 'badge badge-installed';
      badgeEl.textContent = '已安装';
    } else {
      badgeEl.className = 'badge badge-not-installed';
      badgeEl.textContent = '未安装';
    }
  }

  if (actionBtn) {
    if (isInstalled) {
      actionBtn.className = 'btn btn-secondary btn-sm';
      actionBtn.innerHTML = '🗑️ 从我的表情中移除';
    } else {
      actionBtn.className = 'btn btn-primary btn-sm';
      actionBtn.innerHTML = '➕ 添加到我的表情';
    }
  }
}

async function toggleInstallStickerPack() {
  const details = state.activeStickerPackDetails;
  if (!details) return;
  const instId = state.clientSelectedInstance;
  const request = stickerModalRequest;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch && request === stickerModalRequest;
  const isInstalled = state.activeStickerPackIsInstalled;
  const actionBtn = document.getElementById('btn-sticker-pack-action');
  if (actionBtn) actionBtn.disabled = true;

  const packSet = details.set || details;
  const setId = packSet.id;
  const accessHash = packSet.accessHash;

  try {
    if (isInstalled) {
      await api(`/api/instances/${instId}/account/stickers/uninstall`, 'POST', { setId, accessHash });
      if (!isCurrent()) return;
      state.activeStickerPackIsInstalled = false;
      updateStickerPackModalAction(false);
      showToast('贴纸包已从账号移除', 'success');
    } else {
      await api(`/api/instances/${instId}/account/stickers/install`, 'POST', { setId, accessHash });
      if (!isCurrent()) return;
      state.activeStickerPackIsInstalled = true;
      updateStickerPackModalAction(true);
      showToast('贴纸包已成功添加到账号', 'success');
    }
    state.clientStickerPacks = null;
    loadClientStickers();
  } catch (err) {
    if (isCurrent()) showToast(`操作失败: ${err.message}`, 'error');
  } finally {
    if (actionBtn && isCurrent()) actionBtn.disabled = false;
  }
}

function closeStickerPackModal() {
  stickerModalRequest++;
  state.activeStickerPackDetails = null;
  const modal = document.getElementById('modal-sticker-pack');
  if (modal) modal.style.display = 'none';
}

async function loadClientGifs() {
  const instId = state.clientSelectedInstance;
  const container = document.getElementById('gifs-stream-container');
  if (!instId || !container) return;
  const request = ++gifLoadRequest;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch && request === gifLoadRequest;

  if (state.clientGifs && state.clientGifs.length > 0) {
    renderGifStream();
    if (document.getElementById('gif-search-input')?.value.trim()) queueClientGifSearch();
    return;
  }

  container.innerHTML = '<div class="empty-hint">正在获取收藏的 GIF 动图...</div>';

  try {
    const gifs = await api(`/api/instances/${instId}/account/gifs`);
    if (!isCurrent()) return;
    state.clientGifs = Array.isArray(gifs) ? gifs : [];
    renderGifStream();
    if (document.getElementById('gif-search-input')?.value.trim()) queueClientGifSearch();
  } catch (err) {
    if (!isCurrent()) return;
    container.innerHTML = '<div class="empty-hint"></div>';
    container.firstElementChild.textContent = `加载 GIF 失败: ${err.message}`;
  }
}

function queueClientGifSearch() {
  gifSearchRequest++;
  const request = gifSearchRequest;
  if (gifSearchTimer) clearTimeout(gifSearchTimer);
  gifSearchTimer = undefined;
  gifSearchNextOffset = '';
  gifSearchHasMore = false;
  const input = document.getElementById('gif-search-input');
  const results = document.getElementById('gif-search-results');
  const status = document.getElementById('gif-search-status');
  const more = document.getElementById('btn-more-gif-search');
  if (results) results.replaceChildren();
  if (more) { more.hidden = true; more.disabled = false; }
  const query = String(input?.value || '').trim();
  if (!query) { if (status) { status.hidden = true; status.textContent = ''; } return; }
  if (status) { status.hidden = false; status.textContent = '正在搜索 Telegram GIF…'; }
  gifSearchTimer = setTimeout(() => {
    gifSearchTimer = undefined;
    if (request === gifSearchRequest) void loadClientGifSearch(true, request);
  }, 250);
}

function refreshClientGifSearch() {
  const drawer = document.getElementById('client-expression-drawer');
  if (!drawer || !drawer.classList.contains('open') || state.clientActiveExprTab !== 'gifs') return;
  if (document.getElementById('gif-search-input')?.value.trim()) queueClientGifSearch();
}

async function loadClientGifSearch(reset = true, expectedRequest) {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const query = String(document.getElementById('gif-search-input')?.value || '').trim();
  const results = document.getElementById('gif-search-results');
  const status = document.getElementById('gif-search-status');
  const more = document.getElementById('btn-more-gif-search');
  if (!results || !status || !more) return;
  if (gifSearchTimer) clearTimeout(gifSearchTimer);
  gifSearchTimer = undefined;
  const request = Number.isSafeInteger(expectedRequest) ? expectedRequest : ++gifSearchRequest;
  if (!query || query.length > 128) {
    if (reset) results.replaceChildren();
    status.hidden = !query;
    status.textContent = query ? '搜索词最多 128 个字符。' : '';
    more.hidden = true;
    return;
  }
  if (!instId || chatId == null) {
    status.hidden = false; status.textContent = '请先选择一个会话，再搜索 GIF。';
    more.hidden = true; more.disabled = false;
    return;
  }
  const selectionVersion = state.chatSelectionVersion;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => request === gifSearchRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion &&
    expressionAccountEpoch === epoch && String(document.getElementById('gif-search-input')?.value || '').trim() === query;
  const offset = reset ? '' : gifSearchNextOffset;
  if (!reset && !offset) return;
  if (reset) { gifSearchNextOffset = ''; gifSearchHasMore = false; results.replaceChildren(); }
  status.hidden = false; status.textContent = reset ? '正在搜索 Telegram GIF…' : '正在加载更多 GIF…';
  more.disabled = true;
  try {
    const params = new URLSearchParams({ chatId: String(chatId), q: query, ...(offset ? { offset } : {}) });
    const page = await api(`/api/instances/${encodeURIComponent(instId)}/account/gifs/search?${params}`);
    if (!isCurrent()) return;
    const items = Array.isArray(page?.results) ? page.results : [];
    renderSearchedGifs(items, !reset);
    gifSearchNextOffset = typeof page?.nextOffset === 'string' ? page.nextOffset : '';
    gifSearchHasMore = Boolean(gifSearchNextOffset);
    status.textContent = results.children.length ? `${results.children.length} 个 GIF${gifSearchHasMore ? ' · 可继续加载' : ''}` : '没有找到 GIF。';
    more.hidden = !gifSearchHasMore;
  } catch (error) {
    if (isCurrent()) { status.textContent = `GIF 搜索失败：${error.message}`; more.hidden = !gifSearchNextOffset; }
  } finally {
    if (isCurrent()) more.disabled = false;
  }
}

function renderSearchedGifs(items, append = false) {
  const container = document.getElementById('gif-search-results');
  if (!container) return;
  if (!append) container.replaceChildren();
  const instId = state.clientSelectedInstance;
  const searchTarget = { instId, chatId: state.clientActiveChatId, selectionVersion: state.chatSelectionVersion };
  for (const gif of Array.isArray(items) ? items : []) {
    if (!gif || !/^[A-Za-z0-9_-]{32}$/.test(String(gif.token || '')) || !/^[A-Za-z0-9_-]{32}$/.test(String(gif.saveToken || '')) ||
        !/^\d{1,20}$/.test(String(gif.id || '')) || !/^-?\d{1,20}$/.test(String(gif.accessHash || '')) ||
        !['video/mp4', 'video/webm'].includes(gif.mimeType)) continue;
    const card = document.createElement('div'); card.className = 'gif-item-card gif-search-card'; card.setAttribute('role', 'button'); card.tabIndex = 0;
    card.title = `发送 GIF：${String(gif.title || 'GIF').slice(0, 128)}`;
    const params = new URLSearchParams({ docId: String(gif.id), accessHash: String(gif.accessHash),
      fileReference: String(gif.fileReference || ''), mimeType: gif.mimeType });
    const video = document.createElement('video');
    video.src = `/api/instances/${encodeURIComponent(instId)}/account/gif-preview?${params}`;
    video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true; video.preload = 'metadata';
    video.setAttribute('aria-hidden', 'true'); video.tabIndex = -1;
    const badge = document.createElement('span'); badge.className = 'gif-item-badge'; badge.textContent = 'GIF';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'gif-save-toggle';
    const alreadySaved = (state.clientGifs || []).some(item => String(item.id) === String(gif.id));
    save.textContent = alreadySaved ? '✓' : '☆'; save.disabled = alreadySaved;
    save.title = alreadySaved ? '已收藏' : '收藏 GIF'; save.setAttribute('aria-label', save.title);
    save.onclick = event => { event.stopPropagation(); if (!alreadySaved) void saveSearchedGif(gif, searchTarget, save); };
    card.append(video, badge, save); card.onclick = () => {
      if (state.clientSelectedInstance !== searchTarget.instId || String(state.clientActiveChatId) !== String(searchTarget.chatId) ||
          state.chatSelectionVersion !== searchTarget.selectionVersion) return showToast('会话已切换，请重新搜索 GIF。', 'warn');
      void sendSearchedGif(gif, searchTarget);
    };
    card.onkeydown = event => {
      if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault(); card.onclick();
    };
    container.appendChild(card);
  }
}

function renderGifStream() {
  const container = document.getElementById('gifs-stream-container');
  if (!container) return;
  const instId = state.clientSelectedInstance;
  const gifs = state.clientGifs || [];

  if (gifs.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无收藏的 GIF 动图</div>';
    return;
  }

  container.innerHTML = '';
  for (const g of gifs) {
    const card = document.createElement('div');
    card.className = 'gif-item-card';
    card.title = '点击快捷发送动图';

    const thumbUrl = `/api/instances/${instId}/account/sticker-thumb?docId=${g.id}&accessHash=${g.accessHash}&fileRef=${encodeURIComponent(g.fileReference)}`;
    const img = document.createElement('img');
    img.dataset.networkSrc = thumbUrl;
    img.alt = 'GIF';
    img.loading = 'lazy';
    const badge = document.createElement('span');
    badge.className = 'gif-item-badge';
    badge.textContent = 'GIF';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'gif-save-toggle';
    remove.textContent = '−'; remove.title = '从收藏中移除'; remove.setAttribute('aria-label', '从收藏中移除 GIF');
    remove.onclick = event => { event.stopPropagation(); void removeSavedGif(g, remove); };
    card.append(img, badge, remove);

    card.onclick = () => sendGif(g);
    container.appendChild(card);
  }
}

async function saveSearchedGif(gif, target, button) {
  if (!target || state.clientSelectedInstance !== target.instId || String(state.clientActiveChatId) !== String(target.chatId) ||
      state.chatSelectionVersion !== target.selectionVersion || !/^[A-Za-z0-9_-]{32}$/.test(String(gif?.saveToken || ''))) {
    return showToast('搜索结果已过期，请重新搜索。', 'warn');
  }
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === target.instId && String(state.clientActiveChatId) === String(target.chatId) &&
    state.chatSelectionVersion === target.selectionVersion && expressionAccountEpoch === epoch;
  button.disabled = true;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/gifs/save-search-result`, 'POST', {
      chatId: target.chatId, token: gif.saveToken,
    });
    if (!isCurrent()) return;
    state.clientGifs = Array.isArray(state.clientGifs) ? state.clientGifs : [];
    if (!state.clientGifs.some(item => String(item.id) === String(gif.id))) state.clientGifs.push({
      id: String(gif.id), accessHash: String(gif.accessHash), fileReference: String(gif.fileReference || ''),
      mimeType: gif.mimeType, duration: gif.duration, width: gif.width, height: gif.height,
    });
    button.textContent = '✓'; button.title = '已收藏'; button.setAttribute('aria-label', '已收藏');
    showToast('GIF 已添加到收藏', 'success');
    renderGifStream();
  } catch (error) {
    if (isCurrent()) { button.disabled = false; showToast(`收藏 GIF 失败：${error.message}`, 'error'); }
  }
}

async function removeSavedGif(gif, button) {
  const instId = state.clientSelectedInstance;
  if (!instId || !gif) return;
  const epoch = expressionAccountEpoch;
  const isCurrent = () => state.clientSelectedInstance === instId && expressionAccountEpoch === epoch;
  button.disabled = true;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/gifs/remove-saved`, 'POST', {
      docId: String(gif.id), accessHash: String(gif.accessHash), fileReference: String(gif.fileReference || ''),
    });
    if (!isCurrent()) return;
    state.clientGifs = (state.clientGifs || []).filter(item => String(item.id) !== String(gif.id));
    renderGifStream();
    showToast('GIF 已从收藏中移除', 'success');
  } catch (error) {
    if (isCurrent()) { button.disabled = false; showToast(`移除收藏失败：${error.message}`, 'error'); }
  }
}

async function sendGif(gif) {
  if (!state.clientActiveChatId) {
    return showToast('请先在左侧选择会话', 'warn');
  }
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const selectionVersion = state.chatSelectionVersion;
  const reply = state.clientReplyingTo;
  const replyTo = reply ? reply.id : undefined;

  try {
    await api(`/api/instances/${instId}/account/send-gif`, 'POST', {
      chatId,
      docId: gif.id,
      accessHash: gif.accessHash,
      fileReference: gif.fileReference,
      replyTo,
    });
    showToast('动图已发送', 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
      if (state.clientReplyingTo === reply) cancelReplyBanner();
      await loadClientMessages(chatId, true);
    }
  } catch (err) {
    showToast(`发送动图失败: ${err.message}`, 'error');
  }
}

async function sendSearchedGif(gif, target) {
  if (!state.clientActiveChatId) return showToast('请先在左侧选择会话', 'warn');
  if (!target || state.clientSelectedInstance !== target.instId || String(state.clientActiveChatId) !== String(target.chatId) ||
      state.chatSelectionVersion !== target.selectionVersion) return showToast('会话已切换，请重新搜索 GIF。', 'warn');
  const instId = target.instId, chatId = target.chatId;
  const selectionVersion = state.chatSelectionVersion;
  const reply = state.clientReplyingTo;
  if (!gif?.token || !instId) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/send-searched-gif`, 'POST', {
      chatId, token: gif.token, replyTo: reply ? reply.id : undefined,
    });
    showToast('GIF 已发送', 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId) && state.chatSelectionVersion === selectionVersion) {
      if (state.clientReplyingTo === reply) cancelReplyBanner();
      await loadClientMessages(chatId, true);
    }
  } catch (error) { showToast(`GIF 发送失败：${error.message}`, 'error'); }
}

window.chatWs = new ChatWSManager();

// ==========================================
// Miuix Message Context Menu (Desktop Right-Click & Mobile Long-Press)
// ==========================================
let messageSpeechTargetKey = null;
let messageSpeechRunId = 0;

function messageSpeechKey(target) {
  if (!target || typeof target.instId !== 'string' || !target.instId ||
      !Number.isSafeInteger(Number(target.chatId)) || !Number.isSafeInteger(Number(target.id))) return null;
  return `${target.instId}:${Number(target.chatId)}:${Number(target.id)}`;
}

function refreshMessageSpeechButton() {
  const label = document.getElementById('menu-action-read-aloud-text');
  if (!label) return;
  const active = messageSpeechTargetKey && activeContextMsg &&
    messageSpeechTargetKey === messageSpeechKey(activeContextMsg);
  label.textContent = active ? '停止朗读' : '朗读消息';
}

function isMessageSpeechActive(target) {
  const key = messageSpeechKey(target);
  return Boolean(key && messageSpeechTargetKey === key);
}

function toggleMessageSpeech(text, target) {
  const speech = window.speechSynthesis;
  const key = messageSpeechKey(target);
  if (!key || !speech || typeof SpeechSynthesisUtterance !== 'function') return { unsupported: true };
  if (messageSpeechTargetKey === key) {
    messageSpeechRunId++;
    messageSpeechTargetKey = null;
    speech.cancel();
    refreshMessageSpeechButton();
    return { stopped: true };
  }

  messageSpeechRunId++;
  const runId = messageSpeechRunId;
  speech.cancel();
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > 220) {
    let cut = remaining.lastIndexOf(' ', 220);
    if (cut < 100) cut = remaining.lastIndexOf('\n', 220);
    if (cut < 100) cut = 220;
    if (cut > 0 && /[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1)) && /[\uDC00-\uDFFF]/.test(remaining.charAt(cut))) cut--;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  if (!chunks.length) return { empty: true };

  messageSpeechTargetKey = key;
  const lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined;
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (lang) utterance.lang = lang;
    utterance.onend = () => {
      if (messageSpeechRunId === runId && index === chunks.length - 1) {
        messageSpeechTargetKey = null;
        refreshMessageSpeechButton();
      }
    };
    utterance.onerror = () => {
      if (messageSpeechRunId === runId) {
        messageSpeechTargetKey = null;
        refreshMessageSpeechButton();
      }
    };
    speech.speak(utterance);
  });
  refreshMessageSpeechButton();
  return { stopped: false, chunks: chunks.length };
}

let activeContextMsg = null;
let availableReactionCatalog = { instId: null, chatId: null, reactions: null };
let longPressTimer = null;
let touchCoords = { x: 0, y: 0 };

function initMessageContextMenu() {
  const container = document.getElementById('client-messages-container');
  const menu = document.getElementById('msg-context-menu');
  const backdrop = document.getElementById('menu-backdrop');
  if (!container || !menu) return;
  const moreReactions = document.getElementById('btn-more-message-reactions');
  const reactionPicker = document.getElementById('msg-reaction-picker');
  const savedTagsAction = document.getElementById('menu-action-saved-tags');
  const savedTagsPicker = document.getElementById('saved-message-tag-picker');
  const reactionSearch = document.getElementById('msg-reaction-search');
  const reactionGrid = document.getElementById('msg-reaction-grid');
  const reactionStatus = document.getElementById('msg-reaction-status');
  const replaceMediaInput = document.getElementById('message-media-replace-file');
  let replacementTarget = null;
  let reactionRequest = 0;

  const isContextCurrent = (target) => Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && (state.chatSelectionVersion || 0) === target.selectionVersion);

  const renderReactionChoices = (target) => {
    if (!reactionGrid || activeContextMsg !== target) return;
    const query = String(reactionSearch?.value || '').trim().toLocaleLowerCase();
    const all = availableReactionCatalog.instId === target.instId && availableReactionCatalog.chatId === target.chatId
      ? availableReactionCatalog.reactions || [] : [];
    const matches = all.filter(item => `${item.reaction || ''} ${item.title || ''} ${item.customEmojiId || ''}`.toLocaleLowerCase().includes(query));
    reactionGrid.replaceChildren();
    for (const item of matches) {
      if (typeof item.reaction !== 'string' || !item.reaction) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'msg-reaction-choice';
      button.title = `${item.title || item.reaction}${item.premium ? ' · Premium' : ''}`;
      button.setAttribute('aria-label', button.title);
      button.disabled = item.inactive === true;
      if (/^[1-9]\d{0,19}$/.test(String(item.customEmojiId || ''))) {
        const image = document.createElement('img'); image.className = 'msg-reaction-custom-emoji'; image.alt = item.title || '自定义反应';
        image.src = `/api/instances/${encodeURIComponent(target.instId)}/account/custom-emoji?documentId=${encodeURIComponent(item.customEmojiId)}`;
        button.appendChild(image);
      } else button.textContent = item.reaction;
      button.onclick = event => { event.stopPropagation(); void sendMessageReaction(item.reaction, item.title || item.reaction); };
      reactionGrid.appendChild(button);
    }
    if (reactionStatus) reactionStatus.textContent = matches.length ? '' : (query ? '没有匹配的反应' : '当前没有可用反应');
  };

  const loadReactionChoices = async () => {
    const target = activeContextMsg;
    if (!target || !isContextCurrent(target) || !reactionPicker) return;
    const requestId = ++reactionRequest;
    reactionPicker.hidden = false;
    if (moreReactions) moreReactions.setAttribute('aria-expanded', 'true');
    if (reactionSearch) reactionSearch.value = '';
    if (availableReactionCatalog.instId === target.instId && availableReactionCatalog.chatId === target.chatId && Array.isArray(availableReactionCatalog.reactions)) {
      renderReactionChoices(target);
      return;
    }
    if (reactionStatus) reactionStatus.textContent = '正在加载反应…';
    try {
      const reactions = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/reactions?chatId=${encodeURIComponent(target.chatId)}`);
      if (requestId !== reactionRequest || activeContextMsg !== target || !isContextCurrent(target)) return;
      availableReactionCatalog = { instId: target.instId, chatId: target.chatId, reactions: Array.isArray(reactions) ? reactions : [] };
      renderReactionChoices(target);
    } catch (error) {
      if (requestId === reactionRequest && activeContextMsg === target && isContextCurrent(target) && reactionStatus) {
        reactionStatus.textContent = `反应加载失败：${error.message}`;
      }
    }
  };

  const showMenu = (x, y, msgWrap) => {
    const msgId = Number(msgWrap.dataset.msgId);
    const isOut = msgWrap.dataset.isOut === '1';
    const text = msgWrap.dataset.msgText || '';
    const isPinned = msgWrap.dataset.isPinned === '1';
    const currentMessage = (state.clientMessages || []).find(message => Number(message.id) === msgId);
    const mediaType = currentMessage?.media?.type || '';
    const activeDialog = (state.clientDialogs || []).find(dialog => Number(dialog.id) === Number(state.clientActiveChatId));
    activeContextMsg = {
      id: msgId, isOut, isPinned, isService: Boolean(currentMessage?.service), text, mediaType, wrap: msgWrap,
      instId: state.clientSelectedInstance, chatId: Number(state.clientActiveChatId),
      selectionVersion: state.chatSelectionVersion || 0,
    };
    if (savedTagsAction && savedTagsPicker) {
      const isSavedMessages = activeDialog?.isSelf === true;
      savedTagsAction.style.display = isSavedMessages ? 'flex' : 'none';
      savedTagsAction.setAttribute('aria-expanded', 'false');
      savedTagsPicker.hidden = true;
      savedTagsPicker.replaceChildren();
      if (isSavedMessages) {
        const tagTarget = { instId: state.clientSelectedInstance, chatId: Number(state.clientActiveChatId), selectionVersion: state.chatSelectionVersion || 0 };
        const choices = getSavedMessageTagChoices();
        if (!choices.length) {
          const empty = document.createElement('span'); empty.className = 'saved-message-tag-picker-empty';
          empty.textContent = '先在标签管理中检查 Telegram 可用标签'; savedTagsPicker.appendChild(empty);
        }
        for (const tag of choices) {
          const reaction = tag.reaction;
          const key = savedMessageTagKey(reaction);
          const selected = (currentMessage?.reactions || []).some(item => item.chosen &&
            (reaction.type === 'emoji' ? item.emoji === reaction.value : String(item.customEmojiId || '') === reaction.value));
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'saved-message-tag-choice';
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
          button.textContent = `${reaction.type === 'emoji' ? reaction.value : '✨'}${tag.title ? ` ${tag.title}` : ''}`;
          button.onclick = event => {
            event.stopPropagation();
            hideMenu();
            void setSavedMessageTag(tagTarget, msgId, reaction, !selected);
          };
          savedTagsPicker.appendChild(button);
        }
      }
    }
    if (reactionPicker) reactionPicker.hidden = true;
    if (savedTagsPicker) savedTagsPicker.hidden = true;
    if (savedTagsAction) savedTagsAction.setAttribute('aria-expanded', 'false');
    if (moreReactions) moreReactions.setAttribute('aria-expanded', 'false');
    if (reactionSearch) reactionSearch.value = '';
    reactionRequest++;

    // Toggle Edit button (only visible for own outgoing messages)
    const btnEdit = document.getElementById('menu-action-edit');
    if (btnEdit) {
      btnEdit.style.display = isOut && text ? 'flex' : 'none';
    }
    const btnReplaceMedia = document.getElementById('menu-action-replace-media');
    if (btnReplaceMedia) {
      btnReplaceMedia.style.display = isOut && ['photo', 'video', 'audio', 'voice', 'document', 'animation'].includes(mediaType) ? 'flex' : 'none';
    }
    const btnReport = document.getElementById('menu-action-report');
    if (btnReport) btnReport.style.display = !isOut && !currentMessage?.service ? 'flex' : 'none';

    const btnReadParticipants = document.getElementById('menu-action-read-participants');
    if (btnReadParticipants) {
      const isGroup = activeDialog && (activeDialog.type === 'group' || activeDialog.type === 'supergroup');
      btnReadParticipants.style.display = isOut && isGroup ? 'flex' : 'none';
    }

    // Toggle Copy button (only if text exists)
    const btnCopy = document.getElementById('menu-action-copy');
    if (btnCopy) {
      btnCopy.style.display = text ? 'flex' : 'none';
    }

    // Toggle Translate button (only if text exists)
    const btnTranslate = document.getElementById('menu-action-translate');
    if (btnTranslate) {
      btnTranslate.style.display = text ? 'flex' : 'none';
    }
    const btnReadAloud = document.getElementById('menu-action-read-aloud');
    if (btnReadAloud) {
      btnReadAloud.style.display = text && window.speechSynthesis && typeof SpeechSynthesisUtterance === 'function' ? 'flex' : 'none';
      refreshMessageSpeechButton();
    }

    // Toggle Pin / Unpin text
    const pinTextEl = document.getElementById('menu-action-pin-text');
    if (pinTextEl) {
      pinTextEl.innerText = isPinned ? '取消置顶' : '置顶此消息';
    }

    // Display backdrop & position menu with boundary checks
    if (backdrop) backdrop.style.display = 'block';
    menu.style.display = 'flex';
    menu.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const menuWidth = menu.offsetWidth || 210;
      const menuHeight = menu.offsetHeight || 240;
      const winWidth = window.innerWidth;
      const winHeight = window.innerHeight;

      let posX = x;
      let posY = y;

      if (posX + menuWidth > winWidth - 12) {
        posX = Math.max(12, winWidth - menuWidth - 12);
      }
      if (posY + menuHeight > winHeight - 12) {
        posY = Math.max(12, winHeight - menuHeight - 12);
      }

      menu.style.left = `${posX}px`;
      menu.style.top = `${posY}px`;
      menu.style.visibility = 'visible';
    });
  };

  const hideMenu = () => {
    if (menu) menu.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    if (reactionPicker) reactionPicker.hidden = true;
    if (moreReactions) moreReactions.setAttribute('aria-expanded', 'false');
    reactionRequest++;
    activeContextMsg = null;
  };

  const sendMessageReaction = async (reaction, label = reaction) => {
    const target = activeContextMsg;
    if (!target || typeof reaction !== 'string' || !reaction || !isContextCurrent(target)) return;
    hideMenu();
    try {
      if (window.chatWs && window.chatWs.isConnected()) {
        await window.chatWs.sendRpc('send_reaction', {
          instId: target.instId, chatId: target.chatId, messageId: target.id, reaction,
        });
      } else {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/reaction`, 'POST', {
          chatId: target.chatId, messageId: target.id, reaction,
        });
      }
      if (isContextCurrent(target)) showToast(`已回应 ${label}`, 'success');
    } catch (error) {
      if (isContextCurrent(target)) showToast(`回应失败: ${error.message}`, 'error');
    }
  };

  if (moreReactions) moreReactions.onclick = event => {
    event.stopPropagation();
    if (reactionPicker?.hidden) void loadReactionChoices();
    else {
      if (reactionPicker) reactionPicker.hidden = true;
      moreReactions.setAttribute('aria-expanded', 'false');
      reactionRequest++;
    }
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 12) {
        menu.style.top = `${Math.max(12, window.innerHeight - menu.offsetHeight - 12)}px`;
      }
    });
  };
  if (reactionSearch) reactionSearch.oninput = () => { if (activeContextMsg) renderReactionChoices(activeContextMsg); };
  if (savedTagsAction && savedTagsPicker) savedTagsAction.onclick = event => {
    event.stopPropagation();
    savedTagsPicker.hidden = !savedTagsPicker.hidden;
    savedTagsAction.setAttribute('aria-expanded', savedTagsPicker.hidden ? 'false' : 'true');
  };

  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      hideMenu();
    });
  }

  // Bind cancel edit button
  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    cancelEditBanner();
    const textarea = document.getElementById('client-message-textarea');
    if (textarea) {
      textarea.value = '';
      autoResizeTextarea(textarea);
    }
  });

  // 1. Desktop Right-Click
  container.addEventListener('contextmenu', (e) => {
    const wrap = e.target.closest('.chat-bubble-wrap');
    if (wrap && wrap.dataset.msgId) {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, wrap);
    } else {
      hideMenu();
    }
  });

  // 2. Mobile Long-Press (450ms with 40ms vibration)
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchCoords = { x: touch.clientX, y: touch.clientY };
    const wrap = e.target.closest('.chat-bubble-wrap');
    if (!wrap || !wrap.dataset.msgId) return;

    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (navigator.vibrate) {
        try { navigator.vibrate(40); } catch (_) {}
      }
      showMenu(touchCoords.x, touchCoords.y, wrap);
    }, 450);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!longPressTimer || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dist = Math.hypot(touch.clientX - touchCoords.x, touch.clientY - touchCoords.y);
    if (dist > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { passive: true });

  container.addEventListener('touchend', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  container.addEventListener('touchcancel', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  // 3. Global click / scroll dismissal
  window.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) {
      hideMenu();
    }
  });
  window.addEventListener('resize', hideMenu);
  container.addEventListener('scroll', hideMenu, { passive: true });

  // 4. Reactions
  document.querySelectorAll('.reaction-pill').forEach((btn) => {
    if (btn === moreReactions) return;
    btn.onclick = async (e) => {
      e.stopPropagation();
      const reaction = btn.dataset.reaction;
      await sendMessageReaction(reaction);
    };
  });

  // 5. Menu Actions
  document.getElementById('menu-action-reply')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const msgId = activeContextMsg.id;
    hideMenu();
    setReplyingMessage(msgId);
  });

  document.getElementById('menu-action-report')?.addEventListener('click', () => {
    const target = activeContextMsg;
    if (!target || target.isOut || target.isService || !isContextCurrent(target)) return;
    hideMenu();
    void reportTelegramMessage(target);
  });

  document.getElementById('menu-action-read-participants')?.addEventListener('click', () => {
    const target = activeContextMsg;
    if (!target || !isContextCurrent(target)) return;
    hideMenu();
    void showMessageReadParticipants(target.chatId, target.id);
  });

  document.getElementById('menu-action-copy')?.addEventListener('click', async () => {
    if (!activeContextMsg) return;
    const text = activeContextMsg.text;
    hideMenu();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('消息文字已复制到剪贴板', 'success');
      } catch (_) {
        showToast('复制失败，请手动选择复制', 'warn');
      }
    }
  });

  document.getElementById('menu-action-read-aloud')?.addEventListener('click', () => {
    const target = activeContextMsg;
    if (!target || !target.text || !isContextCurrent(target)) return;
    const result = toggleMessageSpeech(target.text, target);
    if (result.unsupported) showToast('此浏览器不支持消息朗读', 'warn');
    else if (result.empty) showToast('没有可朗读的文字', 'info');
    else if (!result.stopped) showToast('正在朗读消息', 'info');
    hideMenu();
  });

  document.getElementById('menu-action-translate')?.addEventListener('click', async () => {
    if (!activeContextMsg || !activeContextMsg.text) return;
    const { id: msgId, wrap, instId, chatId, selectionVersion } = activeContextMsg;
    hideMenu();
    const target = { instId, chatId, selectionVersion };
    const targetIsCurrent = () => state.clientSelectedInstance === target.instId &&
      Number(state.clientActiveChatId) === target.chatId && (state.chatSelectionVersion || 0) === target.selectionVersion;
    if (!target.instId || !Number.isSafeInteger(target.chatId) || target.chatId === 0 || !targetIsCurrent()) return;
    showToast('正在翻译消息...', 'info');
    try {
      const languageLabels = { 'zh-hans': '简体中文', 'zh-hant': '繁体中文', en: 'English', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский' };
      const translationLanguageLabel = Object.prototype.hasOwnProperty.call(languageLabels, state.clientTranslationLanguage)
        ? languageLabels[state.clientTranslationLanguage] : '简体中文';
      const res = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/translate`, 'POST', {
        chatId: target.chatId, messageId: msgId, targetLang: state.clientTranslationLanguage || 'zh-hans',
      });
      if (!targetIsCurrent() || !wrap?.isConnected) return;
      if (res && res.translatedText) {
        const bubble = wrap?.querySelector('.chat-bubble');
        if (bubble) {
          let transEl = bubble.querySelector('.msg-translated-wrap');
          if (!transEl) {
            transEl = document.createElement('div');
            transEl.className = 'msg-translated-wrap';
            bubble.appendChild(transEl);
          }
          transEl.innerHTML = `
            <div class="msg-translated-header">
              <svg class="ui-icon-xs" style="width:12px;height:12px;"><use href="#icon-tools"/></svg>
              <span>Telegram 翻译 · ${translationLanguageLabel}</span>
            </div>
            <div class="msg-translated-body">${formatMessageContent(res.translatedText, res.entities)}</div>
          `;
          showToast('翻译完成', 'success');
        }
      }
    } catch (err) {
      showToast(`翻译失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('menu-action-pin')?.addEventListener('click', async () => {
    if (!activeContextMsg) return;
    const { id: msgId, isPinned } = activeContextMsg;
    hideMenu();
    const instId = state.clientSelectedInstance;
    const chatId = state.clientActiveChatId;
    try {
      if (isPinned) {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('unpin_message', { instId, chatId, messageId: msgId });
        } else {
          await api(`/api/instances/${instId}/account/unpin`, 'POST', { chatId, messageId: msgId });
        }
        showToast('已取消置顶', 'success');
      } else {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('pin_message', { instId, chatId, messageId: msgId, silent: false });
        } else {
          await api(`/api/instances/${instId}/account/pin`, 'POST', { chatId, messageId: msgId });
        }
        showToast('消息已置顶', 'success');
      }
      loadPeerProfile(chatId);
    } catch (err) {
      showToast(`操作失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('menu-action-forward')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const msgId = activeContextMsg.id;
    hideMenu();
    openForwardModal([msgId]);
  });

  document.getElementById('menu-action-select')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const msgId = activeContextMsg.id;
    hideMenu();
    enterSelectionMode(msgId);
  });

  document.getElementById('menu-action-edit')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const { id: msgId, text } = activeContextMsg;
    hideMenu();
    setEditingMessage(msgId, text);
  });

  document.getElementById('menu-action-replace-media')?.addEventListener('click', () => {
    if (!activeContextMsg || !replaceMediaInput) return;
    replacementTarget = activeContextMsg;
    hideMenu();
    replaceMediaInput.value = '';
    replaceMediaInput.click();
  });

  replaceMediaInput?.addEventListener('change', async () => {
    const file = replaceMediaInput.files?.[0];
    const target = replacementTarget;
    replacementTarget = null;
    if (!file || !target || !isContextCurrent(target)) return;
    if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) {
      showToast('文件必须大于 0 且不超过 2 GiB。', 'warn'); replaceMediaInput.value = ''; return;
    }
    let lastProgress = -10;
    try {
      await sendMediaStream(`/api/instances/${encodeURIComponent(target.instId)}/account/message/media/replace`, file, {
        chatId: target.chatId, messageId: target.id, fileName: file.name,
        mimeType: file.type || 'application/octet-stream', caption: target.text || '',
        parseMode: ['plain', 'markdown', 'html'].includes(state.clientParseMode) ? state.clientParseMode : 'plain',
      }, (phase, percent) => {
        if (!isContextCurrent(target)) return;
        if (phase === 'sending') showToast('附件已上传，正在替换 Telegram 媒体…', 'info');
        else if (percent >= lastProgress + 10) { lastProgress = percent; showToast(`替换媒体 ${percent}%`, 'info'); }
      });
      if (!isContextCurrent(target)) return;
      showToast('消息媒体已替换', 'success');
      await loadClientMessages(target.chatId, true);
    } catch (error) {
      if (isContextCurrent(target)) showToast(`替换媒体失败：${error.message}`, 'error');
    } finally {
      replaceMediaInput.value = '';
    }
  });

  document.getElementById('menu-action-delete')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const msgId = activeContextMsg.id;
    hideMenu();
    deleteSingleMsg(msgId);
  });
}

// ==========================================
// Cache & Performance Settings Controller
// ==========================================
function initCacheSettings() {
  const modal = document.getElementById('modal-cache-settings');
  const btnOpen = document.getElementById('btn-open-cache-settings');
  const btnClose = document.getElementById('btn-close-cache-settings');
  const btnCancel = document.getElementById('btn-cancel-cache-settings');
  const btnSave = document.getElementById('btn-save-cache-settings');
  const btnClear = document.getElementById('btn-clear-cache');
  const slider = document.getElementById('cache-limit-slider');
  const label = document.getElementById('cache-limit-label');
  const presetPills = document.querySelectorAll('.cache-presets .preset-pill');

  if (!modal || !btnOpen) return;

  const openModal = async () => {
    modal.style.display = 'flex';
    await loadCacheStats();
  };

  const closeModal = () => {
    modal.style.display = 'none';
  };

  btnOpen.onclick = openModal;
  if (btnClose) btnClose.onclick = closeModal;
  if (btnCancel) btnCancel.onclick = closeModal;

  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };

  const updateSliderDisplay = (valMB) => {
    const gb = (valMB / 1024).toFixed(1);
    if (label) label.innerText = `${valMB} MB (${gb} GB)`;
    presetPills.forEach((p) => {
      p.classList.toggle('active', Number(p.dataset.mb) === Number(valMB));
    });
  };

  if (slider) {
    slider.oninput = () => {
      updateSliderDisplay(Number(slider.value));
    };
  }

  presetPills.forEach((p) => {
    p.onclick = () => {
      const mb = Number(p.dataset.mb);
      if (slider) slider.value = mb;
      updateSliderDisplay(mb);
    };
  });

  if (btnSave) {
    btnSave.onclick = async () => {
      const maxMB = Number(slider?.value || 5120);
      try {
        let stats;
        if (window.chatWs && window.chatWs.isConnected()) {
          stats = await window.chatWs.sendRpc('set_cache_limit', { maxMB });
        } else {
          stats = await api('/api/cache/limit', 'POST', { maxMB });
        }
        applyCacheStats(stats);
        showToast(`缓存上限已成功调整为 ${(maxMB / 1024).toFixed(1)} GB`, 'success');
        closeModal();
      } catch (err) {
        showToast(`调整失败: ${err.message}`, 'error');
      }
    };
  }

  if (btnClear) {
    btnClear.onclick = async () => {
      if (!confirm('确定清除服务端全部已持久化的头像、缩略图与内存高速缓存吗？')) return;
      try {
        let stats;
        if (window.chatWs && window.chatWs.isConnected()) {
          stats = await window.chatWs.sendRpc('clear_cache');
        } else {
          stats = await api('/api/cache/clear', 'POST');
        }
        applyCacheStats(stats);
        showToast('服务端全部长期缓存已清理完毕', 'success');
      } catch (err) {
        showToast(`清理失败: ${err.message}`, 'error');
      }
    };
  }
}

async function loadCacheStats() {
  try {
    let stats;
    if (window.chatWs && window.chatWs.isConnected()) {
      stats = await window.chatWs.sendRpc('get_cache_stats');
    } else {
      stats = await api('/api/cache/stats');
    }
    applyCacheStats(stats);
  } catch (_) {}
}

function applyCacheStats(stats) {
  if (!stats) return;
  const usedText = document.getElementById('cache-used-text');
  const maxText = document.getElementById('cache-max-text');
  const fill = document.getElementById('cache-progress-fill');
  const fileCount = document.getElementById('cache-file-count');
  const memDialogs = document.getElementById('cache-mem-dialogs');
  const memChats = document.getElementById('cache-mem-chats');
  const slider = document.getElementById('cache-limit-slider');
  const label = document.getElementById('cache-limit-label');

  const usedMB = stats.usedMB || 0;
  const maxMB = stats.maxMB || 5120;
  const percent = stats.percent || 0;

  if (usedText) usedText.innerText = `${usedMB} MB`;
  if (maxText) maxText.innerText = `/ ${maxMB} MB (${(maxMB / 1024).toFixed(1)} GB)`;
  if (fill) {
    fill.style.width = `${percent}%`;
    fill.classList.toggle('warning', percent > 85);
  }
  if (fileCount) fileCount.innerText = stats.fileCount || 0;
  if (memDialogs) memDialogs.innerText = stats.memDialogsCount || 0;
  if (memChats) memChats.innerText = stats.memChatsCount || 0;

  if (slider && !document.getElementById('modal-cache-settings')?.contains(document.activeElement)) {
    slider.value = maxMB;
    if (label) label.innerText = `${maxMB} MB (${(maxMB / 1024).toFixed(1)} GB)`;
    document.querySelectorAll('.cache-presets .preset-pill').forEach((p) => {
      p.classList.toggle('active', Number(p.dataset.mb) === Number(maxMB));
    });
  }
}

// ==========================================
// Phase 5: Native Polls & Quizzes Handler
// ==========================================
let quickRepliesDialogRequest = 0;
let quickRepliesDialogTarget = null;

function closeQuickRepliesDialog() {
  quickRepliesDialogRequest++;
  quickRepliesDialogTarget = null;
  hideQuickReplySuggestions();
  const modal = document.getElementById('modal-quick-replies');
  if (modal) modal.style.display = 'none';
}

function quickRepliesTargetIsCurrent(target) {
  return Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId &&
    (state.chatSelectionVersion || 0) === target.selectionVersion);
}

let quickReplyShortcutCatalog = new Map();
let quickReplySuggestionRequest = 0;
let quickReplySuggestionTarget = null;

function hideQuickReplySuggestions() {
  quickReplySuggestionRequest++;
  quickReplySuggestionTarget = null;
  const menu = document.getElementById('quick-reply-suggestions');
  const wasOpen = Boolean(menu && !menu.hidden);
  if (menu) { menu.hidden = true; menu.replaceChildren(); }
  return wasOpen;
}

function quickReplySuggestionTargetIsCurrent(target) {
  return Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId && (state.chatSelectionVersion || 0) === target.selectionVersion);
}

async function updateQuickReplySuggestions(textarea) {
  const text = String(textarea?.value || '');
  const match = /^\/([a-zA-Z0-9_]{0,32})$/.exec(text);
  const instId = state.clientSelectedInstance, chatId = Number(state.clientActiveChatId);
  if (!match || !instId || !Number.isSafeInteger(chatId) || chatId <= 0 || state.clientEditingMessageId || state.clientReplyingTo || state.clientStagedFile) {
    hideQuickReplySuggestions();
    return;
  }
  const target = { instId, chatId, selectionVersion: state.chatSelectionVersion || 0, commandText: text };
  quickReplySuggestionTarget = target;
  const requestId = ++quickReplySuggestionRequest;
  const menu = document.getElementById('quick-reply-suggestions');
  if (!menu) return;
  const render = replies => {
    if (requestId !== quickReplySuggestionRequest || quickReplySuggestionTarget !== target || !quickReplySuggestionTargetIsCurrent(target)) return;
    const query = match[1].toLocaleLowerCase();
    const matches = replies.filter(reply => typeof reply?.shortcut === 'string' && reply.shortcut.toLocaleLowerCase().startsWith(query));
    menu.replaceChildren();
    for (const reply of matches) {
      const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'quick-reply-suggestion';
      choice.setAttribute('role', 'option');
      const name = document.createElement('span'); name.className = 'quick-reply-suggestion-name'; name.textContent = `/${reply.shortcut}`;
      const count = document.createElement('span'); count.className = 'quick-reply-suggestion-count'; count.textContent = `${Number(reply.count) || 0} 条消息`;
      choice.append(name, count);
      choice.addEventListener('mousedown', event => event.preventDefault());
      choice.addEventListener('click', () => { void sendQuickReplyFromComposer(target, Number(reply.shortcutId), choice, textarea); });
      menu.appendChild(choice);
    }
    menu.hidden = matches.length === 0;
  };
  const cached = quickReplyShortcutCatalog.get(instId);
  if (cached && Date.now() - cached.loadedAt < 30000) {
    render(cached.replies);
    return;
  }
  try {
    const replies = await api(`/api/instances/${encodeURIComponent(instId)}/account/quick-replies`);
    if (requestId !== quickReplySuggestionRequest || quickReplySuggestionTarget !== target || !quickReplySuggestionTargetIsCurrent(target)) return;
    const safeReplies = Array.isArray(replies) ? replies : [];
    quickReplyShortcutCatalog.set(instId, { loadedAt: Date.now(), replies: safeReplies });
    render(safeReplies);
  } catch {
    if (requestId === quickReplySuggestionRequest && quickReplySuggestionTarget === target) menu.hidden = true;
  }
}

async function sendQuickReplyFromComposer(target, shortcutId, button, textarea) {
  if (!quickReplySuggestionTargetIsCurrent(target) || button.disabled) return;
  button.disabled = true;
  hideQuickReplySuggestions();
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/send`, 'POST', { chatId: target.chatId, shortcutId });
    if (!quickReplySuggestionTargetIsCurrent(target)) return;
    if (textarea?.value === target.commandText) {
      textarea.value = '';
      autoResizeTextarea(textarea);
      notifyCurrentDraftChanged();
      renderClientDialogs();
    }
    showToast('快捷回复已发送', 'success');
    await loadClientMessages(target.chatId, true);
  } catch (error) {
    if (quickReplySuggestionTargetIsCurrent(target)) showToast(`快捷回复发送失败：${error.message}`, 'error');
  } finally { button.disabled = false; }
}

async function openQuickRepliesDialog() {
  const instId = state.clientSelectedInstance, chatId = Number(state.clientActiveChatId);
  if (!instId || !Number.isSafeInteger(chatId) || chatId <= 0) return showToast('快捷回复只能用于私聊，请先选择一个用户会话', 'warn');
  const modal = document.getElementById('modal-quick-replies');
  const list = modal?.querySelector('[data-quick-replies-list]');
  const status = modal?.querySelector('[data-quick-replies-status]');
  if (!modal || !list || !status) return;
  const target = { instId, chatId, selectionVersion: state.chatSelectionVersion || 0 };
  quickRepliesDialogTarget = target;
  const createForm = modal.querySelector('[data-quick-reply-create-form]');
  if (createForm) createForm.hidden = true;
  const createName = modal.querySelector('[data-quick-reply-create-name]');
  const createText = modal.querySelector('[data-quick-reply-create-text]');
  if (createName) createName.value = '';
  if (createText) createText.value = '';
  const requestId = ++quickRepliesDialogRequest;
  list.replaceChildren(); status.textContent = '正在加载快捷回复…';
  modal.style.display = 'flex';
  try {
    const replies = await api(`/api/instances/${encodeURIComponent(instId)}/account/quick-replies`);
    if (requestId !== quickRepliesDialogRequest || quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) {
      if (quickRepliesDialogTarget === target) closeQuickRepliesDialog();
      return;
    }
    if (Array.isArray(replies)) quickReplyShortcutCatalog.set(instId, { loadedAt: Date.now(), replies });
    list.replaceChildren();
    for (const reply of (Array.isArray(replies) ? replies : [])) {
      if (!Number.isSafeInteger(Number(reply?.shortcutId)) || Number(reply.shortcutId) <= 0) continue;
      const row = document.createElement('div'); row.className = 'quick-reply-row';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quick-reply-choice';
      const name = document.createElement('span'); name.className = 'quick-reply-name'; name.textContent = `/${String(reply.shortcut || '')}`;
      const count = document.createElement('span'); count.className = 'quick-reply-count'; count.textContent = `${Number(reply.count) || 0} 条消息`;
      button.append(name, count);
      button.onclick = () => { void sendQuickReplyFromPicker(target, Number(reply.shortcutId), button); };
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'btn btn-secondary btn-sm';
      rename.textContent = '改名'; rename.setAttribute('aria-label', `重命名快捷回复 ${reply.shortcut || ''}`);
      rename.onclick = () => { void renameQuickReplyFromPicker(target, Number(reply.shortcutId), String(reply.shortcut || '')); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary btn-sm';
      remove.textContent = '删除'; remove.setAttribute('aria-label', `删除快捷回复 ${reply.shortcut || ''}`);
      remove.onclick = () => { void deleteQuickReplyFromPicker(target, Number(reply.shortcutId), String(reply.shortcut || '')); };
      const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'btn btn-secondary btn-sm';
      manage.textContent = '内容'; manage.setAttribute('aria-label', `管理快捷回复 ${reply.shortcut || ''} 的内容`);
      manage.onclick = () => { void openQuickReplyMessages(target, Number(reply.shortcutId), String(reply.shortcut || ''), row); };
      row.append(button, rename, remove, manage);
      list.appendChild(row);
    }
    status.textContent = list.childElementCount ? '选择一个快捷回复发送到当前会话。' : '此账号没有已保存的快捷回复。';
  } catch (error) {
    if (requestId === quickRepliesDialogRequest && quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
      status.textContent = `无法加载快捷回复：${error.message}`;
    }
  }
}

async function saveNewQuickReplyFromPicker(target) {
  if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
  const modal = document.getElementById('modal-quick-replies');
  const nameInput = modal?.querySelector('[data-quick-reply-create-name]');
  const textInput = modal?.querySelector('[data-quick-reply-create-text]');
  const save = modal?.querySelector('[data-quick-reply-create-save]');
  const shortcut = String(nameInput?.value || '').trim(), text = String(textInput?.value || '');
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(shortcut)) return showToast('快捷名称只能包含 1–32 个字母、数字或下划线', 'warn');
  if (!text.trim() || text.length > 4096) return showToast('请输入不超过 4096 个字符的回复内容', 'warn');
  if (save) save.disabled = true;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/create`, 'POST', { shortcut, text });
    if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
    quickReplyShortcutCatalog.delete(target.instId);
    showToast(`快捷回复 /${shortcut} 已创建`, 'success');
    await openQuickRepliesDialog();
  } catch (error) {
    if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
      const status = modal?.querySelector('[data-quick-replies-status]');
      if (status) status.textContent = `新建快捷回复失败：${error.message}`;
    }
  } finally { if (save) save.disabled = false; }
}

function editQuickReplyMessageInPicker(target, shortcutId, detail, message) {
  if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target) || !message?.editable) return;
  const editor = document.createElement('div'); editor.className = 'quick-reply-message-editor';
  const input = document.createElement('textarea'); input.className = 'form-input'; input.rows = 3; input.maxLength = 4096;
  input.value = String(message.text || ''); input.setAttribute('aria-label', '快捷回复消息内容');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = '保存';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
  editor.append(input, save, cancel); detail.appendChild(editor); input.focus();
  cancel.onclick = () => editor.remove();
  save.onclick = async () => {
    if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target) || save.disabled) return;
    const text = String(input.value || '');
    if (!text.trim() || text.length > 4096) return showToast('回复内容不能为空且最多 4096 个字符', 'warn');
    save.disabled = true;
    try {
      await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/message/edit`, 'POST', { shortcutId, messageId: Number(message.id), text });
      quickReplyShortcutCatalog.delete(target.instId);
      if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) await loadQuickReplyMessagesInto(target, shortcutId, detail);
    } catch (error) {
      if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
        const status = detail.querySelector('[data-quick-reply-message-status]');
        if (status) status.textContent = `编辑失败：${error.message}`;
        save.disabled = false;
      }
    }
  };
}

async function loadQuickReplyMessagesInto(target, shortcutId, detail) {
  if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
  detail.replaceChildren();
  const status = document.createElement('div'); status.className = 'quick-reply-message-status';
  status.setAttribute('data-quick-reply-message-status', ''); status.textContent = '正在加载模板内容…';
  const add = document.createElement('button'); add.type = 'button'; add.className = 'btn btn-secondary btn-sm'; add.textContent = '添加文字消息';
  const addMedia = document.createElement('button'); addMedia.type = 'button'; addMedia.className = 'btn btn-secondary btn-sm'; addMedia.textContent = '添加媒体消息';
  const mediaInput = document.createElement('input'); mediaInput.type = 'file'; mediaInput.hidden = true;
  detail.append(status, add, addMedia, mediaInput);
  add.onclick = () => {
    if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
    const editor = document.createElement('div'); editor.className = 'quick-reply-message-editor';
    const input = document.createElement('textarea'); input.className = 'form-input'; input.rows = 3; input.maxLength = 4096;
    input.setAttribute('aria-label', '新快捷回复消息内容');
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = '添加';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
    editor.append(input, save, cancel); detail.appendChild(editor); input.focus();
    cancel.onclick = () => editor.remove();
    save.onclick = async () => {
      const text = String(input.value || '');
      if (!text.trim() || text.length > 4096) return showToast('回复内容不能为空且最多 4096 个字符', 'warn');
      save.disabled = true;
      try {
        await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/message/add`, 'POST', { shortcutId, text });
        quickReplyShortcutCatalog.delete(target.instId);
        if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) await loadQuickReplyMessagesInto(target, shortcutId, detail);
      } catch (error) {
        if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
          status.textContent = `添加失败：${error.message}`; save.disabled = false;
        }
      }
    };
  };
  addMedia.onclick = () => {
    if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) mediaInput.click();
  };
  mediaInput.onchange = async () => {
    const file = mediaInput.files?.[0];
    if (!file || quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
    if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) {
      status.textContent = '文件必须大于 0 且不超过 2 GiB。'; mediaInput.value = ''; return;
    }
    addMedia.disabled = true;
    status.textContent = '正在上传媒体模板…';
    try {
      await sendMediaStream(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/media`, file, {
        shortcutId, fileName: file.name, mimeType: file.type || 'application/octet-stream', caption: '',
      }, (phase, percent) => {
        if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
          status.textContent = phase === 'sending' ? '已上传，正在保存到 Telegram…' : `上传媒体模板 ${percent}%`;
        }
      });
      quickReplyShortcutCatalog.delete(target.instId);
      if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) await loadQuickReplyMessagesInto(target, shortcutId, detail);
    } catch (error) {
      if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) status.textContent = `添加媒体模板失败：${error.message}`;
    } finally {
      addMedia.disabled = false;
      mediaInput.value = '';
    }
  };
  try {
    const result = await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/messages?shortcutId=${shortcutId}`);
    if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
    const messages = Array.isArray(result) ? result : [];
    status.textContent = messages.length ? `${messages.length} 条模板消息` : '此快捷回复没有消息。';
    for (const message of messages) {
      if (!Number.isSafeInteger(Number(message?.id)) || Number(message.id) <= 0) continue;
      const row = document.createElement('div'); row.className = 'quick-reply-message';
      const text = document.createElement('div'); text.className = 'quick-reply-message-text';
      text.textContent = String(message.text || (message.hasMedia ? '[媒体模板消息]' : '[空消息]'));
      row.appendChild(text);
      if (message.hasMedia) {
        const replace = document.createElement('button'); replace.type = 'button'; replace.className = 'btn btn-secondary btn-xs'; replace.textContent = '替换媒体';
        const replaceInput = document.createElement('input'); replaceInput.type = 'file'; replaceInput.hidden = true;
        row.append(replace, replaceInput);
        replace.onclick = () => {
          if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) replaceInput.click();
        };
        replaceInput.onchange = async () => {
          const file = replaceInput.files?.[0];
          if (!file || quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target)) return;
          if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) {
            status.textContent = '文件必须大于 0 且不超过 2 GiB。'; replaceInput.value = ''; return;
          }
          replace.disabled = true;
          status.textContent = '正在替换媒体模板…';
          try {
            await sendMediaStream(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/media/replace`, file, {
              shortcutId, messageId: Number(message.id), fileName: file.name,
              mimeType: file.type || 'application/octet-stream', caption: String(message.text || ''),
            }, (phase, percent) => {
              if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
                status.textContent = phase === 'sending' ? '已上传，正在替换 Telegram 模板…' : `替换媒体模板 ${percent}%`;
              }
            });
            quickReplyShortcutCatalog.delete(target.instId);
            if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) await loadQuickReplyMessagesInto(target, shortcutId, detail);
          } catch (error) {
            if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) status.textContent = `替换媒体失败：${error.message}`;
          } finally {
            replace.disabled = false;
            replaceInput.value = '';
          }
        };
      }
      if (message.editable) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-secondary btn-xs'; edit.textContent = message.hasMedia ? '编辑说明' : '编辑';
        edit.onclick = () => editQuickReplyMessageInPicker(target, shortcutId, detail, message);
        row.appendChild(edit);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary btn-xs'; remove.textContent = '删除';
      remove.onclick = async () => {
        if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target) || !window.confirm('删除这条快捷回复模板消息？')) return;
        remove.disabled = true;
        try {
          await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/message/delete`, 'POST', { shortcutId, messageIds: [Number(message.id)] });
          quickReplyShortcutCatalog.delete(target.instId);
          if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) await loadQuickReplyMessagesInto(target, shortcutId, detail);
        } catch (error) {
          if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) {
            status.textContent = `删除失败：${error.message}`; remove.disabled = false;
          }
        }
      };
      row.appendChild(remove); detail.appendChild(row);
    }
  } catch (error) {
    if (quickRepliesDialogTarget === target && quickRepliesTargetIsCurrent(target)) status.textContent = `无法加载模板内容：${error.message}`;
  }
}

async function openQuickReplyMessages(target, shortcutId, name, row) {
  if (quickRepliesDialogTarget !== target || !quickRepliesTargetIsCurrent(target) || !row) return;
  const existing = row.querySelector('.quick-reply-messages');
  if (existing) { existing.remove(); return; }
  const detail = document.createElement('div'); detail.className = 'quick-reply-messages';
  row.appendChild(detail);
  await loadQuickReplyMessagesInto(target, shortcutId, detail);
}

async function sendQuickReplyFromPicker(target, shortcutId, button) {
  if (!quickRepliesTargetIsCurrent(target) || quickRepliesDialogTarget !== target || button.disabled) return;
  button.disabled = true;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/send`, 'POST', {
      chatId: target.chatId, shortcutId,
    });
    if (!quickRepliesTargetIsCurrent(target)) return;
    closeQuickRepliesDialog();
    showToast('快捷回复已发送', 'success');
    await loadClientMessages(target.chatId, true);
  } catch (error) {
    if (quickRepliesTargetIsCurrent(target)) {
      const status = document.querySelector('#modal-quick-replies [data-quick-replies-status]');
      if (status) status.textContent = `快捷回复发送失败：${error.message}`;
      button.disabled = false;
    }
  }
}

async function renameQuickReplyFromPicker(target, shortcutId, currentName) {
  if (!quickRepliesTargetIsCurrent(target) || quickRepliesDialogTarget !== target) return;
  const shortcut = window.prompt('输入新的快捷回复名称（字母、数字或下划线）', currentName);
  if (shortcut == null) return;
  const name = shortcut.trim();
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(name)) return showToast('名称只能包含 1–32 个字母、数字或下划线', 'warn');
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/rename`, 'POST', { shortcutId, shortcut: name });
    if (!quickRepliesTargetIsCurrent(target) || quickRepliesDialogTarget !== target) return;
    quickReplyShortcutCatalog.delete(target.instId);
    showToast('快捷回复名称已更新', 'success');
    await openQuickRepliesDialog();
  } catch (error) {
    if (quickRepliesTargetIsCurrent(target)) {
      const status = document.querySelector('#modal-quick-replies [data-quick-replies-status]');
      if (status) status.textContent = `重命名失败：${error.message}`;
    }
  }
}

async function deleteQuickReplyFromPicker(target, shortcutId, name) {
  if (!quickRepliesTargetIsCurrent(target) || quickRepliesDialogTarget !== target ||
      !window.confirm(`删除快捷回复 /${name} 及其保存的模板消息？`)) return;
  try {
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/quick-reply/delete`, 'POST', { shortcutId });
    if (!quickRepliesTargetIsCurrent(target) || quickRepliesDialogTarget !== target) return;
    quickReplyShortcutCatalog.delete(target.instId);
    showToast('快捷回复已删除', 'success');
    await openQuickRepliesDialog();
  } catch (error) {
    if (quickRepliesTargetIsCurrent(target)) {
      const status = document.querySelector('#modal-quick-replies [data-quick-replies-status]');
      if (status) status.textContent = `删除失败：${error.message}`;
    }
  }
}

function initQuickRepliesPicker() {
  const button = document.getElementById('btn-chat-quick-replies');
  const modal = document.getElementById('modal-quick-replies');
  if (!button || !modal || modal.dataset.initialized === 'true') return;
  modal.dataset.initialized = 'true';
  button.addEventListener('click', () => { void openQuickRepliesDialog(); });
  const createForm = modal.querySelector('[data-quick-reply-create-form]');
  modal.querySelector('[data-quick-reply-create-open]')?.addEventListener('click', () => {
    if (createForm) createForm.hidden = !createForm.hidden;
    if (createForm && !createForm.hidden) modal.querySelector('[data-quick-reply-create-name]')?.focus();
  });
  modal.querySelector('[data-quick-reply-create-cancel]')?.addEventListener('click', () => {
    if (createForm) createForm.hidden = true;
  });
  modal.querySelector('[data-quick-reply-create-save]')?.addEventListener('click', () => {
    if (quickRepliesDialogTarget) void saveNewQuickReplyFromPicker(quickRepliesDialogTarget);
  });
  modal.querySelector('[data-quick-replies-close]')?.addEventListener('click', closeQuickRepliesDialog);
  modal.addEventListener('click', event => { if (event.target === modal) closeQuickRepliesDialog(); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.style.display !== 'none') closeQuickRepliesDialog();
  });
}

let scheduledMessagesRequest = 0;
let scheduledMessagesTarget = null;

function closeScheduledMessagesDialog() {
  scheduledMessagesRequest++;
  scheduledMessagesTarget = null;
  const modal = document.getElementById('modal-scheduled-messages');
  if (modal) modal.style.display = 'none';
}

function scheduledMessagesTargetIsCurrent(target) {
  return Boolean(target && state.clientSelectedInstance === target.instId &&
    Number(state.clientActiveChatId) === target.chatId &&
    (state.chatSelectionVersion || 0) === target.selectionVersion);
}

function updateScheduledMessageBulkControls(modal) {
  const list = modal?.querySelector('[data-scheduled-messages-list]');
  const boxes = Array.from(list?.querySelectorAll('[data-scheduled-message-select]') || []);
  const selected = boxes.filter(box => box.checked);
  const selectAll = modal?.querySelector('[data-scheduled-select-all]');
  const send = modal?.querySelector('[data-scheduled-bulk-send]');
  const remove = modal?.querySelector('[data-scheduled-bulk-delete]');
  if (selectAll) {
    selectAll.disabled = boxes.length === 0;
    selectAll.checked = boxes.length > 0 && selected.length === boxes.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
  }
  if (send) send.disabled = selected.length === 0;
  if (remove) remove.disabled = selected.length === 0;
  return selected.map(box => Number(box.value)).filter(id => Number.isSafeInteger(id) && id > 0);
}

async function openScheduledMessagesDialog() {
  const instId = state.clientSelectedInstance, chatId = Number(state.clientActiveChatId);
  if (!instId || !Number.isSafeInteger(chatId) || chatId === 0) return showToast('请先选择一个会话', 'warn');
  const modal = document.getElementById('modal-scheduled-messages');
  const list = modal?.querySelector('[data-scheduled-messages-list]');
  const status = modal?.querySelector('[data-scheduled-messages-status]');
  if (!modal || !list || !status) return;
  const target = { instId, chatId, selectionVersion: state.chatSelectionVersion || 0 };
  scheduledMessagesTarget = target;
  const requestId = ++scheduledMessagesRequest;
  list.replaceChildren(); status.textContent = '正在加载计划消息…';
  modal.style.display = 'flex';
  try {
    const messages = await api(`/api/instances/${encodeURIComponent(instId)}/account/scheduled-messages?chatId=${encodeURIComponent(chatId)}`);
    if (requestId !== scheduledMessagesRequest || scheduledMessagesTarget !== target || !scheduledMessagesTargetIsCurrent(target)) {
      if (scheduledMessagesTarget === target) closeScheduledMessagesDialog();
      return;
    }
    list.replaceChildren();
    for (const message of (Array.isArray(messages) ? messages : [])) {
      if (!Number.isSafeInteger(Number(message?.id)) || Number(message.id) <= 0) continue;
      const row = document.createElement('div'); row.className = 'scheduled-message-row';
      const content = document.createElement('div'); content.className = 'scheduled-message-content'; content.textContent = String(message.text || '[计划消息]');
      const date = document.createElement('time'); date.className = 'scheduled-message-date';
      const timestamp = Number(message.date);
      if (Number.isFinite(timestamp) && timestamp > 0) {
        date.dateTime = new Date(timestamp).toISOString(); date.textContent = new Date(timestamp).toLocaleString();
      } else date.textContent = '发送时间未知';
      const repeatPeriod = Number(message.scheduleRepeatPeriod);
      if (Number.isSafeInteger(repeatPeriod) && repeatPeriod > 0) {
        const repeatDays = repeatPeriod / 86400;
        const repeatLabel = Number.isInteger(repeatDays) ? `每 ${repeatDays} 天重复` : `每 ${repeatPeriod} 秒重复`;
        date.textContent += ` · ${repeatLabel}`;
        date.title = repeatLabel;
      }
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-secondary btn-sm'; edit.textContent = '编辑';
      edit.onclick = () => { void editScheduledMessageInDialog(target, Number(message.id), String(message.text || ''), timestamp, repeatPeriod, row); };
      const send = document.createElement('button'); send.type = 'button'; send.className = 'btn btn-secondary btn-sm'; send.textContent = '现在发送';
      send.onclick = () => { void performScheduledMessageAction(target, Number(message.id), 'send-now', row); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger btn-sm'; remove.textContent = '取消计划';
      remove.onclick = () => { void performScheduledMessageAction(target, Number(message.id), 'delete', row); };
      const select = document.createElement('input'); select.type = 'checkbox'; select.className = 'scheduled-message-select';
      select.value = String(message.id); select.setAttribute('data-scheduled-message-select', '');
      select.setAttribute('aria-label', '选择此计划消息');
      select.onchange = () => updateScheduledMessageBulkControls(modal);
      row.append(content, date, edit, send, remove, select); list.appendChild(row);
    }
    updateScheduledMessageBulkControls(modal);
    status.textContent = list.childElementCount ? `${list.childElementCount} 条计划消息` : '此会话没有计划消息。';
  } catch (error) {
    if (requestId === scheduledMessagesRequest && scheduledMessagesTarget === target && scheduledMessagesTargetIsCurrent(target)) {
      status.textContent = `无法加载计划消息：${error.message}`;
    }
  }
}

async function performScheduledMessageAction(target, messageId, action, row) {
  if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target) return;
  if (action === 'delete' && !window.confirm('取消这条计划消息？')) return;
  const buttons = row?.querySelectorAll('button') || [];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const suffix = action === 'send-now' ? 'send-now' : 'delete';
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/scheduled-messages/${suffix}`, 'POST', {
      chatId: target.chatId, messageIds: [messageId],
    });
    if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target) return;
    showToast(action === 'send-now' ? '计划消息已立即发送' : '计划消息已取消', 'success');
    if (action === 'send-now') await loadClientMessages(target.chatId, true);
    await openScheduledMessagesDialog();
  } catch (error) {
    if (scheduledMessagesTargetIsCurrent(target)) {
      const status = document.querySelector('#modal-scheduled-messages [data-scheduled-messages-status]');
      if (status) status.textContent = `计划消息操作失败：${error.message}`;
      buttons.forEach(button => { button.disabled = false; });
    }
  }
}

async function performScheduledMessagesBulkAction(target, action) {
  if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target || !['send-now', 'delete'].includes(action)) return;
  const modal = document.getElementById('modal-scheduled-messages');
  const ids = updateScheduledMessageBulkControls(modal);
  if (!ids.length) return;
  const prompt = action === 'send-now'
    ? `立即发送所选的 ${ids.length} 条计划消息？`
    : `取消所选的 ${ids.length} 条计划消息？`;
  if (!window.confirm(prompt)) return;
  const buttons = [modal?.querySelector('[data-scheduled-bulk-send]'), modal?.querySelector('[data-scheduled-bulk-delete]')].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  try {
    const suffix = action === 'send-now' ? 'send-now' : 'delete';
    await api(`/api/instances/${encodeURIComponent(target.instId)}/account/scheduled-messages/${suffix}`, 'POST', {
      chatId: target.chatId, messageIds: ids,
    });
    if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target) return;
    showToast(action === 'send-now' ? `已立即发送 ${ids.length} 条计划消息` : `已取消 ${ids.length} 条计划消息`, 'success');
    if (action === 'send-now') await loadClientMessages(target.chatId, true);
    await openScheduledMessagesDialog();
  } catch (error) {
    if (scheduledMessagesTargetIsCurrent(target) && scheduledMessagesTarget === target) {
      const status = modal?.querySelector('[data-scheduled-messages-status]');
      if (status) status.textContent = `批量计划消息操作失败：${error.message}`;
      updateScheduledMessageBulkControls(modal);
    }
  }
}

async function editScheduledMessageInDialog(target, messageId, initialText, initialDate, initialRepeatPeriod, row) {
  if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target || row.querySelector('.scheduled-message-editor')) return;
  const editor = document.createElement('div'); editor.className = 'scheduled-message-editor';
  const input = document.createElement('textarea'); input.className = 'form-input'; input.rows = 3; input.maxLength = 4096;
  input.value = initialText; input.setAttribute('aria-label', '计划消息内容');
  const dateInput = document.createElement('input'); dateInput.type = 'datetime-local'; dateInput.className = 'form-input';
  const dateValue = Number(initialDate) > 0 ? new Date(Number(initialDate)) : new Date(Date.now() + 3600000);
  const pad = value => String(value).padStart(2, '0');
  dateInput.value = `${dateValue.getFullYear()}-${pad(dateValue.getMonth() + 1)}-${pad(dateValue.getDate())}T${pad(dateValue.getHours())}:${pad(dateValue.getMinutes())}`;
  dateInput.setAttribute('aria-label', '计划消息发送时间');
  const repeat = document.createElement('select'); repeat.className = 'form-input'; repeat.setAttribute('aria-label', '计划消息重复周期');
  const repeatChoices = [['不重复', 0], ['每天', 86400], ['每 7 天', 604800], ['每 30 天', 2592000], ['每 365 天', 31536000]];
  const currentRepeatPeriod = Number(initialRepeatPeriod);
  if (Number.isSafeInteger(currentRepeatPeriod) && currentRepeatPeriod >= 86400 && currentRepeatPeriod <= 31536000 &&
      !repeatChoices.some(([, value]) => value === currentRepeatPeriod)) {
    const days = currentRepeatPeriod / 86400;
    repeatChoices.push([Number.isInteger(days) ? `每 ${days} 天（当前周期）` : `每 ${currentRepeatPeriod} 秒（当前周期）`, currentRepeatPeriod]);
  }
  for (const [label, value] of repeatChoices) {
    const option = document.createElement('option'); option.value = String(value); option.textContent = label; repeat.append(option);
  }
  repeat.value = Number.isSafeInteger(currentRepeatPeriod) && currentRepeatPeriod > 0 ? String(currentRepeatPeriod) : '0';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = '保存';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary btn-sm'; cancel.textContent = '取消';
  editor.append(input, dateInput, repeat, save, cancel); row.appendChild(editor); input.focus();
  cancel.onclick = () => editor.remove();
  save.onclick = async () => {
    if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target || save.disabled) return;
    const targetTime = new Date(dateInput.value).getTime();
    if (!Number.isFinite(targetTime) || targetTime <= Date.now()) {
      return showToast('设定时间必须晚于当前时间', 'warn');
    }
    save.disabled = true;
    try {
      await api(`/api/instances/${encodeURIComponent(target.instId)}/account/scheduled-messages/edit`, 'POST', {
        chatId: target.chatId, messageId, text: input.value,
        parseMode: state.clientParseMode || document.getElementById('client-input-parsemode')?.value || 'markdown',
        schedule: Math.floor(targetTime / 1000), scheduleRepeatPeriod: Number(repeat.value) || null,
      });
      if (!scheduledMessagesTargetIsCurrent(target) || scheduledMessagesTarget !== target) return;
      showToast('计划消息内容与发送时间已更新', 'success');
      await openScheduledMessagesDialog();
    } catch (error) {
      if (scheduledMessagesTargetIsCurrent(target)) {
        const status = document.querySelector('#modal-scheduled-messages [data-scheduled-messages-status]');
        if (status) status.textContent = `编辑计划消息失败：${error.message}`;
        save.disabled = false;
      }
    }
  };
}

function initScheduledMessagesDialog() {
  const button = document.getElementById('btn-chat-scheduled-messages');
  const modal = document.getElementById('modal-scheduled-messages');
  if (!button || !modal || modal.dataset.initialized === 'true') return;
  modal.dataset.initialized = 'true';
  button.addEventListener('click', () => { void openScheduledMessagesDialog(); });
  modal.querySelector('[data-scheduled-messages-close]')?.addEventListener('click', closeScheduledMessagesDialog);
  modal.querySelector('[data-scheduled-select-all]')?.addEventListener('change', event => {
    const list = modal.querySelector('[data-scheduled-messages-list]');
    list?.querySelectorAll('[data-scheduled-message-select]').forEach(box => { box.checked = event.currentTarget.checked; });
    updateScheduledMessageBulkControls(modal);
  });
  modal.querySelector('[data-scheduled-bulk-send]')?.addEventListener('click', () => {
    if (scheduledMessagesTarget) void performScheduledMessagesBulkAction(scheduledMessagesTarget, 'send-now');
  });
  modal.querySelector('[data-scheduled-bulk-delete]')?.addEventListener('click', () => {
    if (scheduledMessagesTarget) void performScheduledMessagesBulkAction(scheduledMessagesTarget, 'delete');
  });
  modal.addEventListener('click', event => { if (event.target === modal) closeScheduledMessagesDialog(); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.style.display !== 'none') closeScheduledMessagesDialog();
  });
}

const pendingPollVotes = {};
const pendingPollClosures = new Set();
let pollEditSession = null;
const pendingTodoToggles = new Set();
let pollVotersDialogState = null;
let pollVotersDialogRequest = 0;

function pollVotersTargetIsCurrent(session) {
  return Boolean(session && state.clientSelectedInstance === session.instId &&
    Number(state.clientActiveChatId) === session.chatId && (state.chatSelectionVersion || 0) === session.selectionVersion);
}

function closePollVotersDialog() {
  pollVotersDialogRequest++;
  pollVotersDialogState = null;
  const modal = document.getElementById('poll-voters-modal');
  if (modal) modal.hidden = true;
}

function initializePollVotersDialog() {
  const modal = document.getElementById('poll-voters-modal');
  if (!modal || modal.dataset.initialized === 'true') return modal;
  modal.dataset.initialized = 'true';
  modal.querySelector('[data-poll-voters-close]')?.addEventListener('click', closePollVotersDialog);
  modal.querySelector('[data-poll-voters-more]')?.addEventListener('click', () => {
    if (pollVotersDialogState && !pollVotersDialogState.busy) void loadPollVotersPage(pollVotersDialogState, Boolean(pollVotersDialogState.offset));
  });
  modal.addEventListener('click', event => { if (event.target === modal) closePollVotersDialog(); });
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') closePollVotersDialog(); });
  return modal;
}

async function loadPollVotersPage(session, append) {
  if (!pollVotersTargetIsCurrent(session) || pollVotersDialogState !== session || session.busy) {
    if (pollVotersDialogState === session && !pollVotersTargetIsCurrent(session)) closePollVotersDialog();
    return;
  }
  const modal = document.getElementById('poll-voters-modal');
  const list = modal?.querySelector('[data-poll-voters-list]');
  const status = modal?.querySelector('[data-poll-voters-status]');
  const more = modal?.querySelector('[data-poll-voters-more]');
  if (!modal || !list || !status || !more) return;
  const pageOffset = append ? session.offset : undefined;
  const requestId = ++pollVotersDialogRequest;
  session.busy = true; more.disabled = true; status.textContent = append ? '正在加载更多投票者…' : '正在加载投票者…';
  try {
    const params = new URLSearchParams({
      chatId: String(session.chatId), messageId: String(session.messageId),
      optionIndex: String(session.optionIndex), limit: '50',
    });
    if (pageOffset) params.set('offset', pageOffset);
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/poll-votes?${params}`);
    if (requestId !== pollVotersDialogRequest || pollVotersDialogState !== session || !pollVotersTargetIsCurrent(session)) {
      if (pollVotersDialogState === session) closePollVotersDialog();
      return;
    }
    const voters = Array.isArray(result?.voters) ? result.voters : [];
    if (!append) list.replaceChildren();
    for (const entry of voters) {
      const user = entry?.user;
      if (!user || !Number.isSafeInteger(Number(user.id))) continue;
      const row = document.createElement('div'); row.className = 'poll-voter-row';
      const identity = document.createElement('div'); identity.className = 'poll-voter-identity';
      const name = document.createElement('strong');
      name.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : `用户 ${user.id}`);
      identity.appendChild(name);
      if (user.username && name.textContent !== `@${user.username}`) {
        const username = document.createElement('span'); username.textContent = `@${user.username}`; identity.appendChild(username);
      }
      const date = document.createElement('time');
      const seconds = Number(entry.date);
      if (Number.isFinite(seconds) && seconds > 0) {
        date.dateTime = new Date(seconds * 1000).toISOString();
        date.textContent = new Date(seconds * 1000).toLocaleString();
      }
      row.append(identity, date); list.appendChild(row);
    }
    session.offset = typeof result?.nextOffset === 'string' && result.nextOffset && result.nextOffset !== pageOffset
      ? result.nextOffset : undefined;
    more.hidden = !session.offset; more.textContent = '加载更多';
    status.textContent = Number(result?.count) > 0 ? `共 ${Number(result.count)} 人 · 已显示 ${list.childElementCount} 人` : '暂无投票者';
  } catch (error) {
    if (requestId === pollVotersDialogRequest && pollVotersDialogState === session && pollVotersTargetIsCurrent(session)) {
      status.textContent = `无法加载投票者：${error.message}`;
      more.hidden = false; more.textContent = '重试';
    }
  } finally {
    if (pollVotersDialogState === session) { session.busy = false; more.disabled = false; }
  }
}

async function showPollVoters(chatId, messageId, optionIndex, optionTitle) {
  const targetChatId = Number(chatId), msgId = Number(messageId), index = Number(optionIndex);
  const message = state.clientMessages.find(item => Number(item.id) === msgId);
  const option = message?.media?.options?.[index];
  if (!state.clientSelectedInstance || !Number.isSafeInteger(targetChatId) || targetChatId === 0 ||
      Number(state.clientActiveChatId) !== targetChatId || !message || !message.media?.publicVoters || !option) {
    showToast('此投票无法查看投票者', 'warn'); return;
  }
  const modal = initializePollVotersDialog();
  if (!modal) return;
  closePollVotersDialog();
  const session = {
    instId: state.clientSelectedInstance, chatId: targetChatId, messageId: msgId,
    optionIndex: index, selectionVersion: state.chatSelectionVersion || 0, busy: false, offset: undefined,
  };
  pollVotersDialogState = session;
  modal.querySelector('[data-poll-voters-title]').textContent = `投票者 · ${String(optionTitle || option.text || '选项')}`;
  modal.querySelector('[data-poll-voters-list]').replaceChildren();
  modal.querySelector('[data-poll-voters-status]').textContent = '';
  const more = modal.querySelector('[data-poll-voters-more]');
  more.hidden = true; more.disabled = false; more.textContent = '加载更多';
  modal.hidden = false;
  await loadPollVotersPage(session, false);
}

window.showPollVoters = showPollVoters;

let messageReactionUsersState = null;
let messageReactionUsersRequest = 0;

function closeMessageReactionUsersDialog() {
  messageReactionUsersRequest++;
  messageReactionUsersState = null;
  const modal = document.getElementById('message-reactions-modal');
  if (modal) modal.hidden = true;
}

function messageReactionTargetIsCurrent(session) {
  return Boolean(session && state.clientSelectedInstance === session.instId &&
    Number(state.clientActiveChatId) === session.chatId && (state.chatSelectionVersion || 0) === session.selectionVersion);
}

function initializeMessageReactionUsersDialog() {
  const modal = document.getElementById('message-reactions-modal');
  if (!modal || modal.dataset.initialized === 'true') return modal;
  modal.dataset.initialized = 'true';
  modal.querySelector('[data-message-reactions-close]')?.addEventListener('click', closeMessageReactionUsersDialog);
  modal.querySelector('[data-message-reactions-more]')?.addEventListener('click', () => {
    const session = messageReactionUsersState;
    if (session && !session.busy) void loadMessageReactionUsers(session, Boolean(session.offset));
  });
  modal.addEventListener('click', event => { if (event.target === modal) closeMessageReactionUsersDialog(); });
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeMessageReactionUsersDialog(); });
  return modal;
}

async function loadMessageReactionUsers(session, append) {
  if (!messageReactionTargetIsCurrent(session) || messageReactionUsersState !== session || session.busy) {
    if (messageReactionUsersState === session && !messageReactionTargetIsCurrent(session)) closeMessageReactionUsersDialog();
    return;
  }
  const modal = document.getElementById('message-reactions-modal');
  const list = modal?.querySelector('[data-message-reactions-list]');
  const status = modal?.querySelector('[data-message-reactions-status]');
  const more = modal?.querySelector('[data-message-reactions-more]');
  if (!modal || !list || !status || !more) return;
  const pageOffset = append ? session.offset : '';
  const requestId = ++messageReactionUsersRequest;
  session.busy = true; more.disabled = true;
  status.textContent = append ? '正在加载更多反应者…' : '正在加载反应者…';
  try {
    const params = new URLSearchParams({ chatId: String(session.chatId), messageId: String(session.messageId), emoji: session.emoji, offset: pageOffset || '', limit: '50' });
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/message-reactions?${params}`);
    if (requestId !== messageReactionUsersRequest || messageReactionUsersState !== session || !messageReactionTargetIsCurrent(session)) {
      if (messageReactionUsersState === session) closeMessageReactionUsersDialog();
      return;
    }
    const entries = Array.isArray(result?.users) ? result.users : [];
    if (!append) list.replaceChildren();
    for (const entry of entries) {
      const user = entry?.user;
      if (!user || !Number.isSafeInteger(Number(user.id))) continue;
      const row = document.createElement('div'); row.className = 'poll-voter-row';
      const identity = document.createElement('div'); identity.className = 'poll-voter-identity';
      const name = document.createElement('strong');
      name.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : `用户 ${user.id}`);
      identity.appendChild(name);
      if (user.username && name.textContent !== `@${user.username}`) {
        const username = document.createElement('span'); username.textContent = `@${user.username}`; identity.appendChild(username);
      }
      const date = document.createElement('time');
      const seconds = Number(entry.date);
      if (Number.isFinite(seconds) && seconds > 0) {
        date.dateTime = new Date(seconds * 1000).toISOString(); date.textContent = new Date(seconds * 1000).toLocaleString();
      }
      row.append(identity, date); list.appendChild(row);
    }
    session.offset = typeof result?.nextOffset === 'string' && result.nextOffset && result.nextOffset !== pageOffset ? result.nextOffset : undefined;
    more.hidden = !session.offset; more.textContent = '加载更多';
    status.textContent = Number(result?.count) > 0 ? `共 ${Number(result.count)} 人 · 已显示 ${list.childElementCount} 人` : '暂无反应者';
  } catch (error) {
    if (requestId === messageReactionUsersRequest && messageReactionUsersState === session && messageReactionTargetIsCurrent(session)) {
      status.textContent = `无法加载反应者：${error.message}`;
      more.hidden = false; more.textContent = '重试';
    }
  } finally {
    if (messageReactionUsersState === session) { session.busy = false; more.disabled = false; }
  }
}

async function showMessageReactionUsers(chatId, messageId, emoji) {
  const targetChatId = Number(chatId), msgId = Number(messageId);
  const message = state.clientMessages.find(item => Number(item.id) === msgId);
  const customEmojiId = /^custom:([1-9]\d{0,19})$/.exec(String(emoji || ''))?.[1];
  const reactionItem = message?.reactions?.find(item => customEmojiId
    ? String(item.customEmojiId || '') === customEmojiId
    : (item.emoji || item.emoticon) === emoji);
  const hasReaction = Boolean(reactionItem);
  if (!state.clientSelectedInstance || !Number.isSafeInteger(targetChatId) || targetChatId === 0 ||
      Number(state.clientActiveChatId) !== targetChatId || !message || !hasReaction || typeof emoji !== 'string' || !emoji) {
    showToast('当前消息反应列表不可用', 'warn'); return;
  }
  const modal = initializeMessageReactionUsersDialog();
  if (!modal) return;
  closeMessageReactionUsersDialog();
  const session = { instId: state.clientSelectedInstance, chatId: targetChatId, messageId: msgId, emoji,
    selectionVersion: state.chatSelectionVersion || 0, busy: false, offset: undefined };
  messageReactionUsersState = session;
  modal.querySelector('[data-message-reactions-title]').textContent = `回应 ${customEmojiId ? (reactionItem?.emoji || '自定义 Emoji') : emoji}`;
  modal.querySelector('[data-message-reactions-list]').replaceChildren();
  modal.querySelector('[data-message-reactions-status]').textContent = '';
  const more = modal.querySelector('[data-message-reactions-more]');
  more.hidden = true; more.disabled = false; more.textContent = '加载更多';
  modal.hidden = false;
  await loadMessageReactionUsers(session, false);
}

window.showMessageReactionUsers = showMessageReactionUsers;

let messageReadParticipantsState = null;
let messageReadParticipantsRequest = 0;

function closeMessageReadParticipantsDialog() {
  messageReadParticipantsRequest++;
  messageReadParticipantsState = null;
  const modal = document.getElementById('message-read-participants-modal');
  if (modal) modal.hidden = true;
}

function messageReadParticipantsTargetIsCurrent(session) {
  return Boolean(session && state.clientSelectedInstance === session.instId &&
    Number(state.clientActiveChatId) === session.chatId && (state.chatSelectionVersion || 0) === session.selectionVersion);
}

function initializeMessageReadParticipantsDialog() {
  const modal = document.getElementById('message-read-participants-modal');
  if (!modal || modal.dataset.initialized === 'true') return modal;
  modal.dataset.initialized = 'true';
  modal.querySelector('[data-message-read-participants-close]')?.addEventListener('click', closeMessageReadParticipantsDialog);
  modal.querySelector('[data-message-read-participants-retry]')?.addEventListener('click', () => {
    if (messageReadParticipantsState && !messageReadParticipantsState.busy) void loadMessageReadParticipants(messageReadParticipantsState);
  });
  modal.addEventListener('click', event => { if (event.target === modal) closeMessageReadParticipantsDialog(); });
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeMessageReadParticipantsDialog(); });
  return modal;
}

async function loadMessageReadParticipants(session) {
  if (!messageReadParticipantsTargetIsCurrent(session) || messageReadParticipantsState !== session || session.busy) {
    if (messageReadParticipantsState === session && !messageReadParticipantsTargetIsCurrent(session)) closeMessageReadParticipantsDialog();
    return;
  }
  const modal = document.getElementById('message-read-participants-modal');
  const list = modal?.querySelector('[data-message-read-participants-list]');
  const status = modal?.querySelector('[data-message-read-participants-status]');
  const retry = modal?.querySelector('[data-message-read-participants-retry]');
  if (!modal || !list || !status || !retry) return;
  const requestId = ++messageReadParticipantsRequest;
  session.busy = true; retry.disabled = true; retry.hidden = true; status.textContent = '正在加载已读成员…';
  try {
    const params = new URLSearchParams({ chatId: String(session.chatId), messageId: String(session.messageId) });
    const result = await api(`/api/instances/${encodeURIComponent(session.instId)}/account/message-read-participants?${params}`);
    if (requestId !== messageReadParticipantsRequest || messageReadParticipantsState !== session || !messageReadParticipantsTargetIsCurrent(session)) {
      if (messageReadParticipantsState === session) closeMessageReadParticipantsDialog();
      return;
    }
    list.replaceChildren();
    const entries = Array.isArray(result?.participants) ? result.participants : [];
    for (const entry of entries) {
      const user = entry?.user;
      if (!user || !Number.isSafeInteger(Number(user.id))) continue;
      const row = document.createElement('div'); row.className = 'poll-voter-row';
      const identity = document.createElement('div'); identity.className = 'poll-voter-identity';
      const name = document.createElement('strong');
      name.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : `用户 ${user.id}`);
      identity.appendChild(name);
      if (user.username && name.textContent !== `@${user.username}`) {
        const username = document.createElement('span'); username.textContent = `@${user.username}`; identity.appendChild(username);
      }
      const date = document.createElement('time');
      const seconds = Number(entry.date);
      if (Number.isFinite(seconds) && seconds > 0) {
        date.dateTime = new Date(seconds * 1000).toISOString(); date.textContent = new Date(seconds * 1000).toLocaleString();
      }
      row.append(identity, date); list.appendChild(row);
    }
    status.textContent = list.childElementCount ? `共 ${Number(result?.count) || list.childElementCount} 人已读` : '暂无已读成员';
  } catch (error) {
    if (requestId === messageReadParticipantsRequest && messageReadParticipantsState === session && messageReadParticipantsTargetIsCurrent(session)) {
      status.textContent = `无法加载已读成员：${error.message}`;
      retry.hidden = false;
    }
  } finally {
    if (messageReadParticipantsState === session) { session.busy = false; retry.disabled = false; }
  }
}

async function showMessageReadParticipants(chatId, messageId) {
  const targetChatId = Number(chatId), msgId = Number(messageId);
  const message = state.clientMessages.find(item => Number(item.id) === msgId);
  const dialog = (state.clientDialogs || []).find(item => Number(item.id) === targetChatId);
  if (!state.clientSelectedInstance || !Number.isSafeInteger(targetChatId) || targetChatId === 0 ||
      Number(state.clientActiveChatId) !== targetChatId || !message || !message.outgoing ||
      !dialog || !['group', 'supergroup'].includes(dialog.type)) {
    showToast('此群消息无法查看已读成员', 'warn'); return;
  }
  const modal = initializeMessageReadParticipantsDialog();
  if (!modal) return;
  closeMessageReadParticipantsDialog();
  const session = { instId: state.clientSelectedInstance, chatId: targetChatId, messageId: msgId,
    selectionVersion: state.chatSelectionVersion || 0, busy: false };
  messageReadParticipantsState = session;
  modal.querySelector('[data-message-read-participants-title]').textContent = '已读成员';
  modal.querySelector('[data-message-read-participants-list]').replaceChildren();
  modal.querySelector('[data-message-read-participants-status]').textContent = '';
  const retry = modal.querySelector('[data-message-read-participants-retry]');
  retry.hidden = true; retry.disabled = false;
  modal.hidden = false;
  await loadMessageReadParticipants(session);
}

window.showMessageReadParticipants = showMessageReadParticipants;

async function closeTelegramPoll(chatId, messageId) {
  const targetChatId = Number(chatId), msgId = Number(messageId);
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion || 0;
  const key = `${instId}:${targetChatId}:${msgId}`;
  if (!instId || Number(state.clientActiveChatId) !== targetChatId || pendingPollClosures.has(key)) return;
  if (typeof window.confirm === 'function' && !window.confirm('停止此投票？停止后参与者将无法继续投票。')) return;
  pendingPollClosures.add(key);
  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/poll/close`, 'POST', { chatId: targetChatId, messageId: msgId });
    if (state.clientSelectedInstance !== instId || Number(state.clientActiveChatId) !== targetChatId ||
        (state.chatSelectionVersion || 0) !== selectionVersion) return;
    showToast('投票已停止', 'success');
    await loadClientMessages(targetChatId, true);
  } catch (error) {
    if (state.clientSelectedInstance === instId && Number(state.clientActiveChatId) === targetChatId &&
        (state.chatSelectionVersion || 0) === selectionVersion) showToast(`停止投票失败: ${error.message}`, 'error');
  } finally {
    pendingPollClosures.delete(key);
  }
}

window.closeTelegramPoll = closeTelegramPoll;

function renderPollCardHtml(media, msgId, chatId, isOutgoing = false) {
  const options = media.options || [];
  const totalVotes = media.totalVoters || options.reduce((sum, o) => sum + (o.voters || 0), 0);
  const hasVoted = options.some((o) => o.chosen);
  const isClosed = Boolean(media.closed);
  const isQuiz = Boolean(media.isQuiz);
  const multipleChoice = Boolean(media.multipleChoice);

  const typeBadge = isQuiz
    ? '<span class="poll-type-tag quiz">测验</span>'
    : '<span class="poll-type-tag">投票</span>';
  const privacyBadge = `<span>${media.publicVoters ? '实名' : '匿名'}</span>`;
  const countBadge = `<span>${totalVotes} 人参与</span>`;
  const closedBadge = isClosed ? '<span style="color:var(--color-danger);font-weight:600;">已截止</span>' : '';

  const showResults = hasVoted || isClosed;

  let optionsHtml = '';
  options.forEach((opt, idx) => {
    const pct = totalVotes > 0 ? Math.round(((opt.voters || 0) / totalVotes) * 100) : 0;
    let rowClass = 'poll-option-row';
    if (opt.chosen) rowClass += ' selected';
    if (isClosed) rowClass += ' closed';
    if (hasVoted) rowClass += ' voted';

    if (isQuiz && showResults) {
      if (opt.correct) {
        rowClass += ' correct';
      } else if (opt.chosen && !opt.correct) {
        rowClass += ' wrong';
      }
    }

    const checkCircleClass = multipleChoice ? 'poll-check-circle multiple' : 'poll-check-circle';
    const percentHtml = showResults ? `<span class="poll-option-percent">${pct}%</span>` : '';
    const votersHtml = media.publicVoters && showResults && Number(opt.voters) > 0
      ? `<button type="button" class="poll-voters-link" onclick="event.stopPropagation(); showPollVoters(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)}, ${idx}, ${inlineJsArg(opt.text)})">${Number(opt.voters)} 人</button>` : '';
    const progressBarHtml = showResults ? `
      <div class="poll-progress-track">
        <div class="poll-progress-bar" style="width: ${pct}%;"></div>
      </div>
    ` : '';

    const clickAttr = !isClosed
      ? `onclick="handlePollOptionClick(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)}, ${idx}, ${multipleChoice})"`
      : '';

    optionsHtml += `
      <div class="${rowClass}" data-opt-idx="${idx}" ${clickAttr}>
        <div class="poll-option-main">
          <div class="poll-option-left">
            <div class="${checkCircleClass}">
              <div class="poll-check-inner"></div>
            </div>
            <span class="poll-option-text">${escapeHtml(opt.text)}</span>
          </div>
          ${percentHtml}
          ${votersHtml}
        </div>
        ${progressBarHtml}
      </div>
    `;
  });

  let solutionHtml = '';
  if (isQuiz && showResults && media.solution) {
    solutionHtml = `
      <div class="poll-solution-box">
        <svg class="ui-icon-xs" style="color:#f59e0b; flex-shrink:0; margin-top:2px;"><use href="#icon-tools"/></svg>
        <div><b>解析说明:</b> ${escapeHtml(media.solution)}</div>
      </div>
    `;
  }

  let multiVoteBtnHtml = '';
  if (multipleChoice && !isClosed) {
    multiVoteBtnHtml = `
      <div style="display:flex; justify-content:flex-end; margin-top:6px;">
        <button class="btn btn-primary btn-xs" id="btn-poll-submit-${escapeHtml(msgId)}" onclick="submitMultiPollVote(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)})" style="display:none;">
          <span>提交投票</span>
        </button>
      </div>
    `;
  }

  const stopPollHtml = (isOutgoing || media.canClose) && !isClosed
    ? `<div class="poll-actions"><button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); closeTelegramPoll(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)})">停止投票</button></div>`
    : '';
  const editPollHtml = isOutgoing && media.canEdit && !isClosed
    ? `<div class="poll-actions"><button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); editTelegramPoll(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)})">编辑投票</button></div>`
    : '';
  const withdrawPollHtml = hasVoted && !isClosed
    ? `<div class="poll-actions"><button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); withdrawTelegramPollVote(${inlineJsArg(chatId)}, ${inlineJsArg(msgId)})">撤回投票</button></div>`
    : '';

  return `
    <div class="msg-poll-card" id="poll-card-${escapeHtml(msgId)}">
      <div class="poll-header">
        <div class="poll-question">${escapeHtml(media.question || '投票')}</div>
        <div class="poll-badges">
          ${typeBadge}
          ${privacyBadge}
          ${countBadge}
          ${closedBadge}
        </div>
      </div>
      <div class="poll-options">
        ${optionsHtml}
      </div>
      ${solutionHtml}
      ${multiVoteBtnHtml}
      ${withdrawPollHtml}
      ${editPollHtml}
      ${stopPollHtml}
    </div>
  `;
}

window.editTelegramPoll = (chatId, messageId) => {
  const targetChatId = Number(chatId), msgId = Number(messageId);
  const message = state.clientMessages.find(item => Number(item.id) === msgId);
  const media = message?.media;
  const modal = document.getElementById('modal-create-poll');
  if (!modal || !state.clientSelectedInstance || Number(state.clientActiveChatId) !== targetChatId ||
      !message?.outgoing || media?.type !== 'poll' || !media.canEdit || media.closed) {
    showToast('此投票不可编辑，可能已经有人参与投票', 'warn');
    return;
  }
  pollEditSession = {
    instId: state.clientSelectedInstance,
    chatId: targetChatId,
    messageId: msgId,
    selectionVersion: state.chatSelectionVersion || 0,
  };
  document.getElementById('poll-modal-title').textContent = media.isQuiz ? '编辑测验' : '编辑投票';
  document.getElementById('poll-question-input').value = media.question || '';
  document.getElementById('poll-anonymous-input').checked = !media.publicVoters;
  document.getElementById('poll-multiple-input').checked = Boolean(media.multipleChoice);
  document.getElementById('poll-quiz-input').checked = Boolean(media.isQuiz);
  document.getElementById('poll-anonymous-input').disabled = true;
  document.getElementById('poll-multiple-input').disabled = true;
  document.getElementById('poll-quiz-input').disabled = true;
  document.getElementById('poll-quiz-solution-wrap').style.display = media.isQuiz ? 'block' : 'none';
  document.getElementById('poll-solution-input').value = media.solution || '';
  const scheduleToggle = document.getElementById('poll-schedule-toggle');
  const scheduleFields = document.getElementById('poll-schedule-fields');
  if (scheduleToggle) scheduleToggle.checked = false;
  if (scheduleFields) scheduleFields.style.display = 'none';
  const correctOptionIndex = media.isQuiz ? media.options.findIndex(option => option.correct) : -1;
  renderPollModalOptions(media.options.map(option => option.text), correctOptionIndex);
  document.querySelectorAll('.poll-quiz-radio').forEach(radio => { radio.disabled = !media.isQuiz; });
  document.getElementById('btn-submit-poll').querySelector('span').textContent = '保存更改';
  modal.style.display = 'flex';
};

function handlePollOptionClick(chatId, msgId, optIdx, isMultiple) {
  if (!isMultiple) {
    const message = (state.clientMessages || []).find(item => Number(item.id) === Number(msgId));
    if (message?.media?.options?.[optIdx]?.chosen) return;
    sendPollVote(chatId, msgId, [optIdx]);
    return;
  }

  const key = JSON.stringify([state.clientSelectedInstance, String(chatId), String(msgId)]);
  if (!pendingPollVotes[key]) {
    const message = (state.clientMessages || []).find(item => Number(item.id) === Number(msgId));
    const currentOptions = message?.media?.options || [];
    pendingPollVotes[key] = new Set(currentOptions.filter(option => option.chosen).map(option => Number(option.optionIndex)));
  }
  const set = pendingPollVotes[key];
  if (set.has(optIdx)) {
    set.delete(optIdx);
  } else {
    set.add(optIdx);
  }

  const card = document.getElementById(`poll-card-${msgId}`);
  if (card) {
    const rows = card.querySelectorAll('.poll-option-row');
    rows.forEach((r) => {
      const idx = Number(r.dataset.optIdx);
      r.classList.toggle('selected', set.has(idx));
    });

    const submitBtn = document.getElementById(`btn-poll-submit-${msgId}`);
    if (submitBtn) {
      const message = (state.clientMessages || []).find(item => Number(item.id) === Number(msgId));
      const chosen = (message?.media?.options || []).filter(option => option.chosen).map(option => Number(option.optionIndex));
      const changed = set.size !== chosen.length || chosen.some(index => !set.has(index));
      const voted = chosen.length > 0;
      submitBtn.style.display = (changed && (set.size > 0 || voted)) ? 'inline-flex' : 'none';
      const label = submitBtn.querySelector('span');
      if (label) label.textContent = set.size ? (voted ? '更改投票' : '提交投票') : '撤回投票';
    }
  }
}

function submitMultiPollVote(chatId, msgId) {
  const key = JSON.stringify([state.clientSelectedInstance, String(chatId), String(msgId)]);
  const set = pendingPollVotes[key];
  if (!set) return;
  const message = (state.clientMessages || []).find(item => Number(item.id) === Number(msgId));
  const hasVoted = (message?.media?.options || []).some(option => option.chosen);
  if (set.size === 0 && !hasVoted) return showToast('请至少选择一个选项', 'warn');
  const options = Array.from(set);
  delete pendingPollVotes[key];
  sendPollVote(chatId, msgId, options);
}

function withdrawTelegramPollVote(chatId, msgId) {
  return sendPollVote(chatId, msgId, []);
}

async function sendPollVote(chatId, msgId, options) {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('未选择账号', 'warn');

  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/vote`, 'POST', {
      chatId, messageId: msgId, optionIndexes: options,
    });
    showToast('投票成功!', 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId)) {
      await loadClientMessages(chatId, true);
    }
  } catch (err) {
    showToast(`投票请求失败: ${err.message}`, 'error');
  }
}

async function sendTelegramDice(chatId, emoticon = '🎲', topicId) {
  const instId = state.clientSelectedInstance;
  const targetChatId = Number(chatId);
  const selectionVersion = state.chatSelectionVersion || 0;
  if (!instId) return showToast('未选择账号', 'warn');
  if (!Number.isSafeInteger(targetChatId) || targetChatId === 0 || Number(state.clientActiveChatId) !== targetChatId ||
      !['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'].includes(emoticon) ||
      (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0))) {
    showToast('无效的骰子消息目标', 'warn');
    return false;
  }

  try {
    await api(`/api/instances/${encodeURIComponent(instId)}/account/dice`, 'POST', {
      chatId: targetChatId, emoticon, ...(topicId == null ? {} : { topicId: Number(topicId) }),
    });
    showToast('骰子已发送', 'success');
    if (state.clientSelectedInstance === instId && Number(state.clientActiveChatId) === targetChatId &&
        (state.chatSelectionVersion || 0) === selectionVersion && topicId == null) {
      await loadClientMessages(targetChatId, true);
    }
    return true;
  } catch (error) {
    if (state.clientSelectedInstance === instId && Number(state.clientActiveChatId) === targetChatId &&
        (state.chatSelectionVersion || 0) === selectionVersion) showToast(`骰子发送失败: ${error.message}`, 'error');
    return false;
  }
}

function initPollModal() {
  const btnOpenPoll = document.getElementById('btn-chat-poll');
  const modalPoll = document.getElementById('modal-create-poll');
  const btnClose = document.getElementById('btn-close-poll-modal');
  const btnCancel = document.getElementById('btn-cancel-poll');
  const btnAddOption = document.getElementById('btn-add-poll-option');
  const btnSubmit = document.getElementById('btn-submit-poll');
  const chkQuiz = document.getElementById('poll-quiz-input');
  const chkMultiple = document.getElementById('poll-multiple-input');
  const quizSolutionWrap = document.getElementById('poll-quiz-solution-wrap');
  const pollScheduleToggle = document.getElementById('poll-schedule-toggle');
  const pollScheduleFields = document.getElementById('poll-schedule-fields');
  const pollScheduleInput = document.getElementById('poll-schedule-input');
  const pollRepeatInput = document.getElementById('poll-repeat-period');

  if (!modalPoll) return;

  const openPollModal = () => {
    if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
    pollEditSession = null;
    document.getElementById('poll-modal-title').textContent = '新建原生投票 / 测验';
    document.getElementById('poll-question-input').value = '';
    document.getElementById('poll-anonymous-input').checked = true;
    document.getElementById('poll-anonymous-input').disabled = false;
    chkMultiple.checked = false;
    chkMultiple.disabled = false;
    chkQuiz.checked = false;
    chkQuiz.disabled = false;
    quizSolutionWrap.style.display = 'none';
    document.getElementById('poll-solution-input').value = '';
    if (pollScheduleToggle) pollScheduleToggle.checked = false;
    if (pollScheduleFields) pollScheduleFields.style.display = 'none';
    if (pollScheduleInput) pollScheduleInput.value = '';
    if (pollRepeatInput) pollRepeatInput.value = '0';
    btnSubmit.querySelector('span').textContent = '立即发布';

    renderPollModalOptions(['', '']);
    modalPoll.style.display = 'flex';
  };

  const closePollModal = () => {
    modalPoll.style.display = 'none';
    pollEditSession = null;
  };

  window.openPollCreationForRequest = (quiz) => {
    if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
    openPollModal();
    chkQuiz.checked = typeof quiz === 'boolean' ? quiz : false;
    chkQuiz.disabled = typeof quiz === 'boolean';
    chkQuiz.onchange?.();
  };

  if (btnOpenPoll) btnOpenPoll.onclick = openPollModal;
  if (btnClose) btnClose.onclick = closePollModal;
  if (btnCancel) btnCancel.onclick = closePollModal;

  if (pollScheduleToggle) {
    pollScheduleToggle.onchange = () => {
      if (pollScheduleFields) pollScheduleFields.style.display = pollScheduleToggle.checked ? 'block' : 'none';
    };
  }

  if (chkQuiz) {
    chkQuiz.onchange = () => {
      if (chkQuiz.checked) {
        chkMultiple.checked = false;
        chkMultiple.disabled = true;
        quizSolutionWrap.style.display = 'block';
      } else {
        chkMultiple.disabled = false;
        quizSolutionWrap.style.display = 'none';
      }
      updatePollQuizRadiosVisibility();
    };
  }

  if (chkMultiple) {
    chkMultiple.onchange = () => {
      if (chkMultiple.checked) {
        chkQuiz.checked = false;
        chkQuiz.disabled = true;
        quizSolutionWrap.style.display = 'none';
      } else {
        chkQuiz.disabled = false;
      }
      updatePollQuizRadiosVisibility();
    };
  }

  if (btnAddOption) {
    btnAddOption.onclick = () => {
      const container = document.getElementById('poll-options-builder');
      const rows = container.querySelectorAll('.poll-option-input-row');
      if (rows.length >= 10) return showToast('最多支持 10 个选项', 'warn');
      const currentVals = Array.from(rows).map((r) => r.querySelector('.poll-opt-text')?.value || '');
      currentVals.push('');
      renderPollModalOptions(currentVals);
    };
  }

  if (btnSubmit) {
    btnSubmit.onclick = submitCreatePoll;
  }
}

function renderPollModalOptions(values = ['', ''], correctOptionIndex = 0) {
  const container = document.getElementById('poll-options-builder');
  if (!container) return;
  const isQuiz = document.getElementById('poll-quiz-input')?.checked || false;
  const count = values.length;

  container.innerHTML = values.map((val, idx) => `
    <div class="poll-option-input-row" style="display: flex; align-items: center; gap: 8px;">
      <input type="radio" name="poll-quiz-radio" class="poll-quiz-radio" data-idx="${idx}" title="设为正确答案" ${idx === correctOptionIndex ? 'checked' : ''} style="${isQuiz ? 'display:block;' : 'display:none;'}">
      <input type="text" class="input-control poll-opt-text" maxlength="100" placeholder="选项 ${idx + 1}" value="${escapeHtml(val)}" style="flex: 1;">
      <button type="button" class="btn-icon-subtle btn-remove-poll-opt" onclick="removePollOptionRow(${idx})" title="删除此项" style="${count > 2 ? 'visibility:visible;' : 'visibility:hidden;'}">
        <svg class="ui-icon-xs"><use href="#icon-close"/></svg>
      </button>
    </div>
  `).join('');
}

function updatePollQuizRadiosVisibility() {
  const isQuiz = document.getElementById('poll-quiz-input')?.checked || false;
  document.querySelectorAll('.poll-quiz-radio').forEach((r) => {
    r.style.display = isQuiz ? 'block' : 'none';
  });
}

function removePollOptionRow(idx) {
  const container = document.getElementById('poll-options-builder');
  const rows = container.querySelectorAll('.poll-option-input-row');
  if (rows.length <= 2) return;
  const currentVals = Array.from(rows).map((r) => r.querySelector('.poll-opt-text')?.value || '');
  currentVals.splice(idx, 1);
  renderPollModalOptions(currentVals);
}

async function submitCreatePoll() {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  if (!instId || !chatId) return showToast('未指定账号或会话', 'warn');
  const editSession = pollEditSession;
  if (editSession && (editSession.instId !== instId || editSession.chatId !== Number(chatId) ||
      editSession.selectionVersion !== (state.chatSelectionVersion || 0))) {
    pollEditSession = null;
    return showToast('会话已切换，请重新打开投票编辑', 'warn');
  }

  const question = document.getElementById('poll-question-input')?.value?.trim();
  if (!question) return showToast('请输入投票或测验题目', 'warn');
  if (question.length > 300) return showToast('题目不能超过 300 个字符', 'warn');

  const rows = document.querySelectorAll('.poll-option-input-row');
  const options = Array.from(rows, (r) => r.querySelector('.poll-opt-text')?.value?.trim() || '');

  if (options.length < 2) return showToast('请至少输入 2 个有效选项', 'warn');
  if (options.some((option) => !option)) return showToast('请填写所有选项或删除空选项', 'warn');
  if (options.some(option => option.length > 100)) return showToast('每个选项不能超过 100 个字符', 'warn');
  if (new Set(options).size !== options.length) return showToast('投票选项不能重复', 'warn');

  const isAnonymous = document.getElementById('poll-anonymous-input')?.checked ?? true;
  const multipleAnswers = document.getElementById('poll-multiple-input')?.checked ?? false;
  const isQuiz = document.getElementById('poll-quiz-input')?.checked ?? false;

  let correctOptionIndex = undefined;
  let solution = undefined;
  if (isQuiz) {
    const checkedRadio = document.querySelector('.poll-quiz-radio:checked');
    if (editSession && !checkedRadio) return showToast('请选择测验的正确答案', 'warn');
    correctOptionIndex = checkedRadio ? Number(checkedRadio.dataset.idx) : 0;
    solution = document.getElementById('poll-solution-input')?.value?.trim() || undefined;
    if (solution && solution.length > 200) return showToast('测验说明不能超过 200 个字符', 'warn');
  }

  let schedule;
  let scheduleRepeatPeriod;
  if (!editSession && document.getElementById('poll-schedule-toggle')?.checked) {
    const value = document.getElementById('poll-schedule-input')?.value;
    const targetTime = value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(targetTime) || targetTime <= Date.now()) return showToast('设定时间必须晚于当前时间', 'warn');
    schedule = Math.floor(targetTime / 1000);
    scheduleRepeatPeriod = Number(document.getElementById('poll-repeat-period')?.value || 0) || undefined;
  }

  try {
    if (editSession) {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/poll/edit`, 'POST', {
        chatId, messageId: editSession.messageId, question, options,
        pollOptions: { correctOptionIndex, explanation: solution },
      });
    } else {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/poll`, 'POST', {
        chatId, question, options,
        pollOptions: { isAnonymous, isMultipleChoice: multipleAnswers, isQuiz, correctOptionIndex, explanation: solution },
        ...(schedule ? { schedule } : {}),
        ...(scheduleRepeatPeriod ? { scheduleRepeatPeriod } : {}),
      });
    }
    showToast(editSession ? '投票已更新' : schedule ? '投票定时已设定' : '投票已成功发布', 'success');
    if (state.clientSelectedInstance === instId && String(state.clientActiveChatId) === String(chatId)) {
      document.getElementById('modal-create-poll').style.display = 'none';
      pollEditSession = null;
      await loadClientMessages(chatId, true);
    }
  } catch (err) {
    showToast(`${editSession ? '编辑' : '创建'}投票失败: ${err.message}`, 'error');
  }
}

// ==========================================
// Wallpaper Themes Controller
// ==========================================
function initChatThemes() {
  const savedTheme = localStorage.getItem('tg_chat_wallpaper_theme') || 'obsidian';
  applyChatTheme(savedTheme, false);

  const btnThemeToggle = document.getElementById('btn-chat-theme-toggle');
  const modalTheme = document.getElementById('modal-chat-theme');
  const btnCloseModal = document.getElementById('btn-close-theme-modal');

  if (btnThemeToggle && modalTheme) {
    btnThemeToggle.onclick = () => {
      const current = localStorage.getItem('tg_chat_wallpaper_theme') || 'obsidian';
      modalTheme.querySelectorAll('.theme-card').forEach((card) => {
        card.classList.toggle('active', card.dataset.theme === current);
      });
      modalTheme.style.display = 'flex';
      void loadTelegramChatThemes(state.clientSelectedInstance, state.clientActiveDialog, state.chatSelectionVersion);
      void loadTelegramChatWallpapers(state.clientSelectedInstance, state.clientActiveDialog, state.chatSelectionVersion);
    };
  }

  if (btnCloseModal && modalTheme) {
    btnCloseModal.onclick = () => {
      modalTheme.style.display = 'none';
    };
  }

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.onclick = () => {
      const theme = card.dataset.theme;
      applyChatTheme(theme, true);
      document.querySelectorAll('.theme-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      if (modalTheme) modalTheme.style.display = 'none';
    };
  });
}

let telegramChatThemeCatalog = { instId: null, items: [] };
let telegramChatThemeRequest = 0;

function supportsTelegramChatTheme(dialog) {
  return Boolean(dialog && dialog.type === 'private' && !dialog.isSelf);
}

function clearTelegramChatAppearance() {
  state.clientTelegramChatTheme = null;
  state.clientTelegramChatWallpaper = null;
  if (typeof telegramChatThemeRequest === 'number') telegramChatThemeRequest++;
  if (typeof telegramChatWallpaperRequest === 'number') telegramChatWallpaperRequest++;
  const pane = document.querySelector('.client-chat-pane');
  pane?.classList?.remove?.('telegram-wallpaper-active');
  for (const property of ['--tg-peer-theme-out-bg', '--tg-peer-wallpaper-image', '--tg-peer-wallpaper-bg',
    '--tg-peer-wallpaper-size', '--tg-peer-wallpaper-repeat']) pane?.style?.removeProperty?.(property);
  removeTelegramWallpaperLayer();
  syncTelegramChatWallpaperControls({}, false, false);
}

function supportsTelegramChatWallpaper(dialog) {
  return Boolean(dialog && !dialog.isSelf && (dialog.type === 'private' || dialog.type === 'group' || dialog.type === 'supergroup' || dialog.type === 'channel'));
}

async function ensureTelegramChatThemeCatalog(instId) {
  if (telegramChatThemeCatalog.instId === instId) return telegramChatThemeCatalog.items;
  const themes = await api(`/api/instances/${encodeURIComponent(instId)}/account/chat-themes`);
  if (state.clientSelectedInstance !== instId) return [];
  telegramChatThemeCatalog = { instId, items: Array.isArray(themes) ? themes.filter(theme =>
    theme && typeof theme.emoticon === 'string' && theme.emoticon && typeof theme.title === 'string').slice(0, 100) : [] };
  return telegramChatThemeCatalog.items;
}

function applyTelegramChatThemeColor(emoticon) {
  const pane = document.querySelector('.client-chat-pane');
  if (!pane) return;
  const theme = telegramChatThemeCatalog.items.find(item => item.emoticon === emoticon);
  const color = theme?.accentColor;
  if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) {
    pane.style.removeProperty('--tg-peer-theme-out-bg');
    return;
  }
  pane.style.setProperty('--tg-peer-theme-out-bg', `#${color.toString(16).padStart(6, '0')}`);
}

function renderTelegramChatThemeOptions(themes, currentEmoticon, disabled = false) {
  const options = document.getElementById('telegram-chat-theme-options');
  if (!options) return;
  options.replaceChildren();
  const choices = [{ emoticon: '', title: '默认' }, ...themes];
  for (const theme of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `telegram-chat-theme-option${theme.emoticon === currentEmoticon ? ' active' : ''}`;
    button.disabled = disabled;
    button.setAttribute('aria-pressed', theme.emoticon === currentEmoticon ? 'true' : 'false');
    button.setAttribute('aria-label', theme.title);
    const emoji = document.createElement('span');
    emoji.className = 'telegram-chat-theme-option-emoji';
    emoji.textContent = theme.emoticon || '○';
    const title = document.createElement('span');
    title.className = 'telegram-chat-theme-option-title';
    title.textContent = theme.title;
    button.append(emoji, title);
    button.onclick = () => { void setTelegramChatTheme(theme.emoticon); };
    options.appendChild(button);
  }
}

async function loadTelegramChatThemeForDialog(instId, dialog, selectionVersion) {
  const request = ++telegramChatThemeRequest;
  const hasTheme = supportsTelegramChatTheme(dialog);
  const hasWallpaper = supportsTelegramChatWallpaper(dialog);
  if ((!hasTheme && !hasWallpaper) || !instId) {
    state.clientTelegramChatTheme = null;
    applyTelegramChatThemeColor('');
    state.clientTelegramChatWallpaper = null;
    applyTelegramChatWallpaper(null);
    return;
  }
  const isCurrent = () => request === telegramChatThemeRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion;
  try {
    const [themes, selected] = await Promise.all([
      hasTheme ? ensureTelegramChatThemeCatalog(instId) : Promise.resolve([]),
      api(`/api/instances/${encodeURIComponent(instId)}/account/chat-theme?chatId=${encodeURIComponent(dialog.id)}`),
    ]);
    if (!isCurrent()) return;
    if (hasTheme) {
      if (telegramChatThemeCatalog.instId !== instId) telegramChatThemeCatalog = { instId, items: themes };
      state.clientTelegramChatTheme = typeof selected?.emoticon === 'string' ? selected.emoticon : '';
      applyTelegramChatThemeColor(state.clientTelegramChatTheme);
    } else {
      state.clientTelegramChatTheme = null;
      applyTelegramChatThemeColor('');
    }
    state.clientTelegramChatWallpaper = selected?.wallpaper || null;
    applyTelegramChatWallpaper(state.clientTelegramChatWallpaper, instId);
  } catch (_) {
    if (isCurrent()) {
      state.clientTelegramChatTheme = null;
      applyTelegramChatThemeColor('');
      state.clientTelegramChatWallpaper = null;
      applyTelegramChatWallpaper(null);
    }
  }
}

async function loadTelegramChatThemes(instId, dialog, selectionVersion) {
  const status = document.getElementById('telegram-chat-theme-status');
  const options = document.getElementById('telegram-chat-theme-options');
  if (!status || !options) return;
  if (!supportsTelegramChatTheme(dialog) || !instId) {
    status.textContent = 'Telegram 会话主题仅适用于已打开的私聊。';
    renderTelegramChatThemeOptions([], '', true);
    return;
  }
  const request = ++telegramChatThemeRequest;
  const isCurrent = () => request === telegramChatThemeRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion;
  status.textContent = '正在读取 Telegram 会话主题…';
  renderTelegramChatThemeOptions([], '', true);
  try {
    const [themes, selected] = await Promise.all([
      ensureTelegramChatThemeCatalog(instId),
      api(`/api/instances/${encodeURIComponent(instId)}/account/chat-theme?chatId=${encodeURIComponent(dialog.id)}`),
    ]);
    if (!isCurrent()) return;
    if (telegramChatThemeCatalog.instId !== instId) telegramChatThemeCatalog = { instId, items: themes };
    state.clientTelegramChatTheme = typeof selected?.emoticon === 'string' ? selected.emoticon : '';
    applyTelegramChatThemeColor(state.clientTelegramChatTheme);
    status.textContent = themes.length ? '更改会同步到此私聊的其他 Telegram 设备。' : 'Telegram 当前未返回可用主题。';
    renderTelegramChatThemeOptions(themes, state.clientTelegramChatTheme, !themes.length);
  } catch (error) {
    if (!isCurrent()) return;
    status.textContent = `无法读取 Telegram 会话主题：${error.message}`;
    renderTelegramChatThemeOptions([], '', true);
  }
}

async function setTelegramChatTheme(emoticon) {
  const dialog = state.clientActiveDialog;
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  const status = document.getElementById('telegram-chat-theme-status');
  if (!supportsTelegramChatTheme(dialog) || !instId || typeof emoticon !== 'string') return;
  const request = ++telegramChatThemeRequest;
  const isCurrent = () => request === telegramChatThemeRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion;
  renderTelegramChatThemeOptions(telegramChatThemeCatalog.items, state.clientTelegramChatTheme || '', true);
  if (status) status.textContent = '正在保存到 Telegram…';
  try {
    const selected = await api(`/api/instances/${encodeURIComponent(instId)}/account/chat-theme`, 'POST', { chatId: dialog.id, emoticon });
    if (!isCurrent()) return;
    state.clientTelegramChatTheme = selected?.emoticon || '';
    applyTelegramChatThemeColor(state.clientTelegramChatTheme);
    if (status) status.textContent = '主题已保存并同步到 Telegram。';
    renderTelegramChatThemeOptions(telegramChatThemeCatalog.items, state.clientTelegramChatTheme);
  } catch (error) {
    if (!isCurrent()) return;
    if (status) status.textContent = `保存 Telegram 主题失败：${error.message}`;
    renderTelegramChatThemeOptions(telegramChatThemeCatalog.items, state.clientTelegramChatTheme || '');
  }
}

let telegramWallpaperCatalog = { instId: null, items: [] };
let telegramChatWallpaperRequest = 0;
let telegramWallpaperLayerPane = null;
let telegramWallpaperLayer = null;
let telegramWallpaperVideo = null;

async function ensureTelegramWallpaperCatalog(instId) {
  if (telegramWallpaperCatalog.instId === instId) return telegramWallpaperCatalog.items;
  const wallpapers = await api(`/api/instances/${encodeURIComponent(instId)}/account/wallpapers`);
  if (state.clientSelectedInstance !== instId) return [];
  telegramWallpaperCatalog = { instId, items: Array.isArray(wallpapers) ? wallpapers.filter(item =>
    item && typeof item.slug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.slug) && typeof item.title === 'string').slice(0, 200) : [] };
  return telegramWallpaperCatalog.items;
}

function applyTelegramChatWallpaper(wallpaper, instId = state.clientSelectedInstance) {
  const pane = document.querySelector('.client-chat-pane');
  if (!pane) return;
  const slug = typeof wallpaper?.slug === 'string' ? wallpaper.slug : '';
  if (!slug || !instId) {
    pane.classList.remove('telegram-wallpaper-active');
    pane.style.removeProperty('--tg-peer-wallpaper-image');
    pane.style.removeProperty('--tg-peer-wallpaper-bg');
    pane.style.removeProperty('--tg-peer-wallpaper-size');
    pane.style.removeProperty('--tg-peer-wallpaper-repeat');
    removeTelegramWallpaperLayer();
    syncTelegramChatWallpaperControls({}, false, false);
    return;
  }
  const imageType = ['image/jpeg', 'image/png', 'image/webp'].includes(wallpaper.mimeType);
  const isMotionVideo = wallpaper.mimeType === 'video/mp4' && wallpaper.motion === true;
  const sourceKind = imageType || isMotionVideo ? 'wallpaper-file' : 'wallpaper-preview';
  const source = `/api/instances/${encodeURIComponent(instId)}/account/${sourceKind}?slug=${encodeURIComponent(slug)}`;
  pane.style.setProperty('--tg-peer-wallpaper-image', `url("${source}")`);
  const wallpaperLayer = ensureTelegramWallpaperLayer(pane);
  pauseTelegramWallpaperVideo();
  wallpaperLayer.replaceChildren();
  telegramWallpaperVideo = null;
  const color = Number.isInteger(wallpaper.backgroundColor) && wallpaper.backgroundColor >= 0 && wallpaper.backgroundColor <= 0xFFFFFF
    ? `#${wallpaper.backgroundColor.toString(16).padStart(6, '0')}` : 'transparent';
  pane.style.setProperty('--tg-peer-wallpaper-bg', color);
  pane.style.setProperty('--tg-peer-wallpaper-size', wallpaper.pattern ? 'auto 300px' : 'cover');
  pane.style.setProperty('--tg-peer-wallpaper-repeat', wallpaper.pattern ? 'repeat' : 'no-repeat');
  wallpaperLayer.style.backgroundColor = color;
  wallpaperLayer.style.backgroundPosition = 'center';
  wallpaperLayer.style.backgroundSize = wallpaper.pattern ? 'auto 300px, cover' : 'cover';
  wallpaperLayer.style.backgroundRepeat = wallpaper.pattern ? 'repeat, no-repeat' : 'no-repeat';
  wallpaperLayer.style.filter = wallpaper.settings?.blur ? 'blur(8px)' : 'none';
  wallpaperLayer.style.transform = wallpaper.settings?.blur ? 'scale(1.04)' : 'none';
  if (isMotionVideo) {
    const video = document.createElement('video');
    video.className = 'telegram-chat-wallpaper-video';
    video.src = source;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    wallpaperLayer.appendChild(video);
    telegramWallpaperVideo = video;
    const playback = video.play?.();
    if (playback?.catch) playback.catch(() => {});
    wallpaperLayer.style.backgroundImage = 'none';
    wallpaperLayer.style.opacity = '1';
  } else {
    let backgroundImage = `url("${source}")`;
    if (wallpaper.pattern) {
      const colors = Array.isArray(wallpaper.settings?.backgroundColors)
        ? wallpaper.settings.backgroundColors.filter(item => Number.isInteger(item) && item >= 0 && item <= 0xFFFFFF).slice(0, 4) : [];
      const rotation = Number.isInteger(wallpaper.settings?.rotation) ? wallpaper.settings.rotation : 135;
      const stops = colors.length > 1
        ? colors.map((item, index) => `#${item.toString(16).padStart(6, '0')} ${Math.round(index * 100 / (colors.length - 1))}%`).join(', ')
        : `${color} 0%, ${color} 100%`;
      backgroundImage += `, linear-gradient(${rotation}deg, ${stops})`;
      const intensity = Number.isInteger(wallpaper.settings?.intensity) ? Math.abs(wallpaper.settings.intensity) : 50;
      wallpaperLayer.style.opacity = String(Math.max(0, Math.min(100, intensity)) / 100);
    } else wallpaperLayer.style.opacity = '1';
    wallpaperLayer.style.backgroundImage = backgroundImage;
  }
  pane.classList.add('telegram-wallpaper-active');
  syncTelegramChatWallpaperControls(wallpaper.settings || {}, true, Boolean(wallpaper.pattern));
}

function ensureTelegramWallpaperLayer(pane) {
  if (telegramWallpaperLayerPane !== pane || !telegramWallpaperLayer) {
    removeTelegramWallpaperLayer();
    telegramWallpaperLayerPane = pane;
    telegramWallpaperLayer = document.createElement('div');
    telegramWallpaperLayer.className = 'telegram-chat-wallpaper-layer';
    telegramWallpaperLayer.setAttribute('aria-hidden', 'true');
    pane.appendChild(telegramWallpaperLayer);
  }
  return telegramWallpaperLayer;
}

function pauseTelegramWallpaperVideo() {
  if (!telegramWallpaperVideo) return;
  telegramWallpaperVideo.pause?.();
  telegramWallpaperVideo.removeAttribute?.('src');
  telegramWallpaperVideo.load?.();
  telegramWallpaperVideo = null;
}

function removeTelegramWallpaperLayer() {
  pauseTelegramWallpaperVideo();
  telegramWallpaperLayer?.remove?.();
  if (telegramWallpaperLayer && !telegramWallpaperLayer.remove) telegramWallpaperLayer.hidden = true;
  telegramWallpaperLayer = null;
  telegramWallpaperLayerPane = null;
}

function syncTelegramChatWallpaperControls(settings, enabled, pattern) {
  const blur = document.getElementById('telegram-chat-wallpaper-blur');
  const motion = document.getElementById('telegram-chat-wallpaper-motion');
  const intensity = document.getElementById('telegram-chat-wallpaper-intensity');
  const intensityValue = document.getElementById('telegram-chat-wallpaper-intensity-value');
  if (blur) { blur.checked = Boolean(settings?.blur); blur.disabled = !enabled; }
  if (motion) { motion.checked = Boolean(settings?.motion); motion.disabled = !enabled; }
  if (intensity) {
    const value = Number.isInteger(settings?.intensity) && settings.intensity >= -100 && settings.intensity <= 100 ? settings.intensity : 50;
    intensity.value = String(value);
    intensity.disabled = !enabled || !pattern;
    if (intensityValue) intensityValue.value = String(value);
  }
}

function renderTelegramChatWallpaperOptions(wallpapers, currentSlug, disabled = false) {
  const options = document.getElementById('telegram-chat-wallpaper-options');
  if (!options) return;
  options.replaceChildren();
  const choices = [{ slug: '', title: '默认壁纸', pattern: false }, ...wallpapers];
  for (const wallpaper of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `telegram-chat-wallpaper-option${wallpaper.slug === currentSlug ? ' active' : ''}`;
    button.disabled = disabled;
    button.setAttribute('aria-pressed', wallpaper.slug === currentSlug ? 'true' : 'false');
    button.setAttribute('aria-label', wallpaper.title);
    if (wallpaper.slug) {
      const image = document.createElement('img');
      image.className = 'telegram-chat-wallpaper-preview';
      image.src = `/api/instances/${encodeURIComponent(state.clientSelectedInstance)}/account/wallpaper-preview?slug=${encodeURIComponent(wallpaper.slug)}`;
      image.alt = '';
      image.loading = 'lazy';
      button.appendChild(image);
    } else {
      const empty = document.createElement('span');
      empty.className = 'telegram-chat-wallpaper-default';
      empty.textContent = '默认';
      button.appendChild(empty);
    }
    const title = document.createElement('span');
    title.className = 'telegram-chat-wallpaper-title';
    title.textContent = wallpaper.title;
    button.appendChild(title);
    button.onclick = () => {
      if (wallpaper.slug) syncTelegramChatWallpaperControls(wallpaper.settings || {}, true, Boolean(wallpaper.pattern));
      void setTelegramChatWallpaper(wallpaper.slug);
    };
    options.appendChild(button);
  }
}

async function loadTelegramChatWallpapers(instId, dialog, selectionVersion) {
  const status = document.getElementById('telegram-chat-wallpaper-status');
  const options = document.getElementById('telegram-chat-wallpaper-options');
  const forBoth = document.getElementById('telegram-chat-wallpaper-for-both');
  if (!status || !options) return;
  if (forBoth) {
    forBoth.checked = false;
    forBoth.disabled = !supportsTelegramChatWallpaper(dialog) || dialog.type !== 'private';
    forBoth.parentElement && (forBoth.parentElement.hidden = dialog?.type !== 'private');
  }
  const blurControl = document.getElementById('telegram-chat-wallpaper-blur');
  const motionControl = document.getElementById('telegram-chat-wallpaper-motion');
  const intensityControl = document.getElementById('telegram-chat-wallpaper-intensity');
  const intensityValue = document.getElementById('telegram-chat-wallpaper-intensity-value');
  const updateCurrentWallpaper = () => {
    const slug = state.clientTelegramChatWallpaper?.slug;
    if (slug) void setTelegramChatWallpaper(slug);
  };
  if (blurControl) blurControl.onchange = updateCurrentWallpaper;
  if (motionControl) motionControl.onchange = updateCurrentWallpaper;
  if (intensityControl) {
    intensityControl.oninput = () => { if (intensityValue) intensityValue.value = intensityControl.value; };
    intensityControl.onchange = updateCurrentWallpaper;
  }
  if (!supportsTelegramChatWallpaper(dialog) || !instId) {
    status.textContent = 'Telegram 聊天壁纸仅适用于已打开的私聊、群组、超级群或频道。';
    renderTelegramChatWallpaperOptions([], '', true);
    return;
  }
  const request = ++telegramChatWallpaperRequest;
  const isCurrent = () => request === telegramChatWallpaperRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion;
  status.textContent = '正在读取 Telegram 壁纸目录…';
  renderTelegramChatWallpaperOptions([], state.clientTelegramChatWallpaper?.slug || '', true);
  try {
    const wallpapers = await ensureTelegramWallpaperCatalog(instId);
    if (!isCurrent()) return;
    const current = state.clientTelegramChatWallpaper?.slug || '';
    status.textContent = wallpapers.length ? '设置由 Telegram 保存；静态图直接显示，动态视频静音循环播放，模糊与图案强度一并同步。' : 'Telegram 当前未返回可用壁纸。';
    renderTelegramChatWallpaperOptions(wallpapers, current, !wallpapers.length);
  } catch (error) {
    if (!isCurrent()) return;
    status.textContent = `无法读取 Telegram 壁纸目录：${error.message}`;
    renderTelegramChatWallpaperOptions([], state.clientTelegramChatWallpaper?.slug || '', true);
  }
}

async function setTelegramChatWallpaper(slug) {
  const dialog = state.clientActiveDialog;
  const instId = state.clientSelectedInstance;
  const selectionVersion = state.chatSelectionVersion;
  const status = document.getElementById('telegram-chat-wallpaper-status');
  if (!supportsTelegramChatWallpaper(dialog) || !instId || typeof slug !== 'string') return;
  const forBothControl = document.getElementById('telegram-chat-wallpaper-for-both');
  const forBoth = Boolean(slug && dialog.type === 'private' && forBothControl?.checked);
  const selectedWallpaper = telegramWallpaperCatalog.items.find(item => item.slug === slug);
  const blurControl = document.getElementById('telegram-chat-wallpaper-blur');
  const motionControl = document.getElementById('telegram-chat-wallpaper-motion');
  const intensityControl = document.getElementById('telegram-chat-wallpaper-intensity');
  const settings = slug ? {
    blur: Boolean(blurControl?.checked),
    motion: Boolean(motionControl?.checked),
    ...(selectedWallpaper?.pattern && intensityControl ? { intensity: Number(intensityControl.value) } : {}),
  } : {};
  const request = ++telegramChatWallpaperRequest;
  const isCurrent = () => request === telegramChatWallpaperRequest && state.clientSelectedInstance === instId &&
    String(state.clientActiveChatId) === String(dialog.id) && state.chatSelectionVersion === selectionVersion;
  renderTelegramChatWallpaperOptions(telegramWallpaperCatalog.items, state.clientTelegramChatWallpaper?.slug || '', true);
  for (const control of [blurControl, motionControl, intensityControl]) if (control) control.disabled = true;
  if (status) status.textContent = '正在保存到 Telegram…';
  try {
    const selected = await api(`/api/instances/${encodeURIComponent(instId)}/account/chat-wallpaper`, 'POST', { chatId: dialog.id, slug, forBoth, settings });
    if (!isCurrent()) return;
    if (forBothControl && forBoth) forBothControl.checked = false;
    const item = telegramWallpaperCatalog.items.find(wallpaper => wallpaper.slug === selected?.slug);
    state.clientTelegramChatWallpaper = selected?.slug ? { ...item, slug: selected.slug, settings: selected.settings || item?.settings } : null;
    applyTelegramChatWallpaper(state.clientTelegramChatWallpaper, instId);
    if (status) status.textContent = selected?.slug ? (forBoth ? '壁纸已保存，并应用到你和聊天对象的 Telegram。' : '壁纸已保存并同步到 Telegram。') : '已恢复 Telegram 默认壁纸。';
    renderTelegramChatWallpaperOptions(telegramWallpaperCatalog.items, selected?.slug || '');
  } catch (error) {
    if (!isCurrent()) return;
    if (status) status.textContent = `保存 Telegram 壁纸失败：${error.message}`;
    renderTelegramChatWallpaperOptions(telegramWallpaperCatalog.items, state.clientTelegramChatWallpaper?.slug || '');
    applyTelegramChatWallpaper(state.clientTelegramChatWallpaper, instId);
  }
}

function refreshTelegramChatWallpaper(instId, chatId) {
  const dialog = state.clientActiveDialog;
  if (instId !== state.clientSelectedInstance || Number(chatId) !== Number(dialog?.id) || !supportsTelegramChatWallpaper(dialog)) return;
  const selectionVersion = state.chatSelectionVersion;
  return loadTelegramChatThemeForDialog(instId, dialog, selectionVersion).then(() => {
    if (instId !== state.clientSelectedInstance || Number(chatId) !== Number(state.clientActiveChatId) ||
        state.chatSelectionVersion !== selectionVersion || telegramWallpaperCatalog.instId !== instId) return;
    renderTelegramChatWallpaperOptions(telegramWallpaperCatalog.items, state.clientTelegramChatWallpaper?.slug || '');
  });
}

function applyChatTheme(theme, showNotice = false) {
  const chatPane = document.querySelector('.client-chat-pane');
  if (!chatPane) return;
  chatPane.classList.remove('theme-obsidian', 'theme-doodle', 'theme-neon', 'theme-aurora');
  chatPane.classList.add(`theme-${theme}`);
  localStorage.setItem('tg_chat_wallpaper_theme', theme);
  if (showNotice) {
    const names = {
      obsidian: '极客黑曜石 (Obsidian)',
      doodle: 'TG经典涂鸦 (Doodle)',
      neon: '赛博霓虹 (Cyber Neon)',
      aurora: '极光幽绿 (Aurora)'
    };
    showToast(`已应用壁纸主题: ${names[theme] || theme}`, 'success');
  }
}

// ==========================================
// Chat Mute & Notification Controller
// ==========================================
function initChatMuteModal() {
  const btnMuteToggle = document.getElementById('btn-chat-mute-toggle');
  const modalMute = document.getElementById('modal-chat-mute');
  const btnClose = document.getElementById('btn-close-mute-modal');

  if (btnMuteToggle && modalMute) {
    btnMuteToggle.onclick = () => {
      if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
      modalMute.style.display = 'flex';
    };
  }

  if (btnClose && modalMute) {
    btnClose.onclick = () => {
      modalMute.style.display = 'none';
    };
  }

  document.querySelectorAll('.mute-option-btn').forEach((btn) => {
    btn.onclick = async () => {
      const durationVal = btn.dataset.muteDuration;
      await handleSetChatMute(durationVal);
      if (modalMute) modalMute.style.display = 'none';
    };
  });
}

async function handleSetChatMute(durationVal) {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  if (!instId || !chatId) return showToast('未指定会话', 'warn');

  let muteUntil = 0;
  if (durationVal === 'forever') {
    muteUntil = 2147483647;
  } else if (durationVal === 'unmute') {
    muteUntil = 0;
  } else {
    muteUntil = Math.floor(Date.now() / 1000) + Number(durationVal);
  }

  try {
    await setDialogMute(instId, chatId, muteUntil);
    showToast(muteUntil ? '会话已设置为免打扰' : '已恢复消息提醒', 'success');
  } catch (err) {
    showToast(`设置免打扰失败: ${err.message}`, 'error');
  }
}

function updateChatMuteButtonState(chatId) {
  const label = document.getElementById('chat-mute-status-text');
  if (!label) return;
  const isMuted = isDialogMuted(chatId);
  label.innerText = isMuted ? '已静音' : '免打扰';
}

// ==========================================
// Mark All Dialogs as Read
// ==========================================
async function markAllDialogsRead() {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('请先选择账号', 'warn');
  try {
    const res = await fetch(`/api/instances/${instId}/account/mark-all-read`, {
      method: 'POST',
      credentials: 'include'
    });
    const data = await res.json();
    if (data.success) {
      const failed = Number(data.failed) || 0;
      const incomplete = Array.isArray(data.incompleteFolders) && data.incompleteFolders.length > 0;
      if (failed || incomplete) {
        showToast(`已标记 ${Number(data.marked) || 0} 个会话；${failed} 个失败${incomplete ? '，部分会话列表未能完整读取' : ''}`, 'warn');
      } else {
        showToast('会话已标记为已读', 'success');
      }
      if (state.clientSelectedInstance === instId) await loadClientDialogs();
    } else {
      showToast(`标记已读结果未确认，请刷新后检查：${data.error || '请求失败'}`, 'error');
    }
  } catch (err) {
    showToast(`标记已读结果未确认，请刷新后检查：${err.message}`, 'error');
  }
}

// App Initialization
window.onload = async () => {
  window.openSharedTelegramStory = openSharedTelegramStory;
  window.loadClientStoriesFeed = loadClientStoriesFeed;
  window.applyPeerHistoryTtlUpdate = applyPeerHistoryTtlUpdate;
  window.refreshTelegramChatWallpaper = refreshTelegramChatWallpaper;
  window.loadStoryArchive = loadStoryArchive;
  window.refreshStoryViewerForUpdate = refreshStoryViewerForUpdate;
  window.refreshStoryStealthStatus = instId => {
    const session = storyViewer?.session;
    if (session?.instId === instId) void loadStoryStealthStatus(session);
  };
  if (window.ThemeManager) window.ThemeManager.init();
  if (window.SettingsPage) window.SettingsPage.init();
  if (window.ProfilePanel) window.ProfilePanel.init();
  initListeners();
  initManagedImages();
  initManagedAutoplay();
  initSSE();
  initSavedMessageTags();
  initChatTranslationToggle();
  initMessageEffects();
  initMessageContextMenu();
  initCacheSettings();
  initPollModal();
  initQuickRepliesPicker();
  initScheduledMessagesDialog();
  initChatThemes();
  initChatMuteModal();
  const btnMarkAll = document.getElementById('btn-dialogs-mark-all-read');
  if (btnMarkAll) btnMarkAll.onclick = () => markAllDialogsRead();
  await Promise.all([loadStatus(), loadInstances(), loadPlugins()]);
  setInterval(loadStatus, 5000);
};

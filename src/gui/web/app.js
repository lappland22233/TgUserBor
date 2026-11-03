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
  clientDialogs: [],
  clientMessages: [],
  clientDialogFilter: 'all',
  clientReplyingTo: null,
  clientSearchQuery: '',
  profilePhotos: [],
  currentPhotoIndex: 0,
  currentProfileChatId: null,
  sharedMediaTab: 'photos',
  sharedMediaList: [],
  playlist: [],
  currentTrackIndex: -1,
  isPlaying: false,
  schedulerSelectedInstance: null,
  schedulerTasks: [],
  clientDrafts: {},
  chatSendKeyMode: localStorage.getItem('tgbot_chat_send_mode') || 'enter',
  clientSilent: localStorage.getItem('tgbot_chat_silent') === 'true',
  clientParseMode: localStorage.getItem('tgbot_chat_parse_mode') || 'markdown',
  clientStagedFile: null,
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
  clientMutedChats: JSON.parse(localStorage.getItem('tgbot_muted_chats') || '{}'),
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
  t.innerHTML = `<svg class="ui-icon toast-icon"><use href="${iconId}"/></svg><span>${msg}</span>`;
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
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn, priority = 1) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, priority });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.dequeue();
    });
  }

  dequeue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.running++;
    item.fn()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        this.running--;
        this.dequeue();
      });
  }

  fetch(url, options = {}, priority = 1) {
    return this.enqueue(() => fetch(url, options), priority);
  }

  loadImage(imgEl, src, fallbackSrc = '') {
    return this.enqueue(() => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (imgEl) imgEl.src = src;
        resolve(true);
      };
      img.onerror = () => {
        if (imgEl && fallbackSrc) imgEl.src = fallbackSrc;
        resolve(false);
      };
      img.src = src;
    }), 2);
  }
}

const scheduler = new NetworkScheduler(3);

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
  const res = await scheduler.fetch(path, opts, prio);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '网络请求异常' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
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
    closeAuthModal();
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
  // 1. Reset views container scroll to top immediately (prevents scheduler view from opening at bottom)
  const viewsContainer = document.querySelector('.views-container');
  if (viewsContainer) viewsContainer.scrollTop = 0;
  window.scrollTo(0, 0);

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
  const isNeedsAuth = ['NEEDS_PHONE', 'NEEDS_CODE', 'NEEDS_PASSWORD', 'AUTH_REQUIRED'].includes(inst.status);
  const isStarting = inst.status === 'STARTING';

  let statusClass = 'stopped';
  let statusText = '已停止';
  let authStep = 'phone';

  if (isOnline) {
    statusClass = 'online';
    statusText = '运行中';
  } else if (isNeedsAuth) {
    statusClass = 'auth_required';
    if (inst.status === 'NEEDS_CODE') {
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
    <div class="instance-card" id="card-${cfg.id}">
      <div class="inst-card-top">
        <div class="inst-card-info">
          <h4>${escapeHtml(cfg.name)}</h4>
          <span class="inst-card-id">${escapeHtml(cfg.id)} · ${userDisplay}</span>
        </div>
        <span class="status-pill ${statusClass}" id="inst-status-badge-${cfg.id}">
          <span class="pill-dot"></span>
          <span>${statusText}</span>
        </span>
      </div>

      <table class="inst-details-table">
        <tbody>
          <tr>
            <td class="key">内存 / 运行</td>
            <td class="val" id="inst-mem-${cfg.id}">${formatBytes(inst.metrics?.memoryRss)} · ${formatUptime(inst.metrics?.uptime)}</td>
          </tr>
          <tr>
            <td class="key">消息 / 命令</td>
            <td class="val" id="inst-msgs-${cfg.id}">${inst.metrics?.messagesCount || 0} / ${inst.metrics?.commandsCount || 0}</td>
          </tr>
          <tr>
            <td class="key">网络代理</td>
            <td class="val">${cfg.proxy ? `${cfg.proxy.type.toUpperCase()} (${cfg.proxy.host}:${cfg.proxy.port})` : '直连 (无代理)'}</td>
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
            ? `<button class="btn btn-secondary btn-sm" data-action="restart" data-id="${cfg.id}">
                 <svg class="ui-icon-sm"><use href="#icon-refresh"/></svg><span>重启</span>
               </button>
               <button class="btn btn-danger btn-sm" data-action="stop" data-id="${cfg.id}">
                 <svg class="ui-icon-sm"><use href="#icon-stop"/></svg><span>停止</span>
               </button>`
            : isStarting || isNeedsAuth
            ? `<button class="btn btn-danger btn-sm" data-action="stop" data-id="${cfg.id}" title="终止运行">
                 <svg class="ui-icon-sm"><use href="#icon-stop"/></svg><span>停止</span>
               </button>`
            : `<button class="btn btn-primary btn-sm" data-action="start" data-id="${cfg.id}">
                 <svg class="ui-icon-sm"><use href="#icon-play"/></svg><span>启动</span>
               </button>`
        }
        ${
          isNeedsAuth
            ? `<button class="btn btn-primary btn-sm" style="border-color: var(--color-warning); background: rgba(245, 158, 11, 0.25); color: #fbbf24;" data-action="auth" data-id="${cfg.id}" data-step="${authStep}">
                 <svg class="ui-icon-sm"><use href="#icon-key"/></svg><span>${authStep === 'code' ? '输入验证码' : authStep === 'password' ? '输入2FA密码' : '输入手机号'}</span>
               </button>`
            : ''
        }
        <button class="btn btn-secondary btn-sm" data-action="view-logs" data-id="${cfg.id}">
          <svg class="ui-icon-sm"><use href="#icon-terminal"/></svg><span>日志</span>
        </button>
        <button class="btn btn-secondary btn-sm" style="margin-left: auto;" data-action="delete" data-id="${cfg.id}" title="删除实例">
          <svg class="ui-icon-sm"><use href="#icon-trash"/></svg>
        </button>
      </div>
    </div>
  `;
}

function updateInstanceStatus(instanceId, status) {
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
  const opts = state.instances.map((i) => `<option value="${i.config.id}">${i.config.name} (${i.config.id})</option>`).join('');
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
            <button class="btn btn-secondary btn-sm" onclick="openConfigModal('${p.name}')">
              <svg class="ui-icon-sm"><use href="#icon-settings"/></svg><span>配置</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="reloadPlugin('${p.name}')">
              <svg class="ui-icon-sm"><use href="#icon-refresh"/></svg><span>重载</span>
            </button>
            <button class="btn btn-danger btn-sm" onclick="deletePlugin('${p.name}')">
              <svg class="ui-icon-sm"><use href="#icon-trash"/></svg><span>卸载</span>
            </button>
          </div>
          <label class="switch" title="启用/禁用">
            <input type="checkbox" checked onchange="togglePlugin('${p.name}', this.checked)">
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
    <span class="log-tag">[${entry.instanceId}]</span>
    <span class="log-level ${entry.level}">[${entry.level.toUpperCase()}]</span>
    <span class="log-msg">${escapeHtml(entry.msg)}</span>
  `;

  el.terminalContainer.appendChild(line);

  if (el.logAutoScroll.checked) {
    el.terminalContainer.scrollTop = el.terminalContainer.scrollHeight;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // 1. Extract markdown links [label](url)
  const mdLinks = [];
  let processed = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+|tg:\/\/[^\s\)]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s\)]*)\)/g, (match, label, url) => {
    const placeholder = `___MD_LINK_${mdLinks.length}___`;
    const safe = sanitizeUrl(url);
    mdLinks.push(`<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-text-link" title="${safe}">${escapeHtml(label)}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`);
    return placeholder;
  });

  // 2. Escape HTML
  processed = escapeHtml(processed);

  // 3. Autolink plain URLs (https://, http://, t.me/, tg://)
  const urlRegex = /(https?:\/\/[^\s<]+|t\.me\/[a-zA-Z0-9_+\/-]+|tg:\/\/[^\s<]+)/gi;
  processed = processed.replace(urlRegex, (url) => {
    const safe = sanitizeUrl(url);
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-url-link" title="${safe}">${url}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`;
  });

  // 4. Restore Markdown links
  for (let i = 0; i < mdLinks.length; i++) {
    processed = processed.replace(`___MD_LINK_${i}___`, mdLinks[i]);
  }

  // 5. Basic markdown inline formatting
  processed = processed
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="tg-code">$1</code>')
    .replace(/\|\|([^|]+)\|\|/g, '<span class="tg-spoiler" onclick="this.classList.toggle(\'revealed\')" title="点击显示/隐藏剧透">$1</span>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');

  return processed;
}

/**
 * Telegram Full Rich Message Content Formatter
 * Accurately parses entities (TextUrl, Url, Bold, Italic, Code, Pre, Spoiler, etc.)
 */
function formatMessageContent(text, entities) {
  if (!text) return '';
  const rawText = String(text);

  if (Array.isArray(entities) && entities.length > 0) {
    const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);

    let result = '';
    let lastIndex = 0;

    for (const ent of sorted) {
      const offset = Number(ent.offset);
      const length = Number(ent.length);
      if (isNaN(offset) || isNaN(length) || offset < lastIndex || offset >= rawText.length) {
        continue;
      }

      if (offset > lastIndex) {
        result += autoLinkPlainText(rawText.substring(lastIndex, offset));
      }

      const entityText = rawText.substring(offset, offset + length);
      const escapedEntityText = escapeHtml(entityText);
      const type = ent.type || '';

      if ((type === 'MessageEntityTextUrl' || type === 'text_url') && ent.url) {
        const safe = sanitizeUrl(ent.url);
        result += `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-text-link" title="${safe}">${escapedEntityText}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`;
      } else if (type === 'MessageEntityUrl' || type === 'url') {
        const safe = sanitizeUrl(entityText);
        result += `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="tg-link tg-url-link" title="${safe}">${escapedEntityText}<svg class="ext-icon"><use href="#icon-external-link"/></svg></a>`;
      } else if (type === 'MessageEntityBold' || type === 'bold') {
        result += `<strong>${escapedEntityText}</strong>`;
      } else if (type === 'MessageEntityItalic' || type === 'italic') {
        result += `<em>${escapedEntityText}</em>`;
      } else if (type === 'MessageEntityCode' || type === 'code') {
        result += `<code class="tg-code">${escapedEntityText}</code>`;
      } else if (type === 'MessageEntityPre' || type === 'pre') {
        result += `<pre class="tg-pre"><code>${escapedEntityText}</code></pre>`;
      } else if (type === 'MessageEntityStrike' || type === 'strike') {
        result += `<s>${escapedEntityText}</s>`;
      } else if (type === 'MessageEntityUnderline' || type === 'underline') {
        result += `<u>${escapedEntityText}</u>`;
      } else if (type === 'MessageEntitySpoiler' || type === 'spoiler') {
        result += `<span class="tg-spoiler" onclick="this.classList.toggle('revealed')" title="点击显示/隐藏剧透">${escapedEntityText}</span>`;
      } else if (type === 'MessageEntityMention' || type === 'MessageEntityMentionName' || type === 'mention') {
        result += `<span class="tg-mention">${escapedEntityText}</span>`;
      } else {
        result += autoLinkPlainText(entityText);
      }

      lastIndex = offset + length;
    }

    if (lastIndex < rawText.length) {
      result += autoLinkPlainText(rawText.substring(lastIndex));
    }

    return result.replace(/\n/g, '<br>');
  }

  return autoLinkPlainText(rawText).replace(/\n/g, '<br>');
}

// Interactive Auth Modal
function openAuthModal(instanceId, step = 'phone') {
  state.currentAuthInstanceId = instanceId;
  state.currentAuthStep = step;

  document.getElementById('auth-modal-title').innerText = `Telegram 身份验证 (${instanceId})`;

  document.getElementById('auth-group-phone').style.display = step === 'phone' ? 'flex' : 'none';
  document.getElementById('auth-group-code').style.display = step === 'code' ? 'flex' : 'none';
  document.getElementById('auth-group-password').style.display = step === 'password' ? 'flex' : 'none';

  const hints = {
    phone: '请输入该账号国际格式手机号码（如 +8613800000000），点击提交后 Telegram 会发送验证码。',
    code: 'Telegram 验证码已发送至您的官方客户端或短信，请输入收到的数字验证码。',
    password: '该账号已开启两步验证保护，请输入两步验证 (2FA) 密码。',
  };
  document.getElementById('auth-hint').innerText = hints[step] || '请输入验证信息。';

  el.modalAuth.classList.add('active');
  const activeInput =
    step === 'phone'
      ? document.getElementById('auth-input-phone')
      : step === 'code'
      ? document.getElementById('auth-input-code')
      : document.getElementById('auth-input-password');
  setTimeout(() => activeInput.focus(), 100);
}

function closeAuthModal() {
  el.modalAuth.classList.remove('active');
  state.currentAuthInstanceId = null;
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
  document.getElementById('btn-close-auth').onclick = closeAuthModal;
  document.getElementById('btn-cancel-auth').onclick = closeAuthModal;

  const submitAuth = async () => {
    const instId = state.currentAuthInstanceId;
    const step = state.currentAuthStep;
    const btn = document.getElementById('btn-submit-auth');
    const val =
      step === 'phone'
        ? document.getElementById('auth-input-phone').value.trim()
        : step === 'code'
        ? document.getElementById('auth-input-code').value.trim()
        : document.getElementById('auth-input-password').value.trim();

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
      state.clientSelectedInstance = clientAccountSelect.value;
      document.querySelector('.client-layout')?.classList.remove('in-chat');
      updateClientAccountBadge();
      loadClientDialogs();
    };
  }

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
      renderEmojiPicker(btn.dataset.cat, document.getElementById('emoji-search-input')?.value.trim());
    };
  });

  // Emoji Search Input
  const emojiSearch = document.getElementById('emoji-search-input');
  if (emojiSearch) {
    emojiSearch.oninput = () => {
      const activeCat = document.querySelector('.emoji-cat-btn.active')?.dataset.cat || 'smileys';
      renderEmojiPicker(activeCat, emojiSearch.value.trim());
    };
  }

  // Stickers Search Input
  const stickersSearch = document.getElementById('stickers-search-input');
  if (stickersSearch) {
    stickersSearch.oninput = () => renderStickerStream();
  }

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
      updateHeroPhotoDisplay(state.clientActiveChatId);
    };
  }
  if (btnPhotoNext) {
    btnPhotoNext.onclick = () => {
      if (state.profilePhotos.length <= 1) return;
      state.currentPhotoIndex = (state.currentPhotoIndex + 1) % state.profilePhotos.length;
      updateHeroPhotoDisplay(state.clientActiveChatId);
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
  if (btnSearchToggle) btnSearchToggle.onclick = () => toggleChatSearchBar();
  if (btnSearchClose) btnSearchClose.onclick = () => toggleChatSearchBar(false);
  if (chatSearchInput) {
    chatSearchInput.oninput = () => {
      state.clientSearchQuery = chatSearchInput.value.toLowerCase().trim();
      renderClientMessages();
    };
    chatSearchInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeChatServerSearch(chatSearchInput.value.trim());
      }
    };
  }

  const btnSearchPrev = document.getElementById('btn-chat-search-prev');
  if (btnSearchPrev) btnSearchPrev.onclick = () => navigateSearchMatch('prev');
  const btnSearchNext = document.getElementById('btn-chat-search-next');
  if (btnSearchNext) btnSearchNext.onclick = () => navigateSearchMatch('next');

  // Cancel Replying Banner
  const btnCancelReply = document.getElementById('btn-cancel-reply');
  if (btnCancelReply) btnCancelReply.onclick = () => cancelReplyBanner();

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
      try {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('delete_messages', { instId, chatId, messageIds: ids });
        } else {
          await api(`/api/instances/${instId}/account/delete-messages`, 'POST', { chatId, messageIds: ids });
        }
        showToast(`已删除 ${ids.length} 条消息`, 'success');
        const idSet = new Set(ids);
        state.clientMessages = state.clientMessages.filter((m) => !idSet.has(m.id));
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

  // Voice Recording Buttons
  const btnVoiceRecord = document.getElementById('btn-client-voice-record');
  if (btnVoiceRecord) {
    btnVoiceRecord.onclick = () => startVoiceRecording();
  }
  const btnCancelVoice = document.getElementById('btn-cancel-voice-rec');
  if (btnCancelVoice) btnCancelVoice.onclick = () => stopVoiceRecording(false);
  const btnSendVoice = document.getElementById('btn-send-voice-rec');
  if (btnSendVoice) btnSendVoice.onclick = () => stopVoiceRecording(true);

  // Infinite scroll cursor pagination for client messages
  const msgContainer = document.getElementById('client-messages-container');
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
  const btnAttach = document.getElementById('btn-chat-attach');
  const fileInput = document.getElementById('chat-file-input');
  if (btnAttach && fileInput) {
    btnAttach.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) handleSendAttachment(file);
      fileInput.value = '';
    };
  }

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

  document.getElementById('member-search-input')?.addEventListener('input', () => renderGroupMembers());
  document.getElementById('btn-refresh-members')?.addEventListener('click', () => loadGroupMembers(state.clientActiveChatId));

  const clientSearchInput = document.getElementById('client-dialogs-search');
  if (clientSearchInput) {
    clientSearchInput.oninput = () => renderClientDialogs();
  }

  document.querySelectorAll('.dialog-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.dialog-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.clientDialogFilter = tab.dataset.type;
      renderClientDialogs();
    };
  });

  const btnSendMsg = document.getElementById('btn-client-send-msg');
  if (btnSendMsg) btnSendMsg.onclick = () => sendClientMessage();

  const msgTextarea = document.getElementById('client-message-textarea');
  if (msgTextarea) {
    msgTextarea.onkeydown = (e) => {
      // 1. Chinese IME composition guard
      if (e.isComposing || e.keyCode === 229) {
        return;
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
      if (state.clientActiveChatId) {
        state.clientDrafts = state.clientDrafts || {};
        if (msgTextarea.value.trim()) {
          state.clientDrafts[state.clientActiveChatId] = msgTextarea.value;
        } else {
          delete state.clientDrafts[state.clientActiveChatId];
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
  document.getElementById('btn-close-profile').onclick = () => document.getElementById('modal-profile').classList.remove('active');
  document.getElementById('btn-cancel-profile').onclick = () => document.getElementById('modal-profile').classList.remove('active');
  document.getElementById('btn-save-profile').onclick = () => saveProfileModal();

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
async function initClientView() {
  const select = document.getElementById('client-account-select');
  if (!select) return;
  select.innerHTML = '';

  if (state.instances.length === 0) {
    select.innerHTML = '<option value="">无可用实例</option>';
    document.getElementById('client-account-name').innerText = '暂无实例';
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
    state.clientSelectedInstance = onlineOne ? onlineOne.config.id : state.instances[0].config.id;
  }
  select.value = state.clientSelectedInstance;

  updateClientAccountBadge();
  await loadClientDialogs();
}

function updateClientAccountBadge() {
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

async function loadClientDialogs() {
  const instId = state.clientSelectedInstance;
  if (!instId) return;

  const inst = state.instances.find((i) => i.config.id === instId);
  const container = document.getElementById('client-dialogs-list');
  if (!container) return;

  if (!inst || inst.status !== 'ONLINE') {
    container.innerHTML = '<div class="empty-state">当前账号未在线，请在“实例托管”中先启动该账号。</div>';
    return;
  }

  container.innerHTML = '<div class="empty-state">正在同步 Telegram 会话列表...</div>';

  try {
    let dialogs;
    if (window.chatWs && window.chatWs.isConnected()) {
      try {
        dialogs = await window.chatWs.sendRpc('get_dialogs', { instId });
      } catch (_) {}
    }
    if (!dialogs) {
      dialogs = await api(`/api/instances/${instId}/account/dialogs?limit=80`);
    }
    state.clientDialogs = Array.isArray(dialogs) ? dialogs : [];
    renderClientDialogs();
    populateQuickChatOptions();
  } catch (err) {
    container.innerHTML = `<div class="empty-state error">加载会话失败: ${err.message}</div>`;
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

function renderClientDialogs() {
  const container = document.getElementById('client-dialogs-list');
  if (!container) return;

  // Update total unread badge on tab
  const totalUnread = (state.clientDialogs || []).reduce((sum, d) => sum + (Number(d.unreadCount) || 0), 0);
  const totalBadgeEl = document.getElementById('badge-unread-total');
  if (totalBadgeEl) {
    if (totalUnread > 0) {
      totalBadgeEl.innerText = totalUnread > 99 ? '99+' : totalUnread;
      totalBadgeEl.style.display = 'inline-block';
    } else {
      totalBadgeEl.style.display = 'none';
    }
  }

  const search = (document.getElementById('client-dialogs-search')?.value || '').toLowerCase().trim();
  const filterType = state.clientDialogFilter || 'all';

  let list = state.clientDialogs || [];
  if (filterType !== 'all') {
    list = list.filter((d) => {
      if (filterType === 'unread') return (Number(d.unreadCount) || 0) > 0;
      if (filterType === 'private') return d.type === 'private';
      if (filterType === 'group') return d.type === 'group' || d.type === 'supergroup';
      if (filterType === 'channel') return d.type === 'channel';
      if (filterType === 'bot') return d.type === 'bot' || (d.username && d.username.toLowerCase().endsWith('bot'));
      return true;
    });
  }

  if (search) {
    list = list.filter((d) =>
      (d.title && d.title.toLowerCase().includes(search)) ||
      (d.username && d.username.toLowerCase().includes(search)) ||
      String(d.id).includes(search)
    );
  }

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">未找到匹配的会话</div>';
    return;
  }

  const instId = state.clientSelectedInstance;
  container.innerHTML = '';
  for (const d of list) {
    const item = document.createElement('div');
    item.className = `dialog-item ${state.clientActiveChatId === d.id ? 'active' : ''}`;

    const isMuted = Boolean(state.clientMutedChats && state.clientMutedChats[d.id]);
    const initials = (d.title || d.username || 'TG').slice(0, 2);
    const timeStr = d.lastMessageDate ? formatDialogTime(d.lastMessageDate) : '';
    const badgeClass = isMuted ? 'dialog-badge muted' : 'dialog-badge';
    const unreadHtml = d.unreadCount > 0 ? `<span class="${badgeClass}">${d.unreadCount}</span>` : '';
    const muteIconHtml = isMuted ? '<svg class="dialog-mute-icon" title="已静音"><use href="#icon-volume-off"/></svg>' : '';
    const typeIcon = d.type === 'channel'
      ? '<svg class="ui-icon-xs" style="vertical-align:-1px;margin-right:3px;color:var(--text-muted);"><use href="#icon-broadcast"/></svg>'
      : d.type === 'bot'
      ? '<svg class="ui-icon-xs" style="vertical-align:-1px;margin-right:3px;color:var(--text-muted);"><use href="#icon-terminal"/></svg>'
      : '';
    const avatarUrl = `/api/instances/${instId}/account/avatar?chatId=${d.id}`;

    const hasDraft = Boolean(state.clientDrafts && state.clientDrafts[d.id] && state.clientDrafts[d.id].trim());
    const draftBadgeHtml = hasDraft ? '<span class="dialog-draft-tag">草稿</span>' : '';
    let snippetText = '';
    let snippetClass = 'dialog-snippet';
    if (d._typing) {
      snippetText = '<span style="color:var(--tg-typing-color);">正在输入<span class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span></span>';
      snippetClass += ' typing-snippet';
    } else if (hasDraft) {
      snippetText = escapeHtml(state.clientDrafts[d.id].replace(/\n/g, ' '));
      snippetClass += ' draft-snippet';
    } else if (d.lastMessage) {
      const senderPrefix = d.lastSender && (d.type === 'group' || d.type === 'supergroup') ? `${escapeHtml(d.lastSender)}: ` : '';
      snippetText = `${senderPrefix}${escapeHtml(d.lastMessage)}`;
    } else {
      snippetText = d.username ? '@' + escapeHtml(d.username) : 'ID: ' + d.id;
    }

    item.innerHTML = `
      <div class="dialog-avatar-wrap" style="width: 48px; height: 48px; min-width: 48px; min-height: 48px; max-width: 48px; max-height: 48px; border-radius: 50%; position: relative; overflow: visible; flex-shrink: 0; background: var(--bg-subtle);">
        <img class="dialog-avatar-img" src="${avatarUrl}" alt="" loading="lazy" style="width: 48px; height: 48px; max-width: 48px; max-height: 48px; border-radius: 50%; object-fit: cover; position: absolute; top: 0; left: 0;"
             onload="this.classList.add('loaded'); if(this.nextElementSibling) this.nextElementSibling.style.display='none';"
             onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
        <div class="dialog-avatar-initials" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 14px; color: var(--color-primary); text-transform: uppercase;">${escapeHtml(initials)}</div>
        ${d.online ? '<span class="dialog-online-dot" title="在线"></span>' : ''}
      </div>
      <div class="dialog-info">
        <div class="dialog-title-row">
          <span class="dialog-title">${typeIcon}${escapeHtml(d.title || d.username || String(d.id))}</span>
          <span class="dialog-time" style="display:flex;align-items:center;gap:4px;">${d.pinned ? '<svg class="dialog-pinned-icon" title="已置顶"><use href="#icon-pin"/></svg>' : ''}${muteIconHtml}${timeStr}</span>
        </div>
        <div class="dialog-snippet-row">
          ${draftBadgeHtml}
          <span class="${snippetClass}">${snippetText}</span>
          ${unreadHtml}
        </div>
      </div>
    `;

    item.onclick = () => selectClientChat(d);
    container.appendChild(item);
  }
}

async function selectClientChat(dialog) {
  const prevChatId = state.clientActiveChatId;
  const textarea = document.getElementById('client-message-textarea');
  if (prevChatId && textarea) {
    state.clientDrafts = state.clientDrafts || {};
    if (textarea.value && textarea.value.trim()) {
      state.clientDrafts[prevChatId] = textarea.value;
    } else {
      delete state.clientDrafts[prevChatId];
    }
  }

  state.clientActiveChatId = dialog.id;
  state.clientReplyingTo = null;
  state.clientSearchQuery = '';
  cancelReplyBanner();
  clearStagedAttachment();
  if (currentPreviewVideo) {
    pausePreviewVideo(currentPreviewVideo);
  }

  if (textarea) {
    textarea.value = (state.clientDrafts && state.clientDrafts[dialog.id]) || '';
    autoResizeTextarea(textarea);
  }

  // Clear unread badge locally & report to Telegram cloud
  const instId = state.clientSelectedInstance;
  if (dialog.unreadCount > 0) {
    dialog.unreadCount = 0;
    renderClientDialogs();
    if (window.chatWs && window.chatWs.isConnected()) {
      window.chatWs.sendRpc('mark_as_read', { instId, chatId: dialog.id }).catch(() => {});
    } else {
      api(`/api/instances/${instId}/account/read`, 'POST', { chatId: dialog.id }).catch(() => {});
    }
  }

  document.querySelector('.client-layout')?.classList.add('in-chat');
  renderClientDialogs();

  const initials = (dialog.title || dialog.username || 'TG').slice(0, 2);
  const headerAvatarImg = document.getElementById('client-chat-avatar-img');
  const headerAvatarTxt = document.getElementById('client-chat-avatar');

  if (headerAvatarImg && headerAvatarTxt) {
    const avatarUrl = `/api/instances/${instId}/account/avatar?chatId=${dialog.id}`;
    scheduler.loadImage(headerAvatarImg, avatarUrl).then((ok) => {
      if (ok) {
        headerAvatarImg.style.opacity = '1';
        headerAvatarTxt.style.display = 'none';
      } else {
        headerAvatarImg.style.opacity = '0';
        headerAvatarTxt.style.display = 'flex';
        headerAvatarTxt.innerText = initials;
      }
    });
    headerAvatarTxt.innerText = initials;
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
  document.getElementById('client-chat-subtitle').innerText = `${typeMap[dialog.type] || dialog.type} | ID: ${dialog.id}${userTag}`;
  document.getElementById('client-chat-actions').style.display = 'flex';
  updateChatMuteButtonState(dialog.id);

  // If Expression Drawer is NOT open, automatically open profile drawer and load details
  const exprDrawer = document.getElementById('client-expression-drawer');
  const exprOpen = exprDrawer && exprDrawer.style.display !== 'none' && exprDrawer.classList.contains('open');
  const profileDrawer = document.getElementById('client-drawer');
  if (!exprOpen) {
    if (profileDrawer) {
      profileDrawer.style.display = 'flex';
      profileDrawer.classList.add('open');
      loadPeerProfile(dialog.id);
    }
  } else if (profileDrawer && profileDrawer.classList.contains('open')) {
    loadPeerProfile(dialog.id);
  }

  await loadClientMessages(dialog.id);
}

let isLoadingEarlierMessages = false;
let hasReachedEarliestMessage = false;

async function loadClientMessages(chatId, isSilentRefresh = false) {
  const container = document.getElementById('client-messages-container');
  if (!container) return;
  hasReachedEarliestMessage = false;

  if (!isSilentRefresh) {
    container.innerHTML = '<div class="chat-placeholder"><p>正在获取历史消息...</p></div>';
  }

  try {
    const instId = state.clientSelectedInstance;
    let msgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      try {
        msgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 60 });
      } catch (_) {}
    }
    if (!msgs) {
      msgs = await api(`/api/instances/${instId}/account/messages?chatId=${chatId}&limit=60`);
    }
    state.clientMessages = Array.isArray(msgs) ? msgs.reverse() : [];
    renderClientMessages(isSilentRefresh);
  } catch (err) {
    if (!isSilentRefresh) {
      container.innerHTML = `<div class="chat-placeholder"><p style="color:var(--color-danger)">获取消息失败: ${err.message}</p></div>`;
    }
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
        earlierMsgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 40, offsetId: oldestMsg.id });
      } catch (_) {}
    }
    if (!earlierMsgs) {
      earlierMsgs = await api(`/api/instances/${instId}/account/messages?chatId=${chatId}&limit=40&offsetId=${oldestMsg.id}`);
    }

    if (!Array.isArray(earlierMsgs) || earlierMsgs.length === 0) {
      hasReachedEarliestMessage = true;
      if (topLoader) topLoader.remove();
      return;
    }

    const reversed = earlierMsgs.reverse();
    const existingIds = new Set(state.clientMessages.map((m) => m.id));
    const newEarlier = reversed.filter((m) => !existingIds.has(m.id));

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
    showToast(`加载历史失败: ${err.message}`, 'error');
  } finally {
    isLoadingEarlierMessages = false;
    if (topLoader) topLoader.style.display = 'none';
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

function renderClientMessages(preserveScroll = false) {
  const container = document.getElementById('client-messages-container');
  if (!container) return;
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
      wrap.className = 'msg-service-wrap';
      wrap.id = `chat-msg-${m.id}`;
      wrap.dataset.msgId = m.id;
      wrap.innerHTML = `<div class="msg-service">${escapeHtml(m.service.text || m.text || '系统消息')}</div>`;
      container.appendChild(wrap);
      continue;
    }
    wrap.className = `chat-bubble-wrap ${isOut ? 'outgoing' : 'incoming'} ${isSelected ? 'selected' : ''} ${meta.isFirstInGroup ? 'group-start' : 'group-mid'} ${meta.isLastInGroup ? 'group-end' : ''}`;
    wrap.id = `chat-msg-${m.id}`;
    wrap.dataset.msgId = m.id;
    wrap.dataset.isOut = isOut ? '1' : '0';
    wrap.dataset.msgText = m.text || '';
    wrap.dataset.isPinned = m.pinned ? '1' : '0';

    wrap.onclick = (e) => {
      if (state.isSelectionMode) {
        e.stopPropagation();
        toggleSelectMessage(m.id);
      }
    };

    const senderId = m.from?.id;
    const senderName = isOut ? '我' : m.from?.firstName || m.from?.username || `UID:${m.from?.id || '?'}`;
    const initials = (m.from?.firstName || m.from?.username || 'TG').slice(0, 2);
    const senderColor = senderId ? getSenderNameColor(senderId) : '#93c5fa';
    const avatarBg = senderId ? getSenderAvatarColor(senderId) : 'var(--color-primary)';
    const avatarUrl = senderId ? `/api/instances/${instId}/account/avatar?chatId=${senderId}` : '';
    const timeStr = m.date
      ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

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
        <div class="msg-reply-quote" onclick="scrollToMessage(${m.replyToMessageId})">
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
      if (media.type === 'photo') {
        const thumbUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
        const fullUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        mediaHtml = `
          <div class="msg-media-wrap photo">
            <img class="msg-media-photo" src="${thumbUrl}" alt="Photo" loading="lazy" onclick="openLightbox('${fullUrl}', '${escapeHtml(senderName)}')">
          </div>
        `;
      } else if (media.type === 'video') {
        const videoUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const thumbUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
        const durStr = media.duration ? formatDurationSec(media.duration) : '';
        const titleStr = escapeHtml(senderName + ' · 视频');
        mediaHtml = `
          <div class="custom-video-card" onmouseenter="handleVideoPreviewEnter(this)" onmouseleave="handleVideoPreviewLeave(this)" onclick="openCinemaVideo('${videoUrl}', '${titleStr}', '${timeStr}', '${durStr}')" title="点击在影院播放器中播放">
            <video preload="metadata" playsinline muted loop poster="${thumbUrl}" src="${videoUrl}"></video>
            <div class="video-card-play-badge">
              <svg class="ui-icon" style="transform: translateX(1px);"><use href="#icon-play"/></svg>
            </div>
            ${durStr ? `<div class="video-card-dur-badge">${durStr}</div>` : ''}
            <div class="video-card-expand-btn" title="影院全屏模式">
              <svg class="ui-icon-xs"><use href="#icon-fullscreen"/></svg>
            </div>
          </div>
        `;
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
              <button class="btn btn-primary btn-xs" onclick="playTrackDirect('${escapeHtml(trackTitle)}', '${escapeHtml(trackArtist)}', '${audioUrl}', ${m.id})">播放</button>
              <button class="btn btn-secondary btn-xs" onclick="addTrackToPlaylist('${escapeHtml(trackTitle)}', '${escapeHtml(trackArtist)}', '${audioUrl}', ${m.id})">加歌单</button>
            </div>
          </div>
        `;
      } else if (media.type === 'voice') {
        const voiceUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}`;
        const voiceDur = media.duration ? formatDurationSec(media.duration) : '语音';
        const waveformBars = generateWaveformBarsHtml(m.id, m.id, media.waveform);
        mediaHtml = `
          <div class="msg-voice-card" id="voice-card-${m.id}">
            <button class="voice-play-btn" onclick="toggleVoicePlay(this, '${voiceUrl}', ${m.id})" title="播放语音">
              <svg class="ui-icon-sm"><use href="#icon-play"/></svg>
            </button>
            <div class="voice-waveform-wrap">
              ${waveformBars}
              <div class="voice-time-label" id="voice-time-${m.id}">${voiceDur}</div>
            </div>
            <button class="voice-speed-btn" onclick="toggleVoiceSpeed(this, ${m.id})" title="切换播放倍速">1.0x</button>
          </div>
        `;
      } else if (media.type === 'poll') {
        mediaHtml = renderPollCardHtml(media, m.id, chatId);
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
            <a class="btn btn-secondary btn-xs doc-download-btn" href="${docUrl}" download="${escapeHtml(fileName)}" target="_blank" title="下载原文件">
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
              <video class="msg-media-sticker video-sticker" src="${videoUrl}" autoplay loop muted playsinline disablePictureInPicture></video>
            </div>
          `;
        } else {
          const stickerUrl = `/api/instances/${instId}/account/media?chatId=${chatId}&messageId=${m.id}&thumb=1`;
          mediaHtml = `
            <div class="msg-media-wrap sticker sticker-bubble" data-set-id="${escapeHtml(setId)}" data-access-hash="${escapeHtml(accessHash)}" data-short-name="${escapeHtml(shortName)}" title="点击查看与安装此贴纸包">
              <img class="msg-media-sticker" src="${stickerUrl}" alt="Sticker" loading="lazy">
            </div>
          `;
        }
      }
    }

    // Text content
    let textHtml = '';
    if (m.text) {
      textHtml = `<div class="chat-bubble-text">${formatMessageContent(m.text, m.entities)}</div>`;
    }

    // Status tick for outgoing (Telegram-style: ✓ sent, ✓✓ read)
    let statusTickHtml = '';
    if (isOut) {
      if (m.status === 'pending') {
        statusTickHtml = `<span class="msg-status-tick pending" title="正在发送...">⏱</span>`;
      } else if (m.status === 'failed') {
        statusTickHtml = `<span class="msg-status-tick failed" title="发送失败">✕</span>`;
      } else if (m.read) {
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
        return `<span class="reaction-badge ${chosenClass}" onclick="quickToggleReaction('${m.id}', '${escapeHtml(r.emoticon)}')"><span class="reaction-emoji">${escapeHtml(r.emoticon)}</span><span class="reaction-count">${r.count}</span></span>`;
      }).join('');
      reactionsHtml = `<div class="msg-reactions-wrap">${badges}</div>`;
    }

    // Channel comments button
    let commentsHtml = '';
    if (m.replies && m.replies > 0) {
      commentsHtml = `
        <div class="msg-comments-btn" onclick="event.stopPropagation(); showComments(${m.id}, ${chatId})">
          <svg class="ui-icon-xs" style="width:12px;height:12px;"><use href="#icon-chat"/></svg>
          <span>${m.replies} 条评论</span>
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
    if (!isOut && meta.isFirstInGroup) {
      senderHeaderHtml = `<div class="chat-bubble-sender" style="color: ${senderColor}; cursor: pointer;" onclick="event.stopPropagation(); loadPeerProfile(${senderId})">${escapeHtml(senderName)}</div>`;
    }

    wrap.innerHTML = `
      <div class="msg-select-checkbox">
        <svg class="ui-icon-xs"><use href="#icon-check"/></svg>
      </div>
      <div class="quick-reaction-hover-pill">
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction('${m.id}', '👍')">👍</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction('${m.id}', '❤️')">❤️</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction('${m.id}', '🔥')">🔥</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction('${m.id}', '🎉')">🎉</button>
        <button type="button" class="quick-react-btn" onclick="event.stopPropagation(); quickToggleReaction('${m.id}', '😂')">😂</button>
      </div>
      <div class="msg-row-inner">
        ${!isOut && senderId && meta.isLastInGroup ? `
          <div class="msg-sender-avatar-wrap" onclick="event.stopPropagation(); loadPeerProfile(${senderId})" title="${escapeHtml(senderName)} (点击查看资料)">
            <img class="msg-sender-avatar-img" src="${avatarUrl}" alt="" loading="lazy"
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

    container.appendChild(wrap);
  }

  if (!q && !preserveScroll) {
    container.scrollTop = container.scrollHeight;
  }
  setupVideoIntersectionAutoplay();
}

async function quickToggleReaction(msgId, reaction) {
  if (!msgId || !reaction) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('send_reaction', { instId, chatId, messageId: Number(msgId), reaction });
    } else {
      await api(`/api/instances/${instId}/account/reaction`, 'POST', { chatId, messageId: Number(msgId), reaction });
    }
    const m = state.clientMessages.find((x) => String(x.id) === String(msgId));
    if (m) {
      if (!m.reactions) m.reactions = [];
      const existing = m.reactions.find((r) => r.emoticon === reaction);
      if (existing) {
        if (existing.chosen) {
          existing.chosen = false;
          existing.count = Math.max(0, existing.count - 1);
        } else {
          existing.chosen = true;
          existing.count += 1;
        }
      } else {
        m.reactions.push({ emoticon: reaction, count: 1, chosen: true });
      }
      renderClientMessages(true);
    }
  } catch (err) {
    showToast(`回应失败: ${err.message}`, 'error');
  }
}

async function sendClientMessage(scheduledTimestamp = null) {
  const textInput = document.getElementById('client-message-textarea');
  const text = textInput ? textInput.value.trim() : '';
  if (!text && !state.clientStagedFile) return;
  if (!state.clientActiveChatId) {
    return showToast('请先在左侧选择一个会话', 'warn');
  }

  const instId = state.clientSelectedInstance;
  const parseMode = state.clientParseMode || document.getElementById('client-input-parsemode')?.value || 'markdown';
  const silent = Boolean(state.clientSilent);
  const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;

  // Handle staged attachment file
  if (state.clientStagedFile) {
    const file = state.clientStagedFile;
    let mediaType = 'document';
    if (file.type.startsWith('image/')) mediaType = 'photo';
    else if (file.type.startsWith('video/')) mediaType = 'video';
    else if (file.type.startsWith('audio/')) mediaType = 'audio';

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = reader.result.split(',')[1];
        await api(`/api/instances/${instId}/account/send-media`, 'POST', {
          chatId: state.clientActiveChatId,
          mediaType,
          fileBase64: b64,
          fileName: file.name,
          caption: text || undefined,
          replyTo,
          schedule: scheduledTimestamp || undefined,
        });

        clearStagedAttachment();
        if (textInput) {
          textInput.value = '';
          autoResizeTextarea(textInput);
        }
        if (state.clientDrafts && state.clientActiveChatId) {
          delete state.clientDrafts[state.clientActiveChatId];
          renderClientDialogs();
        }
        cancelReplyBanner();
        if (scheduledTimestamp) {
          showToast(`附件定时已设定 (${new Date(scheduledTimestamp * 1000).toLocaleTimeString()})`, 'success');
        } else {
          showToast('附件已成功发送', 'success');
        }
        await loadClientMessages(state.clientActiveChatId, true);
      } catch (err) {
        showToast(`发送附件失败: ${err.message}`, 'error');
      }
    };
    reader.readAsDataURL(file);
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
          chatId: state.clientActiveChatId,
          messageId: editMsgId,
          text,
          options: {
            parseMode: parseMode === 'plain' ? undefined : parseMode,
          },
        });
      } else {
        await api(`/api/instances/${instId}/account/edit`, 'POST', {
          chatId: state.clientActiveChatId,
          messageId: editMsgId,
          text,
          options: {
            parseMode: parseMode === 'plain' ? undefined : parseMode,
          },
        });
      }

      if (textInput) {
        textInput.value = '';
        autoResizeTextarea(textInput);
      }
      showToast('消息已成功修改', 'success');
      await loadClientMessages(state.clientActiveChatId, true);
      return;
    } catch (err) {
      showToast(`编辑消息失败: ${err.message}`, 'error');
      return;
    }
  }

  // Optimistic UI bubble
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
  state.clientMessages.push(optimisticMsg);
  renderClientMessages(false);

  if (textInput) {
    textInput.value = '';
    autoResizeTextarea(textInput);
  }
  if (state.clientDrafts && state.clientActiveChatId) {
    delete state.clientDrafts[state.clientActiveChatId];
    renderClientDialogs();
  }
  cancelReplyBanner();

  try {
    let sentRes;
    if (window.chatWs && window.chatWs.isConnected()) {
      sentRes = await window.chatWs.sendRpc('send_message', {
        instId,
        chatId: state.clientActiveChatId,
        text,
        options: {
          parseMode: parseMode === 'plain' ? undefined : parseMode,
          silent,
          replyTo,
          schedule: scheduledTimestamp || undefined,
        },
      });
    } else {
      sentRes = await api(`/api/instances/${instId}/account/send`, 'POST', {
        chatId: state.clientActiveChatId,
        text,
        options: {
          parseMode: parseMode === 'plain' ? undefined : parseMode,
          silent,
          replyTo,
          schedule: scheduledTimestamp || undefined,
        },
      });
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
    loadClientMessages(state.clientActiveChatId, true);
    if (scheduledTimestamp) {
      showToast(`已成功设定定时消息 (${new Date(scheduledTimestamp * 1000).toLocaleString()})`, 'success');
    }
  } catch (err) {
    const local = state.clientMessages.find((m) => m.id === tempId);
    if (local) {
      local.status = 'failed';
      renderClientMessages(true);
    }
    showToast(`发送失败: ${err.message}`, 'error');
  }
}

function setReplyingMessage(msgId) {
  const m = state.clientMessages.find((x) => x.id === msgId);
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
}

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

// Channel post comments
window.showComments = (msgId, chatId) => {
  showToast('评论区功能开发中，敬请期待', 'info');
};

// Spoiler reveal on click (delegated)
document.addEventListener('click', (e) => {
  const spoiler = e.target.closest('.tg-spoiler.hidden');
  if (spoiler) {
    e.stopPropagation();
    spoiler.classList.remove('hidden');
    spoiler.classList.add('revealed');
  }
});

function toggleChatSearchBar(forceOpen) {
  const bar = document.getElementById('chat-search-bar');
  if (!bar) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : bar.style.display === 'none' || !bar.style.display;
  if (shouldOpen) {
    bar.style.display = 'flex';
    document.getElementById('chat-search-input')?.focus();
  } else {
    bar.style.display = 'none';
    state.clientSearchQuery = '';
    state.searchMatchIds = [];
    state.searchMatchIdx = -1;
    const input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    const statsEl = document.getElementById('chat-search-stats');
    if (statsEl) statsEl.style.display = 'none';
    const prevBtn = document.getElementById('btn-chat-search-prev');
    if (prevBtn) prevBtn.style.display = 'none';
    const nextBtn = document.getElementById('btn-chat-search-next');
    if (nextBtn) nextBtn.style.display = 'none';
    renderClientMessages();
  }
}

async function executeChatServerSearch(query) {
  if (!query || !state.clientActiveChatId) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  const statsEl = document.getElementById('chat-search-stats');
  const prevBtn = document.getElementById('btn-chat-search-prev');
  const nextBtn = document.getElementById('btn-chat-search-next');

  try {
    let msgs;
    if (window.chatWs && window.chatWs.isConnected()) {
      msgs = await window.chatWs.sendRpc('get_messages', { instId, chatId, limit: 60, search: query });
    } else {
      msgs = await api(`/api/instances/${instId}/account/messages?chatId=${chatId}&limit=60&search=${encodeURIComponent(query)}`);
    }

    if (!Array.isArray(msgs) || msgs.length === 0) {
      if (statsEl) {
        statsEl.innerText = '0 / 0';
        statsEl.style.display = 'inline';
      }
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      showToast('未在当前会话记录中检索到匹配消息', 'info');
      return;
    }

    const existingMap = new Map(state.clientMessages.map((m) => [m.id, m]));
    msgs.forEach((m) => {
      if (!existingMap.has(m.id)) {
        state.clientMessages.push(m);
      }
    });
    state.clientMessages.sort((a, b) => (a.id || 0) - (b.id || 0));

    state.searchMatchIds = msgs.map((m) => m.id);
    state.searchMatchIdx = state.searchMatchIds.length - 1;

    if (statsEl) {
      statsEl.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}`;
      statsEl.style.display = 'inline';
    }
    if (prevBtn) prevBtn.style.display = 'inline-flex';
    if (nextBtn) nextBtn.style.display = 'inline-flex';

    renderClientMessages(true);
    scrollToMessage(state.searchMatchIds[state.searchMatchIdx]);
  } catch (err) {
    showToast(`搜索失败: ${err.message}`, 'error');
  }
}

function navigateSearchMatch(direction) {
  if (!state.searchMatchIds || state.searchMatchIds.length === 0) return;
  if (direction === 'prev') {
    state.searchMatchIdx = (state.searchMatchIdx - 1 + state.searchMatchIds.length) % state.searchMatchIds.length;
  } else {
    state.searchMatchIdx = (state.searchMatchIdx + 1) % state.searchMatchIds.length;
  }
  const statsEl = document.getElementById('chat-search-stats');
  if (statsEl) {
    statsEl.innerText = `${state.searchMatchIdx + 1} / ${state.searchMatchIds.length}`;
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
function openForwardModal(msgIds) {
  if (!msgIds || msgIds.length === 0) return;
  state.pendingForwardMsgIds = msgIds.map(Number);

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
        <div class="forward-dialog-sub">${typeLabel} ${d.username ? '@' + escapeHtml(d.username) : 'ID: ' + d.id}</div>
      </div>
    `;

    item.onclick = async () => {
      await executeForwardTo(d);
    };
    listContainer.appendChild(item);
  }
}

async function executeForwardTo(targetDialog) {
  const msgIds = state.pendingForwardMsgIds;
  if (!msgIds || msgIds.length === 0) return;
  const fromChatId = state.clientActiveChatId;
  const toChatId = targetDialog.id;
  const instId = state.clientSelectedInstance;

  closeForwardModal();
  showToast(`正在转发 ${msgIds.length} 条消息至 "${targetDialog.title || targetDialog.username}"...`, 'info');

  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('forward_messages', { instId, fromChatId, toChatId, messageIds: msgIds });
    } else {
      await api(`/api/instances/${instId}/account/forward`, 'POST', { fromChatId, toChatId, messageIds: msgIds });
    }
    showToast(`成功转发至 "${targetDialog.title || targetDialog.username}"`, 'success');
    exitSelectionMode();
  } catch (err) {
    showToast(`转发失败: ${err.message}`, 'error');
  }
}

// Voice Recorder Controller
let mediaRecorderInstance = null;
let recordedAudioChunks = [];
let voiceRecStartTime = 0;
let voiceRecTimerInterval = null;
let voiceRecStream = null;

async function startVoiceRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showToast('当前浏览器环境不支持麦克风音频采集', 'error');
  }

  try {
    voiceRecStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return showToast(`获取麦克风失败: ${err.message}`, 'error');
  }

  recordedAudioChunks = [];
  let options = {};
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options = { mimeType: 'audio/webm;codecs=opus' };
    } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      options = { mimeType: 'audio/ogg;codecs=opus' };
    }
  }

  try {
    mediaRecorderInstance = new MediaRecorder(voiceRecStream, options);
  } catch (err) {
    mediaRecorderInstance = new MediaRecorder(voiceRecStream);
  }

  mediaRecorderInstance.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedAudioChunks.push(e.data);
    }
  };

  mediaRecorderInstance.start(200);
  voiceRecStartTime = Date.now();

  const bar = document.getElementById('chat-voice-recording-bar');
  if (bar) bar.style.display = 'flex';

  const timerEl = document.getElementById('voice-rec-timer');
  if (timerEl) timerEl.innerText = '00:00';

  if (voiceRecTimerInterval) clearInterval(voiceRecTimerInterval);
  voiceRecTimerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - voiceRecStartTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    if (timerEl) timerEl.innerText = `${m}:${s}`;
    if (sec >= 120) {
      stopVoiceRecording(true);
    }
  }, 1000);
}

async function stopVoiceRecording(send = false) {
  if (voiceRecTimerInterval) {
    clearInterval(voiceRecTimerInterval);
    voiceRecTimerInterval = null;
  }

  const bar = document.getElementById('chat-voice-recording-bar');
  if (bar) bar.style.display = 'none';

  if (!mediaRecorderInstance) return;

  const recorder = mediaRecorderInstance;
  mediaRecorderInstance = null;

  return new Promise((resolve) => {
    recorder.onstop = async () => {
      if (voiceRecStream) {
        voiceRecStream.getTracks().forEach((t) => t.stop());
        voiceRecStream = null;
      }

      if (!send || recordedAudioChunks.length === 0) {
        recordedAudioChunks = [];
        return resolve();
      }

      const mime = recorder.mimeType || 'audio/ogg';
      const audioBlob = new Blob(recordedAudioChunks, { type: mime });
      recordedAudioChunks = [];

      const reader = new FileReader();
      reader.onload = async () => {
        const b64 = reader.result.split(',')[1];
        const instId = state.clientSelectedInstance;
        const chatId = state.clientActiveChatId;

        const tempId = 'temp_voice_' + Date.now();
        const optimisticMsg = {
          id: tempId,
          outgoing: true,
          status: 'pending',
          media: { type: 'voice', duration: Math.max(1, Math.floor((Date.now() - voiceRecStartTime) / 1000)) },
          date: Date.now(),
          from: { firstName: '我' },
        };
        state.clientMessages.push(optimisticMsg);
        renderClientMessages(false);

        try {
          await api(`/api/instances/${instId}/account/send-media`, 'POST', {
            chatId,
            mediaType: 'voice',
            fileBase64: b64,
            fileName: 'voice.ogg',
          });
          showToast('语音消息已发送', 'success');
          await loadClientMessages(chatId, true);
        } catch (err) {
          const local = state.clientMessages.find((m) => m.id === tempId);
          if (local) {
            local.status = 'failed';
            renderClientMessages(true);
          }
          showToast(`发送语音失败: ${err.message}`, 'error');
        }
        resolve();
      };
      reader.readAsDataURL(audioBlob);
    };

    if (recorder.state !== 'inactive') {
      recorder.stop();
    } else {
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
  return `<div class="voice-waveform-bars" id="voice-bars-${msgId}" onclick="seekVoiceWaveform(event, ${msgId})">${bars}</div>`;
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

async function handleSendAttachment(file) {
  if (!file) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  if (!chatId) return showToast('请先选择一个会话', 'warn');

  if (file.size > 50 * 1024 * 1024) {
    return showToast('文件过大，当前限制最大 50MB', 'error');
  }

  showToast(`正在读取文件 "${file.name}"...`, 'info');

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = reader.result;
      const base64Data = dataUrl.split(',')[1];
      let mediaType = 'document';
      if (file.type.startsWith('image/')) mediaType = 'photo';
      else if (file.type.startsWith('video/')) mediaType = 'video';
      else if (file.type.startsWith('audio/')) mediaType = 'audio';

      const textInput = document.getElementById('client-message-textarea');
      const caption = textInput?.value?.trim() || undefined;
      const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;

      await api(`/api/instances/${instId}/account/send-media`, 'POST', {
        chatId,
        mediaType,
        fileBase64: base64Data,
        fileName: file.name,
        caption,
        replyTo,
      });

      if (textInput) textInput.value = '';
      cancelReplyBanner();
      showToast('媒体文件已成功发送', 'success');
      await loadClientMessages(chatId);
    } catch (err) {
      showToast(`发送失败: ${err.message}`, 'error');
    }
  };
  reader.onerror = () => {
    showToast('读取文件失败', 'error');
  };
  reader.readAsDataURL(file);
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
async function loadPeerProfile(chatId) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId) return;

  const drawer = document.getElementById('client-drawer');
  if (drawer) {
    drawer.style.display = 'flex';
    drawer.classList.add('open');
  }

  state.currentProfileChatId = chatId;

  const displayNameEl = document.getElementById('profile-display-name');
  const usernameEl = document.getElementById('profile-username');
  const statusEl = document.getElementById('profile-status-badge');
  const bioEl = document.getElementById('profile-val-bio');
  const idEl = document.getElementById('profile-val-id');
  const phoneItem = document.getElementById('profile-item-phone');
  const phoneEl = document.getElementById('profile-val-phone');
  const membersItem = document.getElementById('profile-item-members');
  const membersEl = document.getElementById('profile-val-members');
  const heroPlaceholder = document.getElementById('profile-hero-placeholder');

  const activeChat = state.clientDialogs.find((d) => d.id === chatId);
  const initials = (activeChat?.title || activeChat?.username || 'TG').slice(0, 2);
  if (heroPlaceholder) heroPlaceholder.innerText = initials;

  if (displayNameEl) displayNameEl.innerText = activeChat?.title || activeChat?.username || `Chat #${chatId}`;
  if (usernameEl) usernameEl.innerText = activeChat?.username ? `@${activeChat.username}` : '@未设置用户名';
  if (idEl) idEl.innerText = String(chatId);

  try {
    const p = await api(`/api/instances/${instId}/account/peer-profile?chatId=${chatId}`);
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

    if (p.participantsCount && membersItem && membersEl) {
      membersItem.style.display = 'flex';
      membersEl.innerText = `${p.participantsCount.toLocaleString()} 位成员`;
    } else if (membersItem) {
      membersItem.style.display = 'none';
    }

    const tabMembersBtn = document.getElementById('tab-btn-members');
    const isGroupOrChannel = Boolean(p.isGroup || p.isChannel || activeChat?.type === 'group' || activeChat?.type === 'channel');
    if (tabMembersBtn) {
      if (isGroupOrChannel) {
        tabMembersBtn.style.display = 'inline-flex';
        tabMembersBtn.innerText = `成员 (${p.participantsCount || 0})`;
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
      if (p.isChannel) statusEl.innerText = '广播频道';
      else if (p.isGroup) statusEl.innerText = '群组';
      else statusEl.innerText = p.status || '私聊联系人';
    }

    const pinnedBar = document.getElementById('chat-pinned-bar');
    const pinnedText = document.getElementById('chat-pinned-text');
    if (pinnedBar && pinnedText) {
      if (p.pinnedMsgId) {
        pinnedText.innerText = `置顶消息 #${p.pinnedMsgId} (点击定位)`;
        pinnedBar.style.display = 'flex';
        pinnedBar.onclick = (e) => {
          if (e.target.closest('#btn-pinned-close')) {
            pinnedBar.style.display = 'none';
            return;
          }
          scrollToMessage(p.pinnedMsgId);
        };
      } else {
        pinnedBar.style.display = 'none';
      }
    }
  } catch (err) {
    if (bioEl) bioEl.innerText = '无法获取详细资料';
  }

  loadUserPhotos(chatId);
  loadPeerStories(chatId);
  loadSharedMedia(state.sharedMediaTab || 'photos');
}

async function loadUserPhotos(chatId) {
  const instId = state.clientSelectedInstance;
  const heroImg = document.getElementById('profile-hero-img');
  const heroPlaceholder = document.getElementById('profile-hero-placeholder');
  const counterBadge = document.getElementById('profile-photo-counter');
  const prevBtn = document.getElementById('btn-profile-photo-prev');
  const nextBtn = document.getElementById('btn-profile-photo-next');

  state.profilePhotos = [];
  state.currentPhotoIndex = 0;

  try {
    const photos = await api(`/api/instances/${instId}/account/user-photos?userId=${chatId}&limit=20`);
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
          heroImg.style.display = 'block';
          heroPlaceholder.style.display = 'none';
        };
        heroImg.onerror = () => {
          heroImg.style.display = 'none';
          heroPlaceholder.style.display = 'flex';
        };
      }
    }
  } catch (err) {
    if (counterBadge) counterBadge.style.display = 'none';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    if (heroImg && heroPlaceholder) {
      heroImg.src = `/api/instances/${instId}/account/avatar?chatId=${chatId}&isBig=1`;
      heroImg.onload = () => {
        heroImg.style.display = 'block';
        heroPlaceholder.style.display = 'none';
      };
      heroImg.onerror = () => {
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

  if (state.profilePhotos.length === 0) return;
  const idx = state.currentPhotoIndex;
  if (counterBadge) {
    counterBadge.innerText = `${idx + 1} / ${state.profilePhotos.length}`;
  }

  if (heroImg && heroPlaceholder) {
    heroImg.src = `/api/instances/${instId}/account/user-photo-file?userId=${chatId}&index=${idx}`;
    heroImg.onload = () => {
      heroImg.style.display = 'block';
      heroPlaceholder.style.display = 'none';
    };
    heroImg.onerror = () => {
      heroImg.style.display = 'none';
      heroPlaceholder.style.display = 'flex';
    };
    heroImg.onclick = () => {
      openLightbox(heroImg.src, `头像 ${idx + 1} / ${state.profilePhotos.length}`);
    };
  }
}

async function loadPeerStories(chatId) {
  const instId = state.clientSelectedInstance;
  const container = document.getElementById('profile-stories-container');
  const countBadge = document.getElementById('profile-stories-count');
  if (!container) return;

  try {
    const stories = await api(`/api/instances/${instId}/account/stories?chatId=${chatId}`);
    const list = Array.isArray(stories) ? stories : [];
    if (countBadge) countBadge.innerText = String(list.length);

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-hint">暂无活跃动态发布</div>';
      return;
    }

    container.innerHTML = '';
    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'story-card';
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
      card.onclick = () => {
        showToast('查看动态详情: ' + (s.caption || '动态快拍'), 'info');
      };
      container.appendChild(card);
    }
  } catch (err) {
    if (countBadge) countBadge.innerText = '0';
    container.innerHTML = '<div class="empty-hint">该实体不支持或未发布动态</div>';
  }
}

async function loadSharedMedia(type = 'photos') {
  state.sharedMediaTab = type;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
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
          <div class="shared-photo-item" onclick="openLightbox('${fullUrl}', '共享照片 #${m.id}')">
            <img src="${thumbUrl}" alt="Photo" loading="lazy">
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
        const titleStr = escapeHtml('共享视频 #' + m.id);
        gridHtml += `
          <div class="shared-video-item" onclick="openCinemaVideo('${videoUrl}', '${titleStr}', '${timeStr}', '${durStr}')" title="点击在影院播放器中播放">
            <video preload="metadata" playsinline poster="${thumbUrl}" src="${videoUrl}"></video>
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
            <a class="btn btn-secondary btn-xs" href="${docUrl}" download="${escapeHtml(fName)}" target="_blank" title="下载原文件">
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
              <button class="btn btn-primary btn-xs" onclick="playTrackDirect('${escapeHtml(tTitle)}', '${escapeHtml(tArtist)}', '${audioUrl}', ${m.id})">播放</button>
              <button class="btn btn-secondary btn-xs" onclick="addTrackToPlaylist('${escapeHtml(tTitle)}', '${escapeHtml(tArtist)}', '${audioUrl}', ${m.id})">加歌单</button>
            </div>
          </div>
        `;
      }
      listHtml += '</div>';
      container.innerHTML = listHtml;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-hint error">加载共享媒体失败: ${err.message}</div>`;
  }
}

// ==========================================
// Group & Channel Members Controller
// ==========================================
state.groupMembers = [];

async function loadGroupMembers(chatId) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId) return;
  const container = document.getElementById('members-list-container');
  if (container) container.innerHTML = '<div class="empty-hint">正在加载群成员...</div>';

  try {
    let participants = [];
    if (window.chatWs && window.chatWs.isConnected()) {
      participants = await window.chatWs.sendRpc('get_participants', { instId, chatId, limit: 200 });
    } else {
      participants = await api(`/api/instances/${instId}/account/participants?chatId=${chatId}&limit=200`);
    }

    state.groupMembers = Array.isArray(participants) ? participants : [];
    renderGroupMembers();
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="empty-hint error">获取群成员失败: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderGroupMembers() {
  const container = document.getElementById('members-list-container');
  const searchInput = document.getElementById('member-search-input');
  if (!container) return;

  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const list = state.groupMembers.filter((p) => {
    if (!query) return true;
    const name = `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.toLowerCase();
    const username = (p.user?.username || '').toLowerCase();
    const id = String(p.user?.id || '');
    return name.includes(query) || username.includes(query) || id.includes(query);
  });

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-hint">未检索到匹配的群成员</div>';
    return;
  }

  let html = '';
  for (const item of list) {
    const u = item.user || {};
    const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || `UID:${u.id}`;
    const initials = (u.firstName || u.username || 'U').slice(0, 2);
    const usernameStr = u.username ? `@${u.username}` : `ID: ${u.id}`;

    let roleBadgeHtml = '';
    if (item.role === 'owner') {
      roleBadgeHtml = '<span class="member-badge owner" title="群主">👑 群主</span>';
    } else if (item.role === 'admin') {
      roleBadgeHtml = '<span class="member-badge admin" title="管理员">⭐ 管理员</span>';
    } else if (u.isBot) {
      roleBadgeHtml = '<span class="member-badge bot" title="机器人">🤖 Bot</span>';
    }

    html += `
      <div class="member-item-card">
        <div class="member-info-group">
          <div class="member-avatar">${escapeHtml(initials)}</div>
          <div class="member-text-meta">
            <div class="member-name-row">
              <span class="member-name" title="${escapeHtml(fullName)}">${escapeHtml(fullName)}</span>
              ${roleBadgeHtml}
            </div>
            <div class="member-subtext">${escapeHtml(usernameStr)}</div>
          </div>
        </div>
        <div class="member-actions">
          <button class="btn btn-secondary btn-xs" onclick="startDirectChat('${u.id}', '${escapeHtml(fullName)}')" title="发起私聊">私聊</button>
          <button class="btn btn-secondary btn-xs" onclick="muteGroupMember(${u.id}, '${escapeHtml(fullName)}', 3600)" title="禁言 1 小时">禁言</button>
          <button class="btn btn-danger btn-xs" onclick="kickGroupMember(${u.id}, '${escapeHtml(fullName)}')" title="移出群组">踢出</button>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

async function kickGroupMember(userId, name) {
  if (!confirm(`确定要将【${name}】移出当前群聊吗？`)) return;
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('kick_user', { instId, chatId, userId });
    } else {
      await api(`/api/instances/${instId}/account/kick`, 'POST', { chatId, userId });
    }
    showToast(`已将 ${name} 移出群聊`, 'success');
    loadGroupMembers(chatId);
  } catch (err) {
    showToast(`移出失败: ${err.message}`, 'error');
  }
}

async function muteGroupMember(userId, name, seconds = 3600) {
  const instId = state.clientSelectedInstance;
  const chatId = state.clientActiveChatId;
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('mute_user', { instId, chatId, userId, seconds });
    } else {
      await api(`/api/instances/${instId}/account/mute`, 'POST', { chatId, userId, seconds });
    }
    showToast(`已将 ${name} 禁言 ${Math.round(seconds / 60)} 分钟`, 'success');
  } catch (err) {
    showToast(`禁言失败: ${err.message}`, 'error');
  }
}

function startDirectChat(userId, name) {
  const existing = state.clientDialogs.find((d) => String(d.id) === String(userId));
  if (existing) {
    selectClientChat(existing.id);
  } else {
    state.clientActiveChatId = Number(userId);
    const titleEl = document.getElementById('client-chat-title');
    const subEl = document.getElementById('client-chat-subtitle');
    if (titleEl) titleEl.innerText = name;
    if (subEl) subEl.innerText = `私聊 UID: ${userId}`;
    loadClientMessages(Number(userId));
  }
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

  const openModal = () => {
    if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
    modal.style.display = 'flex';
    if (dateInput) {
      dateInput.value = new Date().toISOString().split('T')[0];
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
        dateInput.value = d.toISOString().split('T')[0];
      }
    };
  });

  btnConfirm.onclick = async () => {
    if (!dateInput || !dateInput.value) return showToast('请选择目标日期', 'warn');
    const selectedDate = new Date(dateInput.value + 'T23:59:59');
    const offsetDate = Math.floor(selectedDate.getTime() / 1000);
    closeModal();
    showToast(`正在跳转至 ${dateInput.value} 历史消息...`, 'info');
    await loadClientMessagesWithDate(state.clientActiveChatId, offsetDate);
  };
}

async function loadClientMessagesWithDate(chatId, offsetDate) {
  const instId = state.clientSelectedInstance;
  if (!instId || !chatId) return;

  try {
    let msgs = [];
    if (window.chatWs && window.chatWs.isConnected()) {
      msgs = await window.chatWs.sendRpc('get_messages', {
        instId,
        chatId,
        limit: 40,
        offsetDate,
      });
    } else {
      msgs = await api(`/api/instances/${instId}/account/messages?chatId=${chatId}&limit=40&offsetDate=${offsetDate}`);
    }

    state.clientMessages = Array.isArray(msgs) ? msgs.reverse() : [];
    renderClientMessages(false);
    showToast(`已定位到指定日期的历史消息`, 'success');
  } catch (err) {
    showToast(`日期跳转失败: ${err.message}`, 'error');
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

  if (!btnToggle || !modal) return;

  const openModal = () => {
    const textInput = document.getElementById('client-message-textarea');
    if (!textInput?.value.trim() && !state.clientStagedFile) {
      return showToast('请先在输入框中输入消息内容或选择附件', 'warn');
    }
    modal.style.display = 'flex';
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
    closeModal();
    sendClientMessage(unixSec);
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
  try {
    if (window.chatWs && window.chatWs.isConnected()) {
      await window.chatWs.sendRpc('delete_messages', { instId, chatId, messageIds: [msgId], revoke: true });
    } else {
      await api(`/api/instances/${instId}/account/purge`, 'POST', {
        chatId,
        count: 1,
      });
    }
    showToast('已撤回消息', 'success');
    state.clientMessages = state.clientMessages.filter((m) => m.id !== msgId);
    renderClientMessages();
  } catch (err) {
    showToast(`撤回失败: ${err.message}`, 'error');
  }
}

async function quickPurge(count) {
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  if (!confirm(`确定清理当前会话最近 ${count} 条消息吗？`)) return;
  const instId = state.clientSelectedInstance;
  try {
    const res = await api(`/api/instances/${instId}/account/purge`, 'POST', {
      chatId: state.clientActiveChatId,
      count,
    });
    showToast(`已成功批量撤回 ${res.deletedCount || count} 条消息`, 'success');
    await loadClientMessages(state.clientActiveChatId);
  } catch (err) {
    showToast(`批量撤回失败: ${err.message}`, 'error');
  }
}

async function quickLeaveChat() {
  if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
  if (!confirm(`确定退出当前群聊/频道 (${state.clientActiveChatId}) 吗？`)) return;
  const instId = state.clientSelectedInstance;
  try {
    await api(`/api/instances/${instId}/account/leave`, 'POST', {
      chatId: state.clientActiveChatId,
    });
    showToast('已成功退出该会话', 'success');
    state.clientActiveChatId = null;
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

async function openProfileModal() {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('请先选择一个账号', 'warn');
  const modal = document.getElementById('modal-profile');
  modal.classList.add('active');

  try {
    const p = await api(`/api/instances/${instId}/account/profile`);
    document.getElementById('profile-avatar-large').innerText = (p.firstName || p.username || 'TG').slice(0, 2);
    document.getElementById('profile-display-name').innerText = `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.username || 'Telegram User';
    document.getElementById('profile-display-username').innerText = p.username ? `@${p.username}` : '@未设置用户名';
    document.getElementById('profile-display-id').innerText = `ID: ${p.id || '--'}`;
    document.getElementById('profile-display-phone').innerText = `Phone: ${p.phone || '--'}`;

    document.getElementById('profile-input-firstname').value = p.firstName || '';
    document.getElementById('profile-input-lastname').value = p.lastName || '';
    document.getElementById('profile-input-bio').value = p.bio || '';
  } catch (err) {
    showToast(`加载账号资料失败: ${err.message}`, 'error');
  }
}

async function saveProfileModal() {
  const instId = state.clientSelectedInstance;
  const firstName = document.getElementById('profile-input-firstname').value.trim();
  const lastName = document.getElementById('profile-input-lastname').value.trim();
  const bio = document.getElementById('profile-input-bio').value.trim();

  if (!firstName) return showToast('First Name 不能为空', 'warn');

  try {
    await api(`/api/instances/${instId}/account/profile`, 'POST', { firstName, lastName, bio });
    showToast('个人资料已成功更新', 'success');
    document.getElementById('modal-profile').classList.remove('active');
    await loadInstances();
  } catch (err) {
    showToast(`更新资料失败: ${err.message}`, 'error');
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
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty error">加载失败: ${err.message}</td></tr>`;
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
      <td><b>#${t.id}</b></td>
      <td><code>${escapeHtml(String(t.chat_id))}</code></td>
      <td>${ruleStr}</td>
      <td title="${escapeHtml(t.content)}"><i>${escapeHtml(snippet)}</i></td>
      <td>
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${countdownStr}</div>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">${nextTimeStr}</div>
      </td>
      <td>${statusBadge}</td>
      <td style="text-align: right;">
        <button class="btn btn-secondary btn-xs" onclick="runTaskNow(${t.id})" title="立即测试发送一次">执行一次</button>
        <button class="btn btn-secondary btn-xs" onclick="toggleTask(${t.id})">${t.enabled === 1 ? '禁用' : '启用'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteTask(${t.id})" title="永久删除任务">删除</button>
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
function stageAttachmentFile(file) {
  if (!file) return;
  state.clientStagedFile = file;
  const strip = document.getElementById('chat-attachment-strip');
  const nameEl = document.getElementById('attachment-chip-name');
  const sizeEl = document.getElementById('attachment-chip-size');
  if (strip && nameEl && sizeEl) {
    nameEl.textContent = file.name;
    sizeEl.textContent = `(${formatBytes(file.size)})`;
    strip.style.display = 'flex';
  }
  document.getElementById('client-message-textarea')?.focus();
}

function clearStagedAttachment() {
  state.clientStagedFile = null;
  const strip = document.getElementById('chat-attachment-strip');
  if (strip) strip.style.display = 'none';
  const fileInput = document.getElementById('chat-file-input');
  if (fileInput) fileInput.value = '';
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
        stageAttachmentFile(e.dataTransfer.files[0]);
      }
    });
  });

  const btnAttach = document.getElementById('btn-chat-attach');
  const fileInput = document.getElementById('chat-file-input');
  if (btnAttach && fileInput) {
    btnAttach.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      if (fileInput.files && fileInput.files.length > 0) {
        stageAttachmentFile(fileInput.files[0]);
      }
    };
  }

  const btnCancelAttach = document.getElementById('btn-cancel-attachment');
  if (btnCancelAttach) {
    btnCancelAttach.onclick = () => clearStagedAttachment();
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
          delete state.clientDrafts[state.clientActiveChatId];
          renderClientDialogs();
        }
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

function renderEmojiPicker(cat = 'smileys', filter = '') {
  const container = document.getElementById('emoji-grid');
  if (!container) return;

  const catBar = document.getElementById('emoji-categories-bar');
  if (catBar) {
    catBar.innerHTML = '';
    const cats = [
      { id: 'smileys', icon: '😀', name: '人物与表情' },
      { id: 'gestures', icon: '👍', name: '手势' },
      { id: 'animals', icon: '🐱', name: '动物' },
      { id: 'food', icon: '🍎', name: '食物' },
      { id: 'activities', icon: '⚽', name: '活动' },
      { id: 'travel', icon: '🚗', name: '旅行' },
      { id: 'objects', icon: '💡', name: '物品' },
      { id: 'symbols', icon: '❤️', name: '符号' },
      { id: 'flags', icon: '🚩', name: '旗帜' },
    ];
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
        renderEmojiPicker(c.id, document.getElementById('emoji-search-input')?.value.trim());
      };
      catBar.appendChild(catBtn);
    }
  }

  let emojis = [];
  if (filter) {
    const all = Object.values(EMOJI_CATEGORIES).flat();
    emojis = all;
  } else {
    emojis = EMOJI_CATEGORIES[cat] || EMOJI_CATEGORIES.smileys;
  }

  container.innerHTML = '';
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
    renderEmojiPicker();
  } else if (tabName === 'stickers') {
    loadClientStickers();
  } else if (tabName === 'gifs') {
    loadClientGifs();
  }
}

async function loadClientStickers() {
  const instId = state.clientSelectedInstance;
  const container = document.getElementById('stickers-stream-container');
  const switcher = document.getElementById('stickers-bottom-switcher');
  if (!instId || !container) return;

  if (state.clientStickerPacks && state.clientStickerPacks.length > 0) {
    renderStickerStream();
    return;
  }

  container.innerHTML = '<div class="empty-hint">正在加载 Telegram 表情包...</div>';
  switcher.innerHTML = '';

  try {
    const packs = await api(`/api/instances/${instId}/account/stickers`);
    if (!Array.isArray(packs) || packs.length === 0) {
      container.innerHTML = '<div class="empty-hint">当前账号未安装表情包</div>';
      return;
    }

    const detailedPacks = [];
    for (const pack of packs.slice(0, 16)) {
      try {
        const details = await api(`/api/instances/${instId}/account/sticker-set?setId=${pack.id}&accessHash=${pack.accessHash}`);
        if (details && details.stickers && details.stickers.length > 0) {
          detailedPacks.push(details);
        }
      } catch (err) {
        console.warn('Failed to load pack details:', pack.title, err);
      }
    }

    state.clientStickerPacks = detailedPacks;
    renderStickerStream();
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">加载表情包失败: ${err.message}</div>`;
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

  if (packs.length === 0) {
    container.innerHTML = '<div class="empty-hint">未找到匹配的表情包</div>';
    switcher.innerHTML = '';
    return;
  }

  container.innerHTML = '';
  switcher.innerHTML = '';

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

    for (const s of p.stickers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-item-btn';
      btn.title = s.emoji ? `${s.emoji} (点击快捷发送)` : '点击快捷发送';

      const img = document.createElement('img');
      img.className = 'sticker-item-img';
      img.alt = s.emoji || 'Sticker';
      img.loading = 'lazy';

      if (s.thumbDataUri) {
        img.src = s.thumbDataUri;
      } else {
        const thumbUrl = `/api/instances/${instId}/account/sticker-thumb?docId=${s.id}&accessHash=${s.accessHash}&fileRef=${encodeURIComponent(s.fileReference || '')}`;
        scheduler.loadImage(img, thumbUrl);
      }

      btn.appendChild(img);
      btn.onclick = () => sendSticker(s);
      grid.appendChild(btn);
    }

    packSection.appendChild(grid);
    container.appendChild(packSection);

    // Bottom Switcher Thumbnail (Telegram PC Desktop Horizontal Strip)
    const switchItem = document.createElement('button');
    switchItem.type = 'button';
    switchItem.className = `pack-switcher-item ${idx === 0 ? 'active' : ''}`;
    switchItem.title = p.set.title;

    if (p.stickers.length > 0) {
      const firstSticker = p.stickers[0];
      if (firstSticker.thumbDataUri) {
        switchItem.innerHTML = `<img class="pack-switcher-img" src="${firstSticker.thumbDataUri}" alt="pack" />`;
      } else {
        const thumbUrl = `/api/instances/${instId}/account/sticker-thumb?docId=${firstSticker.id}&accessHash=${firstSticker.accessHash}&fileRef=${encodeURIComponent(firstSticker.fileReference || '')}`;
        const img = document.createElement('img');
        img.className = 'pack-switcher-img';
        img.alt = 'pack';
        scheduler.loadImage(img, thumbUrl);
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
  const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;

  try {
    await api(`/api/instances/${instId}/account/send-sticker`, 'POST', {
      chatId: state.clientActiveChatId,
      docId: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
      replyTo,
    });
    cancelReplyBanner();
    showToast('贴纸已发送', 'success');
    await loadClientMessages(state.clientActiveChatId);
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
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (event) => {
          openPasteImageModal(event.target.result, file);
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  };

  if (textarea) textarea.addEventListener('paste', handlePaste);
  if (chatPane) chatPane.addEventListener('paste', handlePaste);
}

function openPasteImageModal(dataUrl, file) {
  state.pendingPasteFile = {
    dataUrl,
    fileName: file.name || `pasted_image_${Date.now()}.png`,
    size: file.size,
    type: file.type || 'image/png',
  };

  const modal = document.getElementById('modal-paste-image');
  const img = document.getElementById('paste-image-preview');
  const info = document.getElementById('paste-image-info');
  const caption = document.getElementById('paste-image-caption');
  const textarea = document.getElementById('client-message-textarea');

  if (img) img.src = dataUrl;
  if (info) info.textContent = `${(file.size / 1024).toFixed(1)} KB · ${file.type || 'image/png'}`;
  if (caption) {
    caption.value = textarea?.value?.trim() || '';
    if (textarea) textarea.value = '';
    setTimeout(() => caption.focus(), 100);
  }
  if (modal) modal.style.display = 'flex';
}

function closePasteImageModal() {
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
  const caption = (document.getElementById('paste-image-caption')?.value || '').trim();
  const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;

  const btn = document.getElementById('btn-paste-image-send');
  if (btn) btn.disabled = true;

  try {
    showToast('正在发送图片...', 'info');
    const base64Content = state.pendingPasteFile.dataUrl.split(',')[1];
    await api(`/api/instances/${instId}/account/send-media`, 'POST', {
      chatId: state.clientActiveChatId,
      fileBase64: base64Content,
      fileName: state.pendingPasteFile.fileName,
      caption,
      replyTo,
    });

    closePasteImageModal();
    cancelReplyBanner();
    showToast('图片发送成功', 'success');
    await loadClientMessages(state.clientActiveChatId);
  } catch (err) {
    showToast(`发送图片失败: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ==========================================================================
   Sticker Pack Preview & Install / Uninstall Modal
   ========================================================================== */

async function openStickerPackModal(setId, accessHash, shortName) {
  const instId = state.clientSelectedInstance;
  if (!instId) return;

  const modal = document.getElementById('modal-sticker-pack');
  const titleEl = document.getElementById('sticker-pack-modal-title');
  const nameEl = document.getElementById('sticker-pack-name');
  const subtextEl = document.getElementById('sticker-pack-subtext');
  const badgeEl = document.getElementById('sticker-pack-modal-badge');
  const actionBtn = document.getElementById('btn-sticker-pack-action');
  const gridEl = document.getElementById('sticker-pack-grid');

  if (modal) modal.style.display = 'flex';
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
          scheduler.loadImage(img, thumbUrl);
        }
        item.appendChild(img);

        item.onclick = async () => {
          if (state.clientActiveChatId) {
            await sendSticker(s);
            closeStickerPackModal();
          }
        };

        gridEl.appendChild(item);
      });
    }
  } catch (err) {
    if (nameEl) nameEl.textContent = '加载失败';
    if (gridEl) gridEl.innerHTML = `<div class="empty-hint" style="grid-column: 1/-1;">${escapeHtml(err.message)}</div>`;
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
  const isInstalled = state.activeStickerPackIsInstalled;
  const actionBtn = document.getElementById('btn-sticker-pack-action');
  if (actionBtn) actionBtn.disabled = true;

  const packSet = details.set || details;
  const setId = packSet.id;
  const accessHash = packSet.accessHash;

  try {
    if (isInstalled) {
      await api(`/api/instances/${instId}/account/stickers/uninstall`, 'POST', { setId, accessHash });
      state.activeStickerPackIsInstalled = false;
      updateStickerPackModalAction(false);
      showToast('贴纸包已从账号移除', 'success');
    } else {
      await api(`/api/instances/${instId}/account/stickers/install`, 'POST', { setId, accessHash });
      state.activeStickerPackIsInstalled = true;
      updateStickerPackModalAction(true);
      showToast('贴纸包已成功添加到账号', 'success');
    }
    state.clientStickerPacks = null;
    loadClientStickers();
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  } finally {
    if (actionBtn) actionBtn.disabled = false;
  }
}

function closeStickerPackModal() {
  state.activeStickerPackDetails = null;
  const modal = document.getElementById('modal-sticker-pack');
  if (modal) modal.style.display = 'none';
}

async function loadClientGifs() {
  const instId = state.clientSelectedInstance;
  const container = document.getElementById('gifs-stream-container');
  if (!instId || !container) return;

  if (state.clientGifs && state.clientGifs.length > 0) {
    renderGifStream();
    return;
  }

  container.innerHTML = '<div class="empty-hint">正在获取收藏的 GIF 动图...</div>';

  try {
    const gifs = await api(`/api/instances/${instId}/account/gifs`);
    state.clientGifs = Array.isArray(gifs) ? gifs : [];
    renderGifStream();
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">加载 GIF 失败: ${err.message}</div>`;
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
    card.innerHTML = `
      <img src="${thumbUrl}" alt="GIF" loading="lazy" />
      <span class="gif-item-badge">GIF</span>
    `;

    card.onclick = () => sendGif(g);
    container.appendChild(card);
  }
}

async function sendGif(gif) {
  if (!state.clientActiveChatId) {
    return showToast('请先在左侧选择会话', 'warn');
  }
  const instId = state.clientSelectedInstance;
  const replyTo = state.clientReplyingTo ? state.clientReplyingTo.id : undefined;

  try {
    await api(`/api/instances/${instId}/account/send-gif`, 'POST', {
      chatId: state.clientActiveChatId,
      docId: gif.id,
      accessHash: gif.accessHash,
      fileReference: gif.fileReference,
      replyTo,
    });
    cancelReplyBanner();
    showToast('动图已发送', 'success');
    await loadClientMessages(state.clientActiveChatId);
  } catch (err) {
    showToast(`发送动图失败: ${err.message}`, 'error');
  }
}

// ==========================================
// Dual WebSocket Chat Manager (Strictly at most 2 WebSockets)
// Connection 1: /ws/chat-stream (Server-push real-time event stream)
// Connection 2: /ws/chat-rpc (High-speed interactive RPC & Cache queries)
// ==========================================
class ChatWSManager {
  constructor() {
    this.streamWs = null;
    this.rpcWs = null;
    this.rpcCallbacks = new Map();
    this.rpcIdCounter = 0;
    this.reconnectTimer = null;
    this.isManualClosed = false;
  }

  connect() {
    this.isManualClosed = false;
    if (this.streamWs && this.streamWs.readyState <= 1 && this.rpcWs && this.rpcWs.readyState <= 1) {
      return; // Already connected or connecting
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host;

    // --- 1. Real-time Stream WS (/ws/chat-stream) ---
    try {
      this.streamWs = new WebSocket(`${proto}//${host}/ws/chat-stream`);
      this.streamWs.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          this.handleStreamEvent(event);
        } catch (_) {}
      };
      this.streamWs.onerror = () => {};
      this.streamWs.onclose = () => {
        if (!this.isManualClosed) this.scheduleReconnect();
      };
    } catch (_) {}

    // --- 2. RPC Channel WS (/ws/chat-rpc) ---
    try {
      this.rpcWs = new WebSocket(`${proto}//${host}/ws/chat-rpc`);
      this.rpcWs.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.id && this.rpcCallbacks.has(msg.id)) {
            const cb = this.rpcCallbacks.get(msg.id);
            this.rpcCallbacks.delete(msg.id);
            clearTimeout(cb.timeout);
            if (msg.success) {
              cb.resolve(msg.data);
            } else {
              cb.reject(new Error(msg.error || 'RPC action failed'));
            }
          }
        } catch (_) {}
      };
      this.rpcWs.onerror = () => {};
      this.rpcWs.onclose = () => {
        if (!this.isManualClosed) this.scheduleReconnect();
      };
    } catch (_) {}
  }

  disconnect() {
    this.isManualClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.streamWs) {
      try { this.streamWs.close(); } catch (_) {}
      this.streamWs = null;
    }
    if (this.rpcWs) {
      try { this.rpcWs.close(); } catch (_) {}
      this.rpcWs = null;
    }
    this.rpcCallbacks.forEach((cb) => {
      clearTimeout(cb.timeout);
      cb.reject(new Error('Connection closed'));
    });
    this.rpcCallbacks.clear();
  }

  isConnected() {
    return this.rpcWs && this.rpcWs.readyState === WebSocket.OPEN;
  }

  scheduleReconnect() {
    if (this.isManualClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isManualClosed) this.connect();
    }, 3000);
  }

  sendRpc(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.rpcWs || this.rpcWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('RPC WebSocket is not connected'));
      }
      const id = ++this.rpcIdCounter;
      const timeout = setTimeout(() => {
        if (this.rpcCallbacks.has(id)) {
          this.rpcCallbacks.delete(id);
          reject(new Error(`RPC timeout for action "${action}"`));
        }
      }, 8000);

      this.rpcCallbacks.set(id, { resolve, reject, timeout });
      this.rpcWs.send(JSON.stringify({ id, action, params }));
    });
  }

  handleStreamEvent(event) {
    if (!event || !event.type) return;

    // Real-time message push
    if (event.type === 'new_message' && event.message) {
      const m = event.message;
      const isCurrentChat =
        event.instId === state.clientSelectedInstance &&
        String(m.chatId) === String(state.clientActiveChatId);
      if (isCurrentChat) {
        if (!state.clientMessages.some((x) => String(x.id) === String(m.id))) {
          state.clientMessages.push(m);
          renderClientMessages(false);
          // Auto mark as read if active chat
          try {
            if (this.isConnected()) {
              this.sendRpc('mark_as_read', { instId: event.instId, chatId: m.chatId, maxId: m.id }).catch(() => {});
            }
          } catch (_) {}
        }
      }
      // Update snippet in dialog list & bump to top
      const dIndex = state.clientDialogs.findIndex((x) => String(x.id) === String(m.chatId));
      if (dIndex !== -1) {
        const d = state.clientDialogs[dIndex];
        d.lastMessage = m.text || (m.media ? `[${m.media.type}]` : '');
        d.lastSender = m.from?.firstName || m.from?.username || '';
        d.lastMessageDate = Date.now();
        if (!isCurrentChat) {
          d.unreadCount = (d.unreadCount || 0) + 1;
        }
        if (dIndex > 0) {
          state.clientDialogs.splice(dIndex, 1);
          state.clientDialogs.unshift(d);
        }
        renderClientDialogs();
      }
    }

    // Real-time message edit
    if (event.type === 'message_edit' && event.message) {
      const m = event.message;
      if (
        event.instId === state.clientSelectedInstance &&
        String(m.chatId) === String(state.clientActiveChatId)
      ) {
        const idx = state.clientMessages.findIndex((x) => String(x.id) === String(m.id));
        if (idx !== -1) {
          state.clientMessages[idx] = m;
          renderClientMessages(true);
        }
      }
      const d = state.clientDialogs.find((x) => String(x.id) === String(m.chatId));
      if (d) {
        d.lastMessage = m.text || (m.media ? `[${m.media.type}]` : '');
        renderClientDialogs();
      }
    }

    // Real-time message delete
    if (event.type === 'message_delete' && event.messageIds) {
      if (
        event.instId === state.clientSelectedInstance &&
        String(event.chatId) === String(state.clientActiveChatId)
      ) {
        const idSet = new Set(event.messageIds.map(String));
        state.clientMessages = state.clientMessages.filter((m) => !idSet.has(String(m.id)));
        renderClientMessages(true);
      }
    }

    // Real-time peer typing push
    if (event.type === 'chat_typing' && event.instId === state.clientSelectedInstance) {
      if (String(event.chatId) === String(state.clientActiveChatId)) {
        const subtitleEl = document.getElementById('client-chat-subtitle');
        if (subtitleEl) {
          const sender = state.clientMessages.find((m) => String(m.from?.id) === String(event.userId))?.from?.firstName || '对方';
          subtitleEl.innerHTML = `<span style="color:var(--color-primary);">${escapeHtml(sender)} 正在输入<span class="typing-dots"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span></span>`;
          if (state.typingTimer) clearTimeout(state.typingTimer);
          state.typingTimer = setTimeout(() => {
            const curDialog = state.clientDialogs.find((d) => String(d.id) === String(state.clientActiveChatId));
            if (curDialog && subtitleEl) {
              const typeMap = { private: '私聊 (Private)', group: '普通群组 (Group)', supergroup: '超级群组 (Supergroup)', channel: '广播频道 (Channel)', bot: '机器人 (Bot)' };
              const userTag = curDialog.username ? ` | @${curDialog.username}` : '';
              subtitleEl.innerText = `${typeMap[curDialog.type] || curDialog.type} | ID: ${curDialog.id}${userTag}`;
            }
          }, 4500);
        }
      } else {
        // Show typing indicator in dialog list
        const dIndex = state.clientDialogs.findIndex((d) => String(d.id) === String(event.chatId));
        if (dIndex !== -1) {
          const d = state.clientDialogs[dIndex];
          d._typing = true;
          renderClientDialogs();
          // Clear after timeout
          if (d._typingTimer) clearTimeout(d._typingTimer);
          d._typingTimer = setTimeout(() => {
            d._typing = false;
            renderClientDialogs();
          }, 4500);
        }
      }
    }

    // Real-time message read receipt
    if (event.type === 'message_read' && event.instId === state.clientSelectedInstance) {
      const chatId = String(event.chatId);
      const maxId = Number(event.maxId || 0);
      // Mark all outgoing messages <= maxId as read
      let updated = false;
      for (const m of state.clientMessages) {
        if (m.outgoing && m.id <= maxId && !m.read) {
          m.read = true;
          updated = true;
          // Update tick in-place
          const msgEl = document.getElementById(`chat-msg-${m.id}`);
          if (msgEl) {
            const tick = msgEl.querySelector('.msg-status-tick');
            if (tick) {
              tick.className = 'msg-status-tick read';
              tick.title = '已读';
              tick.textContent = '✓✓';
            }
          }
        }
      }
      if (updated && chatId === String(state.clientActiveChatId)) {
        // No full re-render needed, in-place update is sufficient
      }
    }

    // Real-time user online status
    if (event.type === 'user_status' && event.instId === state.clientSelectedInstance) {
      const userId = String(event.userId);
      // Update dialog list
      const d = state.clientDialogs.find((x) => String(x.id) === userId);
      if (d) {
        d.online = Boolean(event.online);
        d.lastSeen = event.lastSeen || d.lastSeen;
        renderClientDialogs();
      }
      // Update chat header subtitle if current chat
      if (String(state.clientActiveChatId) === userId) {
        const subtitleEl = document.getElementById('client-chat-subtitle');
        if (subtitleEl && !state.typingTimer) {
          if (event.online) {
            subtitleEl.innerHTML = '<span style="color:var(--tg-online-dot);">在线</span>';
          } else if (event.lastSeen) {
            const ls = new Date(event.lastSeen);
            subtitleEl.innerText = `最后上线于 ${ls.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
        }
      }
    }

    // Real-time dialogs update
    if (event.type === 'dialogs_update' && event.instId === state.clientSelectedInstance) {
      if (Array.isArray(event.dialogs)) {
        state.clientDialogs = event.dialogs;
        renderClientDialogs();
      }
    }
  }
}

window.chatWs = new ChatWSManager();

// ==========================================
// Miuix Message Context Menu (Desktop Right-Click & Mobile Long-Press)
// ==========================================
let activeContextMsg = null;
let longPressTimer = null;
let touchCoords = { x: 0, y: 0 };

function initMessageContextMenu() {
  const container = document.getElementById('client-messages-container');
  const menu = document.getElementById('msg-context-menu');
  const backdrop = document.getElementById('menu-backdrop');
  if (!container || !menu) return;

  const showMenu = (x, y, msgWrap) => {
    const msgId = Number(msgWrap.dataset.msgId);
    const isOut = msgWrap.dataset.isOut === '1';
    const text = msgWrap.dataset.msgText || '';
    const isPinned = msgWrap.dataset.isPinned === '1';
    activeContextMsg = { id: msgId, isOut, text, isPinned, wrap: msgWrap };

    // Toggle Edit button (only visible for own outgoing messages)
    const btnEdit = document.getElementById('menu-action-edit');
    if (btnEdit) {
      btnEdit.style.display = isOut && text ? 'flex' : 'none';
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
    activeContextMsg = null;
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
    btn.onclick = async (e) => {
      e.stopPropagation();
      const reaction = btn.dataset.reaction;
      if (!activeContextMsg || !reaction) return;
      const { id: msgId } = activeContextMsg;
      hideMenu();

      const instId = state.clientSelectedInstance;
      const chatId = state.clientActiveChatId;
      try {
        if (window.chatWs && window.chatWs.isConnected()) {
          await window.chatWs.sendRpc('send_reaction', { instId, chatId, messageId: msgId, reaction });
        } else {
          await api(`/api/instances/${instId}/account/reaction`, 'POST', { chatId, messageId: msgId, reaction });
        }
        showToast(`已回应 ${reaction}`, 'success');
      } catch (err) {
        showToast(`回应失败: ${err.message}`, 'error');
      }
    };
  });

  // 5. Menu Actions
  document.getElementById('menu-action-reply')?.addEventListener('click', () => {
    if (!activeContextMsg) return;
    const msgId = activeContextMsg.id;
    hideMenu();
    setReplyingMessage(msgId);
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

  document.getElementById('menu-action-translate')?.addEventListener('click', async () => {
    if (!activeContextMsg || !activeContextMsg.text) return;
    const { id: msgId, text, wrap } = activeContextMsg;
    hideMenu();
    showToast('正在翻译消息...', 'info');
    try {
      const res = await api(`/api/instances/${state.clientSelectedInstance}/account/translate`, 'POST', { text });
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
              <span>翻译自 ${escapeHtml(res.srcLang?.toUpperCase() || '外语')} · 智能引擎</span>
            </div>
            <div class="msg-translated-body">${escapeHtml(res.translatedText)}</div>
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
const pendingPollVotes = {};

function renderPollCardHtml(media, msgId, chatId) {
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
    const progressBarHtml = showResults ? `
      <div class="poll-progress-track">
        <div class="poll-progress-bar" style="width: ${pct}%;"></div>
      </div>
    ` : '';

    const clickAttr = (!hasVoted && !isClosed)
      ? `onclick="handlePollOptionClick('${chatId}', ${msgId}, ${idx}, ${multipleChoice})"`
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
  if (multipleChoice && !hasVoted && !isClosed) {
    multiVoteBtnHtml = `
      <div style="display:flex; justify-content:flex-end; margin-top:6px;">
        <button class="btn btn-primary btn-xs" id="btn-poll-submit-${msgId}" onclick="submitMultiPollVote('${chatId}', ${msgId})" style="display:none;">
          <span>提交投票</span>
        </button>
      </div>
    `;
  }

  return `
    <div class="msg-poll-card" id="poll-card-${msgId}">
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
    </div>
  `;
}

function handlePollOptionClick(chatId, msgId, optIdx, isMultiple) {
  if (!isMultiple) {
    sendPollVote(chatId, msgId, [optIdx]);
    return;
  }

  pendingPollVotes[msgId] = pendingPollVotes[msgId] || new Set();
  const set = pendingPollVotes[msgId];
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
      submitBtn.style.display = set.size > 0 ? 'inline-flex' : 'none';
    }
  }
}

function submitMultiPollVote(chatId, msgId) {
  const set = pendingPollVotes[msgId];
  if (!set || set.size === 0) return showToast('请至少选择一个选项', 'warn');
  const options = Array.from(set);
  delete pendingPollVotes[msgId];
  sendPollVote(chatId, msgId, options);
}

async function sendPollVote(chatId, msgId, options) {
  const instId = state.clientSelectedInstance;
  if (!instId) return showToast('未选择账号', 'warn');

  try {
    const res = await fetch(`/api/instances/${instId}/account/vote`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, msgId, options }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('投票成功!', 'success');
      if (state.clientActiveChatId === chatId) {
        await loadClientMessages(chatId, true);
      }
    } else {
      showToast(data.error || '投票失败', 'error');
    }
  } catch (err) {
    showToast(`投票请求失败: ${err.message}`, 'error');
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

  if (!modalPoll) return;

  const openPollModal = () => {
    if (!state.clientActiveChatId) return showToast('请先选择一个会话', 'warn');
    document.getElementById('poll-question-input').value = '';
    document.getElementById('poll-anonymous-input').checked = true;
    chkMultiple.checked = false;
    chkMultiple.disabled = false;
    chkQuiz.checked = false;
    chkQuiz.disabled = false;
    quizSolutionWrap.style.display = 'none';
    document.getElementById('poll-solution-input').value = '';

    renderPollModalOptions(['', '']);
    modalPoll.style.display = 'flex';
  };

  const closePollModal = () => {
    modalPoll.style.display = 'none';
  };

  if (btnOpenPoll) btnOpenPoll.onclick = openPollModal;
  if (btnClose) btnClose.onclick = closePollModal;
  if (btnCancel) btnCancel.onclick = closePollModal;

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

function renderPollModalOptions(values = ['', '']) {
  const container = document.getElementById('poll-options-builder');
  if (!container) return;
  const isQuiz = document.getElementById('poll-quiz-input')?.checked || false;
  const count = values.length;

  container.innerHTML = values.map((val, idx) => `
    <div class="poll-option-input-row" style="display: flex; align-items: center; gap: 8px;">
      <input type="radio" name="poll-quiz-radio" class="poll-quiz-radio" data-idx="${idx}" title="设为正确答案" ${idx === 0 ? 'checked' : ''} style="${isQuiz ? 'display:block;' : 'display:none;'}">
      <input type="text" class="input-control poll-opt-text" placeholder="选项 ${idx + 1}" value="${escapeHtml(val)}" style="flex: 1;">
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

  const question = document.getElementById('poll-question-input')?.value?.trim();
  if (!question) return showToast('请输入投票或测验题目', 'warn');

  const rows = document.querySelectorAll('.poll-option-input-row');
  const options = [];
  rows.forEach((r) => {
    const val = r.querySelector('.poll-opt-text')?.value?.trim();
    if (val) options.push(val);
  });

  if (options.length < 2) return showToast('请至少输入 2 个有效选项', 'warn');

  const isAnonymous = document.getElementById('poll-anonymous-input')?.checked ?? true;
  const multipleAnswers = document.getElementById('poll-multiple-input')?.checked ?? false;
  const isQuiz = document.getElementById('poll-quiz-input')?.checked ?? false;

  let correctOptionIndex = undefined;
  let solution = undefined;
  if (isQuiz) {
    const checkedRadio = document.querySelector('.poll-quiz-radio:checked');
    correctOptionIndex = checkedRadio ? Number(checkedRadio.dataset.idx) : 0;
    solution = document.getElementById('poll-solution-input')?.value?.trim() || undefined;
  }

  try {
    const res = await fetch(`/api/instances/${instId}/account/poll`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        question,
        options,
        isAnonymous,
        multipleAnswers,
        isQuiz,
        correctOptionIndex,
        solution
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('投票已成功发布', 'success');
      document.getElementById('modal-create-poll').style.display = 'none';
      await loadClientMessages(chatId, true);
    } else {
      showToast(data.error || '创建投票失败', 'error');
    }
  } catch (err) {
    showToast(`创建投票请求失败: ${err.message}`, 'error');
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
    const res = await fetch(`/api/instances/${instId}/account/mute-chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, muteUntil })
    });
    const data = await res.json();
    if (data.success) {
      state.clientMutedChats = state.clientMutedChats || {};
      if (muteUntil > 0) {
        state.clientMutedChats[chatId] = muteUntil;
        showToast('会话已设置为免打扰', 'info');
      } else {
        delete state.clientMutedChats[chatId];
        showToast('已恢复消息提醒', 'success');
      }
      localStorage.setItem('tgbot_muted_chats', JSON.stringify(state.clientMutedChats));
      updateChatMuteButtonState(chatId);
      renderClientDialogs();
    } else {
      showToast(data.error || '设置免打扰失败', 'error');
    }
  } catch (err) {
    showToast(`设置免打扰失败: ${err.message}`, 'error');
  }
}

function updateChatMuteButtonState(chatId) {
  const label = document.getElementById('chat-mute-status-text');
  if (!label) return;
  const isMuted = Boolean(state.clientMutedChats && state.clientMutedChats[chatId]);
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
      showToast('所有会话已全部标记为已读', 'success');
      (state.clientDialogs || []).forEach((d) => { d.unreadCount = 0; });
      renderClientDialogs();
    } else {
      showToast(data.error || '标记已读失败', 'error');
    }
  } catch (err) {
    showToast(`标记已读失败: ${err.message}`, 'error');
  }
}

// App Initialization
window.onload = async () => {
  if (window.ThemeManager) window.ThemeManager.init();
  if (window.SettingsPage) window.SettingsPage.init();
  if (window.ProfilePanel) window.ProfilePanel.init();
  initListeners();
  initSSE();
  initMessageContextMenu();
  initCacheSettings();
  initPollModal();
  initChatThemes();
  initChatMuteModal();
  const btnMarkAll = document.getElementById('btn-dialogs-mark-all-read');
  if (btnMarkAll) btnMarkAll.onclick = () => markAllDialogsRead();
  await loadStatus();
  await loadInstances();
  await loadPlugins();
  setInterval(loadStatus, 5000);
};

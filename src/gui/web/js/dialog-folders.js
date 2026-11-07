'use strict';

// Telegram's custom folders are server-synchronised filter rules applied to
// dialogs. The current list is paged, so matching continues as pages load.
window.DialogFolders = (() => {
  let account = null;
  let folders = [];
  let version = 0;
  let managerAccount = null;
  let currentFolderId = null;
  let currentFolderShared = false;
  let draft = null;
  let tagState = { account: null, enabled: false, premium: false };
  let tagStateVersion = 0;
  let folderSearchTimer;
  let folderSearchRequest = 0;
  let inviteRequest = 0;
  let invitePreviewRequest = 0;
  let folderInvites = [];
  let folderSharePeers = [];
  let folderShareSelection = new Set();
  let folderInvitePreview = null;
  let candidates = new Map();

  const FLAG_FIELDS = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots', 'excludeMuted', 'excludeRead', 'excludeArchived'];
  const PEER_FIELDS = ['includePeers', 'excludePeers', 'pinnedPeers'];
  const emptyFolder = () => ({ title: '', emoticon: '', contacts: false, nonContacts: false, groups: false,
    broadcasts: false, bots: false, excludeMuted: false, excludeRead: false, excludeArchived: false,
    includePeers: [], excludePeers: [], pinnedPeers: [] });

  function closeManager() {
    const modal = document.getElementById('modal-dialog-folder-manager');
    modal?.classList.remove('active');
    managerAccount = null;
    folderSearchRequest++;
    inviteRequest++;
    invitePreviewRequest++;
    folderInvitePreview = null;
    if (folderSearchTimer) clearTimeout(folderSearchTimer);
    folderSearchTimer = undefined;
  }

  function renderManagerItems() {
    const list = document.getElementById('dialog-folder-manager-items');
    if (!list) return;
    list.replaceChildren();
    for (const [index, folder] of folders.entries()) {
      const row = document.createElement('div'); row.className = 'dialog-folder-manager-item';
      const select = document.createElement('button'); select.type = 'button';
      select.className = `dialog-folder-manager-select${currentFolderId === folder.id ? ' active' : ''}`;
      if (Number.isInteger(Number(folder.color))) select.dataset.folderColor = String(((Number(folder.color) % 7) + 7) % 7);
      select.textContent = `${folder.emoticon ? `${folder.emoticon} ` : ''}${folder.title}${folder.isShared ? ' · 共享' : ''}`;
      select.onclick = () => selectFolder(folder);
      row.appendChild(select);
      const up = document.createElement('button'); up.type = 'button'; up.className = 'dialog-folder-order-btn'; up.textContent = '↑';
      up.title = '上移文件夹'; up.disabled = index === 0; up.onclick = () => { void moveFolder(index, -1); };
      const down = document.createElement('button'); down.type = 'button'; down.className = 'dialog-folder-order-btn'; down.textContent = '↓';
      down.title = '下移文件夹'; down.disabled = index === folders.length - 1; down.onclick = () => { void moveFolder(index, 1); };
      row.append(up, down); list.appendChild(row);
    }
  }

  function setManagerStatus(text, error = false) {
    const status = document.getElementById('dialog-folder-manager-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function selectFolder(folder) {
    currentFolderId = folder.id;
    currentFolderShared = Boolean(folder.isShared);
    draft = { ...emptyFolder(), ...folder,
      includePeers: [...(folder.includePeers || [])].map(String),
      excludePeers: [...(folder.excludePeers || [])].map(String),
      pinnedPeers: [...(folder.pinnedPeers || [])].map(String),
    };
    candidates = new Map();
    renderManagerItems();
    populateEditor(Boolean(folder.isShared));
  }

  function newFolder() {
    currentFolderId = null;
    currentFolderShared = false;
    draft = emptyFolder();
    candidates = new Map();
    renderManagerItems();
    populateEditor(false);
  }

  function populateEditor(readOnly) {
    const modal = document.getElementById('modal-dialog-folder-manager');
    if (!modal || !draft) return;
    document.getElementById('dialog-folder-title').value = draft.title || '';
    document.getElementById('dialog-folder-emoticon').value = draft.emoticon || '';
    const color = document.getElementById('dialog-folder-color');
    if (color) {
      color.value = Number.isInteger(Number(draft.color)) ? String(((Number(draft.color) % 7) + 7) % 7) : '';
      color.dataset.originalColor = draft.color == null ? '' : String(draft.color);
      color.dataset.originalSelection = color.value;
      color.disabled = readOnly || tagState.account !== managerAccount || !tagState.premium;
    }
    const tagsToggle = document.getElementById('dialog-folder-tags-enabled');
    if (tagsToggle) {
      tagsToggle.checked = tagState.account === managerAccount && tagState.enabled;
      tagsToggle.disabled = tagState.account !== managerAccount || !tagState.premium;
    }
    modal.querySelectorAll('[data-folder-flag]').forEach((input) => { input.checked = Boolean(draft[input.dataset.folderFlag]); });
    const remove = document.getElementById('btn-delete-dialog-folder');
    if (remove) { remove.hidden = currentFolderId == null || (readOnly && !draft.isOwner); remove.disabled = readOnly && !draft.isOwner; }
    const save = document.getElementById('btn-save-dialog-folder');
    if (save) save.disabled = readOnly;
    modal.querySelector('#dialog-folder-title').disabled = readOnly;
    modal.querySelector('#dialog-folder-emoticon').disabled = readOnly;
    modal.querySelectorAll('[data-folder-flag]').forEach((input) => { input.disabled = readOnly; });
    const search = document.getElementById('dialog-folder-peer-search');
    if (search) { search.value = ''; search.disabled = readOnly; }
    const results = document.getElementById('dialog-folder-peer-results');
    if (results) results.textContent = readOnly ? '共享文件夹由发起分享的账号管理。' : '搜索会话后可单独包含、排除或置顶。';
    setManagerStatus(readOnly ? '共享文件夹为只读。' : '');
    renderSelectedPeers();
    void loadFolderInvites(managerAccount, currentFolderId);
  }

  function selectedPeerTitle(id) {
    const candidate = candidates.get(String(id));
    return candidate?.title || `会话 ${id}`;
  }

  function renderSelectedPeers() {
    const summary = document.getElementById('dialog-folder-peer-summary');
    const results = document.getElementById('dialog-folder-peer-results');
    if (summary && draft) summary.textContent = `包含 ${draft.includePeers.length} · 排除 ${draft.excludePeers.length} · 置顶 ${draft.pinnedPeers.length}`;
    if (!results || !draft) return;
    let selected = results.querySelector('.dialog-folder-selected');
    if (!selected) { selected = document.createElement('div'); selected.className = 'dialog-folder-selected'; results.prepend(selected); }
    selected.replaceChildren();
    const ids = [...new Set([...draft.includePeers, ...draft.excludePeers, ...draft.pinnedPeers])];
    for (const id of ids) {
      const chip = document.createElement('div'); chip.className = 'dialog-folder-peer-chip';
      const name = document.createElement('span'); name.textContent = selectedPeerTitle(id); chip.appendChild(name);
      for (const field of PEER_FIELDS) {
        if (!draft[field].includes(id)) continue;
        const label = document.createElement('small'); label.textContent = field === 'includePeers' ? '包含' : field === 'excludePeers' ? '排除' : '置顶'; chip.appendChild(label);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = `移除 ${label.textContent}`;
        remove.onclick = () => { draft[field] = draft[field].filter(value => value !== id); if (field === 'includePeers') draft.pinnedPeers = draft.pinnedPeers.filter(value => value !== id); renderSelectedPeers(); renderFolderCandidates(); };
        chip.appendChild(remove);
      }
      selected.appendChild(chip);
    }
    renderFolderCandidates();
  }

  function toggleFolderPeer(id, field, checked) {
    if (!draft) return;
    const values = new Set(draft[field]);
    if (checked) values.add(id); else values.delete(id);
    draft[field] = [...values];
    if (field === 'pinnedPeers' && checked && !draft.includePeers.includes(id)) draft.includePeers.push(id);
    if (field === 'includePeers' && !checked) draft.pinnedPeers = draft.pinnedPeers.filter(value => value !== id);
    renderSelectedPeers();
  }

  function renderFolderCandidates() {
    const results = document.getElementById('dialog-folder-peer-results');
    if (!results || !draft) return;
    const query = document.getElementById('dialog-folder-peer-search')?.value.trim();
    let container = results.querySelector('.dialog-folder-search-results');
    if (!container) { container = document.createElement('div'); container.className = 'dialog-folder-search-results'; results.appendChild(container); }
    container.replaceChildren();
    if (!query) return;
    const people = [...candidates.values()];
    if (!people.length) { container.textContent = '没有找到会话。'; return; }
    for (const peer of people) {
      const row = document.createElement('div'); row.className = 'dialog-folder-candidate';
      const title = document.createElement('span'); title.textContent = peer.title; row.appendChild(title);
      for (const [field, label] of [['includePeers', '包含'], ['excludePeers', '排除'], ['pinnedPeers', '置顶']]) {
        const wrapper = document.createElement('label'); wrapper.className = 'dialog-folder-candidate-option';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = draft[field].includes(String(peer.id));
        checkbox.setAttribute('aria-label', `${label} ${peer.title}`);
        checkbox.onchange = () => toggleFolderPeer(String(peer.id), field, checkbox.checked);
        wrapper.append(checkbox, document.createTextNode(label)); row.appendChild(wrapper);
      }
      container.appendChild(row);
    }
  }

  async function searchFolderPeers() {
    const query = document.getElementById('dialog-folder-peer-search')?.value.trim() || '';
    const results = document.getElementById('dialog-folder-peer-results');
    const instId = managerAccount;
    const request = ++folderSearchRequest;
    if (!query || !instId || !draft) { candidates.clear(); renderFolderCandidates(); return; }
    if (query.length > 128) return;
    if (results) setManagerStatus('正在搜索会话…');
    try {
      const peers = await api(`/api/instances/${encodeURIComponent(instId)}/account/search-dialogs?query=${encodeURIComponent(query)}`);
      if (request !== folderSearchRequest || state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      candidates = new Map((Array.isArray(peers) ? peers : []).flatMap(peer =>
        Number.isSafeInteger(Number(peer?.id)) && Number(peer.id) !== 0 && typeof peer.title === 'string'
          ? [[String(peer.id), peer]] : []));
      setManagerStatus(candidates.size ? '' : '没有找到会话。');
      renderFolderCandidates();
    } catch (error) {
      if (request === folderSearchRequest && state.clientSelectedInstance === instId) setManagerStatus(`搜索失败：${error.message}`, true);
    }
  }

  async function loadTagState(instId) {
    const request = ++tagStateVersion;
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-tags`);
      if (request !== tagStateVersion || state.clientSelectedInstance !== instId || account !== instId) return;
      tagState = { account: instId, enabled: result?.enabled === true, premium: result?.premium === true };
      const toggle = document.getElementById('dialog-folder-tags-enabled');
      if (toggle) { toggle.checked = tagState.enabled; toggle.disabled = !tagState.premium; }
      const color = document.getElementById('dialog-folder-color');
      if (color) color.disabled = currentFolderShared || !tagState.premium;
      renderClientDialogs();
    } catch (_) {
      if (request === tagStateVersion && state.clientSelectedInstance === instId) {
        tagState = { account: instId, enabled: false, premium: false };
        const toggle = document.getElementById('dialog-folder-tags-enabled');
        if (toggle) { toggle.checked = false; toggle.disabled = true; }
        const color = document.getElementById('dialog-folder-color');
        if (color) color.disabled = true;
      }
    }
  }

  async function changeTagState(event) {
    const toggle = event.currentTarget;
    const instId = managerAccount;
    if (!toggle || !instId || state.clientSelectedInstance !== instId || tagState.account !== instId) return;
    const previous = tagState.enabled;
    const enabled = toggle.checked === true;
    tagStateVersion++;
    toggle.disabled = true;
    setManagerStatus('正在更新 Telegram 文件夹标签设置…');
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-tags`, 'POST', { enabled });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      tagState = { ...tagState, enabled };
      toggle.checked = enabled;
      setManagerStatus(enabled ? '会话文件夹标签已开启。' : '会话文件夹标签已关闭。');
      renderClientDialogs();
    } catch (error) {
      if (state.clientSelectedInstance === instId && managerAccount === instId) {
        toggle.checked = previous;
        setManagerStatus(`Telegram 未能更新标签设置：${error.message}`, true);
      }
    } finally {
      if (state.clientSelectedInstance === instId && managerAccount === instId) toggle.disabled = false;
    }
  }

  async function moveFolder(index, delta) {
    const next = index + delta;
    if (!managerAccount || next < 0 || next >= folders.length) return;
    const order = folders.map(folder => folder.id);
    [order[index], order[next]] = [order[next], order[index]];
    const instId = managerAccount;
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folders/order`, 'POST', { folderIds: order });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      await load();
      renderManagerItems();
    } catch (error) { setManagerStatus(`调整顺序失败：${error.message}`, true); }
  }

  function openManager() {
    const instId = state.clientSelectedInstance;
    if (!instId) return showToast('请先选择 Telegram 账号', 'warn');
    managerAccount = instId;
    folderInvitePreview = null;
    const inviteUrl = document.getElementById('dialog-folder-invite-url');
    if (inviteUrl) inviteUrl.value = '';
    renderFolderInvitePreview('粘贴共享文件夹链接后预览。');
    void loadTagState(instId);
    const modal = document.getElementById('modal-dialog-folder-manager');
    modal?.classList.add('active');
    renderManagerItems();
    if (folders.length) selectFolder(folders[0]); else newFolder();
  }

  async function saveCurrentFolder() {
    const instId = managerAccount;
    if (!instId || state.clientSelectedInstance !== instId || !draft) return;
    const folder = { ...(currentFolderId == null ? {} : { id: currentFolderId }),
      title: document.getElementById('dialog-folder-title').value.trim(),
      emoticon: document.getElementById('dialog-folder-emoticon').value.trim() || undefined,
      ...Object.fromEntries(FLAG_FIELDS.map(field => [field, Boolean(document.querySelector(`[data-folder-flag="${field}"]`)?.checked)])),
      includePeers: [...draft.includePeers], excludePeers: [...draft.excludePeers], pinnedPeers: [...draft.pinnedPeers],
    };
    const color = document.getElementById('dialog-folder-color');
    if (color && color.value !== '') {
      const unchanged = color.value === color.dataset.originalSelection;
      folder.color = unchanged && color.dataset.originalColor !== ''
        ? Number(color.dataset.originalColor) : Number(color.value);
    }
    if (!folder.title) return setManagerStatus('请输入文件夹名称。', true);
    if (!['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'].some(field => folder[field]) && !folder.includePeers.length) {
      return setManagerStatus('至少选择一个自动包含类别或指定包含会话。', true);
    }
    if (folder.pinnedPeers.some(id => !folder.includePeers.includes(id))) return setManagerStatus('置顶会话也必须包含在文件夹中。', true);
    const save = document.getElementById('btn-save-dialog-folder');
    if (save) save.disabled = true;
    setManagerStatus('正在保存…');
    try {
      const saved = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folders`, 'POST', folder);
      if (state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      currentFolderId = Number(saved.id);
      await load();
      renderManagerItems();
      selectFolder(folders.find(item => item.id === currentFolderId) || saved);
      setManagerStatus('文件夹已保存。');
    } catch (error) { setManagerStatus(`保存失败：${error.message}`, true); }
    finally { if (save && managerAccount === instId && state.clientSelectedInstance === instId) save.disabled = false; }
  }

  async function deleteCurrentFolder() {
    const instId = managerAccount;
    if (!instId || state.clientSelectedInstance !== instId || currentFolderId == null) return;
    const folder = folders.find(item => item.id === currentFolderId);
    if (!folder || (folder.isShared && !folder.isOwner) ||
        !confirm(folder.isShared ? `删除你创建的共享文件夹“${folder.title}”？所有相关共享链接也会失效。` : `删除文件夹“${folder.title}”？`)) return;
    const button = document.getElementById('btn-delete-dialog-folder');
    if (button) button.disabled = true;
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folders`, 'DELETE', { id: currentFolderId });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      currentFolderId = null;
      await load();
      renderManagerItems();
      if (folders.length) selectFolder(folders[0]); else newFolder();
      setManagerStatus('文件夹已删除。');
    } catch (error) { setManagerStatus(`删除失败：${error.message}`, true); }
    finally { if (button && managerAccount === instId) button.disabled = false; }
  }

  function canShareFolder(folder) {
    if (!folder) return false;
    if (folder.isShared) return folder.isOwner === true;
    return !['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots', 'excludeMuted', 'excludeRead', 'excludeArchived']
      .some(field => folder[field]) && !(folder.excludePeers || []).length &&
      new Set([...(folder.includePeers || []), ...(folder.pinnedPeers || [])].map(String)).size > 0;
  }

  function renderFolderInviteList(message) {
    const list = document.getElementById('dialog-folder-invites-list');
    if (!list) return;
    list.replaceChildren();
    if (message) {
      const empty = document.createElement('div'); empty.className = 'dialog-folder-invites-empty'; empty.textContent = message;
      list.appendChild(empty); return;
    }
    if (!folderInvites.length) {
      const empty = document.createElement('div'); empty.className = 'dialog-folder-invites-empty'; empty.textContent = '还没有共享链接。';
      list.appendChild(empty); return;
    }
    for (const invite of folderInvites) {
      const row = document.createElement('div'); row.className = 'dialog-folder-invite';
      const title = document.createElement('strong'); title.className = 'dialog-folder-invite-title'; title.textContent = invite.title || '共享链接';
      const url = document.createElement('div'); url.className = 'dialog-folder-invite-url'; url.textContent = invite.url;
      const actions = document.createElement('div'); actions.className = 'dialog-folder-invite-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-secondary btn-xs'; copy.textContent = '复制链接';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(invite.url); showToast('共享链接已复制', 'success'); }
        catch (_) { showToast('浏览器未提供剪贴板权限，请手动复制链接', 'warn'); }
      };
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-secondary btn-xs'; edit.textContent = '改名';
      edit.onclick = () => { void editFolderInvite(invite); };
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger btn-xs'; remove.textContent = '删除';
      remove.onclick = () => { void deleteFolderInvite(invite); };
      actions.append(copy, edit, remove);
      row.append(title, url, actions); list.appendChild(row);
    }
  }

  function renderFolderSharePeers(message = '') {
    const list = document.getElementById('dialog-folder-share-peers');
    const status = document.getElementById('dialog-folder-share-status');
    const selectAll = document.getElementById('btn-select-dialog-folder-share-peers');
    const create = document.getElementById('btn-create-dialog-folder-invite');
    if (!list) return;
    list.replaceChildren();
    if (status) status.textContent = message;
    if (!folderSharePeers.length || message) {
      if (selectAll) selectAll.hidden = true;
      if (create) create.disabled = true;
      return;
    }
    for (const peer of folderSharePeers) {
      const row = document.createElement('label'); row.className = 'dialog-folder-invite-peer';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = folderShareSelection.has(peer.id); checkbox.dataset.peerId = peer.id;
      checkbox.setAttribute('aria-label', `分享到 ${peer.title}`);
      checkbox.onchange = () => {
        if (checkbox.checked) folderShareSelection.add(peer.id); else folderShareSelection.delete(peer.id);
        updateFolderShareSelection();
      };
      const title = document.createElement('span'); title.className = 'dialog-folder-invite-peer-title'; title.textContent = peer.title;
      const type = document.createElement('span'); type.className = 'dialog-folder-invite-peer-type'; type.textContent = peer.type === 'channel' ? '频道' : '群组';
      row.append(checkbox, title, type); list.appendChild(row);
    }
    if (selectAll) selectAll.hidden = folderSharePeers.length < 2;
    updateFolderShareSelection();
  }

  function updateFolderShareSelection() {
    const list = document.getElementById('dialog-folder-share-peers');
    const selectAll = document.getElementById('btn-select-dialog-folder-share-peers');
    const create = document.getElementById('btn-create-dialog-folder-invite');
    if (!list) return;
    const checkboxes = [...list.querySelectorAll('input[type="checkbox"][data-peer-id]')];
    const selected = checkboxes.filter(input => input.checked).length;
    if (create) {
      create.disabled = selected === 0;
      create.textContent = selected ? `创建链接（${selected}）` : '创建链接';
    }
    if (selectAll) selectAll.textContent = checkboxes.some(input => !input.checked) ? '全选' : '取消全选';
  }

  function toggleFolderSharePeerSelection() {
    const select = [...folderShareSelection].length !== folderSharePeers.length;
    folderShareSelection = new Set(select ? folderSharePeers.map(peer => peer.id) : []);
    renderFolderSharePeers();
  }

  async function loadFolderInvites(instId, folderId) {
    const request = ++inviteRequest;
    const button = document.getElementById('btn-create-dialog-folder-invite');
    const folder = folders.find(item => item.id === folderId);
    folderInvites = [];
    folderSharePeers = [];
    folderShareSelection = new Set();
    if (button) button.disabled = !canShareFolder(folder);
    if (!folder) { renderFolderSharePeers('保存文件夹后可创建共享链接。'); renderFolderInviteList(''); return; }
    if (!canShareFolder(folder)) {
      renderFolderSharePeers(folder.isShared ? '此共享文件夹由其他账号管理。' : '分享前请移除类别和排除规则，并至少指定一个群组或频道。');
      renderFolderInviteList(''); return;
    }
    renderFolderSharePeers('正在读取 Telegram 中可分享的会话…');
    renderFolderInviteList(folder.isShared ? '正在读取共享链接…' : '创建链接后，此文件夹将转换为共享文件夹。');
    if (button) button.disabled = true;
    try {
      const results = await Promise.all([
        api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-share-peers?folderId=${folderId}`),
        folder.isShared
          ? api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites?folderId=${folderId}`)
          : Promise.resolve([]),
      ]);
      if (request !== inviteRequest || managerAccount !== instId || state.clientSelectedInstance !== instId || currentFolderId !== folderId) return;
      folderSharePeers = (Array.isArray(results[0]) ? results[0] : []).filter(peer =>
        peer && typeof peer.id === 'string' && /^-?\d{1,20}$/.test(peer.id) && typeof peer.title === 'string' &&
        (peer.type === 'group' || peer.type === 'channel'));
      folderShareSelection = new Set(folderSharePeers.map(peer => peer.id));
      folderInvites = Array.isArray(results[1]) ? results[1] : [];
      if (button) button.disabled = false;
      renderFolderSharePeers(folderSharePeers.length ? '' : 'Telegram 未返回可分享的群组或频道。');
      renderFolderInviteList(folder.isShared ? undefined : '创建链接后，此文件夹将转换为共享文件夹。');
    } catch (error) {
      if (request === inviteRequest && managerAccount === instId && currentFolderId === folderId) {
        if (button) button.disabled = true;
        renderFolderSharePeers(`读取可分享会话失败：${error.message}`);
        renderFolderInviteList(folder.isShared ? '读取链接失败。' : '');
      }
    }
  }

  async function createFolderInvite() {
    const instId = managerAccount, folderId = currentFolderId;
    const folder = folders.find(item => item.id === folderId);
    if (!instId || !folder || !canShareFolder(folder) || state.clientSelectedInstance !== instId) return;
    const peerIds = [...folderShareSelection];
    if (!peerIds.length) return setManagerStatus('至少选择一个要分享的群组或频道。', true);
    const button = document.getElementById('btn-create-dialog-folder-invite');
    if (button) button.disabled = true;
    setManagerStatus('正在向 Telegram 创建共享链接…');
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites`, 'POST', {
        folderId, title: folder.title, peerIds,
      });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId || currentFolderId !== folderId) return;
      await load();
      const updated = folders.find(item => item.id === folderId);
      if (updated) selectFolder(updated);
      setManagerStatus('共享链接已创建并由 Telegram 保存。');
    } catch (error) {
      if (state.clientSelectedInstance === instId && managerAccount === instId) setManagerStatus(`创建共享链接失败：${error.message}`, true);
    } finally {
      if (state.clientSelectedInstance === instId && managerAccount === instId && button) button.disabled = false;
    }
  }

  async function editFolderInvite(invite) {
    const instId = managerAccount, folderId = currentFolderId;
    if (!instId || !folderId || state.clientSelectedInstance !== instId) return;
    const title = prompt('共享链接名称', invite.title || '');
    if (title === null) return;
    try {
      const updated = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites/edit`, 'POST', {
        folderId, url: invite.url, title, peerIds: invite.peerIds,
      });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId || currentFolderId !== folderId) return;
      folderInvites = folderInvites.map(item => item.url === invite.url ? updated : item);
      renderFolderInviteList();
      setManagerStatus('共享链接已更新。');
    } catch (error) { if (state.clientSelectedInstance === instId && managerAccount === instId) setManagerStatus(`更新共享链接失败：${error.message}`, true); }
  }

  async function deleteFolderInvite(invite) {
    const instId = managerAccount, folderId = currentFolderId;
    if (!instId || !folderId || state.clientSelectedInstance !== instId || !confirm('删除此 Telegram 共享链接？')) return;
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites`, 'DELETE', { folderId, url: invite.url });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId || currentFolderId !== folderId) return;
      folderInvites = folderInvites.filter(item => item.url !== invite.url);
      renderFolderInviteList();
      setManagerStatus('共享链接已删除。');
    } catch (error) { if (state.clientSelectedInstance === instId && managerAccount === instId) setManagerStatus(`删除共享链接失败：${error.message}`, true); }
  }

  function renderFolderInvitePreview(message = '') {
    const preview = document.getElementById('dialog-folder-invite-preview');
    const list = document.getElementById('dialog-folder-invite-peers');
    const join = document.getElementById('btn-join-dialog-folder-invite');
    const selectAll = document.getElementById('btn-select-dialog-folder-invite-peers');
    if (preview) preview.textContent = message;
    if (list) list.replaceChildren();
    if (join) join.disabled = true;
    if (selectAll) selectAll.hidden = true;
    if (!folderInvitePreview || !list) return;
    const peers = Array.isArray(folderInvitePreview.peers) ? folderInvitePreview.peers : [];
    const title = document.createElement('strong');
    title.textContent = folderInvitePreview.title || '共享文件夹';
    if (preview) {
      preview.replaceChildren(title, document.createTextNode(folderInvitePreview.alreadyImported
        ? ' · 此链接已加入，可补充尚未加入的会话。' : ' · 选择要加入的会话。'));
    }
    let selectableCount = 0;
    for (const peer of peers) {
      if (!peer || typeof peer.id !== 'string' || !/^-?\d{1,20}$/.test(peer.id) || typeof peer.title !== 'string') continue;
      const row = document.createElement('label'); row.className = 'dialog-folder-invite-peer';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.disabled = peer.alreadyJoined === true;
      checkbox.dataset.peerId = peer.id;
      checkbox.setAttribute('aria-label', `加入 ${peer.title}`);
      if (!checkbox.disabled) selectableCount++;
      const name = document.createElement('span'); name.className = 'dialog-folder-invite-peer-title'; name.textContent = peer.title;
      const type = document.createElement('span'); type.className = 'dialog-folder-invite-peer-type';
      type.textContent = peer.alreadyJoined ? '已加入' : peer.type === 'channel' ? '频道' : peer.type === 'group' ? '群组' : '私聊';
      checkbox.onchange = () => updateFolderInviteSelection();
      row.append(checkbox, name, type); list.appendChild(row);
    }
    if (selectAll) {
      selectAll.hidden = selectableCount === 0;
      selectAll.textContent = '取消全选';
    }
    if (!peers.length && preview) preview.append(document.createTextNode(' · 链接中没有可加入的会话。'));
    updateFolderInviteSelection();
  }

  function updateFolderInviteSelection() {
    const list = document.getElementById('dialog-folder-invite-peers');
    const join = document.getElementById('btn-join-dialog-folder-invite');
    const selectAll = document.getElementById('btn-select-dialog-folder-invite-peers');
    if (!list || !join) return;
    const checkboxes = [...list.querySelectorAll('input[type="checkbox"][data-peer-id]')];
    const selected = checkboxes.filter(input => input.checked).length;
    const newSelected = checkboxes.filter(input => input.checked && !input.disabled).length;
    join.disabled = selected === 0 || newSelected === 0;
    if (selectAll) {
      selectAll.hidden = checkboxes.every(input => input.disabled);
      selectAll.textContent = checkboxes.some(input => !input.disabled && !input.checked) ? '全选' : '取消全选';
    }
    if (folderInvitePreview) {
      const title = folderInvitePreview.title || '共享文件夹';
      const prior = folderInvitePreview.alreadyImported ? '此链接已加入' : '';
      const selectedText = folderInvitePreview.alreadyImported
        ? `已选 ${selected - newSelected} 个已加入、${newSelected} 个待加入会话`
        : `已选 ${selected} 个会话`;
      const preview = document.getElementById('dialog-folder-invite-preview');
      if (preview) {
        preview.textContent = `${title}${prior ? ` · ${prior}` : ''} · ${selectedText}`;
        preview.setAttribute('aria-label', `${title}。${prior}。${selectedText}`);
      }
    }
  }

  async function previewFolderInvite() {
    const instId = managerAccount;
    const input = document.getElementById('dialog-folder-invite-url');
    const url = input?.value.trim();
    if (!instId || !url || state.clientSelectedInstance !== instId) return;
    const request = ++invitePreviewRequest;
    folderInvitePreview = null;
    renderFolderInvitePreview('正在向 Telegram 检查共享链接…');
    try {
      const result = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites/check`, 'POST', { url });
      if (request !== invitePreviewRequest || managerAccount !== instId || state.clientSelectedInstance !== instId) return;
      if (!result || !Array.isArray(result.peers) || typeof result.alreadyImported !== 'boolean') throw new Error('Telegram 返回了无效的共享文件夹信息');
      folderInvitePreview = { ...result, url };
      renderFolderInvitePreview();
      setManagerStatus('共享文件夹预览已从 Telegram 加载。');
    } catch (error) {
      if (request === invitePreviewRequest && managerAccount === instId && state.clientSelectedInstance === instId) {
        renderFolderInvitePreview(`无法读取共享链接：${error.message}`);
      }
    }
  }

  function toggleInvitePeerSelection() {
    const list = document.getElementById('dialog-folder-invite-peers');
    if (!list) return;
    const checkboxes = [...list.querySelectorAll('input[type="checkbox"][data-peer-id]:not(:disabled)')];
    const select = checkboxes.some(input => !input.checked);
    for (const input of checkboxes) input.checked = select;
    updateFolderInviteSelection();
  }

  async function joinFolderInvite() {
    const instId = managerAccount;
    const preview = folderInvitePreview;
    const list = document.getElementById('dialog-folder-invite-peers');
    const button = document.getElementById('btn-join-dialog-folder-invite');
    if (!instId || !preview || !list || !button || state.clientSelectedInstance !== instId) return;
    const peerIds = [...list.querySelectorAll('input[type="checkbox"][data-peer-id]:checked')].map(input => input.dataset.peerId);
    if (!peerIds.length || !peerIds.some(id => !preview.peers.find(peer => peer.id === id)?.alreadyJoined)) return;
    button.disabled = true;
    setManagerStatus('正在通过 Telegram 加入共享文件夹…');
    try {
      await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folder-invites/join`, 'POST', {
        url: preview.url, peerIds,
      });
      if (state.clientSelectedInstance !== instId || managerAccount !== instId) return;
      await load();
      renderManagerItems();
      await previewFolderInvite();
      setManagerStatus('共享文件夹已加入 Telegram 会话列表。');
    } catch (error) {
      if (state.clientSelectedInstance === instId && managerAccount === instId) setManagerStatus(`加入共享文件夹失败：${error.message}`, true);
    } finally {
      if (state.clientSelectedInstance === instId && managerAccount === instId) updateFolderInviteSelection();
    }
  }

  document.getElementById?.('btn-manage-dialog-folders')?.addEventListener('click', openManager);
  document.getElementById?.('btn-close-dialog-folder-manager')?.addEventListener('click', closeManager);
  document.getElementById?.('btn-cancel-dialog-folder-manager')?.addEventListener('click', closeManager);
  document.getElementById?.('btn-new-dialog-folder')?.addEventListener('click', newFolder);
  document.getElementById?.('btn-save-dialog-folder')?.addEventListener('click', () => { void saveCurrentFolder(); });
  document.getElementById?.('btn-delete-dialog-folder')?.addEventListener('click', () => { void deleteCurrentFolder(); });
  document.getElementById?.('btn-create-dialog-folder-invite')?.addEventListener('click', () => { void createFolderInvite(); });
  document.getElementById?.('btn-select-dialog-folder-share-peers')?.addEventListener('click', toggleFolderSharePeerSelection);
  document.getElementById?.('btn-preview-dialog-folder-invite')?.addEventListener('click', () => { void previewFolderInvite(); });
  document.getElementById?.('btn-select-dialog-folder-invite-peers')?.addEventListener('click', toggleInvitePeerSelection);
  document.getElementById?.('btn-join-dialog-folder-invite')?.addEventListener('click', () => { void joinFolderInvite(); });
  document.getElementById?.('dialog-folder-invite-url')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void previewFolderInvite(); }
  });
  document.getElementById?.('dialog-folder-peer-search')?.addEventListener('input', () => {
    if (folderSearchTimer) clearTimeout(folderSearchTimer);
    folderSearchTimer = setTimeout(() => { folderSearchTimer = undefined; void searchFolderPeers(); }, 250);
  });
  document.getElementById?.('dialog-folder-tags-enabled')?.addEventListener('change', event => { void changeTagState(event); });
  document.getElementById?.('modal-dialog-folder-manager')?.addEventListener('click', event => {
    if (event.target.id === 'modal-dialog-folder-manager') closeManager();
  });

  function matches(folder, dialog) {
    const peer = String(dialog.id);
    if (folder.excludePeers.includes(peer)) return false;
    if (folder.pinnedPeers.includes(peer) || folder.includePeers.includes(peer)) return true;
    if ((folder.excludeMuted && dialog.muted) ||
        (folder.excludeRead && !(Number(dialog.unreadCount) > 0)) ||
        (folder.excludeArchived && dialog.archived)) return false;
    if (dialog.isBot) return folder.bots;
    if (dialog.type === 'private') {
      return dialog.isContact === true ? folder.contacts :
        dialog.isContact === false ? folder.nonContacts : false;
    }
    if (dialog.type === 'group' || dialog.type === 'supergroup') return folder.groups;
    return dialog.type === 'channel' && folder.broadcasts;
  }

  function apply(filter, dialogs) {
    if (!filter.startsWith('folder:') || account !== state.clientSelectedInstance) return [];
    const folder = folders.find((item) => String(item.id) === filter.slice(7));
    if (!folder) return [];
    const result = dialogs.filter((d) => matches(folder, d));
    // Pinned order is specific to each folder, independent of global pinning.
    const pinned = new Map(folder.pinnedPeers.map((id, index) => [id, index]));
    return result.sort((a, b) => {
      const aPin = pinned.get(String(a.id));
      const bPin = pinned.get(String(b.id));
      if (aPin !== undefined || bPin !== undefined) return (aPin ?? Infinity) - (bPin ?? Infinity);
      // Main and archived pages are fetched separately. Merge their visible
      // conversations by latest-message time once the folder rules are applied.
      return (Number(b.lastMessageDate) || 0) - (Number(a.lastMessageDate) || 0);
    });
  }

  function getExplicitPeerIds(filter) {
    if (!filter.startsWith('folder:') || account !== state.clientSelectedInstance) return [];
    const folder = folders.find((item) => String(item.id) === filter.slice(7));
    if (!folder) return [];
    const excluded = new Set(folder.excludePeers.map(String));
    return [...new Set([...folder.pinnedPeers, ...folder.includePeers].map(Number))]
      .filter((id) => Number.isSafeInteger(id) && id !== 0 && !excluded.has(String(id))).slice(0, 100);
  }

  function getTags(dialog, filter = state.clientDialogFilter) {
    if (!dialog || tagState.account !== state.clientSelectedInstance || !tagState.enabled || !tagState.premium) return [];
    const currentFolder = String(filter || '').startsWith('folder:') ? String(filter).slice(7) : null;
    return folders.filter(folder => folder.color != null && String(folder.id) !== currentFolder && matches(folder, dialog))
      .map(folder => ({ id: folder.id, title: folder.title, color: ((Number(folder.color) % 7) + 7) % 7 }));
  }

  function renderTabs() {
    const tabs = document.querySelector('.dialogs-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('[data-folder-id]').forEach((tab) => tab.remove());
    for (const folder of folders) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dialog-tab';
      button.dataset.folderId = String(folder.id);
      button.dataset.type = `folder:${folder.id}`;
      if (Number.isInteger(Number(folder.color))) button.dataset.folderColor = String(((Number(folder.color) % 7) + 7) % 7);
      button.textContent = folder.title;
      button.classList.toggle('active', state.clientDialogFilter === button.dataset.type);
      button.addEventListener('click', () => {
        tabs.querySelectorAll('.dialog-tab').forEach((tab) => tab.classList.remove('active'));
        button.classList.add('active');
        state.clientDialogFilter = button.dataset.type;
        state.clientDialogs = [];
        loadClientDialogs();
      });
      tabs.appendChild(button);
    }
  }

  async function load() {
    const instId = state.clientSelectedInstance;
    const request = ++version;
    if (account !== instId) {
      if (managerAccount && managerAccount !== instId) closeManager();
      account = instId;
      folders = [];
      tagState = { account: null, enabled: false, premium: false };
      if (String(state.clientDialogFilter).startsWith('folder:')) state.clientDialogFilter = 'all';
      renderTabs();
      document.querySelector('.dialog-tab[data-type="all"]')?.classList.toggle('active', state.clientDialogFilter === 'all');
    }
    if (!instId) return;
    if (tagState.account !== instId && document.getElementById?.('dialog-folder-tags-enabled')) void loadTagState(instId);
    const inst = state.instances.find((item) => item.config.id === instId);
    if (!inst || inst.status !== 'ONLINE') return;
    try {
      let result;
      if (window.chatWs && window.chatWs.isConnected()) {
        try { result = await window.chatWs.sendRpc('get_dialog_folders', { instId }); } catch (_) {}
      }
      if (!result) result = await api(`/api/instances/${encodeURIComponent(instId)}/account/dialog-folders`);
      if (request !== version || state.clientSelectedInstance !== instId) return;
      folders = Array.isArray(result) ? result : [];
      if (String(state.clientDialogFilter).startsWith('folder:') &&
          !folders.some((folder) => `folder:${folder.id}` === state.clientDialogFilter)) {
        state.clientDialogFilter = 'all';
        document.querySelector('.dialog-tab[data-type="all"]')?.classList.add('active');
        state.clientDialogs = [];
        renderTabs();
        loadClientDialogs();
        return;
      }
      renderTabs();
      renderClientDialogs();
    } catch (_) {
      if (request !== version || state.clientSelectedInstance !== instId) return;
      // Preserve a previously loaded folder list on temporary network failure.
    }
  }

  return { load, apply, matches, getExplicitPeerIds, getTags, openManager };
})();

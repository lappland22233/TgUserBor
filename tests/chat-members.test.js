'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('state.groupMembers = [];');
const end = source.indexOf('// ==========================================\n// Jump to Date Calendar Controller', start);
if (start < 0 || end < 0) throw new Error('Cannot locate group member controller');
class Element {
  constructor(tagName = 'DIV') { this.tagName = tagName; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  focus() {}
}
function setup() {
  const state = { clientSelectedInstance: 'a', clientActiveChatId: '1', chatSelectionVersion: 1, clientDialogs: [] };
  const requests = [], toasts = [];
  const container = {innerHTML: ''};
  const elements = new Map([
    ['members-list-container', container], ['member-search-input', { value: '' }], ['group-invite-search', { value: '', focus() {} }],
    ['modal-add-group-members', { style: {}, addEventListener() {} }], ['group-invite-list', new Element()],
    ['group-invite-status', { textContent: '' }], ['btn-add-selected-group-members', { disabled: true, textContent: '' }],
    ['btn-add-group-members', { hidden: false }], ['btn-view-banned-members', { hidden: false }], ['btn-view-invite-links', { hidden: false }],
    ['modal-group-member-mute', { style: {}, addEventListener() {} }], ['group-member-mute-target', { textContent: '' }],
    ['group-member-mute-duration', { value: '3600' }], ['group-member-mute-status', { textContent: '' }],
    ['btn-save-group-member-mute', { disabled: false }],
  ]);
  const search = { value: '' };
  elements.set('member-search-input', search);
  const context = vm.createContext({ state, window: {}, URLSearchParams, document: {getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag)},
    api: (url, method, body) => new Promise((resolve, reject) => requests.push({url, method, body, resolve, reject})),
    escapeHtml: String, inlineJsArg: JSON.stringify, showToast: message => toasts.push(message), confirm: () => true,
    selectClientChat() {} });
  vm.runInContext(source.slice(start,end) + '\nthis.loadGroupMembers = loadGroupMembers; this.loadMoreGroupMembers = loadMoreGroupMembers; this.openGroupInviteModal = openGroupInviteModal; this.searchGroupInviteCandidates = searchGroupInviteCandidates; this.inviteSelectedGroupMembers = inviteSelectedGroupMembers; this.openGroupMuteModal = openGroupMuteModal; this.openGroupBanModal = openGroupBanModal; this.saveGroupMute = saveGroupMute; this.kickGroupMember = kickGroupMember; this.muteGroupMember = muteGroupMember; this.invalidateGroupMembers = invalidateGroupMembers;', context);
  return { state, requests, context, toasts, container, search, elements };
}
const person = id => ({user:{id,firstName:`User${id}`},role:'member',supportsCustomAdminRights:true});
test('late old chat and account responses cannot replace the current member list', async () => {
  const h = setup();
  const a = h.context.loadGroupMembers(1);
  h.state.clientSelectedInstance = 'b'; h.state.clientActiveChatId = '2'; h.state.chatSelectionVersion++;
  const b = h.context.loadGroupMembers(2);
  h.requests[1].resolve([person(20)]); await b;
  h.requests[0].resolve([person(10)]); await a;
  assert.equal(h.state.groupMembers[0].user.id, 20);
  assert.match(h.container.innerHTML, /User20/);
});
test('stale member controls cannot kick or mute a member in another group', async () => {
  const h = setup(); const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve([person(10)]); await load;
  assert.match(h.container.innerHTML, /loadPeerProfile\(10\)/);
  h.state.clientActiveChatId = '2'; h.state.chatSelectionVersion++;
  await h.context.kickGroupMember(10, 'User10');
  await h.context.muteGroupMember(10, 'User10');
  assert.equal(h.requests.length, 1);
  assert.match(h.toasts.at(-1), /已过期/);
});
test('successful kick finishing after account switch does not reload old members under the new account', async () => {
  const h = setup(); const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canBanUsers: true } }); await load;
  const kick = h.context.kickGroupMember(10, 'User10');
  assert.equal(h.requests[1].body.chatId, 1);
  h.state.clientSelectedInstance = 'b'; h.state.chatSelectionVersion++;
  h.requests[1].resolve({}); await kick;
  assert.equal(h.requests.length, 2);
});
test('invalidating the view clears visible members and prevents old requests restoring them', async () => {
  const h = setup();
  const first = h.context.loadGroupMembers(1);
  h.requests[0].resolve([person(10)]); await first;
  assert.match(h.container.innerHTML, /User10/);
  const pending = h.context.loadGroupMembers(1);
  h.context.invalidateGroupMembers();
  assert.equal(h.state.groupMembers.length, 0);
  assert.match(h.container.innerHTML, /请先加载当前群成员/);
  h.requests[1].resolve([person(99)]); await pending;
  assert.equal(h.state.groupMembers.length, 0);
  assert.doesNotMatch(h.container.innerHTML, /User99/);
});

test('member list requests server-side search and appends account-bound pages', async () => {
  const h = setup();
  h.search.value = 'ada';
  const first = h.context.loadGroupMembers(1);
  assert.match(h.requests[0].url, /offset=0&limit=50&query=ada/);
  h.requests[0].resolve({ count: 60, participants: [person(10)], nextOffset: 1 });
  await first;
  assert.equal(h.state.groupMembers.length, 1);
  const more = h.context.loadMoreGroupMembers();
  assert.match(h.requests[1].url, /offset=1&limit=50&query=ada/);
  h.requests[1].resolve({ count: 60, participants: [person(11)], nextOffset: 2 });
  await more;
  assert.equal(JSON.stringify([...h.state.groupMembers].map(item => item.user.id)), '[10,11]');
  assert.match(h.container.innerHTML, /匹配 60 位/);
});

test('a late member search cannot restore results after the user changes chats', async () => {
  const h = setup();
  h.search.value = 'alice';
  const search = h.context.loadGroupMembers(1);
  h.state.clientActiveChatId = '2'; h.state.chatSelectionVersion++;
  h.requests[0].resolve({ count: 1, participants: [person(99)] });
  await search;
  assert.equal(h.state.groupMembers.length, 0);
  assert.doesNotMatch(h.container.innerHTML, /User99/);
});

test('group member invitations search Telegram users and invite only selected users to the current chat', async () => {
  const h = setup();
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canInviteUsers: true } });
  await load;
  h.context.openGroupInviteModal();
  assert.equal(h.elements.get('modal-add-group-members').style.display, 'flex');
  const search = h.context.searchGroupInviteCandidates('new');
  assert.match(h.requests[1].url, /search-dialogs\?query=new/);
  h.requests[1].resolve([{ id: 20, type: 'private', title: 'New User', username: 'new_user' }]);
  await search;
  const candidate = h.elements.get('group-invite-list').children[0];
  const checkbox = candidate.children[0];
  checkbox.checked = true;
  checkbox.onchange();
  assert.equal(h.elements.get('btn-add-selected-group-members').disabled, false);
  const invite = h.context.inviteSelectedGroupMembers();
  assert.equal(h.requests[2].url, '/api/instances/a/account/invite-user');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[2].body)), { chatId: 1, userId: 20 });
  h.requests[2].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  h.requests[3].resolve({ count: 2, participants: [person(10), person(20)] });
  await invite;
  assert.deepEqual([...h.state.groupMembers].map(member => member.user.id), [10, 20]);
  assert.match(h.toasts[0], /已邀请 1 位成员/);
});

test('late Telegram user search results are discarded after the group invite target changes', async () => {
  const h = setup();
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canInviteUsers: true } });
  await load;
  h.context.openGroupInviteModal();
  const search = h.context.searchGroupInviteCandidates('new');
  h.state.clientActiveChatId = '2'; h.state.chatSelectionVersion++;
  h.context.invalidateGroupMembers();
  h.requests[1].resolve([{ id: 20, type: 'private', title: 'New User' }]);
  await search;
  assert.equal(h.elements.get('group-invite-list').children.length, 0);
  assert.equal(h.elements.get('modal-add-group-members').style.display, 'none');
});

test('member mute duration is selected in an account-bound modal and saved to the current group', async () => {
  const h = setup();
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canBanUsers: true } });
  await load;
  h.context.openGroupMuteModal(10, 'User10');
  assert.equal(h.elements.get('modal-group-member-mute').style.display, 'flex');
  h.elements.get('group-member-mute-duration').value = '86400';
  const save = h.context.saveGroupMute({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].body)), { chatId: 1, userId: 10, seconds: 86400 });
  h.requests[1].resolve({ success: true });
  await save;
  assert.equal(h.elements.get('modal-group-member-mute').style.display, 'none');
  assert.match(h.toasts.at(-1), /限制发言 1 天/);
});

test('a stale member mute modal cannot target a group after chat selection changes', async () => {
  const h = setup();
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canBanUsers: true } });
  await load;
  h.context.openGroupMuteModal(10, 'User10');
  h.state.clientActiveChatId = '2'; h.state.chatSelectionVersion++;
  await h.context.saveGroupMute({ preventDefault() {} });
  assert.equal(h.requests.length, 1);
  assert.equal(h.elements.get('modal-group-member-mute').style.display, 'none');
});

test('member ban confirms the selected duration, targets the current group and reloads members', async () => {
  const h = setup();
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)], selfPermissions: { canBanUsers: true } });
  await load;
  h.context.openGroupBanModal(10, 'User10');
  h.elements.get('group-member-mute-duration').value = '604800';
  const save = h.context.saveGroupMute({ preventDefault() {} });
  assert.equal(h.requests[1].url, '/api/instances/a/account/ban');
  const payload = JSON.parse(JSON.stringify(h.requests[1].body));
  assert.equal(payload.chatId, 1);
  assert.equal(payload.userId, 10);
  assert.ok(payload.untilDate > Math.floor(Date.now() / 1000));
  assert.ok(payload.untilDate <= Math.floor(Date.now() / 1000) + 604802);
  h.requests[1].resolve({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  h.requests[2].resolve({ count: 0, participants: [] });
  await save;
  assert.equal(h.state.groupMembers.length, 0);
  assert.match(h.toasts.at(-1), /已封禁/);
});

test('member management menu only includes operations granted to the current account', async () => {
  const h = setup();
  let load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [person(10)] });
  await load;
  assert.doesNotMatch(h.container.innerHTML, /manageGroupAdmin|openGroupMuteModal|openGroupBanModal|kickGroupMember/);
  assert.equal(h.elements.get('btn-add-group-members').hidden, true);
  assert.equal(h.elements.get('btn-view-banned-members').hidden, true);
  assert.equal(h.elements.get('btn-view-invite-links').hidden, true);

  load = h.context.loadGroupMembers(1);
  h.requests[1].resolve({ count: 1, participants: [person(10)], selfPermissions: {
    canAddAdmins: true, canBanUsers: true, canInviteUsers: true,
  } });
  await load;
  assert.match(h.container.innerHTML, /manageGroupAdmin\(10/);
  assert.match(h.container.innerHTML, /openGroupMuteModal\(10/);
  assert.match(h.container.innerHTML, /openGroupBanModal\(10/);
  assert.match(h.container.innerHTML, /kickGroupMember\(10/);
  assert.equal(h.elements.get('btn-add-group-members').hidden, false);
  assert.equal(h.elements.get('btn-view-banned-members').hidden, false);
  assert.equal(h.elements.get('btn-view-invite-links').hidden, false);
});

test('a non-creator with ban rights does not get moderation actions for another admin', async () => {
  const h = setup();
  const admin = { ...person(10), role: 'admin' };
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [admin], selfPermissions: { canBanUsers: true } });
  await load;
  assert.doesNotMatch(h.container.innerHTML, /openGroupMuteModal|openGroupBanModal|kickGroupMember/);
});

test('a restricted member still in the group remains a moderation target', async () => {
  const h = setup();
  const restricted = { ...person(10), role: 'banned', isLeft: false };
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [restricted], selfPermissions: {
    isCreator: true, canBanUsers: true,
  } });
  await load;
  assert.match(h.container.innerHTML, /openGroupMuteModal\(10/);
  assert.match(h.container.innerHTML, /openGroupBanModal\(10/);
  assert.match(h.container.innerHTML, /kickGroupMember\(10/);
  h.context.openGroupMuteModal(10, 'User10');
  assert.equal(h.elements.get('modal-group-member-mute').style.display, 'flex');
});

test('a member who left is not shown moderation actions even if their participant class is banned', async () => {
  const h = setup();
  const left = { ...person(10), role: 'banned', isLeft: true };
  const load = h.context.loadGroupMembers(1);
  h.requests[0].resolve({ count: 1, participants: [left], selfPermissions: { isCreator: true, canBanUsers: true } });
  await load;
  assert.doesNotMatch(h.container.innerHTML, /openGroupMuteModal|openGroupBanModal|kickGroupMember/);
});

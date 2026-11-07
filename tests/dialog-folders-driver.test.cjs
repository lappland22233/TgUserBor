'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');

test('Telegram folder TL objects retain filter rules and marked peer identifiers', async () => {
  const user = new Api.InputPeerUser({ userId: bigInt(12), accessHash: bigInt(1) });
  const chat = new Api.InputPeerChat({ chatId: bigInt(34) });
  const channel = new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(2) });
  const title = (text) => new Api.TextWithEntities({ text, entities: [] });
  const response = new Api.messages.DialogFilters({ filters: [
    new Api.DialogFilterDefault(),
    new Api.DialogFilter({ id: 1, title: title('工作'), contacts: true, groups: true, excludeMuted: true,
      pinnedPeers: [channel], includePeers: [user, new Api.InputPeerSelf()], excludePeers: [chat] }),
    new Api.DialogFilterChatlist({ id: 2, title: title('共享'), hasMyInvites: true, pinnedPeers: [], includePeers: [channel] }),
  ] });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 99;
  let called;
  driver.client = { invoke: async (request) => { called = request; return response; } };
  const folders = await driver.getDialogFolders();
  assert.ok(called instanceof Api.messages.GetDialogFilters);
  assert.equal(folders.length, 2);
  assert.equal(folders[0].title, '工作');
  assert.deepEqual(folders[0].pinnedPeers, ['-10056']);
  assert.deepEqual(folders[0].includePeers, ['12', '99']);
  assert.deepEqual(folders[0].excludePeers, ['-34']);
  assert.equal(folders[0].contacts, true);
  assert.equal(folders[0].groups, true);
  assert.equal(folders[0].excludeMuted, true);
  assert.equal(folders[0].isShared, false);
  assert.deepEqual(folders[1].includePeers, ['-10056']);
  assert.deepEqual(folders[1].excludePeers, []);
  assert.equal(folders[1].isShared, true);
  assert.equal(folders[1].isOwner, true);
});

test('Telegram folder create and edit preserve filter flags and resolve peer references', async () => {
  const title = text => new Api.TextWithEntities({ text, entities: [] });
  const existing = new Api.DialogFilter({ id: 1, title: title('旧名称'), pinnedPeers: [], includePeers: [], excludePeers: [] });
  const filters = [new Api.DialogFilterDefault(), existing];
  const calls = [], inputIds = [];
  const user = new Api.InputPeerUser({ userId: bigInt(12), accessHash: bigInt(99) });
  const channel = new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(98) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 99;
  driver.resolvePeer = id => id === '99' ? 'me' : BigInt(id);
  driver.client = {
    getInputEntity: async peer => { inputIds.push(String(peer)); return String(peer) === '12' ? user : String(peer) === '-10056' ? channel : new Api.InputPeerSelf(); },
    invoke: async request => {
      calls.push(request);
      if (request.className === 'messages.GetDialogFilters') return new Api.messages.DialogFilters({ filters: [...filters] });
      if (request.className === 'messages.UpdateDialogFilter') {
        const index = filters.findIndex(item => item.id === request.id);
        if (request.filter && index >= 0) filters[index] = request.filter;
        else if (request.filter) filters.push(request.filter);
        else if (index >= 0) filters.splice(index, 1);
        return true;
      }
      return true;
    },
  };
  const folder = await driver.saveDialogFolder({ title: '重要', emoticon: '⭐', groups: true, contacts: false,
    nonContacts: true, broadcasts: false, bots: false, excludeMuted: true, excludeRead: false, excludeArchived: true,
    includePeers: ['12', '-10056', '99'], excludePeers: ['12'], pinnedPeers: ['99'] });
  const update = calls.find(call => call.className === 'messages.UpdateDialogFilter');
  assert.equal(update.id, 2);
  assert.equal(update.filter.title.text, '重要');
  assert.equal(update.filter.emoticon, '⭐');
  assert.deepEqual(update.filter.pinnedPeers.map(peer => peer.className), ['InputPeerSelf']);
  assert.deepEqual(update.filter.includePeers.map(peer => peer.className), ['InputPeerUser', 'InputPeerChannel', 'InputPeerSelf']);
  assert.deepEqual(inputIds, ['me', '12', '-10056', 'me', '12']);
  assert.equal(folder.id, 2);
  assert.equal(folder.groups, true);
  await driver.saveDialogFolder({ id: 2, title: '重点', emoticon: '', groups: false, contacts: true,
    nonContacts: false, broadcasts: true, bots: false, excludeMuted: false, excludeRead: true, excludeArchived: false,
    includePeers: [], excludePeers: [], pinnedPeers: [] });
  assert.equal(filters.find(item => item.id === 2).title.text, '重点');
  await assert.rejects(driver.saveDialogFolder({ title: 'Bad', groups: true, contacts: false, nonContacts: false,
    broadcasts: false, bots: false, excludeMuted: false, excludeRead: false, excludeArchived: false,
    includePeers: [], excludePeers: [], pinnedPeers: ['12'] }), /must also be included/);
  await assert.rejects(driver.saveDialogFolder({ title: 'Empty', groups: false, contacts: false, nonContacts: false,
    broadcasts: false, bots: false, excludeMuted: false, excludeRead: false, excludeArchived: false,
    includePeers: [], excludePeers: [], pinnedPeers: [] }), /at least one included category or chat/);
});

test('Telegram folder deletion excludes shared folders and reorder requires a complete current order', async () => {
  const title = text => new Api.TextWithEntities({ text, entities: [] });
  const filters = [new Api.DialogFilterDefault(),
    new Api.DialogFilter({ id: 1, title: title('常用'), pinnedPeers: [], includePeers: [], excludePeers: [] }),
    new Api.DialogFilterChatlist({ id: 2, title: title('共享'), pinnedPeers: [], includePeers: [] })];
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request.className === 'messages.GetDialogFilters') return new Api.messages.DialogFilters({ filters: [...filters] });
    return true;
  } };
  await assert.rejects(driver.deleteDialogFolder(2), /not found or cannot be deleted/);
  const owner = new Api.DialogFilterChatlist({ id: 3, title: title('我管理的共享文件夹'), hasMyInvites: true, pinnedPeers: [], includePeers: [] });
  const ownerCalls = [];
  const ownerDriver = Object.create(TelegramDriver.prototype);
  ownerDriver.client = { invoke: async request => {
    ownerCalls.push(request);
    if (request.className === 'messages.GetDialogFilters') return new Api.messages.DialogFilters({ filters: [owner] });
    return true;
  } };
  await ownerDriver.deleteDialogFolder(3);
  assert.equal(ownerCalls.at(-1).className, 'messages.UpdateDialogFilter');
  await driver.reorderDialogFolders([2, 1]);
  assert.deepEqual(calls.find(call => call.className === 'messages.UpdateDialogFiltersOrder').order, [2, 1]);
  await assert.rejects(driver.reorderDialogFolders([1]), /order is stale/);
});

test('Telegram folder tag state follows server flags and tag visibility uses the native request', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfIsPremium = true;
  const calls = [];
  driver.client = { invoke: async request => {
    calls.push(request);
    return request.className === 'messages.GetDialogFilters'
      ? new Api.messages.DialogFilters({ tagsEnabled: true, filters: [] }) : true;
  } };
  assert.deepEqual(await driver.getDialogFolderTagState(), { enabled: true, premium: true });
  await driver.setDialogFolderTags(false);
  assert.ok(calls[0] instanceof Api.messages.GetDialogFilters);
  assert.ok(calls[1] instanceof Api.messages.ToggleDialogFilterTags);
  assert.equal(calls[1].enabled, false);
  await assert.rejects(driver.setDialogFolderTags('yes'), /Invalid Telegram folder tag setting/);
});

test('Telegram share picker resolves only manually selected group and channel peers', async () => {
  const title = text => new Api.TextWithEntities({ text, entities: [] });
  const channel = new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(2) });
  const group = new Api.InputPeerChat({ chatId: bigInt(34) });
  const user = new Api.InputPeerUser({ userId: bigInt(12), accessHash: bigInt(1) });
  const filter = new Api.DialogFilter({ id: 6, title: title('手选'), pinnedPeers: [group],
    includePeers: [channel, user], excludePeers: [] });
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => id;
  driver.client = {
    invoke: async request => request.className === 'messages.GetDialogFilters'
      ? new Api.messages.DialogFilters({ filters: [filter] }) : true,
    getEntity: async id => String(id) === '-10056'
      ? { className: 'Channel', megagroup: false, title: '公告频道' }
      : { className: 'Chat', title: '项目群' },
  };
  assert.deepEqual(await driver.getDialogFolderSharePeers(6), [
    { id: '-34', title: '项目群', type: 'group' },
    { id: '-10056', title: '公告频道', type: 'channel' },
  ]);
  filter.excludeMuted = true;
  await assert.rejects(driver.getDialogFolderSharePeers(6), /manually selected folder/);
});

test('Telegram shared folder invite links use chatlists APIs and only expose owned folder peers', async () => {
  const title = text => new Api.TextWithEntities({ text, entities: [] });
  const channel = new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(2) });
  const peer = new Api.PeerChannel({ channelId: bigInt(56) });
  const filter = new Api.DialogFilterChatlist({ id: 4, title: title('讨论组'), hasMyInvites: true,
    pinnedPeers: [], includePeers: [channel] });
  const invite = new Api.ExportedChatlistInvite({ title: '讨论组', url: 'https://t.me/addlist/abcdefgh', peers: [peer] });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => id;
  driver.client = {
    getInputEntity: async () => channel,
    invoke: async request => {
      calls.push(request);
      if (request.className === 'messages.GetDialogFilters') return new Api.messages.DialogFilters({ filters: [new Api.DialogFilterDefault(), filter] });
      if (request.className === 'chatlists.GetExportedInvites') return new Api.chatlists.ExportedInvites({ invites: [invite], chats: [], users: [] });
      if (request.className === 'chatlists.ExportChatlistInvite') return new Api.chatlists.ExportedChatlistInvite({ filter, invite });
      if (request.className === 'chatlists.EditExportedInvite') return invite;
      return true;
    },
  };
  assert.deepEqual(await driver.getDialogFolderInvites(4), [{ title: '讨论组', url: invite.url, peerIds: ['-10056'] }]);
  assert.deepEqual(await driver.createDialogFolderInvite(4, '讨论组', ['-10056']), { title: '讨论组', url: invite.url, peerIds: ['-10056'] });
  assert.deepEqual(await driver.editDialogFolderInvite(4, invite.url, '新名称', ['-10056']), { title: '讨论组', url: invite.url, peerIds: ['-10056'] });
  await driver.deleteDialogFolderInvite(4, invite.url);
  assert.ok(calls.some(request => request.className === 'chatlists.ExportChatlistInvite'));
  assert.ok(calls.some(request => request.className === 'chatlists.EditExportedInvite'));
  assert.ok(calls.some(request => request.className === 'chatlists.DeleteExportedInvite'));
  await assert.rejects(driver.deleteDialogFolderInvite(4, 'https://evil.example/addlist/abcdefgh'), /Invalid Telegram chatlist invite URL/);
  const categoryFilter = new Api.DialogFilter({ id: 2, title: title('分类'), groups: true, pinnedPeers: [], includePeers: [channel], excludePeers: [] });
  driver.client.invoke = async request => request.className === 'messages.GetDialogFilters'
    ? new Api.messages.DialogFilters({ filters: [categoryFilter] }) : true;
  await assert.rejects(driver.createDialogFolderInvite(2, '分类', ['-10056']), /manually selected folder/);
});

test('Telegram shared folder links preview invite peers and join only peers returned by Telegram', async () => {
  const title = text => new Api.TextWithEntities({ text, entities: [] });
  const channelPeer = new Api.PeerChannel({ channelId: bigInt(56) });
  const groupPeer = new Api.PeerChat({ chatId: bigInt(34) });
  const invite = new Api.chatlists.ChatlistInvite({ title: title('产品讨论'), peers: [channelPeer, groupPeer],
    chats: [new Api.Channel({ id: bigInt(56), title: '发布频道', broadcast: true, accessHash: bigInt(2) }),
      new Api.Chat({ id: bigInt(34), title: '产品群' })], users: [] });
  const calls = [], resolved = [];
  const channel = new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(2) });
  const group = new Api.InputPeerChat({ chatId: bigInt(34) });
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => id;
  driver.client = {
    invoke: async request => {
      calls.push(request);
      if (request.className === 'chatlists.CheckChatlistInvite') return invite;
      return true;
    },
    getInputEntity: async id => {
      resolved.push(String(id));
      return String(id) === '-10056' ? channel : group;
    },
  };
  const preview = await driver.checkDialogFolderInvite('https://t.me/addlist/abcdefgh');
  assert.deepEqual(preview, { title: '产品讨论', emoticon: undefined, alreadyImported: false, peers: [
    { id: '-10056', title: '发布频道', type: 'channel', alreadyJoined: false },
    { id: '-34', title: '产品群', type: 'group', alreadyJoined: false },
  ] });
  await driver.joinDialogFolderInvite('https://t.me/addlist/abcdefgh', ['-10056']);
  assert.deepEqual(resolved, ['-10056']);
  const join = calls.find(request => request.className === 'chatlists.JoinChatlistInvite');
  assert.ok(join);
  assert.deepEqual(join.peers.map(peer => peer.className), ['InputPeerChannel']);
  await assert.rejects(driver.joinDialogFolderInvite('https://t.me/addlist/abcdefgh', ['-99']), /not part of this Telegram invite/);
  await assert.rejects(driver.checkDialogFolderInvite('https://evil.example/addlist/abcdefgh'), /Invalid Telegram chatlist invite URL/);
  assert.equal(calls.filter(request => request.className === 'chatlists.JoinChatlistInvite').length, 1);
});

test('already imported Telegram shared folders show existing and missing peers distinctly', async () => {
  const response = new Api.chatlists.ChatlistInviteAlready({ filterId: 4,
    alreadyPeers: [new Api.PeerChannel({ channelId: bigInt(56) })],
    missingPeers: [new Api.PeerChat({ chatId: bigInt(34) })],
    chats: [new Api.Channel({ id: bigInt(56), title: '已有频道', broadcast: true, accessHash: bigInt(2) }),
      new Api.Chat({ id: bigInt(34), title: '待加入群' })], users: [] });
  const driver = Object.create(TelegramDriver.prototype);
  driver.client = { invoke: async () => response };
  const preview = await driver.checkDialogFolderInvite('https://t.me/addlist/abcdefgh');
  assert.equal(preview.alreadyImported, true);
  assert.deepEqual(preview.peers.map(peer => [peer.id, peer.title, peer.alreadyJoined]), [
    ['-10056', '已有频道', true], ['-34', '待加入群', false],
  ]);
});

test('Telegram resolves explicit folder peers even when no dialog row exists', async () => {
  const driver = Object.create(TelegramDriver.prototype);
  const requested = [], inputs = [], fallbacks = [];
  const inputPeers = new Map([
    ['12', new Api.InputPeerUser({ userId: bigInt(12), accessHash: bigInt(1) })],
    ['-10056', new Api.InputPeerChannel({ channelId: bigInt(56), accessHash: bigInt(2) })],
    ['34', new Api.InputPeerUser({ userId: bigInt(34), accessHash: bigInt(3) })],
  ]);
  driver.client = { getInputEntity: async peer => { inputs.push(String(peer)); return inputPeers.get(String(peer)); },
    invoke: async request => {
      requested.push(request);
      return { users: [
        new Api.User({ id: bigInt(12), firstName: 'Mina', lastName: 'Chen', contact: true, bot: false, status: new Api.UserStatusOnline() }),
      ], chats: [
        new Api.Channel({ id: bigInt(56), title: 'Support', megagroup: true, forum: true, accessHash: bigInt(2) }),
      ] };
    }, getEntity: async peer => {
    fallbacks.push(peer);
    throw new Error('not accessible');
  } };
  driver.logger = { debug() {} };
  const dialogs = await driver.getExplicitDialogs([12, -10056, 12, 34]);
  assert.deepEqual(inputs, ['12', '-10056', '34']);
  assert.equal(requested.length, 1);
  assert.ok(requested[0] instanceof Api.messages.GetPeerDialogs);
  assert.deepEqual(requested[0].peers.map(item => item.peer.className), ['InputPeerUser', 'InputPeerChannel', 'InputPeerUser']);
  assert.equal(fallbacks.length, 1);
  assert.deepEqual(dialogs.map(({ id, type, title }) => ({ id, type, title })), [
    { id: 12, type: 'private', title: 'Mina Chen' },
    { id: -10056, type: 'supergroup', title: 'Support' },
  ]);
  assert.equal(dialogs[0].isContact, true);
  assert.equal(dialogs[0].online, true);
  assert.equal(dialogs[1].isForum, true);
  await assert.rejects(driver.getExplicitDialogs(Array(101).fill(12)), /Invalid/);
});

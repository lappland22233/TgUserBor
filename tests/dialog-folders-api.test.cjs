'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleApiRoute } = require('../dist/gui/api');

test('dialog folder routes validate create, delete, and order operations before dispatch', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'save_dialog_folder') return { id: 4, title: payload.folder.title };
    if (action === 'get_dialog_folder_tag_state') return { enabled: true, premium: true };
    return undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/dialog-folders`;
    const tagBase = base.replace('/dialog-folders', '/dialog-folder-tags');
    const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const folder = { title: '工作', emoticon: '💼', contacts: true, nonContacts: false, groups: true,
      broadcasts: false, bots: false, excludeMuted: true, excludeRead: false, excludeArchived: false,
      includePeers: ['12'], excludePeers: [], pinnedPeers: ['12'] };
    assert.equal((await post(base, { ...folder, groups: 'true' })).status, 400);
    assert.equal((await post(base, { ...folder, contacts: false, groups: false, includePeers: [], pinnedPeers: [] })).status, 400);
    assert.equal((await post(base, { ...folder, includePeers: [12] })).status, 400);
    assert.deepEqual(await (await post(base, folder)).json(), { id: 4, title: '工作' });
    assert.equal((await post(base, { id: 4 }, 'DELETE')).status, 200);
    assert.equal((await post(`${base}/order`, { folderIds: [4, 4] })).status, 400);
    assert.equal((await post(`${base}/order`, { folderIds: [4, 2] })).status, 200);
    assert.equal((await post(tagBase, { enabled: 'true' })).status, 400);
    assert.equal((await post(tagBase, { enabled: true })).status, 200);
    const tagState = await fetch(tagBase);
    assert.equal(tagState.status, 200);
    assert.deepEqual(await tagState.json(), { enabled: true, premium: true });
    assert.deepEqual(calls, [
      { action: 'save_dialog_folder', payload: { folder } },
      { action: 'delete_dialog_folder', payload: { folderId: 4 } },
      { action: 'reorder_dialog_folders', payload: { folderIds: [4, 2] } },
      { action: 'set_dialog_folder_tags', payload: { enabled: true } },
      { action: 'get_dialog_folder_tag_state', payload: undefined },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('chatlist invite routes validate the folder, peers, and URL payloads before dispatch', async () => {
  const calls = [];
  const invite = { title: '讨论组', url: 'https://t.me/addlist/abcdefgh', peerIds: ['-10056'] };
  const sharePeers = [{ id: '-10056', title: '讨论频道', type: 'channel' }];
  const preview = { title: '讨论组', alreadyImported: false, peers: [{ id: '-10056', title: '讨论频道', type: 'channel', alreadyJoined: false }] };
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'get_dialog_folder_share_peers') return sharePeers;
    if (action === 'get_dialog_folder_invites') return [invite];
    if (action === 'check_dialog_folder_invite') return preview;
    return invite;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account/dialog-folder-invites`;
    const sharePeersUrl = base.replace('dialog-folder-invites', 'dialog-folder-share-peers');
    const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const valid = { folderId: 2, title: '讨论组', peerIds: ['-10056'] };
    assert.equal((await fetch(`${base}?folderId=0`)).status, 400);
    assert.equal((await fetch(`${sharePeersUrl}?folderId=0`)).status, 400);
    assert.deepEqual(await (await fetch(`${sharePeersUrl}?folderId=2`)).json(), sharePeers);
    assert.deepEqual(await (await fetch(`${base}?folderId=2`)).json(), [invite]);
    assert.equal((await post(base, { ...valid, peerIds: ['0'] })).status, 400);
    assert.deepEqual(await (await post(base, valid)).json(), invite);
    assert.deepEqual(await (await post(`${base}/edit`, { ...valid, url: invite.url })).json(), invite);
    assert.equal((await post(base, { folderId: 2, url: 'https://evil.example/addlist/abcdefgh' }, 'DELETE')).status, 400);
    assert.equal((await post(base, { folderId: 2, url: invite.url }, 'DELETE')).status, 200);
    const check = `${base}/check`;
    assert.equal((await post(check, { url: 'https://t.me/addlist/../../evil' })).status, 400);
    assert.deepEqual(await (await post(check, { url: invite.url })).json(), preview);
    const join = `${base}/join`;
    assert.equal((await post(join, { url: invite.url, peerIds: ['-10056', '-10056'] })).status, 400);
    assert.equal((await post(join, { url: invite.url, peerIds: ['0'] })).status, 400);
    assert.deepEqual(await (await post(join, { url: invite.url, peerIds: ['-10056'] })).json(), { success: true });
    assert.deepEqual(calls, [
      { action: 'get_dialog_folder_share_peers', payload: { folderId: 2 } },
      { action: 'get_dialog_folder_invites', payload: { folderId: 2 } },
      { action: 'create_dialog_folder_invite', payload: valid },
      { action: 'edit_dialog_folder_invite', payload: { ...valid, url: invite.url } },
      { action: 'delete_dialog_folder_invite', payload: { folderId: 2, url: invite.url } },
      { action: 'check_dialog_folder_invite', payload: { url: invite.url } },
      { action: 'join_dialog_folder_invite', payload: { url: invite.url, peerIds: ['-10056'] } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

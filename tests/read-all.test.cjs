'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { markAllDialogsRead } = require('../dist/manager/read-all');
const dialog = (id, overrides = {}) => ({ id, type: 'private', unreadCount: 1, lastMessageId: id + 100, lastMessageDate: 100000 - id, pinned: false, ...overrides });

test('reads all pages and archive using the snapshot message ID', async () => {
  const reads = [], requests = [];
  const adapter = {
    getDialogs: async (limit, cursor, folder) => {
      requests.push({limit, cursor, folder});
      if (folder === 1) return [dialog(200)];
      return cursor ? [dialog(101)] : Array.from({length: 100}, (_, i) => dialog(i + 1));
    },
    markAsRead: async (id, maxId) => reads.push([id, maxId]),
  };
  const result = await markAllDialogsRead(adapter);
  assert.equal(result.marked, 102);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.incompleteFolders, []);
  assert.deepEqual(requests[1].cursor, {peer:100,id:200,date:99900});
  assert.deepEqual(reads.at(-1), [200, 300]);
});

test('returns partial result for read failures and unavailable folders', async () => {
  const adapter = {
    getDialogs: async (limit, cursor, folder) => { if (folder === 1) throw new Error('offline'); return [dialog(1), dialog(2), dialog(3, {lastMessageId: undefined})]; },
    markAsRead: async id => { if (id === 2) throw new Error('permission'); },
  };
  const result = await markAllDialogsRead(adapter);
  assert.deepEqual(result, {marked:1, failed:2, incompleteFolders:[1]});
});

test('stops cyclic pagination and reports incomplete rather than claiming success', async () => {
  const page = Array.from({length:100}, (_, i) => dialog(i + 1));
  let calls = 0;
  const result = await markAllDialogsRead({
    getDialogs: async (limit, cursor, folder) => { if (folder === 1) return []; calls++; return page; },
    markAsRead: async () => {},
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.incompleteFolders, [0]);
  assert.equal(result.marked, 100);
});

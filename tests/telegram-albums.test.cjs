'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/gui/web/app.js', 'utf8');
const start = source.indexOf('function getMessageAlbumGroupId(');
const end = source.indexOf('\nfunction renderClientMessages(', start);
if (start < 0 || end < 0) throw new Error('Album grouping helper not found');
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\nthis.getMessageAlbumGroupId = getMessageAlbumGroupId;`, context);

test('only adjacent Telegram photo and video messages with one grouped ID form an album', () => {
  const messages = [
    { id: 1, groupedId: 'album-a', media: { type: 'photo' } },
    { id: 2, groupedId: 'album-a', media: { type: 'video' } },
    { id: 3, groupedId: 'album-a', media: { type: 'photo' } },
    { id: 4, media: { type: 'photo' } },
    { id: 5, groupedId: 'album-b', media: { type: 'photo' } },
    { id: 6, groupedId: 'album-c', media: { type: 'photo' } },
  ];
  assert.deepEqual([0, 1, 2].map(index => context.getMessageAlbumGroupId(messages, index)), ['album-a', 'album-a', 'album-a']);
  assert.equal(context.getMessageAlbumGroupId(messages, 3), '');
  assert.equal(context.getMessageAlbumGroupId(messages, 4), '');
  assert.equal(context.getMessageAlbumGroupId(messages, 5), '');
  assert.equal(context.getMessageAlbumGroupId(messages, 1, true), '');
});

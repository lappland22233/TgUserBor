'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

test('GIF search returns a bounded inline result capability and sends it only to the searched chat', async () => {
  const bot = new Api.User({ id: bigInt(900), accessHash: bigInt(901), bot: true, firstName: 'GIF', username: 'gif' });
  const resolved = new Api.contacts.ResolvedPeer({ peer: new Api.PeerUser({ userId: bigInt(900) }), users: [bot], chats: [] });
  const document = new Api.Document({ id: bigInt(77), accessHash: bigInt(-88), fileReference: Buffer.from([1, 2]), date: 1,
    mimeType: 'video/mp4', size: bigInt(1024), dcId: 2,
    attributes: [new Api.DocumentAttributeVideo({ duration: 2.5, w: 320, h: 240, supportsStreaming: true })] });
  const inlineResult = new Api.BotInlineMediaResult({ id: 'gif-result-1', type: 'gif', document,
    title: 'Funny cat', sendMessage: new Api.BotInlineMessageMediaAuto({ message: '' }) });
  const results = new Api.messages.BotResults({ queryId: bigInt(12345), nextOffset: 'opaque-next', results: [inlineResult], cacheTime: 0, users: [] });
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.pendingInlineGifs = new Map();
  driver.gifInlineBot = undefined;
  driver.resolvePeer = chatId => { assert.equal(chatId, 42); return new Api.InputPeerUser({ userId: bigInt(42), accessHash: bigInt(1) }); };
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.contacts.ResolveUsername) return resolved;
    if (request instanceof Api.messages.GetInlineBotResults) return results;
    if (request instanceof Api.messages.SaveGif) return true;
    return new Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 1 });
  } };

  const page = await driver.searchInlineGifs(42, 'funny cats');
  assert.ok(calls[0] instanceof Api.contacts.ResolveUsername);
  assert.equal(calls[0].username, 'gif');
  assert.ok(calls[1] instanceof Api.messages.GetInlineBotResults);
  assert.equal(calls[1].query, 'funny cats');
  assert.equal(calls[1].offset, '');
  assert.equal(calls[1].bot.userId.toString(), '900');
  assert.deepEqual(page, { results: [{ token: page.results[0].token, saveToken: page.results[0].saveToken, title: 'Funny cat', id: '77', accessHash: '-88',
    fileReference: 'AQI=', mimeType: 'video/mp4', duration: 2.5, width: 320, height: 240 }], nextOffset: 'opaque-next' });
  assert.match(page.results[0].token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(page.results[0].saveToken, /^[A-Za-z0-9_-]{32}$/);

  await assert.rejects(driver.sendInlineGif(77, page.results[0].token), /belongs to another chat/);
  await assert.rejects(driver.saveInlineGif(77, page.results[0].saveToken), /belongs to another chat/);
  assert.equal(await driver.saveInlineGif(42, page.results[0].saveToken), true);
  assert.ok(calls[2] instanceof Api.messages.SaveGif);
  assert.equal(calls[2].unsave, false);
  assert.equal(calls[2].id.id.toString(), '77');
  assert.equal(calls[2].id.accessHash.toString(), '-88');
  await driver.saveInlineGif(42, page.results[0].saveToken);
  assert.equal(calls.length, 3, 'a saved GIF capability does not submit duplicate changes');
  await driver.sendInlineGif(42, page.results[0].token, 12);
  const send = calls[3];
  assert.ok(send instanceof Api.messages.SendInlineBotResult);
  assert.equal(send.queryId.toString(), '12345');
  assert.equal(send.id, 'gif-result-1');
  assert.equal(send.replyTo.replyToMsgId, 12);
  await assert.rejects(driver.sendInlineGif(42, page.results[0].token), /expired or belongs to another chat/);
  await assert.rejects(driver.searchInlineGifs(42, '', ''), /Invalid GIF search request/);
});

test('GIF search and send routes validate queries, cursors and worker-scoped result tokens', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'search_inline_gifs') return { results: [{ token: 'g'.repeat(32) }], nextOffset: 'next' };
    return { success: true };
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => {
    res.statusCode = 500; res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    assert.equal((await fetch(`${base}/gifs/search?chatId=0&q=cat`)).status, 400);
    assert.equal((await fetch(`${base}/gifs/search?chatId=42&q=${'x'.repeat(129)}`)).status, 400);
    const search = await fetch(`${base}/gifs/search?chatId=42&q=funny%20cat&offset=opaque`);
    assert.equal(search.status, 200);
    assert.deepEqual(await search.json(), { results: [{ token: 'g'.repeat(32) }], nextOffset: 'next' });
    const send = body => fetch(`${base}/send-searched-gif`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ chatId: 42, token: 'short' })).status, 400);
    assert.equal((await send({ chatId: 42, token: 'g'.repeat(32), replyTo: 3 })).status, 200);
    const save = body => fetch(`${base}/gifs/save-search-result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await save({ chatId: 42, token: 'short' })).status, 400);
    assert.equal((await save({ chatId: 42, token: 's'.repeat(32) })).status, 200);
    const remove = body => fetch(`${base}/gifs/remove-saved`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await remove({ docId: '0', accessHash: '-88' })).status, 400);
    assert.equal((await remove({ docId: '77', accessHash: '-88', fileReference: 'AQI=' })).status, 200);
    assert.deepEqual(calls, [
      { action: 'search_inline_gifs', payload: { chatId: 42, query: 'funny cat', offset: 'opaque' } },
      { action: 'send_inline_gif', payload: { chatId: 42, token: 'g'.repeat(32), replyTo: 3, topMsgId: undefined } },
      { action: 'save_inline_gif', payload: { chatId: 42, token: 's'.repeat(32) } },
      { action: 'save_gif_document', payload: { docId: '77', accessHash: '-88', fileReference: 'AQI=', unsave: true } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

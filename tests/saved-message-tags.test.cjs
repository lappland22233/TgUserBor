'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { EntityCache } = require('telegram/entityCache');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { handleApiRoute } = require('../dist/gui/api');

const reaction = value => new Api.ReactionEmoji({ emoticon: value });
const defaultCatalog = () => new Api.messages.Reactions({ hash: bigInt(0), reactions: [reaction('📚'), reaction('❤️')] });
const savedCatalog = () => new Api.messages.SavedReactionTags({ hash: bigInt(0), tags: [
  new Api.SavedReactionTag({ reaction: reaction('📚'), title: 'Read later', count: 3 }),
] });

test('Saved Messages tag catalog maps used tags, titles, counts, and default choices', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.messages.GetSavedReactionTags) return savedCatalog();
    if (request instanceof Api.messages.GetDefaultTagReactions) return defaultCatalog();
    throw new Error('unexpected RPC');
  } };
  assert.deepEqual(await driver.getSavedMessageTags(), {
    tags: [{ reaction: { type: 'emoji', value: '📚' }, title: 'Read later', count: 3 }],
    defaults: [{ type: 'emoji', value: '📚' }, { type: 'emoji', value: '❤️' }],
  });
  assert.ok(calls[0] instanceof Api.messages.GetSavedReactionTags);
  assert.ok(calls[1] instanceof Api.messages.GetDefaultTagReactions);
});

test('Saved Messages tag searches use Telegram savedReaction pagination and only target self history', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { invoke: async request => { calls.push(request); return { messages: [] }; }, getMessages: async () => { throw new Error('wrong path'); } };
  assert.deepEqual(await driver.getMessages(77, { limit: 30, offsetId: 15, savedReaction: { type: 'emoji', value: '📚' } }), []);
  const request = calls[0];
  assert.ok(request instanceof Api.messages.Search);
  assert.equal(request.q, '');
  assert.equal(request.offsetId, 15);
  assert.equal(request.limit, 30);
  assert.equal(request.savedReaction[0].emoticon, '📚');
  await assert.rejects(driver.getMessages(88, { savedReaction: { type: 'emoji', value: '📚' } }), /Saved Messages/);
  await assert.rejects(driver.getMessages(77, { savedReaction: { type: 'emoji', value: 'hello' } }), /Invalid saved message tag/);
});

test('Saved Messages tag search initializes returned Telegram messages with response entities', async () => {
  const self = new Api.User({ id: bigInt(77), firstName: 'Me', accessHash: bigInt(770) });
  const alice = new Api.User({ id: bigInt(42), firstName: 'Alice', accessHash: bigInt(420) });
  const message = new Api.Message({ id: 19, peerId: new Api.PeerUser({ userId: bigInt(77) }),
    fromId: new Api.PeerUser({ userId: bigInt(42) }), date: 1, message: 'tagged result' });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.selfUser = { id: 77, firstName: 'Me' };
  driver.client = { _entityCache: new EntityCache(), invoke: async () => ({ messages: [message], users: [self, alice], chats: [] }) };
  const results = await driver.getMessages(77, { savedReaction: { type: 'emoji', value: '📚' } });
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'tagged result');
  assert.equal(results[0].chat.id, 77);
  assert.equal(results[0].from.id, 42);
});

test('editing and removing a Saved Messages tag uses Telegram UpdateSavedReactionTag', async () => {
  const calls = [];
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.messages.GetSavedReactionTags) return savedCatalog();
    if (request instanceof Api.messages.GetDefaultTagReactions) return defaultCatalog();
    return true;
  } };
  await driver.updateSavedMessageTag({ type: 'emoji', value: '📚' }, '阅读');
  assert.ok(calls.at(-1) instanceof Api.messages.UpdateSavedReactionTag);
  assert.equal(calls.at(-1).title, '阅读');
  await driver.updateSavedMessageTag({ type: 'emoji', value: '📚' });
  assert.equal(calls.at(-1).title, undefined);
  await assert.rejects(driver.updateSavedMessageTag({ type: 'emoji', value: '🔥' }, 'x'.repeat(65)), /Invalid saved tag title/);
});

test('tagging one saved message preserves its other selected reactions', async () => {
  const calls = [];
  const keptReaction = reaction('❤️');
  const message = new Api.Message({ id: 12, date: 1, message: 'saved', out: true,
    peerId: new Api.PeerUser({ userId: bigInt(77) }),
    reactions: new Api.MessageReactions({ results: [
      new Api.ReactionCount({ reaction: keptReaction, count: 1, chosenOrder: 0 }),
      new Api.ReactionCount({ reaction: reaction('📚'), count: 1 }),
    ] }),
  });
  const driver = Object.create(TelegramDriver.prototype);
  driver.selfId = 77;
  driver.client = { invoke: async request => {
    calls.push(request);
    if (request instanceof Api.messages.GetSavedReactionTags) return savedCatalog();
    if (request instanceof Api.messages.GetDefaultTagReactions) return defaultCatalog();
    if (request instanceof Api.messages.GetMessages) return { messages: [message] };
    if (request instanceof Api.messages.SendReaction) return true;
    throw new Error('unexpected RPC');
  } };
  await driver.setSavedMessageTag(77, 12, { type: 'emoji', value: '📚' }, true);
  const send = calls.at(-1);
  assert.ok(send instanceof Api.messages.SendReaction);
  assert.deepEqual(send.reaction.map(item => item.emoticon), ['❤️', '📚']);
  message.reactions = new Api.MessageReactions({ results: [
    new Api.ReactionCount({ reaction: keptReaction, count: 1, chosenOrder: 0 }),
    new Api.ReactionCount({ reaction: reaction('📚'), count: 1, chosenOrder: 1 }),
  ] });
  await driver.setSavedMessageTag(77, 12, { type: 'emoji', value: '📚' }, false);
  assert.deepEqual(calls.at(-1).reaction.map(item => item.emoticon), ['❤️']);
  await assert.rejects(driver.setSavedMessageTag(88, 12, { type: 'emoji', value: '📚' }, true), /Invalid Saved Messages/);
});

test('Saved Messages tag endpoints validate inputs and stay scoped to one account', async () => {
  const calls = [];
  const manager = { getInstance: id => id === 'a' ? { accountAction: async (action, payload) => {
    calls.push({ action, payload });
    return action === 'get_saved_message_tags' ? { tags: [], defaults: [{ type: 'emoji', value: '📚' }] } : undefined;
  } } : undefined };
  const server = http.createServer((req, res) => handleApiRoute(req, res, manager, '').catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/instances/a/account`;
    const read = await fetch(`${base}/saved-message-tags`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { tags: [], defaults: [{ type: 'emoji', value: '📚' }] });
    const post = (path, body) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('saved-message-tags', { reaction: { type: 'emoji', value: 'hello' }, title: 'bad' })).status, 400);
    assert.equal((await post('saved-message-tags', { reaction: { type: 'emoji', value: '📚' }, title: 'Read' })).status, 200);
    assert.equal((await post('saved-message-tag', { chatId: 77, messageId: 12, reaction: { type: 'emoji', value: '📚' }, enabled: true })).status, 200);
    assert.equal((await post('saved-message-tag', { chatId: 77, messageId: 0, reaction: { type: 'emoji', value: '📚' }, enabled: true })).status, 400);
    const filter = encodeURIComponent(JSON.stringify({ type: 'emoji', value: '📚' }));
    assert.equal((await fetch(`${base}/messages?chatId=77&savedReaction=${filter}`)).status, 200);
    assert.equal((await fetch(`${base}/messages?chatId=77&savedReaction=${encodeURIComponent('{}')}`)).status, 400);
    assert.deepEqual(calls, [
      { action: 'get_saved_message_tags', payload: undefined },
      { action: 'update_saved_message_tag', payload: { reaction: { type: 'emoji', value: '📚' }, title: 'Read' } },
      { action: 'set_saved_message_tag', payload: { chatId: 77, messageId: 12, reaction: { type: 'emoji', value: '📚' }, enabled: true } },
      { action: 'get_messages', payload: { chatId: 77, limit: 40, offsetId: undefined, offsetDate: undefined, search: undefined, searchFilter: undefined, savedReaction: { type: 'emoji', value: '📚' } } },
    ]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

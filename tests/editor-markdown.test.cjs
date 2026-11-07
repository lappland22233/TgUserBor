'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _parseMessageText } = require('telegram/client/messageParse');
const { TelegramDriver } = require('../dist/bot/driver/telegram');
const { customEmojiParser, editorMarkdownParser } = require('../dist/bot/driver/message-format');

async function parse(input) {
  return _parseMessageText({}, input, editorMarkdownParser);
}

function describe(text, entities) {
  return entities.map(e => ({ type: e.className, value: text.slice(e.offset, e.offset + e.length), offset: e.offset, url: e.url }));
}

test('editor formatting produces Telegram entities with UTF-16 offsets', async () => {
  const [text, entities] = await parse('😀 **粗体** __斜体__ <u>下划线</u> ~~删除~~ ||剧透|| `code` [链接](https://example.com)');
  assert.equal(text, '😀 粗体 斜体 下划线 删除 剧透 code 链接');
  assert.deepEqual(describe(text, entities).map(e => [e.type, e.value]), [
    ['MessageEntityBold', '粗体'], ['MessageEntityItalic', '斜体'],
    ['MessageEntityUnderline', '下划线'], ['MessageEntityStrike', '删除'],
    ['MessageEntitySpoiler', '剧透'], ['MessageEntityCode', 'code'],
    ['MessageEntityTextUrl', '链接'],
  ]);
  assert.equal(entities[0].offset, 3);
  assert.equal(entities[6].url, 'https://example.com');
});

test('nested formatting, literal code and multiline code preserve intended content', async () => {
  const [text, entities] = await parse('**外 __内__** `__literal__` ```\n**not bold**\nx < 3\n```');
  assert.equal(text, '外 内 __literal__ **not bold**\nx < 3');
  assert.deepEqual(describe(text, entities).map(e => [e.type, e.value]), [
    ['MessageEntityBold', '外 内'], ['MessageEntityItalic', '内'],
    ['MessageEntityCode', '__literal__'], ['MessageEntityPre', '**not bold**\nx < 3'],
  ]);
});

test('plain punctuation, escaped and unmatched delimiters remain readable', async () => {
  const input = 'one-two < 3 & 4 > 2 \\**literal\\** __unfinished [text](missing';
  const [text, entities] = await parse(input);
  assert.equal(text, 'one-two < 3 & 4 > 2 **literal** __unfinished [text](missing');
  assert.equal(entities.length, 0);
});

test('code nested in decoration does not produce invalid overlapping entities', async () => {
  const [text, entities] = await parse('**a `code` b**');
  assert.equal(text, 'a code b');
  assert.deepEqual(describe(text, entities).map(e => [e.type, e.value]), [['MessageEntityCode', 'code']]);
});

test('blockquote markup preserves nested text formatting and multiline UTF-16 ranges', async () => {
  const [text, entities] = await parse('> 引用 **粗体**\n> 第二行\n普通');
  assert.equal(text, '引用 粗体\n第二行\n普通');
  assert.deepEqual(describe(text, entities).map(e => [e.type, e.value]), [
    ['MessageEntityBlockquote', '引用 粗体\n第二行'],
    ['MessageEntityBold', '粗体'],
  ]);
});

test('custom emoji markup creates native Telegram entities with UTF-16 offsets', async () => {
  const [text, entities] = await parse('Hi [🙂](tg://emoji?id=12345) **bold**');
  assert.equal(text, 'Hi 🙂 bold');
  assert.deepEqual(entities.map(entity => [entity.className, entity.offset, entity.length]), [
    ['MessageEntityCustomEmoji', 3, 2], ['MessageEntityBold', 6, 4],
  ]);
  assert.equal(String(entities[0].documentId), '12345');
});

test('plain-text mode strips only valid custom emoji tokens and leaves all other markup literal', async () => {
  const [text, entities] = await _parseMessageText({}, '**bold** [🙂](tg://emoji?id=12345)', customEmojiParser);
  assert.equal(text, '**bold** 🙂');
  assert.equal(entities.length, 1);
  assert.equal(entities[0].className, 'MessageEntityCustomEmoji');
  const [invalid, invalidEntities] = await _parseMessageText({}, '[not emoji](tg://emoji?id=12345)', customEmojiParser);
  assert.equal(invalid, '[not emoji](tg://emoji?id=12345)');
  assert.equal(invalidEntities.length, 0);
});

test('Telegram plain send mode still emits selected custom emoji as a native entity', async () => {
  let parsed;
  const driver = Object.create(TelegramDriver.prototype);
  driver.resolvePeer = id => id;
  driver.client = { sendMessage: async (_peer, options) => {
    parsed = await _parseMessageText({}, options.message, options.parseMode);
    return { id: 9 };
  } };
  await driver.sendMessage(42, '**bold** [🙂](tg://emoji?id=12345)', { parseMode: 'plain' });
  assert.equal(parsed[0], '**bold** 🙂');
  assert.deepEqual(parsed[1].map(entity => [entity.className, entity.offset, entity.length]), [['MessageEntityCustomEmoji', 9, 2]]);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CommandParser, CommandRegistry } = require('../dist/bot/parser');
const plugin = require('../plugins/text');

function setup(adapter = {}) {
  const parser = new CommandParser(['.']);
  const registry = new CommandRegistry();
  plugin.activate({
    bot: adapter,
    command: (definition, handler) => registry.register(plugin.manifest.name, definition, handler),
  });

  return async (text, replyToMessageId) => {
    const command = parser.parse({ text, replyToMessageId, chat: { id: 23 } });
    const responses = [];
    await registry.resolve(command.name).handler({
      command,
      editOrReply: async (body, options) => responses.push({ body, options }),
    });
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0].options, { parseMode: 'plain' });
    return responses[0].body;
  };
}

test('textinfo counts graphemes, words, lines and UTF-8 bytes', async () => {
  const run = setup();
  assert.equal(
    await run('.textinfo 👩‍💻 e\u0301\r\n你好', 5),
    '字符数（含空白） 6\n词数 2\n行数 2\nUTF-8 字节数 23',
  );
});

test('textinfo reads the targeted reply and handles a reply without text', async () => {
  const run = setup({
    getMessages: async (chatId, options) => {
      assert.equal(chatId, 23);
      assert.deepEqual(options, { ids: [5] });
      return [{ id: 7, text: 'unrelated' }, { id: 5, text: '' }];
    },
  });
  assert.match(await run('.textinfo', 5), /回复包含文本的消息/);
});

test('replace treats punctuation and replacement markers as literal text', async () => {
  const run = setup({
    getMessages: async (chatId, options) => {
      assert.equal(chatId, 23);
      assert.deepEqual(options, { ids: [5] });
      return [{ id: 5, text: 'one.two.' }];
    },
  });
  assert.equal(await run('.replace . "<b>$&</b>"', 5), 'one<b>$&</b>two<b>$&</b>');
  assert.equal(await run('.replace foo "" "foo bar foo"'), ' bar ');
  assert.match(await run('.replace foo "" foo'), /没有可发送的文本/);
});

test('replace rejects missing input and results that cannot fit in one message', async () => {
  const run = setup({ getMessages: async () => [{ id: 5, text: 'a'.repeat(2049) }] });
  assert.match(await run('.replace a'), /用法/);
  assert.match(await run('.replace a b'), /请输入原文/);
  assert.match(await run('.replace z b', 5), /未找到匹配内容/);
  assert.match(await run('.replace a bc', 5), /超过 Telegram 单条消息长度限制/);
});

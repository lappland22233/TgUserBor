'use strict';

const MAX_MESSAGE_LENGTH = 4096;
const graphemeSegmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const plain = { parseMode: 'plain' };

async function readText(adapter, message, inlineText) {
  if (inlineText !== undefined) return inlineText;
  if (!message.replyToMessageId) return undefined;

  const id = message.replyToMessageId;
  const messages = await adapter.getMessages(message.chat.id, { ids: [id] });
  return messages.find((reply) => reply.id === id)?.text;
}

module.exports = {
  manifest: require('./plugin.json'),

  activate(ctx) {
    ctx.command(
      {
        name: 'textinfo',
        description: '统计文字的字符数、词数、行数和 UTF-8 字节数',
        usage: '.textinfo [文本]',
        args: [{ name: '文本', description: '省略时统计所回复的消息正文或媒体说明' }],
        examples: ['.textinfo 你好 Telegram', '.textinfo'],
      },
      async ({ command, editOrReply }) => {
        const source = await readText(ctx.bot, command.message, command.rawArgs || undefined);
        if (!source) {
          await editOrReply('请在 .textinfo 后输入文本，或回复包含文本的消息。', plain);
          return;
        }

        const characters = [...graphemeSegmenter.segment(source)].length;
        const words = [...wordSegmenter.segment(source)].filter(({ isWordLike }) => isWordLike).length;
        const lines = source.split(/\r\n|[\r\n\u2028\u2029]/u).length;
        await editOrReply([
          `字符数（含空白） ${characters}`,
          `词数 ${words}`,
          `行数 ${lines}`,
          `UTF-8 字节数 ${Buffer.byteLength(source, 'utf8')}`,
        ].join('\n'), plain);
      },
    );

    ctx.command(
      {
        name: 'replace',
        description: '区分大小写，按字面替换文本中出现的所有匹配内容',
        usage: '.replace 查找内容 替换内容 [原文]',
        args: [
          { name: '查找内容', required: true, description: '含空格时用引号包裹' },
          { name: '替换内容', required: true, description: '用 "" 表示删除匹配内容，含空格时用引号包裹' },
          { name: '原文', description: '含空格时用引号包裹，省略时读取所回复的消息' },
        ],
        examples: ['.replace "旧名称" "新名称"', '.replace foo "" "foo bar foo"'],
      },
      async ({ command, editOrReply }) => {
        const [search, replacement, inlineText] = command.args;
        if (!search || replacement === undefined || command.args.length > 3) {
          await editOrReply('用法：.replace "查找内容" "替换内容" ["原文"]，省略原文时请回复一条消息。', plain);
          return;
        }

        const source = await readText(ctx.bot, command.message, inlineText);
        if (!source) {
          await editOrReply('请输入原文，或回复包含文本的消息。', plain);
          return;
        }

        const parts = source.split(search);
        if (parts.length === 1) {
          await editOrReply('原文中未找到匹配内容。', plain);
          return;
        }

        const length = source.length + (parts.length - 1) * (replacement.length - search.length);
        if (length > MAX_MESSAGE_LENGTH) {
          await editOrReply('替换结果超过 Telegram 单条消息长度限制。请缩短替换内容后重试。', plain);
          return;
        }

        const result = parts.join(replacement);
        if (!result.trim()) {
          await editOrReply('替换结果没有可发送的文本。', plain);
          return;
        }

        await editOrReply(result, plain);
      },
    );
  },
};

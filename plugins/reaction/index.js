'use strict';

module.exports = {
  manifest: {
    name: 'reaction',
    version: '1.0.0',
    description: '快捷 Telegram 消息表情反应交互工具 (支持自定义 Emoji)',
  },

  activate(ctx) {
    // 命令: .react [emoji]
    ctx.command(
      {
        name: 'react',
        description: '为所回复的消息添加指定表情反应',
        usage: '.react [emoji:string=👍]',
        aliases: ['like'],
        args: [
          { name: 'emoji', type: 'string', required: false, default: '👍', description: '想要添加的 Telegram Emoji (例如 👍、❤️、🔥、🎉、👏)' },
        ],
        examples: [
          '.react (回复消息默认点赞 👍)',
          '.react 🔥 (回复消息点火)',
          '.react ❤️ (回复消息爱心)',
          '.like (快捷别名)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一条想要添加反应的消息。', { autoDeleteMs: 3000 });
          return;
        }

        const emoji = command.args[0] || '👍';
        try {
          await bot.adapter.reactToMessage(msg.chat.id, msg.replyToMessageId, emoji);
          if (msg.outgoing) {
            await ctx.bot.deleteMessage(msg.chat.id, msg.id).catch(() => {});
          } else {
            await editOrReply(`✨ 已添加反应: ${emoji}`, { autoDeleteMs: 2000 });
          }
        } catch (err) {
          await editOrReply(`❌ 添加反应失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 常用快捷别名
    ctx.commands.alias('like', 'react');

    // 命令: .unreact
    ctx.command(
      {
        name: 'unreact',
        description: '取消对所回复消息已添加的表情反应',
        usage: '.unreact',
        args: [],
        examples: [
          '.unreact (直接回复已添加反应的消息)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一条想要取消反应的消息。', { autoDeleteMs: 3000 });
          return;
        }

        try {
          await bot.adapter.reactToMessage(msg.chat.id, msg.replyToMessageId, undefined);
          if (msg.outgoing) {
            await ctx.bot.deleteMessage(msg.chat.id, msg.id).catch(() => {});
          } else {
            await editOrReply('✨ 已移除反应', { autoDeleteMs: 2000 });
          }
        } catch (err) {
          await editOrReply(`❌ 移除反应失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


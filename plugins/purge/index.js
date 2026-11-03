'use strict';

/**
 * 消息清理插件:
 *   .del / .d - 回复一条消息，同时删除该消息与触发指令
 *   .purge <数量> - 批量删除最近 N 条消息
 */
module.exports = {
  manifest: {
    name: 'purge',
    version: '1.0.0',
    description: '快速消息删除与批量清理工具',
  },

  activate(ctx) {
    // 命令: .del / .d
    ctx.command(
      {
        name: 'del',
        description: '删除所回复的消息以及当前发送的指令 (双向快速撤回)',
        usage: '.del',
        aliases: ['d'],
        args: [],
        examples: [
          '.del (直接回复一条消息执行双向撤回)',
          '.d (使用快捷别名)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一条您想要删除的消息。', { autoDeleteMs: 3000 });
          return;
        }

        try {
          await bot.adapter.deleteMessages(msg.chat.id, [msg.id, msg.replyToMessageId]);
        } catch (err) {
          await editOrReply(`❌ 删除消息失败: ${err.message}`, { autoDeleteMs: 3000 });
        }
      },
    );

    ctx.commands.alias('d', 'del');

    // 命令: .purge <count>
    ctx.command(
      {
        name: 'purge',
        description: '批量删除当前会话中的历史消息 (仅限主人)',
        usage: '.purge [数量:integer=10]',
        args: [
          { name: '数量', type: 'integer', required: false, default: '10', description: '要批量清理的消息条数 (默认10条，最大100条)' },
        ],
        examples: [
          '.purge 15',
          '.purge 50',
          '.purge',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.outgoing && msg.from.id !== bot.config.ownerId) {
          await editOrReply('⛔ 仅限 Bot 主人执行此操作。');
          return;
        }

        const countRaw = command.args[0] || '10';
        let count = parseInt(countRaw, 10);
        if (isNaN(count) || count <= 0) {
          await editOrReply('用法示例: .purge <数量> (例如 .purge 15)');
          return;
        }

        if (count > 100) count = 100; // 安全上限

        await editOrReply(`🧹 <i>正在批量清理 ${count} 条消息...</i>`, { parseMode: 'html' });

        try {
          const client = bot.adapter.raw();
          const messages = await client.getMessages(BigInt(msg.chat.id), {
            limit: count + 1, // 包含 purge 指令本身
          });

          const idsToDelete = messages.map((m) => m.id);
          if (idsToDelete.length > 0) {
            await bot.adapter.deleteMessages(msg.chat.id, idsToDelete);
          }

          await bot.adapter.sendMessage(
            msg.chat.id,
            `🧹 <b>已成功清理 ${idsToDelete.length} 条消息。</b>`,
            { parseMode: 'html', autoDeleteMs: 3000 },
          );
        } catch (err) {
          await editOrReply(`❌ 批量清理消息失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};

'use strict';

module.exports = {
  manifest: {
    name: 'history',
    version: '1.0.0',
    description: '对话历史消息搜索与指定消息提取工具',
  },

  activate(ctx) {
    // 命令: .search <query> [limit]
    ctx.command(
      {
        name: 'search',
        description: '在当前对话中检索包含指定关键词的历史消息记录',
        usage: '.search <关键词> [检索数量]',
        args: [
          {
            name: 'query',
            type: 'string',
            required: true,
            description: '要在聊天记录中搜索的文本关键词',
          },
          {
            name: 'limit',
            type: 'integer',
            required: false,
            default: 5,
            description: '最多返回的结果条数 (默认 5，最大 20)',
          },
        ],
        examples: [
          '.search 密码',
          '.search token 10',
          '.search 机场 8',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const query = command.args[0];
        if (!query) {
          await editOrReply('用法示例: <code>.search 密码 5</code>', { parseMode: 'html' });
          return;
        }

        const limit = Math.min(Number(command.args[1]) || 5, 20);
        await editOrReply(`🔍 <i>正在搜索包含 "${query}" 的消息...</i>`, { parseMode: 'html' });

        try {
          const results = await bot.adapter.searchMessages(command.message.chat.id, query, limit);
          if (results.length === 0) {
            await editOrReply(`⚠️ 未找到包含 "<b>${query}</b>" 的相关消息。`, { parseMode: 'html' });
            return;
          }

          const lines = [
            `🔍 <b>搜索结果 (找到 ${results.length} 条):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          for (const m of results) {
            const sender = m.from.username ? `@${m.from.username}` : m.from.firstName || m.from.id;
            const snippet = m.text.length > 50 ? m.text.slice(0, 50) + '...' : m.text;
            lines.push(`• <b>[#${m.id}] ${sender}:</b> ${snippet}`);
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━');

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 搜索失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .getmsg <id>
    ctx.command(
      {
        name: 'getmsg',
        description: '通过具体的消息数字 ID 快速提取与定位历史消息详情与完整正文',
        usage: '.getmsg <消息ID>',
        args: [
          {
            name: 'id',
            type: 'integer',
            required: true,
            description: '目标消息的 Telegram Message ID 数字编号',
          },
        ],
        examples: [
          '.getmsg 12345',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msgId = Number(command.args[0]);
        if (!msgId || isNaN(msgId)) {
          await editOrReply('用法示例: <code>.getmsg 12345</code>', { parseMode: 'html' });
          return;
        }

        try {
          const msgs = await bot.adapter.getMessages(command.message.chat.id, { ids: [msgId] });
          const target = msgs[0];
          if (!target) {
            await editOrReply(`⚠️ 未找到 ID 为 <code>${msgId}</code> 的消息。`, { parseMode: 'html' });
            return;
          }

          const timeStr = new Date(target.date).toLocaleString('zh-CN');
          const lines = [
            `📄 <b>消息详情 [#${target.id}]</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `👤 <b>发送者:</b> ${target.from.firstName || ''} (@${target.from.username || '无'}) [<code>${target.from.id}</code>]`,
            `🕒 <b>发送时间:</b> <code>${timeStr}</code>`,
            `📎 <b>媒体类型:</b> <code>${target.media ? target.media.type : '无媒体'}</code>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `📝 <b>正文内容:</b>\n${target.text || '<i>(空文本)</i>'}`,
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取消息失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


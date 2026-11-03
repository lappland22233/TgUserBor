'use strict';

/**
 * 格式化时间戳为北京时间 YYYY-MM-DD HH:mm:ss
 */
function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

module.exports = {
  manifest: {
    name: 'whitelist',
    version: '1.0.0',
    description: '命令监听用户白名单管理 (仅限主人)',
  },

  activate(ctx) {
    ctx.command(
      {
        name: 'wl',
        description: '管理允许触发 Bot 命令的用户白名单 (仅限主人)',
        usage: '.wl [操作:choice[list|add|del|clear]=list] [目标:user] [备注:string]',
        args: [
          { name: '操作', type: 'choice[list|add|del|clear]', required: false, default: 'list', description: '白名单子指令: list(查看), add(添加), del(移除), clear(清空)' },
          { name: '目标', type: 'user', required: false, description: '目标用户数字 ID，或在聊天中直接回复目标用户的消息' },
          { name: '备注', type: 'string', required: false, description: '添加授权时的自定义备注信息' },
        ],
        examples: [
          '.wl list (查看已授权白名单列表)',
          '.wl add 123456789 管理员A',
          '.wl add (回复某人消息直接加入白名单)',
          '.wl del 123456789',
          '.wl clear',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        // 严格仅限号主/Owner
        if (!command.message.outgoing && command.message.from.id !== bot.config.ownerId) {
          await editOrReply('⛔ 仅限 Bot 主人执行白名单配置。');
          return;
        }

        const args = command.args;
        const sub = (args[0] || 'list').toLowerCase();
        const msg = command.message;

        // 辅助方法：从回复或参数中解析目标用户 ID、用户名与备注
        async function resolveTargetUser() {
          if (msg.isReply && msg.replyToMessageId) {
            try {
              const rawClient = bot.adapter.raw();
              const repliedMsgs = await rawClient.getMessages(BigInt(msg.chat.id), {
                ids: [msg.replyToMessageId],
              });
              const rMsg = repliedMsgs[0];
              if (rMsg) {
                const sender = await rMsg.getSender();
                if (sender?.id) {
                  const remark = args.slice(1).join(' ').trim() || undefined;
                  return {
                    id: Number(sender.id.toString()),
                    username: sender.username || undefined,
                    remark,
                  };
                }
              }
            } catch {
              /* ignore */
            }
          }

          // 从参数中提取数字 ID
          if (args[1]) {
            const rawId = args[1].replace(/[@]/g, '').trim();
            const uid = parseInt(rawId, 10);
            if (!isNaN(uid) && uid > 0) {
              const remark = args.slice(2).join(' ').trim() || undefined;
              return { id: uid, username: undefined, remark };
            }
          }

          return null;
        }

        switch (sub) {
          case 'list': {
            const list = bot.listWhitelist();
            const lines = [];
            lines.push('🛡️ <b>命令监听白名单列表</b>');
            lines.push('━━━━━━━━━━━━━━━━━━━━');
            lines.push('👑 <b>永久特权:</b> 号主及本机账号默认始终允许');

            if (list.length === 0) {
              lines.push('\n<i>当前未添加其他白名单用户（仅号主本人可使用命令）。</i>');
            } else {
              lines.push(`\n👥 <b>已授权用户 (${list.length} 人):</b>`);
              for (const item of list) {
                const userTag = item.username ? `@${item.username}` : `UID: <code>${item.user_id}</code>`;
                const remarkStr = item.remark ? ` <i>(${item.remark})</i>` : '';
                lines.push(`  • ${userTag}${remarkStr} - <code>${item.user_id}</code>`);
              }
            }

            lines.push('\n━━━━━━━━━━━━━━━━━━━━');
            lines.push('💡 <b>添加方式:</b> 回复某人消息发送 <code>.wl add [备注]</code> 或 <code>.wl add &lt;用户ID&gt; [备注]</code>');
            await editOrReply(lines.join('\n'), { parseMode: 'html' });
            break;
          }

          case 'add': {
            const target = await resolveTargetUser();
            if (!target) {
              await editOrReply(
                '⚠️ 请提供用户数字 ID，或直接回复该用户的一条消息发送 <code>.wl add [备注]</code>',
                { parseMode: 'html' },
              );
              return;
            }

            bot.addWhitelist(target.id, target.username, target.remark);
            const userDisplay = target.username ? `@${target.username} (${target.id})` : `ID <code>${target.id}</code>`;
            const remarkInfo = target.remark ? `\n📝 <b>备注:</b> ${target.remark}` : '';

            await editOrReply(
              `✅ <b>已成功将用户加入白名单！</b>\n👤 <b>用户:</b> ${userDisplay}${remarkInfo}\n<i>该用户现已可正常触发所有公开发送的命令。</i>`,
              { parseMode: 'html' },
            );
            break;
          }

          case 'del':
          case 'rm':
          case 'remove': {
            const target = await resolveTargetUser();
            if (!target) {
              await editOrReply(
                '⚠️ 请提供用户数字 ID，或直接回复该用户的一条消息发送 <code>.wl del</code>',
                { parseMode: 'html' },
              );
              return;
            }

            const removed = bot.removeWhitelist(target.id);
            if (removed) {
              await editOrReply(
                `🗑️ <b>已成功将用户从白名单中移除:</b> <code>${target.id}</code>\n<i>该用户发送的命令将不再触发任何响应。</i>`,
                { parseMode: 'html' },
              );
            } else {
              await editOrReply(`ℹ️ 用户 <code>${target.id}</code> 不在白名单列表中。`, { parseMode: 'html' });
            }
            break;
          }

          case 'clear': {
            bot.db.raw().exec('DELETE FROM whitelist');
            await editOrReply('🧹 <b>白名单列表已全部清空！</b>\n<i>当前仅号主本人可触发并响应命令。</i>', { parseMode: 'html' });
            break;
          }

          default:
            await editOrReply(
              [
                '🛡️ <b>白名单管理指令菜单</b>',
                '━━━━━━━━━━━━━━━━━━━━',
                '• <code>.wl</code> 或 <code>.wl list</code> — 查看当前已授权的白名单用户',
                '• <code>.wl add &lt;用户ID&gt; [备注]</code> — 将指定数字 ID 加入白名单',
                '• <b>回复某人消息输入</b> <code>.wl add [备注]</code> — 快捷授权该用户',
                '• <code>.wl del &lt;用户ID&gt;</code> (或回复消息 <code>.wl del</code>) — 撤销授权',
                '• <code>.wl clear</code> — 清空所有已添加的白名单',
              ].join('\n'),
              { parseMode: 'html' },
            );
        }
      },
    );

    ctx.commands.alias('whitelist', 'wl');
  },
};


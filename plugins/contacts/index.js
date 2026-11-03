'use strict';

module.exports = {
  manifest: {
    name: 'contacts',
    version: '1.0.0',
    description: 'Telegram 对话列表、联系人名录与详细信息查看工具',
  },

  activate(ctx) {
    // 命令: .dialogs [limit]
    ctx.command(
      {
        name: 'dialogs',
        description: '列出近期对话列表 (包含群组/频道/私聊，支持未读数与置顶提示)',
        usage: '.dialogs [数量]',
        args: [
          {
            name: 'limit',
            type: 'integer',
            required: false,
            default: 15,
            description: '拉取近期对话的数量上限 (最大 50)',
          },
        ],
        examples: [
          '.dialogs',
          '.dialogs 30',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const limit = Math.min(Number(command.args[0]) || 15, 50);
        await editOrReply('📋 <i>正在获取近期对话列表...</i>', { parseMode: 'html' });

        try {
          const dialogs = await bot.adapter.getDialogs(limit);
          if (dialogs.length === 0) {
            await editOrReply('⚠️ 未找到任何对话。');
            return;
          }

          const lines = [
            `📋 <b>近期对话概览 (前 ${dialogs.length} 个):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          for (const d of dialogs) {
            const typeIcon = d.type === 'private' ? '👤' : d.type === 'channel' ? '📢' : '👥';
            const unread = d.unreadCount > 0 ? ` (🔴 ${d.unreadCount})` : '';
            const pin = d.pinned ? '📌 ' : '';
            lines.push(`${pin}${typeIcon} <code>${d.id}</code> - <b>${d.title || '未知'}</b>${unread}`);
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━');

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取对话失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .contacts [limit]
    ctx.command(
      {
        name: 'contacts',
        description: '列出当前账号的 Telegram 通讯录好友联系人列表',
        usage: '.contacts [数量]',
        args: [
          {
            name: 'limit',
            type: 'integer',
            required: false,
            default: 20,
            description: '展示的联系人数量上限 (最大 100)',
          },
        ],
        examples: [
          '.contacts',
          '.contacts 50',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const limit = Math.min(Number(command.args[0]) || 20, 100);
        await editOrReply('📇 <i>正在读取联系人列表...</i>', { parseMode: 'html' });

        try {
          const list = await bot.adapter.getContacts();
          if (list.length === 0) {
            await editOrReply('⚠️ 联系人列表为空。');
            return;
          }

          const sliced = list.slice(0, limit);
          const lines = [
            `📇 <b>通讯录联系人 (展示前 ${sliced.length} / 共 ${list.length} 位):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          for (const u of sliced) {
            const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || '未设置名字';
            const uname = u.username ? ` (@${u.username})` : '';
            lines.push(`• <code>${u.id}</code>: <b>${name}</b>${uname}`);
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━');

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取联系人失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .chatinfo
    ctx.command(
      {
        name: 'chatinfo',
        description: '查看当前群组或频道的完整元数据、成员数与系统属性',
        usage: '.chatinfo',
        args: [],
        examples: [
          '.chatinfo',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const chat = command.message.chat;
        try {
          const fullChat = await bot.adapter.getChat(chat.id);
          const lines = [
            `📊 <b>会话实体信息</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `🆔 <b>Chat ID:</b> <code>${chat.id}</code>`,
            `🏷️ <b>会话类型:</b> <code>${fullChat?.type || chat.type}</code>`,
            `📌 <b>标题:</b> <b>${fullChat?.title || chat.title || '私聊'}</b>`,
            `🔗 <b>用户名:</b> ${fullChat?.username ? '@' + fullChat.username : '<i>(无公开用户名)</i>'}`,
            `👥 <b>成员总数:</b> <code>${fullChat?.membersCount || '未知'}</code>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取会话信息失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .userinfo [userId]
    ctx.command(
      {
        name: 'userinfo',
        description: '查看目标用户的详细个人档案 (可通过回复消息或直接提供用户ID，默认查自己)',
        usage: '.userinfo [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            default: '当前发送者自己',
            description: '目标用户的数字 ID 或用户名 (可直接回复其消息)',
          },
        ],
        examples: [
          '.userinfo',
          '.userinfo 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        let targetId;
        const msg = command.message;

        if (msg.isReply && msg.replyToMessageId) {
          try {
            const msgs = await bot.adapter.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
            targetId = msgs[0]?.from?.id;
          } catch {}
        }

        if (!targetId && command.args[0]) {
          targetId = Number(command.args[0].replace('@', ''));
        }

        if (!targetId) {
          targetId = msg.from.id; // 默认查询自己
        }

        try {
          const user = await bot.adapter.getUser(targetId);
          if (!user) {
            await editOrReply(`⚠️ 未能解析 ID 为 <code>${targetId}</code> 的用户信息。`, { parseMode: 'html' });
            return;
          }

          const lines = [
            `👤 <b>用户详细档案</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `🆔 <b>User ID:</b> <code>${user.id}</code>`,
            `👤 <b>姓名:</b> ${user.firstName || ''} ${user.lastName || ''}`.trim(),
            `🔗 <b>用户名:</b> ${user.username ? '@' + user.username : '<i>(未设置)</i>'}`,
            `🤖 <b>是否机器人:</b> <code>${user.isBot ? '是 (Bot)' : '否 (真实用户)'}</code>`,
            `📞 <b>绑号手机:</b> <code>${user.phone || '保密 / 未公开'}</code>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 查询用户失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


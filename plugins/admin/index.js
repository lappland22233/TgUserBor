'use strict';

module.exports = {
  manifest: {
    name: 'admin',
    version: '1.0.0',
    description: '强大的群组与频道管理套件 (封禁/禁言/踢出/提权/改名/成员查看)',
  },

  activate(ctx) {
    // 辅助解析目标用户 (通过回复 或 参数ID)
    async function resolveTargetUser(command, bot) {
      const msg = command.message;
      if (msg.isReply && msg.replyToMessageId) {
        try {
          const msgs = await bot.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
          if (msgs[0]?.from) return msgs[0].from;
        } catch {}
      }
      const rawArg = command.args[0];
      if (rawArg) {
        const num = Number(rawArg.replace('@', ''));
        if (!isNaN(num)) return { id: num, isBot: false };
      }
      return undefined;
    }

    // 命令: .ban [userId]
    ctx.command(
      {
        name: 'ban',
        description: '封禁目标成员并将其永久移出群聊 (可通过回复其消息或直接指定用户ID)',
        usage: '.ban [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户的数字 ID (若直接回复目标消息则此参数可省略)',
          },
        ],
        examples: [
          '.ban',
          '.ban 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要封禁用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.banUser(command.message.chat.id, target.id);
          await editOrReply(`🔨 <b>已封禁用户:</b> <code>${target.username ? '@' + target.username : target.id}</code>`, {
            parseMode: 'html',
          });
        } catch (err) {
          await editOrReply(`❌ 封禁失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .unban [userId]
    ctx.command(
      {
        name: 'unban',
        description: '解除目标用户的群组封禁状态 (支持通过回复或指定用户ID)',
        usage: '.unban [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户的数字 ID (若回复目标消息则此参数可省略)',
          },
        ],
        examples: [
          '.unban',
          '.unban 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要解封用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.unbanUser(command.message.chat.id, target.id);
          await editOrReply(`🕊️ <b>已解封用户:</b> <code>${target.username ? '@' + target.username : target.id}</code>`, {
            parseMode: 'html',
          });
        } catch (err) {
          await editOrReply(`❌ 解封失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .kick [userId]
    ctx.command(
      {
        name: 'kick',
        description: '将目标成员踢出群聊 (不列入黑名单，允许其再次通过链接加入)',
        usage: '.kick [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户的数字 ID (若回复目标消息则可省略)',
          },
        ],
        examples: [
          '.kick',
          '.kick 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要踢出用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.kickUser(command.message.chat.id, target.id);
          await editOrReply(`👢 <b>已踢出用户:</b> <code>${target.username ? '@' + target.username : target.id}</code>`, {
            parseMode: 'html',
          });
        } catch (err) {
          await editOrReply(`❌ 踢出失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .mute [秒数] [userId]
    ctx.command(
      {
        name: 'mute',
        description: '对群成员施加禁言限制 (可指定秒数时长或永久禁言)',
        usage: '.mute [禁言秒数] [用户ID]',
        args: [
          {
            name: 'duration',
            type: 'duration|integer',
            required: false,
            default: '0 (永久)',
            description: '禁言持续时长 (单位: 秒，留空或 0 为永久禁言)',
          },
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户的数字 ID (若回复消息则可省略)',
          },
        ],
        examples: [
          '.mute 300',
          '.mute 3600 123456789',
          '.mute',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要禁言用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        let seconds = 0;
        if (command.args[0] && !isNaN(Number(command.args[0]))) {
          seconds = Number(command.args[0]);
        }

        try {
          await bot.adapter.muteUser(command.message.chat.id, target.id, seconds);
          const timeText = seconds > 0 ? `${seconds} 秒` : '永久';
          await editOrReply(`🔇 <b>已禁言用户 (${timeText}):</b> <code>${target.id}</code>`, {
            parseMode: 'html',
          });
        } catch (err) {
          await editOrReply(`❌ 禁言失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .unmute [userId]
    ctx.command(
      {
        name: 'unmute',
        description: '解除目标群成员的禁言限制，恢复其正常发言权限',
        usage: '.unmute [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户数字 ID (若回复目标消息则可省略)',
          },
        ],
        examples: [
          '.unmute',
          '.unmute 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要解除禁言用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.unmuteUser(command.message.chat.id, target.id);
          await editOrReply(`🔊 <b>已解除禁言:</b> <code>${target.id}</code>`, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 解除禁言失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .promote [userId]
    ctx.command(
      {
        name: 'promote',
        description: '将目标成员提升为群组管理员 (赋予常规管理特权)',
        usage: '.promote [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标用户数字 ID (若回复目标消息则可省略)',
          },
        ],
        examples: [
          '.promote',
          '.promote 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要提权用户的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.promoteUser(command.message.chat.id, target.id);
          await editOrReply(`⭐ <b>已将用户提升为管理员:</b> <code>${target.id}</code>`, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 提升管理员失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .demote [userId]
    ctx.command(
      {
        name: 'demote',
        description: '撤销目标管理员的全部管理权限 (降为普通成员)',
        usage: '.demote [用户ID]',
        args: [
          {
            name: 'userId',
            type: 'user|integer',
            required: false,
            description: '目标管理员数字 ID (若回复目标消息则可省略)',
          },
        ],
        examples: [
          '.demote',
          '.demote 123456789',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const target = await resolveTargetUser(command, bot.adapter);
        if (!target) {
          await editOrReply('⚠️ 请回复要降权管理员的消息，或提供用户数字 ID。', { autoDeleteMs: 4000 });
          return;
        }

        try {
          await bot.adapter.demoteUser(command.message.chat.id, target.id);
          await editOrReply(`⬇️ <b>已撤销管理员权限:</b> <code>${target.id}</code>`, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 撤销权限失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .members [limit]
    ctx.command(
      {
        name: 'members',
        description: '查看当前群组的成员列表概览 (展示管理员、所有者与普通成员身份)',
        usage: '.members [获取数量]',
        args: [
          {
            name: 'limit',
            type: 'integer',
            required: false,
            default: 20,
            description: '要拉取的成员数量上限 (默认 20，最大 100)',
          },
        ],
        examples: [
          '.members',
          '.members 50',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const limit = Math.min(Number(command.args[0]) || 20, 100);
        await editOrReply('👥 <i>正在获取群成员列表...</i>', { parseMode: 'html' });

        try {
          const list = await bot.adapter.getParticipants(command.message.chat.id, limit);
          const lines = [
            `👥 <b>当前群成员概览 (前 ${list.length} 名):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          for (const item of list) {
            const roleBadge = item.role === 'owner' ? '👑' : item.role === 'admin' ? '🛡️' : '👤';
            const name = item.user.username ? `@${item.user.username}` : `${item.user.firstName || ''} (${item.user.id})`;
            lines.push(`${roleBadge} <code>${item.user.id}</code> - ${name}`);
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━');

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取群成员失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .settitle <新标题>
    ctx.command(
      {
        name: 'settitle',
        description: '快速修改当前群组或频道的显示标题名称',
        usage: '.settitle <新群名>',
        args: [
          {
            name: 'title',
            type: 'string',
            required: true,
            description: '要设置的新群组/频道标题文本',
          },
        ],
        examples: [
          '.settitle 我的超级开发交流群',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const newTitle = command.rawArgs.trim();
        if (!newTitle) {
          await editOrReply('用法示例: <code>.settitle 我的超级群</code>', { parseMode: 'html' });
          return;
        }

        try {
          await bot.adapter.setChatTitle(command.message.chat.id, newTitle);
          await editOrReply(`✏️ <b>群标题已更新为:</b> <code>${newTitle}</code>`, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 修改标题失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .setdesc <新简介>
    ctx.command(
      {
        name: 'setdesc',
        description: '快速修改当前群组或频道的公开介绍与简介文本 (About)',
        usage: '.setdesc <新简介文本>',
        args: [
          {
            name: 'description',
            type: 'string',
            required: true,
            description: '要设置的新群组/频道简介介绍内容',
          },
        ],
        examples: [
          '.setdesc 本群为官方技术交流社区，欢迎大家加入讨论。',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const desc = command.rawArgs.trim();
        try {
          await bot.adapter.setChatDescription(command.message.chat.id, desc);
          await editOrReply('✏️ <b>群简介已成功更新</b>', { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 修改简介失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .leave
    ctx.command(
      {
        name: 'leave',
        description: '命令当前 UserBot 账号主动退出所在的群组或频道',
        usage: '.leave',
        args: [],
        examples: [
          '.leave',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        await editOrReply('👋 <b>正在退出群组...</b>', { parseMode: 'html' });
        try {
          await bot.adapter.leaveChat(command.message.chat.id);
        } catch (err) {
          await editOrReply(`❌ 退出群组失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


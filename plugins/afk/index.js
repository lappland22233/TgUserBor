'use strict';

function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  parts.push(`${seconds}秒`);
  return parts.join(' ');
}

module.exports = {
  manifest: {
    name: 'afk',
    version: '1.0.0',
    description: '离开挂机自动回复与提及消息摘要汇总',
  },

  activate(ctx) {
    let afkState = ctx.getConfig()?.afk || null;
    const repliedUsers = new Map(); // userId -> lastReplyTimestamp

    // 命令: .afk [reason]
    ctx.command(
      {
        name: 'afk',
        description: '开启离开挂机 (AFK) 状态，自定义回复原因并在有人私聊或艾特时自动应答',
        usage: '.afk [离开原因]',
        args: [
          {
            name: 'reason',
            type: 'string',
            required: false,
            default: '当前正在忙碌，稍后回复。',
            description: '自定义的离开原因文本说明',
          },
        ],
        examples: [
          '.afk',
          '.afk 正在开会，急事请电话联系',
          '.afk 出门运动中，预计2小时后回来',
        ],
      },
      async ({ command, editOrReply }) => {
        const reason = command.rawArgs || '当前正在忙碌，稍后回复。';
        afkState = {
          active: true,
          since: Date.now(),
          reason,
          pms: 0,
          mentions: 0,
        };
        ctx.setConfig({ afk: afkState });

        await editOrReply(
          `😴 <b>已开启 AFK 挂机模式</b>\n<b>离开原因:</b> <i>${reason}</i>\n<i>当有人私聊或在群组提及我时，将自动进行礼貌提醒。</i>`,
          { parseMode: 'html' },
        );
      },
    );

    // 监听消息事件
    ctx.on('message', async (msg) => {
      // 1. 如果是号主发出的消息，自动解除 AFK 状态
      if (msg.outgoing) {
        if (afkState && afkState.active) {
          // 如果是刚开启 AFK 的指令本身，不触发解除
          if (Date.now() - afkState.since < 1500 && msg.text.includes('afk')) return;

          const duration = formatDuration(Date.now() - afkState.since);
          const pms = afkState.pms;
          const mentions = afkState.mentions;

          afkState = null;
          ctx.setConfig({ afk: null });
          repliedUsers.clear();

          const digest = [
            '👋 <b>欢迎回来！已自动解除 AFK 挂机状态。</b>',
            `⏱ <b>离开时长:</b> <code>${duration}</code>`,
            `📬 <b>挂机期间消息:</b> 共收到 <b>${pms}</b> 条私聊与 <b>${mentions}</b> 次群组提及。`,
          ].join('\n');

          await ctx.bot.sendMessage(msg.chat.id, digest, { parseMode: 'html', autoDeleteMs: 8000 });
        }
        return;
      }

      // 2. 如果收到他人消息且当前处于挂机状态
      if (!afkState || !afkState.active) return;
      if (msg.from.isBot) return;

      const isPrivate = msg.chat.type === 'private';
      const isMentioned = Boolean(msg.mentionedBot);

      if (isPrivate || isMentioned) {
        if (isPrivate) afkState.pms++;
        if (isMentioned) afkState.mentions++;
        ctx.setConfig({ afk: afkState });

        // 针对同一用户限制回复频率（60秒内仅回复一次，防止刷屏）
        const lastReplied = repliedUsers.get(msg.from.id) || 0;
        if (Date.now() - lastReplied < 60_000) return;
        repliedUsers.set(msg.from.id, Date.now());

        const duration = formatDuration(Date.now() - afkState.since);
        const replyText = [
          '😴 <b>号主当前处于离开挂机 (AFK) 状态</b>',
          `⏱ <b>已离开:</b> <code>${duration}</code>`,
          `📝 <b>原因:</b> <i>${afkState.reason}</i>`,
        ].join('\n');

        try {
          await ctx.bot.replyTo(msg.chat.id, msg.id, replyText, { parseMode: 'html' });
        } catch {
          /* ignore */
        }
      }
    });
  },
};

'use strict';

const path = require('path');
const fs = require('fs');

module.exports = {
  manifest: {
    name: 'media',
    version: '1.0.0',
    description: '媒体收发、文件下载、消息置顶与转发工具',
  },

  activate(ctx) {
    // 命令: .send <url/path> [caption]
    ctx.command(
      {
        name: 'send',
        description: '发送网络图片/视频/本地文件至当前会话 (根据后缀自动识别媒体格式)',
        usage: '.send <URL或文件路径> [说明文字]',
        args: [
          {
            name: 'source',
            type: 'url|path',
            required: true,
            description: '媒体文件的网络直链 URL (如 .jpg/.mp4) 或本地文件绝对/相对路径',
          },
          {
            name: 'caption',
            type: 'string',
            required: false,
            description: '发送媒体时附带的文字标题或说明内容',
          },
        ],
        examples: [
          '.send https://picsum.photos/800/600.jpg 每日精选壁纸',
          '.send ./data/downloads/report.pdf 离线导出报告',
        ],
      },
      async ({ command, editOrReply }) => {
        const args = command.args;
        if (!args[0]) {
          await editOrReply('用法示例: <code>.send https://example.com/image.jpg 我的图片</code>', {
            parseMode: 'html',
          });
          return;
        }

        const source = args[0];
        const caption = command.rawArgs.slice(args[0].length).trim();
        const chatId = command.message.chat.id;

        await editOrReply('⏳ <i>正在发送媒体文件...</i>', { parseMode: 'html' });

        try {
          // 根据扩展名或链接猜测类型
          const isPhoto = /\.(jpe?g|png|webp|gif)$/i.test(source);
          const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(source);

          if (isPhoto) {
            await ctx.sendPhoto(chatId, source, { caption, replyTo: command.message.replyToMessageId });
          } else if (isVideo) {
            await ctx.sendVideo(chatId, source, { caption, replyTo: command.message.replyToMessageId });
          } else {
            await ctx.sendFile(chatId, source, { caption, replyTo: command.message.replyToMessageId });
          }

          if (command.message.outgoing) {
            // 发送成功后删除触发指令
            await ctx.bot.deleteMessage(chatId, command.message.id).catch(() => {});
          }
        } catch (err) {
          await editOrReply(`❌ 发送失败: ${err.message}`, { autoDeleteMs: 5000 });
        }
      },
    );

    // 命令: .dl [destFileName]
    ctx.command(
      {
        name: 'dl',
        description: '下载回复消息中的媒体、图片或文档附件到本地服务器硬盘存储中',
        usage: '.dl [保存文件名] (需回复媒体消息)',
        args: [
          {
            name: 'fileName',
            type: 'string',
            required: false,
            default: 'media_<timestamp>',
            description: '下载到本地后保存的文件名称 (留空则自动生成时间戳文件名)',
          },
        ],
        examples: [
          '.dl',
          '.dl avatar.jpg',
        ],
      },
      async ({ command, editOrReply }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一条带有媒体或文件的消息。', { autoDeleteMs: 3000 });
          return;
        }

        await editOrReply('⏳ <i>正在下载媒体文件...</i>', { parseMode: 'html' });

        try {
          const downloadDir = path.join(process.cwd(), 'data', 'downloads');
          fs.mkdirSync(downloadDir, { recursive: true });

          const customName = command.args[0];
          const fileName = customName || `media_${Date.now()}`;
          const destPath = path.join(downloadDir, fileName);

          const savedPath = await ctx.downloadMedia(msg.chat.id, msg.replyToMessageId, destPath);
          if (savedPath) {
            await editOrReply(`✅ <b>媒体下载完成:</b>\n<code>${savedPath}</code>`, { parseMode: 'html' });
          } else {
            await editOrReply('❌ 未能下载媒体，所回复的消息可能不包含媒体附件。', { autoDeleteMs: 4000 });
          }
        } catch (err) {
          await editOrReply(`❌ 下载失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .pin [silent]
    ctx.command(
      {
        name: 'pin',
        description: '置顶回复的消息 (支持静默置顶不通知全员)',
        usage: '.pin [silent] (需回复目标消息)',
        args: [
          {
            name: 'silent',
            type: 'enum(silent)',
            required: false,
            description: '静默置顶参数，若传入 silent 则置顶时不触发全员通知通知',
          },
        ],
        examples: [
          '.pin',
          '.pin silent',
        ],
      },
      async ({ command, editOrReply }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复要置顶的消息。', { autoDeleteMs: 3000 });
          return;
        }

        const silent = command.args[0]?.toLowerCase() === 'silent';
        try {
          await ctx.pinMessage(msg.chat.id, msg.replyToMessageId, silent);
          await editOrReply(silent ? '📌 <b>消息已静默置顶</b>' : '📌 <b>消息已置顶并提醒全员</b>', {
            parseMode: 'html',
            autoDeleteMs: 3000,
          });
        } catch (err) {
          await editOrReply(`❌ 置顶失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .unpin
    ctx.command(
      {
        name: 'unpin',
        description: '取消回复消息的置顶状态，若未回复则取消当前群组最新一条置顶消息',
        usage: '.unpin',
        args: [],
        examples: [
          '.unpin',
        ],
      },
      async ({ command, editOrReply }) => {
        const msg = command.message;
        try {
          await ctx.unpinMessage(msg.chat.id, msg.replyToMessageId);
          await editOrReply('📌 <b>已取消置顶</b>', { parseMode: 'html', autoDeleteMs: 3000 });
        } catch (err) {
          await editOrReply(`❌ 取消置顶失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .fwd <targetChatId>
    ctx.command(
      {
        name: 'fwd',
        description: '将当前回复的消息快速无损转发至目标群组、频道或“收藏夹”私聊',
        usage: '.fwd <目标ChatID|Username|me> (需回复消息)',
        args: [
          {
            name: 'targetChatId',
            type: 'chat|user|string',
            required: true,
            description: '转发目标: 群组/频道数字 ID、公开用户名 (@channel) 或 "me" (自己收藏夹)',
          },
        ],
        examples: [
          '.fwd me',
          '.fwd -100123456789',
          '.fwd @my_backup_channel',
        ],
      },
      async ({ command, editOrReply }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复要转发的消息。', { autoDeleteMs: 3000 });
          return;
        }

        const target = command.args[0];
        if (!target) {
          await editOrReply('用法示例: <code>.fwd -100123456789</code> 或 <code>.fwd me</code> (转发给自己)', {
            parseMode: 'html',
          });
          return;
        }

        try {
          const targetId = target === 'me' ? ctx.bot.getSelf()?.id || msg.chat.id : Number(target) || target;
          await ctx.forwardMessage(msg.chat.id, targetId, msg.replyToMessageId);
          await editOrReply('⏩ <b>消息已成功转发</b>', { parseMode: 'html', autoDeleteMs: 3000 });
        } catch (err) {
          await editOrReply(`❌ 转发失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


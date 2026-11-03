'use strict';

const path = require('path');
const fs = require('fs');

module.exports = {
  manifest: {
    name: 'sticker',
    version: '1.0.0',
    description: 'Telegram 贴纸包查询、贴纸转换与提取工具',
  },

  activate(ctx) {
    // 命令: .stickerpack <shortName>
    ctx.command(
      {
        name: 'stickerpack',
        description: '查询并展示指定贴纸包信息与安装链接',
        usage: '.stickerpack <短标识或链接:string>',
        args: [
          { name: '短标识或链接', type: 'string', required: true, description: '贴纸包 shortName 标识或 addstickers 完整链接' },
        ],
        examples: [
          '.stickerpack Animals',
          '.stickerpack https://t.me/addstickers/duck',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        let shortName = command.args[0];
        if (!shortName) {
          await editOrReply('用法示例: <code>.stickerpack Animals</code> 或包含 addstickers 的链接', {
            parseMode: 'html',
          });
          return;
        }

        const match = shortName.match(/addstickers\/([a-zA-Z0-9_]+)/i);
        if (match) shortName = match[1];

        await editOrReply('🎨 <i>正在获取贴纸包信息...</i>', { parseMode: 'html' });

        try {
          const pack = await bot.adapter.getStickerSet(shortName);
          if (!pack) {
            await editOrReply(`⚠️ 未能找到短名为 "<b>${shortName}</b>" 的贴纸包。`, { parseMode: 'html' });
            return;
          }

          const lines = [
            `🎨 <b>贴纸包详情</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `📌 <b>名称:</b> ${pack.title}`,
            `🔗 <b>短标识:</b> <code>${pack.shortName}</code>`,
            `🔢 <b>贴纸总数:</b> <code>${pack.count} 张</code>`,
            `🌐 <b>安装链接:</b> https://t.me/addstickers/${pack.shortName}`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 查询贴纸包失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .getsticker
    ctx.command(
      {
        name: 'getsticker',
        description: '将所回复的贴纸转换为静态 PNG 图片文件并提取发送',
        usage: '.getsticker',
        args: [],
        examples: [
          '.getsticker (直接回复任意贴纸消息)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一张贴纸。', { autoDeleteMs: 3000 });
          return;
        }

        await editOrReply('⏳ <i>正在提取贴纸...</i>', { parseMode: 'html' });

        try {
          const outDir = path.join(process.cwd(), 'data', 'downloads');
          fs.mkdirSync(outDir, { recursive: true });
          const outPath = path.join(outDir, `sticker_${Date.now()}.png`);

          const res = await bot.adapter.downloadMedia(msg.chat.id, msg.replyToMessageId, outPath);
          if (res) {
            await ctx.sendPhoto(msg.chat.id, res, {
              caption: '🖼️ <b>已成功提取贴纸为图片</b>',
              replyTo: msg.replyToMessageId,
            });
            if (msg.outgoing) {
              await ctx.bot.deleteMessage(msg.chat.id, msg.id).catch(() => {});
            }
          } else {
            await editOrReply('❌ 未能提取贴纸文件，可能格式不支持。', { autoDeleteMs: 4000 });
          }
        } catch (err) {
          await editOrReply(`❌ 提取贴纸失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


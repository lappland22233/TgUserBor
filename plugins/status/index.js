'use strict';

const path = require('path');
const fs = require('fs');

module.exports = {
  manifest: {
    name: 'status',
    version: '1.0.0',
    description: '个人在线状态管理与资料修改工具 (在线/隐身/打字/名字/简介/头像)',
  },

  activate(ctx) {
    // 命令: .online
    ctx.command(
      {
        name: 'online',
        description: '将当前账号设置为在线状态',
        usage: '.online',
        args: [],
        examples: ['.online'],
      },
      async ({ editOrReply, bot }) => {
        try {
          await bot.adapter.setOnline(true);
          await editOrReply('🟢 <b>当前账号已设为在线</b>', { parseMode: 'html', autoDeleteMs: 3000 });
        } catch (err) {
          await editOrReply(`❌ 设置在线失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .offline
    ctx.command(
      {
        name: 'offline',
        description: '将当前账号设置为隐身/离线状态',
        usage: '.offline',
        args: [],
        examples: ['.offline'],
      },
      async ({ editOrReply, bot }) => {
        try {
          await bot.adapter.setOnline(false);
          await editOrReply('⚪ <b>当前账号已设为隐身/离线</b>', { parseMode: 'html', autoDeleteMs: 3000 });
        } catch (err) {
          await editOrReply(`❌ 设置离线失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .typing
    ctx.command(
      {
        name: 'typing',
        description: '在当前会话中触发"正在输入..."状态 (持续约5秒)',
        usage: '.typing',
        args: [],
        examples: ['.typing'],
      },
      async ({ command, editOrReply, bot }) => {
        try {
          await bot.adapter.sendTyping(command.message.chat.id);
          if (command.message.outgoing) {
            await ctx.bot.deleteMessage(command.message.chat.id, command.message.id).catch(() => {});
          }
        } catch (err) {
          await editOrReply(`❌ 触发正在输入失败: ${err.message}`, { autoDeleteMs: 3000 });
        }
      },
    );

    // 命令: .bio <内容>
    ctx.command(
      {
        name: 'bio',
        description: '修改账号个人简介 (About)',
        usage: '.bio <新简介内容:string>',
        args: [
          { name: '新简介内容', type: 'string', required: true, description: '要修改设置的个人介绍文本 (最多70字)' },
        ],
        examples: [
          '.bio 保持热爱，奔赴山海',
          '.bio TG UserBot Master / Python & Node.js Developer',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const newBio = command.rawArgs.trim();
        if (!newBio) {
          await editOrReply('用法示例: <code>.bio 终身学习者 / TG UserBot Master</code>', { parseMode: 'html' });
          return;
        }

        try {
          await bot.adapter.updateProfile({ bio: newBio });
          await editOrReply(`✏️ <b>个人简介已更新:</b>\n<i>${newBio}</i>`, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 更新简介失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .name <firstName> [lastName]
    ctx.command(
      {
        name: 'name',
        description: '修改当前账号姓名',
        usage: '.name <名:string> [姓:string]',
        args: [
          { name: '名', type: 'string', required: true, description: 'Telegram 账号的 First Name' },
          { name: '姓', type: 'string', required: false, description: 'Telegram 账号的 Last Name' },
        ],
        examples: [
          '.name 张 三',
          '.name Alexander',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const [firstName, lastName] = command.args;
        if (!firstName) {
          await editOrReply('用法示例: <code>.name 张 三</code>', { parseMode: 'html' });
          return;
        }

        try {
          await bot.adapter.updateProfile({ firstName, lastName: lastName || '' });
          await editOrReply(`✏️ <b>账号姓名已更改为:</b> <code>${firstName} ${lastName || ''}</code>`, {
            parseMode: 'html',
          });
        } catch (err) {
          await editOrReply(`❌ 更新姓名失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .setphoto
    ctx.command(
      {
        name: 'setphoto',
        description: '回复一张图片将其设置为当前账号新头像',
        usage: '.setphoto',
        args: [],
        examples: [
          '.setphoto (直接回复一张图片消息)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        if (!msg.isReply || !msg.replyToMessageId) {
          await editOrReply('⚠️ 请回复一张想要设为头像的图片。', { autoDeleteMs: 3000 });
          return;
        }

        await editOrReply('⏳ <i>正在下载并上传为新头像...</i>', { parseMode: 'html' });

        try {
          const tempFile = path.join(process.cwd(), 'data', `avatar_${Date.now()}.jpg`);
          const downloaded = await bot.adapter.downloadMedia(msg.chat.id, msg.replyToMessageId, tempFile);

          if (!downloaded) {
            await editOrReply('❌ 未能获取到图片文件，请确保回复的是一张图片。', { autoDeleteMs: 4000 });
            return;
          }

          await bot.adapter.updateProfilePhoto(downloaded);
          fs.unlinkSync(downloaded); // 清理临时文件

          await editOrReply('🖼️ <b>头像更新成功！</b>', { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 设置头像失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


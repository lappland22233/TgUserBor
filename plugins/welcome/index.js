'use strict';

/**
 * 示例插件: 群聊新成员欢迎
 * 演示功能:
 *   - 监听进群事件
 *   - 插件持久化配置
 *   - 占位符模板替换 ({name}, {chat})
 */
module.exports = {
  manifest: {
    name: 'welcome',
    version: '1.0.0',
    description: '新成员进群自动欢迎与模板配置',
  },

  activate(ctx) {
    const cfg = ctx.getConfig();
    if (cfg.template === undefined) {
      ctx.setConfig({ template: '欢迎 {name} 加入群组 {chat}！🎉' });
    }

    ctx.on('chat:participant:joined', async ({ chat, participant }) => {
      const template = ctx.getConfig().template || '欢迎 {name} 加入群组！🎉';
      const text = template
        .replace('{name}', participant.user.firstName || participant.user.username || '新朋友')
        .replace('{chat}', chat.title || '本群');
      try {
        await ctx.bot.sendMessage(chat.id, text);
      } catch (err) {
        ctx.logger.warn({ err, chatId: chat.id }, '发送进群欢迎消息失败');
      }
    });

    ctx.command(
      {
        name: 'setwelcome',
        description: '配置群聊新成员进群欢迎词模板 (支持占位符，仅限主人)',
        usage: '.setwelcome [欢迎模板:string]',
        args: [
          { name: '欢迎模板', type: 'string', required: false, description: '包含 {name} 与 {chat} 占位符的欢迎词模板 (留空查看当前模板)' },
        ],
        examples: [
          '.setwelcome 欢迎 {name} 加入群组 {chat}！🎉',
          '.setwelcome 欢迎大佬 {name} 进群，请先阅读置顶规则~',
          '.setwelcome (留空查看当前生效的模板)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        if (command.message.from.id !== bot.config.ownerId && !command.message.outgoing) {
          await editOrReply('⛔ 仅限 Bot 主人执行此操作。');
          return;
        }
        if (!command.rawArgs) {
          const current = ctx.getConfig().template || '暂无设置';
          await editOrReply(`当前欢迎词模板:\n${current}\n\n用法示例: .setwelcome 欢迎 {name} 来到 {chat}！🎉`);
          return;
        }
        ctx.setConfig({ ...ctx.getConfig(), template: command.rawArgs });
        await editOrReply('✅ 入群欢迎词模板已成功更新。');
      },
    );
  },
};

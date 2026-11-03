'use strict';

/**
 * 示例插件: `/hello`
 * 演示功能:
 *   - 注册指令
 *   - 读取和保存插件专属持久化配置
 *   - 发送友好打招呼消息
 */
module.exports = {
  manifest: {
    name: 'hello',
    version: '1.0.0',
    description: '友好问候命令与自定义问候语配置',
  },

  activate(ctx) {
    ctx.command(
      {
        name: 'hello',
        description: '向 Bot 打招呼问好并返回友好问候',
        usage: '.hello [名字:string]',
        args: [
          { name: '名字', type: 'string', required: false, description: '自定义称呼 (留空则默认使用发送者名)' },
        ],
        examples: [
          '.hello',
          '.hello 小明',
        ],
      },
      async ({ command, editOrReply }) => {
        const cfg = ctx.getConfig();
        const greeting = cfg.greeting || '你好';
        const name = command.args[0] || command.message.from.firstName || '朋友';
        await editOrReply(`${greeting}，${name}！👋`);
      },
    );

    ctx.command(
      {
        name: 'setgreeting',
        description: '配置打招呼问候词 (仅限主人)',
        usage: '.setgreeting <问候词:string>',
        args: [
          { name: '问候词', type: 'string', required: true, description: '自定义问候前缀短语 (例如 早安、Hi、你好)' },
        ],
        examples: [
          '.setgreeting 早安',
          '.setgreeting 嗨',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        if (command.message.from.id !== bot.config.ownerId && !command.message.outgoing) {
          await editOrReply('⛔ 只有 Bot 主人可以修改问候语。');
          return;
        }
        const word = command.args[0];
        if (!word) {
          await editOrReply('用法示例: /setgreeting <问候词>');
          return;
        }
        ctx.setConfig({ ...ctx.getConfig(), greeting: word });
        await editOrReply(`✅ 问候词已成功更新为: "${word}"。`);
      },
    );
  },

  deactivate() {
    // 监听器和指令由框架自动注销清理
  },
};

'use strict';

/**
 * 示例插件: `/echo`
 * 演示功能: 原样复读用户发送的文本内容
 */
module.exports = {
  manifest: {
    name: 'echo',
    version: '1.0.0',
    description: '复读回显消息工具',
  },

  activate(ctx) {
    ctx.command(
      {
        name: 'echo',
        description: '原样复读回显输入的文本内容',
        usage: '.echo <文本:string>',
        args: [
          { name: '文本', type: 'string', required: true, description: '要原样回显复读的文本内容' },
        ],
        examples: [
          '.echo Hello World!',
          '.echo 框架运行一切正常',
        ],
      },
      async ({ command, editOrReply }) => {
        if (!command.rawArgs) {
          await editOrReply('用法示例: /echo <文本内容>');
          return;
        }
        await editOrReply(command.rawArgs);
      },
    );
  },
};

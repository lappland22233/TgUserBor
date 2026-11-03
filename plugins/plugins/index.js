'use strict';

/**
 * 插件管理指令:
 *   /plugins list
 *   /plugins enable <name>
 *   /plugins disable <name>
 *   /plugins reload <name>
 * 仅限主人使用。
 */
module.exports = {
  manifest: {
    name: 'plugins',
    version: '1.0.0',
    description: '通过聊天指令管理实例插件热启用、热禁用与重载 (仅限主人)',
  },

  activate(ctx) {
    ctx.command(
      {
        name: 'plugins',
        description: '在聊天中管理插件启用/禁用/热重载 (仅限主人)',
        usage: '/plugins <操作:choice[list|enable|disable|reload]> [插件名:string]',
        args: [
          { name: '操作', type: 'choice[list|enable|disable|reload]', required: true, description: '管理子指令: list(查询列表), enable(启用), disable(禁用), reload(热重载)' },
          { name: '插件名', type: 'string', required: false, description: '目标插件英文标识名 (执行 enable/disable/reload 时必选)' },
        ],
        examples: [
          '/plugins list',
          '/plugins enable welcome',
          '/plugins disable hello',
          '/plugins reload tools',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        if (!command.message.outgoing && command.message.from.id !== bot.config.ownerId) {
          await editOrReply('⛔ 仅限 Bot 主人执行此操作。');
          return;
        }

        const sub = command.args[0];
        const name = command.args[1];

        switch (sub) {
          case 'list': {
            const list = bot.plugins.list();
            if (list.length === 0) {
              await editOrReply('当前未加载任何插件。');
              return;
            }
            const lines = list.map(
              (p) => `• <b>${p.name}</b> v${p.version} — ${p.enabled ? '✅ 已启用' : '⏸ 已禁用'}`,
            );
            await editOrReply(`<b>已加载插件列表 (${list.length} 个):</b>\n\n${lines.join('\n')}`, { parseMode: 'html' });
            break;
          }
          case 'enable': {
            if (!name) return editOrReply('用法: /plugins enable <插件名>');
            try {
              await bot.plugins.setEnabled(name, true);
              await editOrReply(`✅ 插件 "<b>${name}</b>" 已成功启用。`, { parseMode: 'html' });
            } catch (err) {
              await editOrReply(`❌ 操作失败: ${err.message}`);
            }
            break;
          }
          case 'disable': {
            if (!name) return editOrReply('用法: /plugins disable <插件名>');
            try {
              await bot.plugins.setEnabled(name, false);
              await editOrReply(`⏸ 插件 "<b>${name}</b>" 已成功禁用。`, { parseMode: 'html' });
            } catch (err) {
              await editOrReply(`❌ 操作失败: ${err.message}`);
            }
            break;
          }
          case 'reload': {
            if (!name) return editOrReply('用法: /plugins reload <插件名>');
            try {
              await bot.plugins.reload(name);
              await editOrReply(`🔄 插件 "<b>${name}</b>" 已成功完成热重载。`, { parseMode: 'html' });
            } catch (err) {
              await editOrReply(`❌ 热重载失败: ${err.message}`);
            }
            break;
          }
          default:
            await editOrReply(
              [
                '<b>插件管理指令菜单</b>',
                '用法: /plugins &lt;list|enable|disable|reload&gt; [插件名]',
                '',
                '示例:',
                '  <code>/plugins list</code> (查看插件列表)',
                '  <code>/plugins enable hello</code> (启用 hello 插件)',
                '  <code>/plugins reload welcome</code> (重载 welcome 插件)',
              ].join('\n'),
              { parseMode: 'html' },
            );
        }
      },
    );
  },
};

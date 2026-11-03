'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 智能从 usage 字符串推导参数规格 (作为外部第三方插件未显式写 args 时的自适应兜底)
 * 例如从: ".ban <user_id:int> [duration:seconds] [reason:string]" 提取
 */
function inferArgsFromUsage(usage) {
  if (!usage) return [];
  const args = [];
  const regex = /([<\[])([^>\]]+)([>\]])/g;
  let match;

  while ((match = regex.exec(usage)) !== null) {
    const isRequired = match[1] === '<';
    const content = match[2].trim();

    let name = content;
    let type = 'string';
    let defaultValue = undefined;

    // 解析形如 name:type=default
    if (content.includes('=')) {
      const [left, def] = content.split('=');
      defaultValue = def.trim();
      name = left.trim();
    }

    if (name.includes(':')) {
      const [n, t] = name.split(':');
      name = n.trim();
      type = t.trim();
    } else {
      // 智能类型启发式推断 (支持中英文关键词)
      const lower = name.toLowerCase();
      if (/id|user|peer|chat|用户|对象|目标/.test(lower)) type = 'user/chat';
      else if (/time|duration|seconds|min|hour|时间|时长|秒|分/.test(lower)) type = 'duration';
      else if (/count|limit|offset|number|num|条数|数量|次数|限制/.test(lower)) type = 'integer';
      else if (/cron|schedule|定时|表达式/.test(lower)) type = 'cron_expr';
      else if (/flag|bool|silent|静默|开关/.test(lower)) type = 'boolean';
      else if (/url|link|网址|链接/.test(lower)) type = 'url';
      else if (/file|photo|image|doc|文件|图片|音频|视频/.test(lower)) type = 'media/file';
      else if (/opt|action|sub|操作|子指令|动作/.test(lower)) type = 'action/string';
    }

    args.push({
      name,
      type,
      required: isRequired,
      default: defaultValue,
      description: `参数 ${name} (${type})`,
    });
  }

  return args;
}

module.exports = {
  manifest: {
    name: 'help',
    version: '1.1.0',
    description: '交互式命令帮助与详细功能手册中心',
  },

  activate(ctx) {
    ctx.command(
      {
        name: 'help',
        description: '查看系统命令总览菜单或指定命令的参数类型与详细手册',
        usage: '.help [命令名|插件名]',
        args: [
          {
            name: 'target',
            type: 'string',
            required: false,
            description: '要查询的指定命令名 (如 schedule) 或插件模块名 (如 admin)',
          },
        ],
        examples: [
          '.help',
          '.help schedule',
          '.help ban',
          '.help system',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const query = command.args[0]?.toLowerCase().trim();
        const prefixes = bot.config.command.prefixes;
        const mainPrefix = prefixes[0] || '.';

        // 1. 查询指定命令或插件
        if (query) {
          const cleanQuery = query.replace(/^[./!]+/, '');
          const cmd = bot.commands.resolve(cleanQuery);

          // 1.1 精准命中命令
          if (cmd) {
            const def = cmd.def;
            const lines = [];

            lines.push(`📖 <b>命令手册:</b> <code>${mainPrefix}${def.name}</code>`);
            lines.push(`🎯 <b>功能作用:</b> ${def.description || '暂无详细功能说明'}`);
            lines.push(`📦 <b>所属模块:</b> <code>${cmd.plugin}</code>`);

            // 别名
            if (Array.isArray(def.aliases) && def.aliases.length > 0) {
              lines.push(`🏷️ <b>可用别名:</b> ${def.aliases.map((a) => `<code>${mainPrefix}${a}</code>`).join(' ')}`);
            }

            // 标准调用格式
            lines.push(`\n💻 <b>调用格式 (Usage):</b>`);
            lines.push(`<code>${def.usage || `${mainPrefix}${def.name}`}</code>`);

            // 参数列表与类型规格
            const argsList = Array.isArray(def.args) && def.args.length > 0
              ? def.args
              : inferArgsFromUsage(def.usage);

            lines.push(`\n📝 <b>参数规格与类型明细:</b>`);
            if (argsList.length > 0) {
              for (const arg of argsList) {
                const reqText = arg.required ? '<b style="color:#ef4444;">[必填]</b>' : '<i>[可选]</i>';
                const typeText = arg.type ? `<code>${arg.type}</code>` : '<code>string</code>';
                const defText = arg.default !== undefined ? ` (默认: <code>${arg.default}</code>)` : '';
                lines.push(`  • <b>${arg.name}</b> ${reqText} ${typeText}${defText}`);
                if (arg.description) {
                  lines.push(`    ↳ <i>${arg.description}</i>`);
                }
              }
            } else {
              lines.push(`  • <i>该命令无需任何附加参数，直接发送即可执行。</i>`);
            }

            // 实战调用示例
            if (Array.isArray(def.examples) && def.examples.length > 0) {
              lines.push(`\n🌟 <b>实战调用示例 (Examples):</b>`);
              for (const ex of def.examples) {
                const formattedEx = ex.startsWith('.') || ex.startsWith('/')
                  ? `${mainPrefix}${ex.slice(1)}`
                  : `${mainPrefix}${def.name} ${ex}`;
                lines.push(`  • <code>${formattedEx}</code>`);
              }
            }

            await editOrReply(lines.join('\n'), { parseMode: 'html' });
            return;
          }

          // 1.2 命中插件模块名
          const allCommands = bot.commands.list();
          const pluginCmds = allCommands.filter((c) => c.plugin.toLowerCase() === cleanQuery);
          if (pluginCmds.length > 0) {
            const lines = [];
            lines.push(`📦 <b>插件模块详情: <code>${cleanQuery}</code></b>`);
            lines.push(`<i>该模块共注册了 ${pluginCmds.length} 个功能命令:</i>\n`);

            for (const c of pluginCmds) {
              const usageStr = c.usage ? `<code>${c.usage}</code>` : `<code>${mainPrefix}${c.name}</code>`;
              lines.push(`🔹 <b>${mainPrefix}${c.name}</b>`);
              lines.push(`   作用: ${c.description || '暂无说明'}`);
              lines.push(`   格式: ${usageStr}\n`);
            }

            lines.push(`💡 <i>输入 <code>${mainPrefix}help &lt;具体命令名&gt;</code> 可查看各参数类型与详细范例。</i>`);
            await editOrReply(lines.join('\n'), { parseMode: 'html' });
            return;
          }

          // 1.3 未找到时给出相似命令推荐
          const similar = allCommands
            .filter((c) => c.name.includes(cleanQuery) || cleanQuery.includes(c.name))
            .map((c) => `<code>${mainPrefix}${c.name}</code>`);

          let notFoundMsg = `❌ 未找到命令或插件: "<b>${query}</b>"`;
          if (similar.length > 0) {
            notFoundMsg += `\n💡 您可能在寻找: ${similar.join(', ')}`;
          } else {
            notFoundMsg += `\n💡 输入 <code>${mainPrefix}help</code> 可浏览全部可用功能命令。`;
          }
          await editOrReply(notFoundMsg, { parseMode: 'html' });
          return;
        }

        // 2. 总览菜单: 按插件模块分组列出全部命令，并清晰著名每个命令的核心作用
        const allCommands = bot.commands.list();
        const grouped = new Map();
        for (const cmd of allCommands) {
          const list = grouped.get(cmd.plugin) || [];
          list.push(cmd);
          grouped.set(cmd.plugin, list);
        }

        const lines = [];
        lines.push('🤖 <b>TGuserBOT 功能总览参考菜单</b>');
        lines.push(`<i>已加载插件: ${grouped.size} 个 | 注册命令: ${allCommands.length} 个 | 生效前缀: ${prefixes.map((p) => `<code>${p}</code>`).join(' ')}</i>\n`);

        for (const [plugin, cmds] of grouped.entries()) {
          // 尝试读取插件的说明描述
          let pluginDesc = '';
          try {
            const pInfo = bot.plugins?.get?.(plugin);
            if (pInfo?.description) {
              pluginDesc = ` - <i>${pInfo.description}</i>`;
            } else {
              const pluginDir = bot.config.plugin.dir;
              const manifestFile = path.join(pluginDir, plugin, 'plugin.json');
              if (fs.existsSync(manifestFile)) {
                const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
                if (manifest.description) pluginDesc = ` - <i>${manifest.description}</i>`;
              }
            }
          } catch {
            /* ignore */
          }

          lines.push(`📁 <b>${plugin}</b>${pluginDesc}`);
          for (const c of cmds) {
            const desc = c.description || '功能指令';
            lines.push(`  • <code>${mainPrefix}${c.name}</code>: ${desc}`);
          }
          lines.push('');
        }

        lines.push('━━━━━━━━━━━━━━━━━━━━━');
        lines.push(`💡 <b>查看详细命令参数与实战用法:</b>`);
        lines.push(`   发送 <code>${mainPrefix}help &lt;命令名&gt;</code> (如 <code>${mainPrefix}help schedule</code>)`);

        await editOrReply(lines.join('\n'), { parseMode: 'html' });
      },
    );
  },
};

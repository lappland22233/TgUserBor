'use strict';

const os = require('os');
const fs = require('fs');

/**
 * 格式化时间为中文可读格式（如：2天 4小时 12分 30秒）
 */
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

/**
 * 格式化字节为中文可读单位（如：12.4 MB）
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

module.exports = {
  manifest: {
    name: 'system',
    version: '1.0.0',
    description: '系统状态诊断、网络延迟测试及进程重启管理',
  },

  activate(ctx) {
    const startTime = Date.now();

    // 命令: ping
    ctx.command(
      {
        name: 'ping',
        description: '测试与 Telegram MTProto 服务器的双向网络通信延迟及消息编辑耗时',
        usage: '.ping',
        args: [],
        examples: ['.ping'],
      },
      async ({ editOrReply }) => {
        const start = Date.now();
        await editOrReply('🏓 <i>测速中...</i>', { parseMode: 'html' });
        const latency = Date.now() - start;
        await editOrReply(`🏓 <b>Pong!</b>\n⏱ <b>网络延迟:</b> <code>${latency}ms</code>`, { parseMode: 'html' });
      },
    );

    // 命令: status / sysinfo
    ctx.command(
      {
        name: 'status',
        description: '查看服务器硬件规格、CPU核数、内存负载及当前 Bot 进程运行指标',
        usage: '.status',
        aliases: ['sysinfo'],
        args: [],
        examples: ['.status', '.sysinfo'],
      },
      async ({ editOrReply, bot }) => {
        const botUptime = formatDuration(Date.now() - startTime);
        const sysUptime = formatDuration(os.uptime() * 1000);
        const mem = process.memoryUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        let dbSize = '未知';
        try {
          if (fs.existsSync(bot.config.db.path)) {
            const stat = fs.statSync(bot.config.db.path);
            dbSize = formatBytes(stat.size);
          }
        } catch {
          /* ignore */
        }

        const pluginsCount = bot.plugins.list().length;
        const cpus = os.cpus();
        const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : '未知';

        const lines = [
          '⚡ <b>系统与运行状态</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `🤖 <b>Bot 运行时长:</b> <code>${botUptime}</code>`,
          `🖥 <b>主机运行时间:</b> <code>${sysUptime}</code>`,
          `⚙️ <b>系统平台:</b> <code>${os.platform()} (${os.arch()})</code>`,
          `🧩 <b>Node.js:</b> <code>${process.version}</code>`,
          `🧠 <b>CPU 处理器:</b> <code>${cpuModel} (${cpus.length} 核心)</code>`,
          `💾 <b>进程内存 (RSS):</b> <code>${formatBytes(mem.rss)}</code>`,
          `📊 <b>系统物理内存:</b> <code>${formatBytes(usedMem)} / ${formatBytes(totalMem)}</code>`,
          `📦 <b>已加载插件:</b> <code>${pluginsCount} 个</code>`,
          `🗄 <b>数据库大小:</b> <code>${dbSize}</code>`,
          '━━━━━━━━━━━━━━━━━━━━',
        ];

        await editOrReply(lines.join('\n'), { parseMode: 'html' });
      },
    );

    ctx.commands.alias('sysinfo', 'status');

    // 命令: restart (仅限主人)
    ctx.command(
      {
        name: 'restart',
        description: '安全优雅地重启当前 UserBot 实例子进程 (仅限机器人主人)',
        usage: '.restart',
        args: [],
        examples: ['.restart'],
      },
      async ({ command, editOrReply, bot }) => {
        if (!command.message.outgoing && command.message.from.id !== bot.config.ownerId) {
          await editOrReply('⛔ 仅限 Bot 主人执行此操作。');
          return;
        }

        await editOrReply('🔄 <i>正在平滑重启 UserBot 实例...</i>', { parseMode: 'html' });
        ctx.logger.info('用户请求重启 UserBot 实例');

        ctx.scheduler.delay(500, async () => {
          try {
            await bot.stop();
          } finally {
            process.exit(0);
          }
        });
      },
    );
  },
};

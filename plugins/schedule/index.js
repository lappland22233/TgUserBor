'use strict';

/**
 * 将友好的时间字符串解析为毫秒数 (支持 s, m, h, d)
 * 例如: 30s -> 30000, 5m -> 300000, 2h -> 7200000
 */
function parseInterval(str) {
  if (!str) return null;
  const match = str.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();

  switch (unit) {
    case 's':
      return Math.round(val * 1000);
    case 'm':
      return Math.round(val * 60 * 1000);
    case 'h':
      return Math.round(val * 60 * 60 * 1000);
    case 'd':
      return Math.round(val * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

/**
 * 计算下一个每日指定服务器时间的精确时间戳 (支持 HH:mm 或 HH:mm:ss)
 * 例如: timeStr = "00:01" -> 当天或次日凌晨 00:01:00
 */
function calcNextDailyRun(timeStr, baseTime = Date.now()) {
  const match = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const targetHour = parseInt(match[1], 10);
  const targetMinute = parseInt(match[2], 10);
  const targetSecond = match[3] ? parseInt(match[3], 10) : 0;

  if (targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59 || targetSecond < 0 || targetSecond > 59) {
    return null;
  }

  const d = new Date(baseTime);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), targetHour, targetMinute, targetSecond, 0);

  // 如果目标时间已过或在当前秒内，顺延至下一天的该时刻
  if (target.getTime() <= baseTime) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}

/**
 * 格式化毫秒为易读的时间文本
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours} 小时 ${remainingMins} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

module.exports = {
  manifest: {
    name: 'schedule',
    version: '1.0.0',
    description: '定时与自动循环消息发送调度器 (支持自定义间隔与重启自动持久化恢复)',
  },

  activate(ctx) {
    const db = ctx.db.raw();

    // 确保数据库 scheduled_tasks 表支持 time_spec 字段
    try {
      db.prepare('ALTER TABLE scheduled_tasks ADD COLUMN time_spec TEXT').run();
    } catch {}

    // 内存中的活跃任务取消函数集合: taskId -> cancelFn
    const activeTasks = new Map();

    /**
     * 注册/启动一个任务的定时器
     */
    function scheduleTask(task) {
      if (activeTasks.has(task.id)) {
        activeTasks.get(task.id)();
        activeTasks.delete(task.id);
      }

      const now = Date.now();
      let delayMs = task.next_run_at - now;
      if (delayMs < 0) delayMs = 0; // 若过去未执行，立即执行一次

      const execute = async () => {
        try {
          await ctx.bot.sendMessage(task.chat_id, task.content);
        } catch (err) {
          ctx.logger.error({ err, taskId: task.id }, 'scheduled message dispatch failed');
        }

        const runTime = Date.now();
        if (task.repeat === 1) {
          let nextRun;
          if (task.time_spec && task.time_spec.startsWith('daily:')) {
            const timeStr = task.time_spec.slice(6);
            nextRun = calcNextDailyRun(timeStr, runTime + 1000);
          } else {
            nextRun = runTime + task.interval_ms;
          }

          db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
            runTime,
            nextRun,
            task.id,
          );
          task.last_run_at = runTime;
          task.next_run_at = nextRun;

          // 递归进入下一轮调度
          scheduleTask(task);
        } else {
          // 单次任务完成后标记为禁用
          db.prepare('UPDATE scheduled_tasks SET enabled = 0, last_run_at = ? WHERE id = ?').run(runTime, task.id);
          activeTasks.delete(task.id);
        }
      };

      const cancelFn = ctx.scheduler.delay(delayMs, execute);
      activeTasks.set(task.id, cancelFn);
    }

    /**
     * 启动时从数据库加载所有生效中的任务并恢复调度
     */
    function loadAndBootstrapTasks() {
      try {
        const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all();
        for (const t of tasks) {
          scheduleTask(t);
        }
        ctx.logger.info({ taskCount: tasks.length }, 'loaded scheduled tasks from database');
      } catch (err) {
        ctx.logger.error({ err }, 'failed to bootstrap scheduled tasks');
      }
    }

    loadAndBootstrapTasks();

    // 主命令: .schedule <subcommand>
    ctx.command(
      {
        name: 'schedule',
        description: '定时与循环周期消息自动广播管理器 (支持每天固定时刻/自定义间隔循环与持久化)',
        usage: '.schedule <add|daily|addto|dailyto|list|del|run|clear> [时间/HH:mm] [内容] [--once]',
        args: [
          {
            name: 'action',
            type: 'enum(add|daily|addto|dailyto|list|del|run|clear)',
            required: true,
            description: '子命令: daily(每天指定时间如00:01), add(按间隔循环), dailyto(指定会话每天), addto(指定会话间隔), list(列表), del(删除), run(立即发送), clear(清空)',
          },
          {
            name: 'time/interval',
            type: 'time(HH:mm)|duration|integer',
            required: false,
            description: '指定时间(如 00:01, 08:30) 或循环时间间隔(如 30s, 10m, 2h) 或任务 ID',
          },
          {
            name: 'content',
            type: 'string',
            required: false,
            description: '要自动发送的文本内容 (支持直接输入或回复引用消息)',
          },
          {
            name: '--once',
            type: 'flag',
            required: false,
            description: '单次定时执行标记 (仅发送一次，不循环)',
          },
        ],
        examples: [
          '.schedule daily 00:01 凌晨打卡，新的一天开始啦！',
          '.schedule daily 08:30 各位群友早上好！',
          '.schedule dailyto @my_channel 00:01 每日统计报表自动推送',
          '.schedule add 10m 喝水时间到了！',
          '.schedule add 1h 每日提醒 --once',
          '.schedule addto @my_channel 30m 频道自动广播',
          '.schedule list',
          '.schedule del 1',
        ],
      },
      async ({ command, editOrReply }) => {
        const args = command.args;
        const sub = (args[0] || '').toLowerCase();
        const msg = command.message;

        // 1. 每天指定时间发送: .schedule daily <HH:mm> <内容>
        if (sub === 'daily') {
          const timeRaw = args[1];
          if (!timeRaw) {
            await editOrReply(
              '用法示例:\n• <code>.schedule daily 00:01 凌晨打卡，新的一天开始啦！</code> (每天凌晨0点01分发送)\n• <code>.schedule daily 08:30 各位早上好！</code>',
              { parseMode: 'html' },
            );
            return;
          }

          const nextRun = calcNextDailyRun(timeRaw);
          if (!nextRun) {
            await editOrReply('⚠️ 时间格式无效，请输入 24 小时制 <code>HH:mm</code> (例如 <code>00:01</code> 或 <code>08:30</code>)。', {
              parseMode: 'html',
            });
            return;
          }

          const textTokens = args.slice(2);
          let content = textTokens.join(' ').trim();

          if (!content && msg.isReply && msg.replyToMessageId) {
            try {
              const replyMsgs = await ctx.bot.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
              content = replyMsgs[0]?.text || '';
            } catch {}
          }

          if (!content) {
            await editOrReply('⚠️ 请提供要发送的消息内容，或回复一条消息。', { autoDeleteMs: 4000 });
            return;
          }

          const now = Date.now();
          const timeSpec = `daily:${timeRaw}`;
          const res = db
            .prepare(
              `INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at, time_spec)
               VALUES (?, 86400000, ?, 1, 1, ?, ?, ?, ?)`
            )
            .run(msg.chat.id, content, msg.from.id, now, nextRun, timeSpec);

          const taskId = Number(res.lastInsertRowid);
          const newTask = {
            id: taskId,
            chat_id: msg.chat.id,
            interval_ms: 86400000,
            content,
            repeat: 1,
            enabled: 1,
            created_by: msg.from.id,
            created_at: now,
            next_run_at: nextRun,
            time_spec: timeSpec,
          };

          scheduleTask(newTask);

          const diffMs = nextRun - now;
          const nextDateStr = new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          const lines = [
            `⏰ <b>每日定时任务创建成功 [#${taskId}]</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `🔁 <b>执行规则:</b> 每天服务器时间 <code>${timeRaw}</code> 准时发送`,
            `⏱️ <b>首次执行时间:</b> <code>${nextDateStr}</code> (约 ${formatDuration(diffMs)} 后)`,
            `💬 <b>消息内容:</b> <i>${content.slice(0, 80)}${content.length > 80 ? '...' : ''}</i>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `💡 提示: 发送 <code>.schedule del ${taskId}</code> 可随时终止该任务。`,
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
          return;
        }

        // 2. 每天指定时间发送到指定群/频道: .schedule dailyto <chat> <HH:mm> <内容>
        if (sub === 'dailyto') {
          const targetChat = args[1];
          const timeRaw = args[2];
          const content = args.slice(3).join(' ').trim();

          if (!targetChat || !timeRaw || !content) {
            await editOrReply('用法示例: <code>.schedule dailyto @my_channel 00:01 凌晨广播通知</code>', {
              parseMode: 'html',
            });
            return;
          }

          const nextRun = calcNextDailyRun(timeRaw);
          if (!nextRun) {
            await editOrReply('⚠️ 时间格式无效，请输入 24 小时制 <code>HH:mm</code> (例如 <code>00:01</code>)。', {
              parseMode: 'html',
            });
            return;
          }

          const targetId = Number(targetChat) || targetChat;
          const now = Date.now();
          const timeSpec = `daily:${timeRaw}`;

          const res = db
            .prepare(
              `INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at, time_spec)
               VALUES (?, 86400000, ?, 1, 1, ?, ?, ?, ?)`
            )
            .run(targetId, content, msg.from.id, now, nextRun, timeSpec);

          const taskId = Number(res.lastInsertRowid);
          scheduleTask({
            id: taskId,
            chat_id: targetId,
            interval_ms: 86400000,
            content,
            repeat: 1,
            enabled: 1,
            created_by: msg.from.id,
            created_at: now,
            next_run_at: nextRun,
            time_spec: timeSpec,
          });

          await editOrReply(
            `⏰ <b>跨对话每日定时任务创建成功 [#${taskId}]</b>\n目标: <code>${targetChat}</code> | 规则: 每天服务器时间 <code>${timeRaw}</code>`,
            { parseMode: 'html' },
          );
          return;
        }

        // 3. 添加定时任务: .schedule add <间隔或HH:mm> <内容> [--once]
        if (sub === 'add') {
          const timeOrIntervalRaw = args[1];
          if (!timeOrIntervalRaw) {
            await editOrReply(
              '用法示例:\n• <code>.schedule add 00:01 凌晨打卡</code> (每天凌晨0点01分发送)\n• <code>.schedule add 10m 喝水时间到了！</code> (每10分钟自动循环发送)\n• <code>.schedule add 1h 每日提醒 --once</code> (1小时后只发送一次)',
              { parseMode: 'html' },
            );
            return;
          }

          // 智能判断是否为每天特定时刻 (例如 00:01 或 8:30)
          if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(timeOrIntervalRaw.trim())) {
            // 自动转入 daily 处理
            const nextRun = calcNextDailyRun(timeOrIntervalRaw);
            if (!nextRun) {
              await editOrReply('⚠️ 时间格式无效，请输入 24 小时制 <code>HH:mm</code> (例如 <code>00:01</code>)。', {
                parseMode: 'html',
              });
              return;
            }

            const textTokens = args.slice(2);
            let content = textTokens.join(' ').trim();
            if (!content && msg.isReply && msg.replyToMessageId) {
              try {
                const replyMsgs = await ctx.bot.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
                content = replyMsgs[0]?.text || '';
              } catch {}
            }
            if (!content) {
              await editOrReply('⚠️ 请提供要发送的消息内容，或回复一条消息。', { autoDeleteMs: 4000 });
              return;
            }

            const now = Date.now();
            const timeSpec = `daily:${timeOrIntervalRaw}`;
            const res = db
              .prepare(
                `INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at, time_spec)
                 VALUES (?, 86400000, ?, 1, 1, ?, ?, ?, ?)`
              )
              .run(msg.chat.id, content, msg.from.id, now, nextRun, timeSpec);

            const taskId = Number(res.lastInsertRowid);
            scheduleTask({
              id: taskId,
              chat_id: msg.chat.id,
              interval_ms: 86400000,
              content,
              repeat: 1,
              enabled: 1,
              created_by: msg.from.id,
              created_at: now,
              next_run_at: nextRun,
              time_spec: timeSpec,
            });

            const diffMs = nextRun - now;
            const nextDateStr = new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            await editOrReply(
              `⏰ <b>每日定时任务创建成功 [#${taskId}]</b>\n🔁 <b>规则:</b> 每天 <code>${timeOrIntervalRaw}</code> 准时发送\n⏱️ <b>首次执行:</b> <code>${nextDateStr}</code> (约 ${formatDuration(diffMs)} 后)`,
              { parseMode: 'html' },
            );
            return;
          }

          const intervalMs = parseInterval(timeOrIntervalRaw);
          if (!intervalMs || intervalMs < 5000) {
            await editOrReply('⚠️ 间隔时间无效，且为避免频繁刷屏，最小间隔不得低于 5 秒。示例: <code>30s</code>, <code>5m</code>, <code>2h</code>, 或指定时间 <code>00:01</code>', {
              parseMode: 'html',
            });
            return;
          }

          // 提取文本内容
          const textTokens = args.slice(2);
          const isOnce = textTokens.includes('--once');
          const cleanTokens = textTokens.filter((t) => t !== '--once');
          let content = cleanTokens.join(' ').trim();

          if (!content && msg.isReply && msg.replyToMessageId) {
            try {
              const replyMsgs = await ctx.bot.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
              content = replyMsgs[0]?.text || '';
            } catch {}
          }

          if (!content) {
            await editOrReply('⚠️ 请提供要发送的消息内容，或回复一条消息。', { autoDeleteMs: 4000 });
            return;
          }

          const now = Date.now();
          const nextRun = now + intervalMs;
          const repeat = isOnce ? 0 : 1;

          const res = db
            .prepare(
              `INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
            )
            .run(msg.chat.id, intervalMs, content, repeat, msg.from.id, now, nextRun);

          const taskId = Number(res.lastInsertRowid);
          const newTask = {
            id: taskId,
            chat_id: msg.chat.id,
            interval_ms: intervalMs,
            content,
            repeat,
            enabled: 1,
            created_by: msg.from.id,
            created_at: now,
            next_run_at: nextRun,
          };

          scheduleTask(newTask);

          const repeatDesc = isOnce ? '单次执行' : `自动循环 (每隔 ${formatDuration(intervalMs)})`;
          const lines = [
            `⏰ <b>定时任务创建成功 [#${taskId}]</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `🔁 <b>模式:</b> ${repeatDesc}`,
            `⏳ <b>首发倒计时:</b> 约 ${formatDuration(intervalMs)} 后`,
            `💬 <b>消息内容:</b> <i>${content.slice(0, 80)}${content.length > 80 ? '...' : ''}</i>`,
            '━━━━━━━━━━━━━━━━━━━━',
            `💡 提示: 发送 <code>.schedule del ${taskId}</code> 可随时终止该任务。`,
          ];

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
          return;
        }

        // 2. 添加到指定对话: .schedule addto <chatId> <间隔> <内容>
        if (sub === 'addto') {
          const targetChat = args[1];
          const intervalRaw = args[2];
          const content = args.slice(3).join(' ').trim();

          if (!targetChat || !intervalRaw || !content) {
            await editOrReply('用法示例: <code>.schedule addto -100123456789 30m 群广播通知</code>', {
              parseMode: 'html',
            });
            return;
          }

          const intervalMs = parseInterval(intervalRaw);
          if (!intervalMs || intervalMs < 5000) {
            await editOrReply('⚠️ 间隔时间无效，最小间隔为 5 秒。', { autoDeleteMs: 4000 });
            return;
          }

          const targetId = Number(targetChat) || targetChat;
          const now = Date.now();
          const nextRun = now + intervalMs;

          const res = db
            .prepare(
              `INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at)
               VALUES (?, ?, ?, 1, 1, ?, ?, ?)`
            )
            .run(targetId, intervalMs, content, msg.from.id, now, nextRun);

          const taskId = Number(res.lastInsertRowid);
          scheduleTask({
            id: taskId,
            chat_id: targetId,
            interval_ms: intervalMs,
            content,
            repeat: 1,
            enabled: 1,
            created_by: msg.from.id,
            created_at: now,
            next_run_at: nextRun,
          });

          await editOrReply(`⏰ <b>跨对话定时任务已创建 [#${taskId}]</b>\n目标: <code>${targetChat}</code> | 循环周期: <code>${formatDuration(intervalMs)}</code>`, {
            parseMode: 'html',
          });
          return;
        }

        // 3. 列出当前活跃任务: .schedule list
        if (sub === 'list' || sub === 'ls') {
          try {
            const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY id DESC').all();
            if (rows.length === 0) {
              await editOrReply('📅 <i>当前没有任何运行中的定时任务。</i>', { parseMode: 'html' });
              return;
            }

            const now = Date.now();
            const lines = [
              `⏰ <b>运行中的定时任务列表 (${rows.length} 个):</b>`,
              '━━━━━━━━━━━━━━━━━━━━',
            ];

            for (const t of rows) {
              const diffMs = Math.max(0, t.next_run_at - now);
              let mode;
              if (t.time_spec && t.time_spec.startsWith('daily:')) {
                mode = `🔄 每天固定 ${t.time_spec.slice(6)} (服务器时间)`;
              } else if (t.repeat === 1) {
                mode = `🔁 每隔 ${formatDuration(t.interval_ms)}`;
              } else {
                mode = '🔂 单次执行';
              }
              const nextTimeStr = new Date(t.next_run_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
              const snippet = t.content.length > 25 ? t.content.slice(0, 25) + '...' : t.content;
              lines.push(
                `• <b>[#${t.id}]</b> ${mode} | 目标: <code>${t.chat_id}</code>\n  ⏱️ 下次: <code>${nextTimeStr}</code> (约 ${formatDuration(diffMs)} 后) | 内容: "<i>${snippet}</i>"`
              );
            }
            lines.push('━━━━━━━━━━━━━━━━━━━━');
            lines.push('💡 提示: 发送 <code>.schedule del &lt;ID&gt;</code> 可删除指定任务。');

            await editOrReply(lines.join('\n'), { parseMode: 'html' });
          } catch (err) {
            await editOrReply(`❌ 获取任务列表失败: ${err.message}`, { autoDeleteMs: 4000 });
          }
          return;
        }

        // 4. 删除指定任务: .schedule del <taskId>
        if (sub === 'del' || sub === 'rm') {
          const taskId = Number(args[1]);
          if (!taskId || isNaN(taskId)) {
            await editOrReply('用法示例: <code>.schedule del 1</code>', { parseMode: 'html' });
            return;
          }

          if (activeTasks.has(taskId)) {
            activeTasks.get(taskId)();
            activeTasks.delete(taskId);
          }

          const res = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
          if (res.changes > 0) {
            await editOrReply(`🗑️ <b>已取消并删除定时任务:</b> <code>#${taskId}</code>`, {
              parseMode: 'html',
              autoDeleteMs: 3000,
            });
          } else {
            await editOrReply(`⚠️ 未找到 ID 为 <code>#${taskId}</code> 的任务。`, { parseMode: 'html', autoDeleteMs: 3000 });
          }
          return;
        }

        // 5. 立即运行一次: .schedule run <taskId>
        if (sub === 'run') {
          const taskId = Number(args[1]);
          if (!taskId || isNaN(taskId)) {
            await editOrReply('用法示例: <code>.schedule run 1</code>', { parseMode: 'html' });
            return;
          }

          const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId);
          if (!task) {
            await editOrReply(`⚠️ 未找到 ID 为 <code>#${taskId}</code> 的任务。`, { parseMode: 'html', autoDeleteMs: 3000 });
            return;
          }

          try {
            await ctx.bot.sendMessage(task.chat_id, task.content);
            await editOrReply(`🚀 <b>已立即触发执行定时任务:</b> <code>#${taskId}</code>`, { parseMode: 'html', autoDeleteMs: 3000 });
          } catch (err) {
            await editOrReply(`❌ 执行失败: ${err.message}`, { autoDeleteMs: 4000 });
          }
          return;
        }

        // 6. 清空当前会话下的所有任务: .schedule clear
        if (sub === 'clear') {
          const currentChatTasks = db.prepare('SELECT id FROM scheduled_tasks WHERE chat_id = ?').all(msg.chat.id);
          for (const t of currentChatTasks) {
            if (activeTasks.has(t.id)) {
              activeTasks.get(t.id)();
              activeTasks.delete(t.id);
            }
          }

          const res = db.prepare('DELETE FROM scheduled_tasks WHERE chat_id = ?').run(msg.chat.id);
          await editOrReply(`🧹 <b>已清空当前会话的所有定时任务 (共 ${res.changes} 个)</b>`, {
            parseMode: 'html',
            autoDeleteMs: 3000,
          });
          return;
        }

        // 帮助菜单
        const helpText = [
          '⏰ <b>定时与自动循环消息调度中心</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          '• <code>.schedule daily &lt;HH:mm&gt; &lt;内容&gt;</code>: 每天服务器时间固定时刻发送 (例如 <code>.schedule daily 00:01 凌晨打卡</code>)',
          '• <code>.schedule dailyto &lt;ChatID&gt; &lt;HH:mm&gt; &lt;内容&gt;</code>: 每天向指定目标群/频道发送',
          '• <code>.schedule add &lt;间隔&gt; &lt;内容&gt;</code>: 周期循环任务 (支持 30s, 5m, 1h 或 00:01)',
          '• <code>.schedule add &lt;间隔&gt; &lt;内容&gt; --once</code>: 仅发送一次',
          '• <code>.schedule addto &lt;ChatID&gt; &lt;间隔&gt; &lt;内容&gt;</code>: 向指定目标添加定时发送',
          '• <code>.schedule list</code>: 查看当前所有定时循环任务及下次倒计时',
          '• <code>.schedule del &lt;ID&gt;</code>: 删除并停止指定任务',
          '• <code>.schedule run &lt;ID&gt;</code>: 立即手动发送一次该任务',
          '• <code>.schedule clear</code>: 清空当前会话的所有定时任务',
          '━━━━━━━━━━━━━━━━━━━━',
        ].join('\n');

        await editOrReply(helpText, { parseMode: 'html' });
      },
    );

    // 常用快捷别名
    ctx.commands.alias('sch', 'schedule');
    ctx.commands.alias('timer', 'schedule');
  },
};


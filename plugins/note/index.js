'use strict';

module.exports = {
  manifest: {
    name: 'note',
    version: '1.0.0',
    description: '跨对话云端便签与快捷回复管理器 (基于 SQLite 持久化)',
  },

  activate(ctx) {
    const db = ctx.db.raw();

    // 命令: .note <key> [内容]
    ctx.command(
      {
        name: 'note',
        description: '保存一条跨会话便签 (可附带文本或直接回复消息)',
        usage: '.note <名称:string> [文本内容:string]',
        args: [
          { name: '名称', type: 'string', required: true, description: '便签标识关键字 (例如 rules、price、faq)' },
          { name: '文本内容', type: 'string', required: false, description: '便签文本内容，若回复消息则自动提取被回复内容' },
        ],
        examples: [
          '.note rules 请遵守群规不要发广告',
          '.note price 产品定价：月付9.9/年付99',
          '.note mynote (回复任意消息直接存为便签)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const key = command.args[0]?.trim();
        if (!key) {
          await editOrReply('用法示例:\n• <code>.note rules 请遵守群规不要发广告</code>\n• 或回复任意消息输入 <code>.note mynote</code>', {
            parseMode: 'html',
          });
          return;
        }

        let content = command.rawArgs.slice(key.length).trim();
        const msg = command.message;

        if (!content && msg.isReply && msg.replyToMessageId) {
          try {
            const msgs = await bot.adapter.getMessages(msg.chat.id, { ids: [msg.replyToMessageId] });
            if (msgs[0]?.text) {
              content = msgs[0].text;
            }
          } catch {}
        }

        if (!content) {
          await editOrReply('⚠️ 便签内容不能为空，请提供文本或回复带有文字的消息。', { autoDeleteMs: 4000 });
          return;
        }

        const now = Date.now();
        try {
          db.prepare(`
            INSERT INTO notes (key, content, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              content = excluded.content,
              updated_at = excluded.updated_at
          `).run(key, content, msg.from.id, now, now);

          await editOrReply(`📌 <b>便签已保存:</b> <code>#${key}</code>`, { parseMode: 'html', autoDeleteMs: 3000 });
        } catch (err) {
          await editOrReply(`❌ 保存便签失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .get <key>
    ctx.command(
      {
        name: 'get',
        description: '获取并发送已保存的便签内容',
        usage: '.get <名称:string>',
        args: [
          { name: '名称', type: 'string', required: true, description: '已保存便签的标识关键字' },
        ],
        examples: [
          '.get rules',
          '.get price',
        ],
      },
      async ({ command, editOrReply }) => {
        const key = command.args[0]?.trim();
        if (!key) {
          await editOrReply('用法示例: <code>.get rules</code>', { parseMode: 'html' });
          return;
        }

        try {
          const row = db.prepare('SELECT content FROM notes WHERE key = ?').get(key);
          if (!row) {
            await editOrReply(`⚠️ 未找到名为 <code>#${key}</code> 的便签。`, { parseMode: 'html', autoDeleteMs: 3000 });
            return;
          }

          await editOrReply(row.content);
        } catch (err) {
          await editOrReply(`❌ 读取便签失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .notes
    ctx.command(
      {
        name: 'notes',
        description: '列出当前账号所有已保存的便签列表',
        usage: '.notes',
        args: [],
        examples: [
          '.notes',
        ],
      },
      async ({ editOrReply }) => {
        try {
          const rows = db.prepare('SELECT key, updated_at FROM notes ORDER BY updated_at DESC').all();
          if (rows.length === 0) {
            await editOrReply('📝 <i>当前暂无任何保存的便签。</i>', { parseMode: 'html' });
            return;
          }

          const lines = [
            `📝 <b>已保存便签列表 (${rows.length}):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
          ];

          for (const item of rows) {
            const time = new Date(item.updated_at).toLocaleDateString('zh-CN');
            lines.push(`• <code>#${item.key}</code> (更新于 ${time})`);
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━');
          lines.push('💡 提示: 发送 <code>.get &lt;名称&gt;</code> 即可直接引用发送。');

          await editOrReply(lines.join('\n'), { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 获取便签列表失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );

    // 命令: .delnote <key>
    ctx.command(
      {
        name: 'delnote',
        description: '永久删除指定的便签',
        usage: '.delnote <名称:string>',
        args: [
          { name: '名称', type: 'string', required: true, description: '要删除的便签标识关键字' },
        ],
        examples: [
          '.delnote rules',
        ],
      },
      async ({ command, editOrReply }) => {
        const key = command.args[0]?.trim();
        if (!key) {
          await editOrReply('用法示例: <code>.delnote rules</code>', { parseMode: 'html' });
          return;
        }

        try {
          const res = db.prepare('DELETE FROM notes WHERE key = ?').run(key);
          if (res.changes > 0) {
            await editOrReply(`🗑️ <b>便签已删除:</b> <code>#${key}</code>`, { parseMode: 'html', autoDeleteMs: 3000 });
          } else {
            await editOrReply(`⚠️ 未找到名为 <code>#${key}</code> 的便签。`, { parseMode: 'html', autoDeleteMs: 3000 });
          }
        } catch (err) {
          await editOrReply(`❌ 删除便签失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};


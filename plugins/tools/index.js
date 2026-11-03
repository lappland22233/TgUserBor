'use strict';

/**
 * 智能源语言特征启发式检测
 */
function detectSourceLang(text) {
  if (/[\u4e00-\u9fa5]/.test(text)) return 'zh';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  return 'en';
}

/**
 * 多源翻译引擎（优先使用免代理的高可用翻译源，自动备用降级）
 */
async function translateText(text, targetLang = 'zh') {
  const normTarget = targetLang.toLowerCase();
  const detectedSrc = detectSourceLang(text);

  // 如果源语言与目标语言相同（例如输入英文要翻译为英文），自动调整目标语言
  let effectiveTarget = normTarget;
  if (detectedSrc === 'zh' && normTarget === 'zh') {
    effectiveTarget = 'en';
  } else if (detectedSrc === 'en' && normTarget === 'en') {
    effectiveTarget = 'zh';
  }

  // 1. 首选方案: MyMemory API (明确指定源语言与目标语言，准确率极高且国内免翻墙直连)
  try {
    const pair = `${detectedSrc}|${effectiveTarget}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const candidate = data?.responseData?.translatedText;
      if (candidate && candidate.trim().toLowerCase() !== text.trim().toLowerCase()) {
        return decodeHtmlEntities(candidate);
      }
      if (candidate) {
        return decodeHtmlEntities(candidate);
      }
    }
  } catch {
    /* 尝试备用渠道 */
  }

  // 2. 备选方案: Google Translate 接口 (带 4 秒超时)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
      effectiveTarget,
    )}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return decodeHtmlEntities(data[0].map((item) => item[0]).join(''));
      }
    }
  } catch {
    /* 忽略错误并抛出最终信息 */
  }

  throw new Error('所有可用翻译源均未能正常响应，请稍后重试或检查网络连通性。');
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * 纯数学算术求值解析器（严格禁止 eval 与 new Function，杜绝任何代码执行风险）
 */
function safeCalculate(expr) {
  let pos = 0;
  const str = expr.replace(/\s+/g, '');

  function parseNumber() {
    const start = pos;
    if (str[pos] === '-' || str[pos] === '+') pos++;
    while (pos < str.length && ((str[pos] >= '0' && str[pos] <= '9') || str[pos] === '.')) {
      pos++;
    }
    if (start === pos) throw new Error('无效的数字或字符: ' + (str[pos] || '结尾'));
    const num = Number(str.slice(start, pos));
    if (isNaN(num)) throw new Error('无效的数字: ' + str.slice(start, pos));
    return num;
  }

  function parseFactor() {
    if (pos >= str.length) throw new Error('意外的表达式结束');
    if (str[pos] === '(') {
      pos++; // 跳过 '('
      const val = parseExpression();
      if (str[pos] !== ')') throw new Error('缺少配对的右括号 ")"');
      pos++; // 跳过 ')'
      return val;
    }
    // 仅支持白名单纯数学函数: sqrt, abs, round, floor, ceil
    for (const fn of ['sqrt', 'abs', 'round', 'floor', 'ceil']) {
      if (str.startsWith(fn + '(', pos) || str.startsWith('Math.' + fn + '(', pos)) {
        pos += str.startsWith('Math.') ? 5 + fn.length + 1 : fn.length + 1;
        const val = parseExpression();
        if (str[pos] !== ')') throw new Error('缺少配对的右括号 ")"');
        pos++;
        return Math[fn](val);
      }
    }
    return parseNumber();
  }

  function parsePower() {
    let left = parseFactor();
    while (pos < str.length && (str[pos] === '^' || str.startsWith('**', pos))) {
      if (str.startsWith('**', pos)) pos += 2;
      else pos += 1;
      const right = parseFactor();
      left = Math.pow(left, right);
    }
    return left;
  }

  function parseTerm() {
    let left = parsePower();
    while (pos < str.length && (str[pos] === '*' || str[pos] === '/' || str[pos] === '%')) {
      const op = str[pos++];
      const right = parsePower();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('除数不能为零');
        left /= right;
      } else if (op === '%') left %= right;
    }
    return left;
  }

  function parseExpression() {
    let left = parseTerm();
    while (pos < str.length && (str[pos] === '+' || str[pos] === '-')) {
      const op = str[pos++];
      const right = parseTerm();
      if (op === '+') left += right;
      else if (op === '-') left -= right;
    }
    return left;
  }

  const result = parseExpression();
  if (pos < str.length) {
    throw new Error('未识别的多余字符: ' + str.slice(pos));
  }
  return result;
}

module.exports = {
  manifest: {
    name: 'tools',
    version: '1.0.0',
    description: '实用日常工具箱：.id、.calc、.time、.tr',
  },

  activate(ctx) {
    // 命令: .id
    ctx.command(
      {
        name: 'id',
        description: '获取数字 ID、当前会话及消息元数据',
        usage: '.id',
        args: [],
        examples: [
          '.id (查询当前会话及自身 ID)',
          '.id (回复某人消息查询其 UserID 及详细元数据)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        const msg = command.message;
        const lines = [];

        lines.push('🆔 <b>Telegram 对象信息查询</b>');
        lines.push('━━━━━━━━━━━━━━━━━━━━');

        if (msg.isReply && msg.replyToMessageId) {
          try {
            const rawClient = bot.adapter.raw();
            const repliedMsgs = await rawClient.getMessages(BigInt(msg.chat.id), {
              ids: [msg.replyToMessageId],
            });
            const rMsg = repliedMsgs[0];
            if (rMsg) {
              const sender = await rMsg.getSender();
              lines.push('👤 <b>被回复用户:</b>');
              lines.push(`  • <b>用户 ID:</b> <code>${sender?.id ?? '未知'}</code>`);
              if (sender?.username) lines.push(`  • <b>用户名:</b> @${sender.username}`);
              if (sender?.firstName) lines.push(`  • <b>昵称:</b> ${sender.firstName} ${sender.lastName || ''}`);
              lines.push(`  • <b>被回复消息 ID:</b> <code>${msg.replyToMessageId}</code>`);
              lines.push('');
            }
          } catch {
            lines.push(`  • <b>被回复消息 ID:</b> <code>${msg.replyToMessageId}</code>\n`);
          }
        }

        const chatTypeMap = {
          private: '私聊 (Private)',
          group: '普通群组 (Group)',
          supergroup: '超级群组 (Supergroup)',
          channel: '频道 (Channel)',
          unknown: '未知类型',
        };

        lines.push('💬 <b>当前所在会话:</b>');
        lines.push(`  • <b>会话 ID:</b> <code>${msg.chat.id}</code>`);
        lines.push(`  • <b>会话类型:</b> ${chatTypeMap[msg.chat.type] || msg.chat.type}`);
        if (msg.chat.title) lines.push(`  • <b>会话名称:</b> ${msg.chat.title}`);
        if (msg.chat.username) lines.push(`  • <b>公开链接:</b> @${msg.chat.username}`);

        lines.push('');
        lines.push('🙋‍♂️ <b>发送者 (您):</b>');
        lines.push(`  • <b>用户 ID:</b> <code>${msg.from.id}</code>`);
        if (msg.from.username) lines.push(`  • <b>用户名:</b> @${msg.from.username}`);
        lines.push(`  • <b>当前消息 ID:</b> <code>${msg.id}</code>`);
        lines.push('━━━━━━━━━━━━━━━━━━━━');

        await editOrReply(lines.join('\n'), { parseMode: 'html' });
      },
    );

    // 命令: .calc <expression>
    ctx.command(
      {
        name: 'calc',
        description: '快速数学算术求值计算器 (安全无风险引擎)',
        usage: '.calc <数学表达式:string>',
        args: [
          { name: '数学表达式', type: 'string', required: true, description: '算术表达式 (例如 12*8+64、2^10、Math.sqrt(144))' },
        ],
        examples: [
          '.calc 12 * 8 + 64',
          '.calc 2^10',
          '.calc Math.sqrt(144) + 10',
        ],
      },
      async ({ command, editOrReply }) => {
        const expr = command.rawArgs;
        if (!expr) {
          await editOrReply('用法示例: <code>.calc 12 * 8 + Math.sqrt(100)</code>', { parseMode: 'html' });
          return;
        }

        try {
          const result = safeCalculate(expr);
          await editOrReply(
            `🧮 <b>计算器运算结果:</b>\n<code>${expr}</code>\n\n<b>=</b> <code>${result}</code>`,
            { parseMode: 'html' },
          );
        } catch (err) {
          await editOrReply(`❌ 计算错误: <code>${err.message}</code>`, { parseMode: 'html' });
        }
      },
    );

    // 命令: .time
    ctx.command(
      {
        name: 'time',
        description: '查看全球主要时区当前实时标准时间',
        usage: '.time',
        args: [],
        examples: ['.time'],
      },
      async ({ editOrReply }) => {
        const now = new Date();
        const formatTz = (tz, label) => {
          const str = now.toLocaleString('zh-CN', { timeZone: tz, hour12: false });
          return `• <b>${label}:</b> <code>${str}</code>`;
        };

        const lines = [
          '🕒 <b>世界时钟看板</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          formatTz('Asia/Shanghai', '🇨🇳 北京 / 上海 (UTC+8)'),
          formatTz('Asia/Tokyo', '🇯🇵 东京 (UTC+9)'),
          formatTz('UTC', '🌐 标准协调时 (UTC)'),
          formatTz('Europe/London', '🇬🇧 伦敦 (UTC+0/+1)'),
          formatTz('America/New_York', '🇺🇸 纽约 (UTC-5/-4)'),
          formatTz('America/Los_Angeles', '🇺🇸 洛杉矶 (UTC-8/-7)'),
          '━━━━━━━━━━━━━━━━━━━━',
        ];

        await editOrReply(lines.join('\n'), { parseMode: 'html' });
      },
    );

    const KNOWN_LANGS = new Set([
      'zh', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'it', 'pt',
      'ar', 'vi', 'th', 'id', 'tr', 'nl', 'pl', 'uk', 'fa', 'hi',
      'sv', 'no', 'da', 'fi', 'el', 'he', 'cs', 'ro', 'hu', 'sk',
      'bg', 'hr', 'sr', 'ms', 'zh-cn', 'zh-tw'
    ]);

    // 命令: .tr [lang] <text>
    ctx.command(
      {
        name: 'tr',
        description: '多语言翻译文本或所回复的消息 (自动检测/指定语种)',
        usage: '.tr [目标语言:choice[zh|en|ja|ko|ru|fr|de...]=auto] [文本:string]',
        args: [
          { name: '目标语言', type: 'choice[zh|en|ja|ko|ru|fr|de...]', required: false, default: 'auto', description: '目标语言代码 (留空时：中文自动翻英文，外文自动翻中文)' },
          { name: '文本', type: 'string', required: false, description: '待翻译文本内容 (若回复消息则自动提取被回复内容)' },
        ],
        examples: [
          '.tr hello world (自动翻中文)',
          '.tr 你好世界 (自动翻英文)',
          '.tr ja 早上好 (指定翻日文)',
          '.tr (回复任意一条消息直接翻译)',
        ],
      },
      async ({ command, editOrReply, bot }) => {
        let targetLang = '';
        let textToTranslate = '';

        const args = command.args;
        const msg = command.message;

        // 检查是否为回复消息
        if (msg.isReply && msg.replyToMessageId) {
          try {
            const rawClient = bot.adapter.raw();
            const repliedMsgs = await rawClient.getMessages(BigInt(msg.chat.id), {
              ids: [msg.replyToMessageId],
            });
            const rMsg = repliedMsgs[0];
            if (rMsg?.message) {
              textToTranslate = rMsg.message;
              if (args[0] && KNOWN_LANGS.has(args[0].toLowerCase())) {
                targetLang = args[0].toLowerCase();
              }
            }
          } catch {
            /* ignore */
          }
        }

        if (!textToTranslate) {
          if (!command.rawArgs || !command.rawArgs.trim()) {
            await editOrReply(
              '用法示例:\n• <code>.tr hello world</code> (自动翻译为中文)\n• <code>.tr 你好世界</code> (自动翻译为英文)\n• <code>.tr ja 早上好</code> (指定翻译为日文)\n• 或直接回复任意消息发送 <code>.tr</code>',
              { parseMode: 'html' },
            );
            return;
          }

          if (args.length >= 2 && KNOWN_LANGS.has(args[0].toLowerCase())) {
            targetLang = args[0].toLowerCase();
            textToTranslate = command.rawArgs.slice(args[0].length).trim();
          } else {
            textToTranslate = command.rawArgs.trim();
          }
        }

        // 智能确定目标语言：若未显式指定，文本含中文则默认译为英文，否则默认译为中文
        if (!targetLang) {
          targetLang = /[\u4e00-\u9fa5]/.test(textToTranslate) ? 'en' : 'zh';
        }

        await editOrReply('🌐 <i>正在翻译中...</i>', { parseMode: 'html' });

        try {
          const translated = await translateText(textToTranslate, targetLang);
          const output = [
            `🌐 <b>翻译结果 (${targetLang.toUpperCase()}):</b>`,
            '━━━━━━━━━━━━━━━━━━━━',
            translated,
            '━━━━━━━━━━━━━━━━━━━━',
          ].join('\n');
          await editOrReply(output, { parseMode: 'html' });
        } catch (err) {
          await editOrReply(`❌ 翻译失败: ${err.message}`);
        }
      },
    );

    // 命令: .qr <文本或网址>
    ctx.command(
      {
        name: 'qr',
        description: '快速将文本或链接生成二维码图片发送',
        usage: '.qr <文本或链接:string>',
        args: [
          { name: '文本或链接', type: 'string', required: true, description: '要编码进二维码的纯文本或 URL 链接' },
        ],
        examples: [
          '.qr https://t.me/telegram',
          '.qr 欢迎关注我的频道',
        ],
      },
      async ({ command, editOrReply }) => {
        const text = command.rawArgs.trim();
        if (!text) {
          await editOrReply('用法示例: <code>.qr https://t.me/telegram</code>', { parseMode: 'html' });
          return;
        }

        await editOrReply('📱 <i>正在生成二维码...</i>', { parseMode: 'html' });

        try {
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&margin=10&data=${encodeURIComponent(text)}`;
          await ctx.sendPhoto(command.message.chat.id, qrUrl, {
            caption: `📱 <b>二维码生成成功:</b>\n<code>${text}</code>`,
            parseMode: 'html',
            replyTo: command.message.replyToMessageId,
          });

          if (command.message.outgoing) {
            await ctx.bot.deleteMessage(command.message.chat.id, command.message.id).catch(() => {});
          }
        } catch (err) {
          await editOrReply(`❌ 生成二维码失败: ${err.message}`, { autoDeleteMs: 4000 });
        }
      },
    );
  },
};

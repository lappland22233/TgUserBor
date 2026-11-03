import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database } from '../../bot/database';
import type { InstanceManager } from '../../manager';
import type { CacheManager } from '../cache-manager';

function parseJsonBody<T = any>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        // 1MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({} as T);
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

export async function handleApiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: InstanceManager,
  pluginsDir: string,
  cache?: CacheManager,
): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // --- 1. Global Status & System Metrics ---
  if (pathname === '/api/status' && method === 'GET') {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const instances = manager.getAllInfo();
    const onlineCount = instances.filter((i) => i.status === 'ONLINE').length;

    sendJson(res, 200, {
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpuCores: os.cpus().length,
        uptime: os.uptime(),
        memory: {
          total: totalMem,
          free: freeMem,
          used: usedMem,
          percent: Math.round((usedMem / totalMem) * 100),
        },
      },
      instances: {
        total: instances.length,
        online: onlineCount,
      },
    });
    return true;
  }

  // --- 1.5 Cache System Endpoints ---
  if (pathname === '/api/cache/stats' && method === 'GET') {
    const stats = cache ? cache.getStats() : { usedBytes: 0, maxBytes: 5 * 1024 * 1024 * 1024, usedMB: 0, maxMB: 5120, percent: 0, fileCount: 0, memDialogsCount: 0, memChatsCount: 0 };
    sendJson(res, 200, stats);
    return true;
  }

  if (pathname === '/api/cache/limit' && method === 'POST') {
    try {
      const body = await parseJsonBody<{ maxMB: number }>(req);
      if (cache && typeof body.maxMB === 'number' && body.maxMB >= 100) {
        cache.setLimit(body.maxMB * 1024 * 1024);
      }
      sendJson(res, 200, cache ? cache.getStats() : { success: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/cache/clear' && method === 'POST') {
    if (cache) cache.clearAll();
    sendJson(res, 200, cache ? cache.getStats() : { success: true });
    return true;
  }

  // --- 2. Instance Endpoints ---
  if (pathname === '/api/instances' && method === 'GET') {
    sendJson(res, 200, manager.getAllInfo());
    return true;
  }

  if (pathname === '/api/instances' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.id || !body.apiId || !body.apiHash || !body.ownerId) {
        sendJson(res, 400, { error: 'Missing required fields: id, apiId, apiHash, ownerId' });
        return true;
      }
      const inst = manager.createInstance({
        id: String(body.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        name: body.name || `Bot (${body.id})`,
        apiId: Number(body.apiId),
        apiHash: String(body.apiHash).trim(),
        ownerId: Number(body.ownerId),
        prefixes: Array.isArray(body.prefixes) && body.prefixes.length > 0 ? body.prefixes : ['.', '/'],
        proxy: body.proxy,
        autoStart: Boolean(body.autoStart),
      });
      sendJson(res, 201, inst.getInfo());
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // Single instance operations: /api/instances/:id/...
  const instMatch = pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
  if (instMatch) {
    const instId = instMatch[1];
    const subRoute = instMatch[2] || '';
    const inst = manager.getInstance(instId);

    if (!inst && subRoute !== '') {
      sendJson(res, 404, { error: `Instance "${instId}" not found` });
      return true;
    }

    if (subRoute === '' && method === 'GET') {
      if (!inst) return sendJson(res, 404, { error: 'Instance not found' }), true;
      sendJson(res, 200, inst.getInfo());
      return true;
    }

    if (subRoute === '' && method === 'PUT') {
      try {
        const body = await parseJsonBody(req);
        const updated = manager.updateInstance(instId, body);
        sendJson(res, 200, updated.getInfo());
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === '' && method === 'DELETE') {
      const deleted = await manager.deleteInstance(instId);
      sendJson(res, 200, { success: deleted });
      return true;
    }

    if (subRoute === 'start' && method === 'POST') {
      await inst!.start();
      sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      return true;
    }

    if (subRoute === 'stop' && method === 'POST') {
      await inst!.stop();
      sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      return true;
    }

    if (subRoute === 'restart' && method === 'POST') {
      await inst!.restart();
      sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      return true;
    }

    if (subRoute === 'auth' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.step || body.value === undefined) {
        sendJson(res, 400, { error: 'Missing step or value' });
        return true;
      }
      inst!.submitAuth(body.step, String(body.value));
      sendJson(res, 200, { success: true });
      return true;
    }

    if (subRoute === 'logs' && method === 'GET') {
      sendJson(res, 200, inst!.getLogs(100));
      return true;
    }

    // Instance notes inspection: GET/DELETE /api/instances/:id/notes
    if (subRoute === 'notes' && method === 'GET') {
      try {
        const dbPath = inst!.config.dbPath;
        if (!fs.existsSync(dbPath)) {
          sendJson(res, 200, []);
          return true;
        }
        const db = new Database(dbPath);
        const notes = db.raw().prepare('SELECT * FROM notes ORDER BY updated_at DESC').all();
        db.close();
        sendJson(res, 200, notes);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    const noteDeleteMatch = subRoute.match(/^notes\/(.+)$/);
    if (noteDeleteMatch && method === 'DELETE') {
      try {
        const key = decodeURIComponent(noteDeleteMatch[1]);
        const dbPath = inst!.config.dbPath;
        if (fs.existsSync(dbPath)) {
          const db = new Database(dbPath);
          db.raw().prepare('DELETE FROM notes WHERE key = ?').run(key);
          db.close();
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // Per-instance plugin toggle: POST /api/instances/:id/plugins/:name/toggle
    const pluginToggleMatch = subRoute.match(/^plugins\/([a-zA-Z0-9_-]+)\/(enable|disable|reload)$/);
    if (pluginToggleMatch && method === 'POST') {
      const pluginName = pluginToggleMatch[1];
      const action = pluginToggleMatch[2] as 'enable' | 'disable' | 'reload';
      try {
        await inst!.pluginAction(action, pluginName);
        sendJson(res, 200, { success: true, plugin: pluginName, action });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // --- 账号客户端操作端点 (Official Client-like Account Operations) ---
    if (subRoute === 'account/dialogs' && method === 'GET') {
      try {
        const limit = Number(url.searchParams.get('limit')) || 50;
        const dialogs = await inst!.accountAction('get_dialogs', { limit });
        sendJson(res, 200, dialogs || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/messages' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const limit = Number(url.searchParams.get('limit')) || 40;
        const offsetId = url.searchParams.get('offsetId') ? Number(url.searchParams.get('offsetId')) : undefined;
        const search = url.searchParams.get('search') || undefined;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const messages = await inst!.accountAction('get_messages', { chatId, limit, offsetId, search });
        sendJson(res, 200, messages || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, text, options } = body;
        if (!chatId || !text) return sendJson(res, 400, { error: 'Missing chatId or text' }), true;
        const result = await inst!.accountAction('send_message', { chatId, text, options });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, text, options } = body;
        if (!chatId || !messageId || !text) return sendJson(res, 400, { error: 'Missing chatId, messageId or text' }), true;
        const result = await inst!.accountAction('edit_message', { chatId, messageId, text, options });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/reaction' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, reaction } = body;
        if (!chatId || !messageId) return sendJson(res, 400, { error: 'Missing chatId or messageId' }), true;
        const result = await inst!.accountAction('send_reaction', { chatId, messageId, reaction });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/pin' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, silent = false } = body;
        if (!chatId || !messageId) return sendJson(res, 400, { error: 'Missing chatId or messageId' }), true;
        const result = await inst!.accountAction('pin_message', { chatId, messageId, silent });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/unpin' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId } = body;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const result = await inst!.accountAction('unpin_message', { chatId, messageId });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/forward' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { fromChatId, toChatId, messageIds } = body;
        if (!fromChatId || !toChatId || !messageIds) return sendJson(res, 400, { error: 'Missing fromChatId, toChatId or messageIds' }), true;
        const result = await inst!.accountAction('forward_messages', { fromChatId, toChatId, messageIds });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/read' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, maxId } = body;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        await inst!.accountAction('mark_as_read', { chatId, maxId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/delete-messages' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageIds } = body;
        if (!chatId || !Array.isArray(messageIds)) return sendJson(res, 400, { error: 'Missing chatId or messageIds' }), true;
        const result = await inst!.accountAction('delete_messages', { chatId, messageIds });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/purge' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, count = 10 } = body;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const result = await inst!.accountAction('quick_purge', { chatId, count });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/leave' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId } = body;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        await inst!.accountAction('leave_chat', { chatId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/participants' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        const limit = Number(url.searchParams.get('limit')) || 100;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const participants = await inst!.accountAction('get_participants', { chatId: Number(chatId), limit });
        sendJson(res, 200, participants || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/kick' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, userId } = body;
        if (!chatId || !userId) return sendJson(res, 400, { error: 'Missing chatId or userId' }), true;
        await inst!.accountAction('kick_user', { chatId: Number(chatId), userId: Number(userId) });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/ban' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, userId, untilDate } = body;
        if (!chatId || !userId) return sendJson(res, 400, { error: 'Missing chatId or userId' }), true;
        await inst!.accountAction('ban_user', { chatId: Number(chatId), userId: Number(userId), untilDate: Number(untilDate || 0) });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/mute' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, userId, seconds } = body;
        if (!chatId || !userId) return sendJson(res, 400, { error: 'Missing chatId or userId' }), true;
        await inst!.accountAction('mute_user', { chatId: Number(chatId), userId: Number(userId), seconds: Number(seconds || 0) });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/translate' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { text, targetLang = 'zh-CN' } = body;
        if (!text) return sendJson(res, 400, { error: 'Missing text' }), true;

        let srcLang = 'en';
        if (/[\u0400-\u04FF]/.test(text)) srcLang = 'ru';
        else if (/[\u3040-\u30FF]/.test(text)) srcLang = 'ja';
        else if (/[\uAC00-\uD7AF]/.test(text)) srcLang = 'ko';
        else if (/[\u4E00-\u9FFF]/.test(text)) srcLang = 'zh-CN';

        const finalTarget = (srcLang === 'zh-CN' && targetLang === 'zh-CN') ? 'en' : targetLang;
        const langpair = `${srcLang}|${finalTarget}`;

        const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${encodeURIComponent(langpair)}`;
        const response = await fetch(apiUrl, { signal: AbortSignal.timeout(6000) });
        const data: any = await response.json();
        const translatedText = data?.responseData?.translatedText || text;

        sendJson(res, 200, {
          originalText: text,
          translatedText,
          srcLang,
          targetLang: finalTarget,
        });
      } catch (err: any) {
        sendJson(res, 500, { error: `翻译服务异常: ${err.message}` });
      }
      return true;
    }

    if (subRoute === 'account/poll' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, question, options, pollOptions } = body;
        if (!chatId || !question || !Array.isArray(options) || options.length < 2) {
          return sendJson(res, 400, { error: 'Missing chatId, question or at least 2 options' }), true;
        }
        const result = await inst!.accountAction('send_poll', { chatId, question, options, pollOptions });
        sendJson(res, 200, result || { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/vote' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, optionIndexes } = body;
        if (!chatId || !messageId || !Array.isArray(optionIndexes)) {
          return sendJson(res, 400, { error: 'Missing chatId, messageId or optionIndexes' }), true;
        }
        await inst!.accountAction('send_vote', { chatId, messageId, optionIndexes });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/mute-chat' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, muteUntil } = body;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        await inst!.accountAction('set_chat_mute', { chatId, muteUntil });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/mark-all-read' && method === 'POST') {
      try {
        await inst!.accountAction('mark_all_read');
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/profile' && method === 'GET') {
      try {
        const profile = await inst!.accountAction('get_profile');
        sendJson(res, 200, profile || inst!.getInfo().self || {});
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/profile' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        await inst!.accountAction('update_profile', body);
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/status' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        await inst!.accountAction('set_online', { online: Boolean(body.online) });
        sendJson(res, 200, { success: true, online: Boolean(body.online) });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/typing' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        await inst!.accountAction('send_typing', { chatId: body.chatId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/contacts' && method === 'GET') {
      try {
        const contacts = await inst!.accountAction('get_contacts');
        sendJson(res, 200, contacts || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/broadcast' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatIds, text, intervalMs } = body;
        if (!Array.isArray(chatIds) || chatIds.length === 0 || !text) {
          return sendJson(res, 400, { error: 'chatIds array and text are required' }), true;
        }
        const results = await inst!.accountAction('broadcast', { chatIds, text, intervalMs });
        sendJson(res, 200, { success: true, results });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/resolve' && method === 'GET') {
      try {
        const query = url.searchParams.get('query');
        if (!query) return sendJson(res, 400, { error: 'Missing query' }), true;
        const result = await inst!.accountAction('resolve_peer', { query });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/avatar' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        const isBig = url.searchParams.get('isBig') === '1';
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;

        // 1. 尝试从服务端长期磁盘缓存中命中 (秒级响应)
        const cachedPath = cache ? cache.getAvatarPath(instId, chatId) : null;
        if (cachedPath && fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 0) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable',
          });
          fs.createReadStream(cachedPath).pipe(res);
          return true;
        }

        const data = await inst!.accountAction('get_avatar', { chatId: Number(chatId), isBig });
        if (data && data.filePath && fs.existsSync(data.filePath)) {
          if (cachedPath && cache) {
            cache.saveFile(data.filePath, cachedPath);
          }
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/user-photos' && method === 'GET') {
      try {
        const userId = url.searchParams.get('userId');
        const limit = Number(url.searchParams.get('limit')) || 10;
        if (!userId) return sendJson(res, 400, { error: 'Missing userId' }), true;
        const photos = await inst!.accountAction('get_user_photos', { userId: Number(userId), limit });
        sendJson(res, 200, photos || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/user-photo-file' && method === 'GET') {
      try {
        const userId = url.searchParams.get('userId');
        const index = Number(url.searchParams.get('index')) || 0;
        if (!userId) return sendJson(res, 400, { error: 'Missing userId' }), true;
        const data = await inst!.accountAction('get_user_photo_file', { userId: Number(userId), index });
        if (data && data.filePath && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/peer-profile' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const profile = await inst!.accountAction('get_peer_profile', { chatId: Number(chatId) });
        sendJson(res, 200, profile);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;
        const stories = await inst!.accountAction('get_peer_stories', { chatId: Number(chatId) });
        sendJson(res, 200, stories || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/media' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        const messageId = url.searchParams.get('messageId');
        const thumb = url.searchParams.get('thumb') === '1';
        const download = url.searchParams.get('download') === '1';
        if (!chatId || !messageId) return sendJson(res, 400, { error: 'Missing chatId or messageId' }), true;

        // 缩略图长期磁盘缓存加速
        const thumbCachePath = (thumb && cache) ? cache.getThumbPath(instId, chatId, messageId) : null;
        if (thumbCachePath && fs.existsSync(thumbCachePath) && fs.statSync(thumbCachePath).size > 0) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable',
          });
          fs.createReadStream(thumbCachePath).pipe(res);
          return true;
        }

        const data = await inst!.accountAction('get_message_media', {
          chatId: Number(chatId),
          messageId: Number(messageId),
          thumb,
        });

        if (data && data.filePath && fs.existsSync(data.filePath)) {
          if (thumbCachePath && cache) {
            cache.saveFile(data.filePath, thumbCachePath);
          }
          const stat = fs.statSync(data.filePath);
          const totalSize = stat.size;
          const mimeType = data.mimeType || 'application/octet-stream';
          const headers: Record<string, string> = {
            'Content-Type': mimeType,
            'Cache-Control': thumb ? 'public, max-age=604800, immutable' : 'public, max-age=86400',
            'Accept-Ranges': 'bytes',
          };
          if (download) {
            const fName = encodeURIComponent(data.fileName || `media_${messageId}`);
            headers['Content-Disposition'] = `attachment; filename="${fName}"`;
          }

          const range = req.headers.range;
          if (range && !thumb) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

            if (isNaN(start) || start >= totalSize || end >= totalSize || start > end) {
              res.writeHead(416, {
                'Content-Range': `bytes */${totalSize}`,
              });
              res.end();
              return true;
            }

            const chunkSize = (end - start) + 1;
            headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
            headers['Content-Length'] = String(chunkSize);
            res.writeHead(206, headers);
            fs.createReadStream(data.filePath, { start, end }).pipe(res);
            return true;
          }

          headers['Content-Length'] = String(totalSize);
          res.writeHead(200, headers);
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Media not found or failed to download');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/chat-media' && method === 'GET') {
      try {
        const chatId = url.searchParams.get('chatId');
        const filterType = (url.searchParams.get('type') || 'music') as any;
        const limit = Number(url.searchParams.get('limit')) || 50;
        if (!chatId) return sendJson(res, 400, { error: 'Missing chatId' }), true;

        const mediaMessages = await inst!.accountAction('get_chat_media', {
          chatId: Number(chatId),
          filterType,
          limit,
        });
        sendJson(res, 200, mediaMessages || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-media' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, mediaType, fileBase64, fileName, caption, replyTo } = body;
        if (!chatId || !fileBase64) {
          return sendJson(res, 400, { error: 'Missing chatId or fileBase64' }), true;
        }
        const result = await inst!.accountAction('send_media', {
          chatId: Number(chatId),
          mediaType,
          fileBase64,
          fileName,
          caption,
          replyTo: replyTo ? Number(replyTo) : undefined,
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stickers' && method === 'GET') {
      try {
        const sets = await inst!.accountAction('get_all_stickers', {});
        sendJson(res, 200, sets || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/sticker-set' && method === 'GET') {
      try {
        const setId = url.searchParams.get('setId') || undefined;
        const accessHash = url.searchParams.get('accessHash') || undefined;
        const shortName = url.searchParams.get('shortName') || undefined;
        if (!shortName && (!setId || !accessHash)) {
          return sendJson(res, 400, { error: 'Missing setId/accessHash or shortName' }), true;
        }
        const details = await inst!.accountAction('get_sticker_set', { setId, accessHash, shortName });
        sendJson(res, 200, details);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/sticker-thumb' && method === 'GET') {
      try {
        const docId = url.searchParams.get('docId');
        const accessHash = url.searchParams.get('accessHash');
        const fileRef = url.searchParams.get('fileRef') || '';
        if (!docId || !accessHash) return sendJson(res, 400, { error: 'Missing docId or accessHash' }), true;
        const data = await inst!.accountAction('get_sticker_thumb', { docId, accessHash, fileReference: fileRef });
        if (data && data.filePath && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=604800',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Sticker thumb not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/gifs' && method === 'GET') {
      try {
        const gifs = await inst!.accountAction('get_saved_gifs', {});
        sendJson(res, 200, gifs || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-sticker' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, docId, accessHash, fileReference, replyTo } = body;
        if (!chatId || !docId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing chatId, docId, or accessHash' }), true;
        }
        const result = await inst!.accountAction('send_sticker_document', {
          chatId: Number(chatId),
          docId: String(docId),
          accessHash: String(accessHash),
          fileReference: String(fileReference || ''),
          replyTo: replyTo ? Number(replyTo) : undefined,
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-gif' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, docId, accessHash, fileReference, replyTo } = body;
        if (!chatId || !docId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing chatId, docId, or accessHash' }), true;
        }
        const result = await inst!.accountAction('send_gif_document', {
          chatId: Number(chatId),
          docId: String(docId),
          accessHash: String(accessHash),
          fileReference: String(fileReference || ''),
          replyTo: replyTo ? Number(replyTo) : undefined,
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stickers/install' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { setId, accessHash } = body;
        if (!setId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing setId or accessHash' }), true;
        }
        const result = await inst!.accountAction('install_sticker_set', { setId, accessHash });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stickers/uninstall' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { setId, accessHash } = body;
        if (!setId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing setId or accessHash' }), true;
        }
        const result = await inst!.accountAction('uninstall_sticker_set', { setId, accessHash });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    // --- 定时与循环消息调度端点 (Scheduled Tasks Management) ---
    if (subRoute === 'schedule' && method === 'GET') {
      try {
        const dbPath = inst!.config.dbPath;
        if (!fs.existsSync(dbPath)) {
          sendJson(res, 200, { serverTime: Date.now(), tasks: [] });
          return true;
        }
        const db = new Database(dbPath);
        try {
          db.raw().prepare('ALTER TABLE scheduled_tasks ADD COLUMN time_spec TEXT').run();
        } catch {}
        const tasks = db.raw().prepare('SELECT * FROM scheduled_tasks ORDER BY id DESC').all();
        db.close();
        sendJson(res, 200, {
          serverTime: Date.now(),
          serverTimeString: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
          tasks,
        });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'schedule' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, content, type = 'interval', timeSpec, intervalMs = 60000, repeat = 1 } = body;
        if (!chatId || !content) {
          sendJson(res, 400, { error: '目标会话 (chatId) 与消息内容 (content) 不能为空' });
          return true;
        }

        const dbPath = inst!.config.dbPath;
        const db = new Database(dbPath);
        try {
          db.raw().prepare('ALTER TABLE scheduled_tasks ADD COLUMN time_spec TEXT').run();
        } catch {}

        const now = Date.now();
        let nextRun = now;
        let effectiveTimeSpec = timeSpec || null;
        let effectiveInterval = Number(intervalMs) || 60000;
        let effectiveRepeat = repeat ? 1 : 0;

        if (type === 'daily') {
          const cleanTime = String(timeSpec || '00:01').trim();
          effectiveTimeSpec = cleanTime.startsWith('daily:') ? cleanTime : `daily:${cleanTime}`;
          const calcNext = (tStr: string) => {
            const m = tStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
            if (!m) return now + 86400000;
            const h = parseInt(m[1], 10);
            const min = parseInt(m[2], 10);
            const s = m[3] ? parseInt(m[3], 10) : 0;
            const d = new Date(now);
            const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, s, 0);
            if (target.getTime() <= now) target.setDate(target.getDate() + 1);
            return target.getTime();
          };
          nextRun = calcNext(cleanTime.replace(/^daily:/, ''));
          effectiveInterval = 86400000;
          effectiveRepeat = 1;
        } else if (type === 'once') {
          effectiveRepeat = 0;
          nextRun = now + effectiveInterval;
        } else {
          nextRun = now + effectiveInterval;
          effectiveRepeat = 1;
        }

        const resDb = db.raw().prepare(`
          INSERT INTO scheduled_tasks (chat_id, interval_ms, content, repeat, enabled, created_by, created_at, next_run_at, time_spec)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(
          Number(chatId) || chatId,
          effectiveInterval,
          content,
          effectiveRepeat,
          inst!.config.ownerId,
          now,
          nextRun,
          effectiveTimeSpec
        );

        db.close();

        // 刷新插件调度任务
        if (inst!.getInfo().status === 'ONLINE') {
          try {
            await inst!.pluginAction('reload', 'schedule');
          } catch {}
        }

        sendJson(res, 201, {
          success: true,
          taskId: Number(resDb.lastInsertRowid),
          nextRun,
        });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    const schedTaskMatch = subRoute.match(/^schedule\/(\d+)(?:\/(toggle|run))?$/);
    if (schedTaskMatch) {
      const taskId = Number(schedTaskMatch[1]);
      const action = schedTaskMatch[2];
      const dbPath = inst!.config.dbPath;

      if (method === 'DELETE') {
        try {
          const db = new Database(dbPath);
          db.raw().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
          db.close();
          if (inst!.getInfo().status === 'ONLINE') {
            try { await inst!.pluginAction('reload', 'schedule'); } catch {}
          }
          sendJson(res, 200, { success: true });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message });
        }
        return true;
      }

      if (action === 'toggle' && method === 'POST') {
        try {
          const db = new Database(dbPath);
          const row = db.raw().prepare('SELECT enabled FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
          if (row) {
            const newEn = row.enabled ? 0 : 1;
            db.raw().prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(newEn, taskId);
          }
          db.close();
          if (inst!.getInfo().status === 'ONLINE') {
            try { await inst!.pluginAction('reload', 'schedule'); } catch {}
          }
          sendJson(res, 200, { success: true });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message });
        }
        return true;
      }

      if (action === 'run' && method === 'POST') {
        try {
          const db = new Database(dbPath);
          const task = db.raw().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
          db.close();
          if (!task) {
            sendJson(res, 404, { error: 'Task not found' });
            return true;
          }
          if (inst!.getInfo().status !== 'ONLINE') {
            sendJson(res, 400, { error: '账号实例未在线，无法立即发送' });
            return true;
          }
          await inst!.accountAction('send_message', { chatId: task.chat_id, text: task.content });
          sendJson(res, 200, { success: true });
        } catch (err: any) {
          sendJson(res, 500, { error: err.message });
        }
        return true;
      }
    }
  }

  // --- 3. Global Plugin Center Endpoints ---
  if (pathname === '/api/plugins' && method === 'GET') {
    if (!fs.existsSync(pluginsDir)) {
      sendJson(res, 200, []);
      return true;
    }

    const dirs = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const pluginList = [];
    for (const name of dirs) {
      const manifestPath = path.join(pluginsDir, name, 'plugin.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          pluginList.push({
            name: manifest.name || name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            author: manifest.author || 'User',
            entry: manifest.entry || 'index.js',
            configSchema: manifest.configSchema || [],
          });
        } catch {
          pluginList.push({ name, version: '1.0.0', description: 'Manifest error' });
        }
      }
    }
    sendJson(res, 200, pluginList);
    return true;
  }

  if (pathname === '/api/plugins' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name) {
        sendJson(res, 400, { error: 'Invalid or missing plugin name' });
        return true;
      }

      const pluginFolder = path.join(pluginsDir, name);
      if (fs.existsSync(pluginFolder)) {
        sendJson(res, 400, { error: `Plugin "${name}" already exists` });
        return true;
      }

      fs.mkdirSync(pluginFolder, { recursive: true });

      const manifest = {
        name,
        version: body.version || '1.0.0',
        description: body.description || 'Custom UserBot plugin',
        entry: 'index.js',
      };
      fs.writeFileSync(path.join(pluginFolder, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      // Generate scaffold index.js code
      const sampleCode = body.code || `'use strict';

module.exports = {
  manifest: {
    name: '${name}',
    version: '${manifest.version}',
    description: '${manifest.description}',
  },

  activate(ctx) {
    ctx.command(
      {
        name: '${name}',
        description: '执行 ${name} 插件的主要业务功能',
        usage: '.${name} [可选文本内容]',
        args: [
          {
            name: 'text',
            type: 'string',
            required: false,
            description: '要处理或传递的自定义文本参数',
          },
        ],
        examples: [
          '.${name}',
          '.${name} 你好世界',
        ],
      },
      async ({ command, editOrReply }) => {
        const input = command.args.join(' ') || '未携带参数';
        await editOrReply('✨ <b>${name}</b> 插件执行成功！参数内容: <code>' + input + '</code>', { parseMode: 'html' });
      },
    );
  },

  deactivate(ctx) {
    // 插件注销/热重载时的清理逻辑
  },
};
`;

      fs.writeFileSync(path.join(pluginFolder, 'index.js'), sampleCode, 'utf-8');

      // Notify all running instances
      await manager.broadcastPluginAction('reload', name);

      sendJson(res, 201, { success: true, plugin: manifest });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // Delete / Uninstall plugin: DELETE /api/plugins/:name
  const pluginDeleteMatch = pathname.match(/^\/api\/plugins\/([a-zA-Z0-9_-]+)$/);
  if (pluginDeleteMatch && method === 'DELETE') {
    const pluginName = pluginDeleteMatch[1];
    const pluginFolder = path.join(pluginsDir, pluginName);

    if (!fs.existsSync(pluginFolder)) {
      sendJson(res, 404, { error: `Plugin "${pluginName}" not found` });
      return true;
    }

    try {
      // 1. Disable across all running instances
      await manager.broadcastPluginAction('disable', pluginName);

      // 2. Remove directory
      fs.rmSync(pluginFolder, { recursive: true, force: true });
      sendJson(res, 200, { success: true, plugin: pluginName });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  // Plugin config inspection: GET /api/plugins/:name/config?instance=:id
  const pluginConfigMatch = pathname.match(/^\/api\/plugins\/([a-zA-Z0-9_-]+)\/config$/);
  if (pluginConfigMatch) {
    const pluginName = pluginConfigMatch[1];
    const instanceId = url.searchParams.get('instance') || 'default';
    const inst = manager.getInstance(instanceId);

    if (!inst) {
      sendJson(res, 404, { error: `Instance "${instanceId}" not found` });
      return true;
    }

    const dbPath = inst.config.dbPath;
    if (method === 'GET') {
      try {
        if (!fs.existsSync(dbPath)) {
          sendJson(res, 200, { config: {} });
          return true;
        }
        const db = new Database(dbPath);
        const row = db.raw().prepare('SELECT config_json FROM plugin_state WHERE name = ?').get(pluginName) as any;
        db.close();
        sendJson(res, 200, { config: row?.config_json ? JSON.parse(row.config_json) : {} });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (method === 'PUT') {
      try {
        const body = await parseJsonBody(req);
        const config = body.config || {};

        // Schema validation (if plugin declares configSchema)
        const manifestPath = path.join(pluginsDir, pluginName, 'plugin.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (manifest.configSchema && manifest.configSchema.length > 0) {
              const fieldErrors = validatePluginConfig(manifest.configSchema, config);
              if (Object.keys(fieldErrors).length > 0) {
                sendJson(res, 400, { error: '配置校验失败', fieldErrors });
                return true;
              }
            }
          } catch { /* manifest parse error — skip validation */ }
        }

        const db = new Database(dbPath);
        const now = Date.now();
        const jsonStr = JSON.stringify(config);
        db.raw().prepare(`
          INSERT INTO plugin_state (name, enabled, config_json, loaded_at, updated_at)
          VALUES (?, 1, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
        `).run(pluginName, jsonStr, now, now);
        db.close();

        // Trigger reload if online
        if (inst.getInfo().status === 'ONLINE') {
          await inst.pluginAction('reload', pluginName).catch(() => {});
        }

        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
  }

  return false;
}

// ---- Plugin Config Schema Validation ----

function validatePluginConfig(
  schema: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: Array<{ value: string | number; label: string }>;
    min?: number;
    max?: number;
  }>,
  config: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of schema) {
    const val = config[field.key];

    if (field.required && (val === undefined || val === null || val === '')) {
      errors[field.key] = `${field.label} 为必填项`;
      continue;
    }

    if (val === undefined || val === null) continue;

    switch (field.type) {
      case 'number': {
        const n = Number(val);
        if (isNaN(n)) {
          errors[field.key] = `${field.label} 必须是数字`;
        } else if (field.min != null && n < field.min) {
          errors[field.key] = `${field.label} 不能小于 ${field.min}`;
        } else if (field.max != null && n > field.max) {
          errors[field.key] = `${field.label} 不能大于 ${field.max}`;
        }
        break;
      }
      case 'boolean':
        if (typeof val !== 'boolean') {
          errors[field.key] = `${field.label} 必须是布尔值`;
        }
        break;
      case 'select':
        if (field.options && !field.options.some((o) => String(o.value) === String(val))) {
          errors[field.key] = `${field.label} 选择了无效选项`;
        }
        break;
      case 'multiselect':
        if (!Array.isArray(val)) {
          errors[field.key] = `${field.label} 必须是数组`;
        } else if (field.options) {
          const validValues = new Set(field.options.map((o) => String(o.value)));
          for (const item of val) {
            if (!validValues.has(String(item))) {
              errors[field.key] = `${field.label} 包含无效选项`;
              break;
            }
          }
        }
        break;
      case 'string':
      case 'textarea':
      case 'color':
        if (typeof val !== 'string') {
          errors[field.key] = `${field.label} 必须是字符串`;
        }
        break;
    }
  }

  return errors;
}


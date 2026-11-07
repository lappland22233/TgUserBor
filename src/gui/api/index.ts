import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as QRCode from 'qrcode';
import { Database } from '../../bot/database';
import type { InstanceManager } from '../../manager';
import type { CacheManager } from '../cache-manager';
import { mediaDownloadDisposition, parseByteRange } from '../media-response';
import { streamTelegramMedia } from '../media-stream';
import { receiveStreamUpload, receiveStreamAlbumUpload, cleanupStreamUpload, markStreamUploadOwner, watchOrphanedStreamUpload } from '../../manager/media-upload';

const DEFAULT_JSON_LIMIT = 1024 * 1024;
// Base64 adds approximately one third to the original file size.
const MEDIA_JSON_LIMIT = 32 * 1024 * 1024;

export function parseJsonBody<T = any>(req: http.IncomingMessage, maxBytes = DEFAULT_JSON_LIMIT): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!size) return resolve({} as T);
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
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

function isTelegramChatlistInviteUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && /^\/addlist\/[A-Za-z0-9_-]{8,128}\/?$/.test(url.pathname);
  } catch { return false; }
}

function isNotificationSoundId(value: unknown): boolean {
  if (value === 'default' || value === 'none') return true;
  return typeof value === 'string' && /^\d{1,20}$/.test(value) && !/^0+$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function isMessageEffectId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function isScheduleRepeatPeriod(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 86400 && (value as number) <= 31536000;
}

function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32 || /\s/u.test(value) ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) return false;
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1; }
  catch { return [...value].length <= 8; }
}

function isReactionIdentifier(value: unknown): value is string {
  if (isSingleEmoji(value)) return true;
  if (typeof value !== 'string') return false;
  const customId = /^custom:([1-9]\d{0,19})$/.exec(value)?.[1];
  return Boolean(customId && BigInt(customId) <= 9223372036854775807n);
}

function isSavedMessageTagReaction(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type === 'emoji') return isSingleEmoji(value.value);
  if (value.type === 'custom' && typeof value.value === 'string' && /^[1-9]\d{0,19}$/.test(value.value)) {
    return BigInt(value.value) <= 9223372036854775807n;
  }
  return false;
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
      try {
        await inst!.start();
        sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      } catch (err: any) {
        sendJson(res, 409, { error: err.message || '启动失败' });
      }
      return true;
    }

    if (subRoute === 'stop' && method === 'POST') {
      try {
        await inst!.stop();
        sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      } catch (err: any) {
        sendJson(res, 409, { error: err.message || '停止失败' });
      }
      return true;
    }

    if (subRoute === 'restart' && method === 'POST') {
      try {
        await inst!.restart();
        sendJson(res, 200, { success: true, status: inst!.getInfo().status });
      } catch (err: any) {
        sendJson(res, 409, { error: err.message || '重启失败' });
      }
      return true;
    }

    if (subRoute === 'account/logout' && method === 'POST') {
      try {
        const result = await inst!.logOut();
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 400, { error: err.message || '退出账号失败' });
      }
      return true;
    }

    if (subRoute === 'auth/qr' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
      // QR login tokens are credentials: never cache them or put them in URLs.
      res.setHeader('Cache-Control', 'no-store, private');
      try {
        if (method === 'POST') {
          const accessKey = await inst!.beginQrLogin();
          sendJson(res, 200, { accessKey });
        } else {
          const key = req.headers['x-qr-access-key'];
          if (typeof key !== 'string') return sendJson(res, 403, { error: '无权访问二维码' }), true;
          if (method === 'DELETE') {
            await inst!.cancelQrLogin(key);
            sendJson(res, 200, { success: true });
          } else {
            const qr = inst!.getQrLogin(key);
            const image = qr ? await QRCode.toDataURL(`tg://login?token=${qr.token}`, { errorCorrectionLevel: 'M', margin: 2, width: 256 }) : undefined;
            sendJson(res, 200, qr ? { image, expires: qr.expires } : { pending: true });
          }
        }
      } catch (err: any) {
        sendJson(res, method === 'POST' ? 409 : 403, { error: err.message || '二维码登录不可用' });
      }
      return true;
    }

    if (subRoute === 'auth' && method === 'POST') {
      let body: any;
      try {
        body = await parseJsonBody(req);
      } catch (err: any) {
        sendJson(res, err.message === 'Payload too large' ? 413 : 400, { error: err.message });
        return true;
      }
      if (!['phone', 'code', 'password'].includes(body.step) || typeof body.value !== 'string') {
        sendJson(res, 400, { error: 'Invalid step or value' });
        return true;
      }
      try {
        await inst!.submitAuth(body.step, body.value);
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 409, { error: err.message });
      }
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
    if (subRoute === 'account/draft' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0) return sendJson(res, 400, { error: 'Invalid chatId' }), true;
        const result = await inst!.accountAction('get_draft', { chatId });
        sendJson(res, 200, result);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/draft' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof body.text !== 'string' || body.text.length > 16384) return sendJson(res, 400, { error: 'Invalid draft' }), true;
        const result = await inst!.accountAction('save_draft', { chatId, text: body.text, options: body.options });
        sendJson(res, 200, result || { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folders' && method === 'GET') {
      try {
        const folders = await inst!.accountAction('get_dialog_folders');
        sendJson(res, 200, folders || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folders' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const flagFields = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots', 'excludeMuted', 'excludeRead', 'excludeArchived'];
        const peerFields = ['pinnedPeers', 'includePeers', 'excludePeers'];
        const folder: Record<string, any> = {
          ...(body.id == null ? {} : { id: Number(body.id) }),
          title: body.title,
        };
        if (body.emoticon != null) folder.emoticon = body.emoticon;
        if (body.color != null) folder.color = body.color;
        for (const field of flagFields) folder[field] = body[field];
        for (const field of peerFields) folder[field] = body[field];
        if ((folder.id != null && (!Number.isInteger(folder.id) || folder.id < 1 || folder.id > 255)) ||
            typeof folder.title !== 'string' || !folder.title.trim() || folder.title.length > 32 ||
            (folder.emoticon != null && (typeof folder.emoticon !== 'string' || folder.emoticon.length > 32)) ||
            (folder.color != null && (!Number.isInteger(folder.color) || folder.color < 0 || folder.color > 7)) ||
            flagFields.some(field => typeof folder[field] !== 'boolean') ||
            peerFields.some(field => !Array.isArray(folder[field]) || folder[field].length > 100 || folder[field].some((id: any) =>
              typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))) ||
            (!['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'].some(field => folder[field] === true) &&
              Array.isArray(folder.includePeers) && folder.includePeers.length === 0)) {
          return sendJson(res, 400, { error: 'Invalid Telegram chat folder' }), true;
        }
        const saved = await inst!.accountAction('save_dialog_folder', { folder });
        sendJson(res, 200, saved || { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folders' && method === 'DELETE') {
      try {
        const body = await parseJsonBody(req);
        const folderId = Number(body.id);
        if (!Number.isInteger(folderId) || folderId < 1 || folderId > 255) {
          return sendJson(res, 400, { error: 'Invalid Telegram chat folder ID' }), true;
        }
        await inst!.accountAction('delete_dialog_folder', { folderId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folders/order' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const folderIds = body.folderIds;
        if (!Array.isArray(folderIds) || folderIds.length > 20 || folderIds.some((id: any) => !Number.isInteger(id) || id < 1 || id > 255) ||
            new Set(folderIds).size !== folderIds.length) {
          return sendJson(res, 400, { error: 'Invalid Telegram chat folder order' }), true;
        }
        await inst!.accountAction('reorder_dialog_folders', { folderIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folder-tags' && method === 'GET') {
      try {
        const state = await inst!.accountAction('get_dialog_folder_tag_state');
        sendJson(res, 200, state || { enabled: false, premium: false });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folder-tags' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'Invalid Telegram folder tag setting' });
          return true;
        }
        await inst!.accountAction('set_dialog_folder_tags', { enabled: body.enabled });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialog-folder-share-peers' && method === 'GET') {
      try {
        const folderId = Number(url.searchParams.get('folderId'));
        if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255) {
          sendJson(res, 400, { error: 'Invalid Telegram chat folder ID' }); return true;
        }
        const peers = await inst!.accountAction('get_dialog_folder_share_peers', { folderId });
        sendJson(res, 200, peers || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites' && method === 'GET') {
      try {
        const folderId = Number(url.searchParams.get('folderId'));
        if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255) {
          sendJson(res, 400, { error: 'Invalid Telegram chat folder ID' }); return true;
        }
        const invites = await inst!.accountAction('get_dialog_folder_invites', { folderId });
        sendJson(res, 200, invites || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const folderId = Number(body.folderId), peerIds = body.peerIds;
        if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || typeof body.title !== 'string' ||
            !body.title.trim() || body.title.length > 32 || /[\u0000-\u001f]/.test(body.title) || !Array.isArray(peerIds) ||
            peerIds.length < 1 || peerIds.length > 100 || new Set(peerIds).size !== peerIds.length ||
            peerIds.some((id: any) => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))) {
          sendJson(res, 400, { error: 'Invalid Telegram chatlist invite' }); return true;
        }
        const invite = await inst!.accountAction('create_dialog_folder_invite', { folderId, title: body.title, peerIds });
        sendJson(res, 200, invite || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const folderId = Number(body.folderId), peerIds = body.peerIds;
        if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || typeof body.title !== 'string' ||
            body.title.length > 32 || /[\u0000-\u001f]/.test(body.title) || !isTelegramChatlistInviteUrl(body.url) ||
            !Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 100 || new Set(peerIds).size !== peerIds.length ||
            peerIds.some((id: any) => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))) {
          sendJson(res, 400, { error: 'Invalid Telegram chatlist invite' }); return true;
        }
        const invite = await inst!.accountAction('edit_dialog_folder_invite', { folderId, url: body.url, title: body.title, peerIds });
        sendJson(res, 200, invite || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites' && method === 'DELETE') {
      try {
        const body = await parseJsonBody(req);
        const folderId = Number(body.folderId);
        if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || !isTelegramChatlistInviteUrl(body.url)) {
          sendJson(res, 400, { error: 'Invalid Telegram chatlist invite' }); return true;
        }
        await inst!.accountAction('delete_dialog_folder_invite', { folderId, url: body.url });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites/check' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!isTelegramChatlistInviteUrl(body.url)) {
          sendJson(res, 400, { error: 'Invalid Telegram chatlist invite URL' }); return true;
        }
        const preview = await inst!.accountAction('check_dialog_folder_invite', { url: body.url });
        sendJson(res, 200, preview || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/dialog-folder-invites/join' && method === 'POST') {
      try {
        const body = await parseJsonBody(req), peerIds = body.peerIds;
        if (!isTelegramChatlistInviteUrl(body.url) || !Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 100 ||
            new Set(peerIds).size !== peerIds.length ||
            peerIds.some((id: any) => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))) {
          sendJson(res, 400, { error: 'Invalid Telegram chatlist invite selection' }); return true;
        }
        await inst!.accountAction('join_dialog_folder_invite', { url: body.url, peerIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/search-global-messages' && method === 'GET') {
      try {
        const query = (url.searchParams.get('query') || '').trim();
        const searchFilter = url.searchParams.get('filter') || undefined;
        const allowedSearchFilters = new Set(['photos', 'videos', 'files', 'links', 'music', 'voice', 'round-video', 'round-voice', 'geo', 'calls']);
        const rawPeer = url.searchParams.get('peer');
        const rate = Number(url.searchParams.get('rate'));
        const id = Number(url.searchParams.get('id'));
        if ((!query && !searchFilter) || query.length > 128 || (searchFilter && !allowedSearchFilters.has(searchFilter)) ||
            (rawPeer !== null && (!/^-?\d+$/.test(rawPeer) || !Number.isSafeInteger(rate) || rate < 0 || !Number.isSafeInteger(id) || id <= 0))) {
          sendJson(res, 400, { error: 'Invalid search query or cursor' });
          return true;
        }
        const cursor = rawPeer === null ? undefined : { peer: rawPeer, rate, id };
        const payload: { query: string; cursor?: typeof cursor; searchFilter?: string } = { query };
        if (cursor) payload.cursor = cursor;
        if (searchFilter) payload.searchFilter = searchFilter;
        const result = await inst!.accountAction('search_global_messages', payload);
        sendJson(res, 200, result || { messages: [] });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/message-context' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const messageId = Number(url.searchParams.get('messageId'));
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0) {
          sendJson(res, 400, { error: 'Invalid message' }); return true;
        }
        const result = await inst!.accountAction('get_message_context', { chatId, messageId });
        sendJson(res, 200, result || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/pinned-messages' && method === 'GET') {
      try {
        const chatIdRaw = url.searchParams.get('chatId');
        const rawLimit = url.searchParams.get('limit');
        const rawOffsetId = url.searchParams.get('offsetId');
        const chatId = chatIdRaw === null ? NaN : Number(chatIdRaw);
        const limit = rawLimit === null ? 30 : Number(rawLimit);
        const offsetId = rawOffsetId === null ? undefined : Number(rawOffsetId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
            (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) {
          sendJson(res, 400, { error: 'Invalid pinned messages request' });
          return true;
        }
        const result = await inst!.accountAction('get_pinned_messages', { chatId, limit, offsetId });
        sendJson(res, 200, result || { messages: [], total: 0 });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/search-dialogs' && method === 'GET') {
      const query = (url.searchParams.get('query') || '').trim();
      if (query.length > 128) return sendJson(res, 400, { error: 'Search query is too long' }), true;
      try {
        const dialogs = query ? await inst!.accountAction('search_dialogs', { query }) : [];
        sendJson(res, 200, dialogs || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialogs' && method === 'GET') {
      try {
        const limit = Number(url.searchParams.get('limit')) || 50;
        const peer = url.searchParams.get('offsetPeer');
        const id = Number(url.searchParams.get('offsetId'));
        const date = Number(url.searchParams.get('offsetDate'));
        const offset = peer && id > 0 && date > 0 ? { peer, id, date } : undefined;
        const folderId = url.searchParams.get('folderId') === '1' ? 1 : 0;
        const dialogs = await inst!.accountAction('get_dialogs', { limit, offset, folderId });
        sendJson(res, 200, dialogs || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }
    if (subRoute === 'account/dialogs/explicit' && method === 'GET') {
      const rawPeers = url.searchParams.get('peerIds') || '';
      const values = rawPeers ? rawPeers.split(',') : [];
      if (values.length > 100 || values.some(value => !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) === 0)) {
        sendJson(res, 400, { error: 'Invalid explicit dialog peers' });
        return true;
      }
      try {
        const dialogs = values.length ? await inst!.accountAction('get_explicit_dialogs', { peerIds: [...new Set(values.map(Number))] }) : [];
        sendJson(res, 200, dialogs || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/forum-topics' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const hasCursor = url.searchParams.has('topicId');
        const offset = hasCursor ? { date: Number(url.searchParams.get('date')), messageId: Number(url.searchParams.get('messageId')), topicId: Number(url.searchParams.get('topicId')) } : undefined;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || (offset && Object.values(offset).some(value => !Number.isSafeInteger(value) || value <= 0))) {
          sendJson(res, 400, { error: 'Invalid forum or cursor' }); return true;
        }
        const result = await inst!.accountAction('get_forum_topics', { chatId, offset });
        sendJson(res, 200, result || { topics: [] });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/discussion-groups' && method === 'GET') {
      try {
        const channelId = Number(url.searchParams.get('channelId'));
        if (!Number.isSafeInteger(channelId) || channelId >= 0) { sendJson(res, 400, { error: 'Invalid broadcast channel' }); return true; }
        const result = await inst!.accountAction('get_discussion_group_state', { channelId });
        sendJson(res, 200, result || { groups: [] });
      } catch (err: any) { sendJson(res, 500, { error: `读取关联讨论群失败: ${err.message}` }); }
      return true;
    }

    if (subRoute === 'account/discussion-group' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const channelId = Number(body.channelId);
        if (!Number.isSafeInteger(channelId) || channelId >= 0) {
          sendJson(res, 400, { error: 'Invalid discussion group link' }); return true;
        }
        if (body.unlink === true) {
          if (body.groupId != null) { sendJson(res, 400, { error: 'Invalid discussion group unlink' }); return true; }
          await inst!.accountAction('unlink_discussion_group', { channelId });
          sendJson(res, 200, { linked: false });
          return true;
        }
        const groupId = Number(body.groupId);
        if (!Number.isSafeInteger(groupId) || groupId >= 0 || channelId === groupId) {
          sendJson(res, 400, { error: 'Invalid discussion group link' }); return true;
        }
        await inst!.accountAction('link_discussion_group', { channelId, groupId });
        sendJson(res, 200, { linked: true });
      } catch (err: any) { sendJson(res, 500, { error: `关联讨论群失败: ${err.message}` }); }
      return true;
    }

    if (subRoute === 'account/forum-topics' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const action = body.action;
        if (!Number.isSafeInteger(chatId) || chatId >= 0) {
          sendJson(res, 400, { error: 'Invalid forum' }); return true;
        }
        if (action === 'create') {
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!title || title.length > 128) { sendJson(res, 400, { error: 'Invalid topic title' }); return true; }
          await inst!.accountAction('create_forum_topic', { chatId, title });
        } else {
          const topicId = Number(body.topicId);
          if (!Number.isSafeInteger(topicId) || topicId <= 0) { sendJson(res, 400, { error: 'Invalid topicId' }); return true; }
          if (action === 'edit') {
            const options: { title?: string; closed?: boolean; hidden?: boolean } = {};
            if (body.title !== undefined) {
              if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 128) {
                sendJson(res, 400, { error: 'Invalid topic title' }); return true;
              }
              options.title = body.title.trim();
            }
            if (body.closed !== undefined) {
              if (typeof body.closed !== 'boolean') { sendJson(res, 400, { error: 'Invalid closed state' }); return true; }
              options.closed = body.closed;
            }
            if (body.hidden !== undefined) {
              if (typeof body.hidden !== 'boolean') { sendJson(res, 400, { error: 'Invalid hidden state' }); return true; }
              options.hidden = body.hidden;
            }
            if (options.title === undefined && options.closed === undefined && options.hidden === undefined) { sendJson(res, 400, { error: 'Missing topic update' }); return true; }
            await inst!.accountAction('edit_forum_topic', { chatId, topicId, ...options });
          } else if (action === 'pin') {
            if (typeof body.pinned !== 'boolean') { sendJson(res, 400, { error: 'Invalid pinned state' }); return true; }
            await inst!.accountAction('pin_forum_topic', { chatId, topicId, pinned: body.pinned });
          } else if (action === 'movePin') {
            if (!['up', 'down'].includes(body.direction)) { sendJson(res, 400, { error: 'Invalid pinned topic direction' }); return true; }
            await inst!.accountAction('move_pinned_forum_topic', { chatId, topicId, direction: body.direction });
          } else if (action === 'delete') {
            if (topicId <= 1) { sendJson(res, 400, { error: 'The General topic cannot be deleted' }); return true; }
            await inst!.accountAction('delete_forum_topic', { chatId, topicId });
          } else {
            sendJson(res, 400, { error: 'Invalid forum topic action' }); return true;
          }
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/forum-messages' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const topicId = Number(url.searchParams.get('topicId'));
        const offsetId = url.searchParams.has('offsetId') ? Number(url.searchParams.get('offsetId')) : undefined;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 ||
            (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) {
          sendJson(res, 400, { error: 'Invalid forum topic' }); return true;
        }
        const result = await inst!.accountAction('get_forum_messages', { chatId, topicId, offsetId });
        sendJson(res, 200, result || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/forum-topic-read' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), topicId = Number(body.topicId), maxId = Number(body.maxId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 ||
            !Number.isSafeInteger(maxId) || maxId <= 0) {
          sendJson(res, 400, { error: 'Invalid forum topic read boundary' }); return true;
        }
        await inst!.accountAction('mark_forum_topic_read', { chatId, topicId, maxId });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/forum-messages' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), topicId = Number(body.topicId);
        const replyTo = body.replyTo == null ? undefined : Number(body.replyTo);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 ||
            (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo <= 0)) || !text.trim() || text.length > 4096) {
          sendJson(res, 400, { error: 'Invalid forum message' }); return true;
        }
        const result = await inst!.accountAction('send_forum_message', { chatId, topicId, text, replyTo });
        sendJson(res, 200, result || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/channel-comments' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const messageId = Number(url.searchParams.get('messageId'));
        const offset = url.searchParams.get('offsetId');
        const offsetId = offset == null ? undefined : Number(offset);
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) {
          sendJson(res, 400, { error: 'Invalid discussion' });
          return true;
        }
        const result = await inst!.accountAction('get_channel_comments', { chatId, messageId, offsetId, limit: 50 });
        sendJson(res, 200, result || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/channel-comments' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const messageId = Number(body.messageId);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 || !text.trim() || text.length > 4096) {
          sendJson(res, 400, { error: 'Invalid comment' });
          return true;
        }
        const result = await inst!.accountAction('send_channel_comment', { chatId, messageId, text });
        sendJson(res, 200, result || {});
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
        const offsetDate = url.searchParams.get('offsetDate') ? Number(url.searchParams.get('offsetDate')) : undefined;
        const search = url.searchParams.get('search') || undefined;
        const searchFilter = url.searchParams.get('searchFilter') || undefined;
        const savedReactionRaw = url.searchParams.get('savedReaction');
        let savedReaction: any;
        if (savedReactionRaw) {
          try { savedReaction = JSON.parse(savedReactionRaw); } catch { savedReaction = undefined; }
          if (!isSavedMessageTagReaction(savedReaction)) return sendJson(res, 400, { error: 'Invalid Saved Messages tag filter' }), true;
        }
        const allowedSearchFilters = new Set(['photos', 'videos', 'files', 'links', 'music', 'voice', 'round-video', 'round-voice', 'geo', 'calls']);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0)) ||
            (offsetDate !== undefined && (!Number.isSafeInteger(offsetDate) || offsetDate <= 0)) || (search && search.length > 128)) {
          sendJson(res, 400, { error: 'Invalid message history request' });
          return true;
        }
        if (searchFilter && !allowedSearchFilters.has(searchFilter)) return sendJson(res, 400, { error: 'Invalid message search filter' }), true;
        const messages = await inst!.accountAction('get_messages', {
          chatId, limit, offsetId, offsetDate, search, searchFilter,
          ...(savedReaction ? { savedReaction } : {}),
        });
        sendJson(res, 200, messages || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/reply-keyboard-state' && method === 'GET') {
      const chatId = Number(url.searchParams.get('chatId'));
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        sendJson(res, 400, { error: 'Invalid reply keyboard history request' });
        return true;
      }
      try {
        const snapshot = await inst!.accountAction('get_reply_keyboard_state', { chatId });
        sendJson(res, 200, snapshot || { latestMessageId: 0, complete: true });
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
        if (options?.scheduleRepeatPeriod != null && (!isScheduleRepeatPeriod(options.scheduleRepeatPeriod) ||
            !Number.isSafeInteger(options.schedule) || options.schedule <= 0)) {
          return sendJson(res, 400, { error: 'Invalid scheduled-message repeat period' }), true;
        }
        const effectId = options?.effectId;
        if (effectId !== undefined && !isMessageEffectId(effectId)) {
          return sendJson(res, 400, { error: 'Invalid Telegram message effect' }), true;
        }
        const result = await inst!.accountAction('send_message', { chatId, text, options });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/location/live' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const period = Number(body.period);
        const topMsgId = body.topMsgId == null ? undefined : Number(body.topMsgId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || ![900, 3600, 28800].includes(period) ||
            (topMsgId !== undefined && (!Number.isSafeInteger(topMsgId) || topMsgId <= 0)) ||
            typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90 ||
            typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
          sendJson(res, 400, { error: 'Invalid live location' });
          return true;
        }
        const result = await inst!.accountAction('send_live_location', { chatId, latitude: body.latitude, longitude: body.longitude, period, topMsgId });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if ((subRoute === 'account/location/live/update' || subRoute === 'account/location/live/stop') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          sendJson(res, 400, { error: 'Invalid live location target' });
          return true;
        }
        if (subRoute.endsWith('/update')) {
          const period = Number(body.period);
          if (!Number.isSafeInteger(period) || period < 1 || period > 28800 ||
              typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90 ||
              typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
            sendJson(res, 400, { error: 'Invalid live location update' });
            return true;
          }
          await inst!.accountAction('update_live_location', { chatId, messageId, latitude: body.latitude, longitude: body.longitude, period });
        } else {
          await inst!.accountAction('stop_live_location', { chatId, messageId });
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if ((subRoute === 'account/location' || subRoute === 'account/contact') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0) {
          sendJson(res, 400, { error: 'Invalid chatId' });
          return true;
        }
        if (subRoute === 'account/location') {
          const latitude = body.latitude;
          const longitude = body.longitude;
          if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
              typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            sendJson(res, 400, { error: 'Invalid coordinates' });
            return true;
          }
          const result = await inst!.accountAction('send_location', { chatId, latitude, longitude });
          sendJson(res, 200, { success: true, result });
        } else {
          const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
          const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
          const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
          if (!/^\+?[0-9 ()-]{3,32}$/.test(phoneNumber) || phoneNumber.replace(/\D/g, '').length < 3 ||
              !firstName || firstName.length > 64 || lastName.length > 64) {
            sendJson(res, 400, { error: 'Invalid contact' });
            return true;
          }
          const result = await inst!.accountAction('send_contact', { chatId, phoneNumber, firstName, lastName });
          sendJson(res, 200, { success: true, result });
        }
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if ((subRoute === 'account/bot-keyboard/phone' || subRoute === 'account/bot-keyboard/location') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        const row = body.row, column = body.column;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
          sendJson(res, 400, { error: 'Invalid bot keyboard request' });
          return true;
        }
        if (subRoute.endsWith('/phone')) {
          const result = await inst!.accountAction('send_bot_keyboard_phone', { chatId, messageId, row, column });
          sendJson(res, 200, { success: true, result });
        } else {
          const { latitude, longitude } = body;
          if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
              typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            sendJson(res, 400, { error: 'Invalid coordinates' });
            return true;
          }
          const result = await inst!.accountAction('send_bot_keyboard_location', { chatId, messageId, row, column, latitude, longitude });
          sendJson(res, 200, { success: true, result });
        }
      } catch (err: any) {
        sendJson(res, 403, { error: 'Telegram bot request could not be verified' });
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

    if (subRoute === 'account/mini-app' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const { chatId, messageId, row, column } = await parseJsonBody(req);
        if (!Number.isSafeInteger(Number(chatId)) || !Number(chatId) || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
            !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
          sendJson(res, 400, { error: '无效的 Mini App 按钮' });
        } else {
          const data = await inst!.accountAction('open_mini_app', { chatId: Number(chatId), messageId: Number(messageId), row, column });
          sendJson(res, 200, data);
        }
      } catch { sendJson(res, 400, { error: '无法启动 Mini App，请检查机器人和会话权限' }); }
      return true;
    }

    if (subRoute === 'account/mini-app/menu' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId <= 0) return sendJson(res, 400, { error: 'Invalid bot menu peer' }), true;
        const result = await inst!.accountAction('get_mini_app_menu_button', { chatId });
        sendJson(res, 200, result || { available: false });
      } catch { sendJson(res, 400, { error: '无法读取机器人菜单' }); }
      return true;
    }

    if (subRoute === 'account/mini-app/menu' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId <= 0) return sendJson(res, 400, { error: 'Invalid bot menu peer' }), true;
        const result = await inst!.accountAction('open_mini_app_menu', { chatId });
        sendJson(res, 200, result || {});
      } catch { sendJson(res, 400, { error: '无法启动机器人菜单 Mini App' }); }
      return true;
    }

    if ((subRoute === 'account/mini-app' && method === 'DELETE') || (subRoute === 'account/mini-app/prolong' && method === 'POST')) {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      try {
        await inst!.accountAction(method === 'DELETE' ? 'close_mini_app' : 'prolong_mini_app', { capability });
        sendJson(res, 200, { success: true });
      } catch { sendJson(res, 403, { error: 'Mini App 会话已结束' }); }
      return true;
    }

    if (subRoute === 'account/mini-app/write-access' && (method === 'GET' || method === 'POST')) {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      try {
        if (method === 'GET') {
          const result = await inst!.accountAction('mini_app_can_send_messages', { capability });
          sendJson(res, 200, { allowed: result?.allowed === true });
        } else {
          await inst!.accountAction('mini_app_allow_send_messages', { capability });
          sendJson(res, 200, { success: true });
        }
      } catch {
        sendJson(res, 403, { error: '无法更新机器人的消息权限' });
      }
      return true;
    }

    if (subRoute === 'account/mini-app/phone' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      try {
        await inst!.accountAction('mini_app_request_phone', { capability });
        sendJson(res, 200, { success: true });
      } catch { sendJson(res, 403, { error: '无法向此机器人分享电话号码' }); }
      return true;
    }

    if (['account/mini-app/invoice/prepare', 'account/mini-app/invoice/confirm', 'account/mini-app/invoice/cancel'].includes(subRoute) && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      let body: any;
      try { body = await parseJsonBody(req, 4096); }
      catch (error: any) {
        sendJson(res, error?.message === 'Payload too large' ? 413 : 400, { error: 'Invalid Mini App invoice request' });
        return true;
      }
      if (subRoute.endsWith('/prepare')) {
        const slug = body?.slug;
        if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(slug)) {
          sendJson(res, 400, { error: 'Invalid Mini App invoice' });
          return true;
        }
        try {
          const result = await inst!.accountAction('mini_app_prepare_invoice', { capability, slug });
          const data = result?.data || result || {};
          if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(data.token) ||
              typeof data.stars !== 'string' || !/^\d{1,13}$/.test(data.stars) ||
              typeof data.title !== 'string' || typeof data.description !== 'string') throw new Error('Invalid invoice response');
          sendJson(res, 200, { token: data.token, stars: data.stars, title: data.title.slice(0, 256), description: data.description.slice(0, 1024) });
        } catch { sendJson(res, 400, { error: '此发票暂不可付款或不支持 Telegram Stars' }); }
      } else {
        const token = body?.token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
          sendJson(res, 400, { error: 'Invalid Mini App invoice token' });
          return true;
        }
        try {
          if (subRoute.endsWith('/confirm')) {
            const result = await inst!.accountAction('mini_app_confirm_invoice', { capability, token });
            const status = result?.data?.status ?? result?.status;
            sendJson(res, 200, { status: status === 'paid' ? 'paid' : 'failed' });
          } else {
            await inst!.accountAction('mini_app_cancel_invoice', { capability, token });
            sendJson(res, 200, { success: true });
          }
        } catch {
          if (subRoute.endsWith('/confirm')) sendJson(res, 200, { status: 'failed' });
          else sendJson(res, 403, { error: 'Mini App invoice could not be cancelled' });
        }
      }
      return true;
    }

    if (subRoute === 'account/mini-app/download-check' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      try {
        const body = await parseJsonBody(req, 32768);
        const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
        const remoteUrl = body?.url;
        if (!fileName || fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(fileName) ||
            typeof remoteUrl !== 'string' || remoteUrl.length > 16384) {
          sendJson(res, 400, { error: 'Invalid Mini App download request' });
          return true;
        }
        const result = await inst!.accountAction('mini_app_check_download', { capability, fileName, url: remoteUrl });
        sendJson(res, 200, { allowed: result?.allowed === true });
      } catch {
        sendJson(res, 403, { error: 'Mini App file download is not allowed' });
      }
      return true;
    }

    if (subRoute === 'account/mini-app/method' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      let body: any;
      try {
        body = await parseJsonBody(req, 8192);
      } catch (error: any) {
        sendJson(res, error?.message === 'Payload too large' ? 413 : 400, { error: 'Invalid Mini App custom method request' });
        return true;
      }
      const methodName = body?.method;
      const paramsJson = body?.paramsJson;
      if (typeof methodName !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(methodName) ||
          typeof paramsJson !== 'string' || Buffer.byteLength(paramsJson, 'utf8') > 4096) {
        sendJson(res, 400, { error: 'Mini App custom method is invalid' });
        return true;
      }
      try { JSON.parse(paramsJson); } catch {
        sendJson(res, 400, { error: 'Mini App custom method parameters are invalid' });
        return true;
      }
      try {
        const data = await inst!.accountAction('invoke_mini_app_custom_method', { capability, method: methodName, paramsJson });
        sendJson(res, 200, { result: data?.result });
      } catch {
        sendJson(res, 502, { error: 'Mini App custom method failed' });
      }
      return true;
    }

    if (subRoute === 'account/mini-app/send-data' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      const capability = req.headers['x-mini-app-key'];
      if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
        sendJson(res, 403, { error: 'Mini App 会话已结束' });
        return true;
      }
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (error: any) {
        sendJson(res, error?.message === 'Payload too large' ? 413 : 400, { error: 'Invalid Mini App data request' });
        return true;
      }
      if (typeof body?.data !== 'string' || Buffer.byteLength(body.data, 'utf8') > 4096) {
        sendJson(res, 400, { error: 'Mini App data is invalid' });
        return true;
      }
      try {
        await inst!.accountAction('send_mini_app_data', { capability, data: body.data });
        sendJson(res, 200, { success: true });
      } catch { sendJson(res, 403, { error: 'Mini App data could not be sent' }); }
      return true;
    }

    if (subRoute === 'account/bot-callback' && method === 'POST') {
      try {
        const { chatId, messageId, row, column } = await parseJsonBody(req);
        if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
            !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
          sendJson(res, 400, { error: '无效的机器人按钮' });
        } else {
          const result = await inst!.accountAction('press_bot_callback', { chatId, messageId, row, column });
          sendJson(res, 200, result || {});
        }
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/bot-game' && method === 'POST') {
      try {
        const { chatId, messageId, row, column } = await parseJsonBody(req);
        if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
            !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
          sendJson(res, 400, { error: '无效的游戏按钮' });
        } else {
          const result = await inst!.accountAction('launch_bot_game', { chatId: Number(chatId), messageId: Number(messageId), row, column });
          sendJson(res, 200, result || {});
        }
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if ((subRoute === 'account/bot-url-auth' || subRoute === 'account/bot-url-auth/accept') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, row, column, writeAllowed } = body || {};
        if (chatId == null || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 ||
            !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
            !Number.isInteger(column) || column < 0 || column >= 16 ||
            (subRoute.endsWith('/accept') && typeof writeAllowed !== 'boolean')) {
          return sendJson(res, 400, { error: 'Invalid URL authorization request' }), true;
        }
        const accept = subRoute.endsWith('/accept');
        const result = await inst!.accountAction(accept ? 'accept_bot_url_auth' : 'request_bot_url_auth', {
          chatId: Number(chatId), messageId: Number(messageId), row, column, ...(accept ? { writeAllowed } : {}),
        });
        sendJson(res, 200, result || {});
      } catch (err: any) {
        sendJson(res, 403, { error: '无法完成 Telegram 登录授权' });
      }
      return true;
    }

    if (subRoute === 'account/bot-request-peer' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, row, column, peerIds } = body || {};
        if (chatId == null || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 ||
            !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
            !Number.isInteger(column) || column < 0 || column >= 16 || !Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 10 ||
            peerIds.some(id => !Number.isSafeInteger(id) || id === 0) || new Set(peerIds).size !== peerIds.length) {
          return sendJson(res, 400, { error: 'Invalid peer request' }), true;
        }
        await inst!.accountAction('send_bot_requested_peers', { chatId: Number(chatId), messageId: Number(messageId), row, column, peerIds });
        sendJson(res, 200, { success: true });
      } catch { sendJson(res, 403, { error: 'Telegram 未接受会话分享请求' }); }
      return true;
    }

    if (subRoute === 'account/bot-request-peer-search' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, row, column, query } = body || {};
        if (chatId == null || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 ||
            !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
            !Number.isInteger(column) || column < 0 || column >= 16 || typeof query !== 'string' || query.trim().length < 2 || query.length > 64) {
          return sendJson(res, 400, { error: 'Invalid peer search' }), true;
        }
        const peers = await inst!.accountAction('search_bot_requested_peers', {
          chatId: Number(chatId), messageId: Number(messageId), row, column, query: query.trim(),
        });
        sendJson(res, 200, Array.isArray(peers) ? peers : []);
      } catch { sendJson(res, 403, { error: '无法搜索 Telegram 用户或会话' }); }
      return true;
    }

    if (subRoute === 'account/reaction' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, messageId, reaction } = body;
        if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
            (reaction !== undefined && reaction !== '' && !isReactionIdentifier(reaction))) {
          return sendJson(res, 400, { error: 'Invalid message reaction' }), true;
        }
        const result = await inst!.accountAction('send_reaction', { chatId, messageId, reaction });
        sendJson(res, 200, { success: true, result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/reactions' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0) {
          sendJson(res, 400, { error: 'Invalid reaction peer' }); return true;
        }
        const reactions = await inst!.accountAction('get_available_reactions', { chatId });
        sendJson(res, 200, Array.isArray(reactions) ? reactions : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/message-effects' && method === 'GET') {
      try {
        const effects = await inst!.accountAction('get_message_effects');
        sendJson(res, 200, Array.isArray(effects) ? effects : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/chat-themes' && method === 'GET') {
      try {
        const themes = await inst!.accountAction('get_telegram_chat_themes');
        sendJson(res, 200, Array.isArray(themes) ? themes : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/business-settings' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const settings = await inst!.accountAction('get_telegram_business_settings');
        sendJson(res, 200, settings || { chatLinks: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/business-settings' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 16384); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const timezoneId = body?.timezoneId;
      const weeklyOpen = body?.weeklyOpen;
      if (typeof timezoneId !== 'string' || !timezoneId.trim() || timezoneId.length > 128 || !Array.isArray(weeklyOpen) || weeklyOpen.length > 100) {
        sendJson(res, 400, { error: 'Invalid Telegram Business work hours' });
        return true;
      }
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }).format(); }
      catch { sendJson(res, 400, { error: 'Invalid Telegram Business timezone' }); return true; }
      const intervals = weeklyOpen.map((item: any) => ({ startMinute: item?.startMinute, endMinute: item?.endMinute }))
        .sort((a: any, b: any) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
      let previousEnd = -1;
      for (const interval of intervals) {
        if (!Number.isSafeInteger(interval.startMinute) || !Number.isSafeInteger(interval.endMinute) ||
            interval.startMinute < 0 || interval.endMinute > 10080 || interval.startMinute >= interval.endMinute || interval.startMinute < previousEnd) {
          sendJson(res, 400, { error: 'Invalid or overlapping Telegram Business work interval' });
          return true;
        }
        previousEnd = interval.endMinute;
      }
      try {
        await inst!.accountAction('update_telegram_business_work_hours', { timezoneId, weeklyOpen: intervals });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/business-location' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const address = body?.address;
      const hasLatitude = body?.latitude != null, hasLongitude = body?.longitude != null;
      if (typeof address !== 'string' || address.length > 512 || hasLatitude !== hasLongitude ||
          (hasLatitude && (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90 ||
            typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180))) {
        sendJson(res, 400, { error: 'Invalid Telegram Business location' });
        return true;
      }
      try {
        await inst!.accountAction('update_telegram_business_location', {
          address,
          ...(hasLatitude ? { latitude: body.latitude, longitude: body.longitude } : {}),
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/business-intro' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      if (typeof body?.title !== 'string' || body.title.length > 256 || typeof body?.description !== 'string' || body.description.length > 4096 ||
          (body.clear !== undefined && typeof body.clear !== 'boolean')) {
        sendJson(res, 400, { error: 'Invalid Telegram Business intro' });
        return true;
      }
      try {
        await inst!.accountAction('update_telegram_business_intro', { title: body.title, description: body.description, clear: body.clear === true });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/business-chat-links' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      if (body?.action === 'create') {
        const title = body.title == null ? '' : body.title;
        if (typeof title !== 'string' || title.length > 128 || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2048) {
          sendJson(res, 400, { error: 'Invalid Telegram Business chat link' });
          return true;
        }
        try {
          const link = await inst!.accountAction('create_telegram_business_chat_link', { title, message: body.message });
          sendJson(res, 200, link);
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      if (body?.action === 'edit' && typeof body.slug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.slug) &&
          typeof body.title === 'string' && body.title.length <= 128 && typeof body.message === 'string' && body.message.trim() && body.message.length <= 2048) {
        try {
          await inst!.accountAction('edit_telegram_business_chat_link', { slug: body.slug, title: body.title, message: body.message });
          sendJson(res, 200, { success: true });
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      if (body?.action === 'delete' && typeof body.slug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.slug)) {
        try {
          await inst!.accountAction('delete_telegram_business_chat_link', { slug: body.slug });
          sendJson(res, 200, { success: true });
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      sendJson(res, 400, { error: 'Invalid Telegram Business chat link action' });
      return true;
    }

    if (subRoute === 'account/business-greeting-message' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const recipients = body?.recipients;
      if (typeof body?.clear !== 'boolean' || (!body.clear && (!Number.isSafeInteger(body.shortcutId) || body.shortcutId <= 0 ||
          !Number.isSafeInteger(body.noActivityDays) || body.noActivityDays < 0 || body.noActivityDays > 365 ||
          !recipients || ['existingChats', 'newChats', 'contacts', 'nonContacts'].some(key => typeof recipients[key] !== 'boolean')))) {
        sendJson(res, 400, { error: 'Invalid Telegram Business greeting message' });
        return true;
      }
      try {
        await inst!.accountAction('update_telegram_business_greeting_message', {
          shortcutId: body.shortcutId, noActivityDays: body.noActivityDays, recipients, clear: body.clear,
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/business-away-message' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const recipients = body?.recipients;
      const validSchedule = ['always', 'outside_work_hours', 'custom'].includes(body?.schedule);
      const validRecipients = recipients && !['existingChats', 'newChats', 'contacts', 'nonContacts'].some(key => typeof recipients[key] !== 'boolean');
      if (typeof body?.clear !== 'boolean' || (!body.clear && (!Number.isSafeInteger(body.shortcutId) || body.shortcutId <= 0 ||
          typeof body.offlineOnly !== 'boolean' || !validSchedule || !validRecipients ||
          (body.schedule === 'custom' && (!Number.isSafeInteger(body.startDate) || !Number.isSafeInteger(body.endDate) ||
            body.startDate <= 0 || body.endDate <= body.startDate || body.endDate > 2147483647))))) {
        sendJson(res, 400, { error: 'Invalid Telegram Business away message' });
        return true;
      }
      try {
        await inst!.accountAction('update_telegram_business_away_message', {
          shortcutId: body.shortcutId, offlineOnly: body.offlineOnly, schedule: body.schedule,
          startDate: body.startDate, endDate: body.endDate, recipients, clear: body.clear,
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/app-themes' && method === 'GET') {
      try {
        const themes = await inst!.accountAction('get_telegram_app_themes');
        sendJson(res, 200, Array.isArray(themes) ? themes : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/app-theme' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const slug = typeof body?.slug === 'string' ? body.slug : '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || typeof body?.dark !== 'boolean') {
          sendJson(res, 400, { error: 'Invalid Telegram theme' });
          return true;
        }
        const result = await inst!.accountAction('install_telegram_app_theme', { slug, dark: body.dark });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/chat-theme' && method === 'GET') {
      const chatId = Number(url.searchParams.get('chatId'));
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        sendJson(res, 400, { error: 'Invalid chat theme peer' });
        return true;
      }
      try {
        const theme = await inst!.accountAction('get_telegram_chat_theme', { chatId });
        sendJson(res, 200, theme);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/chat-theme' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const emoticon = typeof body.emoticon === 'string' ? body.emoticon : null;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || emoticon === null ||
            (emoticon !== '' && !isSingleEmoji(emoticon))) {
          sendJson(res, 400, { error: 'Invalid Telegram chat theme' });
          return true;
        }
        const theme = await inst!.accountAction('set_telegram_chat_theme', { chatId, emoticon });
        sendJson(res, 200, theme);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/chat-history-ttl' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const period = Number(body.period);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(period) || period < 0 || period > 31536000) {
          sendJson(res, 400, { error: 'Invalid Telegram message auto-delete period' });
          return true;
        }
        const result = await inst!.accountAction('set_chat_history_ttl', { chatId, period });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/chat-history-ttl/bulk' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatIds = body?.chatIds;
        const period = Number(body?.period);
        if (!Array.isArray(chatIds) || chatIds.length < 1 || chatIds.length > 100 ||
            chatIds.some(id => !Number.isSafeInteger(id) || id === 0) ||
            !Number.isSafeInteger(period) || period < 0 || period > 31536000) {
          sendJson(res, 400, { error: 'Invalid Telegram auto-delete selection' });
          return true;
        }
        const result = await inst!.accountAction('apply_chat_history_ttl', { chatIds: [...new Set(chatIds)], period });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/default-history-ttl' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_default_history_ttl');
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/default-history-ttl' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const period = Number(body.period);
        if (!Number.isSafeInteger(period) || period < 0 || period > 31536000) {
          sendJson(res, 400, { error: 'Invalid Telegram default auto-delete period' });
          return true;
        }
        const result = await inst!.accountAction('set_default_history_ttl', { period });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/wallpapers' && method === 'GET') {
      try {
        const wallpapers = await inst!.accountAction('get_telegram_wallpapers');
        sendJson(res, 200, Array.isArray(wallpapers) ? wallpapers : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/wallpaper-preview' && method === 'GET') {
      try {
        const slug = url.searchParams.get('slug') || '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug)) {
          return sendJson(res, 400, { error: 'Invalid Telegram wallpaper slug' }), true;
        }
        const data = await inst!.accountAction('get_telegram_wallpaper_preview', { slug });
        if (data?.filePath && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Telegram wallpaper preview not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/wallpaper-file' && method === 'GET') {
      try {
        const slug = url.searchParams.get('slug') || '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug)) {
          return sendJson(res, 400, { error: 'Invalid Telegram wallpaper slug' }), true;
        }
        const data = await inst!.accountAction('get_telegram_wallpaper_file', { slug });
        const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(String(data?.mimeType)) ? String(data.mimeType) : '';
        if (data?.filePath && mimeType && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Telegram wallpaper not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/chat-wallpaper' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body?.chatId);
        const slug = typeof body?.slug === 'string' ? body.slug : null;
        const forBoth = body?.forBoth === undefined ? false : body.forBoth;
        const settings = body?.settings === undefined ? {} : body.settings;
        const validSettings = settings && typeof settings === 'object' && !Array.isArray(settings) &&
          Object.keys(settings).every(key => ['blur', 'motion', 'intensity'].includes(key)) &&
          (settings.blur === undefined || typeof settings.blur === 'boolean') &&
          (settings.motion === undefined || typeof settings.motion === 'boolean') &&
          (settings.intensity === undefined || (Number.isInteger(settings.intensity) && settings.intensity >= -100 && settings.intensity <= 100));
        if (!Number.isSafeInteger(chatId) || chatId === 0 || slug === null || typeof forBoth !== 'boolean' || (forBoth && !slug) || !validSettings ||
            (slug !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(slug))) {
          sendJson(res, 400, { error: 'Invalid Telegram chat wallpaper' });
          return true;
        }
        const wallpaper = await inst!.accountAction('set_telegram_chat_wallpaper', { chatId, slug, forBoth, settings });
        sendJson(res, 200, wallpaper);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (['account/dialog-pin', 'account/dialog-archive', 'account/dialog-delete'].includes(subRoute) && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0) return sendJson(res, 400, { error: 'Invalid chatId' }), true;
        if (subRoute === 'account/dialog-pin' && typeof body.pinned !== 'boolean') return sendJson(res, 400, { error: 'Missing pinned' }), true;
        if (subRoute === 'account/dialog-archive' && typeof body.archived !== 'boolean') return sendJson(res, 400, { error: 'Missing archived' }), true;
        const action = subRoute === 'account/dialog-pin' ? 'set_dialog_pinned' : subRoute === 'account/dialog-archive' ? 'set_dialog_archived' : 'delete_dialog';
        await inst!.accountAction(action, { chatId, pinned: body.pinned, archived: body.archived });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/pinned-dialogs' && method === 'GET') {
      try {
        const folderId = url.searchParams.has('folderId') ? Number(url.searchParams.get('folderId')) : 0;
        if (folderId !== 0 && folderId !== 1) return sendJson(res, 400, { error: 'Invalid pinned dialog folder' }), true;
        const ids = await inst!.accountAction('get_pinned_dialogs', { folderId });
        sendJson(res, 200, Array.isArray(ids) ? ids : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/pinned-dialogs/order' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const folderId = body.folderId === undefined ? 0 : Number(body.folderId);
        const order = body.order;
        if ((folderId !== 0 && folderId !== 1) || !Array.isArray(order) || !order.length || order.length > 100 ||
            order.some((id: unknown) => !Number.isSafeInteger(id) || id === 0) || new Set(order).size !== order.length) {
          return sendJson(res, 400, { error: 'Invalid pinned dialog order' }), true;
        }
        await inst!.accountAction('reorder_pinned_dialogs', { folderId, order });
        sendJson(res, 200, { success: true });
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
        const { chatId, messageIds, revoke } = body;
        if (!chatId || !Array.isArray(messageIds)) return sendJson(res, 400, { error: 'Missing chatId or messageIds' }), true;
        const result = await inst!.accountAction('delete_messages', { chatId, messageIds, revoke });
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

    if (subRoute === 'account/chat-photo' && method === 'POST') {
      let stagedPath: string | undefined;
      let handedOff = false;
      try {
        if (!String(req.headers['content-type'] || '').startsWith('application/vnd.tguserbot.media-stream')) {
          req.resume();
          sendJson(res, 415, { error: 'Group photo requires a streamed image upload' }); return true;
        }
        const staged = await receiveStreamUpload(req, undefined, 10 * 1024 * 1024);
        stagedPath = staged.path;
        const chatId = Number(staged.metadata.chatId);
        const fileName = typeof staged.metadata.fileName === 'string'
          ? path.basename(staged.metadata.fileName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(-128) : '';
        const mimeType = typeof staged.metadata.mimeType === 'string' ? staged.metadata.mimeType.toLowerCase() : '';
        const validImage = ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) && /\.(?:jpe?g|png|webp)$/i.test(fileName);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !fileName || !validImage) {
          throw new Error('Invalid Telegram group photo metadata');
        }
        const workerPid = inst!.getInfo?.().pid;
        if (!workerPid) throw new Error('账号未在线');
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        await markStreamUploadOwner(stagedPath, workerPid);
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        handedOff = true;
        await inst!.accountAction('set_chat_photo', { chatId, uploadPath: stagedPath, fileName });
        await cleanupStreamUpload(stagedPath).catch(() => {});
        stagedPath = undefined;
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        const notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
        if (stagedPath && (!handedOff || notDispatched)) await cleanupStreamUpload(stagedPath).catch(() => {});
        if (!res.destroyed) sendJson(res, err.message === 'Payload too large' ? 413 : /Invalid Telegram group photo metadata|Missing file data|Invalid upload metadata/.test(err.message) ? 400 : 500, { error: err.message });
        if (stagedPath && handedOff && !notDispatched) watchOrphanedStreamUpload(stagedPath);
      }
      return true;
    }

    if ((subRoute === 'account/chat-title' || subRoute === 'account/chat-description' || subRoute === 'account/chat-username') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0) {
          sendJson(res, 400, { error: 'Invalid Telegram group or channel' }); return true;
        }
        if (subRoute === 'account/chat-title') {
          if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 128 || /[\u0000-\u001f]/.test(body.title)) {
            sendJson(res, 400, { error: 'Invalid Telegram chat title' }); return true;
          }
          await inst!.accountAction('set_chat_title', { chatId, title: body.title.trim() });
        } else if (subRoute === 'account/chat-description') {
          if (typeof body.description !== 'string' || body.description.length > 255 || body.description.includes('\u0000')) {
            sendJson(res, 400, { error: 'Invalid Telegram chat description' }); return true;
          }
          await inst!.accountAction('set_chat_description', { chatId, description: body.description });
        } else {
          const username = typeof body.username === 'string' ? body.username.trim() : undefined;
          if (username === undefined || (username !== '' && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))) {
            sendJson(res, 400, { error: 'Invalid Telegram public username' }); return true;
          }
          await inst!.accountAction('set_chat_username', { chatId, username });
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if ((subRoute === 'account/chat-permissions' || subRoute === 'account/chat-slow-mode' || subRoute === 'account/supergroup-setting') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0) {
          sendJson(res, 400, { error: 'Invalid Telegram group or channel' }); return true;
        }
        if (subRoute === 'account/chat-permissions') {
          const keys = ['viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
            'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline', 'embedLinks',
            'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics'];
          const rights = body.rights;
          if (!rights || typeof rights !== 'object' || Array.isArray(rights) || Object.keys(rights).length !== keys.length ||
              keys.some(key => typeof rights[key] !== 'boolean') || Object.keys(rights).some(key => !keys.includes(key))) {
            sendJson(res, 400, { error: 'Invalid Telegram group permissions' }); return true;
          }
          await inst!.accountAction('set_chat_permissions', { chatId, rights });
        } else if (subRoute === 'account/chat-slow-mode') {
          if (![0, 10, 30, 60, 300, 900, 3600].includes(body.seconds)) {
            sendJson(res, 400, { error: 'Invalid Telegram slow mode' }); return true;
          }
          await inst!.accountAction('set_chat_slow_mode', { chatId, seconds: body.seconds });
        } else {
          const allowed = ['joinToSend', 'joinRequest', 'antiSpam', 'participantsHidden'];
          if (!allowed.includes(body.setting) || typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { error: 'Invalid Telegram supergroup setting' }); return true;
          }
          await inst!.accountAction('set_supergroup_setting', { chatId, setting: body.setting, enabled: body.enabled });
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/participants' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      const chatId = Number(url.searchParams.get('chatId'));
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      const query = url.searchParams.get('query') || '';
      if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 128) {
        sendJson(res, 400, { error: 'Invalid participant query' });
        return true;
      }
      try {
        const page = await inst!.accountAction('get_participants', { chatId, offset, limit, query });
        sendJson(res, 200, page || { count: 0, participants: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/create-chat' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 16384); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const { type, title, about = '', userIds = [], forum = false } = body || {};
      if (!['group', 'supergroup', 'channel'].includes(type) || typeof title !== 'string' || !title.trim() || title.trim().length > 128 ||
          /[\u0000-\u001f]/.test(title) || typeof about !== 'string' || about.length > 255 || about.includes('\u0000') ||
          typeof forum !== 'boolean' || (forum && type !== 'supergroup') || !Array.isArray(userIds) || userIds.length > 200 ||
          (type === 'group' && !userIds.length) || userIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
          new Set(userIds).size !== userIds.length) {
        sendJson(res, 400, { error: 'Invalid Telegram chat creation options' });
        return true;
      }
      try {
        const created = await inst!.accountAction('create_chat', { type, title: title.trim(), about, userIds, forum });
        sendJson(res, 200, created || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/banned-participants' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      const chatId = Number(url.searchParams.get('chatId'));
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      const query = url.searchParams.get('query') || '';
      if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 128) {
        sendJson(res, 400, { error: 'Invalid banned participant query' });
        return true;
      }
      try {
        const result = await inst!.accountAction('get_banned_participants', { chatId, offset, limit, query });
        sendJson(res, 200, result || { count: 0, participants: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/invite-links' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      const chatId = Number(url.searchParams.get('chatId'));
      const date = url.searchParams.has('date') ? Number(url.searchParams.get('date')) : undefined;
      const link = url.searchParams.get('link') || undefined;
      const limit = Number(url.searchParams.get('limit') || 50);
      const invitePattern = /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/;
      const hasCursor = date !== undefined || link !== undefined;
      if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          (hasCursor && (!Number.isSafeInteger(date) || (date as number) < 0 || typeof link !== 'string' || !invitePattern.test(link)))) {
        sendJson(res, 400, { error: 'Invalid Telegram invite link query' });
        return true;
      }
      try {
        const page = await inst!.accountAction('get_chat_invite_links', {
          chatId, cursor: hasCursor ? { date, link } : undefined, limit,
        });
        sendJson(res, 200, page || { count: 0, links: [] });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/invite-links' && method === 'POST') {
      res.setHeader('Cache-Control', 'private, no-store');
      let body: any;
      try { body = await parseJsonBody(req, 8192); }
      catch (err: any) { sendJson(res, err?.message === 'Payload too large' ? 413 : 400, { error: err?.message || 'Invalid JSON' }); return true; }
      const chatId = Number(body?.chatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) { sendJson(res, 400, { error: 'Invalid invite link chat' }); return true; }
      if (body?.action === 'create') {
        const validTitle = body.title === undefined || (typeof body.title === 'string' && body.title.length <= 32 && !/[\u0000-\u001f]/.test(body.title));
        const validExpiry = body.expireDate === undefined || (Number.isSafeInteger(body.expireDate) && body.expireDate > Math.floor(Date.now() / 1000));
        const validLimit = body.usageLimit === undefined || (Number.isSafeInteger(body.usageLimit) && body.usageLimit >= 1 && body.usageLimit <= 99999);
        if (!validTitle || !validExpiry || !validLimit || typeof body.requestNeeded !== 'boolean') {
          sendJson(res, 400, { error: 'Invalid Telegram invite link options' });
          return true;
        }
        try {
          const link = await inst!.accountAction('create_chat_invite_link', {
            chatId, title: body.title, expireDate: body.expireDate, usageLimit: body.usageLimit, requestNeeded: body.requestNeeded,
          });
          sendJson(res, 200, link);
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      if (body?.action === 'edit' && typeof body.link === 'string' &&
          /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(body.link)) {
        if (typeof body.title !== 'string' || body.title.trim().length > 32 || /[\u0000-\u001f]/.test(body.title)) {
          sendJson(res, 400, { error: 'Invalid Telegram invite link title' }); return true;
        }
        try {
          const updated = await inst!.accountAction('edit_chat_invite_link', { chatId, link: body.link, title: body.title.trim() });
          sendJson(res, 200, updated);
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      if (body?.action === 'revoke' && typeof body.link === 'string' &&
          /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(body.link)) {
        try {
          await inst!.accountAction('revoke_chat_invite_link', { chatId, link: body.link });
          sendJson(res, 200, { success: true });
        } catch (err: any) { sendJson(res, 500, { error: err.message }); }
        return true;
      }
      sendJson(res, 400, { error: 'Invalid Telegram invite link action' });
      return true;
    }

    if (subRoute === 'account/join-requests' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const dateParam = url.searchParams.get('date');
        const userIdParam = url.searchParams.get('userId');
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        const query = (url.searchParams.get('query') || '').trim();
        const cursor = dateParam !== null || userIdParam !== null
          ? { date: Number(dateParam), userId: Number(userIdParam) } : undefined;
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || (cursor &&
            (!Number.isSafeInteger(cursor.date) || cursor.date <= 0 || !Number.isSafeInteger(cursor.userId) || cursor.userId <= 0)) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || query.length > 128) {
          return sendJson(res, 400, { error: 'Invalid join request query' }), true;
        }
        const result = await inst!.accountAction('get_join_requests', { chatId, cursor, limit, query });
        sendJson(res, 200, result || { count: 0, requests: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/join-requests' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 || typeof body.approved !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid join request decision' }), true;
        }
        await inst!.accountAction('decide_join_request', { chatId, userId, approved: body.approved });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/join-requests/all' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof body.approved !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid bulk join request decision' }), true;
        }
        await inst!.accountAction('decide_all_join_requests', { chatId, approved: body.approved });
        sendJson(res, 200, { success: true });
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

    if (subRoute === 'account/invite-user' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          sendJson(res, 400, { error: 'Invalid Telegram member invitation' }); return true;
        }
        await inst!.accountAction('invite_user', { chatId, userId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/ban' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId), untilDate = Number(body.untilDate ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
            !Number.isSafeInteger(untilDate) || (untilDate !== 0 && (untilDate <= now || untilDate > now + 31536000))) {
          sendJson(res, 400, { error: 'Invalid Telegram member ban' }); return true;
        }
        await inst!.accountAction('ban_user', { chatId, userId, untilDate });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/unban' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          return sendJson(res, 400, { error: 'Invalid unban target' }), true;
        }
        await inst!.accountAction('unban_user', { chatId, userId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/mute' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId), seconds = Number(body.seconds ?? 0);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
            !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31536000) {
          sendJson(res, 400, { error: 'Invalid Telegram member mute' }); return true;
        }
        await inst!.accountAction('mute_user', { chatId, userId, seconds });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/promote' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId);
        const allowed = ['changeInfo', 'postMessages', 'editMessages', 'deleteMessages', 'banUsers', 'inviteUsers', 'pinMessages', 'addAdmins', 'anonymous', 'manageCall', 'manageTopics', 'postStories', 'editStories', 'deleteStories'];
        const supplied = body.perms && typeof body.perms === 'object' && !Array.isArray(body.perms) ? body.perms : {};
        const perms: Record<string, boolean> = {};
        for (const key of allowed) {
          if (supplied[key] !== undefined) {
            if (typeof supplied[key] !== 'boolean') return sendJson(res, 400, { error: `Invalid admin permission: ${key}` }), true;
            perms[key] = supplied[key];
          }
        }
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          return sendJson(res, 400, { error: 'Invalid admin promotion' }), true;
        }
        await inst!.accountAction('promote_user', { chatId, userId, perms });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/demote' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), userId = Number(body.userId);
        if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
          return sendJson(res, 400, { error: 'Invalid admin demotion' }), true;
        }
        await inst!.accountAction('demote_user', { chatId, userId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/translate' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const messageId = Number(body.messageId);
        const targetLang = typeof body.targetLang === 'string' ? body.targetLang : 'zh-hans';
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(targetLang) || targetLang.length > 16) {
          sendJson(res, 400, { error: 'Invalid message translation request' });
          return true;
        }
        const result = await inst!.accountAction('translate_message', { chatId, messageId, targetLang: targetLang.toLowerCase() });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: `Telegram 翻译失败: ${err.message}` });
      }
      return true;
    }

    if (subRoute === 'account/message-fact-check' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          sendJson(res, 400, { error: 'Invalid fact-check request' }); return true;
        }
        const factChecks = await inst!.accountAction('get_message_fact_checks', { chatId, messageId });
        sendJson(res, 200, factChecks || []);
      } catch (err: any) { sendJson(res, 500, { error: `读取事实核查失败: ${err.message}` }); }
      return true;
    }

    if (subRoute === 'account/message-report' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          sendJson(res, 400, { error: 'Invalid message report request' }); return true;
        }
        const progress = await inst!.accountAction('start_message_report', { chatId, messageId });
        sendJson(res, 200, progress);
      } catch (err: any) { sendJson(res, 500, { error: `启动举报失败: ${err.message}` }); }
      return true;
    }

    if (subRoute === 'account/message-report/continue' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token) ||
            (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 1024))) {
          sendJson(res, 400, { error: 'Invalid message report continuation' }); return true;
        }
        const progress = await inst!.accountAction('continue_message_report', {
          token: body.token, ...(body.comment == null ? {} : { comment: body.comment }),
        });
        sendJson(res, 200, progress);
      } catch (err: any) { sendJson(res, 500, { error: `继续举报失败: ${err.message}` }); }
      return true;
    }

    if (subRoute === 'account/translate-batch' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageIds = body.messageIds;
        const targetLang = typeof body.targetLang === 'string' ? body.targetLang : 'zh-hans';
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 20 ||
            messageIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
            !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(targetLang) || targetLang.length > 16) {
          sendJson(res, 400, { error: 'Invalid batch message translation request' });
          return true;
        }
        const result = await inst!.accountAction('translate_messages', { chatId, messageIds, targetLang: targetLang.toLowerCase() });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: `Telegram 翻译失败: ${err.message}` });
      }
      return true;
    }

    if (subRoute === 'account/translation-settings' && method === 'GET') {
      const chatId = Number(url.searchParams.get('chatId'));
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        sendJson(res, 400, { error: 'Invalid translation peer' });
        return true;
      }
      try {
        const result = await inst!.accountAction('get_chat_translation_settings', { chatId });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/translation-settings' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'Invalid translation setting' });
          return true;
        }
        const result = await inst!.accountAction('set_chat_translation_enabled', { chatId, enabled: body.enabled });
        sendJson(res, 200, result);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/dice' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { error: 'Invalid Telegram dice request' }), true;
        }
        const chatId = Number(body.chatId);
        const emoticon = body.emoticon == null ? '🎲' : body.emoticon;
        if (!Number.isSafeInteger(chatId) || chatId === 0 ||
            !['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'].includes(emoticon) ||
            (body.topicId != null && (!Number.isSafeInteger(body.topicId) || body.topicId <= 0))) {
          return sendJson(res, 400, { error: 'Invalid Telegram dice request' }), true;
        }
        const result = await inst!.accountAction('send_dice', { chatId, emoticon, ...(body.topicId == null ? {} : { topMsgId: body.topicId }) });
        sendJson(res, 200, result || { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/poll' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, question, options, pollOptions, schedule, scheduleRepeatPeriod } = body;
        const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
        const normalizedOptions = Array.isArray(options) ? options.map((option: unknown) => typeof option === 'string' ? option.trim() : '') : [];
        const settings = pollOptions == null ? {} : pollOptions;
        if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 || !normalizedQuestion || normalizedQuestion.length > 300 ||
            normalizedOptions.length < 2 || normalizedOptions.length > 10 || normalizedOptions.some((option: string) => !option || option.length > 100) ||
            new Set(normalizedOptions).size !== normalizedOptions.length || !settings || typeof settings !== 'object' || Array.isArray(settings) ||
            (settings.isAnonymous != null && typeof settings.isAnonymous !== 'boolean') ||
            (settings.isMultipleChoice != null && typeof settings.isMultipleChoice !== 'boolean') ||
            (settings.isQuiz != null && typeof settings.isQuiz !== 'boolean') ||
            (settings.isQuiz && settings.isMultipleChoice) ||
            (settings.isQuiz && (!Number.isSafeInteger(settings.correctOptionIndex) || settings.correctOptionIndex < 0 || settings.correctOptionIndex >= normalizedOptions.length)) ||
            (settings.correctOptionIndex != null && (!Number.isSafeInteger(settings.correctOptionIndex) || settings.correctOptionIndex < 0 || settings.correctOptionIndex >= normalizedOptions.length)) ||
            (settings.explanation != null && (typeof settings.explanation !== 'string' || settings.explanation.length > 200)) ||
            (schedule != null && (!Number.isSafeInteger(schedule) || schedule <= 0)) ||
            (scheduleRepeatPeriod != null && (!isScheduleRepeatPeriod(scheduleRepeatPeriod) || schedule == null))) {
          return sendJson(res, 400, { error: 'Invalid Telegram poll' }), true;
        }
        const result = await inst!.accountAction('send_poll', {
          chatId: Number(chatId), question: normalizedQuestion, options: normalizedOptions, pollOptions: settings,
          ...(schedule == null ? {} : { schedule }), ...(scheduleRepeatPeriod == null ? {} : { scheduleRepeatPeriod }),
        });
        sendJson(res, 200, result || { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/poll/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        const { question, options, pollOptions = {} } = body;
        const normalizedOptions = Array.isArray(options) ? options.map((option: unknown) => typeof option === 'string' ? option.trim() : option) : [];
        const correctOptionIndex = pollOptions?.correctOptionIndex;
        const explanation = pollOptions?.explanation;
        if ((pollOptions != null && (!pollOptions || typeof pollOptions !== 'object' || Array.isArray(pollOptions))) ||
            !Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            typeof question !== 'string' || !question.trim() || question.trim().length > 300 ||
            normalizedOptions.length < 2 || normalizedOptions.length > 10 ||
            normalizedOptions.some((option: unknown) => typeof option !== 'string' || !option || option.length > 100) ||
            new Set(normalizedOptions).size !== normalizedOptions.length ||
            (correctOptionIndex != null && (!Number.isSafeInteger(correctOptionIndex) || correctOptionIndex < 0 || correctOptionIndex >= normalizedOptions.length)) ||
            (explanation != null && (typeof explanation !== 'string' || explanation.length > 200))) {
          return sendJson(res, 400, { error: 'Invalid Telegram poll edit' }), true;
        }
        await inst!.accountAction('edit_poll', { chatId, messageId, question, options: normalizedOptions, pollOptions: { correctOptionIndex, explanation } });
        sendJson(res, 200, { success: true });
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

    if (subRoute === 'account/todo/create' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!Number.isSafeInteger(Number(body.chatId)) || Number(body.chatId) === 0 || typeof body.title !== 'string' ||
            !body.title.trim() || body.title.length > 255 || !Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 10 ||
            body.tasks.some((task: unknown) => typeof task !== 'string' || !task.trim() || task.length > 255) ||
            (body.othersCanComplete != null && typeof body.othersCanComplete !== 'boolean') ||
            (body.othersCanAppend != null && typeof body.othersCanAppend !== 'boolean')) {
          return sendJson(res, 400, { error: 'Invalid Telegram to-do list' }), true;
        }
        const result = await inst!.accountAction('send_todo_list', {
          chatId: Number(body.chatId), title: body.title, tasks: body.tasks,
          othersCanComplete: Boolean(body.othersCanComplete), othersCanAppend: Boolean(body.othersCanAppend),
        });
        sendJson(res, 200, { messageId: Number.isSafeInteger(result?.messageId) && result.messageId > 0 ? result.messageId : undefined });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/todo/toggle' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!Number.isSafeInteger(Number(body.chatId)) || Number(body.chatId) === 0 ||
            !Number.isSafeInteger(Number(body.messageId)) || Number(body.messageId) <= 0 ||
            !Number.isSafeInteger(Number(body.taskId)) || Number(body.taskId) < 1 || typeof body.completed !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid Telegram to-do task' }), true;
        }
        await inst!.accountAction('toggle_todo_task', { chatId: Number(body.chatId), messageId: Number(body.messageId), taskId: Number(body.taskId), completed: body.completed });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/todo/append' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!Number.isSafeInteger(Number(body.chatId)) || Number(body.chatId) === 0 ||
            !Number.isSafeInteger(Number(body.messageId)) || Number(body.messageId) <= 0 ||
            !Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 10 ||
            body.tasks.some((task: unknown) => typeof task !== 'string' || !task.trim() || task.length > 255)) {
          return sendJson(res, 400, { error: 'Invalid Telegram to-do tasks' }), true;
        }
        await inst!.accountAction('append_todo_tasks', { chatId: Number(body.chatId), messageId: Number(body.messageId), tasks: body.tasks });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/todo/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const taskIds = new Set<number>();
        const duplicateTaskId = Array.isArray(body.tasks) && body.tasks.some((task: any) => {
          if (!Number.isSafeInteger(task?.id)) return false;
          if (taskIds.has(task.id)) return true;
          taskIds.add(task.id);
          return false;
        });
        if (!Number.isSafeInteger(Number(body.chatId)) || Number(body.chatId) === 0 ||
            !Number.isSafeInteger(Number(body.messageId)) || Number(body.messageId) <= 0 || typeof body.title !== 'string' ||
            !body.title.trim() || body.title.length > 255 || !Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 10 ||
            body.tasks.some((task: any) => !task || typeof task !== 'object' || Array.isArray(task) ||
              (task.id != null && (!Number.isSafeInteger(task.id) || task.id < 1)) ||
              typeof task.title !== 'string' || !task.title.trim() || task.title.length > 255) ||
            duplicateTaskId || (body.othersCanComplete != null && typeof body.othersCanComplete !== 'boolean') ||
            (body.othersCanAppend != null && typeof body.othersCanAppend !== 'boolean')) {
          return sendJson(res, 400, { error: 'Invalid Telegram to-do list edit' }), true;
        }
        await inst!.accountAction('edit_todo_list', {
          chatId: Number(body.chatId), messageId: Number(body.messageId), title: body.title, tasks: body.tasks,
          othersCanComplete: body.othersCanComplete, othersCanAppend: body.othersCanAppend,
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/poll-votes' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const messageId = Number(url.searchParams.get('messageId'));
        const optionIndex = Number(url.searchParams.get('optionIndex'));
        const offset = url.searchParams.get('offset') || undefined;
        const limit = Number(url.searchParams.get('limit')) || 50;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !Number.isSafeInteger(optionIndex) || optionIndex < 0 || (offset !== undefined && (offset.length > 256 || /[\u0000-\u001f]/.test(offset))) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          sendJson(res, 400, { error: 'Invalid poll voter request' }); return true;
        }
        const result = await inst!.accountAction('get_poll_votes', { chatId, messageId, optionIndex, offset, limit });
        sendJson(res, 200, result || { count: 0, voters: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/poll/close' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          sendJson(res, 400, { error: 'Invalid poll close request' }); return true;
        }
        await inst!.accountAction('close_poll', { chatId, messageId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-replies' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_quick_replies');
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/messages' && method === 'GET') {
      try {
        const shortcutId = Number(url.searchParams.get('shortcutId'));
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0) return sendJson(res, 400, { error: 'Invalid quick reply shortcut' }), true;
        const result = await inst!.accountAction('get_quick_reply_messages', { shortcutId });
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/create' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcut = typeof body.shortcut === 'string' ? body.shortcut.trim() : '';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!/^[a-zA-Z0-9_]{1,32}$/.test(shortcut) || !text.trim() || text.length > 4096) {
          return sendJson(res, 400, { error: 'Invalid quick reply content' }), true;
        }
        await inst!.accountAction('create_quick_reply', { shortcut, text });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/message/add' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcutId = Number(body.shortcutId);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !text.trim() || text.length > 4096) {
          return sendJson(res, 400, { error: 'Invalid quick reply content' }), true;
        }
        await inst!.accountAction('add_quick_reply_message', { shortcutId, text });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if ((subRoute === 'account/quick-reply/media' || subRoute === 'account/quick-reply/media/replace') && method === 'POST') {
      let stagedPath: string | undefined;
      let handedOff = false;
      let notDispatched = false;
      const replacingMedia = subRoute.endsWith('/replace');
      try {
        if (!String(req.headers['content-type'] || '').startsWith('application/vnd.tguserbot.media-stream')) {
          req.resume();
          return sendJson(res, 415, { error: 'Quick reply media requires a streamed upload' }), true;
        }
        const staged = await receiveStreamUpload(req);
        stagedPath = staged.path;
        const { shortcutId, messageId, fileName, mimeType, caption } = staged.metadata;
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || typeof fileName !== 'string' || !fileName.trim() ||
            typeof mimeType !== 'string' || mimeType.length > 128 || (caption != null && (typeof caption !== 'string' || caption.length > 1024)) ||
            (replacingMedia && (!Number.isSafeInteger(messageId) || messageId <= 0))) {
          throw new Error('Invalid quick reply media metadata');
        }
        const workerPid = inst!.getInfo?.().pid;
        if (!workerPid) throw new Error('账号未在线');
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        await markStreamUploadOwner(stagedPath, workerPid);
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        handedOff = true;
        await inst!.accountAction(replacingMedia ? 'replace_quick_reply_media' : 'add_quick_reply_media', {
          shortcutId, ...(replacingMedia ? { messageId } : {}), uploadPath: stagedPath, fileName, mimeType, caption: caption || '',
        });
        await cleanupStreamUpload(stagedPath).catch(() => {});
        stagedPath = undefined;
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
        if (stagedPath && (!handedOff || notDispatched)) await cleanupStreamUpload(stagedPath).catch(() => {});
        if (!res.destroyed) sendJson(res, err.message === 'Payload too large' ? 413 : /Invalid quick reply media metadata|Missing file data|Invalid upload metadata/.test(err.message) ? 400 : 500, { error: err.message });
        if (stagedPath && handedOff && !notDispatched) watchOrphanedStreamUpload(stagedPath);
      }
      return true;
    }

    if (subRoute === 'account/message/media/replace' && method === 'POST') {
      let stagedPath: string | undefined;
      let handedOff = false;
      let notDispatched = false;
      try {
        if (!String(req.headers['content-type'] || '').startsWith('application/vnd.tguserbot.media-stream')) {
          req.resume();
          return sendJson(res, 415, { error: 'Message media replacement requires a streamed upload' }), true;
        }
        const staged = await receiveStreamUpload(req);
        stagedPath = staged.path;
        const { chatId, messageId, fileName, mimeType, caption, parseMode } = staged.metadata;
        if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            typeof fileName !== 'string' || !fileName.trim() || typeof mimeType !== 'string' || mimeType.length > 128 ||
            (caption != null && (typeof caption !== 'string' || caption.length > 1024)) ||
            (parseMode != null && !['plain', 'markdown', 'html'].includes(parseMode))) {
          throw new Error('Invalid message media replacement metadata');
        }
        const workerPid = inst!.getInfo?.().pid;
        if (!workerPid) throw new Error('账号未在线');
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        await markStreamUploadOwner(stagedPath, workerPid);
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        handedOff = true;
        await inst!.accountAction('replace_message_media', {
          chatId: Number(chatId), messageId, uploadPath: stagedPath, fileName, mimeType,
          caption: caption || '', parseMode: parseMode || 'plain',
        });
        await cleanupStreamUpload(stagedPath).catch(() => {});
        stagedPath = undefined;
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
        if (stagedPath && (!handedOff || notDispatched)) await cleanupStreamUpload(stagedPath).catch(() => {});
        if (!res.destroyed) sendJson(res, err.message === 'Payload too large' ? 413 : /Invalid message media replacement metadata|Missing file data|Invalid upload metadata/.test(err.message) ? 400 : 500, { error: err.message });
        if (stagedPath && handedOff && !notDispatched) watchOrphanedStreamUpload(stagedPath);
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/message/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcutId = Number(body.shortcutId), messageId = Number(body.messageId);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !text.trim() || text.length > 4096) return sendJson(res, 400, { error: 'Invalid quick reply edit request' }), true;
        await inst!.accountAction('edit_quick_reply_message', { shortcutId, messageId, text });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/message/delete' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcutId = Number(body.shortcutId);
        const messageIds = Array.isArray(body.messageIds) ? body.messageIds.map(Number) : [];
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !messageIds.length || messageIds.length > 100 ||
            messageIds.some((id: number) => !Number.isSafeInteger(id) || id <= 0)) {
          return sendJson(res, 400, { error: 'Invalid quick reply delete request' }), true;
        }
        await inst!.accountAction('delete_quick_reply_messages', { shortcutId, messageIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/send' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), shortcutId = Number(body.shortcutId);
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(shortcutId) || shortcutId <= 0) {
          return sendJson(res, 400, { error: 'Invalid quick reply request' }), true;
        }
        await inst!.accountAction('send_quick_reply', { chatId, shortcutId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/rename' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcutId = Number(body.shortcutId);
        const shortcut = typeof body.shortcut === 'string' ? body.shortcut.trim() : '';
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !/^[a-zA-Z0-9_]{1,32}$/.test(shortcut)) {
          return sendJson(res, 400, { error: 'Invalid quick reply shortcut' }), true;
        }
        await inst!.accountAction('rename_quick_reply', { shortcutId, shortcut });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/quick-reply/delete' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const shortcutId = Number(body.shortcutId);
        if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0) {
          return sendJson(res, 400, { error: 'Invalid quick reply shortcut' }), true;
        }
        await inst!.accountAction('delete_quick_reply', { shortcutId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/scheduled-messages' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0) return sendJson(res, 400, { error: 'Invalid chatId' }), true;
        const result = await inst!.accountAction('get_scheduled_messages', { chatId });
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if ((subRoute === 'account/scheduled-messages/send-now' || subRoute === 'account/scheduled-messages/delete') && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const messageIds = Array.isArray(body.messageIds) ? body.messageIds.map(Number) : [];
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !messageIds.length || messageIds.length > 100 ||
            messageIds.some((id: number) => !Number.isSafeInteger(id) || id <= 0)) {
          return sendJson(res, 400, { error: 'Invalid scheduled message request' }), true;
        }
        const action = subRoute.endsWith('/send-now') ? 'send_scheduled_now' : 'delete_scheduled_messages';
        await inst!.accountAction(action, { chatId, messageIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/scheduled-messages/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            typeof body.text !== 'string' || body.text.length > 4096 ||
            (body.parseMode != null && !['plain', 'markdown', 'html'].includes(body.parseMode)) ||
            (body.schedule != null && (!Number.isSafeInteger(body.schedule) || body.schedule <= Math.floor(Date.now() / 1000))) ||
            (body.scheduleRepeatPeriod != null && (!isScheduleRepeatPeriod(body.scheduleRepeatPeriod) || body.schedule == null))) {
          return sendJson(res, 400, { error: 'Invalid scheduled message edit request' }), true;
        }
        await inst!.accountAction('edit_scheduled_message', {
          chatId, messageId, text: body.text,
          ...(body.parseMode == null ? {} : { parseMode: body.parseMode }),
          ...(body.schedule == null ? {} : { schedule: body.schedule }),
          ...(body.scheduleRepeatPeriod === undefined ? {} : { scheduleRepeatPeriod: body.scheduleRepeatPeriod }),
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/transcribe' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          return sendJson(res, 400, { error: 'Invalid voice transcription request' }), true;
        }
        const result = await inst!.accountAction('transcribe_voice_message', { chatId, messageId });
        sendJson(res, 200, result || { text: '', pending: false });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/transcribe/rate' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        const transcriptionId = typeof body.transcriptionId === 'string' ? body.transcriptionId : '';
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !/^-?\d{1,20}$/.test(transcriptionId) || typeof body.good !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid transcription rating request' }), true;
        }
        await inst!.accountAction('rate_voice_transcription', { chatId, messageId, transcriptionId, good: body.good });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/message-reactions' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const messageId = Number(url.searchParams.get('messageId'));
        const emoji = url.searchParams.get('emoji') || '';
        const offset = url.searchParams.get('offset') || '';
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !isReactionIdentifier(emoji) || emoji.length > 32 || offset.length > 512 || /[\u0000-\u001f]/.test(offset) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(res, 400, { error: 'Invalid message reaction list request' }), true;
        }
        const result = await inst!.accountAction('get_message_reaction_users', { chatId, messageId, emoji, offset, limit });
        sendJson(res, 200, result || { count: 0, users: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/message-read-participants' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const messageId = Number(url.searchParams.get('messageId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          return sendJson(res, 400, { error: 'Invalid message read participants request' }), true;
        }
        const result = await inst!.accountAction('get_message_read_participants', { chatId, messageId });
        sendJson(res, 200, result || { count: 0, participants: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/authorizations' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_telegram_authorizations');
        sendJson(res, 200, result || { authorizationTtlDays: 0, sessions: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-settings' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_privacy_settings');
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-settings' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const key = typeof body.key === 'string' ? body.key : '';
        const mode = typeof body.mode === 'string' ? body.mode : '';
        const supportedKeys = new Set(['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'peerToPeerCalls',
          'groupInvites', 'about', 'birthday', 'voiceMessages', 'addedByPhone']);
        if (!supportedKeys.has(key) || !['everybody', 'contacts', 'nobody'].includes(mode)) {
          return sendJson(res, 400, { error: 'Invalid account privacy setting' }), true;
        }
        await inst!.accountAction('set_account_privacy_setting', { key, mode });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-exceptions' && method === 'GET') {
      try {
        const key = url.searchParams.get('key') || '';
        const supportedKeys = new Set(['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'peerToPeerCalls',
          'groupInvites', 'about', 'birthday', 'voiceMessages', 'addedByPhone']);
        if (!supportedKeys.has(key)) return sendJson(res, 400, { error: 'Invalid account privacy setting' }), true;
        const result = await inst!.accountAction('get_account_privacy_exceptions', { key });
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-exceptions' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const supportedKeys = new Set(['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'peerToPeerCalls',
          'groupInvites', 'about', 'birthday', 'voiceMessages', 'addedByPhone']);
        const categories = new Set(['allowedUsers', 'blockedUsers', 'allowedChats', 'blockedChats']);
        const operation = body.operation === undefined ? 'remove' : body.operation;
        if (typeof body.key !== 'string' || !supportedKeys.has(body.key) ||
            typeof body.category !== 'string' || !categories.has(body.category) ||
            !['add', 'remove'].includes(operation) ||
            (operation === 'remove' && (typeof body.entityId !== 'string' || !/^\d{1,20}$/.test(body.entityId) || /^0+$/.test(body.entityId))) ||
            (operation === 'add' && ['allowedUsers', 'blockedUsers'].includes(body.category) &&
              (typeof body.entityId !== 'string' || !/^\d{1,20}$/.test(body.entityId) || /^0+$/.test(body.entityId))) ||
            (operation === 'add' && ['allowedChats', 'blockedChats'].includes(body.category) &&
              (!Number.isSafeInteger(body.chatId) || body.chatId >= 0))) {
          return sendJson(res, 400, { error: 'Invalid account privacy exception' }), true;
        }
        if (operation === 'add') {
          if (['allowedChats', 'blockedChats'].includes(body.category)) {
            await inst!.accountAction('add_account_privacy_chat_exception', { key: body.key, category: body.category, chatId: body.chatId });
          } else {
            await inst!.accountAction('add_account_privacy_user_exception', { key: body.key, category: body.category, userId: body.entityId });
          }
        } else {
          await inst!.accountAction('remove_account_privacy_exception', { key: body.key, category: body.category, entityId: body.entityId });
        }
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-special-rules' && method === 'GET') {
      try {
        const key = url.searchParams.get('key') || '';
        const supportedKeys = new Set(['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'peerToPeerCalls',
          'groupInvites', 'about', 'birthday', 'voiceMessages', 'addedByPhone']);
        if (!supportedKeys.has(key)) return sendJson(res, 400, { error: 'Invalid account privacy setting' }), true;
        const result = await inst!.accountAction('get_account_privacy_special_rules', { key });
        sendJson(res, 200, result || { allowPremium: false, botAccess: 'default', editable: false, unsupportedRules: 0 });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/privacy-special-rules' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const supportedKeys = new Set(['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'peerToPeerCalls',
          'groupInvites', 'about', 'birthday', 'voiceMessages', 'addedByPhone']);
        const validValue = body.field === 'allowPremium' ? typeof body.value === 'boolean'
          : body.field === 'botAccess' && ['default', 'allow', 'deny'].includes(body.value);
        if (typeof body.key !== 'string' || !supportedKeys.has(body.key) || !validValue) {
          return sendJson(res, 400, { error: 'Invalid Telegram privacy special rule' }), true;
        }
        await inst!.accountAction('set_account_privacy_special_rule', { key: body.key, field: body.field, value: body.value });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/global-privacy-settings' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_global_privacy_settings');
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/global-privacy-settings' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const keys = new Set(['archiveNewNoncontacts', 'keepArchivedUnmuted', 'keepArchivedFolders', 'hideReadMarks', 'requirePremiumForNewNoncontacts']);
        if (typeof body.key !== 'string' || !keys.has(body.key) || typeof body.value !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid Telegram global privacy setting' }), true;
        }
        await inst!.accountAction('set_account_global_privacy_setting', { key: body.key, value: body.value });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-settings' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_notification_settings');
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars' && method === 'GET') {
      try {
        const offset = url.searchParams.get('offset') || '';
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 20 : Number(rawLimit);
        if (offset.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(res, 400, { error: 'Invalid Telegram Stars pagination' }), true;
        }
        const result = await inst!.accountAction('get_account_stars', { offset, limit });
        sendJson(res, 200, result && typeof result === 'object' ? result : { balance: { amount: '0', nanos: 0 }, transactions: [], nextOffset: '' });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars-topup-options' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_stars_topup_options');
        const options = Array.isArray(result) ? result.filter((option: any) => option &&
          typeof option.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(option.id) &&
          typeof option.stars === 'string' && /^\d{1,20}$/.test(option.stars) && !/^0+$/.test(option.stars) &&
          typeof option.currency === 'string' && /^[A-Z]{3}$/.test(option.currency) &&
          typeof option.amount === 'string' && /^\d{1,20}$/.test(option.amount) && !/^0+$/.test(option.amount) &&
          typeof option.extended === 'boolean').map((option: any) => ({ id: option.id, stars: option.stars,
            currency: option.currency, amount: option.amount, extended: option.extended })) : [];
        sendJson(res, 200, options);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars-topup/prepare' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const optionId = body.optionId;
        if (typeof optionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(optionId)) {
          return sendJson(res, 400, { error: 'Invalid Telegram Stars top-up option' }), true;
        }
        const result = await inst!.accountAction('prepare_account_stars_topup', { optionId });
        if (!result || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.token) ||
            typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars) ||
            typeof result.currency !== 'string' || !/^[A-Z]{3}$/.test(result.currency) ||
            typeof result.amount !== 'string' || !/^\d{1,20}$/.test(result.amount)) {
          throw new Error('Telegram returned an invalid Stars top-up confirmation');
        }
        sendJson(res, 200, { token: result.token, stars: result.stars, currency: result.currency, amount: result.amount,
          title: String(result.title || 'Telegram Stars').slice(0, 256), description: String(result.description || '').slice(0, 1024) });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars-topup/confirm' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const token = body.token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
          return sendJson(res, 400, { error: 'Invalid Telegram Stars top-up confirmation' }), true;
        }
        const result = await inst!.accountAction('confirm_account_stars_topup', { token });
        if (!result || typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) {
          throw new Error('Telegram returned an invalid Stars top-up result');
        }
        if (result.verificationUrl != null) {
          let verificationUrl: URL;
          try { verificationUrl = new URL(String(result.verificationUrl)); }
          catch { throw new Error('Telegram returned an invalid payment verification URL'); }
          if (verificationUrl.protocol !== 'https:' || verificationUrl.username || verificationUrl.password) {
            throw new Error('Telegram returned an unsafe payment verification URL');
          }
          sendJson(res, 200, { stars: result.stars, verificationUrl: verificationUrl.href });
        } else sendJson(res, 200, { stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/gift-codes/check' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const slug = body.slug;
        if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) {
          return sendJson(res, 400, { error: 'Invalid Telegram gift code' }), true;
        }
        const result = await inst!.accountAction('check_account_gift_code', { slug });
        if (!result || result.slug !== slug || !Number.isSafeInteger(result.months) || result.months < 1 || result.months > 120 ||
            !Number.isSafeInteger(result.date) || result.date < 0 || typeof result.viaGiveaway !== 'boolean' ||
            typeof result.recipientMatches !== 'boolean' || (result.usedDate != null && (!Number.isSafeInteger(result.usedDate) || result.usedDate < 0))) {
          throw new Error('Telegram returned an invalid gift code preview');
        }
        sendJson(res, 200, { slug, months: result.months, date: result.date,
          ...(result.usedDate != null ? { usedDate: result.usedDate } : {}), viaGiveaway: result.viaGiveaway,
          recipientMatches: result.recipientMatches });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/gift-codes/apply' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const slug = body.slug;
        if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) {
          return sendJson(res, 400, { error: 'Invalid Telegram gift code' }), true;
        }
        const result = await inst!.accountAction('apply_account_gift_code', { slug });
        if (!result || result.applied !== true || !Number.isSafeInteger(result.months) || result.months < 1 || result.months > 120) {
          throw new Error('Telegram did not confirm gift code activation');
        }
        sendJson(res, 200, { applied: true, months: result.months });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/paid-media/prepare' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
          return sendJson(res, 400, { error: 'Invalid paid media target' }), true;
        }
        const result = await inst!.accountAction('prepare_chat_paid_media', { chatId, messageId });
        if (!result || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.token) ||
            typeof result.stars !== 'string' || !/^\d{1,13}$/.test(result.stars) ||
            !Number.isSafeInteger(result.itemCount) || result.itemCount < 1 || result.itemCount > 10) {
          throw new Error('Telegram returned an invalid paid media confirmation');
        }
        sendJson(res, 200, { token: result.token, stars: result.stars, itemCount: result.itemCount,
          title: String(result.title || '付费媒体').slice(0, 256), description: String(result.description || '').slice(0, 1024) });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/paid-media/confirm' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId), token = body.token;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
          return sendJson(res, 400, { error: 'Invalid paid media payment confirmation' }), true;
        }
        const result = await inst!.accountAction('confirm_chat_paid_media', { chatId, messageId, token });
        sendJson(res, 200, result && typeof result.stars === 'string' ? { stars: result.stars } : { stars: '0' });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/star-gifts' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_star_gifts');
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts' && method === 'GET') {
      try {
        const offset = url.searchParams.get('offset') || '';
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 20 : Number(rawLimit);
        if (offset.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(res, 400, { error: 'Invalid saved Telegram Star Gifts pagination' }), true;
        }
        const result = await inst!.accountAction('get_account_saved_star_gifts', { offset, limit });
        if (!result || !Array.isArray(result.gifts)) throw new Error('Telegram returned invalid saved Star Gifts');
        const gifts = result.gifts.filter((gift: any) => gift && typeof gift.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(gift.id) &&
          typeof gift.title === 'string' && typeof gift.emoji === 'string' && Number.isSafeInteger(gift.date) && gift.date >= 0 &&
          typeof gift.saved === 'boolean' && typeof gift.unique === 'boolean' && typeof gift.refunded === 'boolean' &&
          typeof gift.convertStars === 'string' && /^\d{1,20}$/.test(gift.convertStars) && typeof gift.canUpgrade === 'boolean' &&
          typeof gift.canTransfer === 'boolean')
          .map((gift: any) => ({ id: gift.id, title: gift.title.slice(0, 128), emoji: gift.emoji.slice(0, 32), date: gift.date,
            saved: gift.saved, unique: gift.unique, refunded: gift.refunded, convertStars: gift.convertStars,
            ...(typeof gift.upgradeStars === 'string' && /^\d{1,20}$/.test(gift.upgradeStars) ? { upgradeStars: gift.upgradeStars } : {}),
            canUpgrade: gift.canUpgrade,
            ...(typeof gift.transferStars === 'string' && /^\d{1,20}$/.test(gift.transferStars) ? { transferStars: gift.transferStars } : {}),
            canTransfer: gift.canTransfer,
            ...(Number.isSafeInteger(gift.canExportAt) && gift.canExportAt >= 0 ? { canExportAt: gift.canExportAt } : {}),
            message: typeof gift.message === 'string' ? gift.message.slice(0, 1024) : '' }));
        if (result.nextOffset != null && (typeof result.nextOffset !== 'string' || result.nextOffset.length > 512)) {
          throw new Error('Telegram returned an invalid saved Star Gift cursor');
        }
        sendJson(res, 200, { count: Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : gifts.length,
          gifts, nextOffset: typeof result.nextOffset === 'string' ? result.nextOffset : '',
          chatNotificationsEnabled: Boolean(result.chatNotificationsEnabled) });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/save' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.id) || typeof body.saved !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid saved Telegram Star Gift state' }), true;
        }
        const result = await inst!.accountAction('set_account_star_gift_saved', { id: body.id, saved: body.saved });
        if (!result || result.saved !== body.saved) throw new Error('Telegram did not confirm the Star Gift profile change');
        sendJson(res, 200, { saved: result.saved });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/convert' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.id)) {
          return sendJson(res, 400, { error: 'Invalid saved Telegram Star Gift' }), true;
        }
        const result = await inst!.accountAction('convert_account_star_gift', { id: body.id });
        if (!result || result.converted !== true || typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) {
          throw new Error('Telegram did not confirm Star Gift conversion');
        }
        sendJson(res, 200, { converted: true, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/upgrade/prepare' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.id)) {
          return sendJson(res, 400, { error: 'Invalid saved Telegram Star Gift' }), true;
        }
        const result = await inst!.accountAction('prepare_account_star_gift_upgrade', { id: body.id });
        if (!result || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.token) ||
            typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars) || /^0+$/.test(result.stars)) {
          throw new Error('Telegram returned an invalid Star Gift upgrade confirmation');
        }
        sendJson(res, 200, { token: result.token, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/upgrade/confirm' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token) || typeof body.keepOriginalDetails !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid Telegram Star Gift upgrade confirmation' }), true;
        }
        const result = await inst!.accountAction('confirm_account_star_gift_upgrade', {
          token: body.token, keepOriginalDetails: body.keepOriginalDetails,
        });
        if (!result || result.upgraded !== true || typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) {
          throw new Error('Telegram did not confirm Star Gift upgrade');
        }
        sendJson(res, 200, { upgraded: true, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/transfer/prepare' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.id) || !Number.isSafeInteger(chatId) || chatId <= 0) {
          return sendJson(res, 400, { error: 'Invalid Telegram Star Gift transfer request' }), true;
        }
        const result = await inst!.accountAction('prepare_account_star_gift_transfer', { id: body.id, chatId });
        if (!result || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.token) ||
            typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) {
          throw new Error('Telegram returned an invalid Star Gift transfer confirmation');
        }
        sendJson(res, 200, { token: result.token, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/saved-star-gifts/transfer/confirm' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.token) || !Number.isSafeInteger(chatId) || chatId <= 0) {
          return sendJson(res, 400, { error: 'Invalid Telegram Star Gift transfer confirmation' }), true;
        }
        const result = await inst!.accountAction('confirm_account_star_gift_transfer', { token: body.token, chatId });
        if (!result || result.transferred !== true || typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) {
          throw new Error('Telegram did not confirm Star Gift transfer');
        }
        sendJson(res, 200, { transferred: true, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/star-gifts/prepare' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const giftId = body.giftId;
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || typeof giftId !== 'string' ||
            !/^\d{1,20}$/.test(giftId) || /^0+$/.test(giftId) ||
            (body.hideName != null && typeof body.hideName !== 'boolean') ||
            (body.includeUpgrade != null && typeof body.includeUpgrade !== 'boolean')) {
          return sendJson(res, 400, { error: 'Invalid Star Gift request' }), true;
        }
        const result = await inst!.accountAction('prepare_account_star_gift', {
          chatId, giftId, hideName: Boolean(body.hideName), includeUpgrade: Boolean(body.includeUpgrade),
        });
        if (!result || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.token) ||
            typeof result.stars !== 'string' || !/^\d{1,20}$/.test(result.stars)) throw new Error('Telegram returned an invalid payment confirmation');
        sendJson(res, 200, { token: result.token, stars: result.stars });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/star-gifts/confirm' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const giftId = body.giftId;
        const token = body.token;
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || typeof giftId !== 'string' ||
            !/^\d{1,20}$/.test(giftId) || /^0+$/.test(giftId) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
          return sendJson(res, 400, { error: 'Invalid Star Gift payment confirmation' }), true;
        }
        const result = await inst!.accountAction('confirm_account_star_gift', { chatId, giftId, token });
        sendJson(res, 200, result && typeof result === 'object' ? result : { stars: '0' });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars-subscriptions' && method === 'GET') {
      try {
        const offset = url.searchParams.get('offset') || '';
        if (offset.length > 512) return sendJson(res, 400, { error: 'Invalid Telegram Stars subscription cursor' }), true;
        const result = await inst!.accountAction('get_account_stars_subscriptions', { offset });
        sendJson(res, 200, result && typeof result === 'object' ? result : { subscriptions: [], nextOffset: '' });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stars-subscriptions' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.subscriptionId !== 'string' || !body.subscriptionId || body.subscriptionId.length > 512 || typeof body.canceled !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid Telegram Stars subscription' }), true;
        }
        await inst!.accountAction('set_account_stars_subscription_canceled', { subscriptionId: body.subscriptionId, canceled: body.canceled });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-sounds' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_notification_sounds');
        sendJson(res, 200, Array.isArray(result) ? result : [
          { id: 'default', title: '默认提示音' }, { id: 'none', title: '无提示音' },
        ]);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-sounds' && method === 'POST') {
      let stagedPath: string | undefined;
      let handedOff = false;
      try {
        if (!String(req.headers['content-type'] || '').startsWith('application/vnd.tguserbot.media-stream')) {
          req.resume();
          return sendJson(res, 415, { error: 'Notification sound upload requires a streamed audio file' }), true;
        }
        const staged = await receiveStreamUpload(req, undefined, 5 * 1024 * 1024);
        stagedPath = staged.path;
        const { fileName, mimeType } = staged.metadata;
        const safeName = typeof fileName === 'string' ? path.basename(fileName.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(-128) : '';
        const safeMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
        if (!safeName || safeName === '.' || safeName === '..' || !/^audio\/[a-z0-9.+-]+$/.test(safeMime)) {
          throw new Error('Invalid notification sound upload metadata');
        }
        const workerPid = inst!.getInfo?.().pid;
        if (!workerPid) throw new Error('账号未在线');
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        await markStreamUploadOwner(stagedPath, workerPid);
        if (res.destroyed) { await cleanupStreamUpload(stagedPath).catch(() => {}); stagedPath = undefined; return true; }
        handedOff = true;
        await inst!.accountAction('upload_account_notification_sound', { uploadPath: stagedPath, fileName: safeName, mimeType: safeMime });
        await cleanupStreamUpload(stagedPath).catch(() => {});
        stagedPath = undefined;
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        const notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
        if (stagedPath && (!handedOff || notDispatched)) await cleanupStreamUpload(stagedPath).catch(() => {});
        if (!res.destroyed) sendJson(res, err.message === 'Payload too large' ? 413 : /Invalid notification sound upload metadata|Missing file data|Invalid upload metadata/.test(err.message) ? 400 : 500, { error: err.message });
        if (stagedPath && handedOff && !notDispatched) watchOrphanedStreamUpload(stagedPath);
      }
      return true;
    }

    if (subRoute === 'account/notification-sounds/remove' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const soundId = typeof body.soundId === 'string' ? body.soundId : '';
        if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId) || BigInt(soundId) > 9223372036854775807n) {
          return sendJson(res, 400, { error: 'Invalid Telegram notification sound' }), true;
        }
        await inst!.accountAction('remove_account_notification_sound', { soundId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-sound-preview' && method === 'GET') {
      try {
        const soundId = url.searchParams.get('soundId') || '';
        if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId) || BigInt(soundId) > 9223372036854775807n) {
          return sendJson(res, 400, { error: 'Invalid Telegram notification sound' }), true;
        }
        const data = await inst!.accountAction('get_account_notification_sound_preview', { soundId });
        const mimeType = typeof data?.mimeType === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(data.mimeType) ? data.mimeType : '';
        if (data?.filePath && mimeType && fs.existsSync(data.filePath)) {
          res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Notification sound preview not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/notification-exceptions' && method === 'GET') {
      try {
        const key = url.searchParams.get('key') || '';
        if (!['private', 'groups', 'channels'].includes(key)) return sendJson(res, 400, { error: 'Invalid Telegram notification category' }), true;
        const result = await inst!.accountAction('get_account_notification_exceptions', { key });
        sendJson(res, 200, Array.isArray(result) ? result : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-exceptions' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const categories = new Set(['private', 'groups', 'channels']);
        const changes: { muted?: boolean; muteUntil?: number; showPreviews?: boolean; silent?: boolean; soundId?: string; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSoundId?: string } = {};
        if (typeof body.muted === 'boolean') changes.muted = body.muted;
        if (Number.isSafeInteger(body.muteUntil)) changes.muteUntil = body.muteUntil;
        if (typeof body.showPreviews === 'boolean') changes.showPreviews = body.showPreviews;
        if (typeof body.silent === 'boolean') changes.silent = body.silent;
        if (typeof body.soundId === 'string') changes.soundId = body.soundId;
        if (typeof body.storiesMuted === 'boolean') changes.storiesMuted = body.storiesMuted;
        if (typeof body.storiesHideSender === 'boolean') changes.storiesHideSender = body.storiesHideSender;
        if (typeof body.storiesSoundId === 'string') changes.storiesSoundId = body.storiesSoundId;
        const validSoundIds = (body.soundId === undefined || isNotificationSoundId(body.soundId)) &&
          (body.storiesSoundId === undefined || isNotificationSoundId(body.storiesSoundId));
        if (!categories.has(body.key) || !Number.isSafeInteger(body.chatId) || body.chatId === 0 || !Object.keys(changes).length ||
            (body.muted != null && typeof body.muted !== 'boolean') ||
            (body.muteUntil != null && (!Number.isSafeInteger(body.muteUntil) || body.muteUntil < 0 || body.muteUntil > 2147483647)) ||
            (body.muted != null && body.muteUntil != null) ||
            (body.showPreviews != null && typeof body.showPreviews !== 'boolean') ||
            (body.silent != null && typeof body.silent !== 'boolean') ||
            (body.storiesMuted != null && typeof body.storiesMuted !== 'boolean') ||
            (body.storiesHideSender != null && typeof body.storiesHideSender !== 'boolean') || !validSoundIds) {
          return sendJson(res, 400, { error: 'Invalid Telegram notification exception' }), true;
        }
        await inst!.accountAction('set_account_notification_exception', { chatId: body.chatId, ...changes });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/notification-settings' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const key = typeof body.key === 'string' ? body.key : '';
        const categories = new Set(['private', 'groups', 'channels']);
        const changes: { muted?: boolean; muteUntil?: number; showPreviews?: boolean; silent?: boolean; soundId?: string; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSoundId?: string } = {};
        if (typeof body.muted === 'boolean') changes.muted = body.muted;
        if (Number.isSafeInteger(body.muteUntil)) changes.muteUntil = body.muteUntil;
        if (typeof body.showPreviews === 'boolean') changes.showPreviews = body.showPreviews;
        if (typeof body.silent === 'boolean') changes.silent = body.silent;
        if (typeof body.soundId === 'string') changes.soundId = body.soundId;
        if (typeof body.storiesMuted === 'boolean') changes.storiesMuted = body.storiesMuted;
        if (typeof body.storiesHideSender === 'boolean') changes.storiesHideSender = body.storiesHideSender;
        if (typeof body.storiesSoundId === 'string') changes.storiesSoundId = body.storiesSoundId;
        const validSoundIds = (body.soundId === undefined || isNotificationSoundId(body.soundId)) &&
          (body.storiesSoundId === undefined || isNotificationSoundId(body.storiesSoundId));
        if (!categories.has(key) || !Object.keys(changes).length ||
            (body.muted != null && typeof body.muted !== 'boolean') ||
            (body.muteUntil != null && (!Number.isSafeInteger(body.muteUntil) || body.muteUntil < 0 || body.muteUntil > 2147483647)) ||
            (body.muted != null && body.muteUntil != null) ||
            (body.showPreviews != null && typeof body.showPreviews !== 'boolean') ||
            (body.silent != null && typeof body.silent !== 'boolean') ||
            (body.storiesMuted != null && typeof body.storiesMuted !== 'boolean') ||
            (body.storiesHideSender != null && typeof body.storiesHideSender !== 'boolean') || !validSoundIds) {
          return sendJson(res, 400, { error: 'Invalid Telegram notification settings' }), true;
        }
        await inst!.accountAction('set_account_notification_settings', { key, ...changes });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/authorization/revoke' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (typeof body.hash !== 'string' || !/^-?\d{1,20}$/.test(body.hash)) {
          return sendJson(res, 400, { error: 'Invalid Telegram authorization hash' }), true;
        }
        await inst!.accountAction('revoke_telegram_authorization', { hash: body.hash });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/authorizations/revoke-others' && method === 'POST') {
      try {
        await inst!.accountAction('revoke_other_telegram_authorizations');
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
        const result = await inst!.accountAction('mark_all_read');
        sendJson(res, 200, { success: true, ...result });
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

    if (subRoute === 'account/emoji-status' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_account_emoji_status');
        sendJson(res, 200, result || { options: [] });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/emoji-status' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const documentId = body.documentId;
        const durationSeconds = body.durationSeconds;
        if (documentId !== null && (typeof documentId !== 'string' || !/^[1-9]\d{0,19}$/.test(documentId))) throw new Error('Invalid Emoji status document');
        if (documentId !== null && durationSeconds != null && ![0, 3600, 28800, 172800].includes(durationSeconds)) throw new Error('Invalid Emoji status duration');
        await inst!.accountAction('set_account_emoji_status', { documentId, durationSeconds });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 400, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/saved-message-tags' && method === 'GET') {
      try {
        const result = await inst!.accountAction('get_saved_message_tags');
        sendJson(res, 200, result || { tags: [], defaults: [] });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/saved-message-tags' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (!isSavedMessageTagReaction(body.reaction) ||
            (body.title !== undefined && body.title !== null && (typeof body.title !== 'string' || body.title.trim().length > 64))) {
          return sendJson(res, 400, { error: 'Invalid Saved Messages tag' }), true;
        }
        await inst!.accountAction('update_saved_message_tag', {
          reaction: body.reaction,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
        });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 400, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/saved-message-tag' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), messageId = Number(body.messageId);
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 ||
            !isSavedMessageTagReaction(body.reaction) || typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid Saved Messages tag target' }), true;
        }
        await inst!.accountAction('set_saved_message_tag', { chatId, messageId, reaction: body.reaction, enabled: body.enabled });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 400, { error: err.message }); }
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

        const data = await inst!.accountAction('get_avatar', { chatId: Number(chatId), isBig });
        if (data && data.filePath && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, no-store',
          });
          const stream = fs.createReadStream(data.filePath);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
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
            'Cache-Control': 'private, no-store',
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
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || !chatId) return sendJson(res, 400, { error: 'Invalid chatId' }), true;
        const stories = await inst!.accountAction('get_peer_stories', { chatId });
        sendJson(res, 200, stories || []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/story' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const storyId = Number(url.searchParams.get('storyId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
          return sendJson(res, 400, { error: 'Invalid Telegram story request' }), true;
        }
        const story = await inst!.accountAction('get_story_by_id', { chatId, storyId });
        sendJson(res, 200, story || null);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/feed' && method === 'GET') {
      try {
        const state = url.searchParams.get('state') || '';
        const next = url.searchParams.get('next') === '1';
        const hidden = url.searchParams.get('hidden') === '1';
        if (state.length > 2048 || (url.searchParams.has('next') && !['0', '1'].includes(url.searchParams.get('next') || '')) ||
            (url.searchParams.has('hidden') && !['0', '1'].includes(url.searchParams.get('hidden') || '')) || (next && !state)) {
          return sendJson(res, 400, { error: 'Invalid story feed cursor' }), true;
        }
        const feed = await inst!.accountAction('get_story_feed', { state, next, hidden });
        sendJson(res, 200, feed || { peers: [], state: '', hasMore: false, count: 0 });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/stealth' && method === 'GET') {
      try {
        const status = await inst!.accountAction('get_story_stealth_status');
        sendJson(res, 200, status || {});
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/stealth' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (Object.keys(body).length) return sendJson(res, 400, { error: 'Invalid story stealth request' }), true;
        const status = await inst!.accountAction('activate_story_stealth');
        sendJson(res, 200, status || { activated: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/notifications' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0) return sendJson(res, 400, { error: 'Invalid story notification peer' }), true;
        const muted = await inst!.accountAction('get_story_notifications_muted', { chatId });
        sendJson(res, 200, { muted: Boolean(muted?.muted) });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/notifications' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof body.muted !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid story notification setting' }), true;
        }
        await inst!.accountAction('set_story_notifications_muted', { chatId, muted: body.muted });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/archive' && method === 'GET') {
      try {
        const offsetId = url.searchParams.has('offsetId') ? Number(url.searchParams.get('offsetId')) : 0;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
        if (!Number.isSafeInteger(offsetId) || offsetId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          return sendJson(res, 400, { error: 'Invalid story archive cursor' }), true;
        }
        const archive = await inst!.accountAction('get_story_archive', { offsetId, limit });
        sendJson(res, 200, archive || { stories: [], count: 0 });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/albums' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0) return sendJson(res, 400, { error: 'Invalid story album peer' }), true;
        const albums = await inst!.accountAction('get_story_albums', { chatId });
        sendJson(res, 200, albums || []);
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/story-album-cover' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const chatId = Number(url.searchParams.get('chatId')), albumId = Number(url.searchParams.get('albumId'));
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(albumId) || albumId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story album cover' }), true;
        }
        const cover = await inst!.accountAction('get_story_album_cover', { chatId, albumId });
        if (!cover?.filePath || !fs.existsSync(cover.filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
          res.end('Story album cover not found');
          return true;
        }
        const stat = fs.statSync(cover.filePath);
        res.writeHead(200, { 'Content-Type': cover.mimeType || 'image/jpeg', 'Content-Length': stat.size,
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(cover.filePath).on('error', () => res.destroy()).pipe(res);
      } catch (err: any) {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.destroy();
      }
      return true;
    }
    if (subRoute === 'account/stories/albums/stories' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId')), albumId = Number(url.searchParams.get('albumId'));
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(albumId) || albumId <= 0 ||
            !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(res, 400, { error: 'Invalid story album page' }), true;
        }
        const page = await inst!.accountAction('get_story_album_stories', { chatId, albumId, offset, limit });
        sendJson(res, 200, page || { stories: [], count: 0 });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/stories/albums' && method === 'POST') {
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId), storyIds = body.storyIds ?? [];
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || typeof body.title !== 'string' || !body.title.trim() ||
            body.title.length > 64 || /[\u0000-\u001f]/.test(body.title) || !Array.isArray(storyIds) || storyIds.length > 100 ||
            new Set(storyIds).size !== storyIds.length || storyIds.some((id: any) => !Number.isSafeInteger(id) || id <= 0)) {
          return sendJson(res, 400, { error: 'Invalid story album' }), true;
        }
        const album = await inst!.accountAction('create_story_album', { chatId, title: body.title, storyIds });
        sendJson(res, 200, album || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/stories/albums/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId), albumId = Number(body.albumId), source = body.update;
        const validIds = (ids: any) => Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
          new Set(ids).size === ids.length && ids.every((id: any) => Number.isSafeInteger(id) && id > 0);
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(albumId) || albumId <= 0 ||
            !source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['title', 'addStoryIds', 'removeStoryIds'].includes(key)) ||
            (!Object.keys(source).length) || (source.title !== undefined && (typeof source.title !== 'string' || !source.title.trim() ||
              source.title.length > 64 || /[\u0000-\u001f]/.test(source.title))) ||
            (source.addStoryIds !== undefined && !validIds(source.addStoryIds)) ||
            (source.removeStoryIds !== undefined && !validIds(source.removeStoryIds)) ||
            (source.addStoryIds && source.removeStoryIds && source.addStoryIds.some((id: number) => source.removeStoryIds.includes(id)))) {
          return sendJson(res, 400, { error: 'Invalid story album update' }), true;
        }
        const album = await inst!.accountAction('update_story_album', { chatId, albumId, update: source });
        sendJson(res, 200, album || {});
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/stories/albums' && method === 'DELETE') {
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId), albumId = Number(body.albumId);
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(albumId) || albumId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story album' }), true;
        }
        await inst!.accountAction('delete_story_album', { chatId, albumId });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/stories/albums/order' && method === 'POST') {
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId), albumIds = body.albumIds;
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Array.isArray(albumIds) || albumIds.length > 100 ||
            new Set(albumIds).size !== albumIds.length || albumIds.some((id: any) => !Number.isSafeInteger(id) || id <= 0)) {
          return sendJson(res, 400, { error: 'Invalid story album order' }), true;
        }
        await inst!.accountAction('reorder_story_albums', { chatId, albumIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }
    if (subRoute === 'account/stories/albums/stories/order' && method === 'POST') {
      try {
        const body = await parseJsonBody(req), chatId = Number(body.chatId), albumId = Number(body.albumId), storyId = Number(body.storyId), delta = Number(body.delta);
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(albumId) || albumId <= 0 ||
            !Number.isSafeInteger(storyId) || storyId <= 0 || ![-1, 1].includes(delta)) {
          return sendJson(res, 400, { error: 'Invalid story album move' }), true;
        }
        await inst!.accountAction('move_story_album_story', { chatId, albumId, storyId, delta });
        sendJson(res, 200, { success: true });
      } catch (err: any) { sendJson(res, 500, { error: err.message }); }
      return true;
    }

    if (subRoute === 'account/stories/views' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const storyId = Number(url.searchParams.get('storyId'));
        const offset = url.searchParams.get('offset') || '';
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        const kind = url.searchParams.get('kind') || 'viewers';
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(storyId) || storyId <= 0 ||
            offset.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !['viewers', 'reactions', 'forwards'].includes(kind)) {
          return sendJson(res, 400, { error: 'Invalid story viewers request' }), true;
        }
        const result = await inst!.accountAction('get_story_viewers', { chatId, storyId, offset, limit, kind });
        sendJson(res, 200, result || { count: 0, viewsCount: 0, reactionsCount: 0, forwardsCount: 0, viewers: [], forwards: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/delete' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const storyIds = Array.isArray(body.storyIds) ? body.storyIds.map(Number) : [];
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !storyIds.length || storyIds.length > 100 ||
            storyIds.some((id: number) => !Number.isSafeInteger(id) || id <= 0)) {
          return sendJson(res, 400, { error: 'Invalid story deletion request' }), true;
        }
        await inst!.accountAction('delete_stories', { chatId, storyIds });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/pin' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), storyId = Number(body.storyId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0 || typeof body.pinned !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid story pin request' }), true;
        }
        await inst!.accountAction('pin_story', { chatId, storyId, pinned: body.pinned });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/edit' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), storyId = Number(body.storyId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0 ||
            typeof body.caption !== 'string' || body.caption.length > 2048) {
          return sendJson(res, 400, { error: 'Invalid story caption edit request' }), true;
        }
        await inst!.accountAction('edit_story_caption', { chatId, storyId, caption: body.caption });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/settings' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const storyId = Number(url.searchParams.get('storyId'));
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story privacy request' }), true;
        }
        const settings = await inst!.accountAction('get_story_privacy_settings', { chatId, storyId });
        sendJson(res, 200, settings || {});
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/settings' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), storyId = Number(body.storyId);
        const settings = body.settings;
        const listFields = ['everyoneExcept', 'contactsExcept', 'selectedContacts', 'closeFriends', 'hideFrom'];
        if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(storyId) || storyId <= 0 ||
            !settings || typeof settings !== 'object' || Array.isArray(settings) ||
            !['public', 'contacts', 'close', 'selected'].includes(settings.privacyType) ||
            listFields.some(field => !Array.isArray(settings[field]) || settings[field].length > 2000 || settings[field].some((id: any) =>
              typeof id !== 'string' || !/^\d{1,20}$/.test(id) || /^0+$/.test(id)))) {
          return sendJson(res, 400, { error: 'Invalid story privacy request' }), true;
        }
        await inst!.accountAction('set_story_privacy_settings', { chatId, storyId, settings });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/story-media' && method === 'GET') {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const storyId = Number(url.searchParams.get('storyId'));
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story' }), true;
        }
        const data = await inst!.accountAction('get_story_media', { chatId, storyId });
        if (!data?.filePath || !fs.existsSync(data.filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
          res.end('Story media not found');
          return true;
        }
        const stat = fs.statSync(data.filePath);
        const headers: Record<string, string> = {
          'Content-Type': data.mimeType || 'application/octet-stream',
          'Cache-Control': 'private, no-store',
          'Accept-Ranges': 'bytes',
        };
        const range = req.headers.range ? parseByteRange(req.headers.range, stat.size) : null;
        if (range === 'unsatisfiable') {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'private, no-store' });
          res.end();
          return true;
        }
        if (range) {
          headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
          headers['Content-Length'] = String(range.end - range.start + 1);
          res.writeHead(206, headers);
          fs.createReadStream(data.filePath, { start: range.start, end: range.end }).on('error', () => res.destroy()).pipe(res);
        } else {
          headers['Content-Length'] = String(stat.size);
          res.writeHead(200, headers);
          fs.createReadStream(data.filePath).on('error', () => res.destroy()).pipe(res);
        }
      } catch (err: any) {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.destroy();
      }
      return true;
    }

    if (subRoute === 'account/stories/read' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const storyId = Number(body.storyId);
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story' }), true;
        }
        await inst!.accountAction('read_story', { chatId, storyId });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/link' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), storyId = Number(body.storyId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
          return sendJson(res, 400, { error: 'Invalid story link request' }), true;
        }
        const result = await inst!.accountAction('export_story_link', { chatId, storyId });
        const link = typeof result === 'string' ? result : result?.link;
        if (typeof link !== 'string' || !link || link.length > 2048) throw new Error('Telegram returned an invalid story link');
        sendJson(res, 200, { link });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/reaction' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const storyId = Number(body.storyId);
        const emoji = body.emoji;
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0 ||
            (emoji !== null && !isSingleEmoji(emoji))) {
          return sendJson(res, 400, { error: 'Invalid story reaction' }), true;
        }
        await inst!.accountAction('react_story', { chatId, storyId, emoji });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/reply' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        const storyId = Number(body.storyId);
        const text = body.text;
        const parseMode = body.parseMode === undefined ? 'plain' : body.parseMode;
        if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0 ||
            typeof text !== 'string' || !text.trim() || text.length > 4096 ||
            !['plain', 'markdown', 'html'].includes(parseMode)) {
          return sendJson(res, 400, { error: 'Invalid story reply' }), true;
        }
        await inst!.accountAction('reply_to_story', { chatId, storyId, text, parseMode });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/stories/hidden' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof body.hidden !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid peer stories visibility request' }), true;
        }
        await inst!.accountAction('set_peer_stories_hidden', { chatId, hidden: body.hidden });
        sendJson(res, 200, { success: true });
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
        const rawMediaIndex = url.searchParams.get('mediaIndex');
        const mediaIndex = rawMediaIndex == null ? undefined : Number(rawMediaIndex);
        if (!chatId || !messageId) return sendJson(res, 400, { error: 'Missing chatId or messageId' }), true;
        if (rawMediaIndex != null && (!/^(0|[1-9])$/.test(rawMediaIndex) || !Number.isSafeInteger(mediaIndex))) {
          return sendJson(res, 400, { error: 'Invalid media index' }), true;
        }

        // Stream playable documents with bounded range pulls. Thumbnails,
        // image types and explicit downloads retain the existing cached path.
        if (!thumb && !download) {
          const info = await inst!.accountAction('get_media_stream_info', { chatId: Number(chatId), messageId: Number(messageId), mediaIndex });
          if (info) {
            await streamTelegramMedia(req, res, inst!, Number(chatId), Number(messageId), info);
            return true;
          }
        }

        const data = await inst!.accountAction('get_message_media', {
          chatId: Number(chatId),
          messageId: Number(messageId),
          thumb,
          mediaIndex,
        });

        if (data && data.filePath && fs.existsSync(data.filePath)) {
          const stat = fs.statSync(data.filePath);
          const totalSize = stat.size;
          const mimeType = data.mimeType || 'application/octet-stream';
          const headers: Record<string, string> = {
            'Content-Type': mimeType,
            'Cache-Control': 'private, no-store',
            'Accept-Ranges': 'bytes',
          };
          if (download) {
            headers['Content-Disposition'] = mediaDownloadDisposition(data.fileName || `media_${messageId}`);
          }

          const range = req.headers.range;
          if (range && !thumb) {
            const parsed = parseByteRange(range, totalSize);
            if (parsed === 'unsatisfiable') {
              res.writeHead(416, {
                'Content-Range': `bytes */${totalSize}`,
              });
              res.end();
              return true;
            }
            if (parsed) {
              const { start, end } = parsed;
              headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
              headers['Content-Length'] = String(end - start + 1);
              res.writeHead(206, headers);
              const stream = fs.createReadStream(data.filePath, { start, end });
              stream.on('error', () => res.destroy());
              stream.pipe(res);
              return true;
            }
          }

          headers['Content-Length'] = String(totalSize);
          res.writeHead(200, headers);
          const stream = fs.createReadStream(data.filePath);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
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
      if (req.headers['content-type'] === 'application/vnd.tguserbot.media-stream') {
        let stagedPath: string | undefined;
        let handedOff = false;
        let notDispatched = false;
        let responseStatus = 200;
        let responseData: any;
        try {
          const staged = await receiveStreamUpload(req);
          stagedPath = staged.path;
          const { chatId, mediaType, caption, replyTo, commentTo, topicId, schedule, scheduleRepeatPeriod, parseMode, silent, effectId, paidStars, invertMedia, videoNote } = staged.metadata;
          if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 ||
              (schedule != null && (!Number.isSafeInteger(schedule) || schedule <= 0)) ||
              (scheduleRepeatPeriod != null && (!isScheduleRepeatPeriod(scheduleRepeatPeriod) || schedule == null || paidStars != null)) ||
              !['photo', 'video', 'audio', 'document', 'voice'].includes(mediaType) ||
              (caption != null && typeof caption !== 'string') ||
              (parseMode != null && !['plain', 'markdown', 'html'].includes(parseMode)) ||
              (replyTo != null && (!Number.isSafeInteger(Number(replyTo)) || Number(replyTo) <= 0)) ||
              (commentTo != null && (!Number.isSafeInteger(Number(commentTo)) || Number(commentTo) <= 0 || replyTo != null)) ||
              (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0 || commentTo != null)) ||
              (paidStars != null && (!Number.isSafeInteger(paidStars) || paidStars < 1 || paidStars > 1_000_000 ||
                !['photo', 'video'].includes(mediaType) || topicId != null || commentTo != null)) ||
              (invertMedia != null && typeof invertMedia !== 'boolean') ||
              (videoNote != null && (typeof videoNote !== 'boolean' || (videoNote && (mediaType !== 'video' || paidStars != null || scheduleRepeatPeriod != null)))) ||
              (silent != null && typeof silent !== 'boolean') ||
              (effectId != null && !isMessageEffectId(effectId))) {
            throw new Error('Invalid upload metadata');
          }
          const workerPid = inst!.getInfo?.().pid;
          if (!workerPid) throw new Error('账号未在线');
          if (res.destroyed) return true;
          await markStreamUploadOwner(stagedPath, workerPid);
          if (res.destroyed) return true;
          handedOff = true;
          const result = await inst!.accountAction('send_media_stream', {
            chatId: Number(chatId), mediaType, uploadPath: stagedPath, caption,
            replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
            topMsgId: topicId ? Number(topicId) : undefined,
            commentTo: commentTo ? Number(commentTo) : undefined, schedule, scheduleRepeatPeriod, parseMode, silent, effectId, invertMedia, videoNote,
            ...(paidStars == null ? {} : { paidStars }),
          });
          await cleanupStreamUpload(stagedPath).catch(() => {});
          stagedPath = undefined;
          responseData = { success: true, ...result };
        } catch (err: any) {
          notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
          responseStatus = err.message === 'Payload too large' ? 413 : err.message === 'Invalid upload metadata' || err.message === 'Missing file data' ? 400 : 500;
          responseData = { error: err.message };
        } finally {
          if (stagedPath) {
            if (!handedOff || notDispatched) await cleanupStreamUpload(stagedPath).catch(() => {});
            else {
              // A timed-out IPC operation may still be using the file. The
              // worker cleans it on completion; this is a fallback if it died.
              watchOrphanedStreamUpload(stagedPath);
            }
          }
        }
        if (!res.destroyed && responseData) sendJson(res, responseStatus, responseData);
        return true;
      }
      try {
        const body = await parseJsonBody(req, MEDIA_JSON_LIMIT);
        const { chatId, mediaType, fileBase64, fileName, caption, replyTo, topicId, schedule, scheduleRepeatPeriod, parseMode, silent, effectId, paidStars, invertMedia, videoNote } = body;
        if (!chatId || !fileBase64) {
          return sendJson(res, 400, { error: 'Missing chatId or fileBase64' }), true;
        }
        if (schedule != null && (!Number.isSafeInteger(schedule) || schedule <= 0)) {
          return sendJson(res, 400, { error: 'Invalid schedule' }), true;
        }
        if (scheduleRepeatPeriod != null && (!isScheduleRepeatPeriod(scheduleRepeatPeriod) || schedule == null || paidStars != null)) {
          return sendJson(res, 400, { error: 'Invalid scheduled-message repeat period' }), true;
        }
        if (effectId != null && !isMessageEffectId(effectId)) {
          return sendJson(res, 400, { error: 'Invalid Telegram message effect' }), true;
        }
        if (invertMedia != null && typeof invertMedia !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid media caption position' }), true;
        }
        if (videoNote != null && (typeof videoNote !== 'boolean' || (videoNote && (mediaType !== 'video' || paidStars != null || scheduleRepeatPeriod != null)))) {
          return sendJson(res, 400, { error: 'Invalid Telegram video note options' }), true;
        }
        if (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0)) {
          return sendJson(res, 400, { error: 'Invalid forum topic' }), true;
        }
        if (paidStars != null && (!Number.isSafeInteger(paidStars) || paidStars < 1 || paidStars > 1_000_000 ||
            !['photo', 'video'].includes(mediaType) || topicId != null)) {
          return sendJson(res, 400, { error: 'Invalid paid media metadata' }), true;
        }
        const result = await inst!.accountAction('send_media', {
          chatId: Number(chatId),
          mediaType,
          fileBase64,
          fileName,
          caption,
          replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
          topicId: topicId ? Number(topicId) : undefined,
          schedule,
          scheduleRepeatPeriod,
          parseMode,
          silent,
          effectId,
          invertMedia,
          videoNote,
          ...(paidStars == null ? {} : { paidStars }),
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, err.message === 'Payload too large' ? 413 : 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-media-album' && method === 'POST') {
      if (req.headers['content-type'] !== 'application/vnd.tguserbot.media-album-stream') {
        sendJson(res, 415, { error: 'Media albums require a streamed upload' });
        return true;
      }
      let stagedPaths: string[] = [];
      let handedOff = false;
      let notDispatched = false;
      let responseStatus = 200;
      let responseData: any;
      try {
        const staged = await receiveStreamAlbumUpload(req);
        stagedPaths = staged.paths;
        const { chatId, files, caption, replyTo, topicId, schedule, scheduleRepeatPeriod, parseMode, silent, effectId, paidStars, invertMedia } = staged.metadata;
        if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0 || !Array.isArray(files) ||
            files.length !== stagedPaths.length || files.some((file: any) => !/^image\/(?:jpeg|png|webp|heic|heif)$|^video\/(?:mp4|webm|quicktime|x-m4v|3gpp)$/i.test(file.mimeType)) ||
            (caption != null && (typeof caption !== 'string' || caption.length > 4096)) ||
            (schedule != null && (!Number.isSafeInteger(schedule) || schedule <= 0)) ||
            scheduleRepeatPeriod != null ||
            (parseMode != null && !['plain', 'markdown', 'html'].includes(parseMode)) ||
            (replyTo != null && (!Number.isSafeInteger(Number(replyTo)) || Number(replyTo) <= 0)) ||
            (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0)) ||
            (paidStars != null && (!Number.isSafeInteger(paidStars) || paidStars < 1 || paidStars > 1_000_000 || topicId != null)) ||
            (invertMedia != null && typeof invertMedia !== 'boolean') ||
            (silent != null && typeof silent !== 'boolean') ||
            (effectId != null && !isMessageEffectId(effectId))) {
          throw new Error('Invalid album upload metadata');
        }
        const workerPid = inst!.getInfo?.().pid;
        if (!workerPid) throw new Error('账号未在线');
        if (res.destroyed) return true;
        await markStreamUploadOwner(stagedPaths[0], workerPid);
        if (res.destroyed) return true;
        handedOff = true;
        const result = await inst!.accountAction('send_media_album_stream', {
          chatId: Number(chatId), uploadPaths: stagedPaths, caption,
          replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
          topMsgId: topicId ? Number(topicId) : undefined, schedule, parseMode, silent, effectId, invertMedia,
          ...(paidStars == null ? {} : { paidStars }),
        });
        await cleanupStreamUpload(stagedPaths[0]).catch(() => {});
        stagedPaths = [];
        responseData = { success: true, ...result };
      } catch (err: any) {
        notDispatched = err.code === 'ACTION_NOT_DISPATCHED';
          responseStatus = err.message === 'Payload too large' ? 413 : /Invalid .*metadata|Missing album file data|Unexpected album upload data/.test(err.message) ? 400 : 500;
        responseData = { error: err.message };
      } finally {
        if (stagedPaths.length) {
          if (!handedOff || notDispatched) await cleanupStreamUpload(stagedPaths[0]).catch(() => {});
          else watchOrphanedStreamUpload(stagedPaths[0]);
        }
      }
      if (!res.destroyed && responseData) sendJson(res, responseStatus, responseData);
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

    if (subRoute === 'account/sticker-collections' && method === 'GET') {
      try {
        const collections = await inst!.accountAction('get_sticker_collections', {});
        sendJson(res, 200, collections || { favorites: [], recent: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/sticker-search' && method === 'GET') {
      try {
        const query = (url.searchParams.get('q') || '').trim();
        const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 40;
        if (!query || query.length > 128 || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          return sendJson(res, 400, { error: 'Invalid Telegram sticker search' }), true;
        }
        const result = await inst!.accountAction('search_stickers', { query, offset, limit });
        sendJson(res, 200, result || { stickers: [] });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/emoji-search' && method === 'GET') {
      try {
        const query = (url.searchParams.get('q') || '').trim();
        if (!query || query.length > 64 || /[\u0000-\u001f]/.test(query)) {
          return sendJson(res, 400, { error: 'Invalid Emoji search' }), true;
        }
        const results = await inst!.accountAction('search_emoji_keywords', { query });
        sendJson(res, 200, Array.isArray(results) ? results : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/emoji-groups' && method === 'GET') {
      try {
        const groups = await inst!.accountAction('get_emoji_groups', {});
        sendJson(res, 200, Array.isArray(groups) ? groups : []);
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

    if (subRoute === 'account/custom-emoji' && method === 'GET') {
      try {
        const documentId = url.searchParams.get('documentId') || '';
        if (!/^\d{1,20}$/.test(documentId) || /^0+$/.test(documentId)) {
          return sendJson(res, 400, { error: 'Invalid custom emoji document ID' }), true;
        }
        const data = await inst!.accountAction('get_custom_emoji_preview', { documentId });
        const mimeType = ['image/webp', 'image/png', 'image/jpeg'].includes(String(data?.mimeType)) ? String(data.mimeType) : '';
        if (data?.filePath && mimeType && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(data.filePath).pipe(res);
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Custom emoji preview not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(err.message);
      }
      return true;
    }

    if (subRoute === 'account/custom-emoji-search' && method === 'GET') {
      try {
        const emoticon = (url.searchParams.get('emoticon') || '').trim();
        if (!isSingleEmoji(emoticon)) {
          return sendJson(res, 400, { error: 'Invalid custom emoji search' }), true;
        }
        const results = await inst!.accountAction('search_custom_emoji', { emoticon });
        sendJson(res, 200, Array.isArray(results) ? results : []);
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-custom-emoji' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body?.chatId);
        const emoticon = typeof body?.emoticon === 'string' ? body.emoticon : '';
        const documentId = typeof body?.documentId === 'string' ? body.documentId : String(body?.documentId || '');
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !isSingleEmoji(emoticon) ||
            !/^\d{1,20}$/.test(documentId) || /^0+$/.test(documentId)) {
          return sendJson(res, 400, { error: 'Invalid custom emoji message' }), true;
        }
        const result = await inst!.accountAction('send_custom_emoji', { chatId, emoticon, documentId });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/sticker-thumb' && method === 'GET') {
      try {
        const docId = url.searchParams.get('docId') || '';
        const accessHash = url.searchParams.get('accessHash') || '';
        const fileRef = url.searchParams.get('fileRef') || '';
        const validDocumentId = /^\d{1,20}$/.test(docId) && !/^0+$/.test(docId) && BigInt(docId) <= 9223372036854775807n;
        const validAccessHash = /^-?\d{1,20}$/.test(accessHash) && !/^-?0+$/.test(accessHash) &&
          BigInt(accessHash) >= -9223372036854775808n && BigInt(accessHash) <= 9223372036854775807n;
        if (!validDocumentId || !validAccessHash || fileRef.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(fileRef)) {
          return sendJson(res, 400, { error: 'Invalid sticker document location' }), true;
        }
        const data = await inst!.accountAction('get_sticker_thumb', { docId, accessHash, fileReference: fileRef });
        if (data && data.filePath && fs.existsSync(data.filePath)) {
          res.writeHead(200, {
            'Content-Type': 'image/webp',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
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

    if (subRoute === 'account/gifs/search' && method === 'GET') {
      try {
        const chatId = Number(url.searchParams.get('chatId'));
        const query = url.searchParams.get('q') || '';
        const offset = url.searchParams.get('offset') || '';
        if (!Number.isSafeInteger(chatId) || chatId === 0 || !query.trim() || query.length > 128 || offset.length > 512) {
          return sendJson(res, 400, { error: 'Invalid GIF search request' }), true;
        }
        const result = await inst!.accountAction('search_inline_gifs', { chatId, query, offset });
        sendJson(res, 200, result && typeof result === 'object' ? result : { results: [], nextOffset: '' });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/gifs/save-search-result' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), token = body.token;
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
          return sendJson(res, 400, { error: 'Invalid GIF save request' }), true;
        }
        await inst!.accountAction('save_inline_gif', { chatId, token });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/gifs/remove-saved' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { docId, accessHash } = body;
        const fileReference = body.fileReference ?? '';
        if (typeof docId !== 'string' || !/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) ||
            typeof accessHash !== 'string' || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) ||
            typeof fileReference !== 'string' || fileReference.length > 4096) {
          return sendJson(res, 400, { error: 'Invalid GIF document' }), true;
        }
        const parsedHash = BigInt(accessHash);
        if (parsedHash < -(1n << 63n) || parsedHash > (1n << 63n) - 1n) return sendJson(res, 400, { error: 'Invalid GIF document' }), true;
        await inst!.accountAction('save_gif_document', { docId, accessHash, fileReference, unsave: true });
        sendJson(res, 200, { success: true });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/gif-preview' && method === 'GET') {
      try {
        const docId = url.searchParams.get('docId') || '';
        const accessHash = url.searchParams.get('accessHash') || '';
        const fileReference = url.searchParams.get('fileReference') || '';
        const mimeType = url.searchParams.get('mimeType') || 'video/mp4';
        if (!/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) || fileReference.length > 4096 ||
            !['video/mp4', 'video/webm'].includes(mimeType)) return sendJson(res, 400, { error: 'Invalid GIF document' }), true;
        const parsedAccessHash = BigInt(accessHash);
        if (parsedAccessHash < -(1n << 63n) || parsedAccessHash > (1n << 63n) - 1n) return sendJson(res, 400, { error: 'Invalid GIF document' }), true;
        const data = await inst!.accountAction('get_gif_preview', { docId, accessHash, fileReference, mimeType });
        if (!data?.filePath || !fs.existsSync(data.filePath)) return sendJson(res, 404, { error: 'GIF preview unavailable' }), true;
        const stat = fs.statSync(data.filePath);
        const range = req.headers.range ? parseByteRange(req.headers.range, stat.size) : null;
        if (range === 'unsatisfiable') {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'private, no-store' }); res.end(); return true;
        }
        const start = range ? range.start : 0;
        const end = range ? range.end : stat.size - 1;
        res.writeHead(range ? 206 : 200, {
          'Content-Type': data.mimeType === 'video/webm' ? 'video/webm' : 'video/mp4',
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
        });
        fs.createReadStream(data.filePath, { start, end }).pipe(res);
      } catch (err: any) {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.destroy(err);
      }
      return true;
    }

    if (subRoute === 'account/send-sticker' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { chatId, docId, accessHash, fileReference, replyTo, topicId } = body;
        if (!chatId || !docId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing chatId, docId, or accessHash' }), true;
        }
        if (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0)) {
          return sendJson(res, 400, { error: 'Invalid forum topic' }), true;
        }
        const result = await inst!.accountAction('send_sticker_document', {
          chatId: Number(chatId),
          docId: String(docId),
          accessHash: String(accessHash),
          fileReference: String(fileReference || ''),
          replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
          topMsgId: topicId ? Number(topicId) : undefined,
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
        const { chatId, docId, accessHash, fileReference, replyTo, topicId } = body;
        if (!chatId || !docId || !accessHash) {
          return sendJson(res, 400, { error: 'Missing chatId, docId, or accessHash' }), true;
        }
        if (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0)) {
          return sendJson(res, 400, { error: 'Invalid forum topic' }), true;
        }
        const result = await inst!.accountAction('send_gif_document', {
          chatId: Number(chatId),
          docId: String(docId),
          accessHash: String(accessHash),
          fileReference: String(fileReference || ''),
          replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
          topMsgId: topicId ? Number(topicId) : undefined,
        });
        sendJson(res, 200, { success: true, ...result });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    if (subRoute === 'account/send-searched-gif' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const chatId = Number(body.chatId), token = body.token;
        const replyTo = body.replyTo == null ? undefined : Number(body.replyTo);
        const topicId = body.topicId == null ? undefined : Number(body.topicId);
        if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
            (replyTo != null && (!Number.isSafeInteger(replyTo) || replyTo <= 0)) ||
            (topicId != null && (!Number.isSafeInteger(topicId) || topicId <= 0 || chatId >= 0))) {
          return sendJson(res, 400, { error: 'Invalid GIF send request' }), true;
        }
        await inst!.accountAction('send_inline_gif', { chatId, token, replyTo, topMsgId: topicId });
        sendJson(res, 200, { success: true });
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

    if (subRoute === 'account/sticker-favorite' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const { docId, accessHash, fileReference, favorite } = body;
        if (typeof docId !== 'string' || !/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) ||
            typeof accessHash !== 'string' || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) ||
            typeof fileReference !== 'string' || fileReference.length > 8192 || typeof favorite !== 'boolean') {
          return sendJson(res, 400, { error: 'Invalid sticker favorite request' }), true;
        }
        await inst!.accountAction('set_sticker_favorite', { docId, accessHash, fileReference, favorite });
        sendJson(res, 200, { success: true });
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


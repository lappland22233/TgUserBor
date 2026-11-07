import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';
import { Bot } from '../bot/core/bot';
import { TelegramDriver, QR_AUTH_MARKER, type AuthPromptHandler } from '../bot/driver/telegram';
import type { BotConfig } from '../bot/config';
import type { InstanceConfig, IPCToParent, IPCToChild } from './types';
import { withTemporaryUpload, cleanupStreamUpload, isStreamUploadPath } from './media-upload';
import { mediaCacheNamespace } from '../bot/driver/media-cache';
import { markAllDialogsRead } from './read-all';

function sendIPC(msg: IPCToParent): void {
  if (process.send) {
    process.send(msg);
  }
}

async function runWorker() {
  const rawConfig = process.env.INSTANCE_CONFIG;
  if (!rawConfig) {
    throw new Error('Worker started without INSTANCE_CONFIG environment variable');
  }

  const instConfig: InstanceConfig = JSON.parse(rawConfig);

  // Setup pending auth resolver callbacks
  const authResolvers = new Map<string, (val: string) => void>();

  const authHandler: AuthPromptHandler = {
    askPhone: () => {
      sendIPC({ type: 'STATUS_CHANGE', status: 'NEEDS_PHONE' });
      sendIPC({ type: 'AUTH_REQUIRED', step: 'phone' });
      return new Promise((resolve) => {
        authResolvers.set('phone', resolve);
      });
    },
    askCode: () => {
      sendIPC({ type: 'STATUS_CHANGE', status: 'NEEDS_CODE' });
      sendIPC({ type: 'AUTH_REQUIRED', step: 'code' });
      return new Promise((resolve) => {
        authResolvers.set('code', resolve);
      });
    },
    askPassword: () => {
      sendIPC({ type: 'STATUS_CHANGE', status: 'NEEDS_PASSWORD' });
      sendIPC({ type: 'AUTH_REQUIRED', step: 'password' });
      return new Promise((resolve) => {
        authResolvers.set('password', resolve);
      });
    },
    onQr: (token, expires) => {
      // This credential is sent only over the worker's private IPC channel.
      sendIPC({ type: 'AUTH_QR', token: token.toString('base64url'), expires });
    },
    onError: (err: Error) => {
      sendIPC({ type: 'STATUS_CHANGE', status: 'ERROR', error: err.message });
    },
  };

  const botConfig: BotConfig = {
    telegram: {
      apiId: instConfig.apiId,
      apiHash: instConfig.apiHash,
      sessionPath: instConfig.sessionPath,
      proxy: instConfig.proxy,
    },
    ownerId: instConfig.ownerId,
    log: {
      level: 'info',
      dir: path.dirname(instConfig.logPath),
    },
    db: {
      path: instConfig.dbPath,
    },
    plugin: {
      dir: instConfig.pluginDir,
      hotReload: true,
    },
    command: {
      prefixes: instConfig.prefixes,
    },
  };

  // Ensure log directory exists
  fs.mkdirSync(botConfig.log.dir, { recursive: true });

  // Custom log stream forwarding to parent via IPC + writing to instance log file
  const logFileStream = fs.createWriteStream(instConfig.logPath, { flags: 'a' });
  const ipcLogStream = {
    write: (chunk: any) => {
      try {
        logFileStream.write(chunk);
      } catch {
        /* ignore */
      }
      try {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        const parsed = JSON.parse(str);
        sendIPC({
          type: 'LOG_EVENT',
          level: (pino.levels.labels as any)[parsed.level] || 'info',
          msg: parsed.msg || '',
          time: parsed.time ? new Date(parsed.time).getTime() : Date.now(),
          context: parsed,
        });
      } catch {
        try {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          sendIPC({
            type: 'LOG_EVENT',
            level: 'info',
            msg: text.trim(),
            time: Date.now(),
          });
        } catch {
          /* swallow */
        }
      }
    },
  };

  const logger = pino(
    {
      level: 'info',
      base: { instanceId: instConfig.id, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    ipcLogStream,
  );

  sendIPC({ type: 'STATUS_CHANGE', status: 'STARTING' });

  const driver = new TelegramDriver(botConfig, logger, authHandler);
  const bot = new Bot(botConfig, logger, driver);

  let messagesCount = 0;
  let commandsCount = 0;

  bot.bus.on('message', (msg: any) => {
    messagesCount++;
    if (bot.parser.parse(msg)) {
      commandsCount++;
    }
    sendIPC({
      type: 'RAW_EVENT',
      event: {
        type: 'new_message',
        instId: instConfig.id,
        message: {
          ...msg,
          chatId: msg.chat?.id,
        },
      },
    });
  });

  bot.bus.on('message:edited', (msg: any) => {
    sendIPC({
      type: 'RAW_EVENT',
      event: {
        type: 'message_edited',
        instId: instConfig.id,
        message: {
          ...msg,
          chatId: msg.chat?.id,
        },
      },
    });
  });

  bot.bus.on('message:deleted', (data: any) => {
    sendIPC({
      type: 'RAW_EVENT',
      event: {
        type: 'message_delete',
        instId: instConfig.id,
        chatId: data.chatId,
        messageIds: data.messageIds,
      },
    });
  });

  bot.bus.on('message:read', (data: { chatId: number; maxId: number }) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'message_read', instId: instConfig.id, chatId: data.chatId, maxId: data.maxId } });
  });

  bot.bus.on('user:status', (data: { userId: number; online: boolean; lastSeen?: number }) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'user_status', instId: instConfig.id, ...data } });
  });

  bot.bus.on('chat:typing', (data: any) => {
    sendIPC({
      type: 'RAW_EVENT',
      event: {
        type: 'chat_typing',
        instId: instConfig.id,
        chatId: data.chatId,
        userId: data.userId,
        action: data.action,
      },
    });
  });

  bot.adapter.on('ready', (payload) => {
    sendIPC({ type: 'AUTH_SUCCESS', self: payload.self });
    sendIPC({ type: 'STATUS_CHANGE', status: 'ONLINE' });
  });

  bot.adapter.on('dialog:folders', () => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'dialog_folders_changed', instId: instConfig.id } });
  });

  bot.adapter.on('draft:updated', (data) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'draft_updated', instId: instConfig.id, chatId: data.chatId, draft: data.draft } });
  });

  bot.adapter.on('stories:updated', (data) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'stories_updated', instId: instConfig.id, ...data } });
  });
  bot.adapter.on('stories:stealth', () => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'stories_stealth_updated', instId: instConfig.id } });
  });

  bot.adapter.on('forum:topics', (data) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'forum_topics_updated', instId: instConfig.id, ...data } });
  });
  bot.adapter.on('chat:history-ttl', (data) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'chat_history_ttl_updated', instId: instConfig.id, ...data } });
  });
  bot.adapter.on('chat:wallpaper', (data) => {
    sendIPC({ type: 'RAW_EVENT', event: { type: 'peer_wallpaper_updated', instId: instConfig.id, ...data } });
  });

  bot.adapter.on('disconnected', (e) => {
    sendIPC({ type: 'STATUS_CHANGE', status: 'STOPPED', error: e.reason });
  });

  bot.adapter.on('error', (e) => {
    sendIPC({ type: 'STATUS_CHANGE', status: 'ERROR', error: e.error.message });
  });

  // Listen for IPC messages from parent
  process.on('message', async (raw: IPCToChild) => {
    if (!raw) return;

    if (raw.type === 'AUTH_QR_START') {
      const resolver = authResolvers.get('phone');
      if (resolver) {
        authResolvers.delete('phone');
        resolver(QR_AUTH_MARKER);
      }
    } else if (raw.type === 'AUTH_INPUT') {
      logger.info(`Received auth input for step: ${raw.step}`);
      const resolver = authResolvers.get(raw.step);
      if (resolver) {
        authResolvers.delete(raw.step);
        resolver(raw.value);
      } else {
        logger.warn(`No pending auth resolver found for step: ${raw.step}`);
      }
    } else if (raw.type === 'STOP') {
      logger.info('Stopping instance worker...');
      sendIPC({ type: 'STATUS_CHANGE', status: 'STOPPED' });
      try {
        await Promise.race([
          bot.stop(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch (err) {
        logger.error({ err }, 'Error stopping bot');
      }
      process.exit(0);
    } else if (raw.type === 'PLUGIN_ACTION') {
      const { actionId, action, pluginName } = raw;
      try {
        if (action === 'enable') {
          await bot.plugins.setEnabled(pluginName, true);
        } else if (action === 'disable') {
          await bot.plugins.setEnabled(pluginName, false);
        } else if (action === 'reload') {
          await bot.plugins.reload(pluginName);
        }
        sendIPC({ type: 'PLUGIN_ACTION_RESULT', actionId, success: true });
      } catch (err: any) {
        sendIPC({ type: 'PLUGIN_ACTION_RESULT', actionId, success: false, error: err.message });
      }
    } else if (raw.type === 'ACCOUNT_ACTION') {
      const { actionId, action, payload } = raw;
      try {
        switch (action) {
          case 'open_mini_app': {
            const chatId = Number(payload?.chatId), messageId = Number(payload?.messageId);
            const row = payload?.row, column = payload?.column;
            if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 ||
                !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) throw new Error('无效的 Mini App 按钮');
            // Errors may include request URLs; never forward those to logs/UI.
            let data;
            try { data = await driver.openMiniApp(chatId, messageId, row, column); }
            catch { throw new Error('无法启动 Mini App，请检查机器人和会话权限'); }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data });
            break;
          }
          case 'get_mini_app_menu_button': {
            const chatId = Number(payload?.chatId);
            if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('Invalid bot menu peer');
            try {
              const data = await driver.getMiniAppBotMenuButton(chatId);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data });
            } catch { throw new Error('无法读取机器人菜单'); }
            break;
          }
          case 'open_mini_app_menu': {
            const chatId = Number(payload?.chatId);
            if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('Invalid bot menu peer');
            try {
              const data = await driver.openMiniAppBotMenu(chatId);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data });
            } catch { throw new Error('无法启动机器人菜单 Mini App'); }
            break;
          }
          case 'prolong_mini_app':
          case 'close_mini_app': {
            const capability = payload?.capability;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Mini App 会话已结束');
            if (action === 'prolong_mini_app') await driver.prolongMiniApp(capability);
            else driver.closeMiniApp(capability);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'invoke_mini_app_custom_method': {
            const capability = payload?.capability, method = payload?.method, paramsJson = payload?.paramsJson;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof method !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(method) ||
                typeof paramsJson !== 'string' || Buffer.byteLength(paramsJson, 'utf8') > 4096) {
              throw new Error('Mini App custom method is invalid');
            }
            try { JSON.parse(paramsJson); } catch { throw new Error('Mini App custom method parameters are invalid'); }
            try {
              const result = await driver.invokeMiniAppCustomMethod(capability, method, paramsJson);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { result } });
            } catch { throw new Error('Mini App custom method failed'); }
            break;
          }
          case 'send_mini_app_data': {
            const capability = payload?.capability, data = payload?.data;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 4096) {
              throw new Error('Mini App data is invalid');
            }
            try { await driver.sendMiniAppData(capability, data); }
            catch { throw new Error('Mini App data could not be sent'); }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mini_app_can_send_messages':
          case 'mini_app_allow_send_messages': {
            const capability = payload?.capability;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Mini App 会话已结束');
            if (action === 'mini_app_can_send_messages') {
              const allowed = await driver.canMiniAppBotSendMessages(capability);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { allowed } });
            } else {
              await driver.allowMiniAppBotSendMessages(capability);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            }
            break;
          }
          case 'mini_app_check_download': {
            const capability = payload?.capability, fileName = payload?.fileName, url = payload?.url;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof fileName !== 'string' || fileName.length > 255 || typeof url !== 'string' || url.length > 16384) {
              throw new Error('Invalid Mini App download request');
            }
            try {
              const allowed = await driver.checkMiniAppDownload(capability, fileName, url);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { allowed } });
            } catch { throw new Error('Mini App file download is not allowed'); }
            break;
          }
          case 'mini_app_request_phone': {
            const capability = payload?.capability;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Mini App 会话已结束');
            try { await driver.requestMiniAppPhone(capability); }
            catch { throw new Error('无法向此机器人分享电话号码'); }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mini_app_prepare_invoice': {
            const capability = payload?.capability, slug = payload?.slug;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(slug)) throw new Error('Mini App invoice is invalid');
            try {
              const data = await driver.prepareMiniAppInvoice(capability, slug);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data });
            } catch { throw new Error('此发票暂不可付款或不支持 Telegram Stars'); }
            break;
          }
          case 'mini_app_confirm_invoice': {
            const capability = payload?.capability, token = payload?.token;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Mini App invoice confirmation is invalid');
            try {
              const result = await driver.confirmMiniAppInvoice(capability, token);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { status: result.status === 'paid' ? 'paid' : 'failed' } });
            } catch { sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { status: 'failed' } }); }
            break;
          }
          case 'mini_app_cancel_invoice': {
            const capability = payload?.capability, token = payload?.token;
            if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
                typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Mini App invoice cancellation is invalid');
            driver.cancelMiniAppInvoice(capability, token);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'search_global_messages': {
            const query = String(payload?.query || '').trim();
            const allowedSearchFilters = ['photos', 'videos', 'files', 'links', 'music', 'voice', 'round-video', 'round-voice', 'geo', 'calls'];
            const searchFilter = payload?.searchFilter;
            if (query.length > 128 || (!query && !searchFilter) ||
                (searchFilter != null && searchFilter !== '' && !allowedSearchFilters.includes(searchFilter))) throw new Error('Invalid search query or filter');
            const cursor = payload?.cursor;
            if (cursor && (!Number.isSafeInteger(cursor.rate) || cursor.rate < 0 || !Number.isSafeInteger(cursor.id) || cursor.id <= 0 || !/^-?\d+$/.test(String(cursor.peer)))) throw new Error('Invalid search cursor');
            const result = await bot.adapter.searchGlobalMessages(query, 30, cursor, searchFilter || undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_message_context': {
            const chatId = Number(payload?.chatId);
            const messageId = Number(payload?.messageId);
            if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid message');
            const messages = await bot.adapter.getMessages(chatId, { limit: 41, offsetId: messageId, addOffset: -20 });
            if (!messages.some((message) => message.id === messageId)) {
              const anchor = await bot.adapter.getMessages(chatId, { ids: [messageId] });
              if (anchor.length) messages.push(anchor[0]);
              messages.sort((a, b) => b.id - a.id);
            }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: messages });
            break;
          }
          case 'translate_message': {
            const chatId = Number(payload?.chatId);
            const messageId = Number(payload?.messageId);
            const targetLang = typeof payload?.targetLang === 'string' ? payload.targetLang : 'zh-hans';
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
              throw new Error('Invalid message translation request');
            }
            const result = await driver.translateMessage(chatId, messageId, targetLang);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'translate_messages': {
            const chatId = Number(payload?.chatId), messageIds = payload?.messageIds;
            const targetLang = typeof payload?.targetLang === 'string' ? payload.targetLang : 'zh-hans';
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 20 ||
                messageIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0) ||
                !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(targetLang) || targetLang.length > 16) {
              throw new Error('Invalid batch message translation request');
            }
            const result = await driver.translateMessages(chatId, messageIds.map(Number), targetLang);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_dialog_folders': {
            const folders = await bot.adapter.getDialogFolders();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: folders });
            break;
          }
          case 'save_dialog_folder': {
            const folder = await bot.adapter.saveDialogFolder(payload?.folder);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: folder });
            break;
          }
          case 'delete_dialog_folder': {
            await bot.adapter.deleteDialogFolder(Number(payload?.folderId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'reorder_dialog_folders': {
            await bot.adapter.reorderDialogFolders(payload?.folderIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_dialog_folder_tag_state': {
            const state = await bot.adapter.getDialogFolderTagState();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: state });
            break;
          }
          case 'set_dialog_folder_tags': {
            if (typeof payload?.enabled !== 'boolean') throw new Error('Invalid Telegram folder tag setting');
            await bot.adapter.setDialogFolderTags(payload.enabled);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_dialog_folder_invites': {
            const folderId = Number(payload?.folderId);
            if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255) throw new Error('Invalid Telegram chat folder ID');
            const invites = await bot.adapter.getDialogFolderInvites(folderId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: invites });
            break;
          }
          case 'get_dialog_folder_share_peers': {
            const folderId = Number(payload?.folderId);
            if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255) throw new Error('Invalid Telegram chat folder ID');
            const peers = await bot.adapter.getDialogFolderSharePeers(folderId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: peers });
            break;
          }
          case 'create_dialog_folder_invite': {
            const folderId = Number(payload?.folderId), title = payload?.title, peerIds = payload?.peerIds;
            if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || typeof title !== 'string' ||
                !Array.isArray(peerIds) || peerIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Invalid Telegram chatlist invite');
            const invite = await bot.adapter.createDialogFolderInvite(folderId, title, peerIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: invite });
            break;
          }
          case 'edit_dialog_folder_invite': {
            const folderId = Number(payload?.folderId), title = payload?.title, url = payload?.url, peerIds = payload?.peerIds;
            if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || typeof title !== 'string' ||
                typeof url !== 'string' || !Array.isArray(peerIds) || peerIds.some((id: unknown) => typeof id !== 'string')) {
              throw new Error('Invalid Telegram chatlist invite');
            }
            const invite = await bot.adapter.editDialogFolderInvite(folderId, url, title, peerIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: invite });
            break;
          }
          case 'delete_dialog_folder_invite': {
            const folderId = Number(payload?.folderId), url = payload?.url;
            if (!Number.isSafeInteger(folderId) || folderId < 1 || folderId > 255 || typeof url !== 'string') throw new Error('Invalid Telegram chatlist invite');
            await bot.adapter.deleteDialogFolderInvite(folderId, url);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'check_dialog_folder_invite': {
            const url = payload?.url;
            if (typeof url !== 'string') throw new Error('Invalid Telegram chatlist invite URL');
            const preview = await bot.adapter.checkDialogFolderInvite(url);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: preview });
            break;
          }
          case 'join_dialog_folder_invite': {
            const url = payload?.url, peerIds = payload?.peerIds;
            if (typeof url !== 'string' || !Array.isArray(peerIds) || peerIds.some((id: unknown) => typeof id !== 'string')) {
              throw new Error('Invalid Telegram chatlist invite');
            }
            await bot.adapter.joinDialogFolderInvite(url, peerIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_channel_comments': {
            const chatId = Number(payload?.chatId);
            const messageId = Number(payload?.messageId);
            const offsetId = payload?.offsetId == null ? undefined : Number(payload.offsetId);
            if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 ||
                (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) throw new Error('Invalid discussion');
            const messages = await driver.getChannelComments(chatId, messageId, Math.min(Math.max(Number(payload?.limit) || 50, 1), 100), offsetId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: messages });
            break;
          }
          case 'send_channel_comment': {
            const chatId = Number(payload?.chatId);
            const messageId = Number(payload?.messageId);
            const text = typeof payload?.text === 'string' ? payload.text : '';
            if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 || !text.trim() || text.length > 4096) throw new Error('Invalid comment');
            const id = await driver.sendChannelComment(chatId, messageId, text);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: id } });
            break;
          }
          case 'log_out': {
            // Logout is implemented on the Telegram driver, not the generic
            // bot adapter: it affects only this worker's authorization.
            const result = await driver.logOut();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'search_dialogs': {
            const query = String(payload?.query || '').trim();
            if (query.length > 128) throw new Error('Search query is too long');
            const dialogs = query ? await bot.adapter.searchDialogs(query, 50) : [];
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: dialogs });
            break;
          }
          case 'get_dialogs': {
            const limit = Math.min(Math.max(Number(payload?.limit) || 50, 1), 100);
            const cursor = payload?.offset;
            const offset = cursor && cursor.peer != null && Number(cursor.id) > 0 && Number(cursor.date) > 0
              ? { peer: String(cursor.peer), id: Number(cursor.id), date: Number(cursor.date) }
              : undefined;
            const folderId = payload?.folderId === 1 ? 1 : 0;
            const dialogs = await bot.adapter.getDialogs(limit, offset, folderId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: dialogs });
            break;
          }
          case 'get_explicit_dialogs': {
            const peerIds = payload?.peerIds;
            if (!Array.isArray(peerIds) || peerIds.length > 100 || peerIds.some((id: unknown) =>
              typeof id !== 'number' || !Number.isSafeInteger(id) || id === 0)) throw new Error('Invalid explicit dialog peers');
            const dialogs = await bot.adapter.getExplicitDialogs(peerIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: dialogs });
            break;
          }
          case 'get_messages': {
            const chatId = Number(payload?.chatId);
            const limit = Math.min(Math.max(Number(payload?.limit) || 40, 1), 100);
            const offsetId = payload?.offsetId == null ? undefined : Number(payload.offsetId);
            const offsetDate = payload?.offsetDate == null ? undefined : Number(payload.offsetDate);
            const search = payload?.search ? String(payload.search) : undefined;
            const allowedSearchFilters = ['photos', 'videos', 'files', 'links', 'music', 'voice', 'round-video', 'round-voice', 'geo', 'calls'];
            const searchFilter = payload?.searchFilter;
            if (!Number.isSafeInteger(chatId) || chatId === 0 || (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0)) ||
                (offsetDate !== undefined && (!Number.isSafeInteger(offsetDate) || offsetDate <= 0)) || (search && search.length > 128)) {
              throw new Error('Invalid message history request');
            }
            if (searchFilter != null && searchFilter !== '' && !allowedSearchFilters.includes(searchFilter)) throw new Error('Invalid message search filter');
            const messages = await bot.adapter.getMessages(chatId, {
              limit, offsetId, offsetDate, search, searchFilter: searchFilter || undefined,
              ...(payload?.savedReaction ? { savedReaction: payload.savedReaction } : {}),
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: messages });
            break;
          }
          case 'get_message_fact_checks': {
            const chatId = Number(payload?.chatId), messageId = Number(payload?.messageId);
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
              throw new Error('Invalid fact-check request');
            }
            const factChecks = await bot.adapter.getMessageFactChecks(chatId, messageId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: factChecks });
            break;
          }
          case 'start_message_report': {
            const chatId = Number(payload?.chatId), messageId = Number(payload?.messageId);
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
              throw new Error('Invalid message report request');
            }
            const progress = await bot.adapter.startMessageReport(chatId, messageId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: progress });
            break;
          }
          case 'continue_message_report': {
            const token = payload?.token, comment = payload?.comment;
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
                (comment != null && (typeof comment !== 'string' || comment.length > 1024))) {
              throw new Error('Invalid message report continuation');
            }
            const progress = await bot.adapter.continueMessageReport(token, comment);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: progress });
            break;
          }
          case 'get_reply_keyboard_state': {
            const chatId = Number(payload?.chatId);
            if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid chat ID');
            const snapshot = await driver.getReplyKeyboardState(chatId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: snapshot });
            break;
          }
          case 'get_pinned_messages': {
            const chatId = Number(payload?.chatId);
            const limit = Math.min(Math.max(Number(payload?.limit) || 30, 1), 50);
            const offsetId = payload?.offsetId == null ? undefined : Number(payload.offsetId);
            if (!Number.isSafeInteger(chatId) || chatId === 0 ||
                (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) throw new Error('Invalid pinned messages request');
            const result = await driver.getPinnedMessages(chatId, limit, offsetId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_draft': {
            const draft = await bot.adapter.getDraft(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { draft } });
            break;
          }
          case 'save_draft': {
            if (typeof payload?.text !== 'string') throw new Error('无效的草稿');
            await bot.adapter.saveDraft(Number(payload?.chatId), payload.text, payload?.options);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success: true } });
            break;
          }
          case 'get_forum_topics': {
            const { chatId, offset } = payload;
            const result = await driver.getForumTopics(Number(chatId), offset);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_discussion_group_state': {
            const channelId = Number(payload?.channelId);
            if (!Number.isSafeInteger(channelId) || channelId >= 0) throw new Error('Invalid broadcast channel');
            const result = await driver.getDiscussionGroupState(channelId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'link_discussion_group': {
            const channelId = Number(payload?.channelId), groupId = Number(payload?.groupId);
            if (!Number.isSafeInteger(channelId) || channelId >= 0 || !Number.isSafeInteger(groupId) || groupId >= 0 || channelId === groupId) {
              throw new Error('Invalid discussion group link');
            }
            await driver.linkDiscussionGroup(channelId, groupId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { linked: true } });
            break;
          }
          case 'unlink_discussion_group': {
            const channelId = Number(payload?.channelId);
            if (!Number.isSafeInteger(channelId) || channelId >= 0) throw new Error('Invalid broadcast channel');
            await driver.unlinkDiscussionGroup(channelId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { linked: false } });
            break;
          }
          case 'create_forum_topic': {
            await driver.createForumTopic(Number(payload?.chatId), String(payload?.title || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'edit_forum_topic': {
            await driver.editForumTopic(Number(payload?.chatId), Number(payload?.topicId), {
              title: typeof payload?.title === 'string' ? payload.title : undefined,
              closed: typeof payload?.closed === 'boolean' ? payload.closed : undefined,
              hidden: typeof payload?.hidden === 'boolean' ? payload.hidden : undefined,
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'pin_forum_topic': {
            await driver.setForumTopicPinned(Number(payload?.chatId), Number(payload?.topicId), payload?.pinned === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'move_pinned_forum_topic': {
            await driver.movePinnedForumTopic(Number(payload?.chatId), Number(payload?.topicId), payload?.direction);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_forum_topic': {
            await driver.deleteForumTopic(Number(payload?.chatId), Number(payload?.topicId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_forum_messages': {
            const { chatId, topicId, offsetId } = payload;
            const result = await driver.getForumMessages(Number(chatId), Number(topicId), offsetId ? Number(offsetId) : undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'mark_forum_topic_read': {
            const { chatId, topicId, maxId } = payload || {};
            await driver.markForumTopicAsRead(Number(chatId), Number(topicId), Number(maxId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_forum_message': {
            const { chatId, topicId, text, replyTo } = payload;
            const messageId = await driver.sendForumMessage(Number(chatId), Number(topicId), String(text), replyTo ? Number(replyTo) : undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'forward_messages': {
            const { fromChatId, toChatId, messageIds } = payload;
            const ids = Array.isArray(messageIds) ? messageIds.map(Number) : [Number(messageIds)];
            const forwardedIds = await bot.adapter.forwardMessages(fromChatId, toChatId, ids);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageIds: forwardedIds } });
            break;
          }
          case 'send_message': {
            const { chatId, text, options } = payload;
            const msgId = await bot.adapter.sendMessage(Number(chatId), String(text), options);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'send_location': {
            const messageId = await driver.sendLocation(Number(payload?.chatId), Number(payload?.latitude), Number(payload?.longitude));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'send_live_location': {
            const messageId = await driver.sendLiveLocation(Number(payload?.chatId), Number(payload?.latitude), Number(payload?.longitude),
              Number(payload?.period), payload?.topMsgId == null ? undefined : Number(payload.topMsgId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'update_live_location': {
            await driver.editLiveLocation(Number(payload?.chatId), Number(payload?.messageId), {
              latitude: Number(payload?.latitude), longitude: Number(payload?.longitude), period: Number(payload?.period),
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'stop_live_location': {
            await driver.editLiveLocation(Number(payload?.chatId), Number(payload?.messageId), { stopped: true });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_contact': {
            const messageId = await driver.sendContact(Number(payload?.chatId), String(payload?.phoneNumber || ''), String(payload?.firstName || ''), String(payload?.lastName || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'send_bot_keyboard_phone': {
            const { chatId, messageId, row, column } = payload || {};
            const sentMessageId = await driver.sendReplyKeyboardPhone(Number(chatId), Number(messageId), Number(row), Number(column));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: sentMessageId } });
            break;
          }
          case 'send_bot_keyboard_location': {
            const { chatId, messageId, row, column, latitude, longitude } = payload || {};
            const sentMessageId = await driver.sendReplyKeyboardLocation(Number(chatId), Number(messageId), Number(row), Number(column), Number(latitude), Number(longitude));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: sentMessageId } });
            break;
          }
          case 'delete_messages': {
            const { chatId, messageIds, revoke = true } = payload;
            await bot.adapter.deleteMessages(Number(chatId), (messageIds || []).map(Number), revoke);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_dialog_pinned': {
            await bot.adapter.setDialogPinned(Number(payload.chatId), payload.pinned === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_pinned_dialogs': {
            const folderId = payload?.folderId === 1 ? 1 : 0;
            const ids = await driver.getPinnedDialogIds(folderId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: ids });
            break;
          }
          case 'reorder_pinned_dialogs': {
            const order = Array.isArray(payload?.order) ? payload.order.map(Number) : [];
            const folderId = payload?.folderId === 1 ? 1 : 0;
            await driver.reorderPinnedDialogs(order, folderId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_dialog_archived': {
            await bot.adapter.setDialogArchived(Number(payload.chatId), payload.archived === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_dialog': {
            await bot.adapter.deleteDialog(Number(payload.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'pin_message': {
            const { chatId, messageId, silent = false } = payload;
            await bot.adapter.pinMessage(Number(chatId), Number(messageId), Boolean(silent));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'unpin_message': {
            const { chatId, messageId } = payload;
            await bot.adapter.unpinMessage(chatId, messageId ? Number(messageId) : undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_reaction': {
            const { chatId, messageId, reaction } = payload;
            await bot.adapter.reactToMessage(Number(chatId), Number(messageId), reaction);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_available_reactions': {
            const chatId = payload?.chatId == null ? undefined : Number(payload.chatId);
            const reactions = await driver.getAvailableReactions(chatId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: reactions });
            break;
          }
          case 'get_message_effects': {
            const effects = await driver.getMessageEffects();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: effects });
            break;
          }
          case 'get_telegram_chat_themes': {
            const themes = await driver.getTelegramChatThemes();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: themes });
            break;
          }
          case 'get_telegram_business_settings': {
            const settings = await driver.getTelegramBusinessSettings();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: settings });
            break;
          }
          case 'update_telegram_business_work_hours': {
            await driver.updateTelegramBusinessWorkHours(String(payload?.timezoneId || ''), payload?.weeklyOpen);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'update_telegram_business_location': {
            await driver.updateTelegramBusinessLocation(String(payload?.address ?? ''), payload?.latitude, payload?.longitude);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'update_telegram_business_intro': {
            await driver.updateTelegramBusinessIntro(payload?.title, payload?.description, payload?.clear === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'create_telegram_business_chat_link': {
            const link = await driver.createTelegramBusinessChatLink(String(payload?.title ?? ''), String(payload?.message ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: link });
            break;
          }
          case 'edit_telegram_business_chat_link': {
            await driver.editTelegramBusinessChatLink(String(payload?.slug || ''), String(payload?.title ?? ''), String(payload?.message ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_telegram_business_chat_link': {
            await driver.deleteTelegramBusinessChatLink(String(payload?.slug || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'update_telegram_business_greeting_message': {
            await driver.updateTelegramBusinessGreetingMessage(Number(payload?.shortcutId), Number(payload?.noActivityDays), payload?.recipients, payload?.clear === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'update_telegram_business_away_message': {
            await driver.updateTelegramBusinessAwayMessage(Number(payload?.shortcutId), payload?.offlineOnly,
              payload?.schedule, payload?.startDate == null ? undefined : Number(payload.startDate),
              payload?.endDate == null ? undefined : Number(payload.endDate), payload?.recipients, payload?.clear === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_telegram_app_themes': {
            const themes = await driver.getTelegramAppThemes();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: themes });
            break;
          }
          case 'install_telegram_app_theme': {
            const result = await driver.installTelegramAppTheme(String(payload?.slug || ''), payload?.dark === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_telegram_wallpapers': {
            const wallpapers = await driver.getTelegramWallpapers();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: wallpapers });
            break;
          }
          case 'get_telegram_wallpaper_preview': {
            const filePath = await driver.downloadTelegramWallpaperPreview(String(payload?.slug || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { filePath } });
            break;
          }
          case 'get_telegram_wallpaper_file': {
            const wallpaper = await driver.downloadTelegramWallpaper(String(payload?.slug || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: wallpaper });
            break;
          }
          case 'set_telegram_chat_wallpaper': {
            const wallpaper = await driver.setTelegramChatWallpaper(Number(payload?.chatId), String(payload?.slug ?? ''), {
              forBoth: payload?.forBoth === true,
              ...(payload?.settings ? { settings: payload.settings } : {}),
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: wallpaper });
            break;
          }
          case 'get_telegram_chat_theme': {
            const theme = await driver.getTelegramChatTheme(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: theme });
            break;
          }
          case 'set_telegram_chat_theme': {
            const theme = await driver.setTelegramChatTheme(Number(payload?.chatId), String(payload?.emoticon ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: theme });
            break;
          }
          case 'set_chat_history_ttl': {
            const result = await driver.setChatHistoryTtl(Number(payload?.chatId), Number(payload?.period));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'apply_chat_history_ttl': {
            const result = await driver.applyChatHistoryTtl(payload?.chatIds, Number(payload?.period));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_default_history_ttl': {
            const result = await driver.getDefaultHistoryTtl();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_default_history_ttl': {
            const result = await driver.setDefaultHistoryTtl(Number(payload?.period));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_chat_translation_settings': {
            const settings = await driver.getChatTranslationSettings(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: settings });
            break;
          }
          case 'set_chat_translation_enabled': {
            const settings = await driver.setChatTranslationEnabled(Number(payload?.chatId), payload?.enabled);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: settings });
            break;
          }
          case 'edit_message': {
            const { chatId, messageId, text, options } = payload;
            await bot.adapter.editMessage(Number(chatId), Number(messageId), String(text), options);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'replace_message_media': {
            const { chatId, messageId, uploadPath, fileName, mimeType, caption, parseMode } = payload || {};
            if (typeof uploadPath !== 'string' || !isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
            try {
              await driver.replaceMessageMedia(Number(chatId), Number(messageId), uploadPath, String(fileName || ''),
                String(mimeType || ''), typeof caption === 'string' ? caption : '', parseMode);
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            } finally {
              await cleanupStreamUpload(uploadPath).catch(() => {});
            }
            break;
          }
          case 'mark_as_read': {
            const { chatId, maxId } = payload || {};
            await bot.adapter.markAsRead(Number(chatId), maxId ? Number(maxId) : undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'leave_chat': {
            const { chatId } = payload;
            await bot.adapter.leaveChat(Number(chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_title': {
            const { chatId, title } = payload || {};
            await bot.adapter.setChatTitle(Number(chatId), title);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_username': {
            const { chatId, username } = payload || {};
            await bot.adapter.setChatUsername(Number(chatId), username);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_photo': {
            const { chatId, uploadPath, fileName } = payload || {};
            if (!isStreamUploadPath(uploadPath)) throw new Error('Invalid staged group photo');
            await bot.adapter.setChatPhoto(Number(chatId), uploadPath, String(fileName || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_description': {
            const { chatId, description } = payload || {};
            await bot.adapter.setChatDescription(Number(chatId), description);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_permissions': {
            const { chatId, rights } = payload || {};
            await bot.adapter.setChatDefaultBannedRights(Number(chatId), rights);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_slow_mode': {
            const { chatId, seconds } = payload || {};
            await bot.adapter.setChatSlowMode(Number(chatId), Number(seconds));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_supergroup_setting': {
            const { chatId, setting, enabled } = payload || {};
            await bot.adapter.setSupergroupSetting(Number(chatId), setting, enabled);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_participants': {
            const { chatId, offset = 0, limit = 50, query = '' } = payload || {};
            const page = await bot.adapter.getParticipantsPage(Number(chatId), Number(offset), Number(limit), String(query));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: page });
            break;
          }
          case 'get_banned_participants': {
            const { chatId, offset = 0, limit = 50, query = '' } = payload || {};
            const result = await bot.adapter.getBannedParticipants(Number(chatId), Number(offset), Number(limit), String(query));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_chat_invite_links': {
            const { chatId, cursor, limit = 50 } = payload || {};
            const result = await bot.adapter.getChatInviteLinks(Number(chatId), cursor, Number(limit));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'create_chat_invite_link': {
            const { chatId, title, expireDate, usageLimit, requestNeeded = false } = payload || {};
            const link = await bot.adapter.createChatInviteLink(Number(chatId), {
              ...(title === undefined ? {} : { title: String(title) }),
              ...(expireDate == null ? {} : { expireDate: Number(expireDate) }),
              ...(usageLimit == null ? {} : { usageLimit: Number(usageLimit) }),
              requestNeeded,
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: link });
            break;
          }
          case 'revoke_chat_invite_link': {
            await bot.adapter.revokeChatInviteLink(Number(payload?.chatId), String(payload?.link || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'edit_chat_invite_link': {
            const updated = await bot.adapter.editChatInviteLink(Number(payload?.chatId), String(payload?.link || ''), String(payload?.title ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: updated });
            break;
          }
          case 'get_join_requests': {
            const { chatId, cursor, limit = 50, query = '' } = payload || {};
            const result = await bot.adapter.getJoinRequests(Number(chatId), cursor, Number(limit), String(query));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'decide_join_request': {
            const { chatId, userId, approved } = payload || {};
            await bot.adapter.decideJoinRequest(Number(chatId), Number(userId), approved);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'decide_all_join_requests': {
            const { chatId, approved } = payload || {};
            await bot.adapter.decideAllJoinRequests(Number(chatId), approved);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'kick_user': {
            const { chatId, userId } = payload;
            await bot.adapter.kickUser(Number(chatId), Number(userId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'invite_user': {
            const { chatId, userId } = payload || {};
            await bot.adapter.inviteUser(Number(chatId), Number(userId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'create_chat': {
            const created = await bot.adapter.createChat(payload || {});
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: created });
            break;
          }
          case 'ban_user': {
            const { chatId, userId, untilDate = 0 } = payload;
            await bot.adapter.banUser(Number(chatId), Number(userId), Number(untilDate));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'unban_user': {
            const { chatId, userId } = payload;
            await bot.adapter.unbanUser(Number(chatId), Number(userId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mute_user': {
            const { chatId, userId, seconds = 0 } = payload;
            await bot.adapter.muteUser(Number(chatId), Number(userId), Number(seconds));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'promote_user': {
            const { chatId, userId, perms } = payload || {};
            await bot.adapter.promoteUser(Number(chatId), Number(userId), perms);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'demote_user': {
            const { chatId, userId } = payload || {};
            await bot.adapter.demoteUser(Number(chatId), Number(userId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_poll': {
            const { chatId, question, options, pollOptions, schedule, scheduleRepeatPeriod } = payload;
            const messageId = await (bot.adapter as any).sendPoll(Number(chatId), question, options, pollOptions, {
              schedule: schedule == null ? undefined : Number(schedule),
              scheduleRepeatPeriod: scheduleRepeatPeriod == null ? undefined : Number(scheduleRepeatPeriod),
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'send_dice': {
            const { chatId, emoticon = '🎲', topMsgId } = payload || {};
            const messageId = await driver.sendDice(Number(chatId), emoticon, topMsgId == null ? undefined : Number(topMsgId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'edit_poll': {
            const { chatId, messageId, question, options, pollOptions } = payload || {};
            await driver.editPoll(Number(chatId), Number(messageId), question, options, pollOptions);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'press_bot_callback': {
            const { chatId, messageId, row, column } = payload || {};
            if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId)) ||
                !Number.isInteger(row) || !Number.isInteger(column)) throw new Error('无效的机器人按钮');
            const result = await bot.adapter.pressBotCallback(Number(chatId), Number(messageId), row, column);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'launch_bot_game': {
            const { chatId, messageId, row, column } = payload || {};
            if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId)) ||
                Number(messageId) <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
              throw new Error('无效的游戏按钮');
            }
            const result = await driver.launchBotGame(Number(chatId), Number(messageId), row, column);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'request_bot_url_auth':
          case 'accept_bot_url_auth': {
            const { chatId, messageId, row, column, writeAllowed } = payload || {};
            if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) ||
                !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
                !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16 ||
                (action === 'accept_bot_url_auth' && typeof writeAllowed !== 'boolean')) throw new Error('无效的登录授权按钮');
            const result = action === 'request_bot_url_auth'
              ? await driver.requestBotUrlAuth(Number(chatId), Number(messageId), row, column)
              : await driver.acceptBotUrlAuth(Number(chatId), Number(messageId), row, column, writeAllowed);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'send_bot_requested_peers': {
            const { chatId, messageId, row, column, peerIds } = payload || {};
            if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) ||
                !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
                !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16 ||
                !Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 10 ||
                peerIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) === 0)) throw new Error('无效的会话请求');
            await driver.sendBotRequestedPeers(Number(chatId), Number(messageId), row, column, peerIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'search_bot_requested_peers': {
            const { chatId, messageId, row, column, query } = payload || {};
            if (chatId == null || Number(chatId) === 0 || !Number.isSafeInteger(Number(chatId)) ||
                !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0 ||
                !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16 ||
                typeof query !== 'string' || query.trim().length < 2 || query.length > 64) throw new Error('无效的会话搜索');
            const results = await driver.searchBotRequestedPeers(Number(chatId), Number(messageId), row, column, query);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: results });
            break;
          }
          case 'send_todo_list': {
            const { chatId, title, tasks, othersCanComplete, othersCanAppend } = payload || {};
            const messageId = await driver.sendTodoList(Number(chatId), title, tasks, { othersCanComplete, othersCanAppend });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'toggle_todo_task': {
            await driver.toggleTodoTask(Number(payload?.chatId), Number(payload?.messageId), Number(payload?.taskId), payload?.completed);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'append_todo_tasks': {
            await driver.appendTodoTasks(Number(payload?.chatId), Number(payload?.messageId), payload?.tasks);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'edit_todo_list': {
            await driver.editTodoList(Number(payload?.chatId), Number(payload?.messageId), payload?.title, payload?.tasks, {
              othersCanComplete: payload?.othersCanComplete, othersCanAppend: payload?.othersCanAppend,
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_vote': {
            const { chatId, messageId, optionIndexes } = payload;
            await (bot.adapter as any).sendVote(Number(chatId), Number(messageId), optionIndexes.map(Number));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_poll_votes': {
            const { chatId, messageId, optionIndex, offset, limit } = payload || {};
            const result = await driver.getPollVotes(Number(chatId), Number(messageId), Number(optionIndex),
              typeof offset === 'string' ? offset : undefined, Number(limit) || 50);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'close_poll': {
            const { chatId, messageId } = payload || {};
            await driver.closePoll(Number(chatId), Number(messageId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_quick_replies': {
            const result = await driver.getQuickReplies();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_quick_reply_messages': {
            const result = await driver.getQuickReplyMessages(Number(payload?.shortcutId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'create_quick_reply': {
            await driver.createQuickReply(String(payload?.shortcut || ''), String(payload?.text || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'add_quick_reply_message': {
            await driver.addQuickReplyMessage(Number(payload?.shortcutId), String(payload?.text || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'add_quick_reply_media': {
            const { shortcutId, uploadPath, fileName, mimeType, caption } = payload || {};
            if (typeof uploadPath !== 'string' || !isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
            try {
              await driver.addQuickReplyMedia(Number(shortcutId), uploadPath, String(fileName || ''), String(mimeType || ''), String(caption || ''));
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            } finally {
              await cleanupStreamUpload(uploadPath).catch(() => {});
            }
            break;
          }
          case 'replace_quick_reply_media': {
            const { shortcutId, messageId, uploadPath, fileName, mimeType, caption } = payload || {};
            if (typeof uploadPath !== 'string' || !isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
            try {
              await driver.replaceQuickReplyMedia(Number(shortcutId), Number(messageId), uploadPath, String(fileName || ''), String(mimeType || ''), String(caption || ''));
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            } finally {
              await cleanupStreamUpload(uploadPath).catch(() => {});
            }
            break;
          }
          case 'edit_quick_reply_message': {
            await driver.editQuickReplyMessage(Number(payload?.shortcutId), Number(payload?.messageId), String(payload?.text ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_quick_reply_messages': {
            const ids = Array.isArray(payload?.messageIds) ? payload.messageIds.map(Number) : [];
            await driver.deleteQuickReplyMessages(Number(payload?.shortcutId), ids);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_quick_reply': {
            const { chatId, shortcutId } = payload || {};
            await driver.sendQuickReply(Number(chatId), Number(shortcutId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'rename_quick_reply': {
            const { shortcutId, shortcut } = payload || {};
            await driver.renameQuickReply(Number(shortcutId), String(shortcut || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_quick_reply': {
            await driver.deleteQuickReply(Number(payload?.shortcutId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_scheduled_messages': {
            const result = await driver.getScheduledMessages(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'send_scheduled_now': {
            const messageIds = Array.isArray(payload?.messageIds) ? payload.messageIds.map(Number) : [];
            await driver.sendScheduledMessageNow(Number(payload?.chatId), messageIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'delete_scheduled_messages': {
            const messageIds = Array.isArray(payload?.messageIds) ? payload.messageIds.map(Number) : [];
            await driver.deleteScheduledMessages(Number(payload?.chatId), messageIds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'edit_scheduled_message': {
            const { chatId, messageId, text, parseMode, schedule, scheduleRepeatPeriod } = payload || {};
            await driver.editScheduledMessage(Number(chatId), Number(messageId), String(text ?? ''), {
              parseMode,
              schedule: schedule == null ? undefined : Number(schedule),
              scheduleRepeatPeriod: scheduleRepeatPeriod === undefined ? undefined : scheduleRepeatPeriod === null ? null : Number(scheduleRepeatPeriod),
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'transcribe_voice_message': {
            const { chatId, messageId } = payload || {};
            const result = await driver.transcribeVoiceMessage(Number(chatId), Number(messageId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'rate_voice_transcription': {
            const { chatId, messageId, transcriptionId, good } = payload || {};
            await driver.rateVoiceTranscription(Number(chatId), Number(messageId), String(transcriptionId || ''), good);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_message_reaction_users': {
            const { chatId, messageId, emoji, offset, limit } = payload || {};
            const result = await driver.getMessageReactionUsers(Number(chatId), Number(messageId), String(emoji || ''),
              typeof offset === 'string' ? offset : '', Number(limit) || 50);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_message_read_participants': {
            const { chatId, messageId } = payload || {};
            const result = await driver.getMessageReadParticipants(Number(chatId), Number(messageId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_chat_mute': {
            const { chatId, muteUntil = 2147483647 } = payload;
            await (bot.adapter as any).setChatMute(Number(chatId), Number(muteUntil));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mark_all_read': {
            const result = await markAllDialogsRead(bot.adapter);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_profile': {
            const profile = await bot.adapter.getOwnProfile();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: profile });
            break;
          }
          case 'get_account_emoji_status': {
            const result = await driver.getAccountEmojiStatus();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_emoji_status': {
            const documentId = payload?.documentId;
            const durationSeconds = payload?.durationSeconds;
            if (documentId !== null && (typeof documentId !== 'string' || !/^[1-9]\d{0,19}$/.test(documentId))) throw new Error('Invalid Emoji status document');
            if (documentId !== null && durationSeconds != null && ![0, 3600, 28800, 172800].includes(durationSeconds)) throw new Error('Invalid Emoji status duration');
            await driver.setAccountEmojiStatus(documentId, durationSeconds);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_saved_message_tags': {
            const result = await driver.getSavedMessageTags();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'update_saved_message_tag': {
            await driver.updateSavedMessageTag(payload?.reaction, payload?.title);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_saved_message_tag': {
            await driver.setSavedMessageTag(Number(payload?.chatId), Number(payload?.messageId), payload?.reaction, payload?.enabled);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'update_profile': {
            const { firstName, lastName, bio } = payload;
            await bot.adapter.updateProfile({ firstName, lastName, bio });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_online': {
            const { online } = payload;
            await bot.adapter.setOnline(Boolean(online));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_telegram_authorizations': {
            const result = await driver.getTelegramAuthorizations();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'revoke_telegram_authorization': {
            await driver.revokeTelegramAuthorization(String(payload?.hash || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'revoke_other_telegram_authorizations': {
            await driver.revokeOtherTelegramAuthorizations();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_privacy_settings': {
            const result = await driver.getAccountPrivacySettings();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_privacy_setting': {
            await driver.setAccountPrivacySetting(String(payload?.key || ''), String(payload?.mode || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_privacy_exceptions': {
            const result = await driver.getAccountPrivacyExceptions(String(payload?.key || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_privacy_special_rules': {
            const result = await driver.getAccountPrivacySpecialRules(String(payload?.key || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_privacy_special_rule': {
            await driver.setAccountPrivacySpecialRule(String(payload?.key || ''), String(payload?.field || ''), payload?.value);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'remove_account_privacy_exception': {
            await driver.removeAccountPrivacyException(String(payload?.key || ''), String(payload?.category || ''), String(payload?.entityId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'add_account_privacy_user_exception': {
            await driver.addAccountPrivacyUserException(String(payload?.key || ''), String(payload?.category || ''), String(payload?.userId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'add_account_privacy_chat_exception': {
            await driver.addAccountPrivacyChatException(String(payload?.key || ''), String(payload?.category || ''), Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_global_privacy_settings': {
            const result = await driver.getAccountGlobalPrivacySettings();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_global_privacy_setting': {
            await driver.setAccountGlobalPrivacySetting(String(payload?.key || ''), payload?.value);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_stars': {
            const result = await driver.getAccountStars(String(payload?.offset || ''), Number(payload?.limit) || 20);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_stars_topup_options': {
            const result = await driver.getAccountStarsTopupOptions();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'prepare_account_stars_topup': {
            const optionId = payload?.optionId;
            if (typeof optionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(optionId)) throw new Error('Invalid Telegram Stars top-up option');
            const result = await driver.prepareAccountStarsTopup(optionId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'confirm_account_stars_topup': {
            const token = payload?.token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Invalid Telegram Stars top-up confirmation');
            const result = await driver.confirmAccountStarsTopup(token);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'check_account_gift_code': {
            const slug = payload?.slug;
            if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) throw new Error('Invalid Telegram gift code');
            const result = await driver.checkAccountGiftCode(slug);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'apply_account_gift_code': {
            const slug = payload?.slug;
            if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) throw new Error('Invalid Telegram gift code');
            const result = await driver.applyAccountGiftCode(slug);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_star_gifts': {
            const result = await driver.getAccountStarGifts();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_saved_star_gifts': {
            const result = await driver.getAccountSavedStarGifts(String(payload?.offset || ''), Number(payload?.limit) || 20);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_star_gift_saved': {
            const id = payload?.id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id) || typeof payload?.saved !== 'boolean') {
              throw new Error('Invalid saved Telegram Star Gift state');
            }
            const result = await driver.setAccountStarGiftSaved(id, payload.saved);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'convert_account_star_gift': {
            const id = payload?.id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('Invalid saved Telegram Star Gift');
            const result = await driver.convertAccountStarGift(id);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'prepare_account_star_gift_upgrade': {
            const id = payload?.id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('Invalid saved Telegram Star Gift');
            const result = await driver.prepareAccountStarGiftUpgrade(id);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'confirm_account_star_gift_upgrade': {
            const token = payload?.token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || typeof payload?.keepOriginalDetails !== 'boolean') {
              throw new Error('Invalid Telegram Star Gift upgrade confirmation');
            }
            const result = await driver.confirmAccountStarGiftUpgrade(token, payload.keepOriginalDetails);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'prepare_account_star_gift_transfer': {
            const id = payload?.id, chatId = Number(payload?.chatId);
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id) || !Number.isSafeInteger(chatId) || chatId <= 0) {
              throw new Error('Invalid Telegram Star Gift transfer request');
            }
            const result = await driver.prepareAccountStarGiftTransfer(id, chatId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'confirm_account_star_gift_transfer': {
            const token = payload?.token, chatId = Number(payload?.chatId);
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || !Number.isSafeInteger(chatId) || chatId <= 0) {
              throw new Error('Invalid Telegram Star Gift transfer confirmation');
            }
            const result = await driver.confirmAccountStarGiftTransfer(token, chatId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'prepare_chat_paid_media': {
            const chatId = Number(payload?.chatId), messageId = Number(payload?.messageId);
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
              throw new Error('Invalid paid media target');
            }
            const result = await driver.prepareChatPaidMediaPayment(chatId, messageId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'confirm_chat_paid_media': {
            const chatId = Number(payload?.chatId), messageId = Number(payload?.messageId), token = payload?.token;
            if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
                typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Invalid paid media payment confirmation');
            const result = await driver.confirmChatPaidMediaPayment(token, chatId, messageId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'prepare_account_star_gift': {
            const chatId = Number(payload?.chatId), giftId = payload?.giftId;
            if (!Number.isSafeInteger(chatId) || chatId <= 0 || typeof giftId !== 'string' ||
                !/^\d{1,20}$/.test(giftId) || /^0+$/.test(giftId) ||
                (payload?.hideName != null && typeof payload.hideName !== 'boolean') ||
                (payload?.includeUpgrade != null && typeof payload.includeUpgrade !== 'boolean')) {
              throw new Error('Invalid Star Gift request');
            }
            const result = await driver.prepareAccountStarGiftPayment(chatId, giftId, {
              hideName: payload?.hideName, includeUpgrade: payload?.includeUpgrade,
            });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'confirm_account_star_gift': {
            const chatId = Number(payload?.chatId), giftId = payload?.giftId, token = payload?.token;
            if (!Number.isSafeInteger(chatId) || chatId <= 0 || typeof giftId !== 'string' ||
                !/^\d{1,20}$/.test(giftId) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
              throw new Error('Invalid Star Gift payment confirmation');
            }
            const result = await driver.confirmAccountStarGiftPayment(token, chatId, giftId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_stars_subscriptions': {
            const result = await driver.getAccountStarsSubscriptions(String(payload?.offset || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_stars_subscription_canceled': {
            await driver.setAccountStarsSubscriptionCanceled(String(payload?.subscriptionId || ''), payload?.canceled);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_notification_settings': {
            const result = await driver.getAccountNotificationSettings();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_notification_sounds': {
            const result = await driver.getAccountNotificationSounds();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_account_notification_sound_preview': {
            const result = await driver.downloadAccountNotificationSound(String(payload?.soundId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'upload_account_notification_sound': {
            await driver.uploadAccountNotificationSound(String(payload?.uploadPath || ''), String(payload?.fileName || ''), String(payload?.mimeType || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'remove_account_notification_sound': {
            await driver.removeAccountNotificationSound(String(payload?.soundId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_account_notification_exceptions': {
            const result = await driver.getAccountNotificationExceptions(String(payload?.key || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'set_account_notification_settings': {
            const { key, muted, muteUntil, showPreviews, silent, soundId, storiesMuted, storiesHideSender, storiesSoundId } = payload || {};
            await driver.setAccountNotificationSettings(String(key || ''), { muted, muteUntil, showPreviews, silent, soundId, storiesMuted, storiesHideSender, storiesSoundId });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_account_notification_exception': {
            const { chatId, muted, muteUntil, showPreviews, silent, soundId, storiesMuted, storiesHideSender, storiesSoundId } = payload || {};
            await driver.setAccountNotificationException(Number(chatId), { muted, muteUntil, showPreviews, silent, soundId, storiesMuted, storiesHideSender, storiesSoundId });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_typing': {
            const { chatId } = payload;
            await bot.adapter.sendTyping(Number(chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_contacts': {
            const contacts = await bot.adapter.getContacts();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: contacts });
            break;
          }
          case 'quick_purge': {
            const chatId = Number(payload?.chatId);
            const count = Math.min(Math.max(Number(payload?.count) || 10, 1), 100);
            const client: any = bot.adapter.raw();
            const msgs = await client.getMessages(BigInt(chatId), { limit: count });
            const ids = msgs.map((m: any) => m.id);
            if (ids.length > 0) {
              await bot.adapter.deleteMessages(chatId, ids);
            }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { deletedCount: ids.length } });
            break;
          }
          case 'broadcast': {
            const { chatIds, text, intervalMs = 800 } = payload;
            const results = [];
            for (const cid of chatIds) {
              try {
                const mid = await bot.adapter.sendMessage(Number(cid), text);
                results.push({ chatId: cid, success: true, messageId: mid });
              } catch (err: any) {
                results.push({ chatId: cid, success: false, error: err.message });
              }
              if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
            }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: results });
            break;
          }
          case 'resolve_peer': {
            const query = String(payload?.query || '').trim();
            let result: any = null;
            if (/^\d+$/.test(query)) {
              result = (await bot.adapter.getUser(Number(query))) || (await bot.adapter.getChat(Number(query)));
            } else {
              const client: any = bot.adapter.raw();
              const entity = await client.getEntity(query);
              result = {
                id: entity.id?.toString(),
                title: entity.title || `${entity.firstName || ''} ${entity.lastName || ''}`.trim(),
                username: entity.username,
                phone: entity.phone,
                className: entity.className,
              };
            }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_avatar': {
            const { chatId, isBig } = payload;
            const filePath = await bot.adapter.downloadProfilePhoto(Number(chatId), { isBig: Boolean(isBig) });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { filePath } });
            break;
          }
          case 'get_user_photos': {
            const { userId, limit } = payload;
            const photos = await bot.adapter.getUserPhotos(Number(userId), limit);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: photos });
            break;
          }
          case 'get_user_photo_file': {
            const { userId, index } = payload;
            const self = bot.adapter.getSelf();
            if (!self) throw new Error('Telegram account is not ready');
            const namespace = mediaCacheNamespace(instConfig.sessionPath, self.id);
            const cachePath = path.resolve('data', 'cache', 'photos', `${namespace}_${Number(userId)}_${Number(index)}`);
            const filePath = await bot.adapter.downloadUserPhoto(Number(userId), Number(index), cachePath);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { filePath } });
            break;
          }
          case 'get_peer_profile': {
            const { chatId } = payload;
            const details = await bot.adapter.getPeerProfile(Number(chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: details });
            break;
          }
          case 'get_peer_stories': {
            const { chatId } = payload;
            const stories = await bot.adapter.getPeerStories(Number(chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: stories });
            break;
          }
          case 'get_story_by_id': {
            const story = await bot.adapter.getStoryById(Number(payload?.chatId), Number(payload?.storyId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: story || null });
            break;
          }
          case 'get_story_archive': {
            const stories = await driver.getStoryArchive(Number(payload?.offsetId || 0), Number(payload?.limit || 20));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: stories });
            break;
          }
          case 'get_story_albums': {
            const albums = await driver.getStoryAlbums(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: albums });
            break;
          }
          case 'get_story_album_cover': {
            const cover = await driver.downloadStoryAlbumCover(Number(payload?.chatId), Number(payload?.albumId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: cover });
            break;
          }
          case 'get_story_album_stories': {
            const page = await driver.getStoryAlbumStories(Number(payload?.chatId), Number(payload?.albumId),
              Number(payload?.offset || 0), Number(payload?.limit || 20));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: page });
            break;
          }
          case 'create_story_album': {
            const album = await driver.createStoryAlbum(Number(payload?.chatId), String(payload?.title ?? ''), payload?.storyIds || []);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: album });
            break;
          }
          case 'update_story_album': {
            const album = await driver.updateStoryAlbum(Number(payload?.chatId), Number(payload?.albumId), payload?.update || {});
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: album });
            break;
          }
          case 'delete_story_album': {
            await driver.deleteStoryAlbum(Number(payload?.chatId), Number(payload?.albumId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'reorder_story_albums': {
            await driver.reorderStoryAlbums(Number(payload?.chatId), payload?.albumIds || []);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'move_story_album_story': {
            await driver.moveStoryAlbumStory(Number(payload?.chatId), Number(payload?.albumId), Number(payload?.storyId), Number(payload?.delta));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_story_stealth_status': {
            const status = await driver.getStoryStealthStatus();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: status });
            break;
          }
          case 'get_story_feed': {
            const feed = await driver.getStoriesFeed(String(payload?.state || ''), payload?.next === true, payload?.hidden === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: feed });
            break;
          }
          case 'get_story_notifications_muted': {
            const muted = await driver.getPeerStoriesNotificationsMuted(Number(payload?.chatId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { muted } });
            break;
          }
          case 'set_story_notifications_muted': {
            await driver.setPeerStoriesNotificationsMuted(Number(payload?.chatId), payload?.muted);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'activate_story_stealth': {
            const status = await driver.activateStoryStealth();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: status });
            break;
          }
          case 'get_story_viewers': {
            const result = await driver.getStoryViewers(Number(payload.chatId), Number(payload.storyId), String(payload.offset || ''), Number(payload.limit) || 50,
              payload.kind === 'reactions' || payload.kind === 'forwards' ? payload.kind : 'viewers');
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'export_story_link': {
            const link = await driver.exportStoryLink(Number(payload.chatId), Number(payload.storyId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { link } });
            break;
          }
          case 'delete_stories': {
            const ids = Array.isArray(payload?.storyIds) ? payload.storyIds.map(Number) : [];
            await driver.deleteStories(Number(payload?.chatId), ids);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'pin_story': {
            await driver.setStoryPinned(Number(payload?.chatId), Number(payload?.storyId), payload?.pinned === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'edit_story_caption': {
            await driver.editStoryCaption(Number(payload?.chatId), Number(payload?.storyId), String(payload?.caption ?? ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_story_privacy_settings': {
            const settings = await driver.getStoryPrivacySettings(Number(payload?.chatId), Number(payload?.storyId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: settings });
            break;
          }
          case 'set_story_privacy_settings': {
            await driver.setStoryPrivacySettings(Number(payload?.chatId), Number(payload?.storyId), payload?.settings);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_story_media': {
            const { chatId, storyId } = payload || {};
            const media = await driver.downloadStoryMedia(Number(chatId), Number(storyId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: media || null });
            break;
          }
          case 'read_story': {
            const { chatId, storyId } = payload || {};
            await driver.readStory(Number(chatId), Number(storyId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'react_story': {
            const { chatId, storyId, emoji } = payload || {};
            await driver.reactToStory(Number(chatId), Number(storyId), typeof emoji === 'string' ? emoji : undefined);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'reply_to_story': {
            const { chatId, storyId, text, parseMode } = payload || {};
            await driver.replyToStory(Number(chatId), Number(storyId), String(text || ''), parseMode);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_peer_stories_hidden': {
            const { chatId, hidden } = payload || {};
            await driver.setPeerStoriesHidden(Number(chatId), hidden);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_chat_media': {
            const { chatId, filterType = 'music', limit = 50 } = payload;
            const mediaMessages = await bot.adapter.getChatMedia(Number(chatId), filterType, limit);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: mediaMessages });
            break;
          }
          case 'get_media_stream_info': {
            const info = await driver.getMediaStreamInfo(Number(payload?.chatId), Number(payload?.messageId), payload?.mediaIndex == null ? undefined : Number(payload.mediaIndex));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: info || null });
            break;
          }
          case 'get_media_stream_chunk': {
            const bytes = await driver.getMediaStreamChunk(Number(payload?.chatId), Number(payload?.messageId), payload?.info, Number(payload?.offset), Number(payload?.length));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { base64: bytes.toString('base64') } });
            break;
          }
          case 'get_message_media': {
            const { chatId, messageId, thumb, mediaIndex } = payload;
            const media = await bot.adapter.downloadMediaFile(Number(chatId), Number(messageId), Boolean(thumb), undefined, mediaIndex == null ? undefined : Number(mediaIndex));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: media });
            break;
          }
          case 'send_media': {
            const { chatId, mediaType = 'document', fileBase64, fileName = 'file.bin', caption, replyTo, topicId, parseMode, silent, effectId, paidStars, scheduleRepeatPeriod, invertMedia, videoNote } = payload;
            if (typeof fileBase64 !== 'string' || !fileBase64) throw new Error('Missing file data');
            if (videoNote != null && (typeof videoNote !== 'boolean' || (videoNote && (mediaType !== 'video' || paidStars != null || scheduleRepeatPeriod != null)))) throw new Error('Invalid Telegram video note options');
            const msgId = await withTemporaryUpload(
              path.resolve('data', 'cache', 'uploads'), fileName, fileBase64,
              (tempPath) => bot.adapter.sendMedia(Number(chatId), tempPath, mediaType, {
                caption,
                parseMode,
                silent,
                replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
                topMsgId: topicId ? Number(topicId) : undefined,
                schedule: payload.schedule ? Number(payload.schedule) : undefined,
                scheduleRepeatPeriod: scheduleRepeatPeriod == null ? undefined : Number(scheduleRepeatPeriod),
                effectId,
                invertMedia,
                videoNote,
                ...(paidStars == null ? {} : { paidStars: Number(paidStars) }),
              }),
            );

            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'send_media_stream': {
            const { chatId, mediaType = 'document', uploadPath, caption, replyTo, commentTo, topicId, parseMode, silent, schedule, scheduleRepeatPeriod, effectId, paidStars, invertMedia, videoNote } = payload;
            if (typeof uploadPath !== 'string' || !isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
            if (videoNote != null && (typeof videoNote !== 'boolean' || (videoNote && (mediaType !== 'video' || paidStars != null || scheduleRepeatPeriod != null)))) throw new Error('Invalid Telegram video note options');
            if (commentTo != null && (!Number.isSafeInteger(Number(commentTo)) || Number(commentTo) <= 0 || replyTo != null)) throw new Error('Invalid discussion');
            if (topicId != null && (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0 || Number(chatId) >= 0 || commentTo != null)) throw new Error('Invalid forum topic');
            try {
              const msgId = await bot.adapter.sendMedia(Number(chatId), uploadPath, mediaType, {
                caption, parseMode, silent,
                replyTo: replyTo ? Number(replyTo) : (topicId ? Number(topicId) : undefined),
                topMsgId: topicId ? Number(topicId) : undefined,
                commentTo: commentTo ? Number(commentTo) : undefined,
                schedule: schedule ? Number(schedule) : undefined,
                scheduleRepeatPeriod: scheduleRepeatPeriod == null ? undefined : Number(scheduleRepeatPeriod),
                effectId,
                invertMedia,
                videoNote,
                ...(paidStars == null ? {} : { paidStars: Number(paidStars) }),
              });
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            } finally {
              await cleanupStreamUpload(uploadPath).catch(() => {});
            }
            break;
          }
          case 'send_media_album_stream': {
            const { chatId, uploadPaths, caption, replyTo, topMsgId, parseMode, silent, schedule, effectId, paidStars, invertMedia } = payload;
            if (!Array.isArray(uploadPaths) || uploadPaths.length < 2 || uploadPaths.length > 10 ||
                uploadPaths.some((file: unknown) => typeof file !== 'string' || !isStreamUploadPath(file)) ||
                uploadPaths.some((file: string) => path.dirname(file) !== path.dirname(uploadPaths[0]))) {
              throw new Error('Invalid staged album upload');
            }
            const uploadPath = uploadPaths[0] as string;
            try {
              const msgId = await bot.adapter.sendMediaAlbum(Number(chatId), uploadPaths, {
                caption, parseMode, silent,
                replyTo: replyTo ? Number(replyTo) : (topMsgId ? Number(topMsgId) : undefined),
                topMsgId: topMsgId ? Number(topMsgId) : undefined,
                schedule: schedule ? Number(schedule) : undefined,
                effectId,
                invertMedia,
                ...(paidStars == null ? {} : { paidStars: Number(paidStars) }),
              });
              sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            } finally {
              await cleanupStreamUpload(uploadPath).catch(() => {});
            }
            break;
          }
          case 'get_all_stickers': {
            const sets = await bot.adapter.getAllStickerSets();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: sets });
            break;
          }
          case 'get_sticker_collections': {
            const collections = await bot.adapter.getStickerCollections();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: collections });
            break;
          }
          case 'set_sticker_favorite': {
            await bot.adapter.setStickerFavorite(String(payload?.docId || ''), String(payload?.accessHash || ''),
              String(payload?.fileReference || ''), payload?.favorite === true);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'search_stickers': {
            const result = await bot.adapter.searchStickers(String(payload?.query || ''), Number(payload?.offset || 0), Number(payload?.limit || 40));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'get_sticker_set': {
            const { setId, accessHash, shortName } = payload;
            const details = await bot.adapter.getStickerSetDetails(setId, accessHash, shortName);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: details });
            break;
          }
          case 'get_sticker_thumb': {
            const { docId, accessHash, fileReference } = payload;
            const filePath = await bot.adapter.downloadStickerThumb(String(docId), String(accessHash), String(fileReference || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { filePath } });
            break;
          }
          case 'get_custom_emoji_preview': {
            const preview = await bot.adapter.downloadCustomEmojiPreview(String(payload?.documentId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: preview });
            break;
          }
          case 'search_custom_emoji': {
            const results = await bot.adapter.searchCustomEmoji(String(payload?.emoticon || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: results });
            break;
          }
          case 'search_emoji_keywords': {
            const results = await driver.searchEmojiKeywords(String(payload?.query || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: results });
            break;
          }
          case 'get_emoji_groups': {
            const groups = await driver.getEmojiGroups();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: groups });
            break;
          }
          case 'send_custom_emoji': {
            const messageId = await bot.adapter.sendCustomEmoji(Number(payload?.chatId), String(payload?.emoticon || ''), String(payload?.documentId || ''));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'get_saved_gifs': {
            const gifs = await bot.adapter.getSavedGifs();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: gifs });
            break;
          }
          case 'search_inline_gifs': {
            const chatId = Number(payload?.chatId), query = payload?.query, offset = payload?.offset ?? '';
            if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof query !== 'string' || !query.trim() || query.length > 128 ||
                typeof offset !== 'string' || offset.length > 512) throw new Error('Invalid GIF search request');
            const result = await driver.searchInlineGifs(chatId, query, offset);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: result });
            break;
          }
          case 'send_inline_gif': {
            const chatId = Number(payload?.chatId), token = payload?.token;
            const replyTo = payload?.replyTo == null ? undefined : Number(payload.replyTo);
            const topMsgId = payload?.topMsgId == null ? undefined : Number(payload.topMsgId);
            if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
                (replyTo != null && (!Number.isSafeInteger(replyTo) || replyTo <= 0)) ||
                (topMsgId != null && (!Number.isSafeInteger(topMsgId) || topMsgId <= 0 || chatId >= 0))) throw new Error('Invalid GIF send request');
            await driver.sendInlineGif(chatId, token, replyTo, topMsgId);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success: true } });
            break;
          }
          case 'save_inline_gif': {
            const chatId = Number(payload?.chatId), token = payload?.token;
            if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
              throw new Error('Invalid GIF save request');
            }
            const success = await driver.saveInlineGif(chatId, token);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success } });
            break;
          }
          case 'get_gif_preview': {
            const { docId, accessHash, fileReference, mimeType } = payload;
            const preview = await bot.adapter.downloadGifPreview(String(docId), String(accessHash), String(fileReference || ''), String(mimeType || 'video/mp4'));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: preview });
            break;
          }
          case 'send_sticker_document': {
            const { chatId, docId, accessHash, fileReference, replyTo, topMsgId } = payload;
            const msgId = await bot.adapter.sendStickerDocument(
              Number(chatId),
              String(docId),
              String(accessHash),
              String(fileReference || ''),
              replyTo ? Number(replyTo) : undefined,
              topMsgId ? Number(topMsgId) : undefined,
            );
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'send_gif_document': {
            const { chatId, docId, accessHash, fileReference, replyTo, topMsgId } = payload;
            const msgId = await bot.adapter.sendGifDocument(
              Number(chatId),
              String(docId),
              String(accessHash),
              String(fileReference || ''),
              replyTo ? Number(replyTo) : undefined,
              topMsgId ? Number(topMsgId) : undefined,
            );
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'save_gif_document': {
            const { docId, accessHash, fileReference, unsave } = payload;
            if (typeof unsave !== 'boolean') throw new Error('Invalid GIF save request');
            const success = await driver.saveGifDocument(String(docId), String(accessHash), String(fileReference || ''), unsave);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success } });
            break;
          }
          case 'install_sticker_set': {
            const { setId, accessHash } = payload;
            const ok = await bot.adapter.installStickerSet(String(setId), String(accessHash));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success: ok } });
            break;
          }
          case 'uninstall_sticker_set': {
            const { setId, accessHash } = payload;
            const ok = await bot.adapter.uninstallStickerSet(String(setId), String(accessHash));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { success: ok } });
            break;
          }
          default:
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: false, error: `Unknown action: ${action}` });
        }
      } catch (err: any) {
        sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: false, error: err.message });
      }
    }
  });

  // Periodic metrics heartbeat
  const metricsTimer = setInterval(() => {
    sendIPC({
      type: 'METRICS',
      data: {
        memoryRss: process.memoryUsage().rss,
        uptime: Math.floor(process.uptime()),
        messagesCount,
        commandsCount,
      },
    });
  }, 3000);

  // Graceful shutdown handlers
  const cleanup = async () => {
    clearInterval(metricsTimer);
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await bot.start();
  } catch (err: any) {
    logger.error({ err }, 'Failed to start bot');
    sendIPC({ type: 'STATUS_CHANGE', status: 'ERROR', error: err.message });
  }
}

runWorker().catch((err) => {
  sendIPC({ type: 'STATUS_CHANGE', status: 'ERROR', error: err.message });
  // eslint-disable-next-line no-console
  console.error('Worker fatal error:', err);
  process.exit(1);
});

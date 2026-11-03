import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';
import { Bot } from '../bot/core/bot';
import { TelegramDriver, type AuthPromptHandler } from '../bot/driver/telegram';
import type { BotConfig } from '../bot/config';
import type { InstanceConfig, IPCToParent, IPCToChild } from './types';

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

  bot.adapter.on('disconnected', (e) => {
    sendIPC({ type: 'STATUS_CHANGE', status: 'STOPPED', error: e.reason });
  });

  bot.adapter.on('error', (e) => {
    sendIPC({ type: 'STATUS_CHANGE', status: 'ERROR', error: e.error.message });
  });

  // Listen for IPC messages from parent
  process.on('message', async (raw: IPCToChild) => {
    if (!raw) return;

    if (raw.type === 'AUTH_INPUT') {
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
          case 'get_dialogs': {
            const limit = Number(payload?.limit) || 50;
            const dialogs = await bot.adapter.getDialogs(limit);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: dialogs });
            break;
          }
          case 'get_messages': {
            const chatId = Number(payload?.chatId);
            const limit = Math.min(Math.max(Number(payload?.limit) || 40, 1), 100);
            const offsetId = payload?.offsetId ? Number(payload.offsetId) : undefined;
            const search = payload?.search ? String(payload.search) : undefined;
            const messages = await bot.adapter.getMessages(chatId, { limit, offsetId, search });
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: messages });
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
          case 'delete_messages': {
            const { chatId, messageIds } = payload;
            await bot.adapter.deleteMessages(Number(chatId), (messageIds || []).map(Number));
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
          case 'edit_message': {
            const { chatId, messageId, text, options } = payload;
            await bot.adapter.editMessage(Number(chatId), Number(messageId), String(text), options);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
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
          case 'get_participants': {
            const { chatId, limit = 100 } = payload;
            const participants = await bot.adapter.getParticipants(Number(chatId), Number(limit));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: participants });
            break;
          }
          case 'kick_user': {
            const { chatId, userId } = payload;
            await bot.adapter.kickUser(Number(chatId), Number(userId));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'ban_user': {
            const { chatId, userId, untilDate = 0 } = payload;
            await bot.adapter.banUser(Number(chatId), Number(userId), Number(untilDate));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mute_user': {
            const { chatId, userId, seconds = 0 } = payload;
            await bot.adapter.muteUser(Number(chatId), Number(userId), Number(seconds));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'send_poll': {
            const { chatId, question, options, pollOptions } = payload;
            const messageId = await (bot.adapter as any).sendPoll(Number(chatId), question, options, pollOptions);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId } });
            break;
          }
          case 'send_vote': {
            const { chatId, messageId, optionIndexes } = payload;
            await (bot.adapter as any).sendVote(Number(chatId), Number(messageId), optionIndexes.map(Number));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'set_chat_mute': {
            const { chatId, muteUntil = 2147483647 } = payload;
            await (bot.adapter as any).setChatMute(Number(chatId), Number(muteUntil));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'mark_all_read': {
            const dialogs = await bot.adapter.getDialogs(100);
            for (const d of dialogs) {
              if (d.unreadCount > 0) {
                await bot.adapter.markAsRead(d.id).catch(() => {});
              }
            }
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true });
            break;
          }
          case 'get_profile': {
            const self = bot.adapter.getSelf();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: self });
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
            const cachePath = path.resolve('data', 'cache', 'photos', `${userId}_${index}.jpg`);
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
          case 'get_chat_media': {
            const { chatId, filterType = 'music', limit = 50 } = payload;
            const mediaMessages = await bot.adapter.getChatMedia(Number(chatId), filterType, limit);
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: mediaMessages });
            break;
          }
          case 'get_message_media': {
            const { chatId, messageId, thumb } = payload;
            const media = await bot.adapter.downloadMediaFile(Number(chatId), Number(messageId), Boolean(thumb));
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: media });
            break;
          }
          case 'send_media': {
            const { chatId, mediaType = 'document', fileBase64, fileName = 'file.bin', caption, replyTo } = payload;
            let tempPath: string;
            if (fileBase64) {
              const uploadDir = path.resolve('data', 'cache', 'uploads');
              fs.mkdirSync(uploadDir, { recursive: true });
              tempPath = path.join(uploadDir, `${Date.now()}_${fileName}`);
              const buffer = Buffer.from(fileBase64.replace(/^data:.*?;base64,/, ''), 'base64');
              fs.writeFileSync(tempPath, buffer);
            } else {
              throw new Error('Missing file data');
            }

            const msgId = await bot.adapter.sendMedia(Number(chatId), tempPath, mediaType, {
              caption,
              replyTo: replyTo ? Number(replyTo) : undefined,
              schedule: payload.schedule ? Number(payload.schedule) : undefined,
            });

            // Clean up temporary upload after 10 seconds
            setTimeout(() => {
              try { fs.unlinkSync(tempPath); } catch {}
            }, 10_000);

            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'get_all_stickers': {
            const sets = await bot.adapter.getAllStickerSets();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: sets });
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
          case 'get_saved_gifs': {
            const gifs = await bot.adapter.getSavedGifs();
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: gifs });
            break;
          }
          case 'send_sticker_document': {
            const { chatId, docId, accessHash, fileReference, replyTo } = payload;
            const msgId = await bot.adapter.sendStickerDocument(
              Number(chatId),
              String(docId),
              String(accessHash),
              String(fileReference || ''),
              replyTo ? Number(replyTo) : undefined,
            );
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
            break;
          }
          case 'send_gif_document': {
            const { chatId, docId, accessHash, fileReference, replyTo } = payload;
            const msgId = await bot.adapter.sendGifDocument(
              Number(chatId),
              String(docId),
              String(accessHash),
              String(fileReference || ''),
              replyTo ? Number(replyTo) : undefined,
            );
            sendIPC({ type: 'ACCOUNT_ACTION_RESULT', actionId, success: true, data: { messageId: msgId } });
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

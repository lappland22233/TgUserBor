import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { TelegramClient, Api } from 'telegram';
import { strippedPhotoToJpg } from 'telegram/Utils';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { DeletedMessage } from 'telegram/events/DeletedMessage';
import { CallbackQuery as TelegramCallbackQuery } from 'telegram/events/CallbackQuery';
import type { Logger } from '../logger';
import type { BotConfig } from '../config';
import type {
  BotAdapter,
  IncomingMessage,
  SendOptions,
  MediaOptions,
  UserRef,
  ChatRef,
  ChatType,
  AdapterEventMap,
  ParticipantInfo,
  AdminPermissions,
  DialogInfo,
  MediaAttachment,
  MediaType,
  GetMessagesOptions,
  StickerSetInfo,
  StickerPackSummary,
  StickerItem,
  SavedGifItem,
  UserPhotoEntry,
  StoryEntry,
  PeerProfileDetails,
} from '../adapter';
import { EventBus } from '../core/event-bus';

function mapChatType(t: string): ChatType {
  switch (t) {
    case 'Chat':
    case 'ChatForbidden':
      return 'group';
    case 'Channel':
    case 'ChannelForbidden':
      return 'channel';
    case 'User':
      return 'private';
    default:
      return 'unknown';
  }
}

function userFromEntity(u?: Api.User | Api.UserFull | null): UserRef | undefined {
  if (!u) return undefined;
  const id = (u as any).id;
  if (!id) return undefined;
  return {
    id: Number(id.toString ? id.toString() : id),
    username: (u as any).username ?? undefined,
    firstName: (u as any).firstName ?? undefined,
    lastName: (u as any).lastName ?? undefined,
    isBot: Boolean((u as any).bot),
    phone: (u as any).phone ?? undefined,
  };
}

function formatDialogMessageSnippet(msg: any): string {
  if (!msg) return '';
  if (msg.message && typeof msg.message === 'string' && msg.message.trim()) {
    return msg.message.trim().replace(/\n+/g, ' ').slice(0, 100);
  }
  if (msg.photo) return '[图片]';
  if (msg.video) return '[视频]';
  if (msg.document) {
    const doc = msg.document as any;
    const attrs = doc.attributes || [];
    for (const a of attrs) {
      if (a.className === 'DocumentAttributeAudio') return a.voice ? '[语音]' : '[音乐]';
      if (a.className === 'DocumentAttributeSticker') return '[贴纸]';
      if (a.className === 'DocumentAttributeAnimated') return '[动图]';
      if (a.className === 'DocumentAttributeFilename' && a.fileName) return `[文件] ${a.fileName}`;
    }
    return '[文件]';
  }
  if (msg.action) return '[系统通知]';
  return '';
}

function chatFromEntity(c: Api.Chat | Api.Channel | Api.User): ChatRef {
  if (c instanceof Api.User || (c as any).className === 'User') {
    return {
      id: Number((c as any).id.toString()),
      type: 'private',
      username: (c as any).username ?? undefined,
      firstName: (c as any).firstName,
    } as ChatRef;
  }
  const rawId = (c as any).id.toString();
  const isChannel = c instanceof Api.Channel || (c as any).className === 'Channel';
  // Supergroups and Broadcast Channels in Telegram have -100 prefix
  // Dialog IDs use Telegram's marked peer IDs for both channels and basic groups.
  // Keeping basic groups positive makes live events impossible to match to dialogs.
  const id = isChannel && !rawId.startsWith('-100')
    ? Number(`-100${rawId}`)
    : !isChannel && !rawId.startsWith('-') ? -Number(rawId) : Number(rawId);
  const type: ChatType = c instanceof Api.Chat ? mapChatType(c.className) : 'supergroup';
  return {
    id,
    type: isChannel ? ((c as any).broadcast ? 'channel' : 'supergroup') : type,
    title: (c as any).title ?? undefined,
    username: (c as any).username ?? undefined,
    membersCount: (c as any).participantsCount ?? undefined,
  } as ChatRef;
}

function extractMediaAttachment(msg: Api.Message): MediaAttachment | undefined {
  // Webpage link preview
  const msgMedia = (msg as any).media;
  if (msgMedia && msgMedia.className === 'MessageMediaWebPage') {
    const wp = msgMedia.webpage;
    return {
      type: 'webpage',
      webTitle: wp?.title || undefined,
      webDescription: wp?.description || undefined,
      webUrl: wp?.url || undefined,
      webSiteName: wp?.siteName || undefined,
      webPhotoThumb: Boolean(wp?.photo),
    };
  }

  if (msg.photo) {
    return {
      type: 'photo',
      fileId: (msg.photo as any).id?.toString(),
    };
  }

  if (msg.poll || (msg as any).media?.poll) {
    const p = (msg as any).poll || (msg as any).media?.poll;
    const results = (msg as any).media?.results;
    const totalVoters = results?.totalVoters || 0;
    const options = (p.answers || []).map((a: any, idx: number) => {
      const res = results?.results?.find((r: any) => {
        if (!r.option) return false;
        if (typeof r.option.equals === 'function' && a.option) return r.option.equals(a.option);
        return String(r.option) === String(a.option);
      });
      const voters = res?.voters || 0;
      const chosen = Boolean(res?.chosen);
      const correct = Boolean(res?.correct);
      const pct = totalVoters > 0 ? Math.round((voters / totalVoters) * 100) : 0;
      return {
        text: a.text?.text || a.text || `选项 ${idx + 1}`,
        optionIndex: idx,
        voters,
        chosen,
        correct,
        pct,
      };
    });

    return {
      type: 'poll',
      pollId: p.id?.toString(),
      question: p.question?.text || p.question || '投票',
      options,
      totalVoters,
      closed: Boolean(p.closed),
      publicVoters: Boolean(p.publicVoters),
      multipleChoice: Boolean(p.multipleChoice),
      isQuiz: Boolean(p.quiz),
    };
  }

  // 1. Sticker Check (Must precede generic video/document because video stickers also contain DocumentAttributeVideo)
  const docObj = (msg.document || (msg as any).media?.document) as any;
  if (docObj && Array.isArray(docObj.attributes)) {
    const stickerAttr = docObj.attributes.find((a: any) => a.className === 'DocumentAttributeSticker');
    if (stickerAttr) {
      const mime = (docObj.mimeType || '').toLowerCase();
      const hasVideoAttr = docObj.attributes.some((a: any) => a.className === 'DocumentAttributeVideo');
      const isVideoSticker = mime === 'video/webm' || mime.startsWith('video/') || hasVideoAttr;
      const isAnimatedSticker = mime === 'application/x-tgsticker';

      return {
        type: 'sticker',
        fileId: docObj.id?.toString(),
        fileSize: Number(docObj.size || 0),
        mimeType: docObj.mimeType || (isVideoSticker ? 'video/webm' : 'image/webp'),
        isVideoSticker,
        isAnimatedSticker,
        stickerEmoji: stickerAttr.alt || undefined,
        stickerSetId: stickerAttr.stickerset?.id ? String(stickerAttr.stickerset.id) : undefined,
        stickerAccessHash: stickerAttr.stickerset?.accessHash ? String(stickerAttr.stickerset.accessHash) : undefined,
        stickerShortName: stickerAttr.stickerset?.shortName || undefined,
      };
    }

    const isAnimated = docObj.attributes.some((a: any) => a.className === 'DocumentAttributeAnimated');
    if (isAnimated) {
      return {
        type: 'animation',
        fileId: docObj.id?.toString(),
        fileSize: Number(docObj.size || 0),
        mimeType: docObj.mimeType || 'video/mp4',
      };
    }
  }

  if (msg.video) {
    const v = msg.video as any;
    return {
      type: 'video',
      fileId: v.id?.toString(),
      duration: v.duration,
      width: v.w,
      height: v.h,
      mimeType: v.mimeType,
    };
  }

  if (msg.document) {
    const doc = msg.document as any;
    const mime = (doc.mimeType || '').toLowerCase();
    let type: MediaType = 'document';
    let fileName: string | undefined;
    let stickerSetId: string | undefined;
    let stickerAccessHash: string | undefined;
    let stickerShortName: string | undefined;
    let waveform: number[] | undefined;

    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.className === 'DocumentAttributeFilename') {
          fileName = attr.fileName;
        } else if (attr.className === 'DocumentAttributeAudio') {
          type = attr.voice ? 'voice' : 'audio';
          // Extract waveform data (5-bit, 0-31)
          if (attr.waveform) {
            try {
              const wf = attr.waveform;
              const buf = Buffer.isBuffer(wf) ? wf : Buffer.from(wf);
              waveform = Array.from(buf);
            } catch { /* waveform not critical */ }
          }
        }
      }
    }

    if (type === 'document') {
      if (mime.startsWith('image/')) type = 'photo';
      else if (mime.startsWith('video/')) type = 'video';
      else if (mime.startsWith('audio/')) type = 'audio';
    }

    return {
      type,
      fileId: doc.id?.toString(),
      fileSize: Number(doc.size || 0),
      fileName,
      mimeType: doc.mimeType,
      stickerSetId,
      stickerAccessHash,
      stickerShortName,
      waveform,
    };
  }

  return undefined;
}

export interface AuthPromptHandler {
  askPhone: () => Promise<string>;
  askCode: () => Promise<string>;
  askPassword: () => Promise<string>;
  onError?: (err: Error) => void;
}

export class TelegramDriver implements BotAdapter {
  private readonly bus = new EventBus();
  private client!: TelegramClient;
  private selfId: number | undefined;
  private selfUser: UserRef | undefined;
  private started = false;
  private keepaliveTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly authHandler?: AuthPromptHandler,
  ) {}

  async start(): Promise<void> {
    const session = this.loadSession();

    let proxy: any = undefined;
    if (this.config.telegram.proxy) {
      const p = this.config.telegram.proxy;
      if (p.type === 'socks5') {
        proxy = {
          ip: p.host,
          port: p.port,
          socksType: 5,
          username: p.username,
          password: p.password,
        };
      } else if (p.type === 'mtproxy') {
        proxy = {
          ip: p.host,
          port: p.port,
          secret: p.secret || '',
          MTProxy: true,
        };
      }
      this.logger.info({ proxyType: p.type, host: p.host, port: p.port }, 'using proxy for connection');
    }

    this.client = new TelegramClient(session, this.config.telegram.apiId, this.config.telegram.apiHash, {
      connectionRetries: 5,
      proxy,
    });

    this.logger.info('正在建立与 Telegram MTProto 服务器的加密通信隧道...');
    const connectWarningTimer = setTimeout(() => {
      this.logger.warn('⚠️ Telegram 网络连接耗时较长 (超过 8 秒)，如长时间卡在此处，请检查服务器海外网络连通性或在实例配置中配置 SOCKS5/MTProxy 代理。');
    }, 8000);

    try {
      await this.client.connect();
    } finally {
      clearTimeout(connectWarningTimer);
    }

    this.started = true;
    this.logger.info('Telegram MTProto 隧道建立成功，正在校验账号登录凭据...');

    if (!(await this.client.isUserAuthorized())) {
      this.logger.warn('当前账号尚未登录授权，正在等待输入手机号验证...');
      await this.interactiveLogin();
    }

    const self = await this.client.getMe();
    this.selfId = Number((self as any).id.toString());
    this.selfUser = {
      id: this.selfId,
      username: (self as any).username ?? undefined,
      firstName: (self as any).firstName ?? undefined,
      lastName: (self as any).lastName ?? undefined,
      isBot: Boolean((self as any).bot),
      phone: (self as any).phone ?? undefined,
    };

    this.bus.emit('ready', {
      self: this.selfUser,
    });

    this.registerEventHandlers();
    this.logger.info({ selfId: this.selfId, username: this.selfUser.username }, 'telegram driver started');

    // MTProto Keepalive & Reconnect Watchdog (每 40 秒探测，防止无感知断开)
    this.keepaliveTimer = setInterval(async () => {
      if (!this.started || !this.client) return;
      try {
        if ((this.client as any).disconnected) {
          this.logger.warn('MTProto keepalive detected disconnected state, triggering reconnect...');
          await this.client.connect();
        } else {
          await this.client.invoke(new Api.Ping({ pingId: BigInt(Date.now()) as any }));
        }
      } catch (err: any) {
        this.logger.debug({ error: err.message }, 'MTProto keepalive ping warning');
      }
    }, 40000);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    try {
      await this.client.disconnect();
    } catch (err) {
      this.logger.warn({ err }, 'error disconnecting telegram client');
    }
    this.bus.emit('disconnected', { reason: 'stopped' });
  }

  private loadSession(): StringSession {
    const sessionPath = this.config.telegram.sessionPath;
    if (fs.existsSync(sessionPath)) {
      const data = fs.readFileSync(sessionPath, 'utf-8').trim();
      if (data) return new StringSession(data);
    }
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    return new StringSession('');
  }

  private saveSession(): void {
    const sessionPath = this.config.telegram.sessionPath;
    const sessionStr = (this.client.session as StringSession).save() ?? '';
    if (sessionStr) fs.writeFileSync(sessionPath, sessionStr, { encoding: 'utf-8' });
  }

  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  private async interactiveLogin(): Promise<void> {
    if (this.authHandler) {
      await this.client.start({
        phoneNumber: async () => this.authHandler!.askPhone(),
        password: async () => this.authHandler!.askPassword(),
        phoneCode: async () => this.authHandler!.askCode(),
        onError: (err) => {
          this.logger.error({ err }, 'login error');
          this.authHandler?.onError?.(err as Error);
        },
      });
      this.saveSession();
      return;
    }

    const phone = await this.prompt('Phone number (international format, e.g. +8613800138000): ');
    await this.client.start({
      phoneNumber: async () => phone,
      password: async () => this.prompt('2FA password (empty if none): '),
      phoneCode: async () => this.prompt('Login code from Telegram: '),
      onError: (err) => this.logger.error({ err }, 'login error'),
    });
    this.saveSession();
  }

  private registerEventHandlers(): void {
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        const msg = event.message;
        if (!msg) return;
        const mapped = await this.mapMessage(msg);
        if (mapped) this.bus.emit('message', mapped);

        // Check for participant joined action in service messages
        if (msg.action && (msg.action.className === 'MessageActionChatAddUser' || (msg.action as any).users)) {
          const chat = (await msg.getChat()) ?? (await msg.getSender());
          if (chat) {
            const chatRef = chatFromEntity(chat as any);
            const inviter = userFromEntity((await msg.getSender()) as any);
            const users = (msg.action as any).users ?? [];
            for (const uid of users) {
              const userRef = await this.getUser(Number(uid.toString()));
              if (userRef) {
                this.bus.emit('chat:participant:joined', {
                  chat: chatRef,
                  participant: { user: userRef, inviter },
                });
              }
            }
          }
        }
      } catch (err) {
        this.bus.emit('error', { error: err as Error, context: 'NewMessage' });
      }
    }, new NewMessage({}));

    this.client.addEventHandler(async (event: EditedMessageEvent) => {
      try {
        const msg = event.message;
        if (!msg) return;
        const mapped = await this.mapMessage(msg);
        if (mapped) this.bus.emit('message:edited', mapped);
      } catch (err) {
        this.bus.emit('error', { error: err as Error, context: 'EditedMessage' });
      }
    }, new EditedMessage({}));

    // Message deleted event
    this.client.addEventHandler(async (event: any) => {
      try {
        const deletedIds = event.deletedIds || [];
        const chatId = event.chatId ? Number(event.chatId.toString()) : 0;
        if (deletedIds.length > 0) {
          this.bus.emit('message:deleted', {
            chatId,
            messageIds: deletedIds.map((id: any) => Number(id.toString())),
          });
        }
      } catch (err) {
        this.bus.emit('error', { error: err as Error, context: 'DeletedMessage' });
      }
    }, new DeletedMessage({}));

    // Callback query event
    this.client.addEventHandler(async (event: any) => {
      try {
        const query = event.query;
        if (!query) return;
        const fromUser = userFromEntity(await event.getSender());
        const chat = await event.getChat();
        if (fromUser) {
          this.bus.emit('callback:query', {
            id: query.id ? query.id.toString() : '',
            from: fromUser,
            chat: chat ? chatFromEntity(chat) : undefined,
            messageId: query.msgId,
            data: query.data ? Buffer.from(query.data).toString('utf-8') : undefined,
          });
        }
      } catch (err) {
        this.bus.emit('error', { error: err as Error, context: 'CallbackQuery' });
      }
    }, new TelegramCallbackQuery({}));

    // Typing indicator event
    this.client.addEventHandler(async (update: any) => {
      try {
        if (update && (update.className === 'UpdateUserTyping' || update.className === 'UpdateChatUserTyping')) {
          const userId = update.userId ? update.userId.toString() : '';
          const chatId = update.chatId ? update.chatId.toString() : userId;
          if (chatId) {
            this.bus.emit('chat:typing', {
              chatId: Number(chatId),
              userId: Number(userId),
              action: update.action?.className || 'SendMessageTypingAction',
            });
          }
        }
      } catch (_) {}
    });
  }

  private async mapMessage(msg: Api.Message): Promise<IncomingMessage | undefined> {
    const chatEntity = (await msg.getChat()) ?? (await msg.getSender());
    if (!chatEntity) return undefined;

    const isOut = Boolean((msg as any).out ?? (msg as any).outgoing);
    let fromUser: UserRef | undefined;
    if (isOut && this.selfUser) {
      fromUser = this.selfUser;
    } else {
      const sender = await msg.getSender();
      fromUser = userFromEntity(sender as any);
    }
    if (!fromUser && this.selfUser) {
      fromUser = this.selfUser;
    }
    if (!fromUser) return undefined;

    const chatRef = chatFromEntity(chatEntity as any);
    const text = msg.message ?? '';
    const mentionedBot = this.selfUser?.username
      ? Boolean(msg.message?.includes(`@${this.selfUser.username}`))
      : false;

    // Service message mapping
    let service: IncomingMessage['service'] | undefined;
    const action = (msg as any).action;
    if (action) {
      service = this.mapServiceAction(action, fromUser);
    }

    const media = service ? undefined : extractMediaAttachment(msg);

    // Reactions
    let reactions: any[] | undefined = undefined;
    if ((msg as any).reactions && Array.isArray((msg as any).reactions.results)) {
      reactions = (msg as any).reactions.results.map((r: any) => {
        let emoji = '❤️';
        if (r.reaction && r.reaction.emoticon) {
          emoji = r.reaction.emoticon;
        } else if (r.reaction && r.reaction.documentId) {
          emoji = '✨';
        }
        return {
          emoji,
          count: Number(r.count || 1),
          chosen: Boolean(r.chosenOrder !== undefined || r.chosen),
        };
      });
    }

    // Forward origin
    let fwdFrom: any | undefined = undefined;
    if ((msg as any).fwdFrom) {
      const fwd = (msg as any).fwdFrom;
      fwdFrom = {
        fromName: fwd.fromName || undefined,
        fromId: fwd.fromId?.userId ? Number(fwd.fromId.userId.toString()) : undefined,
        channelId: fwd.fromId?.channelId ? Number(`-100${fwd.fromId.channelId.toString()}`) : undefined,
        postAuthor: fwd.postAuthor || undefined,
        date: fwd.date ? fwd.date * 1000 : undefined,
      };
    }

    // Read status for outgoing messages
    const read = isOut ? undefined : undefined; // Will be set by caller based on readOutboxMaxId

    return {
      id: msg.id,
      text: service ? (service.text || text) : text,
      raw: msg.message,
      entities: (msg.entities ?? []).map((e: any) => ({
        type: String(e.className),
        offset: e.offset,
        length: e.length,
        url: e.url || undefined,
        userId: e.userId ? Number(e.userId) : undefined,
      })),
      date: msg.date * 1000,
      from: fromUser,
      chat: chatRef,
      outgoing: isOut,
      isReply: Boolean(msg.replyTo),
      replyToMessageId: msg.replyTo?.replyToMsgId,
      mentionedBot,
      media,
      reactions,
      fwdFrom,
      views: (msg as any).views ? Number((msg as any).views) : undefined,
      forwards: (msg as any).forwards ? Number((msg as any).forwards) : undefined,
      service,
      groupedId: (msg as any).groupedId?.toString(),
      replies: (msg as any).replies?.replies ? Number((msg as any).replies.replies) : undefined,
    };
  }

  private mapServiceAction(action: any, fromUser: UserRef): IncomingMessage['service'] {
    const cls = action.className || '';
    switch (cls) {
      case 'MessageActionChatAddUser':
        return { type: 'joined', text: `${fromUser.firstName || '用户'} 加入了群组` };
      case 'MessageActionChatDeleteUser':
        return { type: 'left', text: `${fromUser.firstName || '用户'} 退出了群组` };
      case 'MessageActionChatEditTitle':
        return { type: 'title_changed', text: `群组名称已更改为 "${action.title || ''}"` };
      case 'MessageActionChatEditPhoto':
        return { type: 'photo_changed', text: `${fromUser.firstName || '用户'} 更换了群组头像` };
      case 'MessageActionChatDeletePhoto':
        return { type: 'photo_changed', text: `${fromUser.firstName || '用户'} 删除了群组头像` };
      case 'MessageActionChatCreate':
        return { type: 'created', text: `${fromUser.firstName || '用户'} 创建了群组 "${action.title || ''}"` };
      case 'MessageActionPinMessage':
        return { type: 'pinned', text: `${fromUser.firstName || '用户'} 置顶了一条消息` };
      case 'MessageActionHistoryClear':
        return { type: 'cleared', text: '聊天记录已清空' };
      case 'MessageActionPhoneCall':
        return { type: 'call', text: action.duration ? `通话时长 ${action.duration} 秒` : '未接来电' };
      default:
        return { type: 'service', text: `[系统消息]` };
    }
  }

  private resolvePeer(chatId: number | string): any {
    if (this.selfId && (chatId === this.selfId || String(chatId) === String(this.selfId))) {
      return 'me';
    }
    const str = String(chatId).trim();
    if (str === 'me') return 'me';
    try {
      return BigInt(str);
    } catch {
      return str;
    }
  }

  async sendMessage(chatId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    let parseMode: any = options?.parseMode;
    let messageText = text;

    if (parseMode === 'markdown' || parseMode === 'md') {
      messageText = messageText
        .replace(/\*\*(.*?)\*\*/g, '*$1*')
        .replace(/~~(.*?)~~/g, '~$1~');
      parseMode = 'md2';
    }

    try {
      const sent = await this.client.sendMessage(peer, {
        message: messageText,
        parseMode: parseMode ?? undefined,
        silent: options?.silent,
        replyTo: options?.replyTo,
        schedule: options?.schedule,
      });
      const id = (sent as any)?.id;
      if (id && options?.autoDeleteMs && options.autoDeleteMs > 0) {
        setTimeout(() => {
          this.deleteMessage(chatId, id).catch(() => {});
        }, options.autoDeleteMs);
      }
      return id;
    } catch (err: any) {
      if (parseMode) {
        this.logger.warn({ chatId, error: err.message }, 'Markdown/HTML parse failed, falling back to plain text');
        const fallbackSent = await this.client.sendMessage(peer, {
          message: text,
          silent: options?.silent,
          replyTo: options?.replyTo,
          schedule: options?.schedule,
        });
        const id = (fallbackSent as any)?.id;
        if (id && options?.autoDeleteMs && options.autoDeleteMs > 0) {
          setTimeout(() => {
            this.deleteMessage(chatId, id).catch(() => {});
          }, options.autoDeleteMs);
        }
        return id;
      }
      throw err;
    }
  }

  async replyTo(chatId: number, replyToMsgId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    return this.sendMessage(chatId, text, {
      ...options,
      replyTo: replyToMsgId,
    });
  }

  async editMessage(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const res = await this.client.editMessage(peer, {
      message: messageId,
      text,
      parseMode: options?.parseMode ?? undefined,
    });
    const id = (res as any)?.id ?? messageId;
    if (id && options?.autoDeleteMs && options.autoDeleteMs > 0) {
      setTimeout(() => {
        this.deleteMessage(chatId, id).catch(() => {});
      }, options.autoDeleteMs);
    }
    return id;
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.deleteMessages(peer, [messageId], { revoke: true });
  }

  async deleteMessages(chatId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const peer = this.resolvePeer(chatId);
    await this.client.deleteMessages(peer, messageIds, { revoke: true });
  }

  on<E extends keyof AdapterEventMap>(event: E, handler: (payload: AdapterEventMap[E]) => void): () => void {
    const handle = this.bus.on(event, handler);
    return () => handle.off();
  }

  async getUser(id: number): Promise<UserRef | undefined> {
    try {
      if (this.selfId && id === this.selfId && this.selfUser) {
        return this.selfUser;
      }
      const u = await this.client.getEntity(this.resolvePeer(id));
      return userFromEntity(u as any);
    } catch {
      return undefined;
    }
  }

  async getChat(id: number): Promise<ChatRef | undefined> {
    try {
      const c = await this.client.getEntity(this.resolvePeer(id));
      return chatFromEntity(c as any);
    } catch {
      return undefined;
    }
  }

  getSelf(): UserRef | undefined {
    return this.selfUser;
  }

  raw<T = unknown>(): T {
    return this.client as unknown as T;
  }

  // --- 媒体能力实现 ---

  async sendPhoto(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: options?.caption,
      parseMode: options?.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      silent: options?.silent,
      schedule: options?.schedule,
      thumb: options?.thumb as any,
    } as any);
    return (sent as any)?.id;
  }

  async sendVideo(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: options?.caption,
      parseMode: options?.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      silent: options?.silent,
      schedule: options?.schedule,
      thumb: options?.thumb as any,
    } as any);
    return (sent as any)?.id;
  }

  async sendAudio(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: options?.caption,
      parseMode: options?.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      silent: options?.silent,
      schedule: options?.schedule,
    } as any);
    return (sent as any)?.id;
  }

  async sendFile(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: options?.caption,
      parseMode: options?.parseMode,
      forceDocument: options?.forceDocument ?? true,
      replyTo: options?.replyTo,
      silent: options?.silent,
      schedule: options?.schedule,
      thumb: options?.thumb as any,
    } as any);
    return (sent as any)?.id;
  }

  async sendVoice(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: options?.caption,
      parseMode: options?.parseMode,
      voiceNote: true,
      replyTo: options?.replyTo,
      silent: options?.silent,
      schedule: options?.schedule,
    } as any);
    return (sent as any)?.id;
  }

  async sendSticker(chatId: number, file: string | Buffer, options?: SendOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const sent = await this.client.sendFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      replyTo: options?.replyTo,
      silent: options?.silent,
    });
    return (sent as any)?.id;
  }

  async downloadMedia(chatId: number, messageId: number, destPath: string): Promise<string | undefined> {
    const peer = this.resolvePeer(chatId);
    const msgs = await this.client.getMessages(peer, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || !msg.media) return undefined;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await this.client.downloadMedia(msg.media, { outputFile: destPath });
    return destPath;
  }

  async downloadProfilePhoto(chatId: number, options?: { isBig?: boolean; outputFile?: string }): Promise<string | undefined> {
    const peer = this.resolvePeer(chatId);
    const isBig = Boolean(options?.isBig);
    const cacheDir = path.resolve('data', 'cache', 'avatars');
    fs.mkdirSync(cacheDir, { recursive: true });
    const destPath = options?.outputFile || path.join(cacheDir, `${chatId}${isBig ? '_big' : ''}.jpg`);

    if (fs.existsSync(destPath)) {
      const stat = fs.statSync(destPath);
      if (Date.now() - stat.mtimeMs < 86400000 && stat.size > 0) {
        return destPath;
      }
    }

    try {
      let targetEntity: any = peer;
      try {
        const ent = await this.client.getEntity(peer as any);
        if (ent) targetEntity = ent;
      } catch {
        try {
          const ent = await this.client.getEntity(`-100${chatId}` as any);
          if (ent) targetEntity = ent;
        } catch {
          /* fallback to peer */
        }
      }

      const res = await this.client.downloadProfilePhoto(targetEntity, {
        isBig,
        outputFile: destPath,
      });
      if (res && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return destPath;
      }
    } catch (err: any) {
      this.logger.debug({ chatId, error: err.message }, 'Failed to download profile photo');
    }
    return undefined;
  }

  async getUserPhotos(userId: number, limit = 10): Promise<UserPhotoEntry[]> {
    const peer = this.resolvePeer(userId);
    try {
      let targetEntity: any = peer;
      try {
        const ent = await this.client.getEntity(peer as any);
        if (ent) targetEntity = ent;
      } catch {
        /* fallback to peer */
      }

      const result = await this.client.invoke(
        new Api.photos.GetUserPhotos({
          userId: targetEntity,
          offset: 0,
          maxId: 0 as any,
          limit: Math.min(limit, 20),
        })
      );
      const photos = (result as any)?.photos || [];
      const list: UserPhotoEntry[] = [];
      for (const p of photos) {
        if (p instanceof Api.Photo) {
          list.push({
            id: p.id.toString(),
            date: p.date,
          });
        }
      }
      return list;
    } catch (err: any) {
      this.logger.debug({ userId, error: err.message }, 'Failed to get user photos');
      return [];
    }
  }

  async downloadUserPhoto(userId: number, photoIndex: number, outputFile: string): Promise<string | undefined> {
    const peer = this.resolvePeer(userId);
    try {
      let targetEntity: any = peer;
      try {
        const ent = await this.client.getEntity(peer as any);
        if (ent) targetEntity = ent;
      } catch {
        /* fallback to peer */
      }

      const result = await this.client.invoke(
        new Api.photos.GetUserPhotos({
          userId: targetEntity,
          offset: 0,
          maxId: 0 as any,
          limit: 20,
        })
      );
      const photos = (result as any)?.photos || [];
      const photo = photos[photoIndex];
      if (!photo) return undefined;
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      await this.client.downloadMedia(photo, { outputFile });
      return outputFile;
    } catch (err: any) {
      this.logger.debug({ userId, photoIndex, error: err.message }, 'Failed to download user photo');
      return undefined;
    }
  }

  async getPeerProfile(chatId: number): Promise<PeerProfileDetails> {
    const peer = this.resolvePeer(chatId);
    let title = `Chat #${chatId}`;
    let username: string | undefined;
    let phone: string | undefined;
    let bio: string | undefined;
    let type: ChatType = 'unknown';
    let memberCount: number | undefined;
    let commonChatsCount: number | undefined;
    let isVerified = false;
    let isPremium = false;
    let isBot = false;
    let hasPhoto = false;
    let photosCount = 0;
    let pinnedMsgId: number | undefined;
    let stories: StoryEntry[] = [];

    try {
      const entity: any = await this.client.getEntity(peer);
      if (entity) {
        if (entity.className === 'User') {
          type = 'private';
          title = `${entity.firstName || ''} ${entity.lastName || ''}`.trim() || entity.username || `User #${chatId}`;
          username = entity.username;
          phone = entity.phone;
          isVerified = Boolean(entity.verified);
          isPremium = Boolean(entity.premium);
          isBot = Boolean(entity.bot);
          hasPhoto = Boolean(entity.photo);

          try {
            const fullUser = (await this.client.invoke(new Api.users.GetFullUser({ id: peer }))) as any;
            const full = fullUser?.fullUser;
            if (full) {
              bio = full.about;
              commonChatsCount = full.commonChatsCount;
              pinnedMsgId = full.pinnedMsgId;
            }
          } catch {}

          try {
            const photos = await this.getUserPhotos(chatId, 10);
            photosCount = photos.length;
          } catch {}

          try {
            stories = await this.getPeerStories(chatId);
          } catch {}
        } else if (entity.className === 'Channel' || entity.className === 'Chat') {
          type = entity.broadcast ? 'channel' : 'group';
          title = entity.title || `Chat #${chatId}`;
          username = entity.username;
          isVerified = Boolean(entity.verified);
          hasPhoto = Boolean(entity.photo);

          try {
            const fullChat = (await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }))) as any;
            const full = fullChat?.fullChat;
            if (full) {
              bio = full.about;
              memberCount = full.participantsCount;
              pinnedMsgId = full.pinnedMsgId;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      this.logger.debug({ chatId, error: err.message }, 'Failed to get peer profile details');
    }

    return {
      id: chatId,
      title,
      username,
      phone,
      bio,
      type,
      memberCount,
      commonChatsCount,
      isVerified,
      isPremium,
      isBot,
      hasPhoto,
      photosCount,
      pinnedMsgId,
      stories,
    };
  }

  async getPeerStories(chatId: number): Promise<StoryEntry[]> {
    const peer = this.resolvePeer(chatId);
    try {
      const res = (await this.client.invoke(new Api.stories.GetPeerStories({ peer }))) as any;
      const stories = res?.stories?.stories || [];
      const list: StoryEntry[] = [];
      for (const s of stories) {
        if (s instanceof Api.StoryItem) {
          let mediaType = 'unknown';
          if (s.media instanceof Api.MessageMediaPhoto) mediaType = 'photo';
          else if (s.media instanceof Api.MessageMediaDocument) mediaType = 'video';
          list.push({
            id: s.id,
            date: s.date,
            expireDate: s.expireDate,
            caption: s.caption,
            isPinned: Boolean(s.pinned),
            mediaType,
          });
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  async getChatMedia(chatId: number, filterType: 'music' | 'photos' | 'videos' | 'files', limit = 50): Promise<IncomingMessage[]> {
    const peer = this.resolvePeer(chatId);
    let filter: any;
    if (filterType === 'music') filter = new Api.InputMessagesFilterMusic();
    else if (filterType === 'photos') filter = new Api.InputMessagesFilterPhotos();
    else if (filterType === 'videos') filter = new Api.InputMessagesFilterVideo();
    else if (filterType === 'files') filter = new Api.InputMessagesFilterDocument();

    const msgs = await this.client.getMessages(peer, {
      filter,
      limit: Math.min(limit, 100),
    });

    const list: IncomingMessage[] = [];
    for (const m of msgs) {
      if (m && m instanceof Api.Message) {
        const mapped = await this.mapMessage(m);
        if (mapped) list.push(mapped);
      }
    }
    return list;
  }

  async downloadMediaFile(chatId: number, messageId: number, thumb = false, destPath?: string): Promise<{ filePath: string; mimeType: string; fileName?: string } | undefined> {
    const peer = this.resolvePeer(chatId);
    const msgs = await this.client.getMessages(peer, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || !msg.media) return undefined;

    const mediaInfo = extractMediaAttachment(msg);
    let ext = 'bin';
    let mime = mediaInfo?.mimeType || 'application/octet-stream';
    let fileName = mediaInfo?.fileName;

    if (mediaInfo?.type === 'photo') {
      ext = 'jpg';
      mime = 'image/jpeg';
    } else if (mediaInfo?.type === 'video' || mediaInfo?.type === 'animation') {
      ext = 'mp4';
      mime = 'video/mp4';
    } else if (mediaInfo?.type === 'sticker') {
      if (mediaInfo.isVideoSticker || (mediaInfo.mimeType && mediaInfo.mimeType.includes('webm'))) {
        ext = 'webm';
        mime = 'video/webm';
      } else if (mediaInfo.isAnimatedSticker || (mediaInfo.mimeType && mediaInfo.mimeType.includes('tgsticker'))) {
        ext = 'tgs';
        mime = 'application/x-tgsticker';
      } else {
        ext = 'webp';
        mime = 'image/webp';
      }
    } else if (mediaInfo?.type === 'audio' || mediaInfo?.type === 'voice') {
      ext = mediaInfo.type === 'voice' ? 'ogg' : 'mp3';
      mime = mediaInfo.type === 'voice' ? 'audio/ogg' : 'audio/mpeg';
    } else if (fileName) {
      const mExt = path.extname(fileName).slice(1);
      if (mExt) ext = mExt;
    }

    if (thumb) {
      mime = 'image/jpeg';
    }

    const targetPath = destPath || path.resolve('data', 'cache', 'media', `${chatId}_${messageId}${thumb ? '_thumb.jpg' : `.${ext}`}`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      return { filePath: targetPath, mimeType: mime, fileName };
    }

    try {
      const downloaded = await this.client.downloadMedia(msg.media, {
        outputFile: targetPath,
        thumb: thumb ? 1 : undefined,
      });
      if (downloaded && fs.existsSync(targetPath)) {
        return { filePath: targetPath, mimeType: mime, fileName };
      }
    } catch (err: any) {
      this.logger.debug({ chatId, messageId, error: err.message }, 'Failed to download message media');
    }
    return undefined;
  }

  async sendMedia(chatId: number, file: string | Buffer, mediaType: 'photo' | 'video' | 'audio' | 'document' | 'voice', options?: MediaOptions): Promise<number | undefined> {
    if (mediaType === 'photo') return this.sendPhoto(chatId, file, options);
    if (mediaType === 'video') return this.sendVideo(chatId, file, options);
    if (mediaType === 'audio') return this.sendAudio(chatId, file, options);
    if (mediaType === 'voice') {
      const peer = this.resolvePeer(chatId);
      const sent = await this.client.sendFile(peer, {
        file,
        voiceNote: true,
        caption: options?.caption,
        replyTo: options?.replyTo,
      });
      return (sent as any)?.id;
    }
    return this.sendFile(chatId, file, options);
  }

  // --- 消息与历史操作 ---

  async forwardMessage(fromChatId: number | string, toChatId: number | string, messageId: number): Promise<number | undefined> {
    const toPeer = this.resolvePeer(toChatId);
    const fromPeer = this.resolvePeer(fromChatId);
    const sent = await this.client.forwardMessages(toPeer, {
      messages: [messageId],
      fromPeer,
    });
    const first = Array.isArray(sent) ? sent[0] : sent;
    return (first as any)?.id;
  }

  async forwardMessages(fromChatId: number | string, toChatId: number | string, messageIds: number[]): Promise<number[]> {
    const toPeer = this.resolvePeer(toChatId);
    const fromPeer = this.resolvePeer(fromChatId);
    const sent = await this.client.forwardMessages(toPeer, {
      messages: messageIds,
      fromPeer,
    });
    const list = Array.isArray(sent) ? sent : [sent];
    return list.map((m: any) => m?.id).filter((id) => typeof id === 'number');
  }

  async pinMessage(chatId: number, messageId: number, silent = false): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.pinMessage(peer, messageId, { notify: !silent });
  }

  async unpinMessage(chatId: number | string, messageId?: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    if (messageId !== undefined) {
      await this.client.unpinMessage(peer, messageId);
    } else {
      await this.client.unpinMessage(peer);
    }
  }

  async getMessages(chatId: number, options?: GetMessagesOptions): Promise<IncomingMessage[]> {
    const peer = this.resolvePeer(chatId);
    const msgs = await this.client.getMessages(peer, {
      limit: options?.limit ?? 20,
      offsetId: options?.offsetId,
      ids: options?.ids,
      search: options?.search,
    });

    const result: IncomingMessage[] = [];
    for (const m of msgs) {
      if (m && m instanceof Api.Message) {
        const mapped = await this.mapMessage(m);
        if (mapped) result.push(mapped);
      }
    }
    return result;
  }

  async searchMessages(chatId: number, query: string, limit = 20): Promise<IncomingMessage[]> {
    return this.getMessages(chatId, { search: query, limit });
  }

  // --- 群组与频道管理 ---

  async banUser(chatId: number, userId: number, untilDate = 0): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await (this.client as any).editPermissions(peer, userPeer, {
      viewMessages: false,
      untilDate,
    });
  }

  async unbanUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await (this.client as any).editPermissions(peer, userPeer, {
      viewMessages: true,
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
      sendGames: true,
      sendInline: true,
      embedLinks: true,
    });
  }

  async kickUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await this.client.kickParticipant(peer, userPeer);
  }

  async muteUser(chatId: number, userId: number, seconds: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    const untilDate = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
    await (this.client as any).editPermissions(peer, userPeer, {
      sendMessages: false,
      untilDate,
    });
  }

  async unmuteUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await (this.client as any).editPermissions(peer, userPeer, {
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
    });
  }

  async promoteUser(chatId: number, userId: number, perms?: AdminPermissions): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await (this.client as any).editAdmin(peer, userPeer, {
      changeInfo: perms?.changeInfo ?? true,
      postMessages: perms?.postMessages ?? true,
      editMessages: perms?.editMessages ?? true,
      deleteMessages: perms?.deleteMessages ?? true,
      banUsers: perms?.banUsers ?? true,
      inviteUsers: perms?.inviteUsers ?? true,
      pinMessages: perms?.pinMessages ?? true,
      addAdmins: perms?.addAdmins ?? false,
      manageCall: perms?.manageCall ?? true,
    });
  }

  async demoteUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await (this.client as any).editAdmin(peer, userPeer, {
      changeInfo: false,
      postMessages: false,
      editMessages: false,
      deleteMessages: false,
      banUsers: false,
      inviteUsers: false,
      pinMessages: false,
      addAdmins: false,
      manageCall: false,
    });
  }

  async getParticipants(chatId: number, limit = 100): Promise<ParticipantInfo[]> {
    const peer = this.resolvePeer(chatId);
    const participants = await this.client.getParticipants(peer, { limit });
    const res: ParticipantInfo[] = [];

    for (const p of participants) {
      const user = userFromEntity(p as any);
      if (!user) continue;

      let role: ParticipantInfo['role'] = 'member';
      const pClass = (p as any).participant?.className || '';
      if (pClass.includes('Creator')) role = 'owner';
      else if (pClass.includes('Admin')) role = 'admin';
      else if (pClass.includes('Banned')) role = 'banned';
      else if (pClass.includes('Left')) role = 'left';

      res.push({
        user,
        role,
      });
    }

    return res;
  }

  async inviteUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    try {
      await this.client.invoke(
        new Api.channels.InviteToChannel({
          channel: peer,
          users: [userPeer],
        }),
      );
    } catch {
      await this.client.invoke(
        new Api.messages.AddChatUser({
          chatId: BigInt(chatId) as any,
          userId: userPeer,
          fwdLimit: 100,
        }),
      );
    }
  }

  async getChatMember(chatId: number, userId: number): Promise<ParticipantInfo | undefined> {
    const participants = await this.getParticipants(chatId, 500);
    return participants.find((p) => p.user.id === userId);
  }

  async leaveChat(chatId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    try {
      await (this.client as any).deleteDialog(peer);
    } catch {
      await this.client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
    }
  }

  async setChatTitle(chatId: number, title: string): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.channels.EditTitle({
        channel: peer,
        title,
      }),
    );
  }

  async setChatDescription(chatId: number, description: string): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.EditChatAbout({
        peer,
        about: description,
      }),
    );
  }

  // --- 对话与联系人 ---

  async getDialogs(limit = 30): Promise<DialogInfo[]> {
    const dialogs = await this.client.getDialogs({ limit });
    const list: DialogInfo[] = [];

    for (const d of dialogs) {
      const entity = d.entity;
      if (!entity) continue;
      const rawId = d.id ? d.id.toString() : (entity as any).id.toString();
      const id = Number(rawId);
      let type: ChatType = 'unknown';
      if (d.isUser) type = 'private';
      else if (d.isGroup) type = 'group';
      else if (d.isChannel) type = 'channel';

      // Format last message preview and sender
      let lastMsgText: string | undefined = undefined;
      let lastSenderName: string | undefined = undefined;
      if (d.message) {
        lastMsgText = formatDialogMessageSnippet(d.message);
        if ((d.message as any).sender) {
          lastSenderName = (d.message as any).sender.firstName || (d.message as any).sender.username;
        }
      }

      list.push({
        id,
        type,
        title: d.title || (entity as any).username || (entity as any).firstName,
        username: (entity as any).username,
        unreadCount: d.unreadCount,
        pinned: d.pinned,
        lastMessageDate: d.date ? d.date * 1000 : undefined,
        lastMessage: lastMsgText,
        lastSender: lastSenderName,
        isChannel: d.isChannel,
        // Extended fields for Telegram-style client
        online: (entity as any).status?.className === 'UserStatusOnline' ? true : undefined,
        lastSeen: (entity as any).status?.wasOnline ? (entity as any).status.wasOnline * 1000 : undefined,
        readInboxMaxId: (d.dialog as any)?.readInboxMaxId ? Number((d.dialog as any).readInboxMaxId) : undefined,
        readOutboxMaxId: (d.dialog as any)?.readOutboxMaxId ? Number((d.dialog as any).readOutboxMaxId) : undefined,
        muted: (d.dialog as any)?.notifySettings?.muteUntil ? (d.dialog as any).notifySettings.muteUntil > Date.now() / 1000 : undefined,
        folderId: (d as any).folderId || 0,
        archived: (d as any).folderId === 1,
      });
    }

    return list;
  }

  async markAsRead(chatId: number, maxId?: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    try {
      await (this.client as any).markAsRead(peer, maxId || 0);
    } catch (err: any) {
      this.logger.debug({ chatId, error: err.message }, 'Failed to mark chat as read');
    }
  }

  async getContacts(): Promise<UserRef[]> {
    const res = await this.client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }));
    const users = (res as any).users || [];
    const list: UserRef[] = [];
    for (const u of users) {
      const ref = userFromEntity(u);
      if (ref) list.push(ref);
    }
    return list;
  }

  // --- 自身与交互 ---

  async setOnline(online: boolean): Promise<void> {
    await this.client.invoke(new Api.account.UpdateStatus({ offline: !online }));
  }

  async sendTyping(chatId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.SetTyping({
        peer,
        action: new Api.SendMessageTypingAction(),
      }),
    );
  }

  async updateProfile(opts: { firstName?: string; lastName?: string; bio?: string }): Promise<void> {
    await this.client.invoke(
      new Api.account.UpdateProfile({
        firstName: opts.firstName,
        lastName: opts.lastName,
        about: opts.bio,
      }),
    );
  }

  async updateProfilePhoto(file: string | Buffer): Promise<void> {
    const uploaded = await (this.client as any).uploadFile({
      file: typeof file === 'string' ? file : Buffer.from(file),
      workers: 1,
    });
    await this.client.invoke(
      new Api.photos.UploadProfilePhoto({
        file: uploaded,
      }),
    );
  }

  async reactToMessage(chatId: number, messageId: number, emoji?: string): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer,
        msgId: messageId,
        reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
      }),
    );
  }

  async sendPoll(
    chatId: number,
    question: string,
    options: string[],
    pollOptions?: {
      isAnonymous?: boolean;
      isMultipleChoice?: boolean;
      isQuiz?: boolean;
      correctOptionIndex?: number;
      explanation?: string;
    },
  ): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const answers = options.map((opt, idx) => new Api.PollAnswer({
      text: new Api.TextWithEntities({ text: opt, entities: [] }),
      option: Buffer.from([idx]),
    }));

    const isQuiz = Boolean(pollOptions?.isQuiz);
    const correctAnswers = isQuiz && pollOptions?.correctOptionIndex !== undefined
      ? [Buffer.from([pollOptions.correctOptionIndex])]
      : undefined;

    const res = await this.client.invoke(
      new Api.messages.SendMedia({
        peer,
        media: new Api.InputMediaPoll({
          poll: new Api.Poll({
            id: BigInt(Date.now()) as any,
            question: new Api.TextWithEntities({ text: question, entities: [] }),
            answers,
            closed: false,
            publicVoters: pollOptions?.isAnonymous === false,
            multipleChoice: Boolean(pollOptions?.isMultipleChoice),
            quiz: isQuiz,
          }),
          correctAnswers,
          solution: pollOptions?.explanation,
        }),
        message: '',
      }),
    );
    return (res as any)?.updates?.find((u: any) => u.id)?.id;
  }

  async sendVote(chatId: number, messageId: number, optionIndexes: number[]): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.SendVote({
        peer,
        msgId: messageId,
        options: optionIndexes.map((idx) => Buffer.from([idx])),
      }),
    );
  }

  async setChatMute(chatId: number, muteUntilSeconds: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: muteUntilSeconds,
        }),
      }),
    );
  }

  async getStickerSet(shortName: string): Promise<StickerSetInfo | undefined> {
    try {
      const res: any = await this.client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName }),
          hash: 0,
        }),
      );

      const set = res.set;
      const documents = res.documents || [];
      return {
        id: set.id.toString(),
        title: set.title,
        shortName: set.shortName,
        count: set.count,
        stickers: documents.map((d: any) => ({
          id: d.id.toString(),
          mimeType: d.mimeType,
        })),
      };
    } catch {
      return undefined;
    }
  }

  async getAllStickerSets(): Promise<StickerPackSummary[]> {
    try {
      const res: any = await this.client.invoke(
        new Api.messages.GetAllStickers({
          hash: BigInt(0) as any,
        })
      );
      const sets = res.sets || [];
      return sets.map((s: any) => ({
        id: s.id.toString(),
        accessHash: s.accessHash.toString(),
        title: s.title,
        shortName: s.shortName,
        count: s.count,
        thumbDocumentId: s.thumbDocumentId ? s.thumbDocumentId.toString() : undefined,
        isAnimated: Boolean(s.animated),
        isVideo: Boolean(s.video),
      }));
    } catch (err: any) {
      this.logger.debug({ error: err.message }, 'Failed to get all sticker sets');
      return [];
    }
  }

  async getStickerSetDetails(setId?: string, accessHash?: string, shortName?: string): Promise<{ set: StickerPackSummary; stickers: StickerItem[] } | undefined> {
    try {
      let stickerset: any;
      if (setId && accessHash) {
        stickerset = new Api.InputStickerSetID({
          id: BigInt(setId) as any,
          accessHash: BigInt(accessHash) as any,
        });
      } else if (shortName) {
        stickerset = new Api.InputStickerSetShortName({ shortName });
      } else {
        return undefined;
      }

      const res: any = await this.client.invoke(
        new Api.messages.GetStickerSet({
          stickerset,
          hash: 0,
        })
      );
      const set = res.set;
      const documents = res.documents || [];
      return {
        set: {
          id: set.id.toString(),
          accessHash: set.accessHash.toString(),
          title: set.title,
          shortName: set.shortName,
          count: set.count,
          isAnimated: Boolean(set.animated),
          isVideo: Boolean(set.video),
          isInstalled: Boolean(set.installed || !set.archived),
        },
        stickers: documents.map((d: any) => {
          let emoji = '✨';
          if (Array.isArray(d.attributes)) {
            const attr = d.attributes.find((a: any) => a.className === 'DocumentAttributeSticker');
            if (attr?.alt) emoji = attr.alt;
          }

          let thumbDataUri: string | undefined = undefined;
          if (Array.isArray(d.thumbs)) {
            const stripped = d.thumbs.find((t: any) => t.className === 'PhotoStrippedSize');
            if (stripped && stripped.bytes) {
              try {
                const jpgBuf = strippedPhotoToJpg(stripped.bytes);
                if (jpgBuf && jpgBuf.length > 0) {
                  thumbDataUri = `data:image/jpeg;base64,${Buffer.from(jpgBuf).toString('base64')}`;
                }
              } catch {
                /* fallback to network */
              }
            }
          }

          return {
            id: d.id.toString(),
            accessHash: d.accessHash.toString(),
            fileReference: d.fileReference ? Buffer.from(d.fileReference).toString('base64') : '',
            mimeType: d.mimeType || 'image/webp',
            emoji,
            thumbDataUri,
          };
        }),
      };
    } catch (err: any) {
      this.logger.debug({ setId, error: err.message }, 'Failed to get sticker set details');
      return undefined;
    }
  }

  async installStickerSet(setId: string, accessHash: string): Promise<boolean> {
    try {
      const res = await this.client.invoke(
        new Api.messages.InstallStickerSet({
          stickerset: new Api.InputStickerSetID({
            id: BigInt(setId) as any,
            accessHash: BigInt(accessHash) as any,
          }),
          archived: false as any,
        })
      );
      return Boolean(res);
    } catch (err: any) {
      this.logger.error({ setId, error: err.message }, 'Failed to install sticker set');
      throw err;
    }
  }

  async uninstallStickerSet(setId: string, accessHash: string): Promise<boolean> {
    try {
      const res = await this.client.invoke(
        new Api.messages.UninstallStickerSet({
          stickerset: new Api.InputStickerSetID({
            id: BigInt(setId) as any,
            accessHash: BigInt(accessHash) as any,
          }),
        })
      );
      return Boolean(res);
    } catch (err: any) {
      this.logger.error({ setId, error: err.message }, 'Failed to uninstall sticker set');
      throw err;
    }
  }

  async downloadStickerThumb(docId: string, accessHash: string, fileRefBase64: string): Promise<string | undefined> {
    const destPath = path.resolve('data', 'cache', 'stickers', `${docId}.webp`);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      return destPath;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    try {
      const location = new Api.InputDocumentFileLocation({
        id: BigInt(docId) as any,
        accessHash: BigInt(accessHash) as any,
        fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0),
        thumbSize: '',
      });
      await this.client.downloadFile(location as any, {
        outputFile: destPath,
      });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return destPath;
      }
    } catch (err: any) {
      this.logger.warn({ docId, error: err.message }, 'Failed to download sticker thumb');
    }
    return undefined;
  }

  async getSavedGifs(): Promise<SavedGifItem[]> {
    try {
      const res: any = await this.client.invoke(
        new Api.messages.GetSavedGifs({
          hash: BigInt(0) as any,
        })
      );
      const gifs = (res as any)?.gifs || [];
      return gifs.map((g: any) => ({
        id: g.id.toString(),
        accessHash: g.accessHash.toString(),
        fileReference: g.fileReference ? Buffer.from(g.fileReference).toString('base64') : '',
        mimeType: g.mimeType || 'video/mp4',
        duration: g.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo')?.duration,
        width: g.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo')?.w,
        height: g.attributes?.find((a: any) => a.className === 'DocumentAttributeVideo')?.h,
      }));
    } catch (err: any) {
      this.logger.debug({ error: err.message }, 'Failed to get saved gifs');
      return [];
    }
  }

  async sendStickerDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    try {
      const inputDoc = new Api.InputDocument({
        id: BigInt(docId) as any,
        accessHash: BigInt(accessHash) as any,
        fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0),
      });
      const sent = await this.client.sendFile(peer, {
        file: inputDoc as any,
        replyTo,
      });
      return (sent as any)?.id;
    } catch (err: any) {
      this.logger.error({ chatId, docId, error: err.message }, 'Failed to send sticker document');
      throw err;
    }
  }

  async sendGifDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    try {
      const inputDoc = new Api.InputDocument({
        id: BigInt(docId) as any,
        accessHash: BigInt(accessHash) as any,
        fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0),
      });
      const sent = await this.client.sendFile(peer, {
        file: inputDoc as any,
        replyTo,
      });
      return (sent as any)?.id;
    } catch (err: any) {
      this.logger.error({ chatId, docId, error: err.message }, 'Failed to send gif document');
      throw err;
    }
  }
}

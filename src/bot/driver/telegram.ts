import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { randomBytes } from 'crypto';
import bigInt from 'big-integer';
import { TelegramClient, Api } from 'telegram';
import { Api as ModernApi } from 'teleproto';
import { CustomFile } from 'telegram/client/uploads';
import { getCommentData } from 'telegram/client/messages';
import { _parseMessageText } from 'telegram/client/messageParse';
import { getPeerId, strippedPhotoToJpg } from 'telegram/Utils';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage';
import { EditedMessage, EditedMessageEvent } from 'telegram/events/EditedMessage';
import { DeletedMessage } from 'telegram/events/DeletedMessage';
import { CallbackQuery as TelegramCallbackQuery } from 'telegram/events/CallbackQuery';
import { getBotCallbackData, mapBotKeyboard, mapBotReplyKeyboard } from './bot-keyboard';
import { downloadMediaToCache, invalidateMessageMediaCache, mediaCacheNamespace, withAwaitedFileWriter } from './media-cache';
import { getMediaStreamInfo, getMediaStreamChunk, type MediaStreamInfo } from './media-stream';
import { mapChatRawUpdate } from './update-mapping';
import { mapStoryMediaAreas } from './story-media-areas';
import { MiniAppSessions } from './mini-app-session';
import { mapCloudDraft } from './cloud-draft';

function discussionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT/i.test(message)) return new Error('无法访问关联的讨论群，请检查群组访问权限');
  if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHAT_SEND_PLAIN_FORBIDDEN/i.test(message)) return new Error('当前账号没有在讨论群发送消息的权限');
  if (/MSG_ID_INVALID|CHANNEL_INVALID|Reduce of empty array/i.test(message)) return new Error('评论不可用，帖子可能没有关联讨论群或已被删除');
  return error instanceof Error ? error : new Error(message);
}

function isSingleEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32 || /\s/u.test(value) ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) return false;
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1; }
  catch { return [...value].length <= 8; }
}

function isTelegramScheduleRepeatPeriod(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 86400 && (value as number) <= 31536000;
}

function chatlistSlug(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid Telegram chatlist invite URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Telegram chatlist invite URL'); }
  const match = url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password &&
    !url.port && !url.search && !url.hash ? /^\/addlist\/([A-Za-z0-9_-]{8,128})\/?$/.exec(url.pathname) : null;
  if (!match) throw new Error('Invalid Telegram chatlist invite URL');
  return match[1];
}

function telegramInviteLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.username || url.password || url.port || url.search || url.hash) return undefined;
    return /^\/(?:\+[A-Za-z0-9_-]{1,128}|joinchat\/[A-Za-z0-9_-]{1,128})\/?$/.test(url.pathname) ? url.href : undefined;
  } catch { return undefined; }
}

const CHAT_DEFAULT_BANNED_RIGHT_KEYS: (keyof ChatDefaultBannedRights)[] = [
  'viewMessages', 'sendMessages', 'sendPlain', 'sendMedia', 'sendPhotos', 'sendVideos', 'sendRoundvideos',
  'sendAudios', 'sendVoices', 'sendDocs', 'sendStickers', 'sendGifs', 'sendGames', 'sendInline',
  'embedLinks', 'sendPolls', 'changeInfo', 'inviteUsers', 'pinMessages', 'manageTopics',
];

function savedTagReaction(value: unknown): Api.TypeReaction {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved message tag');
  const reaction = value as Partial<SavedMessageTagReaction>;
  if (reaction.type === 'emoji' && isSingleEmoji(reaction.value)) {
    return new Api.ReactionEmoji({ emoticon: reaction.value });
  }
  if (reaction.type === 'custom' && typeof reaction.value === 'string' && /^[1-9]\d{0,19}$/.test(reaction.value) &&
      BigInt(reaction.value) <= (1n << 63n) - 1n) {
    return new Api.ReactionCustomEmoji({ documentId: bigInt(reaction.value) });
  }
  throw new Error('Invalid saved message tag');
}

function savedTagReactionRef(value: Api.TypeReaction): SavedMessageTagReaction | undefined {
  if (value instanceof Api.ReactionEmoji) return { type: 'emoji', value: value.emoticon };
  if (value instanceof Api.ReactionCustomEmoji) return { type: 'custom', value: String(value.documentId) };
  return undefined;
}

function savedTagReactionKey(value: Api.TypeReaction | SavedMessageTagReaction): string {
  if (value instanceof Api.ReactionEmoji) return `emoji:${value.emoticon}`;
  if (value instanceof Api.ReactionCustomEmoji) return `custom:${String(value.documentId)}`;
  const reaction = value as SavedMessageTagReaction;
  return `${reaction.type}:${reaction.value}`;
}

function searchMessagesFilter(filter?: GetMessagesOptions['searchFilter']): Api.TypeMessagesFilter {
  const filters: Record<NonNullable<GetMessagesOptions['searchFilter']>, () => Api.TypeMessagesFilter> = {
    photos: () => new Api.InputMessagesFilterPhotos(),
    videos: () => new Api.InputMessagesFilterVideo(),
    files: () => new Api.InputMessagesFilterDocument(),
    links: () => new Api.InputMessagesFilterUrl(),
    music: () => new Api.InputMessagesFilterMusic(),
    voice: () => new Api.InputMessagesFilterVoice(),
    'round-video': () => new Api.InputMessagesFilterRoundVideo(),
    'round-voice': () => new Api.InputMessagesFilterRoundVoice(),
    geo: () => new Api.InputMessagesFilterGeo(),
    calls: () => new Api.InputMessagesFilterPhoneCalls({}),
  };
  return filter ? filters[filter]() : new Api.InputMessagesFilterEmpty();
}
import type { Logger } from '../logger';
import type { BotConfig } from '../config';
import type {
  BotAdapter,
  IncomingMessage,
  MessageFactCheck,
  MessageReportProgress,
  DiscussionGroupState,
  SendOptions,
  MediaOptions,
  UserRef,
  OwnProfile,
  ChatRef,
  ChatType,
  ChatDefaultBannedRights,
  SupergroupSetting,
  MessageEntity,
  AdapterEventMap,
  ParticipantInfo,
  ParticipantsPage,
  CreateChatOptions,
  ChatInviteLinkInfo,
  ChatInviteLinksPage,
  JoinRequestsPage,
  AdminPermissions,
  DialogInfo,
  DialogFolder,
  DialogFolderInvite,
  DialogFolderSharePeer,
  DialogFolderInvitePreview,
  DialogFolderInvitePreviewPeer,
  DialogFolderTagState,
  MediaAttachment,
  MediaType,
  GetMessagesOptions,
  SavedMessageTag,
  SavedMessageTagReaction,
  StickerSetInfo,
  StickerPackSummary,
  StickerItem,
  StickerSearchPage,
  SavedGifItem,
  UserPhotoEntry,
  StoryEntry,
  StoryAlbumEntry,
  StoryAlbumStoriesPage,
  StoryFeedPage,
  StoryForwardEntry,
  StoryViewersPage,
  PeerProfileDetails,
} from '../adapter';
import { EventBus } from '../core/event-bus';
import { customEmojiParser, editorMarkdownParser } from './message-format';

// GramJS's stable layer predates story albums. The compatible Teleproto TL
// constructors supply just these newer wire types while the authenticated
// GramJS client continues to own the session and transport.
const gramTlObjects = require('telegram/tl/AllTLObjects').tlobjects as Record<number, any>;
for (const constructor of [
  ModernApi.StoryAlbum, ModernApi.stories.Albums, ModernApi.stories.AlbumsNotModified,
  ModernApi.InputMediaTodo, ModernApi.MessageMediaToDo, ModernApi.TodoList, ModernApi.TodoItem,
  ModernApi.TodoCompletion, ModernApi.MessageActionTodoAppendTasks, ModernApi.MessageActionTodoCompletions,
]) {
  const existing = gramTlObjects[constructor.CONSTRUCTOR_ID];
  if (!existing) gramTlObjects[constructor.CONSTRUCTOR_ID] = constructor;
  else if (existing.className !== constructor.className) throw new Error(`Telegram TL constructor collision: ${constructor.className}`);
}

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

/** Keep the editor's Markdown syntax consistent for sends, edits and captions. */
function prepareText(text: string, mode?: SendOptions['parseMode']): { text: string; parseMode: any } {
  if (mode === 'plain') return { text, parseMode: /\[[^\]\r\n]{1,32}\]\(tg:\/\/emoji\?id=[1-9]\d{0,19}\)/.test(text) ? customEmojiParser : false };
  if (mode === 'markdown' || (mode as string | undefined) === 'md') {
    return { text, parseMode: editorMarkdownParser };
  }
  return { text, parseMode: mode };
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
  if (msg.media?.className === 'MessageMediaToDo') return '[待办清单]';
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
  const className = (c as any).className;
  if (c instanceof Api.User || className === 'User') {
    return {
      id: Number(getPeerId(new Api.PeerUser({ userId: (c as any).id }))),
      type: 'private',
      username: (c as any).username ?? undefined,
      firstName: (c as any).firstName,
    } as ChatRef;
  }
  const isChannel = c instanceof Api.Channel || className === 'Channel' || className === 'ChannelForbidden';
  // Use the same marked peer IDs as GramJS dialogs: users are positive,
  // ordinary groups are negative and channels use the -100 prefix.
  const peer = isChannel
    ? new Api.PeerChannel({ channelId: (c as any).id })
    : new Api.PeerChat({ chatId: (c as any).id });
  const id = Number(getPeerId(peer));
  const type: ChatType = isChannel ? ((c as any).broadcast ? 'channel' : 'supergroup') : mapChatType(className);
  return {
    id,
    type,
    title: (c as any).title ?? undefined,
    username: (c as any).username ?? undefined,
    membersCount: (c as any).participantsCount ?? undefined,
  } as ChatRef;
}

function mapFactCheck(value: any): MessageFactCheck | undefined {
  if (!value || (value.className && value.className !== 'FactCheck')) return undefined;
  const rich = value.text;
  const text = typeof rich?.text === 'string' ? rich.text : undefined;
  const entities = Array.isArray(rich?.entities) ? rich.entities.map((entity: any) => ({
    type: String(entity?.className || ''), offset: Number(entity?.offset) || 0, length: Number(entity?.length) || 0,
    ...(typeof entity?.url === 'string' ? { url: entity.url } : {}),
    ...(entity?.userId != null ? { userId: Number(String(entity.userId)) } : {}),
    ...(entity?.documentId != null ? { documentId: String(entity.documentId) } : {}),
  })) : undefined;
  return {
    needCheck: Boolean(value.needCheck),
    ...(typeof value.country === 'string' && value.country ? { country: value.country.slice(0, 8) } : {}),
    ...(text ? { text: text.slice(0, 4096) } : {}),
    ...(entities?.length ? { entities } : {}),
    ...(value.hash != null ? { hash: String(value.hash) } : {}),
  };
}

function extractMediaAttachment(msg: Api.Message): MediaAttachment | undefined {
  // Webpage link preview
  const msgMedia = (msg as any).media;
  if (msgMedia?.className === 'MessageMediaToDo') {
    const todo = msgMedia.todo;
    const completed = Array.isArray(msgMedia.completions) ? msgMedia.completions : [];
    const peerId = (peer: any): number | undefined => {
      if (!peer) return undefined;
      const id = Number(String(peer.userId ?? peer.chatId ?? peer.channelId ?? ''));
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      if (peer.className === 'PeerUser') return id;
      if (peer.className === 'PeerChat') return -id;
      if (peer.className === 'PeerChannel') return Number(`-100${id}`);
      return undefined;
    };
    const entities = (value: any): MessageEntity[] => (Array.isArray(value?.entities) ? value.entities : []).map((entity: any) => ({
      type: String(entity?.className || ''), offset: Number(entity?.offset) || 0, length: Number(entity?.length) || 0,
      ...(typeof entity?.url === 'string' ? { url: entity.url } : {}),
      ...(entity?.userId != null ? { userId: Number(String(entity.userId)) } : {}),
      ...(entity?.documentId != null ? { documentId: String(entity.documentId) } : {}),
    }));
    return {
      type: 'todo', todoTitle: String(todo?.title?.text || ''), todoTitleEntities: entities(todo?.title),
      todoOthersCanAppend: Boolean(todo?.othersCanAppend), todoOthersCanComplete: Boolean(todo?.othersCanComplete),
      todoItems: (Array.isArray(todo?.list) ? todo.list : []).filter((item: any) => Number.isSafeInteger(Number(item?.id)))
        .map((item: any) => ({ id: Number(item.id), title: String(item.title?.text || ''), entities: entities(item.title) })),
      todoCompletions: completed.filter((item: any) => Number.isSafeInteger(Number(item?.id)))
        .map((item: any) => ({ id: Number(item.id), completedBy: peerId(item.completedBy), date: Number(item.date) || 0 })),
    };
  }
  if (msgMedia instanceof Api.MessageMediaPaidMedia) {
    const extended = Array.isArray(msgMedia.extendedMedia) ? msgMedia.extendedMedia : [];
    const locked = extended.some(item => item instanceof Api.MessageExtendedMediaPreview);
    const items = locked ? [] : extended.flatMap(item => {
      if (!(item instanceof Api.MessageExtendedMedia)) return [];
      const media = item.media as any;
      if (!media) return [];
      const attachment = extractMediaAttachment({
        ...(msg as any), media, photo: media.photo, document: media.document, poll: media.poll,
      } as Api.Message);
      return attachment ? [attachment] : [];
    });
    return {
      type: 'paid_media',
      paidMediaStars: String(msgMedia.starsAmount ?? '0'),
      paidMediaItemCount: extended.length,
      paidMediaLocked: locked,
      paidMediaItems: items,
    };
  }
  if (msgMedia && ['MessageMediaGeo', 'MessageMediaGeoLive', 'MessageMediaVenue'].includes(msgMedia.className)) {
    const lat = msgMedia.geo?.lat;
    const lon = msgMedia.geo?.long;
    const valid = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    return {
      type: 'location',
      latitude: valid ? lat : undefined,
      longitude: valid ? lon : undefined,
      locationTitle: msgMedia.className === 'MessageMediaVenue' ? msgMedia.title : undefined,
      locationAddress: msgMedia.className === 'MessageMediaVenue' ? msgMedia.address : undefined,
      liveLocation: msgMedia.className === 'MessageMediaGeoLive',
      liveLocationPeriod: msgMedia.className === 'MessageMediaGeoLive' && Number.isSafeInteger(msgMedia.period)
        ? Math.max(0, msgMedia.period) : undefined,
    };
  }
  if (msgMedia?.className === 'MessageMediaContact') {
    const userId = msgMedia.userId?.toString();
    return {
      type: 'contact',
      contactFirstName: msgMedia.firstName || undefined,
      contactLastName: msgMedia.lastName || undefined,
      contactPhone: msgMedia.phoneNumber || undefined,
      contactUserId: userId && userId !== '0' ? userId : undefined,
    };
  }
  if (msgMedia?.className === 'MessageMediaGame' && msgMedia.game) {
    return {
      type: 'game',
      gameTitle: typeof msgMedia.game.title === 'string' ? msgMedia.game.title.slice(0, 256) : undefined,
      gameDescription: typeof msgMedia.game.description === 'string' ? msgMedia.game.description.slice(0, 2048) : undefined,
      gameShortName: typeof msgMedia.game.shortName === 'string' ? msgMedia.game.shortName.slice(0, 128) : undefined,
    };
  }
  if (msgMedia?.className === 'MessageMediaDice') {
    const diceEmoji = ['🎲', '🎯', '🏀', '⚽', '🎳', '🎰'].includes(String(msgMedia.emoticon))
      ? String(msgMedia.emoticon) : '🎲';
    const diceValue = Number(msgMedia.value);
    return {
      type: 'dice',
      diceEmoji,
      ...(Number.isSafeInteger(diceValue) && diceValue >= 0 && diceValue <= 64 ? { diceValue } : {}),
    };
  }
  if (msgMedia?.className === 'MessageMediaStory') {
    let storyChatId = 0;
    try { storyChatId = Number(getPeerId(msgMedia.peer)); } catch { /* Invalid story peer */ }
    const storyId = Number(msgMedia.id);
    if (Number.isSafeInteger(storyChatId) && storyChatId !== 0 && Number.isSafeInteger(storyId) && storyId > 0) {
      return { type: 'story', storyChatId, storyId };
    }
  }
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
      canEdit: Boolean((msg as any).out && !(msg as any).fwdFrom && !p.closed && totalVoters === 0 &&
        !(results?.results || []).some((item: any) => Number(item?.voters) > 0)),
      publicVoters: Boolean(p.publicVoters),
      multipleChoice: Boolean(p.multipleChoice),
      isQuiz: Boolean(p.quiz),
      solution: (msg as any).media?.solution ?? results?.solution,
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
    const videoAttribute = docObj?.attributes?.find((attribute: any) => attribute.className === 'DocumentAttributeVideo');
    return {
      type: 'video',
      fileId: v.id?.toString(),
      duration: v.duration ?? videoAttribute?.duration,
      width: v.w ?? videoAttribute?.w,
      height: v.h ?? videoAttribute?.h,
      mimeType: v.mimeType,
      roundVideo: Boolean(videoAttribute?.roundMessage || v.roundMessage),
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
    let videoAttribute: any;

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
        } else if (attr.className === 'DocumentAttributeVideo') {
          videoAttribute = attr;
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
      ...(type === 'video' && videoAttribute ? {
        duration: Number.isFinite(Number(videoAttribute.duration)) ? Number(videoAttribute.duration) : undefined,
        width: Number.isSafeInteger(videoAttribute.w) ? videoAttribute.w : undefined,
        height: Number.isSafeInteger(videoAttribute.h) ? videoAttribute.h : undefined,
        roundVideo: Boolean(videoAttribute.roundMessage),
      } : {}),
      stickerSetId,
      stickerAccessHash,
      stickerShortName,
      waveform,
    };
  }

  // Preserve an explicit indication for unsupported Telegram media rather
  // than rendering an empty message bubble.
  return msgMedia && msgMedia.className !== 'MessageMediaEmpty' ? { type: 'unsupported' } : undefined;
}

export interface AuthPromptHandler {
  askPhone: () => Promise<string>;
  askCode: () => Promise<string>;
  askPassword: () => Promise<string>;
  onQr?: (token: Buffer, expires: number) => void;
  onError?: (err: Error) => void;
}

// Internal marker consumed before GramJS tries to send a phone code.
export const QR_AUTH_MARKER = '__telegram_qr_login__';

export class TelegramDriver implements BotAdapter {
  private readonly bus = new EventBus();
  private client!: TelegramClient;
  private selfId: number | undefined;
  private selfUser: UserRef | undefined;
  private selfIsPremium = false;
  private started = false;
  private keepaliveTimer?: NodeJS.Timeout;
  private keepalivePromise?: Promise<void>;
  private miniApps?: MiniAppSessions;
  private readonly pendingStarGiftPayments = new Map<string, {
    chatId: number; giftId: string; stars: string; formId: any; invoice: Api.TypeInputInvoice; expiresAt: number;
  }>();
  private readonly pendingPaidMediaPayments = new Map<string, {
    chatId: number; messageId: number; stars: string; itemCount: number; formId: any; invoice: Api.TypeInputInvoice; expiresAt: number;
  }>();
  private readonly pendingMessageReports = new Map<string, {
    chatId: number; messageId: number; option: Buffer; requireComment: boolean; expiresAt: number;
  }>();
  private readonly starsTopupOptions = new Map<string, {
    stars: string; currency: string; amount: string; storeProduct?: string; extended: boolean; expiresAt: number;
  }>();
  private readonly pendingStarsTopups = new Map<string, {
    stars: string; currency: string; amount: string; formId: any; invoice: Api.TypeInputInvoice; expiresAt: number;
  }>();
  private readonly savedStarGiftItems = new Map<string, {
    msgId: number; unsaved: boolean; unique: boolean; refunded: boolean; convertStars: string;
    upgradeStars: string; canUpgrade: boolean; transferStars?: string; canExportAt?: number; expiresAt: number;
  }>();
  private readonly pendingStarGiftUpgrades = new Map<string, { msgId: number; unsaved: boolean; stars: string; expiresAt: number }>();
  private readonly pendingStarGiftTransfers = new Map<string, {
    msgId: number; unsaved: boolean; chatId: number; target: any; stars: string; expiresAt: number;
  }>();
  private gifInlineBot?: Api.InputUser;
  private readonly emojiKeywordIndexes = new Map<string, { expiresAt: number; entries: Array<{ keyword: string; emoticons: string[] }> }>();
  private readonly emojiKeywordLoads = new Map<string, Promise<Array<{ keyword: string; emoticons: string[] }>>>();
  private emojiKeywordEpoch = 0;
  private emojiGroupsCache?: { expiresAt: number; groups: Array<{ title: string; emoticons: string[] }> };
  private emojiGroupsLoad?: Promise<Array<{ title: string; emoticons: string[] }>>;
  private telegramWallpapersCache?: { expiresAt: number; items: Api.TypeWallPaper[] };
  private telegramAppThemesCache?: { expiresAt: number; items: Api.Theme[] };
  private readonly pendingInlineGifs = new Map<string, {
    chatId: number; queryId: bigint; resultId: string; docId: string; accessHash: string; fileReference: string;
    action: 'send' | 'save'; expiresAt: number; saved?: boolean;
  }>();

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
    this.selfIsPremium = Boolean((self as any).premium);
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

    this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer || !this.started) return;
    this.keepaliveTimer = setInterval(() => {
      if (!this.started || !this.client || this.keepalivePromise) return;
      const operation = (async () => {
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
      })();
      this.keepalivePromise = operation;
      void operation.finally(() => { if (this.keepalivePromise === operation) this.keepalivePromise = undefined; });
    }, 40000);
    this.keepaliveTimer.unref();
  }

  async stop(): Promise<void> {
    this.miniApps?.closeAll();
    this.emojiKeywordEpoch = (this.emojiKeywordEpoch || 0) + 1;
    this.emojiKeywordIndexes?.clear();
    this.emojiKeywordLoads?.clear();
    this.emojiGroupsCache = undefined;
    this.emojiGroupsLoad = undefined;
    this.pendingStarGiftPayments?.clear();
    this.pendingPaidMediaPayments?.clear();
    this.starsTopupOptions?.clear();
    this.pendingStarsTopups?.clear();
    this.savedStarGiftItems?.clear();
    this.pendingStarGiftUpgrades?.clear();
    this.pendingStarGiftTransfers?.clear();
    this.pendingInlineGifs?.clear();
    this.gifInlineBot = undefined;
    if (!this.started) return;
    this.started = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.keepalivePromise) await this.keepalivePromise;
    try {
      await this.client.disconnect();
    } catch (err) {
      this.logger.warn({ err }, 'error disconnecting telegram client');
    }
    this.bus.emit('disconnected', { reason: 'stopped' });
  }

  /** Revoke only this Telegram authorization, then remove its local session. */
  async logOut(): Promise<{ localSessionRemoved: boolean }> {
    if (!this.started) throw new Error('Telegram 账号未连接');
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.keepalivePromise) await this.keepalivePromise;
    // Preserve the local session when Telegram rejects the logout request.
    try {
      await this.client.invoke(new Api.auth.LogOut());
    } catch (err) {
      this.startKeepalive();
      throw err;
    }
    try {
      await this.stop();
    } catch (err) {
      // Remote revocation already succeeded; still remove the invalid local
      // session even if a disconnect listener fails during cleanup.
      this.logger.warn({ err }, 'error stopping Telegram client after logout');
    }
    try {
      fs.rmSync(this.config.telegram.sessionPath, { force: true });
      return { localSessionRemoved: true };
    } catch (err) {
      this.logger.error({ err }, 'Telegram authorization revoked but local session could not be removed');
      return { localSessionRemoved: false };
    }
  }

  async getTelegramAuthorizations(): Promise<{ authorizationTtlDays: number; sessions: Array<{
    hash?: string; current: boolean; deviceModel: string; platform: string; systemVersion: string;
    appName: string; appVersion: string; dateCreated: number; dateActive: number; ip: string; country: string; region: string;
  }> }> {
    const result = await this.client.invoke(new Api.account.GetAuthorizations()) as any;
    const sessions = (result?.authorizations || []).flatMap((authorization: any) => {
      if (!authorization || authorization.className !== 'Authorization') return [];
      const current = Boolean(authorization.current);
      const hash = authorization.hash == null ? '' : String(authorization.hash.toString?.() ?? authorization.hash);
      return [{
        // The current session cannot be revoked through this list, so its hash
        // never needs to cross the GUI boundary.
        hash: !current && /^-?\d{1,20}$/.test(hash) ? hash : undefined,
        current,
        deviceModel: String(authorization.deviceModel || ''), platform: String(authorization.platform || ''),
        systemVersion: String(authorization.systemVersion || ''), appName: String(authorization.appName || ''),
        appVersion: String(authorization.appVersion || ''), dateCreated: Number(authorization.dateCreated) || 0,
        dateActive: Number(authorization.dateActive) || 0, ip: String(authorization.ip || ''),
        country: String(authorization.country || ''), region: String(authorization.region || ''),
      }];
    });
    return { authorizationTtlDays: Number(result?.authorizationTtlDays) || 0, sessions };
  }

  async revokeTelegramAuthorization(hash: string): Promise<void> {
    if (typeof hash !== 'string' || !/^-?\d{1,20}$/.test(hash)) throw new Error('Invalid Telegram authorization hash');
    const parsedHash = BigInt(hash);
    if (parsedHash < -(1n << 63n) || parsedHash > (1n << 63n) - 1n) throw new Error('Invalid Telegram authorization hash');
    const result = await this.client.invoke(new Api.account.ResetAuthorization({ hash: parsedHash as any }));
    if (result === false) throw new Error('Telegram 未能终止此登录会话');
  }

  async revokeOtherTelegramAuthorizations(): Promise<void> {
    const result = await this.client.invoke(new Api.auth.ResetAuthorizations());
    if (result === false) throw new Error('Telegram 未能终止其他登录会话');
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
    if (sessionStr) fs.writeFileSync(sessionPath, sessionStr, { encoding: 'utf-8', mode: 0o600 });
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
        phoneNumber: async () => {
          const phone = await this.authHandler!.askPhone();
          if (phone === QR_AUTH_MARKER) {
            // GramJS recognizes this error and enters its QR auth flow.
            throw Object.assign(new Error('QR login requested'), { errorMessage: 'RESTART_AUTH_WITH_QR' });
          }
          return phone;
        },
        password: async () => this.authHandler!.askPassword(),
        phoneCode: async () => this.authHandler!.askCode(),
        qrCode: async ({ token, expires }) => this.authHandler!.onQr?.(token, expires),
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
        if (update?.className === 'UpdateWebViewResultSent') this.miniApps?.closeQuery(update.queryId);
        if (update && ['UpdateDialogFilter', 'UpdateDialogFilterOrder', 'UpdateDialogFilters'].includes(update.className)) {
          this.bus.emit('dialog:folders', {});
        }
        if (update?.className === 'UpdateDraftMessage' && update.topMsgId == null && update.peer) {
          const chatId = Number(getPeerId(update.peer));
          if (Number.isSafeInteger(chatId) && chatId !== 0) this.bus.emit('draft:updated', { chatId, draft: mapCloudDraft(update.draft) });
        }
        const mapped = mapChatRawUpdate(update);
        if (mapped?.kind === 'read') this.bus.emit('message:read', { chatId: mapped.chatId, maxId: mapped.maxId });
        else if (mapped?.kind === 'stories') this.bus.emit('stories:updated', { chatId: mapped.chatId, storyId: mapped.storyId, maxReadId: mapped.maxReadId });
        else if (mapped?.kind === 'storiesStealth') this.bus.emit('stories:stealth', {});
        else if (mapped?.kind === 'historyTtl') this.bus.emit('chat:history-ttl', { chatId: mapped.chatId, period: mapped.period });
        else if (mapped?.kind === 'wallpaper') this.bus.emit('chat:wallpaper', { chatId: mapped.chatId });
        else if (mapped?.kind === 'forumTopics') this.bus.emit('forum:topics', { chatId: mapped.chatId });
        else if (mapped?.kind === 'status') this.bus.emit('user:status', { userId: mapped.userId, online: mapped.online, lastSeen: mapped.lastSeen });
        else if (mapped?.kind === 'typing') this.bus.emit('chat:typing', { chatId: mapped.chatId, userId: mapped.userId, action: mapped.action });
      } catch (_) {}
    });
  }

  private async mapMessage(msg: Api.Message, canClosePoll = false): Promise<IncomingMessage | undefined> {
    const resolvedChat = await msg.getChat();
    const chatEntity = resolvedChat ?? (await msg.getSender());
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

    let chatRef = chatFromEntity(chatEntity as any);
    if (!resolvedChat && msg.peerId) {
      // A sender is not the containing group. If the chat entity is absent,
      // keep the message's authoritative peer ID without borrowing the
      // sender's title or username for that conversation.
      const peerId = Number(getPeerId(msg.peerId));
      if (peerId !== chatRef.id) {
        chatRef = {
          id: peerId,
          type: msg.peerId instanceof Api.PeerChat ? 'group' :
            msg.peerId instanceof Api.PeerUser ? 'private' : 'unknown',
        };
      }
    }
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
    if (media?.type === 'story' && this.selfId) media.storyIsSelf = media.storyChatId === this.selfId;
    if (media?.type === 'poll' && canClosePoll) media.canClose = true;
    const mappedReplyKeyboard = mapBotReplyKeyboard(msg.replyMarkup);
    // Telegram's selective reply markup is delivered only to the addressed
    // user as a message with the `mentioned` flag. Keep this check server-side
    // so the browser never has to infer who the keyboard targets.
    const replyKeyboard = mappedReplyKeyboard?.selective && !(msg as any).mentioned ? undefined : mappedReplyKeyboard;

    // Reactions
    let reactions: any[] | undefined = undefined;
    if ((msg as any).reactions && Array.isArray((msg as any).reactions.results)) {
      reactions = (msg as any).reactions.results.map((r: any) => {
        let emoji = '❤️';
        let customEmojiId: string | undefined;
        if (r.reaction && r.reaction.emoticon) {
          emoji = r.reaction.emoticon;
        } else if (r.reaction && r.reaction.documentId) {
          customEmojiId = String(r.reaction.documentId);
          emoji = '✨';
        }
        return {
          emoji,
          ...(customEmojiId ? { customEmojiId } : {}),
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
    const replyHeader: any = msg.replyTo;
    let forumTopicId = Number(replyHeader?.replyToTopId) || 0;
    if (!forumTopicId && replyHeader?.forumTopic) forumTopicId = Number(replyHeader.replyToMsgId) || 0;
    if (!forumTopicId && ['MessageActionTopicCreate', 'MessageActionTopicEdit'].includes(action?.className)) forumTopicId = Number(msg.id) || 0;
    const topicUpdate = action?.className === 'MessageActionTopicEdit' ? {
      title: typeof action.title === 'string' ? action.title : undefined,
      closed: typeof action.closed === 'boolean' ? action.closed : undefined,
      hidden: typeof action.hidden === 'boolean' ? action.hidden : undefined,
      ...(action.iconEmojiId && /^[1-9]\d{0,19}$/.test(String(action.iconEmojiId)) ? { iconEmojiId: String(action.iconEmojiId) } : {}),
    } : undefined;
    const factCheck = mapFactCheck((msg as any).factcheck ?? (msg as any).factCheck ?? (msg as any).originalArgs?.factcheck);

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
        documentId: e.documentId != null ? String(e.documentId) : undefined,
        ...(e.className === 'MessageEntityBlockquote' && typeof e.collapsed === 'boolean' ? { collapsed: e.collapsed } : {}),
      })),
      ...(factCheck ? { factChecks: [factCheck] } : {}),
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
      topicId: Number.isSafeInteger(forumTopicId) && forumTopicId > 0 ? forumTopicId : undefined,
      topicUpdate,
      replies: (msg as any).replies?.replies ? Number((msg as any).replies.replies) : undefined,
      commentsEnabled: Boolean((msg as any).replies?.comments),
      botKeyboard: mapBotKeyboard(msg.replyMarkup),
      replyKeyboard,
    };
  }

  private mapServiceAction(action: any, fromUser: UserRef): IncomingMessage['service'] {
    const cls = action.className || '';
    const actor = fromUser.firstName || '用户';
    const formatDuration = (seconds: number): string => {
      if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
      const units: Array<[number, string]> = [[86400, '天'], [3600, '小时'], [60, '分钟']];
      for (const [size, label] of units) {
        if (seconds >= size && seconds % size === 0) return `${seconds / size} ${label}`;
      }
      return `${seconds} 秒`;
    };
    const amountText = (value: unknown): string => {
      try {
        const amount = BigInt(String(value ?? '0'));
        return amount > 0n ? amount.toString() : '';
      } catch {
        return '';
      }
    };
    switch (cls) {
      case 'MessageActionChatAddUser': {
        const addedIds = Array.isArray(action.users) ? action.users.map((id: unknown) => String(id)) : [];
        const selfJoined = addedIds.length === 1 && addedIds[0] === String(fromUser.id);
        return { type: selfJoined ? 'joined' : 'members_added', text: selfJoined
          ? `${actor} 加入了群组`
          : addedIds.length ? `${actor} 添加了 ${addedIds.length} 位成员` : `${actor} 添加了群组成员` };
      }
      case 'MessageActionChatDeleteUser': {
        const removedSelf = action.userId != null && String(action.userId) === String(fromUser.id);
        return { type: removedSelf ? 'left' : 'member_removed', text: removedSelf
          ? `${actor} 退出了群组`
          : `${actor} 移除了一位成员` };
      }
      case 'MessageActionChatJoinedByLink':
        return { type: 'joined', text: `${actor} 通过邀请链接加入了群组` };
      case 'MessageActionChatJoinedByRequest':
        return { type: 'joined', text: `${actor} 通过加入申请加入了群组` };
      case 'MessageActionChatEditTitle':
        return { type: 'title_changed', text: `群组名称已更改为 "${action.title || ''}"` };
      case 'MessageActionChatEditPhoto':
        return { type: 'photo_changed', text: `${fromUser.firstName || '用户'} 更换了群组头像` };
      case 'MessageActionChatDeletePhoto':
        return { type: 'photo_changed', text: `${fromUser.firstName || '用户'} 删除了群组头像` };
      case 'MessageActionChatCreate':
        return { type: 'created', text: `${actor} 创建了群组 "${action.title || ''}"` };
      case 'MessageActionChannelCreate':
        return { type: 'created', text: `${actor} 创建了频道 "${action.title || ''}"` };
      case 'MessageActionChatMigrateTo':
        return { type: 'chat_migrated', text: '群组已升级为超级群组' };
      case 'MessageActionChannelMigrateFrom':
        return { type: 'chat_migrated', text: `群组 "${action.title || ''}" 已升级为超级群组` };
      case 'MessageActionTopicCreate':
        return { type: 'topic_created', text: `${actor} 创建了话题 "${action.title || ''}"` };
      case 'MessageActionTopicEdit': {
        const changes = [];
        if (typeof action.title === 'string') changes.push(`名称改为 "${action.title}"`);
        if (action.iconEmojiId != null) changes.push('更换了话题图标');
        if (typeof action.closed === 'boolean') changes.push(action.closed ? '关闭了话题' : '重新打开了话题');
        if (typeof action.hidden === 'boolean') changes.push(action.hidden ? '隐藏了话题' : '显示了话题');
        return { type: 'topic_edited', text: `${actor} ${changes.join('，') || '更新了话题'}` };
      }
      case 'MessageActionGiftCode': {
        const months = Number(action.months) || 0;
        const slug = typeof action.slug === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(action.slug) ? action.slug : undefined;
        const text = action.unclaimed
          ? `${fromUser.firstName || '用户'} 赠送了 ${months || 'Telegram Premium'} 个月 Premium 礼物链接`
          : `${fromUser.firstName || '用户'} 赠送了 ${months || 'Telegram Premium'} 个月 Telegram Premium`;
        return { type: 'gift_code', text, ...(slug ? { giftCode: { slug, months, unclaimed: Boolean(action.unclaimed), viaGiveaway: Boolean(action.viaGiveaway) } } : {}) };
      }
      case 'MessageActionTodoAppendTasks':
        return { type: 'todo_tasks_added', text: `${actor} 向待办清单添加了任务` };
      case 'MessageActionTodoCompletions': {
        const completed = Array.isArray(action.completed) ? action.completed.length : 0;
        const incompleted = Array.isArray(action.incompleted) ? action.incompleted.length : 0;
        const changed = completed + incompleted;
        return { type: 'todo_tasks_updated', text: `${actor} 更新了 ${changed} 项待办任务` };
      }
      case 'MessageActionPinMessage':
        return { type: 'pinned', text: `${actor} 置顶了一条消息` };
      case 'MessageActionHistoryClear':
        return { type: 'cleared', text: '聊天记录已清空' };
      case 'MessageActionPhoneCall': {
        const duration = formatDuration(Number(action.duration));
        const kind = action.video ? '视频通话' : '语音通话';
        return { type: 'call', text: duration ? `${kind} · ${duration}` : (action.reason?.className === 'PhoneCallDiscardReasonBusy'
          ? `${kind} · 对方忙线` : `${kind} · 未接通`) };
      }
      case 'MessageActionPaymentSent':
        return { type: 'payment', text: action.currency === 'XTR'
          ? `已支付 ${amountText(action.totalAmount) || 'Stars'} Stars`
          : '已完成付款' };
      case 'MessageActionPaymentSentMe':
        return { type: 'payment_received', text: action.currency === 'XTR'
          ? `已收到 ${amountText(action.totalAmount) || 'Stars'} Stars 付款`
          : '已收到付款' };
      case 'MessageActionPaymentRefunded':
        return { type: 'payment_refunded', text: action.currency === 'XTR'
          ? `已退还 ${amountText(action.totalAmount) || 'Stars'} Stars`
          : '付款已退款' };
      case 'MessageActionGiftPremium':
        return { type: 'premium_gift', text: `${actor} 赠送了 ${Number(action.months) || 0} 个月 Telegram Premium` };
      case 'MessageActionGiftStars': {
        const amount = amountText(action.stars);
        return { type: 'gift_stars', text: `${actor} 赠送了 ${amount || '若干'} Stars` };
      }
      case 'MessageActionPrizeStars': {
        const amount = amountText(action.stars);
        return { type: 'prize_stars', text: action.unclaimed
          ? `抽奖送出的 ${amount || 'Stars'} 尚未领取`
          : `抽奖获得 ${amount || 'Stars'}` };
      }
      case 'MessageActionGiveawayLaunch':
        return { type: 'giveaway', text: 'Telegram Premium 抽奖已开始' };
      case 'MessageActionGiveawayResults':
        return { type: 'giveaway_results', text: `抽奖已结束 · ${Number(action.winnersCount) || 0} 位获奖者` };
      case 'MessageActionBoostApply':
        return { type: 'boost', text: `${actor} 为群组增加了 ${Number(action.boosts) || 1} 个 Boost` };
      case 'MessageActionGroupCall': {
        const duration = formatDuration(Number(action.duration));
        return { type: 'group_call', text: duration ? `群组通话结束 · ${duration}` : '群组语音/视频通话' };
      }
      case 'MessageActionGroupCallScheduled': {
        const date = Number(action.scheduleDate);
        const when = Number.isSafeInteger(date) && date > 0 ? new Date(date * 1000).toLocaleString() : '';
        return { type: 'group_call_scheduled', text: when ? `已安排群组通话 · ${when}` : '已安排群组通话' };
      }
      case 'MessageActionInviteToGroupCall':
        return { type: 'group_call_invite', text: `${actor} 邀请了 ${Array.isArray(action.users) ? action.users.length : 0} 位成员加入群组通话` };
      case 'MessageActionSetMessagesTTL': {
        const duration = formatDuration(Number(action.period));
        return { type: 'ttl_changed', text: duration ? `设置了自动删除计时器 · ${duration}` : '关闭了自动删除计时器' };
      }
      case 'MessageActionSetChatTheme':
        return { type: 'chat_theme', text: action.emoticon ? `更改了聊天主题 ${action.emoticon}` : '更改了聊天主题' };
      case 'MessageActionSetChatWallPaper':
        return { type: 'chat_wallpaper', text: '更改了聊天壁纸' };
      case 'MessageActionScreenshotTaken':
        return { type: 'screenshot', text: `${actor} 截取了屏幕` };
      case 'MessageActionContactSignUp':
        return { type: 'contact_signup', text: `${actor} 加入了 Telegram` };
      case 'MessageActionWebViewDataSent':
      case 'MessageActionWebViewDataSentMe':
        return { type: 'web_app_data', text: action.text ? `通过 ${action.text} 发送了 Mini App 数据` : '发送了 Mini App 数据' };
      case 'MessageActionRequestedPeer':
      case 'MessageActionRequestedPeerSentMe':
        return { type: 'peer_shared', text: `分享了 ${Array.isArray(action.peers) ? action.peers.length : 0} 个请求的会话` };
      case 'MessageActionGameScore':
        return { type: 'game_score', text: `${actor} 在游戏中获得 ${Number(action.score) || 0} 分` };
      case 'MessageActionCustomAction':
        return { type: 'custom', text: typeof action.message === 'string' ? action.message : '服务消息' };
      case 'MessageActionSuggestProfilePhoto':
        return { type: 'profile_photo_suggested', text: `${actor} 建议更新个人头像` };
      case 'MessageActionStarGift': {
        const status = action.refunded ? '已退款' : action.converted ? '已兑换' : action.upgraded ? '已升级' : action.saved ? '已保存' : '发送了礼物';
        return { type: 'star_gift', text: `${actor} ${status} Telegram 礼物` };
      }
      case 'MessageActionStarGiftUnique': {
        const status = action.refunded ? '已退款' : action.transferred ? '转让了' : action.upgrade ? '升级了' : '收到了';
        return { type: 'star_gift_unique', text: `${actor} ${status}独特礼物` };
      }
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

  private clientWithMessageEffect(effectId?: string, scheduleRepeatPeriod?: number, invertMedia = false): TelegramClient {
    if (effectId != null && (!/^[1-9]\d{0,19}$/.test(effectId) || BigInt(effectId) > (1n << 63n) - 1n)) {
      throw new Error('Invalid Telegram message effect');
    }
    if (scheduleRepeatPeriod != null && !isTelegramScheduleRepeatPeriod(scheduleRepeatPeriod)) {
      throw new Error('Invalid Telegram scheduled-message repeat period');
    }
    const client = this.client;
    const effect = effectId == null ? undefined : bigInt(effectId);
    // GramJS's sendFile helper does not currently forward message effects,
    // repeat periods, or invertMedia. Intercept only this operation's invoke
    // calls; the shared TelegramClient is untouched.
    return new Proxy(client, {
      get(target, property) {
        if (property === '_getResponseMessage') {
          return (request: any, result: any, inputPeer: any) => {
            const messageId = TelegramDriver.extractMessageIdFromUpdates(result);
            if (messageId) return { id: messageId };
            return (target as any)._getResponseMessage(request, result, inputPeer);
          };
        }
        if (property === 'invoke') {
          return (request: any, ...args: any[]) => {
            if (request instanceof Api.messages.SendMedia) {
              if (effect != null) request.effect = effect;
              if (invertMedia) request.invertMedia = true;
              if (scheduleRepeatPeriod != null) {
                // Telegram's current schema has repeat periods on SendMedia,
                // while GramJS's bundled layer predates that field.
                const modernRequest = new ModernApi.messages.SendMedia({
                  peer: request.peer, replyTo: request.replyTo, media: request.media,
                  message: request.message, randomId: request.randomId,
                  replyMarkup: request.replyMarkup, entities: request.entities,
                  scheduleDate: request.scheduleDate, scheduleRepeatPeriod,
                  sendAs: request.sendAs, quickReplyShortcut: request.quickReplyShortcut,
                  effect: request.effect, silent: request.silent, background: request.background,
                  clearDraft: request.clearDraft, noforwards: request.noforwards,
                  updateStickersetsOrder: request.updateStickersetsOrder,
                  invertMedia: request.invertMedia, allowPaidFloodskip: request.allowPaidFloodskip,
                  allowPaidStars: (request as any).allowPaidStars, suggestedPost: (request as any).suggestedPost,
                } as any);
                return (target.invoke as any).apply(target, [modernRequest, ...args]);
              }
            } else if (request instanceof Api.messages.SendMultiMedia) {
              if (invertMedia) request.invertMedia = true;
              if (scheduleRepeatPeriod != null) throw new Error('Telegram does not support repeating scheduled albums');
              if (effect != null) request.effect = effect;
            }
            return (target.invoke as any).apply(target, [request, ...args]);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private static extractMessageIdFromUpdates(result: any): number | undefined {
    const updates = Array.isArray(result?.updates) ? result.updates : result?.update ? [result.update] : [];
    for (const update of updates) {
      const id = Number(update?.message?.id ?? update?.id);
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
    return undefined;
  }

  private clientWithPaidMedia(client: TelegramClient, paidStars: number): TelegramClient {
    const price = bigInt(paidStars);
    return new Proxy(client, {
      get(target, property) {
        if (property === 'invoke') {
          return (request: any, ...args: any[]) => {
            if (!(request instanceof Api.messages.SendMultiMedia)) return (target.invoke as any).apply(target, [request, ...args]);
            const items = request.multiMedia || [];
            if (items.length < 1 || items.length > 10) throw new Error('付费媒体需要 1 到 10 项内容');
            const first = items[0];
            return (target.invoke as any).apply(target, [new Api.messages.SendMedia({
              peer: request.peer,
              replyTo: request.replyTo,
              media: new Api.InputMediaPaidMedia({ starsAmount: price, extendedMedia: items.map((item: any) => item.media) }),
              message: first.message || '',
              entities: first.entities,
              randomId: first.randomId,
              silent: request.silent,
              background: request.background,
              clearDraft: request.clearDraft,
              noforwards: request.noforwards,
              updateStickersetsOrder: request.updateStickersetsOrder,
              invertMedia: request.invertMedia,
              scheduleDate: request.scheduleDate,
              sendAs: request.sendAs,
              effect: request.effect,
            }), ...args]);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private sendMediaFile(peer: any, options: any, effectId?: string): Promise<any> {
    if (!effectId && options?.scheduleRepeatPeriod == null && !options?.invertMedia) return this.client.sendFile(peer, options);
    const effectClient = this.clientWithMessageEffect(effectId, options?.scheduleRepeatPeriod, options?.invertMedia);
    // Supply the proxy as `this` so GramJS's upload helper routes its final
    // MTProto request through the effect/repeat-aware invoke wrapper.
    return this.client.sendFile.call(effectClient, peer, options);
  }

  async sendMessage(chatId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(text, options?.parseMode);
    // An error can arrive after Telegram accepted the message. Retrying here
    // with a new request risks sending the same message twice.
    let sent: any;
    if (options?.scheduleRepeatPeriod != null && (!options.schedule || !isTelegramScheduleRepeatPeriod(options.scheduleRepeatPeriod))) {
      throw new Error('Invalid Telegram scheduled-message repeat period');
    }
    if (options?.effectId != null && (!/^[1-9]\d{0,19}$/.test(options.effectId) || BigInt(options.effectId) > (1n << 63n) - 1n)) {
      throw new Error('Invalid Telegram message effect');
    }
    if (options?.scheduleRepeatPeriod != null) {
      const inputPeer = await this.client.getInputEntity(peer);
      const [message, entities] = await _parseMessageText(this.client, formatted.text, formatted.parseMode);
      const randomId = bigInt(BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString());
      const request = new ModernApi.messages.SendMessage({
        peer: inputPeer,
        message: String(message),
        entities,
        noWebpage: false,
        silent: options.silent,
        ...(options.replyTo ? { replyTo: new ModernApi.InputReplyToMessage({ replyToMsgId: options.replyTo }) } : {}),
        ...(options.schedule ? { scheduleDate: options.schedule } : {}),
        ...(options.scheduleRepeatPeriod != null ? { scheduleRepeatPeriod: options.scheduleRepeatPeriod } : {}),
        ...(options.effectId != null ? { effect: bigInt(options.effectId) } : {}),
        randomId,
      } as any);
      const result = await this.client.invoke(request as any);
      const id = TelegramDriver.extractMessageIdFromUpdates(result);
      sent = id ? { id } : undefined;
    } else if (options?.effectId != null) {
      const inputPeer = await this.client.getInputEntity(peer);
      const [message, entities] = await _parseMessageText(this.client, formatted.text, formatted.parseMode);
      const randomId = bigInt(BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString());
      const request = new Api.messages.SendMessage({
        peer: inputPeer,
        message: String(message),
        entities,
        noWebpage: false,
        silent: options.silent,
        ...(options.replyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: options.replyTo }) } : {}),
        ...(options.schedule ? { scheduleDate: options.schedule } : {}),
        effect: bigInt(options.effectId),
        randomId,
      });
      const result = await this.client.invoke(request);
      sent = await (this.client as any)._getResponseMessage(request, result, inputPeer);
    } else {
      sent = await this.client.sendMessage(peer, {
        message: formatted.text,
        parseMode: formatted.parseMode,
        silent: options?.silent,
        replyTo: options?.replyTo,
        schedule: options?.schedule,
      });
    }
    const id = (sent as any)?.id;
    if (id && options?.autoDeleteMs && options.autoDeleteMs > 0) {
      setTimeout(() => {
        this.deleteMessage(chatId, id).catch(() => {});
      }, options.autoDeleteMs);
    }
    return id;
  }

  async replyTo(chatId: number, replyToMsgId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    return this.sendMessage(chatId, text, {
      ...options,
      replyTo: replyToMsgId,
    });
  }

  async editMessage(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(text, options?.parseMode);
    const res = await this.client.editMessage(peer, {
      message: messageId,
      text: formatted.text,
      parseMode: formatted.parseMode,
    });
    const id = (res as any)?.id ?? messageId;
    if (id && options?.autoDeleteMs && options.autoDeleteMs > 0) {
      setTimeout(() => {
        this.deleteMessage(chatId, id).catch(() => {});
      }, options.autoDeleteMs);
    }
    return id;
  }

  async replaceMessageMedia(chatId: number, messageId: number, uploadPath: string, fileName: string, mimeType: string,
    caption = '', parseMode: SendOptions['parseMode'] = 'plain'): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof caption !== 'string' || caption.length > 1024 || ![undefined, 'plain', 'markdown', 'html'].includes(parseMode)) {
      throw new Error('Invalid message media replacement');
    }
    if (!this.selfId) throw new Error('Telegram account is not ready');
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    const mediaType = message?.media?.className || '';
    if (!message || message.id !== messageId || !message.out || !mediaType ||
        ['MessageMediaEmpty', 'MessageMediaWebPage', 'MessageMediaPoll', 'MessageMediaGeo', 'MessageMediaGeoLive',
          'MessageMediaVenue', 'MessageMediaContact', 'MessageMediaGame', 'MessageMediaInvoice'].includes(mediaType)) {
      throw new Error('此消息不支持替换媒体');
    }
    const media = await this.createQuickReplyInputMedia(uploadPath, fileName, mimeType);
    const prepared = prepareText(caption, parseMode || 'plain');
    const [formattedCaption, entities] = await _parseMessageText(this.client, prepared.text, prepared.parseMode);
    if (formattedCaption.length > 1024) throw new Error('媒体说明不能超过 1024 个字符');
    await this.client.invoke(new Api.messages.EditMessage({
      peer, id: messageId, media, message: formattedCaption, entities,
    }));
    try {
      const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
      await invalidateMessageMediaCache(path.resolve('data', 'cache', 'media'), namespace, chatId, messageId);
    } catch (error: any) {
      this.logger.warn({ chatId, messageId, error: error?.message }, 'Failed to invalidate replaced message media cache');
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    await this.client.deleteMessages(peer, [messageId], { revoke: true });
  }

  async deleteMessages(chatId: number, messageIds: number[], revoke = true): Promise<void> {
    if (messageIds.length === 0) return;
    const peer = this.resolvePeer(chatId);
    await this.client.deleteMessages(peer, messageIds, { revoke });
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

  async getOwnProfile(): Promise<OwnProfile> {
    // The short self user does not contain `about`. Do not substitute an
    // empty biography if this request fails: the editor must not overwrite it.
    const result = await this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
    if (!result?.fullUser) throw new Error('无法读取完整账号资料');
    const own = result.users.find((user: any) => user.self ||
      (this.selfUser && String(user.id) === String(this.selfUser.id)));
    const self = userFromEntity(own as Api.User | undefined) || this.selfUser;
    if (!self) throw new Error('无法读取当前账号');
    return { ...self, bio: result.fullUser.about ?? '' };
  }

  async getAccountEmojiStatus(): Promise<{ currentDocumentId?: string; until?: number; options: Array<{ documentId: string; emoji: string }> }> {
    const [profile, result] = await Promise.all([
      this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })),
      this.client.invoke(new Api.account.GetDefaultEmojiStatuses({ hash: bigInt(0) })),
    ]);
    const own = (profile as any)?.users?.find((user: any) => user.self ||
      (this.selfUser && String(user.id) === String(this.selfUser.id)));
    const current = own?.emojiStatus as Api.TypeEmojiStatus | undefined;
    const currentDocumentId = current instanceof Api.EmojiStatus || current instanceof Api.EmojiStatusCollectible
      ? String(current.documentId) : undefined;
    const until = current instanceof Api.EmojiStatus || current instanceof Api.EmojiStatusCollectible ? current.until : undefined;
    const statuses = (result as any)?.statuses;
    const statusIds = Array.isArray(statuses) ? statuses.flatMap((status: any) => {
      const id = status instanceof Api.EmojiStatus ? String(status.documentId) : '';
      return /^[1-9]\d{0,19}$/.test(id) ? [id] : [];
    }).slice(0, 200) : [];
    let emojiById = new Map<string, string>();
    if (statusIds.length) {
      try {
        const documents = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: statusIds.map(id => bigInt(id)) })) as Api.TypeDocument[];
        emojiById = new Map(documents.flatMap(document => {
          if (!(document instanceof Api.Document)) return [];
          const attribute = document.attributes.find((item: any) => item instanceof Api.DocumentAttributeCustomEmoji);
          return attribute?.alt ? [[String(document.id), String(attribute.alt)]] : [];
        }));
      } catch { /* keep the status picker usable with accessible ID labels */ }
    }
    const options = statusIds.map(documentId => ({ documentId, emoji: emojiById.get(documentId) || '' }));
    return { currentDocumentId, until, options };
  }

  async setAccountEmojiStatus(documentId: string | null, durationSeconds?: number): Promise<void> {
    let emojiStatus: Api.TypeEmojiStatus;
    if (documentId == null) emojiStatus = new Api.EmojiStatusEmpty();
    else {
      if (!/^[1-9]\d{0,19}$/.test(documentId) ||
          (durationSeconds != null && ![0, 3600, 28800, 172800].includes(durationSeconds))) {
        throw new Error('Invalid Emoji status');
      }
      const until = durationSeconds && durationSeconds > 0 ? Math.floor(Date.now() / 1000) + durationSeconds : undefined;
      emojiStatus = new Api.EmojiStatus({ documentId: bigInt(documentId), until });
    }
    const result = await this.client.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus }));
    if (!result) throw new Error('Telegram 未确认更新 Emoji 状态');
  }

  raw<T = unknown>(): T {
    return this.client as unknown as T;
  }

  // --- 媒体能力实现 ---

  private async assertForumReply(chatId: number, topicId: number, replyTo: number): Promise<void> {
    if (!Number.isSafeInteger(topicId) || topicId <= 0 || !Number.isSafeInteger(replyTo) || replyTo <= 0) {
      throw new Error('Invalid forum reply');
    }
    if (replyTo === topicId) return;
    const messages = await this.client.getMessages(this.resolvePeer(chatId), { ids: [replyTo] });
    const message = messages[0];
    const header = message?.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;
    const actualTopic = header?.replyToTopId || (header?.forumTopic ? header.replyToMsgId : undefined) || 1;
    if (!message || actualTopic !== topicId) throw new Error('回复消息不属于当前话题');
  }

  async sendPhoto(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    const sent = await this.sendMediaFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: formatted.text,
      parseMode: formatted.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
      scheduleRepeatPeriod: options?.scheduleRepeatPeriod,
      thumb: options?.thumb as any,
      invertMedia: options?.invertMedia,
    } as any, options?.effectId);
    return (sent as any)?.id;
  }

  async sendVideo(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    const sent = await this.sendMediaFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: formatted.text,
      parseMode: formatted.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
      scheduleRepeatPeriod: options?.scheduleRepeatPeriod,
      thumb: options?.thumb as any,
      invertMedia: options?.invertMedia,
      videoNote: options?.videoNote,
    } as any, options?.effectId);
    return (sent as any)?.id;
  }

  async sendAudio(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    const sent = await this.sendMediaFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: formatted.text,
      parseMode: formatted.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
      scheduleRepeatPeriod: options?.scheduleRepeatPeriod,
      invertMedia: options?.invertMedia,
    } as any, options?.effectId);
    return (sent as any)?.id;
  }

  async sendFile(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    const sent = await this.sendMediaFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: formatted.text,
      parseMode: formatted.parseMode,
      forceDocument: options?.forceDocument ?? true,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
      scheduleRepeatPeriod: options?.scheduleRepeatPeriod,
      thumb: options?.thumb as any,
      invertMedia: options?.invertMedia,
    } as any, options?.effectId);
    return (sent as any)?.id;
  }

  async sendVoice(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined> {
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    const sent = await this.sendMediaFile(peer, {
      file: typeof file === 'string' ? file : Buffer.from(file),
      caption: formatted.text,
      parseMode: formatted.parseMode,
      voiceNote: true,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
      scheduleRepeatPeriod: options?.scheduleRepeatPeriod,
      invertMedia: options?.invertMedia,
    } as any, options?.effectId);
    return (sent as any)?.id;
  }

  async transcribeVoiceMessage(chatId: number, messageId: number): Promise<{
    transcriptionId: string; text: string; pending: boolean; trialRemainsNum?: number; trialRemainsUntilDate?: number;
  }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid voice transcription request');
    }
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    const media = message?.media;
    const document = media?.document;
    const isVoice = media instanceof Api.MessageMediaDocument && document instanceof Api.Document &&
      document.attributes.some((attribute: any) => attribute instanceof Api.DocumentAttributeAudio && attribute.voice);
    if (!isVoice) throw new Error('仅支持 Telegram 语音消息转文字');
    const result = await this.client.invoke(new Api.messages.TranscribeAudio({ peer, msgId: messageId })) as any;
    return {
      transcriptionId: String(result?.transcriptionId?.toString?.() ?? result?.transcriptionId ?? ''),
      text: String(result?.text || ''),
      pending: Boolean(result?.pending),
      trialRemainsNum: Number.isSafeInteger(result?.trialRemainsNum) ? result.trialRemainsNum : undefined,
      trialRemainsUntilDate: Number.isSafeInteger(result?.trialRemainsUntilDate) ? result.trialRemainsUntilDate : undefined,
    };
  }

  async rateVoiceTranscription(chatId: number, messageId: number, transcriptionId: string, good: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof transcriptionId !== 'string' || !/^-?\d{1,20}$/.test(transcriptionId) || typeof good !== 'boolean') {
      throw new Error('Invalid transcription rating request');
    }
    await this.client.invoke(new Api.messages.RateTranscribedAudio({
      peer: this.resolvePeer(chatId), msgId: messageId, transcriptionId: BigInt(transcriptionId) as any, good,
    }));
  }

  async getMessageReactionUsers(chatId: number, messageId: number, emoji: string, offset = '', limit = 50): Promise<{
    count: number; users: Array<{ user: UserRef; date: number }>; nextOffset?: string;
  }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof emoji !== 'string' || emoji.length > 32 || (!isSingleEmoji(emoji) && !/^custom:[1-9]\d{0,19}$/.test(emoji)) || typeof offset !== 'string' || offset.length > 512 ||
        /[\u0000-\u001f]/.test(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid message reaction list request');
    }
    const customEmojiId = /^custom:([1-9]\d{0,19})$/.exec(emoji)?.[1];
    if (customEmojiId && BigInt(customEmojiId) > (1n << 63n) - 1n) throw new Error('Invalid message reaction list request');
    const peer = this.resolvePeer(chatId);
    const result = await this.client.invoke(new Api.messages.GetMessageReactionsList({
      peer, id: messageId,
      reaction: customEmojiId ? new Api.ReactionCustomEmoji({ documentId: BigInt(customEmojiId) as any }) : new Api.ReactionEmoji({ emoticon: emoji }),
      offset, limit,
    })) as any;
    const byId = new Map<number, UserRef>();
    for (const entity of result?.users || []) {
      const user = userFromEntity(entity);
      if (user) byId.set(user.id, user);
    }
    const users = (result?.reactions || []).flatMap((reaction: any) => {
      if (!(reaction?.peerId instanceof Api.PeerUser)) return [];
      const id = Number(reaction.peerId.userId.toString());
      const user = byId.get(id);
      return user ? [{ user, date: Number(reaction.date) || 0 }] : [];
    });
    return { count: Number(result?.count) || 0, users, nextOffset: result?.nextOffset || undefined };
  }

  async getMessageReadParticipants(chatId: number, messageId: number): Promise<{
    count: number; participants: Array<{ user: UserRef; date: number }>;
  }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid message read participants request');
    }
    const result = await this.client.invoke(new Api.messages.GetMessageReadParticipants({
      peer: this.resolvePeer(chatId), msgId: messageId,
    })) as any;
    const entries = Array.isArray(result) ? result : [];
    const ids = entries.flatMap((entry: any) => {
      if (entry?.userId == null) return [];
      const id = Number(entry.userId.toString ? entry.userId.toString() : entry.userId);
      return Number.isSafeInteger(id) && id > 0 ? [id] : [];
    });
    const users = new Map<number, UserRef>();
    if (ids.length) {
      try {
        const entities = await this.client.getEntity(ids.map(id => new Api.PeerUser({ userId: BigInt(id) as any })));
        for (const entity of Array.isArray(entities) ? entities : [entities]) {
          const user = userFromEntity(entity as any);
          if (user) users.set(user.id, user);
        }
      } catch {
        // Read receipts contain IDs only. Keep them visible even when a profile
        // is no longer available from the local Telegram entity cache.
      }
    }
    const participants = entries.flatMap((entry: any) => {
      if (entry?.userId == null) return [];
      const id = Number(entry.userId.toString ? entry.userId.toString() : entry.userId);
      if (!Number.isSafeInteger(id) || id <= 0) return [];
      return [{ user: users.get(id) || { id, isBot: false }, date: Number(entry.date) || 0 }];
    });
    return { count: participants.length, participants };
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
    if (!options?.outputFile && !this.selfId) throw new Error('Telegram account is not ready');
    const namespace = options?.outputFile ? '' : mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId!);
    const destPath = options?.outputFile || path.join(cacheDir, `${namespace}_${chatId}${isBig ? '_big' : ''}.jpg`);

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

      const downloaded = await downloadMediaToCache(destPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadProfilePhoto(targetEntity, {
          isBig,
          outputFile: writer as any,
        })), 86400000);
      if (downloaded) {
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
      // Photo index can change when a user replaces their profile picture.
      const photoPath = `${outputFile}.${photo.id}`;
      const downloaded = await downloadMediaToCache(photoPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadMedia(photo, { outputFile: writer as any })));
      return downloaded ? photoPath : undefined;
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
    let ttlPeriod: number | undefined;
    let defaultBannedRights: ChatDefaultBannedRights | undefined;
    let slowmodeSeconds: number | undefined;
    let joinToSend: boolean | undefined;
    let joinRequest: boolean | undefined;
    let antiSpam: boolean | undefined;
    let participantsHidden: boolean | undefined;
    let commonChatsCount: number | undefined;
    let isVerified = false;
    let isPremium = false;
    let isBot = false;
    let storiesHidden = false;
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
          storiesHidden = Boolean(entity.storiesHidden);
          hasPhoto = Boolean(entity.photo);

          try {
            const fullUser = (await this.client.invoke(new Api.users.GetFullUser({ id: peer }))) as any;
            const full = fullUser?.fullUser;
            if (full) {
              bio = full.about;
              commonChatsCount = full.commonChatsCount;
              pinnedMsgId = full.pinnedMsgId;
              ttlPeriod = Number.isSafeInteger(full.ttlPeriod) && full.ttlPeriod >= 0 ? full.ttlPeriod : 0;
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
          if (typeof entity.joinToSend === 'boolean') joinToSend = entity.joinToSend;
          if (typeof entity.joinRequest === 'boolean') joinRequest = entity.joinRequest;

          try {
            const fullChat = entity.className === 'Chat'
              ? await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id })) as any
              : await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer })) as any;
            const full = fullChat?.fullChat;
            if (full) {
              bio = full.about;
              memberCount = full.participantsCount ?? full.participants?.participants?.length ?? entity.participantsCount;
              pinnedMsgId = full.pinnedMsgId;
              ttlPeriod = Number.isSafeInteger(full.ttlPeriod) && full.ttlPeriod >= 0 ? full.ttlPeriod : 0;
              const rawRights = full.defaultBannedRights;
              if (rawRights && rawRights.className === 'ChatBannedRights') {
                defaultBannedRights = Object.fromEntries(CHAT_DEFAULT_BANNED_RIGHT_KEYS.map(key => [key, Boolean(rawRights[key])])) as unknown as ChatDefaultBannedRights;
              }
              const rawSlowmode = Number(full.slowmodeSeconds);
              if (Number.isSafeInteger(rawSlowmode) && rawSlowmode >= 0) slowmodeSeconds = rawSlowmode;
              if (typeof full.antispam === 'boolean') antiSpam = full.antispam;
              if (typeof full.participantsHidden === 'boolean') participantsHidden = full.participantsHidden;
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
      isSelf: Boolean(this.selfId && chatId === this.selfId),
      username,
      phone,
      bio,
      type,
      memberCount,
      ttlPeriod,
      commonChatsCount,
      isVerified,
      isPremium,
      isBot,
      storiesHidden,
      hasPhoto,
      photosCount,
      pinnedMsgId,
      ...(defaultBannedRights ? { defaultBannedRights } : {}),
      ...(slowmodeSeconds === undefined ? {} : { slowmodeSeconds }),
      ...(joinToSend === undefined ? {} : { joinToSend }),
      ...(joinRequest === undefined ? {} : { joinRequest }),
      ...(antiSpam === undefined ? {} : { antiSpam }),
      ...(participantsHidden === undefined ? {} : { participantsHidden }),
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
          const mediaAreas = mapStoryMediaAreas(s.mediaAreas);
          list.push({
            id: s.id,
            date: s.date,
            expireDate: s.expireDate,
            caption: s.caption,
            isPinned: Boolean(s.pinned),
            mediaType,
            sentReaction: s.sentReaction instanceof Api.ReactionEmoji ? s.sentReaction.emoticon : undefined,
            ...(mediaAreas.length ? { mediaAreas } : {}),
          });
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  async getStoryById(chatId: number, storyId: number): Promise<StoryEntry | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
      throw new Error('Invalid Telegram story request');
    }
    const result = await this.client.invoke(new Api.stories.GetStoriesByID({ peer: this.resolvePeer(chatId), id: [storyId] })) as any;
    const story = (Array.isArray(result?.stories) ? result.stories : []).find((item: any) => item instanceof Api.StoryItem && item.id === storyId);
    return story ? this.mapStoryAlbumStory(story) : undefined;
  }

  async getStoryStealthStatus(): Promise<{ activeUntilDate?: number; cooldownUntilDate?: number }> {
    const result = await this.client.invoke(new Api.stories.GetAllStories({})) as any;
    const mode = result?.stealthMode || result?.stealth_mode;
    const activeUntilDate = Number(mode?.activeUntilDate ?? mode?.active_until_date);
    const cooldownUntilDate = Number(mode?.cooldownUntilDate ?? mode?.cooldown_until_date);
    return {
      ...(Number.isSafeInteger(activeUntilDate) && activeUntilDate > 0 ? { activeUntilDate } : {}),
      ...(Number.isSafeInteger(cooldownUntilDate) && cooldownUntilDate > 0 ? { cooldownUntilDate } : {}),
    };
  }

  async getStoriesFeed(state = '', next = false, hidden = false): Promise<StoryFeedPage> {
    if (typeof state !== 'string' || state.length > 2048 || typeof next !== 'boolean' ||
        typeof hidden !== 'boolean' || (next && !state)) throw new Error('Invalid story feed cursor');
    const request = new Api.stories.GetAllStories({
      ...(state ? { state } : {}), ...(next ? { next: true } : {}), ...(hidden ? { hidden: true } : {}),
    });
    const result = await this.client.invoke(request) as any;
    const entities = new Map<string, any>();
    for (const entity of [...(result?.users || []), ...(result?.chats || [])]) {
      try { entities.set(String(getPeerId(entity)), entity); } catch { /* malformed entity */ }
    }
    const peers = (result?.peerStories || []).flatMap((peerStories: any) => {
      let id: number;
      try { id = Number(getPeerId(peerStories.peer)); } catch { return []; }
      if (!Number.isSafeInteger(id) || id === 0) return [];
      const entity = entities.get(String(id));
      const chat = entity ? chatFromEntity(entity) : undefined;
      const fullName = entity && (entity instanceof Api.User || entity.className === 'User')
        ? [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim()
        : '';
      const title = fullName || chat?.title || chat?.username || (id > 0 ? `用户 ${id}` : `群组 ${Math.abs(id)}`);
      const stories: StoryEntry[] = (peerStories.stories || []).flatMap((story: any) => {
        if (!(story instanceof Api.StoryItem) || (story.expireDate && story.expireDate <= Math.floor(Date.now() / 1000))) return [];
        const mediaAreas = mapStoryMediaAreas(story.mediaAreas);
        return [{
          id: story.id, date: story.date, expireDate: story.expireDate, caption: story.caption,
          isPinned: Boolean(story.pinned),
          mediaType: story.media instanceof Api.MessageMediaPhoto ? 'photo' : story.media instanceof Api.MessageMediaDocument ? 'video' : 'unknown',
          sentReaction: story.sentReaction instanceof Api.ReactionEmoji ? story.sentReaction.emoticon : undefined,
          ...(mediaAreas.length ? { mediaAreas } : {}),
        }];
      });
      if (!stories.length) return [];
      const maxReadId = Number(peerStories.maxReadId) || 0;
      return [{
        id, type: chat?.type || (id > 0 ? 'private' : 'supergroup'), title,
        username: entity?.username || undefined, isSelf: Boolean(this.selfId && id === this.selfId),
        isRead: stories.every(story => story.id <= maxReadId), isHidden: hidden, stories,
      }];
    });
    return {
      peers, state: typeof result?.state === 'string' ? result.state : '',
      hasMore: Boolean(result?.hasMore), count: Number(result?.count) || peers.length,
    };
  }

  async getPeerStoriesNotificationsMuted(chatId: number): Promise<boolean> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || (this.selfId && chatId === this.selfId)) {
      throw new Error('Invalid story notification peer');
    }
    const result = await this.client.invoke(new Api.account.GetNotifySettings({
      peer: new Api.InputNotifyPeer({ peer: this.resolvePeer(chatId) }),
    })) as any;
    return Boolean(result?.storiesMuted);
  }

  async setPeerStoriesNotificationsMuted(chatId: number, muted: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof muted !== 'boolean' || (this.selfId && chatId === this.selfId)) {
      throw new Error('Invalid story notification setting');
    }
    await this.client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer: this.resolvePeer(chatId) }),
      settings: new Api.InputPeerNotifySettings({ storiesMuted: muted }),
    }));
  }

  async activateStoryStealth(): Promise<{ activeUntilDate?: number; cooldownUntilDate?: number; activated?: boolean }> {
    await this.client.invoke(new Api.stories.ActivateStealthMode({ past: true, future: true }));
    // Telegram returns the updated mode through Updates, but older layers may
    // omit it. Read the authoritative state when available without treating a
    // status-read failure as a failed activation.
    try {
      const status = await this.getStoryStealthStatus();
      return { ...status, activated: true };
    } catch {
      return { activated: true };
    }
  }

  private async storyAlbumPeer(chatId: number, requireOwner = false): Promise<any> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || (requireOwner && (!this.selfId || chatId !== this.selfId))) {
      throw new Error(requireOwner ? 'Story albums can only be managed by the current account' : 'Invalid Telegram story album peer');
    }
    const input = await this.client.getInputEntity(this.resolvePeer(chatId));
    const convert = (peer: any): any => {
      switch (peer?.className) {
        case 'InputPeerSelf': return new ModernApi.InputPeerSelf();
        case 'InputPeerChat': return new ModernApi.InputPeerChat({ chatId: bigInt(String(peer.chatId)) });
        case 'InputPeerUser': return new ModernApi.InputPeerUser({ userId: bigInt(String(peer.userId)), accessHash: bigInt(String(peer.accessHash)) });
        case 'InputPeerChannel': return new ModernApi.InputPeerChannel({ channelId: bigInt(String(peer.channelId)), accessHash: bigInt(String(peer.accessHash)) });
        case 'InputPeerUserFromMessage': return new ModernApi.InputPeerUserFromMessage({
          peer: convert(peer.peer), msgId: peer.msgId, userId: bigInt(String(peer.userId)),
        });
        case 'InputPeerChannelFromMessage': return new ModernApi.InputPeerChannelFromMessage({
          peer: convert(peer.peer), msgId: peer.msgId, channelId: bigInt(String(peer.channelId)),
        });
        default: throw new Error('Unsupported Telegram story album peer');
      }
    };
    return convert(input);
  }

  private mapStoryAlbumStory(story: any): StoryEntry | undefined {
    if (!(story instanceof Api.StoryItem)) return undefined;
    const mediaAreas = mapStoryMediaAreas(story.mediaAreas);
    return {
      id: story.id, date: story.date, expireDate: story.expireDate, caption: story.caption,
      isPinned: Boolean(story.pinned),
      mediaType: story.media instanceof Api.MessageMediaPhoto ? 'photo' : story.media instanceof Api.MessageMediaDocument ? 'video' : 'unknown',
      sentReaction: story.sentReaction instanceof Api.ReactionEmoji ? story.sentReaction.emoticon : undefined,
      ...(mediaAreas.length ? { mediaAreas } : {}),
      viewsCount: story.views?.viewsCount || 0,
      reactionsCount: story.views?.reactionsCount || 0,
      forwardsCount: story.views?.forwardsCount || 0,
    };
  }

  async getStoryAlbums(chatId = this.selfId || 0): Promise<StoryAlbumEntry[]> {
    const peer = await this.storyAlbumPeer(chatId);
    const result = await this.client.invoke(new ModernApi.stories.GetAlbums({ peer, hash: bigInt.zero }) as any) as any;
    if (result instanceof ModernApi.stories.AlbumsNotModified) return [];
    return (Array.isArray(result?.albums) ? result.albums : []).flatMap((album: any) => {
      const id = Number(album?.albumId);
      return Number.isSafeInteger(id) && id > 0 && typeof album?.title === 'string'
        ? [{ id, title: album.title, ...(album.iconPhoto?.className === 'Photo' ? { coverType: 'photo' as const } :
          album.iconVideo?.className === 'Document' ? { coverType: 'video' as const } : {}) }] : [];
    });
  }

  async downloadStoryAlbumCover(chatId: number, albumId: number): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!Number.isSafeInteger(albumId) || albumId <= 0 || !this.selfId) throw new Error('Invalid Telegram story album cover');
    const peer = await this.storyAlbumPeer(chatId);
    const result = await this.client.invoke(new ModernApi.stories.GetAlbums({ peer, hash: bigInt.zero }) as any) as any;
    const album = (Array.isArray(result?.albums) ? result.albums : []).find((item: any) => Number(item?.albumId) === albumId);
    if (!album) return undefined;
    const photo = album.iconPhoto?.className === 'Photo' ? album.iconPhoto : undefined;
    const document = album.iconVideo?.className === 'Document' ? album.iconVideo : undefined;
    const media = photo || document;
    if (!media || !/^[1-9]\d{0,19}$/.test(String(media.id)) || !media.accessHash || !Number.isSafeInteger(Number(media.dcId))) return undefined;
    const thumbs = photo ? media.sizes : media.thumbs;
    const thumb = (Array.isArray(thumbs) ? thumbs : []).find((item: any) =>
      ['PhotoSize', 'PhotoSizeProgressive'].includes(item?.className) && typeof item.type === 'string' && item.type.length > 0);
    if (!thumb) return undefined;
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const filePath = path.resolve('data', 'cache', 'story-album-covers', `${namespace}_${chatId}_${albumId}_${String(media.id)}.jpg`);
    const location = photo ? new Api.InputPhotoFileLocation({
      id: bigInt(String(media.id)), accessHash: bigInt(String(media.accessHash)),
      fileReference: media.fileReference ? Buffer.from(media.fileReference) : Buffer.alloc(0), thumbSize: thumb.type,
    }) : new Api.InputDocumentFileLocation({
      id: bigInt(String(media.id)), accessHash: bigInt(String(media.accessHash)),
      fileReference: media.fileReference ? Buffer.from(media.fileReference) : Buffer.alloc(0), thumbSize: thumb.type,
    });
    const downloaded = await downloadMediaToCache(filePath, temporaryPath =>
      withAwaitedFileWriter(temporaryPath, writer => this.client.downloadFile(location as any, {
        outputFile: writer as any, dcId: Number(media.dcId),
      })));
    return downloaded ? { filePath, mimeType: 'image/jpeg' } : undefined;
  }

  async getStoryAlbumStories(chatId: number, albumId: number, offset = 0, limit = 20): Promise<StoryAlbumStoriesPage> {
    if (!Number.isSafeInteger(albumId) || albumId <= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Telegram story album page');
    const peer = await this.storyAlbumPeer(chatId);
    if (!(await this.getStoryAlbums(chatId)).some(album => album.id === albumId)) throw new Error('Telegram story album not found');
    const result = await this.client.invoke(new ModernApi.stories.GetAlbumStories({ peer, albumId, offset, limit }) as any) as any;
    const stories = (result?.stories || []).flatMap((story: any) => {
      const entry = this.mapStoryAlbumStory(story);
      return entry ? [entry] : [];
    });
    const count = Math.max(stories.length, Number(result?.count) || 0);
    const nextOffset = offset + stories.length < count ? offset + stories.length : undefined;
    return { stories, count, nextOffset };
  }

  async createStoryAlbum(chatId: number, title: string, storyIds: number[] = []): Promise<StoryAlbumEntry> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 64 || /[\u0000-\u001f]/.test(title) ||
        !Array.isArray(storyIds) || storyIds.length > 100 || new Set(storyIds).size !== storyIds.length ||
        storyIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid Telegram story album');
    const peer = await this.storyAlbumPeer(chatId, true);
    const album = await this.client.invoke(new ModernApi.stories.CreateAlbum({ peer, title: title.trim(), stories: storyIds }) as any) as any;
    const id = Number(album?.albumId);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof album?.title !== 'string') throw new Error('Telegram did not return the created story album');
    return { id, title: album.title };
  }

  async updateStoryAlbum(chatId: number, albumId: number, update: { title?: string; addStoryIds?: number[]; removeStoryIds?: number[] }): Promise<StoryAlbumEntry> {
    const validIds = (ids: unknown): ids is number[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
      new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0);
    if (!Number.isSafeInteger(albumId) || albumId <= 0 || !update || typeof update !== 'object' ||
        !await this.getStoryAlbums(chatId).then(albums => albums.some(album => album.id === albumId))) {
      throw new Error('Invalid Telegram story album update');
    }
    const hasTitle = update.title !== undefined;
    if (hasTitle && (typeof update.title !== 'string' || !update.title.trim() || update.title.trim().length > 64 || /[\u0000-\u001f]/.test(update.title))) {
      throw new Error('Invalid Telegram story album title');
    }
    if ((!hasTitle && update.addStoryIds === undefined && update.removeStoryIds === undefined) ||
        (update.addStoryIds !== undefined && !validIds(update.addStoryIds)) ||
        (update.removeStoryIds !== undefined && !validIds(update.removeStoryIds))) throw new Error('Invalid Telegram story album update');
    if (update.addStoryIds && update.removeStoryIds && update.addStoryIds.some(id => update.removeStoryIds!.includes(id))) {
      throw new Error('A story cannot be added and removed from an album in the same request');
    }
    const peer = await this.storyAlbumPeer(chatId, true);
    const album = await this.client.invoke(new ModernApi.stories.UpdateAlbum({ peer, albumId,
      title: hasTitle ? update.title!.trim() : undefined,
      addStories: update.addStoryIds,
      deleteStories: update.removeStoryIds,
    }) as any) as any;
    const title = typeof album?.title === 'string' ? album.title : update.title;
    if (!title) throw new Error('Telegram did not return the updated story album');
    return { id: albumId, title };
  }

  async deleteStoryAlbum(chatId: number, albumId: number): Promise<void> {
    if (!Number.isSafeInteger(albumId) || albumId <= 0 ||
        !await this.getStoryAlbums(chatId).then(albums => albums.some(album => album.id === albumId))) {
      throw new Error('Invalid Telegram story album deletion');
    }
    const peer = await this.storyAlbumPeer(chatId, true);
    await this.client.invoke(new ModernApi.stories.DeleteAlbum({ peer, albumId }) as any);
  }

  async reorderStoryAlbums(chatId: number, albumIds: number[]): Promise<void> {
    if (!Array.isArray(albumIds) || albumIds.length > 100 || albumIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(albumIds).size !== albumIds.length) throw new Error('Invalid Telegram story album order');
    const peer = await this.storyAlbumPeer(chatId, true);
    const current = (await this.getStoryAlbums(chatId)).map(album => album.id);
    if (current.length !== albumIds.length || current.some(id => !albumIds.includes(id))) throw new Error('Telegram story album order is incomplete or stale');
    await this.client.invoke(new ModernApi.stories.ReorderAlbums({ peer, order: albumIds }) as any);
  }

  async moveStoryAlbumStory(chatId: number, albumId: number, storyId: number, delta: number): Promise<void> {
    if (!Number.isSafeInteger(albumId) || albumId <= 0 || !Number.isSafeInteger(storyId) || storyId <= 0 ||
        ![-1, 1].includes(delta)) throw new Error('Invalid Telegram story album move');
    const peer = await this.storyAlbumPeer(chatId, true);
    if (!(await this.getStoryAlbums(chatId)).some(album => album.id === albumId)) throw new Error('Telegram story album not found');
    const ids: number[] = [];
    const unique = new Set<number>();
    let count = 0, offset = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.client.invoke(new ModernApi.stories.GetAlbumStories({ peer, albumId, offset, limit: 100 }) as any) as any;
      const items = Array.isArray(result?.stories) ? result.stories : [];
      count = Math.max(count, Number(result?.count) || 0);
      for (const item of items) {
        if (item instanceof Api.StoryItem && !unique.has(item.id)) { unique.add(item.id); ids.push(item.id); }
      }
      offset += items.length;
      if (!items.length || offset >= count) break;
    }
    if (count > 10000 || ids.length !== count) throw new Error('Telegram story album list is incomplete; order was not changed');
    const index = ids.indexOf(storyId), next = index + delta;
    if (index < 0) throw new Error('Telegram story is not in this album');
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    await this.client.invoke(new ModernApi.stories.UpdateAlbum({ peer, albumId, order: ids }) as any);
  }

  async getStoryArchive(offsetId = 0, limit = 20): Promise<{ stories: StoryEntry[]; count: number; nextOffsetId?: number }> {
    if (!this.selfId) throw new Error('Telegram account is not ready');
    if (!Number.isSafeInteger(offsetId) || offsetId < 0) throw new Error('Invalid story archive cursor');
    const pageSize = Math.max(1, Math.min(Math.floor(limit), 50));
    const result = await this.client.invoke(new Api.stories.GetStoriesArchive({
      peer: this.resolvePeer(this.selfId), offsetId, limit: pageSize,
    })) as any;
    const entries = (result?.stories || []).flatMap((story: any) => {
      const entry = this.mapStoryAlbumStory(story);
      return entry ? [entry] : [];
    });
    const lastId = entries.length ? entries[entries.length - 1].id : undefined;
    return { stories: entries, count: Number(result?.count || 0), nextOffsetId: entries.length >= pageSize ? lastId : undefined };
  }

  async getStoryViewers(chatId: number, storyId: number, offset = '', limit = 50, kind: 'viewers' | 'reactions' | 'forwards' = 'viewers'): Promise<StoryViewersPage> {
    if (!this.selfId || chatId !== this.selfId || !Number.isSafeInteger(storyId) || storyId <= 0 ||
        typeof offset !== 'string' || offset.length > 512 || !['viewers', 'reactions', 'forwards'].includes(kind)) throw new Error('Invalid story viewers request');
    const result = await this.client.invoke(new Api.stories.GetStoryViewsList({
      peer: this.resolvePeer(chatId), id: storyId, offset, limit: Math.max(1, Math.min(Math.floor(limit), 50)),
      reactionsFirst: kind === 'reactions', forwardsFirst: kind === 'forwards',
    })) as any;
    const users = new Map<string, UserRef>();
    const peerTitles = new Map<string, string>();
    for (const entity of result?.users || []) {
      const user = userFromEntity(entity);
      if (user) {
        users.set(String(user.id), user);
        peerTitles.set(String(user.id), [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || `用户 ${user.id}`);
      }
    }
    for (const entity of result?.chats || []) {
      try { peerTitles.set(String(getPeerId(entity)), String(entity.title || `会话 ${getPeerId(entity)}`)); } catch { /* Ignore malformed peer entities. */ }
    }
    const viewers = (result?.views || []).flatMap((view: any) => {
      if (view?.userId == null) return [];
      const user = users.get(String(view.userId));
      if (!user) return [];
      return [{ user, date: Number(view.date) || 0,
        reaction: view.reaction instanceof Api.ReactionEmoji ? view.reaction.emoticon : undefined }];
    });
    const forwards: StoryForwardEntry[] = (result?.views || []).flatMap((view: any) => {
      if (view instanceof Api.StoryViewPublicForward) {
        const message: any = view.message;
        let peerId: number | undefined;
        try {
          if (message?.peerId) {
            const markedPeer = Number(getPeerId(message.peerId));
            if (Number.isSafeInteger(markedPeer)) peerId = markedPeer;
          }
        } catch { /* The forwarded message may not expose a peer. */ }
        const title = peerId == null ? '公开转发' : peerTitles.get(String(peerId)) || `会话 ${peerId}`;
        return [{ type: 'forward' as const, title, peerId, messageId: Number(message?.id) || undefined,
          date: Number(message?.date) || undefined, text: String(message?.message || '').slice(0, 2048) }];
      }
      if (view instanceof Api.StoryViewPublicRepost) {
        let peerId: number | undefined;
        try {
          if (view.peerId) {
            const markedPeer = Number(getPeerId(view.peerId));
            if (Number.isSafeInteger(markedPeer)) peerId = markedPeer;
          }
        } catch { /* The public repost may not expose a peer. */ }
        const story: any = view.story;
        const title = peerId == null ? '公开转发动态' : peerTitles.get(String(peerId)) || `会话 ${peerId}`;
        return [{ type: 'repost' as const, title, peerId, storyId: Number(story?.id) || undefined,
          date: Number(story?.date) || undefined, text: String(story?.caption || '').slice(0, 2048) }];
      }
      return [];
    });
    return {
      count: Number(result?.count || 0), viewsCount: Number(result?.viewsCount || 0),
      reactionsCount: Number(result?.reactionsCount || 0), forwardsCount: Number(result?.forwardsCount || 0),
      viewers, forwards, nextOffset: result?.nextOffset || undefined,
    };
  }

  async deleteStories(chatId: number, storyIds: number[]): Promise<void> {
    const ids = [...new Set(storyIds)];
    if (!Number.isSafeInteger(chatId) || !chatId || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid story deletion request');
    await this.client.invoke(new Api.stories.DeleteStories({ peer: this.resolvePeer(chatId), id: ids }));
  }

  async setStoryPinned(chatId: number, storyId: number, pinned: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0 || typeof pinned !== 'boolean') {
      throw new Error('Invalid story pin request');
    }
    await this.client.invoke(new Api.stories.TogglePinned({ peer: this.resolvePeer(chatId), id: [storyId], pinned }));
  }

  async editStoryCaption(chatId: number, storyId: number, caption: string): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0 ||
        typeof caption !== 'string' || caption.length > 2048 || (this.selfId && chatId !== this.selfId)) {
      throw new Error('Invalid story caption edit request');
    }
    await this.client.invoke(new Api.stories.EditStory({ peer: this.resolvePeer(chatId), id: storyId, caption }));
  }

  private async getStoryBlocklist(): Promise<{ ids: string[]; users: any[] }> {
    const ids: string[] = [];
    const users = new Map<string, any>();
    let count = Infinity;
    while (ids.length < count) {
      const page = await this.client.invoke(new Api.contacts.GetBlocked({ myStoriesFrom: true, offset: ids.length, limit: 100 })) as any;
      for (const user of page?.users || []) if (user?.id != null) users.set(String(user.id), user);
      const blocked: any[] = page?.blocked || [];
      for (const entry of blocked) {
        const peer = entry?.peerId;
        if (peer instanceof Api.PeerUser && peer.userId != null) ids.push(String(peer.userId));
      }
      count = Number.isSafeInteger(Number(page?.count)) ? Number(page.count) : ids.length;
      if (!blocked.length || (page?.className === 'Blocked' && ids.length >= count)) break;
      if (ids.length < count && blocked.length < 100) throw new Error('STORY_BLOCKLIST_INCOMPLETE');
    }
    if (ids.length < count) throw new Error('STORY_BLOCKLIST_INCOMPLETE');
    return { ids: [...new Set(ids)], users: [...users.values()] };
  }

  async getStoryPrivacySettings(chatId: number, storyId: number): Promise<any> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0 ||
        !this.selfId || chatId !== this.selfId) throw new Error('Invalid story privacy request');
    const [response, contactResponse, blocked] = await Promise.all([
      this.client.invoke(new Api.stories.GetStoriesByID({ peer: this.resolvePeer(chatId), id: [storyId] })) as Promise<any>,
      this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) })) as Promise<any>,
      this.getStoryBlocklist(),
    ]);
    const story = response?.stories?.find((item: any) => Number(item?.id) === storyId && item?.className === 'StoryItem');
    if (!story || !Array.isArray(story.privacy)) throw new Error('STORY_ID_INVALID');
    const contacts: any[] = contactResponse?.users || [];
    const userMap = new Map<string, any>();
    for (const user of [...contacts, ...(response?.users || []), ...blocked.users]) {
      if (user?.id != null) userMap.set(String(user.id), user);
    }
    const toIds = (values: any[]) => (values || []).map(value => String(value?.toString?.() ?? value))
      .filter((value: string) => /^\d{1,20}$/.test(value) && !/^0+$/.test(value));
    const privacy = story.privacy as any[];
    const flags = story.pFlags || story;
    const hasFlag = (snake: string, camel: string) => Boolean(flags[snake] ?? flags[camel]);
    const privacyType = hasFlag('close_friends', 'closeFriends') || privacy.some(rule => rule?.className === 'PrivacyValueAllowCloseFriends') ? 'close'
      : hasFlag('public', 'public') || privacy.some(rule => rule?.className === 'PrivacyValueAllowAll') ? 'public'
      : hasFlag('selected_contacts', 'selectedContacts') || privacy.some(rule => rule?.className === 'PrivacyValueAllowUsers') ? 'selected'
      : hasFlag('contacts', 'contacts') || privacy.some(rule => rule?.className === 'PrivacyValueAllowContacts') ? 'contacts' : 'selected';
    const listRule = (className: string, field: string) => privacy
      .filter(rule => rule?.className === className).flatMap(rule => toIds(rule[field] || []));
    const everyoneExcept = privacyType === 'public' ? listRule('PrivacyValueDisallowUsers', 'users') : [];
    const contactsExcept = privacyType === 'contacts' ? listRule('PrivacyValueDisallowUsers', 'users') : [];
    const selectedContacts = privacyType === 'selected' ? listRule('PrivacyValueAllowUsers', 'users') : [];
    const unsupportedRules = privacy.filter(rule => ![
      'PrivacyValueAllowAll', 'PrivacyValueAllowContacts', 'PrivacyValueAllowCloseFriends', 'PrivacyValueAllowUsers',
      'PrivacyValueDisallowUsers', 'PrivacyValueAllowChatParticipants', 'PrivacyValueDisallowChatParticipants',
      'PrivacyValueAllowPremium', 'PrivacyValueAllowBots', 'PrivacyValueDisallowBots',
    ].includes(rule?.className || '')).length;
    const people = [...userMap.values()].filter(user => user?.id != null).map(user => ({
      id: String(user.id),
      title: [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : `Telegram 用户 ${user.id}`),
      username: user.username || undefined,
      isBot: Boolean(user.bot),
      deleted: Boolean(user.deleted),
      isContact: Boolean(user.contact),
      closeFriend: Boolean(user.closeFriend),
    }));
    return {
      privacyType, everyoneExcept, contactsExcept, selectedContacts,
      closeFriends: contacts.filter(user => user?.closeFriend && user?.id != null).map(user => String(user.id)),
      hideFrom: blocked.ids,
      people,
      isPinned: Boolean(flags.pinned),
      editable: unsupportedRules === 0,
      unsupportedRules,
    };
  }

  async setStoryPrivacySettings(chatId: number, storyId: number, settings: any): Promise<void> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(storyId) || storyId <= 0 ||
        !this.selfId || chatId !== this.selfId || !settings ||
        !['public', 'contacts', 'close', 'selected'].includes(settings.privacyType)) {
      throw new Error('Invalid story privacy request');
    }
    const readIds = (field: string): string[] => {
      const values = settings[field];
      if (!Array.isArray(values) || values.length > 2000 || values.some((value: any) =>
        typeof value !== 'string' || !/^\d{1,20}$/.test(value) || /^0+$/.test(value))) {
        throw new Error('Invalid story privacy list');
      }
      const unique = [...new Set(values)];
      if (this.selfId && unique.includes(String(this.selfId))) throw new Error('Cannot add the current account to a story privacy list');
      return unique;
    };
    const everyoneExcept = readIds('everyoneExcept');
    const contactsExcept = readIds('contactsExcept');
    const selectedContacts = readIds('selectedContacts');
    const closeFriends = readIds('closeFriends');
    const hideFrom = readIds('hideFrom');
    const [response, contactResponse, blocked] = await Promise.all([
      this.client.invoke(new Api.stories.GetStoriesByID({ peer: this.resolvePeer(chatId), id: [storyId] })) as Promise<any>,
      this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) })) as Promise<any>,
      this.getStoryBlocklist(),
    ]);
    const story = response?.stories?.find((item: any) => Number(item?.id) === storyId && item?.className === 'StoryItem');
    if (!story || !Array.isArray(story.privacy)) throw new Error('STORY_ID_INVALID');
    const contactUsers: any[] = contactResponse?.users || [];
    const usersById = new Map<string, any>();
    for (const user of [...contactUsers, ...(response?.users || []), ...blocked.users]) {
      if (user?.id != null) usersById.set(String(user.id), user);
    }
    const inputUser = (id: string) => {
      const user = usersById.get(id);
      if (!user?.accessHash || user?.deleted || user?.bot) throw new Error(`无法安全解析动态隐私联系人 ${id}`);
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    };
    const inputUsers = (ids: string[]) => ids.map(inputUser);
    const rules: Api.TypeInputPrivacyRule[] = [];
    for (const rule of story.privacy as any[]) {
      switch (rule?.className) {
        case 'PrivacyValueAllowAll': case 'PrivacyValueAllowContacts': case 'PrivacyValueAllowCloseFriends':
        case 'PrivacyValueAllowUsers': case 'PrivacyValueDisallowUsers':
          break;
        case 'PrivacyValueAllowChatParticipants':
          rules.push(new Api.InputPrivacyValueAllowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueDisallowChatParticipants':
          rules.push(new Api.InputPrivacyValueDisallowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueAllowPremium': rules.push(new Api.InputPrivacyValueAllowPremium()); break;
        case 'PrivacyValueAllowBots': rules.push(new Api.InputPrivacyValueAllowBots()); break;
        case 'PrivacyValueDisallowBots': rules.push(new Api.InputPrivacyValueDisallowBots()); break;
        default: throw new Error('动态包含此界面无法安全保留的隐私规则，未执行更改');
      }
    }
    switch (settings.privacyType) {
      case 'public':
        if (everyoneExcept.length) rules.unshift(new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(everyoneExcept) }));
        rules.push(new Api.InputPrivacyValueAllowAll()); break;
      case 'contacts':
        if (contactsExcept.length) rules.unshift(new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(contactsExcept) }));
        rules.push(new Api.InputPrivacyValueAllowContacts()); break;
      case 'close': rules.push(new Api.InputPrivacyValueAllowCloseFriends()); break;
      case 'selected':
        if (selectedContacts.length) rules.push(new Api.InputPrivacyValueAllowUsers({ users: inputUsers(selectedContacts) }));
        break;
    }

    const currentCloseFriends = contactUsers.filter(user => user?.closeFriend && user?.id != null).map(user => String(user.id));
    const closeSet = new Set(closeFriends);
    if (closeFriends.some(id => !usersById.get(id)?.contact || !usersById.get(id)?.accessHash)) {
      throw new Error('密友名单只能包含当前 Telegram 联系人');
    }
    const currentBlocked = new Set(blocked.ids);
    const targetBlocked = new Set(hideFrom);
    const shouldUpdateBlocklist = blocked.ids.length !== hideFrom.length || blocked.ids.some(id => !targetBlocked.has(id));
    const blockedPeers = hideFrom.map(id => {
      const user = usersById.get(id);
      if (!user?.accessHash || user?.deleted || user?.bot) throw new Error(`无法安全解析动态屏蔽联系人 ${id}`);
      return new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
    });
    if (Math.max(blockedPeers.length, currentBlocked.size) > 10000) throw new Error('动态屏蔽名单过大，未执行更改');
    if (currentCloseFriends.length !== closeFriends.length || currentCloseFriends.some(id => !closeSet.has(id))) {
      const closeResult = await this.client.invoke(new Api.contacts.EditCloseFriends({ id: closeFriends.map(id => BigInt(id) as any) }));
      if (closeResult === false) throw new Error('Telegram 未确认密友名单更新');
    }

    if (shouldUpdateBlocklist) {
      const blockedResult = await this.client.invoke(new Api.contacts.SetBlocked({
        myStoriesFrom: true, id: blockedPeers, limit: Math.max(1, blockedPeers.length, currentBlocked.size),
      }));
      if (blockedResult === false) throw new Error('Telegram 未确认动态屏蔽名单更新');
    }
    await this.client.invoke(new Api.stories.EditStory({
      peer: this.resolvePeer(chatId), id: storyId, privacyRules: rules,
    }));
  }

  async readStory(chatId: number, storyId: number): Promise<void> {
    if (!Number.isSafeInteger(storyId) || storyId <= 0) throw new Error('无效的动态');
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(new Api.stories.ReadStories({ peer, maxId: storyId }));
  }

  async exportStoryLink(chatId: number, storyId: number): Promise<string> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(storyId) || storyId <= 0) {
      throw new Error('Invalid story link request');
    }
    const result = await this.client.invoke(new Api.stories.ExportStoryLink({ peer: this.resolvePeer(chatId), id: storyId })) as any;
    if (!(result instanceof Api.ExportedStoryLink) || typeof result.link !== 'string' || !result.link || result.link.length > 2048) {
      throw new Error('Telegram returned an invalid story link');
    }
    return result.link;
  }

  async reactToStory(chatId: number, storyId: number, emoji?: string): Promise<void> {
    if (!Number.isSafeInteger(storyId) || storyId <= 0 || (emoji != null && !isSingleEmoji(emoji))) throw new Error('无效的动态反应');
    await this.client.invoke(new Api.stories.SendReaction({
      peer: this.resolvePeer(chatId), storyId,
      reaction: emoji ? new Api.ReactionEmoji({ emoticon: emoji }) : new Api.ReactionEmpty(),
      addToRecent: Boolean(emoji),
    }));
  }

  async replyToStory(chatId: number, storyId: number, text: string, parseMode: SendOptions['parseMode'] = 'plain'): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || (this.selfId && chatId === this.selfId) ||
        !Number.isSafeInteger(storyId) || storyId <= 0 || typeof text !== 'string' || !text.trim() || text.length > 4096 ||
        ![undefined, 'plain', 'markdown', 'html'].includes(parseMode)) {
      throw new Error('Invalid story reply');
    }
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const prepared = prepareText(text, parseMode || 'plain');
    const [message, entities] = await _parseMessageText(this.client, prepared.text, prepared.parseMode);
    if (!message.trim() || message.length > 4096) throw new Error('Invalid story reply');
    await this.client.invoke(new Api.messages.SendMessage({
      peer, message: message.toString(), entities,
      replyTo: new Api.InputReplyToStory({ peer, storyId }),
      randomId: randomBytes(8).readBigInt64LE() as any,
      noWebpage: true,
    }));
  }

  async setPeerStoriesHidden(chatId: number, hidden: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof hidden !== 'boolean' || (this.selfId && chatId === this.selfId)) {
      throw new Error('Invalid peer stories visibility request');
    }
    await this.client.invoke(new Api.stories.TogglePeerStoriesHidden({ peer: this.resolvePeer(chatId), hidden }));
  }

  async downloadStoryMedia(chatId: number, storyId: number): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!Number.isSafeInteger(storyId) || storyId <= 0 || !this.selfId) throw new Error('无效的动态');
    const peer = this.resolvePeer(chatId);
    const result = await this.client.invoke(new Api.stories.GetStoriesByID({ peer, id: [storyId] })) as any;
    const story = result?.stories?.find((item: any) => item instanceof Api.StoryItem && item.id === storyId);
    const media = story?.media;
    if (media instanceof Api.MessageMediaPhoto) {
      const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
      const filePath = path.resolve('data', 'cache', 'stories', `${namespace}_${chatId}_${storyId}.jpg`);
      const downloaded = await downloadMediaToCache(filePath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadMedia(media, { outputFile: writer as any })));
      return downloaded ? { filePath, mimeType: 'image/jpeg' } : undefined;
    }
    if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
      const document = media.document;
      const video = document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeVideo);
      const declaredMime = document.mimeType.toLowerCase();
      const allowedMimes = new Set(['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp']);
      const mimeType = allowedMimes.has(declaredMime) ? declaredMime : video ? 'video/mp4' : undefined;
      if (!mimeType) return undefined;
      const extension = mimeType === 'video/webm' ? 'webm' : mimeType === 'image/webp' ? 'webp' :
        mimeType === 'image/png' ? 'png' : mimeType === 'video/mp4' ? 'mp4' : 'jpg';
      const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
      const filePath = path.resolve('data', 'cache', 'stories', `${namespace}_${chatId}_${storyId}.${extension}`);
      const downloaded = await downloadMediaToCache(filePath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadMedia(media, { outputFile: writer as any })));
      return downloaded ? { filePath, mimeType } : undefined;
    }
    return undefined;
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

  async getMediaStreamInfo(chatId: number, messageId: number, mediaIndex?: number): Promise<MediaStreamInfo | undefined> {
    if (!this.selfId) throw new Error('Telegram account is not ready');
    return getMediaStreamInfo(this.client, this.resolvePeer(chatId), messageId, this.selfId, mediaIndex);
  }

  async getMediaStreamChunk(chatId: number, messageId: number, info: MediaStreamInfo, offset: number, length: number): Promise<Buffer> {
    if (!this.selfId) throw new Error('Telegram account is not ready');
    return getMediaStreamChunk(this.client, this.resolvePeer(chatId), messageId, this.selfId, info, offset, length);
  }

  async downloadMediaFile(chatId: number, messageId: number, thumb = false, destPath?: string, mediaIndex?: number): Promise<{ filePath: string; mimeType: string; fileName?: string } | undefined> {
    const peer = this.resolvePeer(chatId);
    const msgs = await this.client.getMessages(peer, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg || !msg.media) return undefined;
    let messageMedia: any = msg.media;
    let mediaMessage: Api.Message = msg;
    if (messageMedia instanceof Api.MessageMediaPaidMedia) {
      if (!Number.isSafeInteger(mediaIndex) || mediaIndex! < 0 || mediaIndex! >= messageMedia.extendedMedia.length) return undefined;
      const extended = messageMedia.extendedMedia[mediaIndex!];
      if (!(extended instanceof Api.MessageExtendedMedia)) return undefined;
      messageMedia = extended.media;
      mediaMessage = { ...(msg as any), media: messageMedia, photo: (messageMedia as any).photo,
        document: (messageMedia as any).document } as Api.Message;
    } else if (mediaIndex != null) return undefined;

    const mediaInfo = extractMediaAttachment(mediaMessage);
    if (!mediaInfo) return undefined;
    let ext = 'bin';
    let mime = mediaInfo?.mimeType || 'application/octet-stream';
    let fileName = mediaInfo?.fileName;

    if (mediaInfo?.type === 'photo') {
      ext = 'jpg';
      mime = 'image/jpeg';
    } else if (mediaInfo?.type === 'animation' && mediaInfo.mimeType?.toLowerCase() === 'image/gif') {
      ext = 'gif';
      mime = 'image/gif';
    } else if (mediaInfo?.type === 'animation' && mediaInfo.mimeType?.toLowerCase() === 'video/webm') {
      ext = 'webm';
      mime = 'video/webm';
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
      if (/^[a-zA-Z0-9]{1,12}$/.test(mExt)) ext = mExt;
    }

    if (thumb) {
      mime = 'image/jpeg';
    }

    // A message ID is only unique within an account. Bind cached files to the
    // session path and authenticated Telegram user, including after re-login.
    if (!destPath && !this.selfId) throw new Error('Telegram account is not ready');
    const namespace = destPath ? '' : mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId!);
    const paidIndexSuffix = mediaIndex == null ? '' : `_paid_${mediaIndex}`;
    const targetPath = destPath || path.resolve('data', 'cache', 'media', `${namespace}_${chatId}_${messageId}${paidIndexSuffix}${thumb ? '_thumb.jpg' : `.${ext}`}`);

    try {
      const downloaded = await downloadMediaToCache(targetPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadMedia(messageMedia, {
          outputFile: writer as any,
          thumb: thumb ? 1 : undefined,
        })));
      if (downloaded) {
        return { filePath: targetPath, mimeType: mime, fileName };
      }
    } catch (err: any) {
      this.logger.debug({ chatId, messageId, error: err.message }, 'Failed to download message media');
    }
    return undefined;
  }

  async sendMedia(chatId: number, file: string | Buffer, mediaType: 'photo' | 'video' | 'audio' | 'document' | 'voice', options?: MediaOptions): Promise<number | undefined> {
    if (options?.paidStars != null) {
      if (!['photo', 'video'].includes(mediaType) || typeof file !== 'string' || options.videoNote) {
        throw new Error('Telegram 付费媒体只支持服务器暂存的照片或视频');
      }
      return this.sendMediaAlbum(chatId, [file], options);
    }
    if (options?.videoNote && mediaType !== 'video') throw new Error('Telegram 圆形视频消息只支持视频附件');
    if (mediaType === 'photo') return this.sendPhoto(chatId, file, options);
    if (mediaType === 'video') return this.sendVideo(chatId, file, options);
    if (mediaType === 'audio') return this.sendAudio(chatId, file, options);
    if (mediaType === 'voice') return this.sendVoice(chatId, file, options);
    return this.sendFile(chatId, file, options);
  }

  async sendMediaAlbum(chatId: number, files: string[], options?: MediaOptions): Promise<number | undefined> {
    const paidStars = options?.paidStars;
    if (!Array.isArray(files) || files.length < (paidStars == null ? 2 : 1) || files.length > 10 || files.some(file => typeof file !== 'string' || !file)) {
      throw new Error(paidStars == null ? '相册需要 2 到 10 个有效文件' : '付费媒体需要 1 到 10 个有效文件');
    }
    if (paidStars != null && (!Number.isSafeInteger(paidStars) || paidStars < 1 || paidStars > 1_000_000)) throw new Error('Invalid paid media Stars amount');
    if (options?.scheduleRepeatPeriod != null) throw new Error('Telegram does not support repeating scheduled albums');
    if (paidStars != null && (options?.topMsgId || options?.commentTo)) throw new Error('Paid media can only be sent directly to a broadcast channel');
    if (options?.topMsgId) await this.assertForumReply(chatId, options.topMsgId, options.replyTo || options.topMsgId);
    const peer = this.resolvePeer(chatId);
    if (paidStars != null) {
      for (const file of files) {
        if (!/\.(?:jpe?g|png|webp|heic|heif|mp4|webm|mov|m4v|3gp)$/i.test(path.basename(file))) {
          throw new Error('Telegram 付费媒体只支持照片和视频');
        }
      }
      const entity = await this.client.getEntity(peer);
      if (!(entity instanceof Api.Channel) || !entity.broadcast) throw new Error('Telegram 付费媒体只能发送到频道');
      const inputChannel = await this.client.getInputEntity(entity);
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })) as any;
      if (full?.fullChat?.paidMediaAllowed !== true) throw new Error('Telegram 当前未允许此频道发布付费媒体');
    }
    const formatted = prepareText(options?.caption ?? '', options?.parseMode);
    // GramJS exports this helper internally because its public sendFile array
    // path drops scheduleDate and silent even though SendMultiMedia supports them.
    const albumSender = (require('telegram/client/uploads') as { _sendAlbum: (client: TelegramClient, peer: any, options: any) => Promise<any> })._sendAlbum;
    const effectClient = options?.effectId || options?.invertMedia
      ? this.clientWithMessageEffect(options.effectId, undefined, options?.invertMedia) : this.client;
    const sendClient = paidStars == null ? effectClient : this.clientWithPaidMedia(effectClient, paidStars);
    const sent = await albumSender(sendClient, peer, {
      file: files,
      caption: formatted.text,
      parseMode: formatted.parseMode,
      forceDocument: false,
      replyTo: options?.replyTo,
      commentTo: options?.commentTo,
      topMsgId: options?.topMsgId,
      silent: options?.silent,
      scheduleDate: options?.schedule,
    });
    const first = Array.isArray(sent) ? sent[0] : sent;
    return Number.isSafeInteger(Number(first?.id)) && Number(first.id) > 0 ? Number(first.id) : undefined;
  }

  async sendLocation(chatId: number, latitude: number, longitude: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Invalid location');
    }
    const result = await this.client.invoke(new Api.messages.SendMedia({
      peer: this.resolvePeer(chatId),
      media: new Api.InputMediaGeoPoint({
        geoPoint: new Api.InputGeoPoint({ lat: latitude, long: longitude }),
      }),
      message: '',
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
    return (result as any)?.updates?.find((update: any) => typeof update?.id === 'number')?.id;
  }

  async sendDice(chatId: number, emoticon = '🎲', topMsgId?: number): Promise<number | undefined> {
    const allowedEmoticons = new Set(['🎲', '🎯', '🏀', '⚽', '🎳', '🎰']);
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !allowedEmoticons.has(emoticon) ||
        (topMsgId !== undefined && (!Number.isSafeInteger(topMsgId) || topMsgId <= 0))) {
      throw new Error('Invalid Telegram dice request');
    }
    if (topMsgId !== undefined) await this.assertForumReply(chatId, topMsgId, topMsgId);
    const result = await this.client.invoke(new Api.messages.SendMedia({
      peer: this.resolvePeer(chatId),
      ...(topMsgId !== undefined ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: topMsgId, topMsgId }) } : {}),
      media: new Api.InputMediaDice({ emoticon }),
      message: '',
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
    return TelegramDriver.extractMessageIdFromUpdates(result) ?? (result as any)?.updates?.find((update: any) => typeof update?.id === 'number')?.id;
  }

  async sendLiveLocation(chatId: number, latitude: number, longitude: number, period: number, topMsgId?: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || ![900, 3600, 28800].includes(period) ||
        (topMsgId !== undefined && (!Number.isSafeInteger(topMsgId) || topMsgId <= 0))) {
      throw new Error('Invalid live location');
    }
    if (topMsgId !== undefined) await this.assertForumReply(chatId, topMsgId, topMsgId);
    const result = await this.client.invoke(new Api.messages.SendMedia({
      peer: this.resolvePeer(chatId),
      ...(topMsgId ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: topMsgId, topMsgId }) } : {}),
      media: new Api.InputMediaGeoLive({
        geoPoint: new Api.InputGeoPoint({ lat: latitude, long: longitude }), period,
      }),
      message: '',
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
    const updates = (result as any)?.updates || [];
    const update = updates.find((entry: any) => entry?.className === 'UpdateMessageID') ||
      updates.find((entry: any) => entry?.message?.id != null) || updates.find((entry: any) => typeof entry?.id === 'number');
    const id = Number(update?.message?.id ?? update?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  async editLiveLocation(chatId: number, messageId: number, options: { latitude?: number; longitude?: number; period?: number; stopped?: boolean }): Promise<void> {
    const stopped = options?.stopped === true;
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !options || typeof options !== 'object' ||
        (!stopped && (!Number.isFinite(options.latitude) || options.latitude! < -90 || options.latitude! > 90 ||
          !Number.isFinite(options.longitude) || options.longitude! < -180 || options.longitude! > 180 ||
          !Number.isSafeInteger(options.period) || options.period! < 1 || options.period! > 28800))) {
      throw new Error('Invalid live location update');
    }
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    if (!message || Number(message.id) !== messageId || message.out !== true || message.media?.className !== 'MessageMediaGeoLive') {
      throw new Error('Live location is not an outgoing Telegram live location');
    }
    const geo = message.media.geo;
    const latitude = stopped ? Number(geo?.lat) : options.latitude!;
    const longitude = stopped ? Number(geo?.long) : options.longitude!;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Telegram live location has invalid coordinates');
    }
    await this.client.invoke(new Api.messages.EditMessage({
      peer, id: messageId,
      media: new Api.InputMediaGeoLive({
        geoPoint: new Api.InputGeoPoint({ lat: latitude, long: longitude }),
        ...(stopped ? { stopped: true } : { period: options.period }),
      }),
    }));
  }

  async sendContact(chatId: number, phoneNumber: string, firstName: string, lastName = ''): Promise<number | undefined> {
    const phone = phoneNumber.trim();
    const first = firstName.trim();
    const last = lastName.trim();
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !/^\+?[0-9 ()-]{3,32}$/.test(phone) || phone.replace(/\D/g, '').length < 3 ||
        !first || first.length > 64 || last.length > 64) {
      throw new Error('Invalid contact');
    }
    const result = await this.client.invoke(new Api.messages.SendMedia({
      peer: this.resolvePeer(chatId),
      media: new Api.InputMediaContact({ phoneNumber: phone, firstName: first, lastName: last, vcard: '' }),
      message: '',
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
    return (result as any)?.updates?.find((update: any) => typeof update?.id === 'number')?.id;
  }

  private async getReplyKeyboardRequestButton(chatId: number, messageId: number, row: number, column: number): Promise<any> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
      throw new Error('Invalid bot keyboard request');
    }
    const messages = await this.client.getMessages(this.resolvePeer(chatId), { ids: [messageId] });
    const message = messages?.[0];
    if (!message || Number(message.id) !== messageId || !(message.replyMarkup instanceof Api.ReplyKeyboardMarkup)) {
      throw new Error('Bot request keyboard is no longer available');
    }
    const sender = await message.getSender();
    if (!(sender instanceof Api.User) || !sender.bot) throw new Error('Reply keyboard sender is not a bot');
    const button = message.replyMarkup.rows[row]?.buttons[column];
    if (!button) throw new Error('Bot request button is unavailable');
    return button;
  }

  async sendReplyKeyboardPhone(chatId: number, messageId: number, row: number, column: number): Promise<number | undefined> {
    const button = await this.getReplyKeyboardRequestButton(chatId, messageId, row, column);
    if (!(button instanceof Api.KeyboardButtonRequestPhone)) throw new Error('Bot did not request a phone number');
    const self = await this.client.getMe();
    const phone = typeof self.phone === 'string' ? self.phone.trim() : '';
    if (!/^\+?[0-9 ()-]{3,32}$/.test(phone) || phone.replace(/\D/g, '').length < 3 || !self.firstName) {
      throw new Error('Current Telegram account has no shareable phone number');
    }
    return this.sendContact(chatId, phone, self.firstName, self.lastName || '');
  }

  async sendReplyKeyboardLocation(chatId: number, messageId: number, row: number, column: number, latitude: number, longitude: number): Promise<number | undefined> {
    const button = await this.getReplyKeyboardRequestButton(chatId, messageId, row, column);
    if (!(button instanceof Api.KeyboardButtonRequestGeoLocation)) throw new Error('Bot did not request a location');
    return this.sendLocation(chatId, latitude, longitude);
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
    let msgs: any[];
    let savedMessageEntities: Map<string, any> | undefined;
    if (options?.savedReaction) {
      if (!this.selfId || Number(chatId) !== this.selfId) throw new Error('Saved tags are only available in Saved Messages');
      const reaction = savedTagReaction(options.savedReaction);
      const result = await this.client.invoke(new Api.messages.Search({
        peer,
        q: options.search || '',
        savedReaction: [reaction],
        filter: searchMessagesFilter(options.searchFilter),
        minDate: 0,
        maxDate: 0,
        offsetId: options.offsetId ?? 0,
        addOffset: options.addOffset ?? 0,
        limit: options.limit ?? 20,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      })) as any;
      savedMessageEntities = new Map<string, any>();
      for (const entity of [...(result?.users || []), ...(result?.chats || [])]) {
        try { savedMessageEntities.set(getPeerId(entity), entity); } catch { /* ignore incomplete entities */ }
      }
      msgs = Array.isArray(result?.messages) ? result.messages : [];
    } else {
      msgs = await this.client.getMessages(peer, {
        limit: options?.limit ?? 20,
        offsetId: options?.offsetId,
        addOffset: options?.addOffset,
        offsetDate: options?.offsetDate,
        ids: options?.ids,
        search: options?.search,
        filter: options?.searchFilter ? searchMessagesFilter(options.searchFilter) : undefined,
      });
    }

    const hasOtherOpenPoll = msgs.some((message: any) => {
      const raw = message as any;
      if (!(message instanceof Api.Message) || Boolean(raw.out ?? raw.outgoing)) return false;
      const poll = raw.poll || raw.media?.poll;
      return Boolean(poll && !poll.closed);
    });
    const canClosePoll = hasOtherOpenPoll ? await this.canCloseOtherPolls(chatId) : false;

    const result: IncomingMessage[] = [];
    for (const m of msgs) {
      if (m && m instanceof Api.Message) {
        if (savedMessageEntities) {
          (m as any)._finishInit(this.client, savedMessageEntities, undefined);
          (m as any)._entities = savedMessageEntities;
        }
        const mapped = await this.mapMessage(m, canClosePoll);
        if (mapped) result.push(mapped);
      }
    }
    return result;
  }

  /** Restore the last reply keyboard on initial chat open when it predates the visible history window. */
  async getReplyKeyboardState(chatId: number): Promise<{ message?: IncomingMessage; latestMessageId: number; complete: boolean }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid chat ID');
    const peer = this.resolvePeer(chatId);
    const pageSize = 100, maxScan = 1000;
    let offsetId: number | undefined;
    let scanned = 0, latestMessageId = 0;
    const outgoingAfter: Array<{ id: number; replyToId?: number }> = [];
    const visitedOffsets = new Set<number>();
    while (scanned < maxScan) {
      const limit = Math.min(pageSize, maxScan - scanned);
      const fetched = await this.client.getMessages(peer, { limit, offsetId });
      const page = [...fetched].filter((message: any) => message instanceof Api.Message)
        .sort((a: any, b: any) => Number(b.id) - Number(a.id));
      if (!page.length) return { latestMessageId, complete: true };
      if (!latestMessageId) latestMessageId = Number(page[0].id) || 0;
      scanned += page.length;
      for (const message of page as Api.Message[]) {
        const id = Number(message.id);
        const keyboard = mapBotReplyKeyboard(message.replyMarkup);
        // Ordinary inline buttons stay in their own bubble. Selective markup
        // addressed to another participant does not replace this account's
        // active reply keyboard.
        if (keyboard && !(keyboard.selective && !(message as any).mentioned)) {
          const wasUsed = outgoingAfter.some(outgoing =>
            keyboard.type === 'force' ? outgoing.replyToId === id : keyboard.singleUse && outgoing.id > id);
          const mapped = await this.mapMessage(message);
          if (mapped?.replyKeyboard) {
            if (wasUsed) mapped.replyKeyboard = { type: 'hide' };
            return { message: mapped, latestMessageId, complete: true };
          }
        }
        if (message.out && String(message.message || '').length) {
          outgoingAfter.push({ id, replyToId: Number(message.replyTo?.replyToMsgId) || undefined });
        }
      }
      const nextOffset = Number(page[page.length - 1]?.id);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= 0 || visitedOffsets.has(nextOffset) || page.length < limit) {
        return { latestMessageId, complete: true };
      }
      visitedOffsets.add(nextOffset);
      offsetId = nextOffset;
    }
    return { latestMessageId, complete: false };
  }

  async getPinnedMessages(chatId: number, limit = 30, offsetId?: number): Promise<{ messages: IncomingMessage[]; total: number; nextOffsetId?: number }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        (offsetId !== undefined && (!Number.isSafeInteger(offsetId) || offsetId <= 0))) {
      throw new Error('Invalid pinned messages request');
    }
    const result = await this.client.getMessages(this.resolvePeer(chatId), {
      limit,
      offsetId,
      filter: new Api.InputMessagesFilterPinned(),
    });
    const rawMessages = Array.from(result).filter((message: any) => message instanceof Api.Message);
    const messages: IncomingMessage[] = [];
    for (const message of rawMessages) {
      const mapped = await this.mapMessage(message);
      if (mapped) messages.push(mapped);
    }
    const lastId = rawMessages.length >= limit ? Number(rawMessages[rawMessages.length - 1]?.id) : undefined;
    return {
      messages,
      total: Number((result as any).total) || rawMessages.length,
      nextOffsetId: Number.isSafeInteger(lastId) && lastId! > 0 ? lastId : undefined,
    };
  }

  private async canCloseOtherPolls(chatId: number): Promise<boolean> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !this.selfId) return false;
    try {
      const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
      if (peer instanceof Api.InputPeerChat) {
        const result = await this.client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId })) as any;
        const participants = result?.fullChat?.participants;
        const participantList = participants?.participants || [];
        const self = participantList.find((participant: any) =>
          Number(participant.userId?.toString?.() ?? participant.userId) === this.selfId) ||
          participants?.selfParticipant;
        if (self && Number(self.userId?.toString?.() ?? self.userId) !== this.selfId) return false;
        return self?.className === 'ChatParticipantCreator' || self?.className === 'ChatParticipantAdmin' ||
          self instanceof Api.ChatParticipantCreator || self instanceof Api.ChatParticipantAdmin;
      }
      if (peer instanceof Api.InputPeerChannel) {
        const participant = await this.client.invoke(new Api.channels.GetParticipant({
          channel: peer, participant: new Api.InputUserSelf(),
        })) as any;
        const role = participant?.participant || participant;
        if (role?.className === 'ChannelParticipantCreator' || role instanceof Api.ChannelParticipantCreator) return true;
        if (role?.className !== 'ChannelParticipantAdmin' && !(role instanceof Api.ChannelParticipantAdmin)) return false;
        return Boolean(role.adminRights?.editMessages);
      }
    } catch {
      // The server remains authoritative; hide the action if role lookup is unavailable.
    }
    return false;
  }

  /** Retrieve one server-ordered page of a supergroup's forum topics. */
  async getForumTopics(chatId: number, offset?: { date: number; messageId: number; topicId: number }): Promise<any> {
    const result = await this.client.invoke(new Api.channels.GetForumTopics({
      channel: this.resolvePeer(chatId), limit: 50,
      offsetDate: offset?.date || 0, offsetId: offset?.messageId || 0, offsetTopic: offset?.topicId || 0,
    }));
    const dates = new Map<number, number>();
    for (const message of result.messages) {
      if ('id' in message && 'date' in message) dates.set(message.id, Number(message.date));
    }
    const topics = result.topics.filter((topic): topic is Api.ForumTopic => topic instanceof Api.ForumTopic).map(topic => ({
      id: topic.id, title: topic.title, closed: Boolean(topic.closed), hidden: Boolean(topic.hidden),
      pinned: Boolean(topic.pinned), unreadCount: topic.unreadCount, topMessage: topic.topMessage, date: topic.date,
      iconColor: Number.isSafeInteger(topic.iconColor) && topic.iconColor >= 0 && topic.iconColor <= 0xffffff ? topic.iconColor : 0,
      ...(topic.iconEmojiId && /^[1-9]\d{0,19}$/.test(String(topic.iconEmojiId)) ? { iconEmojiId: String(topic.iconEmojiId) } : {}),
    }));
    const last = result.topics[result.topics.length - 1];
    const date = last instanceof Api.ForumTopic ? (result.orderByCreateDate ? last.date : dates.get(last.topMessage)) : undefined;
    const nextCursor = result.topics.length >= 50 && last instanceof Api.ForumTopic && date
      ? { date, messageId: last.topMessage, topicId: last.id } : undefined;
    return { topics, nextCursor, incomplete: result.topics.length >= 50 && !nextCursor };
  }

  async createForumTopic(chatId: number, title: string): Promise<void> {
    const normalizedTitle = title.trim();
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !normalizedTitle || normalizedTitle.length > 128) {
      throw new Error('Invalid forum topic title');
    }
    await this.client.invoke(new Api.channels.CreateForumTopic({
      channel: this.resolvePeer(chatId),
      title: normalizedTitle,
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
  }

  async editForumTopic(chatId: number, topicId: number, options: { title?: string; closed?: boolean; hidden?: boolean }): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 ||
        (options.title !== undefined && (!options.title.trim() || options.title.trim().length > 128)) ||
        (options.closed !== undefined && typeof options.closed !== 'boolean') ||
        (options.hidden !== undefined && typeof options.hidden !== 'boolean')) {
      throw new Error('Invalid forum topic update');
    }
    await this.client.invoke(new Api.channels.EditForumTopic({
      channel: this.resolvePeer(chatId), topicId,
      title: options.title?.trim(), closed: options.closed, hidden: options.hidden,
    }));
  }

  async setForumTopicPinned(chatId: number, topicId: number, pinned: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 || typeof pinned !== 'boolean') {
      throw new Error('Invalid forum topic pin state');
    }
    await this.client.invoke(new Api.channels.UpdatePinnedForumTopic({
      channel: this.resolvePeer(chatId), topicId, pinned,
    }));
  }

  async movePinnedForumTopic(chatId: number, topicId: number, direction: 'up' | 'down'): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 || !['up', 'down'].includes(direction)) {
      throw new Error('Invalid pinned forum topic move');
    }
    const topics: any[] = [];
    let offset: { date: number; messageId: number; topicId: number } | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const result = await this.getForumTopics(chatId, offset);
      if (result.incomplete) throw new Error('无法获取完整话题列表，未调整置顶顺序');
      topics.push(...(Array.isArray(result.topics) ? result.topics : []));
      const next = result.nextCursor;
      if (!next) break;
      const cursorKey = JSON.stringify(next);
      if (seenCursors.has(cursorKey)) throw new Error('话题分页游标重复，未调整置顶顺序');
      seenCursors.add(cursorKey);
      offset = next;
      if (page === 999) throw new Error('话题列表过长，未调整置顶顺序');
    }
    const order = topics.filter(topic => topic.pinned).map(topic => Number(topic.id));
    const index = order.indexOf(topicId);
    if (index < 0) throw new Error('此话题当前没有置顶');
    const adjacent = index + (direction === 'up' ? -1 : 1);
    if (adjacent < 0 || adjacent >= order.length) throw new Error('此话题已在置顶列表边界');
    [order[index], order[adjacent]] = [order[adjacent], order[index]];
    await this.client.invoke(new Api.channels.ReorderPinnedForumTopics({
      channel: this.resolvePeer(chatId), order,
    }));
  }

  async deleteForumTopic(chatId: number, topicId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 1) {
      throw new Error('Invalid forum topic');
    }
    await this.client.invoke(new Api.channels.DeleteTopicHistory({ channel: this.resolvePeer(chatId), topMsgId: topicId }));
  }

  async getForumMessages(chatId: number, topicId: number, offsetId?: number): Promise<IncomingMessage[]> {
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { replyTo: topicId, limit: 50, offsetId });
    const result: IncomingMessage[] = [];
    for (const message of messages) {
      if (message instanceof Api.Message) {
        const mapped = await this.mapMessage(message);
        if (mapped) result.push(mapped);
      }
    }
    return result;
  }

  async markForumTopicAsRead(chatId: number, topicId: number, maxId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(topicId) || topicId <= 0 ||
        !Number.isSafeInteger(maxId) || maxId <= 0) {
      throw new Error('Invalid forum topic read boundary');
    }
    const accepted = await this.client.invoke(new Api.messages.ReadDiscussion({
      peer: this.resolvePeer(chatId), msgId: topicId, readMaxId: maxId,
    }));
    if (accepted === false) throw new Error('Telegram 未确认话题已读');
  }

  async sendForumMessage(chatId: number, topicId: number, text: string, replyTo?: number): Promise<number | undefined> {
    const peer = this.resolvePeer(chatId);
    await this.assertForumReply(chatId, topicId, replyTo || topicId);
    const sent = await this.client.sendMessage(peer, { message: text, parseMode: false, replyTo: replyTo || topicId, topMsgId: topicId });
    return sent?.id;
  }

  /** Resolve a channel post's linked discussion and fetch its replies. */
  async getChannelComments(chatId: number, messageId: number, limit = 50, offsetId?: number): Promise<IncomingMessage[]> {
    try {
    const discussion = await getCommentData(this.client, this.resolvePeer(chatId), messageId);
    const messages = await this.client.getMessages(discussion.entity, {
      replyTo: discussion.replyTo,
      limit: Math.max(1, Math.min(limit, 100)),
      offsetId,
    });
    const result: IncomingMessage[] = [];
    for (const message of messages) {
      if (message instanceof Api.Message) {
        const mapped = await this.mapMessage(message);
        if (mapped) result.push(mapped);
      }
    }
    return result;
    } catch (error) { throw discussionError(error); }
  }

  /** Let GramJS resolve the linked discussion each time, including permissions. */
  async sendChannelComment(chatId: number, messageId: number, text: string): Promise<number | undefined> {
    try {
    const sent = await this.client.sendMessage(this.resolvePeer(chatId), {
      message: text,
      commentTo: messageId,
      parseMode: false,
    });
    return sent?.id;
    } catch (error) { throw discussionError(error); }
  }

  async searchMessages(chatId: number, query: string, limit = 20): Promise<IncomingMessage[]> {
    return this.getMessages(chatId, { search: query, limit });
  }

  // --- 群组与频道管理 ---

  private async resolveAdminInputUser(userId: number): Promise<Api.TypeInputUser> {
    const input = await this.client.getInputEntity(this.resolvePeer(userId));
    if (input instanceof Api.InputUser || input instanceof Api.InputUserSelf || input instanceof Api.InputUserFromMessage) return input;
    if (input instanceof Api.InputPeerSelf) return new Api.InputUserSelf();
    if (input instanceof Api.InputPeerUser) return new Api.InputUser({ userId: input.userId, accessHash: input.accessHash });
    if (input instanceof Api.InputPeerUserFromMessage) {
      return new Api.InputUserFromMessage({ peer: input.peer, msgId: input.msgId, userId: input.userId });
    }
    throw new Error('无法解析群成员账号');
  }

  private async resolveAdminInputChannel(chatId: number): Promise<Api.TypeInputChannel> {
    const input = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (input instanceof Api.InputChannel || input instanceof Api.InputChannelFromMessage) return input;
    if (input instanceof Api.InputPeerChannel) return new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash });
    if (input instanceof Api.InputPeerChannelFromMessage) {
      return new Api.InputChannelFromMessage({ peer: input.peer, msgId: input.msgId, channelId: input.channelId });
    }
    throw new Error('此管理操作仅支持超级群或频道');
  }

  async banUser(chatId: number, userId: number, untilDate = 0): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 ||
        !Number.isSafeInteger(untilDate) || (untilDate !== 0 && (untilDate <= now || untilDate > now + 31536000))) {
      throw new Error('Invalid ban target or duration');
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    const participant = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.channels.EditBanned({
      channel, participant,
      bannedRights: new Api.ChatBannedRights({ viewMessages: true, untilDate: untilDate || 0 }),
    }));
  }

  async unbanUser(chatId: number, userId: number): Promise<void> {
    const channel = await this.resolveAdminInputChannel(chatId);
    const participant = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.channels.EditBanned({
      channel, participant, bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
    }));
  }

  async kickUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    await this.client.kickParticipant(peer, userPeer);
  }

  async muteUser(chatId: number, userId: number, seconds: number): Promise<void> {
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31536000) throw new Error('Invalid mute duration');
    const channel = await this.resolveAdminInputChannel(chatId);
    const participant = await this.resolveAdminInputUser(userId);
    const untilDate = seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0;
    await this.client.invoke(new Api.channels.EditBanned({
      channel, participant,
      bannedRights: new Api.ChatBannedRights({ sendMessages: true, sendMedia: true, untilDate }),
    }));
  }

  async unmuteUser(chatId: number, userId: number): Promise<void> {
    const channel = await this.resolveAdminInputChannel(chatId);
    const participant = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.channels.EditBanned({
      channel, participant, bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
    }));
  }

  async promoteUser(chatId: number, userId: number, perms?: AdminPermissions): Promise<void> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(userId) || !userId) throw new Error('Invalid admin target');
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.EditChatAdmin({
        chatId: peer.chatId, userId: await this.resolveAdminInputUser(userId), isAdmin: true,
      }));
      return;
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    const user = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.channels.EditAdmin({
      channel, userId: user,
      adminRights: new Api.ChatAdminRights({
        changeInfo: perms?.changeInfo ?? true, postMessages: perms?.postMessages ?? true,
        editMessages: perms?.editMessages ?? true, deleteMessages: perms?.deleteMessages ?? true,
        banUsers: perms?.banUsers ?? true, inviteUsers: perms?.inviteUsers ?? true,
        pinMessages: perms?.pinMessages ?? true, addAdmins: perms?.addAdmins ?? false,
        anonymous: perms?.anonymous ?? false, manageCall: perms?.manageCall ?? true,
        manageTopics: perms?.manageTopics ?? false, postStories: perms?.postStories ?? false,
        editStories: perms?.editStories ?? false, deleteStories: perms?.deleteStories ?? false,
      }),
      rank: '',
    }));
  }

  async demoteUser(chatId: number, userId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(userId) || !userId) throw new Error('Invalid admin target');
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.EditChatAdmin({
        chatId: peer.chatId, userId: await this.resolveAdminInputUser(userId), isAdmin: false,
      }));
      return;
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    const user = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.channels.EditAdmin({
      channel, userId: user, adminRights: new Api.ChatAdminRights({}), rank: '',
    }));
  }

  async getParticipants(chatId: number, limit = 100): Promise<ParticipantInfo[]> {
    const peer = this.resolvePeer(chatId);
    const inputPeer = await this.client.getInputEntity(peer);
    const supportsCustomAdminRights = inputPeer instanceof Api.InputPeerChannel;
    const participants = await this.client.getParticipants(peer, { limit });
    return this.mapParticipantEntities(participants as any[], supportsCustomAdminRights);
  }

  private mapParticipantEntities(participants: any[], supportsCustomAdminRights: boolean): ParticipantInfo[] {
    const res: ParticipantInfo[] = [];

    for (const p of participants) {
      const user = userFromEntity(p as any);
      if (!user) continue;

      let role: ParticipantInfo['role'] = 'member';
      const participant = (p as any).participant;
      const pClass = participant?.className || '';
      if (pClass.includes('Creator')) role = 'owner';
      else if (pClass.includes('Admin')) role = 'admin';
      else if (pClass.includes('Banned')) role = 'banned';
      else if (pClass.includes('Left')) role = 'left';

      res.push({
        user,
        role,
        joinedDate: participant?.date,
        supportsCustomAdminRights,
        adminPermissions: participant?.adminRights ? {
          changeInfo: Boolean(participant.adminRights.changeInfo), postMessages: Boolean(participant.adminRights.postMessages),
          editMessages: Boolean(participant.adminRights.editMessages), deleteMessages: Boolean(participant.adminRights.deleteMessages),
          banUsers: Boolean(participant.adminRights.banUsers), inviteUsers: Boolean(participant.adminRights.inviteUsers),
          pinMessages: Boolean(participant.adminRights.pinMessages), addAdmins: Boolean(participant.adminRights.addAdmins),
          anonymous: Boolean(participant.adminRights.anonymous), manageCall: Boolean(participant.adminRights.manageCall),
          manageTopics: Boolean(participant.adminRights.manageTopics), postStories: Boolean(participant.adminRights.postStories),
          editStories: Boolean(participant.adminRights.editStories), deleteStories: Boolean(participant.adminRights.deleteStories),
        } : undefined,
      });
    }

    return res;
  }

  async getParticipantsPage(chatId: number, offset = 0, limit = 50, query = ''): Promise<ParticipantsPage> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof query !== 'string' || query.length > 128) {
      throw new Error('Invalid participant query');
    }
    const peer = this.resolvePeer(chatId);
    const inputPeer = await this.client.getInputEntity(peer);
    const trimmedQuery = query.trim();

    if (inputPeer instanceof Api.InputPeerChannel) {
      const response: any = await this.client.invoke(new Api.channels.GetParticipants({
        channel: inputPeer,
        filter: new Api.ChannelParticipantsSearch({ q: trimmedQuery }),
        offset,
        limit,
        hash: bigInt.zero,
      }));
      const users = new Map<string, any>();
      for (const user of response.users || []) users.set(String(user.id), user);
      const entities = (response.participants || []).flatMap((participant: any) => {
        const participantUserId = participant.userId ?? participant.peer?.userId;
        const user = users.get(String(participantUserId));
        return user ? [{ ...user, participant }] : [];
      });
      const participants = this.mapParticipantEntities(entities, true);
      const count = Math.max(0, Number(response.count) || 0);
      const nextOffset = offset + (response.participants?.length || 0);
      return { count, participants, ...(nextOffset < count && response.participants?.length ? { nextOffset } : {}) };
    }

    if (inputPeer instanceof Api.InputPeerChat) {
      // Basic groups do not expose a server-side participant search endpoint. Telegram
      // returns their full roster, so filter it locally and paginate the matching rows.
      const all = await this.client.getParticipants(peer, { limit: Number.MAX_SAFE_INTEGER });
      const normalizedQuery = trimmedQuery.toLocaleLowerCase();
      const filtered = normalizedQuery ? all.filter((entry: any) => {
        const user = userFromEntity(entry);
        const name = `${user?.firstName || ''} ${user?.lastName || ''}`.toLocaleLowerCase();
        const username = String(user?.username || '').toLocaleLowerCase();
        return name.includes(normalizedQuery) || username.includes(normalizedQuery) || String(user?.id || '').includes(normalizedQuery);
      }) : all;
      const page = filtered.slice(offset, offset + limit) as any[];
      const participants = this.mapParticipantEntities(page, false);
      const nextOffset = offset + page.length;
      return { count: filtered.length, participants, ...(nextOffset < filtered.length && page.length ? { nextOffset } : {}) };
    }

    throw new Error('只能读取群组或频道成员');
  }

  async getBannedParticipants(chatId: number, offset = 0, limit = 50, query = ''): Promise<{
    count: number;
    participants: Array<{ user: UserRef; date: number; untilDate?: number }>;
    nextOffset?: number;
  }> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof query !== 'string' || query.length > 128) {
      throw new Error('Invalid banned participant query');
    }
    const pageSize = Math.min(limit, 50);
    const channel = await this.resolveAdminInputChannel(chatId);
    const response = await this.client.invoke(new Api.channels.GetParticipants({
      channel,
      filter: new Api.ChannelParticipantsKicked({ q: query }),
      offset,
      limit: pageSize,
      hash: bigInt(0),
    })) as any;
    const users = new Map<string, UserRef>();
    for (const raw of Array.isArray(response?.users) ? response.users : []) {
      const user = userFromEntity(raw);
      if (user) users.set(String(user.id), user);
    }
    const rawParticipants = Array.isArray(response?.participants) ? response.participants : [];
    const participants = rawParticipants.flatMap((participant: any) => {
      const userId = participant?.peer instanceof Api.PeerUser ? Number(participant.peer.userId.toString()) : 0;
      const user = users.get(String(userId));
      if (!user) return [];
      const untilDate = Number(participant?.bannedRights?.untilDate) || 0;
      return [{ user, date: Math.max(0, Number(participant?.date) || 0), ...(untilDate > 0 ? { untilDate } : {}) }];
    });
    const count = Math.max(0, Number(response?.count) || participants.length);
    const nextOffset = rawParticipants.length === pageSize && offset + rawParticipants.length < count
      ? offset + rawParticipants.length : undefined;
    return { count, participants, ...(nextOffset == null ? {} : { nextOffset }) };
  }

  private mapChatInviteLink(item: any): ChatInviteLinkInfo | undefined {
    if (!(item instanceof Api.ChatInviteExported)) return undefined;
    const link = telegramInviteLink(item.link);
    if (!link) return undefined;
    const expireDate = Number(item.expireDate) || 0;
    const usageLimit = Number(item.usageLimit) || 0;
    return {
      link,
      ...(typeof item.title === 'string' && item.title ? { title: item.title.slice(0, 32) } : {}),
      date: Math.max(0, Number(item.date) || 0),
      ...(expireDate > 0 ? { expireDate } : {}),
      ...(usageLimit > 0 ? { usageLimit } : {}),
      usage: Math.max(0, Number(item.usage) || 0),
      requestNeeded: Boolean(item.requestNeeded),
      revoked: Boolean(item.revoked),
    };
  }

  async getChatInviteLinks(chatId: number, cursor?: { date: number; link: string }, limit = 50): Promise<ChatInviteLinksPage> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (cursor && (!Number.isSafeInteger(cursor.date) || cursor.date < 0 || !telegramInviteLink(cursor.link)))) {
      throw new Error('Invalid Telegram invite link query');
    }
    const pageSize = Math.min(limit, 50);
    const result = await this.client.invoke(new Api.messages.GetExportedChatInvites({
      peer: this.resolvePeer(chatId), adminId: new Api.InputUserSelf(), revoked: false,
      offsetDate: cursor?.date || 0, offsetLink: cursor?.link || '', limit: pageSize,
    })) as any;
    const rawLinks = Array.isArray(result?.invites) ? result.invites : [];
    const links = rawLinks.flatMap((item: any) => {
      const mapped = this.mapChatInviteLink(item);
      return mapped ? [mapped] : [];
    });
    const last = rawLinks[rawLinks.length - 1];
    const nextCursor = rawLinks.length === pageSize && last instanceof Api.ChatInviteExported &&
      Number.isSafeInteger(Number(last.date)) && telegramInviteLink(last.link)
      ? { date: Number(last.date), link: String(last.link) } : undefined;
    return { count: Math.max(0, Number(result?.count) || links.length), links, ...(nextCursor ? { nextCursor } : {}) };
  }

  async createChatInviteLink(chatId: number, options: { title?: string; expireDate?: number; usageLimit?: number; requestNeeded?: boolean }): Promise<ChatInviteLinkInfo> {
    const title = options?.title;
    const expireDate = options?.expireDate;
    const usageLimit = options?.usageLimit;
    const requestNeeded = options?.requestNeeded ?? false;
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !options || typeof options !== 'object' ||
        (title !== undefined && (typeof title !== 'string' || title.trim().length > 32 || /[\u0000-\u001f]/.test(title))) ||
        (expireDate !== undefined && (!Number.isSafeInteger(expireDate) || expireDate <= Math.floor(Date.now() / 1000))) ||
        (usageLimit !== undefined && (!Number.isSafeInteger(usageLimit) || usageLimit < 1 || usageLimit > 99999)) ||
        typeof requestNeeded !== 'boolean') throw new Error('Invalid Telegram invite link options');
    const result = await this.client.invoke(new Api.messages.ExportChatInvite({
      peer: this.resolvePeer(chatId),
      ...(requestNeeded ? { requestNeeded: true } : {}),
      ...(expireDate === undefined ? {} : { expireDate }),
      ...(usageLimit === undefined ? {} : { usageLimit }),
      ...(title?.trim() ? { title: title.trim() } : {}),
    })) as any;
    const mapped = this.mapChatInviteLink(result);
    if (!mapped) throw new Error('Telegram did not return a valid invite link');
    return mapped;
  }

  async revokeChatInviteLink(chatId: number, link: string): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !telegramInviteLink(link)) throw new Error('Invalid Telegram invite link');
    const result = await this.client.invoke(new Api.messages.EditExportedChatInvite({
      peer: this.resolvePeer(chatId), link, revoked: true,
    })) as any;
    if (result === false) throw new Error('Telegram did not confirm invite link revocation');
  }

  async editChatInviteLink(chatId: number, link: string, title: string): Promise<ChatInviteLinkInfo> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !telegramInviteLink(link) || typeof title !== 'string' ||
        title.trim().length > 32 || /[\u0000-\u001f]/.test(title)) throw new Error('Invalid Telegram invite link title');
    const result = await this.client.invoke(new Api.messages.EditExportedChatInvite({
      peer: this.resolvePeer(chatId), link, title: title.trim(),
    })) as any;
    const mapped = this.mapChatInviteLink(result);
    if (!mapped) throw new Error('Telegram did not return the updated invite link');
    return mapped;
  }

  async getJoinRequests(chatId: number, cursor?: { date: number; userId: number }, limit = 50, query = ''): Promise<JoinRequestsPage> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || (cursor &&
        (!Number.isSafeInteger(cursor.date) || cursor.date <= 0 || !Number.isSafeInteger(cursor.userId) || cursor.userId <= 0)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof query !== 'string' || query.length > 128) throw new Error('Invalid join request query');
    const pageSize = Math.max(1, Math.min(Math.floor(limit), 50));
    const peer = await this.resolveAdminInputChannel(chatId);
    const offsetUser = cursor ? await this.resolveAdminInputUser(cursor.userId) : new Api.InputUserEmpty();
    const result = await this.client.invoke(new Api.messages.GetChatInviteImporters({
      peer, requested: true, offsetDate: cursor?.date || 0, offsetUser, limit: pageSize, q: query || undefined,
    })) as any;
    const users = new Map<string, UserRef>();
    for (const entity of result?.users || []) {
      const user = userFromEntity(entity);
      if (user) users.set(String(user.id), user);
    }
    const importers = (result?.importers || []).filter((entry: any) => entry?.requested !== false);
    const requests = importers.flatMap((entry: any) => {
      const user = users.get(String(entry.userId));
      if (!user) return [];
      return [{ user, date: Number(entry.date) || 0, about: entry.about || undefined }];
    });
    const last = importers[importers.length - 1];
    const lastUserId = last?.userId == null ? 0 : Number(String(last.userId));
    const nextCursor = importers.length >= pageSize && Number.isSafeInteger(lastUserId) && lastUserId > 0 && Number(last.date) > 0
      ? { date: Number(last.date), userId: lastUserId } : undefined;
    return { count: Number(result?.count || 0), requests, nextCursor };
  }

  async decideJoinRequest(chatId: number, userId: number, approved: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0 || typeof approved !== 'boolean') {
      throw new Error('Invalid join request decision');
    }
    const peer = await this.resolveAdminInputChannel(chatId);
    const user = await this.resolveAdminInputUser(userId);
    await this.client.invoke(new Api.messages.HideChatJoinRequest({ peer, userId: user, approved }));
  }

  async decideAllJoinRequests(chatId: number, approved: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof approved !== 'boolean') throw new Error('Invalid bulk join request decision');
    const peer = await this.resolveAdminInputChannel(chatId);
    await this.client.invoke(new Api.messages.HideAllChatJoinRequests({ peer, approved }));
  }

  async inviteUser(chatId: number, userId: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const userPeer = this.resolvePeer(userId);
    const inputPeer = await this.client.getInputEntity(peer);
    if (inputPeer instanceof Api.InputPeerChat) {
      await this.client.invoke(
        new Api.messages.AddChatUser({
          chatId: inputPeer.chatId,
          userId: userPeer,
          fwdLimit: 100,
        }),
      );
    } else if (inputPeer instanceof Api.InputPeerChannel || inputPeer instanceof Api.InputPeerChannelFromMessage) {
      // GramJS does not convert InputPeerChannelFromMessage in getInputChannel.
      const channel = inputPeer instanceof Api.InputPeerChannelFromMessage
        ? new Api.InputChannelFromMessage({ peer: inputPeer.peer, msgId: inputPeer.msgId, channelId: inputPeer.channelId })
        : inputPeer;
      await this.client.invoke(
        new Api.channels.InviteToChannel({
          channel: channel as any,
          users: [userPeer],
        }),
      );
    } else {
      throw new Error('只能向群组或频道邀请成员');
    }
  }

  async createChat(options: CreateChatOptions): Promise<DialogInfo> {
    const { type, title, about = '', forum = false } = options;
    const userIds = options.userIds || [];
    if (!options || !['group', 'supergroup', 'channel'].includes(type) || typeof title !== 'string' ||
        !title.trim() || title.trim().length > 128 || /[\u0000-\u001f]/.test(title) ||
        typeof about !== 'string' || about.length > 255 || about.includes('\u0000') || typeof forum !== 'boolean' ||
        (forum && type !== 'supergroup') || !Array.isArray(userIds) || userIds.length > 200 ||
        (type === 'group' && userIds.length < 1) || userIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id === this.selfId) ||
        new Set(userIds).size !== userIds.length) {
      throw new Error('Invalid Telegram chat creation options');
    }
    let result: any;
    if (type === 'group') {
      const users = await Promise.all(userIds.map(id => this.resolveAdminInputUser(id)));
      result = await this.client.invoke(new Api.messages.CreateChat({ users, title: title.trim() }));
    } else {
      result = await this.client.invoke(new Api.channels.CreateChannel({
        title: title.trim(), about: about.trim(), broadcast: type === 'channel',
        megagroup: type === 'supergroup', forum: type === 'supergroup' && forum,
      }));
    }
    const entity = (result?.chats || []).find((chat: any) => chat?.id != null);
    if (!entity) throw new Error('Telegram did not return the created chat');
    const id = Number(getPeerId(entity));
    if (!Number.isSafeInteger(id) || id === 0) throw new Error('Telegram returned an invalid created chat ID');
    const isBroadcast = type === 'channel';
    const actualTitle = String(entity.title || title.trim());
    return {
      id,
      type: type === 'group' ? 'group' : type,
      title: actualTitle,
      username: entity.username || undefined,
      unreadCount: 0,
      isChannel: type !== 'group',
      isBroadcast,
      isForum: type === 'supergroup' && Boolean(entity.forum ?? forum),
    };
  }

  async getChatMember(chatId: number, userId: number): Promise<ParticipantInfo | undefined> {
    const participants = await this.getParticipants(chatId, 500);
    return participants.find((p) => p.user.id === userId);
  }

  async leaveChat(chatId: number): Promise<void> {
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: peer.chatId, userId: new Api.InputUserSelf() }));
    } else if (peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerChannelFromMessage) {
      await this.client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
    } else {
      throw new Error('只能退出群组或频道');
    }
  }

  async setChatTitle(chatId: number, title: string): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof title !== 'string' || !title.trim() ||
        title.length > 128 || /[\u0000-\u001f]/.test(title)) throw new Error('Invalid Telegram chat title');
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.EditChatTitle({ chatId: peer.chatId, title: title.trim() }));
    } else if (peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerChannelFromMessage) {
      await this.client.invoke(new Api.channels.EditTitle({ channel: peer, title: title.trim() }));
    } else {
      throw new Error('只能修改群组或频道标题');
    }
  }

  async setChatUsername(chatId: number, username: string): Promise<void> {
    const value = typeof username === 'string' ? username.trim() : '';
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof username !== 'string' ||
        (value !== '' && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value))) {
      throw new Error('Invalid Telegram public username');
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    if (value) {
      const available = await this.client.invoke(new Api.channels.CheckUsername({ channel, username: value }));
      if (available !== true) throw new Error('这个公开用户名不可用');
    }
    const updated = await this.client.invoke(new Api.channels.UpdateUsername({ channel, username: value }));
    if (updated === false) throw new Error('Telegram 未确认用户名更新');
  }

  async setChatPhoto(chatId: number, uploadPath: string, fileName: string): Promise<void> {
    const name = path.basename(String(fileName || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(-128);
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof uploadPath !== 'string' || !uploadPath || !name ||
        !/\.(?:jpe?g|png|webp)$/i.test(name)) throw new Error('Invalid Telegram group photo');
    const stat = fs.statSync(uploadPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 10 * 1024 * 1024) throw new Error('Group photo must be smaller than 10 MiB');
    const file = await this.client.uploadFile({ file: new CustomFile(name, stat.size, uploadPath), workers: 1 });
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const photo = new Api.InputChatUploadedPhoto({ file });
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.EditChatPhoto({ chatId: peer.chatId, photo }));
    } else if (peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerChannelFromMessage) {
      await this.client.invoke(new Api.channels.EditPhoto({ channel: peer, photo }));
    } else {
      throw new Error('只能更换群组或频道头像');
    }
  }

  async setChatDescription(chatId: number, description: string): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof description !== 'string' ||
        description.length > 255 || description.includes('\u0000')) throw new Error('Invalid Telegram chat description');
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.EditChatAbout({
        peer,
        about: description,
      }),
    );
  }

  async setChatDefaultBannedRights(chatId: number, rights: ChatDefaultBannedRights): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || !rights || typeof rights !== 'object' ||
        CHAT_DEFAULT_BANNED_RIGHT_KEYS.some(key => typeof rights[key] !== 'boolean') ||
        Object.keys(rights).some(key => !CHAT_DEFAULT_BANNED_RIGHT_KEYS.includes(key as keyof ChatDefaultBannedRights))) {
      throw new Error('Invalid Telegram group permissions');
    }
    const bannedRights = new Api.ChatBannedRights({ ...rights, untilDate: 0 });
    await this.client.invoke(new Api.messages.EditChatDefaultBannedRights({
      peer: this.resolvePeer(chatId), bannedRights,
    }));
  }

  async setChatSlowMode(chatId: number, seconds: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || ![0, 10, 30, 60, 300, 900, 3600].includes(seconds)) {
      throw new Error('Invalid Telegram slow mode');
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    await this.client.invoke(new Api.channels.ToggleSlowMode({ channel, seconds }));
  }

  async setSupergroupSetting(chatId: number, setting: SupergroupSetting, enabled: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof enabled !== 'boolean' ||
        !['joinToSend', 'joinRequest', 'antiSpam', 'participantsHidden'].includes(setting)) {
      throw new Error('Invalid Telegram supergroup setting');
    }
    const channel = await this.resolveAdminInputChannel(chatId);
    switch (setting) {
      case 'joinToSend': await this.client.invoke(new Api.channels.ToggleJoinToSend({ channel, enabled })); break;
      case 'joinRequest': await this.client.invoke(new Api.channels.ToggleJoinRequest({ channel, enabled })); break;
      case 'antiSpam': await this.client.invoke(new Api.channels.ToggleAntiSpam({ channel, enabled })); break;
      case 'participantsHidden': await this.client.invoke(new Api.channels.ToggleParticipantsHidden({ channel, enabled })); break;
    }
  }

  async setDialogPinned(chatId: number, pinned: boolean): Promise<void> {
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const success = await this.client.invoke(new Api.messages.ToggleDialogPin({
      peer: new Api.InputDialogPeer({ peer }), pinned,
    }));
    if (success === false) throw new Error('Telegram 未能更新会话置顶状态');
  }

  async getPinnedDialogIds(folderId = 0): Promise<number[]> {
    if (folderId !== 0 && folderId !== 1) throw new Error('Invalid pinned dialog folder');
    const result = await this.client.invoke(new Api.messages.GetPinnedDialogs({ folderId })) as any;
    return (result?.dialogs || []).flatMap((dialog: any) => {
      if (!dialog?.peer) return [];
      const id = Number(getPeerId(dialog.peer));
      return Number.isSafeInteger(id) && id !== 0 ? [id] : [];
    });
  }

  async reorderPinnedDialogs(order: number[], folderId = 0): Promise<void> {
    if ((folderId !== 0 && folderId !== 1) || !Array.isArray(order) || !order.length || order.length > 100 ||
        order.some(id => !Number.isSafeInteger(id) || id === 0) || new Set(order).size !== order.length) {
      throw new Error('Invalid pinned dialog order');
    }
    const current = await this.getPinnedDialogIds(folderId);
    if (current.length !== order.length || current.some(id => !order.includes(id))) {
      throw new Error('置顶会话列表已变化，请重新加载后再排序');
    }
    const peers = await Promise.all(order.map(async id => new Api.InputDialogPeer({
      peer: await this.client.getInputEntity(this.resolvePeer(id)),
    })));
    const result = await this.client.invoke(new Api.messages.ReorderPinnedDialogs({ folderId, order: peers, force: true }));
    if (result === false) throw new Error('Telegram 未能更新置顶顺序');
  }

  async setDialogArchived(chatId: number, archived: boolean): Promise<void> {
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    await this.client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId: archived ? 1 : 0 })],
    }));
  }

  async deleteDialog(chatId: number): Promise<void> {
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerChannelFromMessage) {
      await this.client.invoke(new Api.channels.LeaveChannel({ channel: peer }));
      return;
    }
    if (peer instanceof Api.InputPeerChat) {
      await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: peer.chatId, userId: new Api.InputUserSelf() }));
    } else if (!(peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerUserFromMessage || peer instanceof Api.InputPeerSelf)) {
      throw new Error('不支持删除此类型的会话');
    }
    // DeleteHistory can be paginated by Telegram; keep requesting until the
    // affected history reports completion, but never revoke the other side.
    for (let page = 0; page < 1000; page++) {
      try {
        const result = await this.client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, revoke: false, justClear: false }));
        if (!result.offset) return;
      } catch (err) {
        if (peer instanceof Api.InputPeerChat) throw new Error(`已退出群组，但无法清理本地历史：${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    throw new Error('会话历史尚未完全删除，请稍后检查');
  }

  // --- 对话与联系人 ---

  async getDialogFolders(): Promise<DialogFolder[]> {
    const response = await this.client.invoke(new Api.messages.GetDialogFilters());
    const peerIds = (peers: Api.TypeInputPeer[] | undefined): string[] => (peers || []).flatMap((peer) => {
      try {
        if (peer instanceof Api.InputPeerSelf) return this.selfId ? [String(this.selfId)] : [];
        return [getPeerId(peer)];
      } catch { return []; }
    });
    return response.filters.flatMap((filter) => {
      if (filter instanceof Api.DialogFilterDefault) return [];
      const common = {
        id: filter.id,
        title: filter.title.text,
        emoticon: filter.emoticon || undefined,
        color: filter.color ?? undefined,
        isShared: filter instanceof Api.DialogFilterChatlist,
        isOwner: filter instanceof Api.DialogFilterChatlist && Boolean(filter.hasMyInvites),
        pinnedPeers: peerIds(filter.pinnedPeers),
        includePeers: peerIds(filter.includePeers),
      };
      if (filter instanceof Api.DialogFilterChatlist) {
        return [{ ...common, excludePeers: [], contacts: false, nonContacts: false, groups: false,
          broadcasts: false, bots: false, excludeMuted: false, excludeRead: false, excludeArchived: false }];
      }
      return [{ ...common, excludePeers: peerIds(filter.excludePeers), contacts: Boolean(filter.contacts),
        nonContacts: Boolean(filter.nonContacts), groups: Boolean(filter.groups),
        broadcasts: Boolean(filter.broadcasts), bots: Boolean(filter.bots), excludeMuted: Boolean(filter.excludeMuted),
        excludeRead: Boolean(filter.excludeRead), excludeArchived: Boolean(filter.excludeArchived) }];
    });
  }

  async saveDialogFolder(folder: any): Promise<DialogFolder> {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder) ||
        typeof folder.title !== 'string' || !folder.title.trim() || folder.title.trim().length > 32 ||
        /[\u0000-\u001f]/.test(folder.title) ||
        (folder.emoticon != null && folder.emoticon !== '' && !isSingleEmoji(folder.emoticon)) ||
        (folder.color != null && (!Number.isInteger(folder.color) || folder.color < 0 || folder.color > 7))) {
      throw new Error('Invalid Telegram chat folder');
    }
    const fields = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots', 'excludeMuted', 'excludeRead', 'excludeArchived'];
    if (fields.some(field => typeof folder[field] !== 'boolean')) throw new Error('Invalid Telegram chat folder options');
    const readPeerIds = (field: string): string[] => {
      const values = folder[field];
      if (!Array.isArray(values) || values.length > 100 || values.some((value: any) =>
        typeof value !== 'string' || !/^-?\d{1,20}$/.test(value) || /^-?0+$/.test(value))) {
        throw new Error('Invalid Telegram chat folder peers');
      }
      return [...new Set(values)];
    };
    const includeIds = readPeerIds('includePeers');
    const excludeIds = readPeerIds('excludePeers');
    const pinnedIds = readPeerIds('pinnedPeers');
    if (!['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'].some(field => folder[field]) && includeIds.length === 0) {
      throw new Error('Telegram chat folders require at least one included category or chat');
    }
    if (pinnedIds.some(id => !includeIds.includes(id))) throw new Error('Telegram folder pinned peers must also be included');

    const response = await this.client.invoke(new Api.messages.GetDialogFilters()) as any;
    const folders = (response?.filters || []).filter((filter: any) => filter instanceof Api.DialogFilter);
    let id = Number(folder.id);
    if (folder.id == null) {
      if (folders.length >= 10) throw new Error('Telegram supports up to 10 custom chat folders');
      const used = new Set((response?.filters || []).map((filter: any) => Number(filter.id)).filter(Number.isInteger));
      id = Array.from({ length: 254 }, (_, index) => index + 2).find(candidate => !used.has(candidate)) || 0;
      if (!id) throw new Error('No Telegram chat folder ID is available');
    } else if (!Number.isInteger(id) || id < 1 || id > 255 || !folders.some((filter: any) => filter.id === id)) {
      throw new Error('Invalid Telegram chat folder ID');
    }
    const inputPeers = async (ids: string[]) => Promise.all(ids.map(async peerId => {
      const input = await this.client.getInputEntity(this.resolvePeer(peerId));
      if (!(input instanceof Api.InputPeerSelf || input instanceof Api.InputPeerUser || input instanceof Api.InputPeerChat || input instanceof Api.InputPeerChannel)) {
        throw new Error(`无法解析文件夹会话 ${peerId}`);
      }
      return input as Api.TypeInputPeer;
    }));
    const [pinnedPeers, includePeers, excludePeers] = await Promise.all([
      inputPeers(pinnedIds), inputPeers(includeIds), inputPeers(excludeIds),
    ]);
    const filter = new Api.DialogFilter({
      id,
      title: new Api.TextWithEntities({ text: folder.title.trim(), entities: [] }),
      emoticon: folder.emoticon || undefined,
      color: folder.color,
      contacts: folder.contacts,
      nonContacts: folder.nonContacts,
      groups: folder.groups,
      broadcasts: folder.broadcasts,
      bots: folder.bots,
      excludeMuted: folder.excludeMuted,
      excludeRead: folder.excludeRead,
      excludeArchived: folder.excludeArchived,
      pinnedPeers,
      includePeers,
      excludePeers,
    });
    const result = await this.client.invoke(new Api.messages.UpdateDialogFilter({ id, filter }));
    if (result === false) throw new Error('Telegram 未确认文件夹保存');
    const updated = await this.getDialogFolders();
    const saved = updated.find(item => item.id === id);
    if (!saved) throw new Error('Telegram 未返回已保存的文件夹');
    return saved;
  }

  async deleteDialogFolder(folderId: number): Promise<void> {
    if (!Number.isInteger(folderId) || folderId < 1 || folderId > 255) throw new Error('Invalid Telegram chat folder ID');
    const response = await this.client.invoke(new Api.messages.GetDialogFilters()) as any;
    const folder = (response?.filters || []).find((filter: any) =>
      (filter instanceof Api.DialogFilter || filter instanceof Api.DialogFilterChatlist) && filter.id === folderId);
    if (!folder || (folder instanceof Api.DialogFilterChatlist && !folder.hasMyInvites)) {
      throw new Error('Telegram chat folder not found or cannot be deleted');
    }
    const result = await this.client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId }));
    if (result === false) throw new Error('Telegram 未确认文件夹删除');
  }

  async reorderDialogFolders(folderIds: number[]): Promise<void> {
    if (!Array.isArray(folderIds) || folderIds.length > 20 || folderIds.some(id => !Number.isInteger(id) || id < 1 || id > 255) ||
        new Set(folderIds).size !== folderIds.length) throw new Error('Invalid Telegram chat folder order');
    const response = await this.client.invoke(new Api.messages.GetDialogFilters()) as any;
    const currentIds = (response?.filters || []).filter((filter: any) =>
      filter instanceof Api.DialogFilter || filter instanceof Api.DialogFilterChatlist).map((filter: any) => filter.id);
    if (currentIds.length !== folderIds.length || currentIds.some((id: number) => !folderIds.includes(id))) {
      throw new Error('Telegram chat folder order is stale');
    }
    const result = await this.client.invoke(new Api.messages.UpdateDialogFiltersOrder({ order: folderIds }));
    if (result === false) throw new Error('Telegram 未确认文件夹顺序');
  }

  async getDialogFolderTagState(): Promise<DialogFolderTagState> {
    const response = await this.client.invoke(new Api.messages.GetDialogFilters()) as any;
    return { enabled: Boolean(response?.tagsEnabled), premium: this.selfIsPremium };
  }

  async setDialogFolderTags(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Telegram folder tag setting');
    const result = await this.client.invoke(new Api.messages.ToggleDialogFilterTags({ enabled }));
    if (result === false) throw new Error('Telegram 未确认文件夹标签设置');
  }

  async getDialogFolderSharePeers(folderId: number): Promise<DialogFolderSharePeer[]> {
    const folder = await this.getManageableChatlistFolder(folderId);
    if (folder instanceof Api.DialogFilter &&
        (folder.contacts || folder.nonContacts || folder.groups || folder.broadcasts || folder.bots ||
          folder.excludeMuted || folder.excludeRead || folder.excludeArchived || folder.excludePeers.length)) {
      throw new Error('Only a manually selected folder without category or exclusion rules can be shared');
    }
    const peers = new Map<string, Api.TypeInputPeer>();
    for (const peer of [...(folder.pinnedPeers || []), ...(folder.includePeers || [])]) {
      try { peers.set(peer instanceof Api.InputPeerSelf && this.selfId ? String(this.selfId) : getPeerId(peer), peer); }
      catch { /* Telegram can include peers without a stable identifier. */ }
    }
    const result: DialogFolderSharePeer[] = [];
    for (const [id, inputPeer] of peers) {
      if (!(inputPeer instanceof Api.InputPeerChat || inputPeer instanceof Api.InputPeerChannel)) continue;
      try {
        const entity: any = await this.client.getEntity(this.resolvePeer(id));
        const type = entity?.className === 'Channel' && !entity.megagroup ? 'channel' : 'group';
        const title = entity?.title || entity?.username || `会话 ${id}`;
        result.push({ id, title: String(title).slice(0, 256), type });
      } catch {
        // Keep the peer available even if its display entity is no longer cached;
        // Telegram will re-resolve and authorize it during invite creation.
        result.push({ id, title: `会话 ${id}`, type: inputPeer instanceof Api.InputPeerChannel ? 'channel' : 'group' });
      }
    }
    return result;
  }

  private async getManageableChatlistFolder(folderId: number): Promise<Api.DialogFilter | Api.DialogFilterChatlist> {
    if (!Number.isInteger(folderId) || folderId < 1 || folderId > 255) throw new Error('Invalid Telegram chat folder ID');
    const response = await this.client.invoke(new Api.messages.GetDialogFilters()) as any;
    const folder = (response?.filters || []).find((item: any) =>
      (item instanceof Api.DialogFilter || item instanceof Api.DialogFilterChatlist) && item.id === folderId);
    if (!folder) throw new Error('Telegram chat folder not found');
    if (folder instanceof Api.DialogFilterChatlist && !folder.hasMyInvites) throw new Error('This shared folder is not managed by this account');
    return folder;
  }

  private validateChatlistPeers(folder: Api.DialogFilter | Api.DialogFilterChatlist, peerIds: string[]): void {
    if (!Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 100 ||
        peerIds.some(id => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id)) ||
        new Set(peerIds).size !== peerIds.length) throw new Error('Invalid Telegram chatlist peers');
    if (folder instanceof Api.DialogFilter &&
        (folder.contacts || folder.nonContacts || folder.groups || folder.broadcasts || folder.bots || folder.excludeMuted || folder.excludeRead || folder.excludeArchived || folder.excludePeers.length)) {
      throw new Error('Only a manually selected folder without category or exclusion rules can be shared');
    }
    const markedPeerId = (peer: Api.TypeInputPeer): string | undefined => {
      try { return peer instanceof Api.InputPeerSelf ? (this.selfId ? String(this.selfId) : undefined) : getPeerId(peer); }
      catch { return undefined; }
    };
    const allowed = new Set([...(folder.pinnedPeers || []), ...(folder.includePeers || [])].map(markedPeerId).filter(Boolean));
    if (peerIds.some(id => !allowed.has(id))) throw new Error('A shared chat must belong to this folder');
  }

  private async resolveChatlistPeers(peerIds: string[]): Promise<Api.TypeInputPeer[]> {
    const peers = await Promise.all(peerIds.map(async id => {
      const peer = await this.client.getInputEntity(this.resolvePeer(id));
      if (!(peer instanceof Api.InputPeerChat || peer instanceof Api.InputPeerChannel)) {
        throw new Error('Shared folders can contain groups and channels, not private users');
      }
      return peer as Api.TypeInputPeer;
    }));
    return peers;
  }

  private mapChatlistInvite(invite: Api.TypeExportedChatlistInvite): DialogFolderInvite {
    const item = invite as Api.ExportedChatlistInvite;
    const peerIds = (item.peers || []).flatMap(peer => {
      try { return [getPeerId(peer)]; } catch { return []; }
    });
    return { title: item.title || '', url: item.url, peerIds };
  }

  async getDialogFolderInvites(folderId: number): Promise<DialogFolderInvite[]> {
    const folder = await this.getManageableChatlistFolder(folderId);
    if (!(folder instanceof Api.DialogFilterChatlist)) return [];
    const result = await this.client.invoke(new Api.chatlists.GetExportedInvites({
      chatlist: new Api.InputChatlistDialogFilter({ filterId: folderId }),
    })) as Api.chatlists.ExportedInvites;
    return (result?.invites || []).map(invite => this.mapChatlistInvite(invite));
  }

  async createDialogFolderInvite(folderId: number, title: string, peerIds: string[]): Promise<DialogFolderInvite> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 32 || /[\u0000-\u001f]/.test(title)) {
      throw new Error('Invalid Telegram chatlist invite title');
    }
    const folder = await this.getManageableChatlistFolder(folderId);
    this.validateChatlistPeers(folder, peerIds);
    const peers = await this.resolveChatlistPeers(peerIds);
    const result = await this.client.invoke(new Api.chatlists.ExportChatlistInvite({
      chatlist: new Api.InputChatlistDialogFilter({ filterId: folderId }), title: title.trim(), peers,
    })) as Api.chatlists.ExportedChatlistInvite;
    if (!result?.invite?.url) throw new Error('Telegram did not return a chatlist invite link');
    return this.mapChatlistInvite(result.invite);
  }

  async editDialogFolderInvite(folderId: number, url: string, title: string, peerIds: string[]): Promise<DialogFolderInvite> {
    const slug = chatlistSlug(url);
    if (typeof title !== 'string' || title.length > 32 || /[\u0000-\u001f]/.test(title)) throw new Error('Invalid Telegram chatlist invite title');
    const folder = await this.getManageableChatlistFolder(folderId);
    if (!(folder instanceof Api.DialogFilterChatlist)) throw new Error('Telegram folder has no editable invite links');
    const invites = await this.getDialogFolderInvites(folderId);
    if (!invites.some(invite => chatlistSlug(invite.url) === slug)) throw new Error('Telegram chatlist invite not found');
    this.validateChatlistPeers(folder, peerIds);
    const peers = await this.resolveChatlistPeers(peerIds);
    const invite = await this.client.invoke(new Api.chatlists.EditExportedInvite({
      chatlist: new Api.InputChatlistDialogFilter({ filterId: folderId }), slug, title: title.trim(), peers,
    })) as Api.TypeExportedChatlistInvite;
    return this.mapChatlistInvite(invite);
  }

  async deleteDialogFolderInvite(folderId: number, url: string): Promise<void> {
    const slug = chatlistSlug(url);
    const folder = await this.getManageableChatlistFolder(folderId);
    if (!(folder instanceof Api.DialogFilterChatlist)) throw new Error('Telegram folder has no deletable invite links');
    const invites = await this.getDialogFolderInvites(folderId);
    if (!invites.some(invite => chatlistSlug(invite.url) === slug)) throw new Error('Telegram chatlist invite not found');
    const result = await this.client.invoke(new Api.chatlists.DeleteExportedInvite({
      chatlist: new Api.InputChatlistDialogFilter({ filterId: folderId }), slug,
    }));
    if (result === false) throw new Error('Telegram did not confirm chatlist invite deletion');
  }

  private mapChatlistInvitePreview(result: Api.chatlists.TypeChatlistInvite): DialogFolderInvitePreview {
    const entities = new Map<string, any>();
    for (const entity of [...(result.chats || []), ...(result.users || [])]) {
      try { entities.set(String(getPeerId(entity)), entity); } catch { /* Ignore incomplete invite entities. */ }
    }
    const already = result instanceof Api.chatlists.ChatlistInviteAlready;
    const alreadyIds = new Set(already ? result.alreadyPeers.flatMap(peer => {
      try { return [String(getPeerId(peer))]; } catch { return []; }
    }) : []);
    const peers = (already ? [...result.alreadyPeers, ...result.missingPeers] : result.peers).flatMap(peer => {
      let id: string;
      try { id = String(getPeerId(peer)); } catch { return []; }
      const entity = entities.get(id);
      let title = '';
      let type: DialogFolderInvitePreviewPeer['type'] = 'private';
      if (entity instanceof Api.User) {
        title = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || `会话 ${id}`;
      } else if (entity instanceof Api.Chat) {
        title = entity.title || `群组 ${id}`;
        type = 'group';
      } else if (entity instanceof Api.Channel) {
        title = entity.title || `会话 ${id}`;
        type = entity.broadcast ? 'channel' : 'group';
      } else {
        title = `会话 ${id}`;
        if (peer instanceof Api.PeerChat) type = 'group';
        else if (peer instanceof Api.PeerChannel) type = 'channel';
      }
      return [{ id, title, type, alreadyJoined: alreadyIds.has(id) }];
    });
    return {
      title: already ? '' : result.title.text,
      emoticon: already ? undefined : result.emoticon,
      alreadyImported: already,
      peers,
    };
  }

  async checkDialogFolderInvite(url: string): Promise<DialogFolderInvitePreview> {
    const slug = chatlistSlug(url);
    const result = await this.client.invoke(new Api.chatlists.CheckChatlistInvite({ slug })) as Api.chatlists.TypeChatlistInvite;
    return this.mapChatlistInvitePreview(result);
  }

  async joinDialogFolderInvite(url: string, peerIds: string[]): Promise<void> {
    const slug = chatlistSlug(url);
    if (!Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > 100 ||
        peerIds.some(id => typeof id !== 'string' || !/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id)) ||
        new Set(peerIds).size !== peerIds.length) throw new Error('Invalid Telegram chatlist invite peers');
    const checked = await this.client.invoke(new Api.chatlists.CheckChatlistInvite({ slug })) as Api.chatlists.TypeChatlistInvite;
    const allowed = new Set((checked instanceof Api.chatlists.ChatlistInviteAlready
      ? [...checked.alreadyPeers, ...checked.missingPeers] : checked.peers).flatMap(peer => {
      try { return [String(getPeerId(peer))]; } catch { return []; }
    }));
    if (peerIds.some(id => !allowed.has(id))) throw new Error('A selected chat is not part of this Telegram invite');
    const peers = await Promise.all(peerIds.map(async id => {
      const peer = await this.client.getInputEntity(this.resolvePeer(id));
      if (!(peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf ||
            peer instanceof Api.InputPeerChat || peer instanceof Api.InputPeerChannel)) {
        throw new Error('Unsupported Telegram chatlist peer');
      }
      return peer as Api.TypeInputPeer;
    }));
    await this.client.invoke(new Api.chatlists.JoinChatlistInvite({ slug, peers }));
  }

  async searchDialogs(query: string, limit = 30): Promise<DialogInfo[]> {
    const q = query.trim();
    if (!q) return [];
    const found = await this.client.invoke(new Api.contacts.Search({ q, limit: Math.min(Math.max(limit, 1), 100) }));
    // invoke() also puts the returned entities and access hashes in GramJS's
    // cache, allowing a result that was not in the dialogs page to be opened.
    const entities = new Map<string, any>();
    for (const entity of [...found.users, ...found.chats]) {
      try { entities.set(getPeerId(entity), entity); } catch { /* incomplete entity */ }
    }
    const result: DialogInfo[] = [];
    const seen = new Set<string>();
    for (const peer of [...found.myResults, ...found.results]) {
      let id: string;
      try { id = getPeerId(peer); } catch { continue; }
      const entity = entities.get(id);
      if (!entity || seen.has(id)) continue;
      seen.add(id);
      const title = entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || id;
      const type: ChatType = entity.className === 'User' ? 'private' :
        entity.className === 'Channel' && !entity.megagroup ? 'channel' : 'group';
      result.push({ id: Number(id), type, title, username: entity.username, unreadCount: 0,
        isSelf: Boolean(this.selfId && Number(id) === this.selfId),
        isBot: Boolean(entity.bot),
        online: entity.status?.className === 'UserStatusOnline',
        isChannel: entity.className === 'Channel',
        isForum: Boolean(entity.forum),
      });
    }
    return result;
  }

  async searchGlobalMessages(query: string, limit = 30, cursor?: { rate: number; peer: string; id: number }, searchFilter?: GetMessagesOptions['searchFilter']): Promise<{ messages: IncomingMessage[]; nextCursor?: { rate: number; peer: string; id: number } }> {
    const q = query.trim();
    if (!q && !searchFilter) return { messages: [] };
    const pageSize = Math.min(Math.max(limit, 1), 50);
    const peer = cursor ? await this.client.getInputEntity(this.resolvePeer(cursor.peer)) : new Api.InputPeerEmpty();
    const result = await this.client.invoke(new Api.messages.SearchGlobal({
      q, filter: searchMessagesFilter(searchFilter), minDate: 0, maxDate: 0,
      offsetRate: cursor?.rate || 0, offsetPeer: peer, offsetId: cursor?.id || 0, limit: pageSize,
    }));
    if (!('messages' in result)) return { messages: [] };
    const entities = new Map<string, any>();
    for (const entity of [...result.users, ...result.chats]) {
      try { entities.set(getPeerId(entity), entity); } catch { /* incomplete entity */ }
    }
    const messages: IncomingMessage[] = [];
    for (const message of result.messages) {
      if (!(message instanceof Api.Message)) continue;
      try {
        (message as any)._finishInit(this.client, entities, undefined);
        (message as any)._entities = entities;
        const mapped = await this.mapMessage(message);
        if (mapped) {
          mapped.chat.id = Number(getPeerId(message.peerId));
          messages.push(mapped);
        }
      } catch (err) { this.logger.debug({ err }, 'Failed to map global search message'); }
    }
    const last = result.messages[result.messages.length - 1];
    const rate = 'nextRate' in result ? result.nextRate : undefined;
    let nextCursor: { rate: number; peer: string; id: number } | undefined;
    if (result.messages.length === pageSize && rate != null && last instanceof Api.Message && last.peerId) {
      nextCursor = { rate, peer: getPeerId(last.peerId), id: last.id };
    }
    return { messages, nextCursor };
  }

  async getDialogs(limit = 30, offset?: { peer: number | string; id: number; date: number }, folderId: 0 | 1 = 0): Promise<DialogInfo[]> {
    const dialogs = await this.client.getDialogs(offset ? {
      limit,
      offsetPeer: await this.client.getInputEntity(this.resolvePeer(offset.peer)),
      offsetId: offset.id,
      offsetDate: Math.floor(offset.date / 1000),
      ignorePinned: true,
      folder: folderId,
    } : { limit, folder: folderId });
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
        isSelf: Boolean(this.selfId && id === this.selfId),
        title: d.title || (entity as any).username || (entity as any).firstName,
        username: (entity as any).username,
        unreadCount: d.unreadCount,
        lastMessageId: d.message?.id,
        pinned: d.pinned,
        lastMessageDate: d.date ? d.date * 1000 : undefined,
        lastMessage: lastMsgText,
        lastSender: lastSenderName,
        isChannel: d.isChannel,
        isForum: Boolean((entity as any).forum),
        // Extended fields for Telegram-style client
        online: (entity as any).status?.className === 'UserStatusOnline' ? true : undefined,
        lastSeen: (entity as any).status?.wasOnline ? (entity as any).status.wasOnline * 1000 : undefined,
        readInboxMaxId: (d.dialog as any)?.readInboxMaxId ? Number((d.dialog as any).readInboxMaxId) : undefined,
        readOutboxMaxId: (d.dialog as any)?.readOutboxMaxId ? Number((d.dialog as any).readOutboxMaxId) : undefined,
        ttlPeriod: Number.isSafeInteger((d.dialog as any)?.ttlPeriod) && (d.dialog as any).ttlPeriod >= 0
          ? Number((d.dialog as any).ttlPeriod) : 0,
        muted: (d.dialog as any)?.notifySettings?.muteUntil ? (d.dialog as any).notifySettings.muteUntil > Date.now() / 1000 : undefined,
        isContact: Boolean((entity as any).contact),
        isBot: Boolean((entity as any).bot),
        isPremium: Boolean((entity as any).premium),
        isCreator: Boolean((entity as any).creator),
        isBroadcast: Boolean((entity as any).broadcast),
        folderId: (d as any).folderId || 0,
        archived: (d as any).folderId === 1,
        draft: d.dialog ? mapCloudDraft((d.dialog as any).draft) : undefined,
      });
    }

    return list;
  }

  async getExplicitDialogs(peerIds: number[]): Promise<DialogInfo[]> {
    if (!Array.isArray(peerIds) || peerIds.length > 100 || peerIds.some(id => !Number.isSafeInteger(id) || id === 0)) {
      throw new Error('Invalid explicit dialog peers');
    }
    const unique = [...new Set(peerIds)];
    const result: DialogInfo[] = [];
    const resolved: Array<{ id: number; peer: Api.TypeInputPeer }> = [];
    for (const id of unique) {
      try {
        const peer = await this.client.getInputEntity(this.resolvePeer(id));
        if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerUserFromMessage ||
            peer instanceof Api.InputPeerChat || peer instanceof Api.InputPeerChannel || peer instanceof Api.InputPeerChannelFromMessage ||
            peer instanceof Api.InputPeerSelf) resolved.push({ id, peer });
      } catch (err) {
        this.logger.debug({ peerId: id, err }, 'Skipped inaccessible explicit folder peer');
      }
    }
    if (!resolved.length) return result;

    let entities = new Map<string, any>();
    try {
      const response = await this.client.invoke(new Api.messages.GetPeerDialogs({
        peers: resolved.map(({ peer }) => new Api.InputDialogPeer({ peer })),
      })) as any;
      for (const entity of [...(response.users || []), ...(response.chats || [])]) {
        try { entities.set(getPeerId(entity), entity); } catch { /* incomplete Telegram entity */ }
      }
    } catch (err) {
      this.logger.debug({ err }, 'Unable to batch explicit folder peers');
    }

    for (const { id, peer } of resolved) {
      try {
        const entity: any = entities.get(String(id)) || await this.client.getEntity(peer);
        if (!entity || !['User', 'Chat', 'Channel'].includes(entity.className)) continue;
        const type: ChatType = entity.className === 'User' ? 'private' :
          entity.className === 'Channel' ? (entity.megagroup ? 'supergroup' : 'channel') : 'group';
        const title = entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || String(id);
        result.push({
          id, type, title, username: entity.username, unreadCount: 0,
          isSelf: Boolean(this.selfId && id === this.selfId),
          isChannel: entity.className === 'Channel', isForum: Boolean(entity.forum),
          online: entity.status?.className === 'UserStatusOnline' ? true : undefined,
          lastSeen: entity.status?.wasOnline ? entity.status.wasOnline * 1000 : undefined,
          isContact: Boolean(entity.contact), isBot: Boolean(entity.bot),
        });
      } catch (err) {
        this.logger.debug({ peerId: id, err }, 'Skipped inaccessible explicit folder peer');
      }
    }
    return result;
  }

  async getDraft(chatId: number): Promise<import('../adapter/types').CloudDraft | null> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('无效的会话');
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const result = await this.client.invoke(new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer })] }));
    const dialog = result.dialogs.find((entry) => entry instanceof Api.Dialog && String(getPeerId(entry.peer)) === String(chatId));
    if (!(dialog instanceof Api.Dialog)) throw new Error('无法读取此会话草稿');
    return mapCloudDraft(dialog.draft);
  }

  async saveDraft(chatId: number, text: string, options?: { replyToMessageId?: number; parseMode?: 'plain' | 'markdown' | 'html' }): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof text !== 'string' || text.length > 16384) throw new Error('无效的草稿');
    const replyId = options?.replyToMessageId;
    if (replyId !== undefined && (!Number.isSafeInteger(replyId) || replyId <= 0)) throw new Error('无效的草稿回复');
    if (options?.parseMode && !['plain', 'markdown', 'html'].includes(options.parseMode)) throw new Error('无效的草稿格式');
    const prepared = prepareText(text, options?.parseMode || 'plain');
    const [message, entities] = await _parseMessageText(this.client, prepared.text, prepared.parseMode);
    if (message.length > 4096) throw new Error('草稿内容过长');
    const saved = await this.client.invoke(new Api.messages.SaveDraft({
      peer: this.resolvePeer(chatId), message, entities,
      replyTo: replyId === undefined ? undefined : new Api.InputReplyToMessage({ replyToMsgId: replyId }),
    }));
    if (saved === false) throw new Error('Telegram 未确认保存草稿');
  }

  async markAsRead(chatId: number, maxId?: number): Promise<void> {
    const peer = this.resolvePeer(chatId);
    const accepted = await this.client.markAsRead(peer, maxId);
    if (accepted === false) throw new Error('Telegram 未确认已读');
  }

  async getMessageFactChecks(chatId: number, messageId: number): Promise<MessageFactCheck[]> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid fact-check request');
    }
    const result = await this.client.invoke(new Api.messages.GetFactCheck({ peer: this.resolvePeer(chatId), msgId: [messageId] }));
    return (Array.isArray(result) ? result : []).map(mapFactCheck).filter((item): item is MessageFactCheck => Boolean(item));
  }

  private createMessageReportToken(chatId: number, messageId: number, option: Buffer, requireComment = false): string {
    const now = Date.now();
    for (const [token, item] of this.pendingMessageReports) if (item.expiresAt <= now) this.pendingMessageReports.delete(token);
    while (this.pendingMessageReports.size >= 1000) this.pendingMessageReports.delete(this.pendingMessageReports.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    this.pendingMessageReports.set(token, { chatId, messageId, option: Buffer.from(option), requireComment, expiresAt: now + 10 * 60_000 });
    return token;
  }

  private mapMessageReportProgress(result: any, chatId: number, messageId: number): MessageReportProgress {
    if (result instanceof Api.ReportResultChooseOption || result?.className === 'ReportResultChooseOption') {
      const options = Array.isArray(result.options) ? result.options.slice(0, 32).flatMap((item: any) =>
        typeof item?.text === 'string' && item.option != null
          ? [{ token: this.createMessageReportToken(chatId, messageId, Buffer.from(item.option)), text: item.text.slice(0, 256) }]
          : []) : [];
      if (!options.length) throw new Error('Telegram returned no report options');
      return { status: 'choose', title: typeof result.title === 'string' ? result.title.slice(0, 256) : '选择举报原因', options };
    }
    if (result instanceof Api.ReportResultAddComment || result?.className === 'ReportResultAddComment') {
      if (result.option == null) throw new Error('Telegram returned an invalid report comment option');
      return { status: 'comment', token: this.createMessageReportToken(chatId, messageId, Buffer.from(result.option), !result.optional),
        optional: Boolean(result.optional) };
    }
    if (result instanceof Api.ReportResultReported || result?.className === 'ReportResultReported') return { status: 'reported' };
    throw new Error('Telegram returned an unsupported report step');
  }

  async startMessageReport(chatId: number, messageId: number): Promise<MessageReportProgress> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid message report request');
    }
    const result = await this.client.invoke(new Api.messages.Report({
      peer: this.resolvePeer(chatId), id: [messageId], option: Buffer.alloc(0), message: '',
    }));
    return this.mapMessageReportProgress(result, chatId, messageId);
  }

  async continueMessageReport(token: string, comment?: string): Promise<MessageReportProgress> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
        (comment != null && (typeof comment !== 'string' || comment.length > 1024))) {
      throw new Error('Invalid message report continuation');
    }
    const pending = this.pendingMessageReports.get(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingMessageReports.delete(token);
      throw new Error('Telegram message report option has expired');
    }
    if (pending.requireComment && (comment == null || !comment.trim())) throw new Error('A report comment is required');
    // Consume before dispatch: a timeout can arrive after Telegram accepted the report.
    this.pendingMessageReports.delete(token);
    const result = await this.client.invoke(new Api.messages.Report({
      peer: this.resolvePeer(pending.chatId), id: [pending.messageId], option: pending.option, message: comment || '',
    }));
    return this.mapMessageReportProgress(result, pending.chatId, pending.messageId);
  }

  async getDiscussionGroupState(channelId: number): Promise<DiscussionGroupState> {
    if (!Number.isSafeInteger(channelId) || channelId >= 0) throw new Error('Invalid broadcast channel');
    const entity = await this.client.getEntity(this.resolvePeer(channelId));
    if (!(entity instanceof Api.Channel) || !entity.broadcast) throw new Error('Discussion groups can only be managed for broadcast channels');
    const channel = await this.client.getInputEntity(entity);
    const [full, choices] = await Promise.all([
      this.client.invoke(new Api.channels.GetFullChannel({ channel })) as Promise<any>,
      this.client.invoke(new Api.channels.GetGroupsForDiscussion()) as Promise<any>,
    ]);
    const toGroup = (item: any) => {
      if (!(item instanceof Api.Channel) || !item.megagroup) return undefined;
      const id = Number(getPeerId(new Api.PeerChannel({ channelId: item.id })));
      return Number.isSafeInteger(id) && id < 0
        ? { id, title: String(item.title || '').slice(0, 256), ...(Number.isSafeInteger(item.participantsCount) ? { membersCount: item.participantsCount } : {}) }
        : undefined;
    };
    const groups = new Map<number, NonNullable<ReturnType<typeof toGroup>>>();
    for (const item of Array.isArray(choices?.chats) ? choices.chats : []) {
      const group = toGroup(item);
      if (group) groups.set(group.id, group);
    }
    const linkedRaw = full?.fullChat?.linkedChatId;
    let linkedGroup: ReturnType<typeof toGroup> | undefined;
    if (linkedRaw != null && bigInt(String(linkedRaw)).greater(0)) {
      const linkedId = bigInt(String(linkedRaw));
      const linkedEntity = (Array.isArray(full?.chats) ? full.chats : []).find((item: any) => item instanceof Api.Channel && String(item.id) === String(linkedId))
        || await this.client.getEntity(new Api.PeerChannel({ channelId: linkedId }));
      linkedGroup = toGroup(linkedEntity);
      if (!linkedGroup) throw new Error('Telegram 返回了无效的关联讨论群');
      groups.set(linkedGroup.id, linkedGroup);
    }
    return { ...(linkedGroup ? { linkedGroup } : {}), groups: [...groups.values()].sort((a, b) => a.title.localeCompare(b.title)) };
  }

  async linkDiscussionGroup(channelId: number, groupId: number): Promise<void> {
    if (!Number.isSafeInteger(channelId) || channelId >= 0 || !Number.isSafeInteger(groupId) || groupId >= 0 || channelId === groupId) {
      throw new Error('Invalid discussion group link');
    }
    const channelEntity = await this.client.getEntity(this.resolvePeer(channelId));
    const groupEntity = await this.client.getEntity(this.resolvePeer(groupId));
    if (!(channelEntity instanceof Api.Channel) || !channelEntity.broadcast ||
        !(groupEntity instanceof Api.Channel) || !groupEntity.megagroup) {
      throw new Error('Telegram discussion links require a broadcast channel and a supergroup');
    }
    const [broadcast, group] = await Promise.all([
      this.client.getInputEntity(channelEntity), this.client.getInputEntity(groupEntity),
    ]);
    const result = await this.client.invoke(new Api.channels.SetDiscussionGroup({ broadcast, group }));
    if (result === false) throw new Error('Telegram did not confirm the discussion group link');
  }

  async unlinkDiscussionGroup(channelId: number): Promise<void> {
    if (!Number.isSafeInteger(channelId) || channelId >= 0) throw new Error('Invalid broadcast channel');
    const entity = await this.client.getEntity(this.resolvePeer(channelId));
    if (!(entity instanceof Api.Channel) || !entity.broadcast) throw new Error('Discussion groups can only be managed for broadcast channels');
    const broadcast = await this.client.getInputEntity(entity);
    const result = await this.client.invoke(new Api.channels.SetDiscussionGroup({ broadcast, group: new Api.InputChannelEmpty() }));
    if (result === false) throw new Error('Telegram did not confirm the discussion group unlink');
  }

  async translateMessage(chatId: number, messageId: number, targetLang = 'zh-hans'): Promise<{ translatedText: string; targetLang: string; entities?: MessageEntity[] }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(targetLang) || targetLang.length > 16) {
      throw new Error('Invalid message translation request');
    }
    const result = await this.client.invoke(new Api.messages.TranslateText({
      peer: this.resolvePeer(chatId), id: [messageId], toLang: targetLang.toLowerCase(),
    }));
    const translated = (result as Api.messages.TranslateResult)?.result?.[0];
    const translatedText = translated?.text;
    if (typeof translatedText !== 'string' || !translatedText) throw new Error('Telegram did not return a translation');
    const entities = Array.isArray(translated.entities) ? translated.entities.flatMap((entity: any) => {
      const offset = Number(entity?.offset), length = Number(entity?.length);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > translatedText.length) return [];
      return [{
        type: String(entity?.className || ''), offset, length,
        ...(typeof entity?.url === 'string' ? { url: entity.url } : {}),
        ...(entity?.userId != null ? { userId: Number(String(entity.userId)) } : {}),
        ...(entity?.documentId != null ? { documentId: String(entity.documentId) } : {}),
      }];
    }) : [];
    return { translatedText, targetLang: targetLang.toLowerCase(), ...(entities.length ? { entities } : {}) };
  }

  async translateMessages(chatId: number, messageIds: number[], targetLang = 'zh-hans'): Promise<Array<{ messageId: number; translatedText: string }>> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 20 ||
        messageIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(targetLang) || targetLang.length > 16) {
      throw new Error('Invalid batch message translation request');
    }
    const ids = [...new Set(messageIds)];
    const result = await this.client.invoke(new Api.messages.TranslateText({
      peer: this.resolvePeer(chatId), id: ids, toLang: targetLang.toLowerCase(),
    })) as any;
    const texts = Array.isArray(result?.result) ? result.result : [];
    return ids.flatMap((messageId, index) => typeof texts[index]?.text === 'string' && texts[index].text
      ? [{ messageId, translatedText: texts[index].text }] : []);
  }

  async getChatTranslationSettings(chatId: number): Promise<{ enabled: boolean }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid translation peer');
    let peer: any = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (peer instanceof Api.InputPeerUserFromMessage || peer instanceof Api.InputPeerChannelFromMessage) {
      peer = await this.client.getInputEntity(await this.client.getEntity(peer));
    }
    let full: any;
    if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf) {
      const inputUser = peer instanceof Api.InputPeerSelf ? new Api.InputUserSelf() :
        new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
      const response = await this.client.invoke(new Api.users.GetFullUser({ id: inputUser })) as any;
      full = response?.fullUser;
    } else if (peer instanceof Api.InputPeerChat) {
      const response = await this.client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId })) as any;
      full = response?.fullChat;
    } else if (peer instanceof Api.InputPeerChannel) {
      const response = await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer })) as any;
      full = response?.fullChat;
    } else {
      throw new Error('Unsupported translation peer');
    }
    if (!full) throw new Error('Telegram did not return translation settings');
    return { enabled: !Boolean(full.translationsDisabled) };
  }

  async setChatTranslationEnabled(chatId: number, enabled: boolean): Promise<{ enabled: boolean }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof enabled !== 'boolean') {
      throw new Error('Invalid translation setting');
    }
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const result = await this.client.invoke(new Api.messages.TogglePeerTranslations({ peer, disabled: !enabled }));
    if (result === false) throw new Error('Telegram did not confirm the translation setting');
    return { enabled };
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

  private accountPrivacyKey(key: string): Api.TypeInputPrivacyKey {
    const keys: Record<string, () => Api.TypeInputPrivacyKey> = {
      lastSeen: () => new Api.InputPrivacyKeyStatusTimestamp(),
      phoneNumber: () => new Api.InputPrivacyKeyPhoneNumber(),
      profilePhoto: () => new Api.InputPrivacyKeyProfilePhoto(),
      forwards: () => new Api.InputPrivacyKeyForwards(),
      calls: () => new Api.InputPrivacyKeyPhoneCall(),
      peerToPeerCalls: () => new Api.InputPrivacyKeyPhoneP2P(),
      groupInvites: () => new Api.InputPrivacyKeyChatInvite(),
      about: () => new Api.InputPrivacyKeyAbout(),
      birthday: () => new Api.InputPrivacyKeyBirthday(),
      voiceMessages: () => new Api.InputPrivacyKeyVoiceMessages(),
      addedByPhone: () => new Api.InputPrivacyKeyAddedByPhone(),
    };
    const create = keys[key];
    if (!create) throw new Error('Unsupported account privacy setting');
    return create();
  }

  async getAccountPrivacySettings(): Promise<Array<{ key: string; title: string; mode: string; available: boolean; exceptions: { allowedUsers: number; blockedUsers: number; allowedChats: number; blockedChats: number; otherRules: number } }>> {
    const settings = [
      ['lastSeen', '上线时间'], ['phoneNumber', '手机号'], ['profilePhoto', '头像'], ['forwards', '转发来源'],
      ['calls', '语音与视频通话'], ['peerToPeerCalls', '点对点通话'], ['groupInvites', '群组与频道邀请'],
      ['about', '个人简介'], ['birthday', '生日'], ['voiceMessages', '语音消息'], ['addedByPhone', '通过手机号找到我'],
    ];
    const result: Array<{ key: string; title: string; mode: string; available: boolean; exceptions: { allowedUsers: number; blockedUsers: number; allowedChats: number; blockedChats: number; otherRules: number } }> = [];
    for (const [key, title] of settings) {
      let privacy: any;
      try {
        privacy = await this.client.invoke(new Api.account.GetPrivacy({ key: this.accountPrivacyKey(key) })) as any;
      } catch {
        result.push({ key, title, mode: 'unavailable', available: false,
          exceptions: { allowedUsers: 0, blockedUsers: 0, allowedChats: 0, blockedChats: 0, otherRules: 0 } });
        continue;
      }
      const rules: any[] = privacy?.rules || [];
      let mode = 'custom';
      for (const rule of rules) {
        const type = rule?.className || '';
        if (type === 'PrivacyValueAllowAll') { mode = 'everybody'; break; }
        if (type === 'PrivacyValueAllowContacts') { mode = 'contacts'; break; }
        if (type === 'PrivacyValueDisallowAll') { mode = 'nobody'; break; }
      }
      const counts = { allowedUsers: 0, blockedUsers: 0, allowedChats: 0, blockedChats: 0, otherRules: 0 };
      for (const rule of rules) {
        const type = rule?.className || '';
        if (type === 'PrivacyValueAllowUsers') counts.allowedUsers += rule.users?.length || 0;
        else if (type === 'PrivacyValueDisallowUsers') counts.blockedUsers += rule.users?.length || 0;
        else if (type === 'PrivacyValueAllowChatParticipants') counts.allowedChats += rule.chats?.length || 0;
        else if (type === 'PrivacyValueDisallowChatParticipants') counts.blockedChats += rule.chats?.length || 0;
        else if (!['PrivacyValueAllowAll', 'PrivacyValueAllowContacts', 'PrivacyValueDisallowAll', 'PrivacyValueDisallowContacts'].includes(type)) counts.otherRules++;
      }
      result.push({ key, title, mode, available: true, exceptions: counts });
    }
    return result;
  }

  async getAccountPrivacyExceptions(key: string): Promise<Array<{ id: string; category: string; title: string; kind: 'user' | 'chat' }>> {
    const privacy = await this.client.invoke(new Api.account.GetPrivacy({ key: this.accountPrivacyKey(key) })) as any;
    const users = new Map<string, any>();
    for (const user of privacy?.users || []) if (user?.id != null) users.set(String(user.id), user);
    const chats = new Map<string, any>();
    for (const chat of privacy?.chats || []) if (chat?.id != null) chats.set(String(chat.id), chat);
    const result: Array<{ id: string; category: string; title: string; kind: 'user' | 'chat' }> = [];
    const append = (values: any[], category: string, kind: 'user' | 'chat') => {
      for (const value of values || []) {
        const id = String(value?.toString?.() ?? value ?? '');
        if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) continue;
        const entity = (kind === 'user' ? users : chats).get(id);
        const title = kind === 'user'
          ? [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || (entity?.username ? `@${entity.username}` : `Telegram 用户 ${id}`)
          : String(entity?.title || `Telegram 群组 ${id}`);
        result.push({ id, category, title, kind });
      }
    };
    for (const rule of privacy?.rules || []) {
      switch (rule?.className) {
        case 'PrivacyValueAllowUsers': append(rule.users, 'allowedUsers', 'user'); break;
        case 'PrivacyValueDisallowUsers': append(rule.users, 'blockedUsers', 'user'); break;
        case 'PrivacyValueAllowChatParticipants': append(rule.chats, 'allowedChats', 'chat'); break;
        case 'PrivacyValueDisallowChatParticipants': append(rule.chats, 'blockedChats', 'chat'); break;
      }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getAccountPrivacySpecialRules(key: string): Promise<{ allowPremium: boolean; botAccess: 'default' | 'allow' | 'deny'; editable: boolean; unsupportedRules: number }> {
    const privacy = await this.client.invoke(new Api.account.GetPrivacy({ key: this.accountPrivacyKey(key) })) as any;
    const rules: any[] = privacy?.rules || [];
    const known = new Set([
      'PrivacyValueAllowAll', 'PrivacyValueAllowContacts', 'PrivacyValueDisallowAll', 'PrivacyValueDisallowContacts',
      'PrivacyValueAllowUsers', 'PrivacyValueDisallowUsers', 'PrivacyValueAllowChatParticipants',
      'PrivacyValueDisallowChatParticipants', 'PrivacyValueAllowCloseFriends', 'PrivacyValueAllowPremium',
      'PrivacyValueAllowBots', 'PrivacyValueDisallowBots',
    ]);
    const botRule = rules.find(rule => ['PrivacyValueAllowBots', 'PrivacyValueDisallowBots'].includes(rule?.className || ''));
    return {
      allowPremium: rules.some(rule => rule?.className === 'PrivacyValueAllowPremium'),
      botAccess: botRule?.className === 'PrivacyValueAllowBots' ? 'allow'
        : botRule?.className === 'PrivacyValueDisallowBots' ? 'deny' : 'default',
      editable: rules.every(rule => known.has(rule?.className || '')),
      unsupportedRules: rules.filter(rule => !known.has(rule?.className || '')).length,
    };
  }

  async setAccountPrivacySpecialRule(key: string, field: string, value: boolean | string): Promise<void> {
    if (!['allowPremium', 'botAccess'].includes(field) ||
        (field === 'allowPremium' && typeof value !== 'boolean') ||
        (field === 'botAccess' && !['default', 'allow', 'deny'].includes(String(value)))) {
      throw new Error('Invalid Telegram privacy special rule');
    }
    const inputKey = this.accountPrivacyKey(key);
    const current = await this.client.invoke(new Api.account.GetPrivacy({ key: inputKey })) as any;
    const usersById = new Map<string, any>();
    for (const user of current?.users || []) {
      const id = user?.id?.toString?.() ?? String(user?.id ?? '');
      if (id) usersById.set(id, user);
    }
    const inputUsers = (ids: any[]) => (ids || []).map(id => {
      const userId = id?.toString?.() ?? String(id);
      if (this.selfId && userId === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(userId);
      if (!user?.accessHash) throw new Error('无法安全保留此隐私规则中的用户例外');
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    });
    const preserveRule = (rule: any): Api.TypeInputPrivacyRule => {
      switch (rule?.className) {
        case 'PrivacyValueAllowAll': return new Api.InputPrivacyValueAllowAll();
        case 'PrivacyValueAllowContacts': return new Api.InputPrivacyValueAllowContacts();
        case 'PrivacyValueDisallowAll': return new Api.InputPrivacyValueDisallowAll();
        case 'PrivacyValueDisallowContacts': return new Api.InputPrivacyValueDisallowContacts();
        case 'PrivacyValueAllowUsers': return new Api.InputPrivacyValueAllowUsers({ users: inputUsers(rule.users) });
        case 'PrivacyValueDisallowUsers': return new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(rule.users) });
        case 'PrivacyValueAllowChatParticipants': return new Api.InputPrivacyValueAllowChatParticipants({ chats: rule.chats || [] });
        case 'PrivacyValueDisallowChatParticipants': return new Api.InputPrivacyValueDisallowChatParticipants({ chats: rule.chats || [] });
        case 'PrivacyValueAllowCloseFriends': return new Api.InputPrivacyValueAllowCloseFriends();
        case 'PrivacyValueAllowPremium': return new Api.InputPrivacyValueAllowPremium();
        case 'PrivacyValueAllowBots': return new Api.InputPrivacyValueAllowBots();
        case 'PrivacyValueDisallowBots': return new Api.InputPrivacyValueDisallowBots();
        default: throw new Error('此隐私设置包含当前界面无法安全保留的规则，未执行更改');
      }
    };
    const specialClass = field === 'allowPremium' ? 'PrivacyValueAllowPremium' : '';
    const desiredBotClass = value === 'allow' ? 'PrivacyValueAllowBots' : value === 'deny' ? 'PrivacyValueDisallowBots' : '';
    const rules: Api.TypeInputPrivacyRule[] = [];
    let targetExists = false;
    for (const rule of current?.rules || []) {
      const type = rule?.className || '';
      if (field === 'allowPremium' && type === specialClass) {
        targetExists = true;
        if (value) rules.push(preserveRule(rule));
        continue;
      }
      if (field === 'botAccess' && ['PrivacyValueAllowBots', 'PrivacyValueDisallowBots'].includes(type)) {
        if (type === desiredBotClass) { targetExists = true; rules.push(preserveRule(rule)); }
        continue;
      }
      rules.push(preserveRule(rule));
    }
    const shouldAdd = field === 'allowPremium' ? value === true : Boolean(desiredBotClass);
    if (shouldAdd && !targetExists) {
      const added = field === 'allowPremium' ? new Api.InputPrivacyValueAllowPremium()
        : desiredBotClass === 'PrivacyValueAllowBots' ? new Api.InputPrivacyValueAllowBots() : new Api.InputPrivacyValueDisallowBots();
      const baseRuleTypes = new Set(['InputPrivacyValueAllowAll', 'InputPrivacyValueAllowContacts', 'InputPrivacyValueDisallowAll', 'InputPrivacyValueDisallowContacts', 'InputPrivacyValueAllowCloseFriends']);
      const baseIndex = rules.findIndex(rule => baseRuleTypes.has(rule.className));
      rules.splice(baseIndex < 0 ? rules.length : baseIndex, 0, added);
    }
    await this.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
  }

  async removeAccountPrivacyException(key: string, category: string, entityId: string): Promise<void> {
    const allowedCategories = new Set(['allowedUsers', 'blockedUsers', 'allowedChats', 'blockedChats']);
    if (!allowedCategories.has(category) || typeof entityId !== 'string' || !/^\d{1,20}$/.test(entityId) || /^0+$/.test(entityId)) {
      throw new Error('Invalid account privacy exception');
    }
    const inputKey = this.accountPrivacyKey(key);
    const current = await this.client.invoke(new Api.account.GetPrivacy({ key: inputKey })) as any;
    const usersById = new Map<string, any>();
    for (const user of current?.users || []) if (user?.id != null) usersById.set(String(user.id), user);
    const inputUsers = (ids: any[]) => (ids || []).map(id => {
      const userId = String(id?.toString?.() ?? id);
      if (this.selfId && userId === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(userId);
      if (!user?.accessHash) throw new Error('无法安全保留此隐私规则中的用户例外');
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    });
    const targetRules: Record<string, string> = {
      allowedUsers: 'PrivacyValueAllowUsers', blockedUsers: 'PrivacyValueDisallowUsers',
      allowedChats: 'PrivacyValueAllowChatParticipants', blockedChats: 'PrivacyValueDisallowChatParticipants',
    };
    let removed = false;
    const rules: Api.TypeInputPrivacyRule[] = [];
    for (const rule of current?.rules || []) {
      const type = rule?.className || '';
      if (type === targetRules[category]) {
        const field = category.endsWith('Users') ? 'users' : 'chats';
        const values = rule[field] || [];
        if (values.some((value: any) => String(value?.toString?.() ?? value) === entityId)) removed = true;
        const remaining = values.filter((value: any) => String(value?.toString?.() ?? value) !== entityId);
        if (!remaining.length) continue;
        if (field === 'users') {
          const mapped = inputUsers(remaining);
          rules.push(category === 'allowedUsers'
            ? new Api.InputPrivacyValueAllowUsers({ users: mapped })
            : new Api.InputPrivacyValueDisallowUsers({ users: mapped }));
        } else {
          rules.push(category === 'allowedChats'
            ? new Api.InputPrivacyValueAllowChatParticipants({ chats: remaining })
            : new Api.InputPrivacyValueDisallowChatParticipants({ chats: remaining }));
        }
        continue;
      }
      switch (type) {
        case 'PrivacyValueAllowAll': rules.push(new Api.InputPrivacyValueAllowAll()); break;
        case 'PrivacyValueAllowContacts': rules.push(new Api.InputPrivacyValueAllowContacts()); break;
        case 'PrivacyValueDisallowAll': rules.push(new Api.InputPrivacyValueDisallowAll()); break;
        case 'PrivacyValueDisallowContacts': rules.push(new Api.InputPrivacyValueDisallowContacts()); break;
        case 'PrivacyValueAllowUsers': rules.push(new Api.InputPrivacyValueAllowUsers({ users: inputUsers(rule.users) })); break;
        case 'PrivacyValueDisallowUsers': rules.push(new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(rule.users) })); break;
        case 'PrivacyValueAllowChatParticipants': rules.push(new Api.InputPrivacyValueAllowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueDisallowChatParticipants': rules.push(new Api.InputPrivacyValueDisallowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueAllowCloseFriends': rules.push(new Api.InputPrivacyValueAllowCloseFriends()); break;
        case 'PrivacyValueAllowPremium': rules.push(new Api.InputPrivacyValueAllowPremium()); break;
        case 'PrivacyValueAllowBots': rules.push(new Api.InputPrivacyValueAllowBots()); break;
        case 'PrivacyValueDisallowBots': rules.push(new Api.InputPrivacyValueDisallowBots()); break;
        default: throw new Error('此隐私设置包含当前界面无法安全保留的规则，未执行更改');
      }
    }
    if (!removed) throw new Error('未找到此隐私例外，规则可能已经变更');
    await this.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
  }

  async addAccountPrivacyUserException(key: string, category: string, userId: string): Promise<void> {
    if (!['allowedUsers', 'blockedUsers'].includes(category) || typeof userId !== 'string' || !/^\d{1,20}$/.test(userId) || /^0+$/.test(userId)) {
      throw new Error('Invalid account privacy exception');
    }
    if (this.selfId && userId === String(this.selfId)) throw new Error('Cannot add the current account as its own privacy exception');
    const inputKey = this.accountPrivacyKey(key);
    const current = await this.client.invoke(new Api.account.GetPrivacy({ key: inputKey })) as any;
    const usersById = new Map<string, any>();
    for (const user of current?.users || []) if (user?.id != null) usersById.set(String(user.id), user);
    const inputUsers = (ids: any[]) => (ids || []).map(id => {
      const idString = String(id?.toString?.() ?? id);
      if (this.selfId && idString === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(idString);
      if (!user?.accessHash) throw new Error('无法安全保留此隐私规则中的用户例外');
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    });
    const targetPeer = await this.client.getInputEntity(BigInt(userId) as any) as any;
    const targetInput = targetPeer?.className === 'InputPeerSelf' || targetPeer?.className === 'InputUserSelf'
      ? new Api.InputUserSelf()
      : targetPeer?.className === 'InputPeerUser' && targetPeer.accessHash
        ? new Api.InputUser({ userId: targetPeer.userId, accessHash: targetPeer.accessHash })
        : undefined;
    if (!targetInput) throw new Error('无法安全解析此 Telegram 用户');

    const desiredRuleName = category === 'allowedUsers' ? 'PrivacyValueAllowUsers' : 'PrivacyValueDisallowUsers';
    const oppositeRuleName = category === 'allowedUsers' ? 'PrivacyValueDisallowUsers' : 'PrivacyValueAllowUsers';
    const rules: Api.TypeInputPrivacyRule[] = [];
    let alreadyPresent = false;
    let inserted = false;
    for (const rule of current?.rules || []) {
      const type = rule?.className || '';
      if (type === desiredRuleName || type === oppositeRuleName) {
        const idList: any[] = rule.users || [];
        const hasTarget = idList.some(id => String(id?.toString?.() ?? id) === userId);
        if (type === desiredRuleName && hasTarget) alreadyPresent = true;
        const remaining = type === oppositeRuleName ? idList.filter(id => String(id?.toString?.() ?? id) !== userId) : idList;
        if (!remaining.length && type === oppositeRuleName) continue;
        const mapped = inputUsers(remaining);
        const finalUsers = type === desiredRuleName && !inserted
          ? (inserted = true, hasTarget ? mapped : [...mapped, targetInput]) : mapped;
        rules.push(type === 'PrivacyValueAllowUsers'
          ? new Api.InputPrivacyValueAllowUsers({ users: finalUsers })
          : new Api.InputPrivacyValueDisallowUsers({ users: finalUsers }));
        continue;
      }
      switch (type) {
        case 'PrivacyValueAllowAll': rules.push(new Api.InputPrivacyValueAllowAll()); break;
        case 'PrivacyValueAllowContacts': rules.push(new Api.InputPrivacyValueAllowContacts()); break;
        case 'PrivacyValueDisallowAll': rules.push(new Api.InputPrivacyValueDisallowAll()); break;
        case 'PrivacyValueDisallowContacts': rules.push(new Api.InputPrivacyValueDisallowContacts()); break;
        case 'PrivacyValueAllowChatParticipants': rules.push(new Api.InputPrivacyValueAllowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueDisallowChatParticipants': rules.push(new Api.InputPrivacyValueDisallowChatParticipants({ chats: rule.chats || [] })); break;
        case 'PrivacyValueAllowCloseFriends': rules.push(new Api.InputPrivacyValueAllowCloseFriends()); break;
        case 'PrivacyValueAllowPremium': rules.push(new Api.InputPrivacyValueAllowPremium()); break;
        case 'PrivacyValueAllowBots': rules.push(new Api.InputPrivacyValueAllowBots()); break;
        case 'PrivacyValueDisallowBots': rules.push(new Api.InputPrivacyValueDisallowBots()); break;
        default: throw new Error('此隐私设置包含当前界面无法安全保留的规则，未执行更改');
      }
    }
    if (!alreadyPresent && !inserted) {
      const added = category === 'allowedUsers'
        ? new Api.InputPrivacyValueAllowUsers({ users: [targetInput] })
        : new Api.InputPrivacyValueDisallowUsers({ users: [targetInput] });
      rules.unshift(added);
    }
    if (alreadyPresent && !rules.some(rule => rule.className === (category === 'allowedUsers' ? 'InputPrivacyValueDisallowUsers' : 'InputPrivacyValueAllowUsers'))) return;
    await this.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
  }

  async addAccountPrivacyChatException(key: string, category: string, chatId: number): Promise<void> {
    if (!['allowedChats', 'blockedChats'].includes(category) || !Number.isSafeInteger(chatId) || chatId >= 0) {
      throw new Error('Invalid account privacy chat exception');
    }
    const inputKey = this.accountPrivacyKey(key);
    const resolved = await this.client.getInputEntity(this.resolvePeer(chatId));
    let targetChatId: any;
    if (resolved instanceof Api.InputPeerChat) {
      targetChatId = resolved.chatId;
    } else if (resolved instanceof Api.InputPeerChannel) {
      const entity = await this.client.getEntity(resolved) as any;
      if (entity instanceof Api.Channel && entity.megagroup && !entity.broadcast) targetChatId = resolved.channelId;
    }
    if (targetChatId == null) throw new Error('只能将群组或超级群组添加为隐私例外');
    const targetId = String(targetChatId?.toString?.() ?? targetChatId);
    if (!/^\d{1,20}$/.test(targetId) || /^0+$/.test(targetId)) throw new Error('Invalid account privacy chat exception');

    const current = await this.client.invoke(new Api.account.GetPrivacy({ key: inputKey })) as any;
    const usersById = new Map<string, any>();
    for (const user of current?.users || []) if (user?.id != null) usersById.set(String(user.id), user);
    const inputUsers = (ids: any[]) => (ids || []).map(id => {
      const userId = String(id?.toString?.() ?? id);
      if (this.selfId && userId === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(userId);
      if (!user?.accessHash) throw new Error('无法安全保留此隐私规则中的用户例外');
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    });
    const desiredRuleName = category === 'allowedChats' ? 'PrivacyValueAllowChatParticipants' : 'PrivacyValueDisallowChatParticipants';
    const oppositeRuleName = category === 'allowedChats' ? 'PrivacyValueDisallowChatParticipants' : 'PrivacyValueAllowChatParticipants';
    const rules: Api.TypeInputPrivacyRule[] = [];
    let alreadyPresent = false;
    let removedOpposite = false;
    let inserted = false;
    const mapChats = (values: any[]) => (values || []).map(value => BigInt(String(value?.toString?.() ?? value)) as any);
    for (const rule of current?.rules || []) {
      const type = rule?.className || '';
      if (type === desiredRuleName || type === oppositeRuleName) {
        const values: any[] = rule.chats || [];
        const hasTarget = values.some(value => String(value?.toString?.() ?? value) === targetId);
        if (type === desiredRuleName && hasTarget) alreadyPresent = true;
        const remaining = type === oppositeRuleName ? values.filter(value => String(value?.toString?.() ?? value) !== targetId) : values;
        if (type === oppositeRuleName && hasTarget) removedOpposite = true;
        if (!remaining.length && type === oppositeRuleName) continue;
        const mapped = mapChats(remaining);
        const finalChats = type === desiredRuleName && !inserted
          ? (inserted = true, hasTarget ? mapped : [...mapped, BigInt(targetId) as any]) : mapped;
        rules.push(type === 'PrivacyValueAllowChatParticipants'
          ? new Api.InputPrivacyValueAllowChatParticipants({ chats: finalChats })
          : new Api.InputPrivacyValueDisallowChatParticipants({ chats: finalChats }));
        continue;
      }
      switch (type) {
        case 'PrivacyValueAllowAll': rules.push(new Api.InputPrivacyValueAllowAll()); break;
        case 'PrivacyValueAllowContacts': rules.push(new Api.InputPrivacyValueAllowContacts()); break;
        case 'PrivacyValueDisallowAll': rules.push(new Api.InputPrivacyValueDisallowAll()); break;
        case 'PrivacyValueDisallowContacts': rules.push(new Api.InputPrivacyValueDisallowContacts()); break;
        case 'PrivacyValueAllowUsers': rules.push(new Api.InputPrivacyValueAllowUsers({ users: inputUsers(rule.users) })); break;
        case 'PrivacyValueDisallowUsers': rules.push(new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(rule.users) })); break;
        case 'PrivacyValueAllowChatParticipants': rules.push(new Api.InputPrivacyValueAllowChatParticipants({ chats: mapChats(rule.chats) })); break;
        case 'PrivacyValueDisallowChatParticipants': rules.push(new Api.InputPrivacyValueDisallowChatParticipants({ chats: mapChats(rule.chats) })); break;
        case 'PrivacyValueAllowCloseFriends': rules.push(new Api.InputPrivacyValueAllowCloseFriends()); break;
        case 'PrivacyValueAllowPremium': rules.push(new Api.InputPrivacyValueAllowPremium()); break;
        case 'PrivacyValueAllowBots': rules.push(new Api.InputPrivacyValueAllowBots()); break;
        case 'PrivacyValueDisallowBots': rules.push(new Api.InputPrivacyValueDisallowBots()); break;
        default: throw new Error('此隐私设置包含当前界面无法安全保留的规则，未执行更改');
      }
    }
    if (!alreadyPresent && !inserted) {
      const added = category === 'allowedChats'
        ? new Api.InputPrivacyValueAllowChatParticipants({ chats: [BigInt(targetId) as any] })
        : new Api.InputPrivacyValueDisallowChatParticipants({ chats: [BigInt(targetId) as any] });
      rules.unshift(added);
    }
    if (alreadyPresent && !removedOpposite) return;
    await this.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
  }

  async setAccountPrivacySetting(key: string, mode: string): Promise<void> {
    const inputKey = this.accountPrivacyKey(key);
    const newBase = mode === 'everybody' ? new Api.InputPrivacyValueAllowAll()
      : mode === 'contacts' ? new Api.InputPrivacyValueAllowContacts()
      : mode === 'nobody' ? new Api.InputPrivacyValueDisallowAll()
      : mode === 'closeFriends' ? new Api.InputPrivacyValueAllowCloseFriends()
      : undefined;
    if (!newBase) throw new Error('Invalid account privacy mode');

    const current = await this.client.invoke(new Api.account.GetPrivacy({ key: inputKey })) as any;
    const usersById = new Map<string, any>();
    for (const user of current?.users || []) {
      const id = user?.id?.toString?.() ?? String(user?.id ?? '');
      if (id) usersById.set(id, user);
    }
    const inputUsers = (ids: any[]) => (ids || []).map(id => {
      const userId = id?.toString?.() ?? String(id);
      if (this.selfId && userId === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(userId);
      if (!user?.accessHash) throw new Error('无法安全保留此隐私规则中的用户例外');
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
    });
    const generalRuleNames = new Set(['PrivacyValueAllowAll', 'PrivacyValueAllowContacts', 'PrivacyValueDisallowAll']);
    const preserveRule = (rule: any): Api.TypeInputPrivacyRule => {
      switch (rule?.className) {
        case 'PrivacyValueAllowAll': return new Api.InputPrivacyValueAllowAll();
        case 'PrivacyValueAllowContacts': return new Api.InputPrivacyValueAllowContacts();
        case 'PrivacyValueDisallowAll': return new Api.InputPrivacyValueDisallowAll();
        case 'PrivacyValueDisallowContacts': return new Api.InputPrivacyValueDisallowContacts();
        case 'PrivacyValueDisallowContacts': return new Api.InputPrivacyValueDisallowContacts();
        case 'PrivacyValueAllowUsers': return new Api.InputPrivacyValueAllowUsers({ users: inputUsers(rule.users) });
        case 'PrivacyValueDisallowUsers': return new Api.InputPrivacyValueDisallowUsers({ users: inputUsers(rule.users) });
        case 'PrivacyValueAllowChatParticipants': return new Api.InputPrivacyValueAllowChatParticipants({ chats: rule.chats || [] });
        case 'PrivacyValueDisallowChatParticipants': return new Api.InputPrivacyValueDisallowChatParticipants({ chats: rule.chats || [] });
        case 'PrivacyValueAllowCloseFriends': return new Api.InputPrivacyValueAllowCloseFriends();
        case 'PrivacyValueAllowPremium': return new Api.InputPrivacyValueAllowPremium();
        case 'PrivacyValueAllowBots': return new Api.InputPrivacyValueAllowBots();
        case 'PrivacyValueDisallowBots': return new Api.InputPrivacyValueDisallowBots();
        default: throw new Error('此隐私设置包含当前界面无法安全保留的规则，未执行更改');
      }
    };
    const rules: Api.TypeInputPrivacyRule[] = [];
    let replacedBase = false;
    for (const rule of current?.rules || []) {
      if (generalRuleNames.has(rule?.className || '')) {
        if (!replacedBase) { rules.push(newBase); replacedBase = true; }
      } else {
        rules.push(preserveRule(rule));
      }
    }
    if (!replacedBase) rules.unshift(newBase);
    await this.client.invoke(new Api.account.SetPrivacy({ key: inputKey, rules }));
  }

  private accountGlobalPrivacyFields(): Record<string, 'archiveAndMuteNewNoncontactPeers' | 'keepArchivedUnmuted' | 'keepArchivedFolders' | 'hideReadMarks' | 'newNoncontactPeersRequirePremium'> {
    return {
      archiveNewNoncontacts: 'archiveAndMuteNewNoncontactPeers',
      keepArchivedUnmuted: 'keepArchivedUnmuted',
      keepArchivedFolders: 'keepArchivedFolders',
      hideReadMarks: 'hideReadMarks',
      requirePremiumForNewNoncontacts: 'newNoncontactPeersRequirePremium',
    };
  }

  async getAccountGlobalPrivacySettings(): Promise<Array<{ key: string; title: string; description: string; value: boolean }>> {
    const current = await this.client.invoke(new Api.account.GetGlobalPrivacySettings()) as Api.GlobalPrivacySettings;
    const fields = this.accountGlobalPrivacyFields();
    const titles: Record<string, [string, string]> = {
      archiveNewNoncontacts: ['自动归档陌生人', '自动归档并静音未保存为联系人的新会话。'],
      keepArchivedUnmuted: ['归档会话继续提醒', '允许已归档的会话继续发送通知。'],
      keepArchivedFolders: ['保留归档文件夹', '归档会话所在的文件夹保持可见。'],
      hideReadMarks: ['隐藏已读标记', '在支持的会话中隐藏消息已读状态。'],
      requirePremiumForNewNoncontacts: ['限制陌生人发消息', '要求非联系人的新会话满足 Telegram Premium 条件。'],
    };
    return Object.entries(fields).map(([key, field]) => ({ key, title: titles[key][0], description: titles[key][1], value: Boolean(current?.[field]) }));
  }

  async setAccountGlobalPrivacySetting(key: string, value: boolean): Promise<void> {
    const field = this.accountGlobalPrivacyFields()[key];
    if (!field || typeof value !== 'boolean') throw new Error('Invalid Telegram global privacy setting');
    const current = await this.client.invoke(new Api.account.GetGlobalPrivacySettings()) as Api.GlobalPrivacySettings;
    const settings = new Api.GlobalPrivacySettings({
      archiveAndMuteNewNoncontactPeers: Boolean(current?.archiveAndMuteNewNoncontactPeers),
      keepArchivedUnmuted: Boolean(current?.keepArchivedUnmuted),
      keepArchivedFolders: Boolean(current?.keepArchivedFolders),
      hideReadMarks: Boolean(current?.hideReadMarks),
      newNoncontactPeersRequirePremium: Boolean(current?.newNoncontactPeersRequirePremium),
      [field]: value,
    });
    const updated = await this.client.invoke(new Api.account.SetGlobalPrivacySettings({ settings }));
    if (!updated) throw new Error('Telegram 未确认保存全局隐私设置');
  }

  private accountNotifyPeer(key: string): Api.TypeInputNotifyPeer {
    switch (key) {
      case 'private': return new Api.InputNotifyUsers();
      case 'groups': return new Api.InputNotifyChats();
      case 'channels': return new Api.InputNotifyBroadcasts();
      default: throw new Error('Unsupported Telegram notification category');
    }
  }

  private notificationSoundSummary(settings: any): { soundId: string; soundTitle: string } {
    const sound = settings?.otherSound || settings?.iosSound || settings?.androidSound;
    if (!sound || sound.className === 'NotificationSoundDefault') return { soundId: 'default', soundTitle: '默认提示音' };
    if (sound.className === 'NotificationSoundNone') return { soundId: 'none', soundTitle: '无提示音' };
    if (sound.className === 'NotificationSoundRingtone' && sound.id != null) return { soundId: String(sound.id), soundTitle: 'Telegram 提示音' };
    if (sound.className === 'NotificationSoundLocal') return { soundId: 'local', soundTitle: String(sound.title || '设备自定义提示音') };
    return { soundId: 'custom', soundTitle: '自定义提示音' };
  }

  private notificationSoundInput(soundId: string): Api.TypeNotificationSound {
    if (soundId === 'default') return new Api.NotificationSoundDefault();
    if (soundId === 'none') return new Api.NotificationSoundNone();
    if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId) || BigInt(soundId) > 9223372036854775807n) {
      throw new Error('Invalid Telegram notification sound');
    }
    return new Api.NotificationSoundRingtone({ id: BigInt(soundId) as any });
  }

  async getAccountNotificationSounds(): Promise<Array<{ id: string; title: string }>> {
    const sounds: Array<{ id: string; title: string }> = [
      { id: 'default', title: '默认提示音' }, { id: 'none', title: '无提示音' },
    ];
    try {
      const result = await this.client.invoke(new Api.account.GetSavedRingtones({ hash: BigInt(0) as any })) as any;
      for (const document of result?.ringtones || []) {
        if (!(document instanceof Api.Document) || !document.id) continue;
        const filename = (document.attributes || []).find((attribute: any) => attribute?.className === 'DocumentAttributeFilename') as any;
        const title = typeof filename?.fileName === 'string' ? filename.fileName.replace(/\.[^.]+$/, '') : '';
        sounds.push({ id: String(document.id), title: title || `Telegram 提示音 ${document.id}` });
      }
    } catch { /* Default and silent sounds remain available if the saved sound list cannot be read. */ }
    return sounds;
  }

  async downloadAccountNotificationSound(soundId: string): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId) || BigInt(soundId) > 9223372036854775807n || !this.selfId) {
      throw new Error('Invalid Telegram notification sound');
    }
    const result = await this.client.invoke(new Api.account.GetSavedRingtones({ hash: BigInt(0) as any })) as any;
    const document = (result?.ringtones || []).find((item: any) => item instanceof Api.Document && String(item.id) === soundId);
    if (!document?.accessHash) return undefined;
    const mimeType = String(document.mimeType || '');
    if (!/^audio\/[a-z0-9.+-]+$/i.test(mimeType) || Number(document.size) > 10 * 1024 * 1024) return undefined;
    const extension = mimeType === 'audio/ogg' ? '.ogg' : mimeType === 'audio/mpeg' ? '.mp3' : '.audio';
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const targetPath = path.resolve('data', 'cache', 'ringtones', `${namespace}_${soundId}${extension}`);
    const location = new Api.InputDocumentFileLocation({
      id: document.id, accessHash: document.accessHash,
      fileReference: document.fileReference ? Buffer.from(document.fileReference) : Buffer.alloc(0), thumbSize: '',
    });
    const downloaded = await downloadMediaToCache(targetPath, temporaryPath => withAwaitedFileWriter(temporaryPath, writer =>
      this.client.downloadFile(location as any, { outputFile: writer as any })));
    return downloaded ? { filePath: targetPath, mimeType } : undefined;
  }

  async uploadAccountNotificationSound(uploadPath: string, fileName: string, mimeType: string): Promise<void> {
    const name = path.basename(String(fileName || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(-128);
    const mime = String(mimeType || '').trim().toLowerCase();
    if (!name || name === '.' || name === '..' || !/^audio\/[a-z0-9.+-]+$/.test(mime) ||
        typeof uploadPath !== 'string' || !uploadPath) throw new Error('Invalid Telegram notification sound upload');
    const stat = fs.statSync(uploadPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error('Telegram notification sounds must be smaller than 5 MiB');
    const file = await this.client.uploadFile({ file: new CustomFile(name, stat.size, uploadPath), workers: 1 });
    const result = await this.client.invoke(new Api.account.UploadRingtone({ file, fileName: name, mimeType: mime })) as any;
    if (!(result instanceof Api.Document)) throw new Error('Telegram did not confirm the uploaded notification sound');
  }

  async removeAccountNotificationSound(soundId: string): Promise<void> {
    if (!/^\d{1,20}$/.test(soundId) || /^0+$/.test(soundId) || BigInt(soundId) > 9223372036854775807n) {
      throw new Error('Invalid Telegram notification sound');
    }
    const result = await this.client.invoke(new Api.account.GetSavedRingtones({ hash: BigInt(0) as any })) as any;
    const document = (result?.ringtones || []).find((item: any) => item instanceof Api.Document && String(item.id) === soundId);
    if (!document?.accessHash) throw new Error('Telegram notification sound was not found');
    const saved = await this.client.invoke(new Api.account.SaveRingtone({
      id: new Api.InputDocument({ id: document.id, accessHash: document.accessHash,
        fileReference: document.fileReference ? Buffer.from(document.fileReference) : Buffer.alloc(0) }),
      unsave: true,
    }));
    if (!(saved instanceof Api.account.SavedRingtone) && !(saved instanceof Api.account.SavedRingtoneConverted)) {
      throw new Error('Telegram did not confirm removal of the notification sound');
    }
  }

  async prepareChatPaidMediaPayment(chatId: number, messageId: number): Promise<{ token: string; stars: string; itemCount: number; title: string; description: string }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid paid media target');
    }
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages.find((item: any) => Number(item?.id) === messageId) as any;
    const media = message?.media;
    if (!message || message.out || !(media instanceof Api.MessageMediaPaidMedia) ||
        !Array.isArray(media.extendedMedia) || !media.extendedMedia.some((item: any) => item instanceof Api.MessageExtendedMediaPreview)) {
      throw new Error('这条消息没有仍可购买的 Telegram 付费媒体');
    }
    const inputPeer = await this.client.getInputEntity(peer);
    const invoice = new Api.InputInvoiceMessage({ peer: inputPeer, msgId: messageId });
    const form = await this.client.invoke(new Api.payments.GetPaymentForm({ invoice })) as any;
    if (!(form instanceof Api.payments.PaymentFormStars) || form.formId == null || !(form.invoice instanceof Api.Invoice)) {
      throw new Error('Telegram 未返回有效的付费媒体 Stars 表单');
    }
    if (form.invoice.currency !== 'XTR' || !Array.isArray(form.invoice.prices) || !form.invoice.prices.length) {
      throw new Error('Telegram 返回了无效的付费媒体金额');
    }
    let amount = 0n;
    try { amount = form.invoice.prices.reduce((sum: bigint, price: any) => sum + BigInt(String(price.amount)), 0n); }
    catch { throw new Error('Telegram 返回了无效的付费媒体金额'); }
    if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error('Telegram 返回了无效的付费媒体金额');
    const now = Date.now();
    for (const [token, pending] of this.pendingPaidMediaPayments) if (pending.expiresAt <= now) this.pendingPaidMediaPayments.delete(token);
    while (this.pendingPaidMediaPayments.size >= 20) this.pendingPaidMediaPayments.delete(this.pendingPaidMediaPayments.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    this.pendingPaidMediaPayments.set(token, {
      chatId, messageId, stars: amount.toString(), itemCount: media.extendedMedia.length,
      formId: form.formId, invoice, expiresAt: now + 120_000,
    });
    return { token, stars: amount.toString(), itemCount: media.extendedMedia.length,
      title: String(form.title || '付费媒体').slice(0, 256), description: String(form.description || '').slice(0, 1024) };
  }

  async confirmChatPaidMediaPayment(token: string, chatId: number, messageId: number): Promise<{ stars: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || !Number.isSafeInteger(chatId) || chatId === 0 ||
        !Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid paid media payment confirmation');
    const pending = this.pendingPaidMediaPayments.get(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.chatId !== chatId || pending.messageId !== messageId) {
      throw new Error('Paid media confirmation expired or does not match');
    }
    this.pendingPaidMediaPayments.delete(token);
    const result = await this.client.invoke(new Api.payments.SendStarsForm({ formId: pending.formId, invoice: pending.invoice })) as any;
    if (result instanceof Api.payments.PaymentVerificationNeeded) {
      throw new Error('Telegram 要求在其他设备完成付款验证；媒体尚未确认解锁');
    }
    if (!(result instanceof Api.payments.PaymentResult)) throw new Error('Telegram 未确认付费媒体已解锁');
    return { stars: pending.stars };
  }

  async getAccountStars(offset = '', limit = 20): Promise<{
    balance: { amount: string; nanos: number };
    transactions: Array<{ id: string; stars: { amount: string; nanos: number }; date: number; title: string; description: string; kind: string; status: string }>;
    nextOffset: string;
  }> {
    if (typeof offset !== 'string' || offset.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid Telegram Stars pagination');
    }
    const response = await this.client.invoke(new Api.payments.GetStarsTransactions({
      peer: new Api.InputPeerSelf(), offset, limit,
    })) as any;
    if (!(response instanceof Api.payments.StarsStatus)) throw new Error('Telegram returned invalid Stars status');
    const amount = (value: any) => ({ amount: String(value?.amount ?? 0), nanos: Number(value?.nanos) || 0 });
    return {
      balance: amount(response.balance),
      transactions: (response.history || []).map((transaction: any) => ({
        id: String(transaction.id), stars: amount(transaction.stars), date: Number(transaction.date) || 0,
        title: String(transaction.title || ''), description: String(transaction.description || ''),
        kind: String(transaction.peer?.className || 'StarsTransactionPeer'),
        status: transaction.failed ? 'failed' : transaction.pending ? 'pending' : transaction.refund ? 'refund' : 'complete',
      })),
      nextOffset: typeof response.nextOffset === 'string' ? response.nextOffset : '',
    };
  }

  async getAccountStarsTopupOptions(): Promise<Array<{ id: string; stars: string; currency: string; amount: string; extended: boolean }>> {
    const response = await this.client.invoke(new Api.payments.GetStarsTopupOptions()) as any;
    if (!Array.isArray(response)) throw new Error('Telegram returned invalid Stars top-up options');
    const now = Date.now();
    for (const [id, option] of this.starsTopupOptions) if (option.expiresAt <= now) this.starsTopupOptions.delete(id);
    const options: Array<{ id: string; stars: string; currency: string; amount: string; extended: boolean }> = [];
    for (const option of response) {
      if (!(option instanceof Api.StarsTopupOption)) continue;
      const stars = String(option.stars ?? '');
      const currency = String(option.currency || '');
      const amount = String(option.amount ?? '');
      const storeProduct = option.storeProduct == null ? undefined : String(option.storeProduct);
      if (!/^\d{1,20}$/.test(stars) || /^0+$/.test(stars) || !/^[A-Z]{3}$/.test(currency) ||
          !/^\d{1,20}$/.test(amount) || /^0+$/.test(amount) || (storeProduct != null && storeProduct.length > 256)) continue;
      const id = randomBytes(24).toString('base64url');
      const entry = { stars, currency, amount, ...(storeProduct ? { storeProduct } : {}), extended: Boolean(option.extended), expiresAt: now + 300_000 };
      this.starsTopupOptions.set(id, entry);
      options.push({ id, stars, currency, amount, extended: entry.extended });
    }
    while (this.starsTopupOptions.size > 100) this.starsTopupOptions.delete(this.starsTopupOptions.keys().next().value!);
    return options;
  }

  async prepareAccountStarsTopup(optionId: string): Promise<{
    token: string; stars: string; currency: string; amount: string; title: string; description: string;
  }> {
    if (typeof optionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(optionId)) throw new Error('Invalid Telegram Stars top-up option');
    const selected = this.starsTopupOptions.get(optionId);
    this.starsTopupOptions.delete(optionId);
    if (!selected || selected.expiresAt <= Date.now()) throw new Error('Telegram Stars top-up option expired; refresh the list');
    const response = await this.client.invoke(new Api.payments.GetStarsTopupOptions()) as any;
    if (!Array.isArray(response)) throw new Error('Telegram returned invalid Stars top-up options');
    const current = response.find((option: any) => option instanceof Api.StarsTopupOption &&
      String(option.stars) === selected.stars && String(option.currency) === selected.currency && String(option.amount) === selected.amount &&
      String(option.storeProduct || '') === String(selected.storeProduct || '') && Boolean(option.extended) === selected.extended);
    if (!current) throw new Error('Telegram Stars top-up price changed; refresh the list');
    const purpose = new Api.InputStorePaymentStarsTopup({
      stars: bigInt(selected.stars), currency: selected.currency, amount: bigInt(selected.amount),
    });
    const invoice = new Api.InputInvoiceStars({ purpose });
    const form = await this.client.invoke(new Api.payments.GetPaymentForm({ invoice })) as any;
    if (!(form instanceof Api.payments.PaymentFormStars) || form.formId == null || !(form.invoice instanceof Api.Invoice)) {
      throw new Error('Telegram did not return a valid Stars top-up payment form');
    }
    if (form.invoice.currency !== 'XTR' || !Array.isArray(form.invoice.prices) || !form.invoice.prices.length) {
      throw new Error('Telegram returned an invalid Stars top-up invoice');
    }
    const invoiceStars = form.invoice.prices.reduce((sum: bigint, price: any) => sum + BigInt(String(price.amount)), 0n);
    if (invoiceStars !== BigInt(selected.stars)) throw new Error('Telegram Stars top-up amount changed; refresh the list');
    const now = Date.now();
    for (const [token, pending] of this.pendingStarsTopups) if (pending.expiresAt <= now) this.pendingStarsTopups.delete(token);
    while (this.pendingStarsTopups.size >= 20) this.pendingStarsTopups.delete(this.pendingStarsTopups.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    this.pendingStarsTopups.set(token, {
      stars: selected.stars, currency: selected.currency, amount: selected.amount,
      formId: form.formId, invoice, expiresAt: now + 120_000,
    });
    return { token, stars: selected.stars, currency: selected.currency, amount: selected.amount,
      title: String(form.title || 'Telegram Stars').slice(0, 256), description: String(form.description || '').slice(0, 1024) };
  }

  async confirmAccountStarsTopup(token: string): Promise<{ stars: string; verificationUrl?: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Invalid Telegram Stars top-up confirmation');
    const pending = this.pendingStarsTopups.get(token);
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('Telegram Stars top-up confirmation expired');
    this.pendingStarsTopups.delete(token);
    const result = await this.client.invoke(new Api.payments.SendStarsForm({ formId: pending.formId, invoice: pending.invoice })) as any;
    if (result instanceof Api.payments.PaymentVerificationNeeded) {
      let verificationUrl: URL;
      try { verificationUrl = new URL(String(result.url || '')); }
      catch { throw new Error('Telegram returned an invalid payment verification URL'); }
      if (verificationUrl.protocol !== 'https:' || verificationUrl.username || verificationUrl.password) {
        throw new Error('Telegram returned an unsafe payment verification URL');
      }
      return { stars: pending.stars, verificationUrl: verificationUrl.href };
    }
    if (!(result instanceof Api.payments.PaymentResult)) throw new Error('Telegram did not confirm the Stars top-up');
    return { stars: pending.stars };
  }

  async checkAccountGiftCode(slug: string): Promise<{
    slug: string; months: number; date: number; usedDate?: number; viaGiveaway: boolean; recipientMatches: boolean;
  }> {
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(slug)) throw new Error('Invalid Telegram gift code');
    const response = await this.client.invoke(new Api.payments.CheckGiftCode({ slug })) as any;
    if (!(response instanceof Api.payments.CheckedGiftCode)) throw new Error('Telegram returned an invalid gift code');
    const recipientId = response.toId == null ? undefined : String(response.toId);
    const recipientMatches = recipientId == null || (this.selfId != null && recipientId === String(this.selfId));
    return {
      slug, months: Number(response.months) || 0, date: Number(response.date) || 0,
      ...(response.usedDate != null ? { usedDate: Number(response.usedDate) || 0 } : {}),
      viaGiveaway: Boolean(response.viaGiveaway), recipientMatches,
    };
  }

  async applyAccountGiftCode(slug: string): Promise<{ applied: true; months: number }> {
    const checked = await this.checkAccountGiftCode(slug);
    if (checked.usedDate) throw new Error('此 Telegram 礼物链接已被使用');
    if (!checked.recipientMatches) throw new Error('此 Telegram 礼物链接属于其他账号');
    await this.client.invoke(new Api.payments.ApplyGiftCode({ slug }));
    return { applied: true, months: checked.months };
  }

  async getAccountStarGifts(): Promise<Array<{
    id: string; sticker: { id: string; accessHash: string; fileReference: string; emoji: string };
    stars: string; convertStars: string; upgradeStars?: string; limited: boolean; soldOut: boolean;
    availabilityRemains?: number; availabilityTotal?: number;
  }>> {
    const response = await this.client.invoke(new Api.payments.GetStarGifts({ hash: 0 })) as any;
    if (!(response instanceof Api.payments.StarGifts)) throw new Error('Telegram returned invalid Star Gifts catalog');
    return (response.gifts || []).filter((gift: any) => gift instanceof Api.StarGift && gift.sticker?.id != null)
      .map((gift: any) => {
        const emoji = (gift.sticker.attributes || []).find((attribute: any) => attribute?.className === 'DocumentAttributeSticker')?.alt;
        return {
          id: String(gift.id),
          sticker: { id: String(gift.sticker.id), accessHash: String(gift.sticker.accessHash),
            fileReference: Buffer.from(gift.sticker.fileReference || []).toString('base64'), emoji: String(emoji || '🎁') },
          stars: String(gift.stars), convertStars: String(gift.convertStars),
          upgradeStars: gift.upgradeStars != null ? String(gift.upgradeStars) : undefined,
          limited: Boolean(gift.limited), soldOut: Boolean(gift.soldOut),
          availabilityRemains: gift.availabilityRemains != null ? Number(gift.availabilityRemains) : undefined,
          availabilityTotal: gift.availabilityTotal != null ? Number(gift.availabilityTotal) : undefined,
        };
      });
  }

  async getAccountSavedStarGifts(offset = '', limit = 20): Promise<{
    count: number; gifts: Array<{ id: string; title: string; emoji: string; date: number; saved: boolean; unique: boolean;
      refunded: boolean; convertStars: string; upgradeStars?: string; canUpgrade: boolean; transferStars?: string;
      canTransfer: boolean; canExportAt?: number; message: string }>;
    nextOffset: string; chatNotificationsEnabled: boolean;
  }> {
    if (typeof offset !== 'string' || offset.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid saved Telegram Star Gifts pagination');
    }
    const response = await this.client.invoke(new Api.payments.GetSavedStarGifts({
      peer: new Api.InputPeerSelf(), offset, limit,
    })) as any;
    if (!(response instanceof Api.payments.SavedStarGifts)) throw new Error('Telegram returned invalid saved Star Gifts');
    const now = Date.now();
    for (const [id, gift] of this.savedStarGiftItems) if (gift.expiresAt <= now) this.savedStarGiftItems.delete(id);
    const gifts = (response.gifts || []).filter((gift: any) => gift instanceof Api.SavedStarGift &&
      Number.isSafeInteger(Number(gift.msgId)) && Number(gift.msgId) > 0 &&
      (gift.gift instanceof Api.StarGift || gift.gift instanceof Api.StarGiftUnique)).map((gift: any) => {
      const unique = gift.gift instanceof Api.StarGiftUnique;
      const basicGift = unique ? undefined : gift.gift as Api.StarGift;
      const sticker = basicGift?.sticker as any;
      const stickerEmoji = sticker?.attributes?.find((attribute: any) => attribute?.className === 'DocumentAttributeSticker')?.alt;
      const id = randomBytes(24).toString('base64url');
      const convertStars = String(gift.convertStars ?? basicGift?.convertStars ?? 0);
      const upgradeStars = String(gift.upgradeStars ?? '0');
      const canUpgrade = Boolean(gift.canUpgrade) && !unique;
      const transferStars = gift.transferStars == null ? undefined : String(gift.transferStars);
      const canExportAt = gift.canExportAt != null && Number.isSafeInteger(Number(gift.canExportAt)) ? Number(gift.canExportAt) : undefined;
      const canTransfer = typeof transferStars === 'string' && /^\d{1,20}$/.test(transferStars) &&
        (canExportAt == null || canExportAt <= Math.floor(now / 1000));
      this.savedStarGiftItems.set(id, {
        msgId: Number(gift.msgId), unsaved: Boolean(gift.unsaved), unique, refunded: Boolean(gift.refunded),
        convertStars: /^\d{1,20}$/.test(convertStars) ? convertStars : '0',
        upgradeStars: /^\d{1,20}$/.test(upgradeStars) ? upgradeStars : '0', canUpgrade,
        ...(typeof transferStars === 'string' && /^\d{1,20}$/.test(transferStars) ? { transferStars } : {}),
        ...(canExportAt != null ? { canExportAt } : {}), expiresAt: now + 300_000,
      });
      return {
        id, title: unique ? String(gift.gift.title || '独特礼物') : String(stickerEmoji || '礼物'),
        emoji: unique ? '💎' : String(stickerEmoji || '🎁'), date: Number(gift.date) || 0,
        saved: !gift.unsaved, unique, refunded: Boolean(gift.refunded),
        convertStars: /^\d{1,20}$/.test(convertStars) ? convertStars : '0',
        ...(gift.upgradeStars != null ? { upgradeStars } : {}),
        canUpgrade, canTransfer, ...(canTransfer ? { transferStars } : {}), ...(canExportAt != null ? { canExportAt } : {}),
        message: String(gift.message?.text || '').slice(0, 1024),
      };
    });
    while (this.savedStarGiftItems.size > 200) this.savedStarGiftItems.delete(this.savedStarGiftItems.keys().next().value!);
    return { count: Number(response.count) || gifts.length, gifts,
      nextOffset: typeof response.nextOffset === 'string' ? response.nextOffset : '',
      chatNotificationsEnabled: Boolean(response.chatNotificationsEnabled) };
  }

  private async readSavedStarGiftForAction(id: string): Promise<{
    input: Api.TypeInputSavedStarGift; gift: Api.SavedStarGift; unique: boolean;
    cached: { msgId: number; unsaved: boolean; unique: boolean; refunded: boolean; convertStars: string;
      upgradeStars: string; canUpgrade: boolean; transferStars?: string; canExportAt?: number; expiresAt: number };
  }> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('Invalid saved Telegram Star Gift');
    const cached = this.savedStarGiftItems.get(id);
    this.savedStarGiftItems.delete(id);
    if (!cached || cached.expiresAt <= Date.now()) throw new Error('Saved Telegram Star Gift entry expired; refresh the list');
    const input = new Api.InputSavedStarGiftUser({ msgId: cached.msgId });
    const response = await this.client.invoke(new Api.payments.GetSavedStarGift({ stargift: [input] })) as any;
    if (!(response instanceof Api.payments.SavedStarGifts)) throw new Error('Telegram returned invalid saved Star Gift details');
    const gift = (response.gifts || []).find((item: any) => item instanceof Api.SavedStarGift && Number(item.msgId) === cached.msgId);
    if (!gift || Boolean(gift.unsaved) !== cached.unsaved || Boolean(gift.refunded) !== cached.refunded) {
      throw new Error('Saved Telegram Star Gift changed; refresh the list');
    }
    const unique = gift.gift instanceof Api.StarGiftUnique;
    if (unique !== cached.unique || (!unique && !(gift.gift instanceof Api.StarGift))) throw new Error('Saved Telegram Star Gift type changed');
    return { input, gift, unique, cached };
  }

  async setAccountStarGiftSaved(id: string, saved: boolean): Promise<{ saved: boolean }> {
    if (typeof saved !== 'boolean') throw new Error('Invalid saved Telegram Star Gift state');
    const current = await this.readSavedStarGiftForAction(id);
    if (current.gift.refunded) throw new Error('Refunded Telegram gifts cannot be changed');
    if (Boolean(current.gift.unsaved) === !saved) return { saved };
    const result = await this.client.invoke(new Api.payments.SaveStarGift({ stargift: current.input, unsave: !saved })) as any;
    if (result !== true) throw new Error('Telegram did not confirm the Star Gift profile change');
    return { saved };
  }

  async convertAccountStarGift(id: string): Promise<{ converted: true; stars: string }> {
    const current = await this.readSavedStarGiftForAction(id);
    if (current.unique || !(current.gift.gift instanceof Api.StarGift)) throw new Error('Unique Telegram gifts cannot be converted');
    if (current.gift.refunded) throw new Error('Refunded Telegram gifts cannot be converted');
    const stars = String(current.gift.convertStars ?? current.gift.gift.convertStars ?? '0');
    if (!/^\d{1,20}$/.test(stars) || /^0+$/.test(stars)) throw new Error('This Telegram Star Gift cannot be converted');
    const result = await this.client.invoke(new Api.payments.ConvertStarGift({ stargift: current.input })) as any;
    if (result !== true) throw new Error('Telegram did not confirm Star Gift conversion');
    return { converted: true, stars };
  }

  async prepareAccountStarGiftUpgrade(id: string): Promise<{ token: string; stars: string }> {
    const cached = this.savedStarGiftItems.get(id);
    const current = await this.readSavedStarGiftForAction(id);
    if (current.unique || !(current.gift.gift instanceof Api.StarGift)) throw new Error('Unique Telegram gifts cannot be upgraded here');
    if (current.gift.refunded || !current.gift.canUpgrade) throw new Error('This Telegram Star Gift cannot be upgraded');
    const stars = String(current.gift.upgradeStars ?? '0');
    if (!/^\d{1,20}$/.test(stars) || /^0+$/.test(stars)) throw new Error('Telegram did not provide a valid Star Gift upgrade price');
    const now = Date.now();
    for (const [token, pending] of this.pendingStarGiftUpgrades) if (pending.expiresAt <= now) this.pendingStarGiftUpgrades.delete(token);
    while (this.pendingStarGiftUpgrades.size >= 20) this.pendingStarGiftUpgrades.delete(this.pendingStarGiftUpgrades.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    if (!cached) throw new Error('Saved Telegram Star Gift entry expired; refresh the list');
    this.pendingStarGiftUpgrades.set(token, { msgId: cached.msgId, unsaved: cached.unsaved, stars, expiresAt: now + 120_000 });
    return { token, stars };
  }

  async confirmAccountStarGiftUpgrade(token: string, keepOriginalDetails: boolean): Promise<{ upgraded: true; stars: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || typeof keepOriginalDetails !== 'boolean') {
      throw new Error('Invalid Telegram Star Gift upgrade confirmation');
    }
    const pending = this.pendingStarGiftUpgrades.get(token);
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('Telegram Star Gift upgrade confirmation expired');
    this.pendingStarGiftUpgrades.delete(token);
    const input = new Api.InputSavedStarGiftUser({ msgId: pending.msgId });
    const response = await this.client.invoke(new Api.payments.GetSavedStarGift({ stargift: [input] })) as any;
    if (!(response instanceof Api.payments.SavedStarGifts)) throw new Error('Telegram returned invalid saved Star Gift details');
    const gift = (response.gifts || []).find((item: any) => item instanceof Api.SavedStarGift && Number(item.msgId) === pending.msgId);
    if (!gift || Boolean(gift.unsaved) !== pending.unsaved || gift.refunded || !gift.canUpgrade ||
        !(gift.gift instanceof Api.StarGift) || String(gift.upgradeStars ?? '0') !== pending.stars) {
      throw new Error('Telegram Star Gift upgrade price or eligibility changed; refresh the list');
    }
    const result = await this.client.invoke(new Api.payments.UpgradeStarGift({ stargift: input, keepOriginalDetails })) as any;
    if (!result) throw new Error('Telegram did not confirm Star Gift upgrade');
    return { upgraded: true, stars: pending.stars };
  }

  async prepareAccountStarGiftTransfer(id: string, chatId: number): Promise<{ token: string; stars: string }> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || (this.selfId != null && chatId === this.selfId)) {
      throw new Error('Choose another Telegram user as the gift recipient');
    }
    const cached = this.savedStarGiftItems.get(id);
    const current = await this.readSavedStarGiftForAction(id);
    if (!cached || current.gift.refunded) throw new Error('This Telegram Star Gift cannot be transferred');
    const stars = String(current.gift.transferStars ?? '');
    if (!/^\d{1,20}$/.test(stars)) throw new Error('Telegram does not allow transferring this Star Gift');
    const canExportAt = Number(current.gift.canExportAt) || 0;
    if (canExportAt > Math.floor(Date.now() / 1000)) throw new Error('Telegram does not allow transferring this gift yet');
    const target = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (!(target instanceof Api.InputPeerUser) || String(target.userId) !== String(chatId) || String(target.userId) === String(this.selfId ?? '')) {
      throw new Error('Star Gifts can only be transferred to another Telegram user');
    }
    const now = Date.now();
    for (const [token, pending] of this.pendingStarGiftTransfers) if (pending.expiresAt <= now) this.pendingStarGiftTransfers.delete(token);
    while (this.pendingStarGiftTransfers.size >= 20) this.pendingStarGiftTransfers.delete(this.pendingStarGiftTransfers.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    this.pendingStarGiftTransfers.set(token, { msgId: cached.msgId, unsaved: cached.unsaved, chatId, target,
      stars, expiresAt: now + 120_000 });
    return { token, stars };
  }

  async confirmAccountStarGiftTransfer(token: string, chatId: number): Promise<{ transferred: true; stars: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || !Number.isSafeInteger(chatId) || chatId <= 0) {
      throw new Error('Invalid Telegram Star Gift transfer confirmation');
    }
    const pending = this.pendingStarGiftTransfers.get(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.chatId !== chatId) {
      throw new Error('Telegram Star Gift transfer confirmation expired or does not match');
    }
    this.pendingStarGiftTransfers.delete(token);
    const input = new Api.InputSavedStarGiftUser({ msgId: pending.msgId });
    const response = await this.client.invoke(new Api.payments.GetSavedStarGift({ stargift: [input] })) as any;
    if (!(response instanceof Api.payments.SavedStarGifts)) throw new Error('Telegram returned invalid saved Star Gift details');
    const gift = (response.gifts || []).find((item: any) => item instanceof Api.SavedStarGift && Number(item.msgId) === pending.msgId);
    const stars = gift?.transferStars == null ? '' : String(gift.transferStars);
    const canExportAt = Number(gift?.canExportAt) || 0;
    if (!gift || Boolean(gift.unsaved) !== pending.unsaved || gift.refunded || !/^\d{1,20}$/.test(stars) ||
        stars !== pending.stars || canExportAt > Math.floor(Date.now() / 1000)) {
      throw new Error('Telegram Star Gift transfer price or eligibility changed; refresh the list');
    }
    const result = await this.client.invoke(new Api.payments.TransferStarGift({ stargift: input, toId: pending.target })) as any;
    if (!result) throw new Error('Telegram did not confirm Star Gift transfer');
    return { transferred: true, stars: pending.stars };
  }

  async prepareAccountStarGiftPayment(chatId: number, giftId: string,
    options: { hideName?: boolean; includeUpgrade?: boolean } = {}): Promise<{ token: string; stars: string }> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !/^\d{1,20}$/.test(giftId) || /^0+$/.test(giftId) ||
        (options.hideName != null && typeof options.hideName !== 'boolean') ||
        (options.includeUpgrade != null && typeof options.includeUpgrade !== 'boolean')) {
      throw new Error('Invalid Star Gift request');
    }
    const gifts = await this.getAccountStarGifts();
    const gift = gifts.find(item => item.id === giftId);
    if (!gift || gift.soldOut || (gift.limited && gift.availabilityRemains != null && gift.availabilityRemains <= 0)) {
      throw new Error('Telegram 礼物已售罄或不可用');
    }
    const includeUpgrade = Boolean(options.includeUpgrade);
    if (includeUpgrade && !gift.upgradeStars) throw new Error('此礼物不支持升级');
    const invoice = new Api.InputInvoiceStarGift({
      peer: this.resolvePeer(chatId), giftId: BigInt(giftId) as any,
      hideName: Boolean(options.hideName), includeUpgrade,
    });
    const form = await this.client.invoke(new Api.payments.GetPaymentForm({ invoice })) as any;
    if (!(form instanceof Api.payments.PaymentFormStarGift) || form.formId == null || !form.invoice) {
      throw new Error('Telegram 未返回有效的 Stars 礼物付款表单');
    }
    const paymentInvoice = form.invoice as Api.Invoice;
    if (paymentInvoice.currency !== 'XTR' || !Array.isArray(paymentInvoice.prices)) throw new Error('Telegram 返回了无效的 Stars 礼物金额');
    const amount = paymentInvoice.prices.reduce((sum: bigint, price: any) => sum + BigInt(String(price.amount)), 0n);
    if (amount <= 0n) throw new Error('Telegram 返回了无效的 Stars 礼物金额');
    const now = Date.now();
    for (const [token, pending] of this.pendingStarGiftPayments) if (pending.expiresAt <= now) this.pendingStarGiftPayments.delete(token);
    while (this.pendingStarGiftPayments.size >= 20) this.pendingStarGiftPayments.delete(this.pendingStarGiftPayments.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    this.pendingStarGiftPayments.set(token, { chatId, giftId, stars: amount.toString(), formId: form.formId, invoice, expiresAt: now + 120_000 });
    return { token, stars: amount.toString() };
  }

  async confirmAccountStarGiftPayment(token: string, chatId: number, giftId: string): Promise<{ stars: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || !Number.isSafeInteger(chatId) || chatId <= 0 ||
        typeof giftId !== 'string' || !/^\d{1,20}$/.test(giftId)) throw new Error('Invalid Star Gift payment confirmation');
    const pending = this.pendingStarGiftPayments.get(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.chatId !== chatId || pending.giftId !== giftId) {
      throw new Error('Star Gift confirmation expired or does not match');
    }
    this.pendingStarGiftPayments.delete(token);
    const result = await this.client.invoke(new Api.payments.SendStarsForm({ formId: pending.formId, invoice: pending.invoice })) as any;
    if (result instanceof Api.payments.PaymentVerificationNeeded) {
      throw new Error('Telegram 要求在其他设备完成付款验证；礼物状态尚未确认');
    }
    if (!(result instanceof Api.payments.PaymentResult)) throw new Error('Telegram 未确认 Stars 礼物已发送');
    return { stars: pending.stars };
  }

  async getAccountStarsSubscriptions(offset = ''): Promise<{
    subscriptions: Array<{ id: string; title: string; canceled: boolean; canRefulfill: boolean; missingBalance: boolean; untilDate: number; amount: string; period: number }>;
    nextOffset: string;
  }> {
    if (typeof offset !== 'string' || offset.length > 512) throw new Error('Invalid Telegram Stars subscription cursor');
    const response = await this.client.invoke(new Api.payments.GetStarsSubscriptions({ peer: new Api.InputPeerSelf(), offset })) as any;
    if (!(response instanceof Api.payments.StarsStatus)) throw new Error('Telegram returned invalid Stars subscriptions');
    return {
      subscriptions: (response.subscriptions || []).map((subscription: any) => ({
        id: String(subscription.id), title: String(subscription.title || 'Telegram 订阅'),
        canceled: Boolean(subscription.canceled), canRefulfill: Boolean(subscription.canRefulfill),
        missingBalance: Boolean(subscription.missingBalance), untilDate: Number(subscription.untilDate) || 0,
        amount: String(subscription.pricing?.amount ?? 0), period: Number(subscription.pricing?.period) || 0,
      })),
      nextOffset: typeof response.subscriptionsNextOffset === 'string' ? response.subscriptionsNextOffset : '',
    };
  }

  async setAccountStarsSubscriptionCanceled(subscriptionId: string, canceled: boolean): Promise<void> {
    if (typeof subscriptionId !== 'string' || !subscriptionId || subscriptionId.length > 512 || typeof canceled !== 'boolean') {
      throw new Error('Invalid Telegram Stars subscription');
    }
    const accepted = await this.client.invoke(new Api.payments.ChangeStarsSubscription({
      peer: new Api.InputPeerSelf(), subscriptionId, canceled,
    }));
    if (!accepted) throw new Error('Telegram 未确认订阅设置已保存');
  }

  async getAccountNotificationSettings(): Promise<Array<{ key: string; title: string; muted: boolean; muteUntil: number; showPreviews: boolean; silent: boolean; soundId: string; soundTitle: string; storiesMuted: boolean; storiesHideSender: boolean; storiesSoundId: string; storiesSoundTitle: string }>> {
    const categories = [['private', '私聊'], ['groups', '群组'], ['channels', '频道']];
    const now = Math.floor(Date.now() / 1000);
    const result: Array<{ key: string; title: string; muted: boolean; muteUntil: number; showPreviews: boolean; silent: boolean; soundId: string; soundTitle: string; storiesMuted: boolean; storiesHideSender: boolean; storiesSoundId: string; storiesSoundTitle: string }> = [];
    for (const [key, title] of categories) {
      const settings = await this.client.invoke(new Api.account.GetNotifySettings({ peer: this.accountNotifyPeer(key) })) as any;
      const muteUntil = Number(settings?.muteUntil) || 0;
      const storySound = this.notificationSoundSummary({
        otherSound: settings?.storiesOtherSound, iosSound: settings?.storiesIosSound, androidSound: settings?.storiesAndroidSound,
      });
      result.push({ key, title, muted: muteUntil > now, muteUntil,
        showPreviews: settings?.showPreviews !== false, silent: Boolean(settings?.silent), ...this.notificationSoundSummary(settings),
        storiesMuted: Boolean(settings?.storiesMuted), storiesHideSender: Boolean(settings?.storiesHideSender),
        storiesSoundId: storySound.soundId, storiesSoundTitle: storySound.soundTitle });
    }
    return result;
  }

  async getAccountNotificationExceptions(key: string): Promise<Array<{ chatId: number; title: string; type: ChatType; muted: boolean; muteUntil: number; showPreviews: boolean; silent: boolean; soundId: string; soundTitle: string; storiesMuted: boolean; storiesHideSender: boolean; storiesSoundId: string; storiesSoundTitle: string }>> {
    const result = await this.client.invoke(new Api.account.GetNotifyExceptions({
      peer: this.accountNotifyPeer(key), compareSound: true, compareStories: true,
    })) as any;
    const users = new Map<string, any>();
    for (const user of result?.users || []) if (user?.id != null) users.set(String(user.id), user);
    const chats = new Map<string, any>();
    for (const chat of result?.chats || []) {
      try { chats.set(String(getPeerId(chat)), chat); } catch {}
    }
    const now = Math.floor(Date.now() / 1000);
    const exceptions: Array<{ chatId: number; title: string; type: ChatType; muted: boolean; muteUntil: number; showPreviews: boolean; silent: boolean; soundId: string; soundTitle: string; storiesMuted: boolean; storiesHideSender: boolean; storiesSoundId: string; storiesSoundTitle: string }> = [];
    for (const update of result?.updates || []) {
      if (update?.className !== 'UpdateNotifySettings' || update.peer?.className !== 'NotifyPeer') continue;
      const peer = update.peer.peer;
      let entity: any;
      let ref: ChatRef | undefined;
      if (peer instanceof Api.PeerUser) {
        entity = users.get(String(peer.userId));
        const user = userFromEntity(entity);
        if (user) ref = { id: user.id, type: 'private', title: [user.firstName, user.lastName].filter(Boolean).join(' '), username: user.username };
      } else {
        try { entity = chats.get(String(getPeerId(peer))); } catch {}
        if (entity) ref = chatFromEntity(entity);
      }
      let chatId: number;
      try { chatId = Number(getPeerId(peer)); } catch { continue; }
      if (!Number.isSafeInteger(chatId) || !chatId) continue;
      const settings = update.notifySettings || {};
      const muteUntil = Number(settings.muteUntil) || 0;
      const storySound = this.notificationSoundSummary({
        otherSound: settings.storiesOtherSound, iosSound: settings.storiesIosSound, androidSound: settings.storiesAndroidSound,
      });
      exceptions.push({ chatId, title: ref?.title || ref?.username || `Peer ${chatId}`, type: ref?.type || 'unknown',
        muted: muteUntil > now, muteUntil, showPreviews: settings.showPreviews !== false, silent: Boolean(settings.silent),
        ...this.notificationSoundSummary(settings), storiesMuted: Boolean(settings.storiesMuted),
        storiesHideSender: Boolean(settings.storiesHideSender), storiesSoundId: storySound.soundId, storiesSoundTitle: storySound.soundTitle });
    }
    return exceptions.sort((a, b) => a.title.localeCompare(b.title));
  }

  async setAccountNotificationException(chatId: number, changes: { muted?: boolean; muteUntil?: number; showPreviews?: boolean; silent?: boolean; soundId?: string; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSoundId?: string }): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || (this.selfId && chatId === this.selfId) || !changes ||
        (changes.muted === undefined && changes.muteUntil === undefined && changes.showPreviews === undefined && changes.silent === undefined && changes.soundId === undefined &&
          changes.storiesMuted === undefined && changes.storiesHideSender === undefined && changes.storiesSoundId === undefined) ||
        (changes.muted !== undefined && typeof changes.muted !== 'boolean') ||
        (changes.muted !== undefined && changes.muteUntil !== undefined) ||
        (changes.muteUntil !== undefined && (!Number.isSafeInteger(changes.muteUntil) || changes.muteUntil < 0 || changes.muteUntil > 2147483647)) ||
        (changes.showPreviews !== undefined && typeof changes.showPreviews !== 'boolean') ||
        (changes.silent !== undefined && typeof changes.silent !== 'boolean') ||
        (changes.soundId !== undefined && typeof changes.soundId !== 'string') ||
        (changes.storiesMuted !== undefined && typeof changes.storiesMuted !== 'boolean') ||
        (changes.storiesHideSender !== undefined && typeof changes.storiesHideSender !== 'boolean') ||
        (changes.storiesSoundId !== undefined && typeof changes.storiesSoundId !== 'string')) {
      throw new Error('Invalid Telegram notification exception');
    }
    const inputPeer = await this.client.getInputEntity(this.resolvePeer(chatId));
    const peer = new Api.InputNotifyPeer({ peer: inputPeer });
    const input: { muteUntil?: number; showPreviews?: boolean; silent?: boolean; sound?: Api.TypeNotificationSound; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSound?: Api.TypeNotificationSound } = {};
    if (changes.muted !== undefined) {
      const current = await this.client.invoke(new Api.account.GetNotifySettings({ peer })) as any;
      const muteUntil = Number(current?.muteUntil) || 0;
      input.muteUntil = changes.muted
        ? muteUntil > Math.floor(Date.now() / 1000) ? muteUntil : 2147483647
        : 0;
    }
    if (changes.muteUntil !== undefined) input.muteUntil = changes.muteUntil;
    if (changes.showPreviews !== undefined) input.showPreviews = changes.showPreviews;
    if (changes.silent !== undefined) input.silent = changes.silent;
    if (changes.soundId !== undefined) input.sound = this.notificationSoundInput(changes.soundId);
    if (changes.storiesMuted !== undefined) input.storiesMuted = changes.storiesMuted;
    if (changes.storiesHideSender !== undefined) input.storiesHideSender = changes.storiesHideSender;
    if (changes.storiesSoundId !== undefined) input.storiesSound = this.notificationSoundInput(changes.storiesSoundId);
    const accepted = await this.client.invoke(new Api.account.UpdateNotifySettings({
      peer, settings: new Api.InputPeerNotifySettings(input),
    }));
    if (accepted === false) throw new Error('Telegram 未确认保存此会话的通知例外');
  }

  async setAccountNotificationSettings(key: string, changes: { muted?: boolean; muteUntil?: number; showPreviews?: boolean; silent?: boolean; soundId?: string; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSoundId?: string }): Promise<void> {
    const peer = this.accountNotifyPeer(key);
    if (!changes || (changes.muted === undefined && changes.muteUntil === undefined && changes.showPreviews === undefined && changes.silent === undefined && changes.soundId === undefined &&
        changes.storiesMuted === undefined && changes.storiesHideSender === undefined && changes.storiesSoundId === undefined) ||
        (changes.muted !== undefined && typeof changes.muted !== 'boolean') ||
        (changes.muted !== undefined && changes.muteUntil !== undefined) ||
        (changes.muteUntil !== undefined && (!Number.isSafeInteger(changes.muteUntil) || changes.muteUntil < 0 || changes.muteUntil > 2147483647)) ||
        (changes.showPreviews !== undefined && typeof changes.showPreviews !== 'boolean') ||
        (changes.silent !== undefined && typeof changes.silent !== 'boolean') ||
        (changes.soundId !== undefined && typeof changes.soundId !== 'string') ||
        (changes.storiesMuted !== undefined && typeof changes.storiesMuted !== 'boolean') ||
        (changes.storiesHideSender !== undefined && typeof changes.storiesHideSender !== 'boolean') ||
        (changes.storiesSoundId !== undefined && typeof changes.storiesSoundId !== 'string')) {
      throw new Error('Invalid Telegram notification settings');
    }
    const input: { muteUntil?: number; showPreviews?: boolean; silent?: boolean; sound?: Api.TypeNotificationSound; storiesMuted?: boolean; storiesHideSender?: boolean; storiesSound?: Api.TypeNotificationSound } = {};
    if (changes.muted !== undefined) {
      const current = await this.client.invoke(new Api.account.GetNotifySettings({ peer })) as any;
      const currentMuteUntil = Number(current?.muteUntil) || 0;
      input.muteUntil = changes.muted
        ? currentMuteUntil > Math.floor(Date.now() / 1000) ? currentMuteUntil : 2147483647
        : 0;
    }
    if (changes.muteUntil !== undefined) input.muteUntil = changes.muteUntil;
    if (changes.showPreviews !== undefined) input.showPreviews = changes.showPreviews;
    if (changes.silent !== undefined) input.silent = changes.silent;
    if (changes.soundId !== undefined) input.sound = this.notificationSoundInput(changes.soundId);
    if (changes.storiesMuted !== undefined) input.storiesMuted = changes.storiesMuted;
    if (changes.storiesHideSender !== undefined) input.storiesHideSender = changes.storiesHideSender;
    if (changes.storiesSoundId !== undefined) input.storiesSound = this.notificationSoundInput(changes.storiesSoundId);
    const accepted = await this.client.invoke(new Api.account.UpdateNotifySettings({
      peer, settings: new Api.InputPeerNotifySettings(input),
    }));
    if (accepted === false) throw new Error('Telegram 未确认保存通知设置');
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

  async pressBotCallback(chatId: number, messageId: number, row: number, column: number): Promise<{ message?: string; alert?: boolean; url?: string }> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('无效的消息');
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0];
    if (!message || message.id !== messageId) throw new Error('消息不存在或不可访问');
    const data = getBotCallbackData(message.replyMarkup, row, column);
    const answer = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId: messageId, data }));
    return { message: answer.message, alert: answer.alert, url: answer.url };
  }

  async launchBotGame(chatId: number, messageId: number, row: number, column: number): Promise<{ message?: string; alert?: boolean; url?: string }> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
        !Number.isInteger(column) || column < 0 || column >= 16) throw new Error('无效的游戏按钮');
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0];
    if (!message || message.id !== messageId || !(message.replyMarkup instanceof Api.ReplyInlineMarkup)) throw new Error('机器人消息不可用');
    if (!(message.replyMarkup.rows[row]?.buttons[column] instanceof Api.KeyboardButtonGame)) throw new Error('该游戏按钮不可用');
    const sender = message.viaBotId ? await this.client.getEntity(message.viaBotId) : await message.getSender();
    if (!(sender instanceof Api.User) || !sender.bot) throw new Error('无法确认游戏机器人身份');
    const answer = await this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId: messageId, game: true }));
    return { message: answer.message, alert: answer.alert, url: answer.url };
  }

  private async getBotUrlAuthButton(chatId: number, messageId: number, row: number, column: number): Promise<{ peer: any; button: Api.KeyboardButtonUrlAuth }> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
        !Number.isInteger(column) || column < 0 || column >= 16) throw new Error('无效的机器人按钮');
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0];
    if (!message || message.id !== messageId || !(message.replyMarkup instanceof Api.ReplyInlineMarkup)) throw new Error('机器人消息不可用');
    const button = message.replyMarkup.rows[row]?.buttons[column];
    if (!(button instanceof Api.KeyboardButtonUrlAuth)) throw new Error('该登录授权按钮不可用');
    const sender = message.viaBotId ? await this.client.getEntity(message.viaBotId) : await message.getSender();
    if (!(sender instanceof Api.User) || !sender.bot) throw new Error('无法确认机器人身份');
    return { peer, button };
  }

  async requestBotUrlAuth(chatId: number, messageId: number, row: number, column: number): Promise<{ type: 'request' | 'accepted' | 'default'; domain?: string; requestWriteAccess?: boolean; url?: string }> {
    const { peer, button } = await this.getBotUrlAuthButton(chatId, messageId, row, column);
    const result = await this.client.invoke(new Api.messages.RequestUrlAuth({ peer, msgId: messageId, buttonId: button.buttonId }));
    if (result instanceof Api.UrlAuthResultRequest) return { type: 'request', domain: result.domain, requestWriteAccess: Boolean(result.requestWriteAccess) };
    if (result instanceof Api.UrlAuthResultAccepted) return { type: 'accepted', url: result.url };
    if (result instanceof Api.UrlAuthResultDefault) return { type: 'default', url: button.url };
    throw new Error('Telegram returned an invalid URL authorization result');
  }

  async acceptBotUrlAuth(chatId: number, messageId: number, row: number, column: number, writeAllowed: boolean): Promise<{ type: 'accepted' | 'default'; url?: string }> {
    const { peer, button } = await this.getBotUrlAuthButton(chatId, messageId, row, column);
    const result = await this.client.invoke(new Api.messages.AcceptUrlAuth({ peer, msgId: messageId, buttonId: button.buttonId, writeAllowed }));
    if (result instanceof Api.UrlAuthResultAccepted) return { type: 'accepted', url: result.url };
    if (result instanceof Api.UrlAuthResultDefault) return { type: 'default', url: button.url };
    throw new Error('Telegram returned an invalid URL authorization result');
  }

  private async getBotRequestPeerButton(chatId: number, messageId: number, row: number, column: number): Promise<{ peer: any; button: Api.KeyboardButtonRequestPeer }> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isInteger(row) || row < 0 || row >= 32 ||
        !Number.isInteger(column) || column < 0 || column >= 16) throw new Error('无效的机器人按钮');
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0];
    if (!message || message.id !== messageId ||
        (!(message.replyMarkup instanceof Api.ReplyInlineMarkup) && !(message.replyMarkup instanceof Api.ReplyKeyboardMarkup))) throw new Error('机器人消息不可用');
    const button = message.replyMarkup.rows[row]?.buttons[column];
    if (!(button instanceof Api.KeyboardButtonRequestPeer)) throw new Error('该会话请求按钮不可用');
    const sender = message.viaBotId ? await this.client.getEntity(message.viaBotId) : await message.getSender();
    if (!(sender instanceof Api.User) || !sender.bot) throw new Error('无法确认机器人身份');
    return { peer, button };
  }

  async sendBotRequestedPeers(chatId: number, messageId: number, row: number, column: number, peerIds: number[]): Promise<void> {
    const { peer, button } = await this.getBotRequestPeerButton(chatId, messageId, row, column);
    const maxQuantity = Math.max(1, Math.min(10, Number(button.maxQuantity) || 1));
    if (!Array.isArray(peerIds) || peerIds.length < 1 || peerIds.length > maxQuantity ||
        peerIds.some(id => !Number.isSafeInteger(id) || id === 0) || new Set(peerIds).size !== peerIds.length) {
      throw new Error('所选会话数量无效');
    }
    const requestedPeers = await Promise.all(peerIds.map(id => this.client.getInputEntity(this.resolvePeer(id))));
    await this.client.invoke(new Api.messages.SendBotRequestedPeer({
      peer, msgId: messageId, buttonId: button.buttonId, requestedPeers,
    }));
  }

  async searchBotRequestedPeers(chatId: number, messageId: number, row: number, column: number, query: string): Promise<DialogInfo[]> {
    const { button } = await this.getBotRequestPeerButton(chatId, messageId, row, column);
    const normalized = typeof query === 'string' ? query.trim().slice(0, 64) : '';
    if (normalized.length < 2) return [];
    const result = await this.client.invoke(new Api.contacts.Search({ q: normalized, limit: 50 }));
    if (!(result instanceof Api.contacts.Found)) throw new Error('Telegram returned an invalid peer search result');
    const users = new Map((result.users || []).map(user => [String(user.id), user]));
    const chats = new Map((result.chats || []).map(chat => [String(chat.id), chat]));
    const peers = [...(result.myResults || []), ...(result.results || [])];
    const seen = new Set<string>();
    const dialogs: DialogInfo[] = [];
    for (const peer of peers) {
      const markedId = Number(getPeerId(peer));
      if (!Number.isSafeInteger(markedId) || !markedId || seen.has(String(markedId))) continue;
      seen.add(String(markedId));
      if (peer instanceof Api.PeerUser) {
        const user = users.get(String(peer.userId));
        if (!(user instanceof Api.User)) continue;
        dialogs.push({ id: markedId, type: 'private', title: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username,
          username: user.username, unreadCount: 0, isBot: Boolean(user.bot), isPremium: Boolean(user.premium) });
      } else if (peer instanceof Api.PeerChat) {
        const chat = chats.get(String(peer.chatId));
        if (!(chat instanceof Api.Chat)) continue;
        dialogs.push({ id: markedId, type: 'group', title: chat.title, unreadCount: 0, isCreator: Boolean(chat.creator) });
      } else if (peer instanceof Api.PeerChannel) {
        const chat = chats.get(String(peer.channelId));
        if (!(chat instanceof Api.Channel)) continue;
        dialogs.push({ id: markedId, type: 'channel', title: chat.title, username: chat.username, unreadCount: 0,
          isCreator: Boolean(chat.creator), isBroadcast: Boolean(chat.broadcast), isForum: Boolean(chat.forum) });
      }
    }
    // Telegram rechecks all requested constraints when SendBotRequestedPeer is called.
    // Return only peer types that can be represented in this selector.
    return dialogs.filter(dialog => button.peerType instanceof Api.RequestPeerTypeUser ? dialog.type === 'private' :
      button.peerType instanceof Api.RequestPeerTypeBroadcast ? dialog.type === 'channel' && dialog.isBroadcast === true :
      button.peerType instanceof Api.RequestPeerTypeChat ? dialog.type === 'group' || (dialog.type === 'channel' && dialog.isBroadcast !== true) : false);
  }

  async openMiniApp(chatId: number, messageId: number, row: number, column: number): Promise<{ capability: string; url: string; botId: string; accountId: string; simpleWebView: boolean; buttonText: string }> {
    if (!this.miniApps) this.miniApps = new MiniAppSessions(this.client, this.selfId);
    return this.miniApps.open(chatId, messageId, row, column);
  }

  async getMiniAppBotMenuButton(chatId: number): Promise<{ available: boolean; text?: string }> {
    if (!this.miniApps) this.miniApps = new MiniAppSessions(this.client, this.selfId);
    return this.miniApps.getBotMenuButton(chatId);
  }

  async openMiniAppBotMenu(chatId: number): Promise<{ capability: string; url: string; botId: string; accountId: string; simpleWebView: false; buttonText: string }> {
    if (!this.miniApps) this.miniApps = new MiniAppSessions(this.client, this.selfId);
    return this.miniApps.openBotMenu(chatId);
  }

  async prolongMiniApp(capability: string): Promise<void> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    await this.miniApps.prolong(capability);
  }

  async invokeMiniAppCustomMethod(capability: string, method: string, paramsJson: string): Promise<string> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    return this.miniApps.invokeCustomMethod(capability, method, paramsJson);
  }

  async sendMiniAppData(capability: string, data: string): Promise<void> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    await this.miniApps.sendWebViewData(capability, data);
  }

  async canMiniAppBotSendMessages(capability: string): Promise<boolean> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    return this.miniApps.canBotSendMessages(capability);
  }

  async checkMiniAppDownload(capability: string, fileName: string, url: string): Promise<boolean> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    return this.miniApps.checkDownloadFile(capability, fileName, url);
  }

  async allowMiniAppBotSendMessages(capability: string): Promise<void> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    await this.miniApps.allowBotSendMessages(capability);
  }

  async requestMiniAppPhone(capability: string): Promise<void> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    await this.miniApps.requestPhone(capability);
  }

  async prepareMiniAppInvoice(capability: string, slug: string): Promise<{ token: string; stars: string; title: string; description: string }> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    return this.miniApps.prepareInvoice(capability, slug);
  }

  async confirmMiniAppInvoice(capability: string, token: string): Promise<{ status: 'paid' | 'failed' }> {
    if (!this.miniApps) throw new Error('Mini App 会话已结束');
    return this.miniApps.confirmInvoice(capability, token);
  }

  cancelMiniAppInvoice(capability: string, token: string): void {
    this.miniApps?.cancelInvoice(capability, token);
  }

  closeMiniApp(capability: string): void { this.miniApps?.close(capability); }

  async reactToMessage(chatId: number, messageId: number, emoji?: string): Promise<void> {
    const customEmojiId = typeof emoji === 'string' ? /^custom:([1-9]\d{0,19})$/.exec(emoji)?.[1] : undefined;
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        (emoji != null && emoji !== '' && !customEmojiId && !isSingleEmoji(emoji))) throw new Error('Invalid message reaction');
    if (customEmojiId && BigInt(customEmojiId) > (1n << 63n) - 1n) throw new Error('Invalid message reaction');
    const peer = this.resolvePeer(chatId);
    await this.client.invoke(
      new Api.messages.SendReaction({
        peer,
        msgId: messageId,
        reaction: emoji ? [customEmojiId
          ? new Api.ReactionCustomEmoji({ documentId: BigInt(customEmojiId) as any })
          : new Api.ReactionEmoji({ emoticon: emoji })] : [],
      }),
    );
  }

  async getSavedMessageTags(): Promise<{ tags: SavedMessageTag[]; defaults: SavedMessageTagReaction[] }> {
    const [tagResult, defaultResult] = await Promise.all([
      this.client.invoke(new Api.messages.GetSavedReactionTags({ hash: bigInt(0) })) as Promise<any>,
      this.client.invoke(new Api.messages.GetDefaultTagReactions({ hash: bigInt(0) })) as Promise<any>,
    ]);
    const mapTag = (item: any): SavedMessageTag | undefined => {
      const reaction = item?.reaction && savedTagReactionRef(item.reaction);
      if (!reaction) return undefined;
      const title = typeof item.title === 'string' && item.title ? item.title : undefined;
      return { reaction, ...(title ? { title } : {}), count: Math.max(0, Number(item.count) || 0) };
    };
    const tags = Array.isArray(tagResult?.tags) ? tagResult.tags.map(mapTag).filter(Boolean) as SavedMessageTag[] : [];
    const defaults = Array.isArray(defaultResult?.reactions)
      ? defaultResult.reactions.map(savedTagReactionRef).filter(Boolean) as SavedMessageTagReaction[] : [];
    return { tags: tags.slice(0, 100), defaults: [...new Map(defaults.map(reaction => [savedTagReactionKey(reaction), reaction])).values()].slice(0, 100) };
  }

  async updateSavedMessageTag(reactionValue: unknown, title?: string): Promise<void> {
    if (!this.selfId) throw new Error('Telegram account is not ready');
    if (title !== undefined && (typeof title !== 'string' || title.trim().length > 64)) throw new Error('Invalid saved tag title');
    const reaction = savedTagReaction(reactionValue);
    const catalog = await this.getSavedMessageTags();
    const key = savedTagReactionKey(reaction);
    if (![...catalog.defaults, ...catalog.tags.map(tag => tag.reaction)].some(item => savedTagReactionKey(item) === key)) {
      throw new Error('This reaction is not available as a Saved Messages tag');
    }
    const normalizedTitle = title?.trim();
    const result = await this.client.invoke(new Api.messages.UpdateSavedReactionTag({
      reaction,
      ...(normalizedTitle ? { title: normalizedTitle } : {}),
    }));
    if (!result) throw new Error('Telegram 未确认更新 Saved Messages 标签');
  }

  async setSavedMessageTag(chatId: number, messageId: number, reactionValue: unknown, enabled: boolean): Promise<void> {
    if (!this.selfId || chatId !== this.selfId || !Number.isSafeInteger(messageId) || messageId <= 0 || typeof enabled !== 'boolean') {
      throw new Error('Invalid Saved Messages tag target');
    }
    const reaction = savedTagReaction(reactionValue);
    const catalog = await this.getSavedMessageTags();
    const key = savedTagReactionKey(reaction);
    if (![...catalog.defaults, ...catalog.tags.map(tag => tag.reaction)].some(item => savedTagReactionKey(item) === key)) {
      throw new Error('This reaction is not available as a Saved Messages tag');
    }
    const result = await this.client.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] })) as any;
    const message = result?.messages?.find((item: any) => Number(item.id) === messageId);
    if (!(message instanceof Api.Message)) throw new Error('Saved message no longer exists');
    const chosen = (message.reactions?.results || []).filter((item: any) => item.chosenOrder != null)
      .map((item: any) => item.reaction as Api.TypeReaction).filter(Boolean);
    const hasTag = chosen.some(item => savedTagReactionKey(item) === key);
    const next = enabled
      ? (hasTag ? chosen : [...chosen, reaction])
      : chosen.filter(item => savedTagReactionKey(item) !== key);
    if (hasTag === enabled) return;
    await this.client.invoke(new Api.messages.SendReaction({
      peer: this.resolvePeer(this.selfId), msgId: messageId, reaction: next,
    }));
  }

  async getMessageEffects(): Promise<Array<{ id: string; emoticon: string; premium: boolean; staticIconId?: string }>> {
    const result = await this.client.invoke(new Api.messages.GetAvailableEffects({ hash: 0 })) as any;
    if (!(result instanceof Api.messages.AvailableEffects) && result?.className !== 'messages.AvailableEffects') return [];
    const seen = new Set<string>();
    return (result.effects || []).flatMap((effect: any) => {
      if (!(effect instanceof Api.AvailableEffect) && effect?.className !== 'AvailableEffect') return [];
      const id = String(effect.id);
      if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > (1n << 63n) - 1n || seen.has(id) || !isSingleEmoji(effect.emoticon)) return [];
      seen.add(id);
      const staticIconId = effect.staticIconId == null ? undefined : String(effect.staticIconId);
      return [{ id, emoticon: effect.emoticon, premium: Boolean(effect.premiumRequired),
        ...(staticIconId && /^[1-9]\d{0,19}$/.test(staticIconId) ? { staticIconId } : {}) }];
    }).slice(0, 100);
  }

  async getTelegramChatThemes(): Promise<Array<{ emoticon: string; title: string; accentColor?: number }>> {
    const result = await this.client.invoke(new Api.account.GetChatThemes({ hash: bigInt(0) })) as any;
    if (!(result instanceof Api.account.Themes) && result?.className !== 'account.Themes') return [];
    const seen = new Set<string>();
    return (result.themes || []).flatMap((theme: any) => {
      if (!(theme instanceof Api.Theme) && theme?.className !== 'Theme') return [];
      const emoticon = theme.emoticon;
      if (!isSingleEmoji(emoticon) || seen.has(emoticon)) return [];
      seen.add(emoticon);
      const settings = Array.isArray(theme.settings) ? theme.settings.find((item: any) => item?.className === 'ThemeSettings' || item instanceof Api.ThemeSettings) : undefined;
      const colors = Array.isArray(settings?.messageColors) ? settings.messageColors : [];
      const accentColor = colors.find((color: unknown) => Number.isInteger(color) && Number(color) >= 0 && Number(color) <= 0xFFFFFF) ??
        (Number.isInteger(settings?.accentColor) && settings.accentColor >= 0 && settings.accentColor <= 0xFFFFFF ? settings.accentColor : undefined);
      return [{ emoticon, title: typeof theme.title === 'string' && theme.title.trim() ? theme.title.trim().slice(0, 80) : emoticon,
        ...(accentColor == null ? {} : { accentColor }) }];
    }).slice(0, 100);
  }

  async getTelegramBusinessSettings(): Promise<{
    workHours?: { openNow?: boolean; timezoneId: string; weeklyOpen: Array<{ startMinute: number; endMinute: number }> };
    location?: { address: string; latitude?: number; longitude?: number };
    greeting?: { shortcutId: number; noActivityDays: number; recipients: Record<string, boolean | number> };
    away?: { shortcutId: number; offlineOnly: boolean; schedule: string; startDate?: number; endDate?: number; recipients: Record<string, boolean | number> };
    intro?: { title: string; description: string; hasSticker: boolean };
    chatLinks: Array<{ title: string; url?: string; message: string; hasFormatting?: boolean; views: number }>;
  }> {
    const response = await this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })) as any;
    const full: any = response?.fullUser;
    if (!full) throw new Error('Telegram business settings are unavailable');
    const recipientSummary = (recipients: any): Record<string, boolean | number> => ({
      existingChats: Boolean(recipients?.existingChats), newChats: Boolean(recipients?.newChats),
      contacts: Boolean(recipients?.contacts), nonContacts: Boolean(recipients?.nonContacts),
      excludeSelected: Boolean(recipients?.excludeSelected), selectedUsers: Array.isArray(recipients?.users) ? Math.min(1000, recipients.users.length) : 0,
    });
    const rawHours = full.businessWorkHours;
    const workHours = rawHours ? {
      ...(typeof rawHours.openNow === 'boolean' ? { openNow: rawHours.openNow } : {}),
      timezoneId: typeof rawHours.timezoneId === 'string' ? rawHours.timezoneId.slice(0, 128) : '',
      weeklyOpen: (Array.isArray(rawHours.weeklyOpen) ? rawHours.weeklyOpen : []).flatMap((item: any) => {
        const startMinute = Number(item?.startMinute), endMinute = Number(item?.endMinute);
        return Number.isSafeInteger(startMinute) && Number.isSafeInteger(endMinute) && startMinute >= 0 && endMinute <= 10080 && startMinute < endMinute
          ? [{ startMinute, endMinute }] : [];
      }).slice(0, 100),
    } : undefined;
    const rawLocation = full.businessLocation;
    const latitude = Number(rawLocation?.geoPoint?.lat), longitude = Number(rawLocation?.geoPoint?.long);
    const location = rawLocation ? {
      address: typeof rawLocation.address === 'string' ? rawLocation.address.slice(0, 512) : '',
      ...(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? { latitude } : {}),
      ...(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? { longitude } : {}),
    } : undefined;
    const rawGreeting = full.businessGreetingMessage;
    const greeting = rawGreeting ? {
      shortcutId: Number(rawGreeting.shortcutId) || 0,
      noActivityDays: Math.max(0, Math.min(365, Number(rawGreeting.noActivityDays) || 0)),
      recipients: recipientSummary(rawGreeting.recipients),
    } : undefined;
    const rawAway = full.businessAwayMessage;
    const rawSchedule = rawAway?.schedule;
    const away = rawAway ? {
      shortcutId: Number(rawAway.shortcutId) || 0,
      offlineOnly: Boolean(rawAway.offlineOnly),
      schedule: rawSchedule?.className === 'BusinessAwayMessageScheduleOutsideWorkHours' ? 'outside_work_hours' :
        rawSchedule?.className === 'BusinessAwayMessageScheduleCustom' ? 'custom' : 'always',
      ...(rawSchedule?.className === 'BusinessAwayMessageScheduleCustom' && Number.isSafeInteger(rawSchedule.startDate) ? { startDate: rawSchedule.startDate } : {}),
      ...(rawSchedule?.className === 'BusinessAwayMessageScheduleCustom' && Number.isSafeInteger(rawSchedule.endDate) ? { endDate: rawSchedule.endDate } : {}),
      recipients: recipientSummary(rawAway.recipients),
    } : undefined;
    const rawIntro = full.businessIntro;
    const intro = rawIntro ? {
      title: typeof rawIntro.title === 'string' ? rawIntro.title.slice(0, 256) : '',
      description: typeof rawIntro.description === 'string' ? rawIntro.description.slice(0, 4096) : '',
      hasSticker: Boolean(rawIntro.sticker),
    } : undefined;
    let rawLinks: any;
    try { rawLinks = await this.client.invoke(new Api.account.GetBusinessChatLinks()) as any; }
    catch (error: any) { this.logger.debug({ error: error?.message }, 'Telegram business chat links are unavailable'); }
    const chatLinks = (Array.isArray(rawLinks?.links) ? rawLinks.links : []).flatMap((item: any) => {
      const title = typeof item?.title === 'string' ? item.title.slice(0, 128) : '';
      const message = typeof item?.message === 'string' ? item.message.slice(0, 2048) : '';
      const rawUrl = typeof item?.link === 'string' ? item.link : '';
      let safeUrl: string | undefined;
      try {
        const url = new URL(rawUrl);
        if (url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && !url.port &&
            /^\/m\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname) && !url.search && !url.hash) safeUrl = url.toString();
      } catch {}
      return title || message || safeUrl ? [{ title, ...(safeUrl ? { url: safeUrl } : {}), message,
        ...(Array.isArray(item?.entities) && item.entities.length > 0 ? { hasFormatting: true } : {}),
        views: Math.max(0, Number(item?.views) || 0) }] : [];
    }).slice(0, 100);
    return { ...(workHours ? { workHours } : {}), ...(location ? { location } : {}), ...(greeting ? { greeting } : {}),
      ...(away ? { away } : {}), ...(intro ? { intro } : {}), chatLinks };
  }

  async updateTelegramBusinessWorkHours(timezoneId: string, weeklyOpen: Array<{ startMinute: number; endMinute: number }>): Promise<void> {
    if (typeof timezoneId !== 'string' || !timezoneId.trim() || timezoneId.length > 128 || !Array.isArray(weeklyOpen) || weeklyOpen.length > 100) {
      throw new Error('Invalid Telegram Business work hours');
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }).format(); }
    catch { throw new Error('Invalid Telegram Business timezone'); }
    const intervals = weeklyOpen.map(item => ({ startMinute: item?.startMinute, endMinute: item?.endMinute }))
      .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    let previousEnd = -1;
    for (const item of intervals) {
      if (!Number.isSafeInteger(item.startMinute) || !Number.isSafeInteger(item.endMinute) || item.startMinute < 0 ||
          item.endMinute > 10080 || item.startMinute >= item.endMinute || item.startMinute < previousEnd) {
        throw new Error('Invalid or overlapping Telegram Business work interval');
      }
      previousEnd = item.endMinute;
    }
    const result = await this.client.invoke(new Api.account.UpdateBusinessWorkHours({
      businessWorkHours: new Api.BusinessWorkHours({
        timezoneId,
        weeklyOpen: intervals.map(item => new Api.BusinessWeeklyOpen(item)),
      }),
    }));
    if (result === false) throw new Error('Telegram did not confirm Business work hours');
  }

  async updateTelegramBusinessLocation(address: string, latitude?: number, longitude?: number): Promise<void> {
    if (typeof address !== 'string' || address.length > 512 ||
        ((latitude == null) !== (longitude == null)) ||
        (latitude != null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
        (longitude != null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
      throw new Error('Invalid Telegram Business location');
    }
    const params: { address?: string; geoPoint?: Api.InputGeoPoint } = {};
    if (address) params.address = address;
    if (latitude != null && longitude != null) params.geoPoint = new Api.InputGeoPoint({ lat: latitude, long: longitude });
    const result = await this.client.invoke(new Api.account.UpdateBusinessLocation(params));
    if (result === false) throw new Error('Telegram did not confirm Business location');
  }

  async updateTelegramBusinessIntro(title: string, description: string, clear = false): Promise<void> {
    if (typeof title !== 'string' || title.length > 256 || typeof description !== 'string' || description.length > 4096 || typeof clear !== 'boolean') {
      throw new Error('Invalid Telegram Business intro');
    }
    let intro: Api.InputBusinessIntro | undefined;
    if (!clear) {
      const response = await this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })) as any;
      const rawIntro = response?.fullUser?.businessIntro;
      let sticker: Api.TypeInputDocument | undefined;
      if (rawIntro?.sticker) {
        const document = rawIntro.sticker;
        if (!(document instanceof Api.Document) || !document.id || !document.accessHash) {
          throw new Error('Cannot safely preserve the current Business intro sticker');
        }
        sticker = new Api.InputDocument({ id: document.id, accessHash: document.accessHash,
          fileReference: document.fileReference ? Buffer.from(document.fileReference) : Buffer.alloc(0) });
      }
      if (title || description || sticker) intro = new Api.InputBusinessIntro({ title, description, ...(sticker ? { sticker } : {}) });
    }
    const result = await this.client.invoke(new Api.account.UpdateBusinessIntro({ ...(intro ? { intro } : {}) }));
    if (result === false) throw new Error('Telegram did not confirm Business intro');
  }

  async createTelegramBusinessChatLink(title: string, message: string): Promise<{ title?: string; url?: string; message: string; views: number }> {
    if (typeof title !== 'string' || title.length > 128 || typeof message !== 'string' || !message.trim() || message.length > 2048) {
      throw new Error('Invalid Telegram Business chat link');
    }
    const response = await this.client.invoke(new Api.account.CreateBusinessChatLink({
      link: new Api.InputBusinessChatLink({ message, ...(title.trim() ? { title: title.trim() } : {}) }),
    })) as any;
    if (!(response instanceof Api.BusinessChatLink) && response?.className !== 'BusinessChatLink') {
      throw new Error('Telegram did not return a Business chat link');
    }
    const returnedTitle = typeof response.title === 'string' ? response.title.slice(0, 128) : '';
    const returnedMessage = typeof response.message === 'string' ? response.message.slice(0, 2048) : '';
    let url: string | undefined;
    try {
      const parsed = new URL(response.link);
      if (parsed.protocol === 'https:' && parsed.hostname === 't.me' && !parsed.username && !parsed.password && !parsed.port &&
          /^\/m\/[A-Za-z0-9_-]{1,128}\/?$/.test(parsed.pathname) && !parsed.search && !parsed.hash) url = parsed.toString();
    } catch {}
    return { ...(returnedTitle ? { title: returnedTitle } : {}), ...(url ? { url } : {}), message: returnedMessage,
      views: Math.max(0, Number(response.views) || 0) };
  }

  async editTelegramBusinessChatLink(slug: string, title: string, message: string): Promise<void> {
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(slug) || typeof title !== 'string' || title.length > 128 ||
        typeof message !== 'string' || !message.trim() || message.length > 2048) throw new Error('Invalid Telegram Business chat link');
    const response = await this.client.invoke(new Api.account.GetBusinessChatLinks()) as any;
    const item = (Array.isArray(response?.links) ? response.links : []).find((link: any) => {
      if (typeof link?.link !== 'string') return false;
      try {
        const url = new URL(link.link);
        return url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && !url.port &&
          url.pathname.replace(/\/$/, '') === `/m/${slug}` && !url.search && !url.hash;
      } catch { return false; }
    });
    if (!item || typeof item.message !== 'string') throw new Error('Telegram Business chat link was not found on this account');
    const keepEntities = message === item.message && Array.isArray(item.entities) && item.entities.length > 0;
    const updated = await this.client.invoke(new Api.account.EditBusinessChatLink({ slug, link: new Api.InputBusinessChatLink({
      message, ...(keepEntities ? { entities: item.entities } : {}), ...(title.trim() ? { title: title.trim() } : {}),
    }) })) as any;
    if (!(updated instanceof Api.BusinessChatLink) && updated?.className !== 'BusinessChatLink') {
      throw new Error('Telegram did not confirm Business chat link update');
    }
  }

  async deleteTelegramBusinessChatLink(slug: string): Promise<void> {
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(slug)) throw new Error('Invalid Telegram Business chat link');
    const response = await this.client.invoke(new Api.account.GetBusinessChatLinks()) as any;
    const links = Array.isArray(response?.links) ? response.links : [];
    const exists = links.some((item: any) => {
      if (typeof item?.link !== 'string') return false;
      try {
        const url = new URL(item.link);
        return url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && !url.port &&
          url.pathname.replace(/\/$/, '') === `/m/${slug}` && !url.search && !url.hash;
      } catch { return false; }
    });
    if (!exists) throw new Error('Telegram Business chat link was not found on this account');
    const result = await this.client.invoke(new Api.account.DeleteBusinessChatLink({ slug }));
    if (result === false) throw new Error('Telegram did not confirm Business chat link deletion');
  }

  private async mapBusinessRecipients(response: any, current: any, options: {
    existingChats: boolean; newChats: boolean; contacts: boolean; nonContacts: boolean;
  }): Promise<Api.InputBusinessRecipients> {
    if (!options || ['existingChats', 'newChats', 'contacts', 'nonContacts'].some(key => typeof (options as any)[key] !== 'boolean')) {
      throw new Error('Invalid Telegram Business recipients');
    }
    const rawRecipients = current?.recipients || {};
    const ids: string[] = Array.isArray(rawRecipients.users)
      ? Array.from(new Set<string>(rawRecipients.users.map((id: any) => String(id?.toString?.() ?? id)))) : [];
    if (ids.length > 1000) throw new Error('Too many Telegram Business recipient exceptions');
    const usersById = new Map<string, any>();
    for (const user of response?.users || []) if (user?.id != null) usersById.set(String(user.id), user);
    const users = await Promise.all(ids.map(async (id: string) => {
      if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) throw new Error('Cannot safely preserve Business recipient exceptions');
      if (this.selfId && id === String(this.selfId)) return new Api.InputUserSelf();
      const user = usersById.get(id);
      if (user?.accessHash) return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId)) throw new Error('Cannot safely preserve Business recipient exceptions');
      try { return await this.resolveAdminInputUser(numericId); }
      catch { throw new Error('无法安全保留 Business 自动回复的指定用户，未执行更改'); }
    }));
    return new Api.InputBusinessRecipients({
      existingChats: options.existingChats, newChats: options.newChats,
      contacts: options.contacts, nonContacts: options.nonContacts,
      excludeSelected: Boolean(rawRecipients.excludeSelected), users,
    });
  }

  async updateTelegramBusinessGreetingMessage(shortcutId: number, noActivityDays: number,
    recipients: { existingChats: boolean; newChats: boolean; contacts: boolean; nonContacts: boolean }, clear = false): Promise<void> {
    if (typeof clear !== 'boolean') throw new Error('Invalid Telegram Business greeting message');
    if (clear) {
      const result = await this.client.invoke(new Api.account.UpdateBusinessGreetingMessage({}));
      if (result === false) throw new Error('Telegram did not confirm Business greeting message removal');
      return;
    }
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !Number.isSafeInteger(noActivityDays) || noActivityDays < 0 || noActivityDays > 365) {
      throw new Error('Invalid Telegram Business greeting message');
    }
    if (!(await this.getQuickReplies()).some(item => item.shortcutId === shortcutId)) throw new Error('Telegram quick reply was not found');
    const response = await this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })) as any;
    if (!response?.fullUser) throw new Error('Telegram Business settings are unavailable');
    const mappedRecipients = await this.mapBusinessRecipients(response, response.fullUser.businessGreetingMessage, recipients);
    const result = await this.client.invoke(new Api.account.UpdateBusinessGreetingMessage({
      message: new Api.InputBusinessGreetingMessage({ shortcutId, noActivityDays, recipients: mappedRecipients }),
    }));
    if (result === false) throw new Error('Telegram did not confirm Business greeting message');
  }

  async updateTelegramBusinessAwayMessage(shortcutId: number, offlineOnly: boolean,
    schedule: 'always' | 'outside_work_hours' | 'custom', startDate: number | undefined, endDate: number | undefined,
    recipients: { existingChats: boolean; newChats: boolean; contacts: boolean; nonContacts: boolean }, clear = false): Promise<void> {
    if (typeof clear !== 'boolean') throw new Error('Invalid Telegram Business away message');
    if (clear) {
      const result = await this.client.invoke(new Api.account.UpdateBusinessAwayMessage({}));
      if (result === false) throw new Error('Telegram did not confirm Business away message removal');
      return;
    }
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || typeof offlineOnly !== 'boolean' ||
        !['always', 'outside_work_hours', 'custom'].includes(schedule)) throw new Error('Invalid Telegram Business away message');
    if (!(await this.getQuickReplies()).some(item => item.shortcutId === shortcutId)) throw new Error('Telegram quick reply was not found');
    let scheduleInput: Api.TypeBusinessAwayMessageSchedule;
    if (schedule === 'outside_work_hours') scheduleInput = new Api.BusinessAwayMessageScheduleOutsideWorkHours();
    else if (schedule === 'custom') {
      if (!Number.isSafeInteger(startDate) || !Number.isSafeInteger(endDate) || startDate! <= 0 || endDate! <= startDate! || endDate! > 2147483647) {
        throw new Error('Invalid Telegram Business away schedule');
      }
      scheduleInput = new Api.BusinessAwayMessageScheduleCustom({ startDate: startDate!, endDate: endDate! });
    } else scheduleInput = new Api.BusinessAwayMessageScheduleAlways();
    const response = await this.client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })) as any;
    if (!response?.fullUser) throw new Error('Telegram Business settings are unavailable');
    const mappedRecipients = await this.mapBusinessRecipients(response, response.fullUser.businessAwayMessage, recipients);
    const result = await this.client.invoke(new Api.account.UpdateBusinessAwayMessage({
      message: new Api.InputBusinessAwayMessage({ shortcutId, offlineOnly, schedule: scheduleInput, recipients: mappedRecipients }),
    }));
    if (result === false) throw new Error('Telegram did not confirm Business away message');
  }

  private async getTelegramAppThemesRaw(): Promise<Api.Theme[]> {
    if (this.telegramAppThemesCache && this.telegramAppThemesCache.expiresAt > Date.now()) return this.telegramAppThemesCache.items;
    const response = await this.client.invoke(new Api.account.GetThemes({ format: 'android', hash: bigInt(0) })) as any;
    if (!(response instanceof Api.account.Themes) && response?.className !== 'account.Themes') {
      if (response instanceof Api.account.ThemesNotModified || response?.className === 'account.ThemesNotModified') {
        return this.telegramAppThemesCache?.items || [];
      }
      return [];
    }
    const themes = Array.isArray(response.themes) ? response.themes.filter((theme: any) =>
      theme instanceof Api.Theme || theme?.className === 'Theme').slice(0, 300) : [];
    this.telegramAppThemesCache = { expiresAt: Date.now() + 10 * 60 * 1000, items: themes };
    return themes;
  }

  async getTelegramAppThemes(): Promise<Array<{ slug: string; title: string; emoticon?: string; dark: boolean; accentColor?: number; messageColors: number[] }>> {
    const themes = await this.getTelegramAppThemesRaw();
    const seen = new Set<string>();
    return themes.flatMap((theme: any) => {
      const slug = typeof theme.slug === 'string' ? theme.slug : '';
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || seen.has(slug)) return [];
      seen.add(slug);
      const settings = Array.isArray(theme.settings) ? theme.settings.find((item: any) => item?.className === 'ThemeSettings' || item instanceof Api.ThemeSettings) : undefined;
      const baseTheme = String(settings?.baseTheme?.className || '');
      const accentColor = Number.isInteger(settings?.accentColor) && settings.accentColor >= 0 && settings.accentColor <= 0xFFFFFF
        ? settings.accentColor : undefined;
      const messageColors = Array.isArray(settings?.messageColors)
        ? settings.messageColors.filter((color: unknown) => Number.isInteger(color) && Number(color) >= 0 && Number(color) <= 0xFFFFFF).slice(0, 4)
        : [];
      const emoticon = isSingleEmoji(theme.emoticon) ? theme.emoticon : undefined;
      return [{ slug, title: typeof theme.title === 'string' && theme.title.trim() ? theme.title.trim().slice(0, 80) : slug,
        ...(emoticon ? { emoticon } : {}), dark: /Night|Tinted/.test(baseTheme), ...(accentColor == null ? {} : { accentColor }), messageColors }];
    }).slice(0, 200);
  }

  async installTelegramAppTheme(slug: string, dark: boolean): Promise<{ slug: string; dark: boolean }> {
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(slug) || typeof dark !== 'boolean') {
      throw new Error('Invalid Telegram theme');
    }
    if (!(await this.getTelegramAppThemesRaw()).some((theme: any) => theme.slug === slug)) {
      throw new Error('Telegram theme is unavailable');
    }
    const result = await this.client.invoke(new Api.account.InstallTheme({
      theme: new Api.InputThemeSlug({ slug }), format: 'android', dark,
    }));
    if (!result) throw new Error('Telegram did not confirm theme installation');
    return { slug, dark };
  }

  async getTelegramChatTheme(chatId: number): Promise<{ emoticon: string; wallpaper?: {
    slug: string; pattern: boolean; dark: boolean; motion: boolean; mimeType?: string; backgroundColor?: number;
    settings: { blur: boolean; motion: boolean; intensity?: number; rotation?: number; backgroundColors: number[]; emoticon?: string };
  } | null }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid chat theme peer');
    const peer: any = await this.client.getInputEntity(this.resolvePeer(chatId));
    let response: any;
    if (peer instanceof Api.InputPeerSelf || peer instanceof Api.InputPeerUser) {
      const inputUser = peer instanceof Api.InputPeerSelf ? new Api.InputUserSelf() :
        new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
      response = await this.client.invoke(new Api.users.GetFullUser({ id: inputUser }));
      return { emoticon: String(response?.fullUser?.themeEmoticon || ''), wallpaper: this.mapTelegramPeerWallpaper(response?.fullUser?.wallpaper) };
    }
    if (peer instanceof Api.InputPeerChat) {
      response = await this.client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }));
      return { emoticon: String(response?.fullChat?.themeEmoticon || ''), wallpaper: this.mapTelegramPeerWallpaper(response?.fullChat?.wallpaper) };
    }
    if (peer instanceof Api.InputPeerChannel) {
      response = await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
      return { emoticon: String(response?.fullChat?.themeEmoticon || ''), wallpaper: this.mapTelegramPeerWallpaper(response?.fullChat?.wallpaper) };
    }
    throw new Error('Unsupported chat theme peer');
  }

  private mapTelegramWallpaperSettings(settings: any): { blur: boolean; motion: boolean; intensity?: number; rotation?: number; backgroundColors: number[]; emoticon?: string } {
    const backgroundColors = [settings?.backgroundColor, settings?.secondBackgroundColor, settings?.thirdBackgroundColor, settings?.fourthBackgroundColor]
      .filter((color: unknown) => Number.isInteger(color) && Number(color) >= 0 && Number(color) <= 0xFFFFFF) as number[];
    const intensity = Number.isInteger(settings?.intensity) && settings.intensity >= -100 && settings.intensity <= 100 ? settings.intensity : undefined;
    const rotation = Number.isInteger(settings?.rotation) && settings.rotation >= 0 && settings.rotation < 360 ? settings.rotation : undefined;
    return { blur: Boolean(settings?.blur), motion: Boolean(settings?.motion), backgroundColors,
      ...(intensity == null ? {} : { intensity }), ...(rotation == null ? {} : { rotation }),
      ...(isSingleEmoji(settings?.emoticon) ? { emoticon: settings.emoticon } : {}) };
  }

  private mapTelegramPeerWallpaper(wallpaper: any): { slug: string; pattern: boolean; dark: boolean; motion: boolean; mimeType?: string; backgroundColor?: number; settings: ReturnType<TelegramDriver['mapTelegramWallpaperSettings']> } | null {
    if (!wallpaper || !['WallPaper', 'WallPaperNoFile'].includes(wallpaper.className)) return null;
    const slug = typeof wallpaper.slug === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(wallpaper.slug) ? wallpaper.slug : '';
    const settings = wallpaper.settings;
    const backgroundColor = Number.isInteger(settings?.backgroundColor) && settings.backgroundColor >= 0 && settings.backgroundColor <= 0xFFFFFF
      ? settings.backgroundColor : undefined;
    const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(String(wallpaper.document?.mimeType))
      ? String(wallpaper.document.mimeType) : undefined;
    return { slug, pattern: Boolean(wallpaper.pattern), dark: Boolean(wallpaper.dark), motion: Boolean(settings?.motion),
      settings: this.mapTelegramWallpaperSettings(settings),
      ...(mimeType ? { mimeType } : {}), ...(backgroundColor == null ? {} : { backgroundColor }) };
  }

  private async getTelegramWallpaperCatalogRaw(): Promise<Api.TypeWallPaper[]> {
    if (this.telegramWallpapersCache && this.telegramWallpapersCache.expiresAt > Date.now()) return this.telegramWallpapersCache.items;
    const response = await this.client.invoke(new Api.account.GetWallPapers({ hash: bigInt(0) })) as any;
    if (!(response instanceof Api.account.WallPapers) && response?.className !== 'account.WallPapers') {
      if (response instanceof Api.account.WallPapersNotModified || response?.className === 'account.WallPapersNotModified') {
        return this.telegramWallpapersCache?.items || [];
      }
      return [];
    }
    const items = Array.isArray(response.wallpapers) ? response.wallpapers.slice(0, 300) : [];
    this.telegramWallpapersCache = { expiresAt: Date.now() + 10 * 60 * 1000, items };
    return items;
  }

  async getTelegramWallpapers(): Promise<Array<{ slug: string; title: string; pattern: boolean; dark: boolean; motion: boolean; mimeType?: string; backgroundColor?: number; settings: ReturnType<TelegramDriver['mapTelegramWallpaperSettings']> }>> {
    const wallpapers = await this.getTelegramWallpaperCatalogRaw();
    const seen = new Set<string>();
    return wallpapers.flatMap((wallpaper: any, index) => {
      if (!(wallpaper instanceof Api.WallPaper) && wallpaper?.className !== 'WallPaper') return [];
      const slug = typeof wallpaper.slug === 'string' ? wallpaper.slug : '';
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || seen.has(slug)) return [];
      seen.add(slug);
      const attributes = wallpaper.document?.attributes || [];
      const filename = attributes.find((attribute: any) => attribute?.className === 'DocumentAttributeFilename')?.fileName;
      const backgroundColor = Number.isInteger(wallpaper.settings?.backgroundColor) && wallpaper.settings.backgroundColor >= 0 && wallpaper.settings.backgroundColor <= 0xFFFFFF
        ? wallpaper.settings.backgroundColor : undefined;
      const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(String(wallpaper.document?.mimeType))
        ? String(wallpaper.document.mimeType) : undefined;
      const title = typeof filename === 'string' && filename.trim()
        ? filename.trim().replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 80)
        : (wallpaper.settings?.emoticon || (wallpaper.pattern ? '图案壁纸' : `Telegram 壁纸 ${index + 1}`));
      return [{ slug, title, pattern: Boolean(wallpaper.pattern), dark: Boolean(wallpaper.dark), motion: Boolean(wallpaper.settings?.motion),
        settings: this.mapTelegramWallpaperSettings(wallpaper.settings), ...(mimeType ? { mimeType } : {}),
        ...(backgroundColor == null ? {} : { backgroundColor }) }];
    }).slice(0, 200);
  }

  async downloadTelegramWallpaper(slug: string): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || !this.selfId) return undefined;
    const wallpaper: any = (await this.getTelegramWallpaperCatalogRaw()).find((item: any) => item?.className === 'WallPaper' && item.slug === slug);
    const document = wallpaper?.document;
    const mimeType = String(document?.mimeType || '');
    const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };
    if (!document || !extensions[mimeType]) return undefined;
    const size = Number(document.size);
    if (Number.isFinite(size) && size > 32 * 1024 * 1024) return undefined;
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const targetPath = path.resolve('data', 'cache', 'wallpapers', `${namespace}_${slug}.${extensions[mimeType]}`);
    try {
      const downloaded = await downloadMediaToCache(targetPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadMedia(document, { outputFile: writer as any })));
      return downloaded ? { filePath: targetPath, mimeType } : undefined;
    } catch (err: any) {
      this.logger.warn({ slug, error: err.message }, 'Failed to download Telegram wallpaper');
      return undefined;
    }
  }

  async downloadTelegramWallpaperPreview(slug: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || !this.selfId) return undefined;
    const wallpaper: any = (await this.getTelegramWallpaperCatalogRaw()).find((item: any) => item?.className === 'WallPaper' && item.slug === slug);
    const document = wallpaper?.document;
    if (!document || !/^[1-9]\d{0,19}$/.test(String(document.id)) || !document.accessHash) return undefined;
    const thumb = (document.thumbs || []).find((item: any) => ['PhotoSize', 'PhotoSizeProgressive'].includes(item?.className) && typeof item.type === 'string');
    if (!thumb) return undefined;
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const destPath = path.resolve('data', 'cache', 'wallpapers', `${namespace}_${slug}_preview.jpg`);
    const location = new Api.InputDocumentFileLocation({
      id: document.id,
      accessHash: document.accessHash,
      fileReference: document.fileReference ? Buffer.from(document.fileReference) : Buffer.alloc(0),
      thumbSize: thumb.type,
    });
    try {
      const downloaded = await downloadMediaToCache(destPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadFile(location as any, { outputFile: writer as any })));
      return downloaded ? destPath : undefined;
    } catch (err: any) {
      this.logger.warn({ slug, error: err.message }, 'Failed to download Telegram wallpaper preview');
      return undefined;
    }
  }

  async setTelegramChatWallpaper(chatId: number, slug: string, options: { forBoth?: boolean; settings?: { blur?: boolean; motion?: boolean; intensity?: number } } = {}): Promise<{ slug: string; settings?: ReturnType<TelegramDriver['mapTelegramWallpaperSettings']> }> {
    const forBoth = options?.forBoth ?? false;
    const requestedSettings = options?.settings || {};
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof slug !== 'string' || typeof forBoth !== 'boolean' ||
        (slug && !/^[A-Za-z0-9_-]{1,128}$/.test(slug)) || (!slug && forBoth) ||
        Object.keys(requestedSettings).some(key => !['blur', 'motion', 'intensity'].includes(key)) ||
        (requestedSettings.blur !== undefined && typeof requestedSettings.blur !== 'boolean') ||
        (requestedSettings.motion !== undefined && typeof requestedSettings.motion !== 'boolean') ||
        (requestedSettings.intensity !== undefined && (!Number.isInteger(requestedSettings.intensity) || requestedSettings.intensity < -100 || requestedSettings.intensity > 100))) {
      throw new Error('Invalid Telegram chat wallpaper');
    }
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (!(peer instanceof Api.InputPeerUser) && !(peer instanceof Api.InputPeerChat) && !(peer instanceof Api.InputPeerChannel)) {
      throw new Error('Telegram chat wallpapers are only available for chats and channels');
    }
    if (forBoth && !(peer instanceof Api.InputPeerUser)) throw new Error('Applying a wallpaper for both people is only available in private chats');
    if (!slug) {
      const result = await this.client.invoke(new Api.messages.SetChatWallPaper({ peer, revert: true }));
      if (!result) throw new Error('Telegram did not confirm the wallpaper reset');
      return { slug: '' };
    }
    const wallpaper: any = (await this.getTelegramWallpaperCatalogRaw()).find((item: any) => item?.className === 'WallPaper' && item.slug === slug);
    if (!wallpaper) throw new Error('Telegram wallpaper is unavailable');
    const defaults = wallpaper.settings || {};
    const settings = new Api.WallPaperSettings({
      blur: requestedSettings.blur ?? Boolean(defaults.blur),
      motion: requestedSettings.motion ?? Boolean(defaults.motion),
      ...(defaults.backgroundColor == null ? {} : { backgroundColor: defaults.backgroundColor }),
      ...(defaults.secondBackgroundColor == null ? {} : { secondBackgroundColor: defaults.secondBackgroundColor }),
      ...(defaults.thirdBackgroundColor == null ? {} : { thirdBackgroundColor: defaults.thirdBackgroundColor }),
      ...(defaults.fourthBackgroundColor == null ? {} : { fourthBackgroundColor: defaults.fourthBackgroundColor }),
      ...((requestedSettings.intensity ?? defaults.intensity) == null ? {} : { intensity: requestedSettings.intensity ?? defaults.intensity }),
      ...(defaults.rotation == null ? {} : { rotation: defaults.rotation }),
      ...(defaults.emoticon ? { emoticon: defaults.emoticon } : {}),
    });
    const result = await this.client.invoke(new Api.messages.SetChatWallPaper({
      peer,
      ...(forBoth ? { forBoth: true } : {}),
      wallpaper: new Api.InputWallPaperSlug({ slug }),
      settings,
    }));
    if (!result) throw new Error('Telegram did not confirm the wallpaper change');
    return { slug, settings: this.mapTelegramWallpaperSettings(settings) };
  }

  async setTelegramChatTheme(chatId: number, emoticon: string): Promise<{ emoticon: string }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof emoticon !== 'string' ||
        (emoticon !== '' && !isSingleEmoji(emoticon))) throw new Error('Invalid Telegram chat theme');
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (!(peer instanceof Api.InputPeerUser) && !(peer instanceof Api.InputPeerSelf)) {
      throw new Error('Telegram chat themes are only available for private chats');
    }
    if (emoticon && !(await this.getTelegramChatThemes()).some(theme => theme.emoticon === emoticon)) {
      throw new Error('Telegram chat theme is unavailable');
    }
    const result = await this.client.invoke(new Api.messages.SetChatTheme({ peer, emoticon }));
    if (!result) throw new Error('Telegram did not confirm the chat theme');
    return { emoticon };
  }

  async setChatHistoryTtl(chatId: number, period: number): Promise<{ period: number }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(period) || period < 0 || period > 31536000) {
      throw new Error('Invalid Telegram message auto-delete period');
    }
    const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
    if (![Api.InputPeerSelf, Api.InputPeerUser, Api.InputPeerChat, Api.InputPeerChannel].some(Type => peer instanceof Type)) {
      throw new Error('Unsupported Telegram message auto-delete peer');
    }
    const result = await this.client.invoke(new Api.messages.SetHistoryTTL({ peer, period }));
    if (!result) throw new Error('Telegram did not confirm the auto-delete timer');
    return { period };
  }

  async applyChatHistoryTtl(chatIds: number[], period: number): Promise<{ updated: number; failedChatIds: number[] }> {
    if (!Array.isArray(chatIds) || chatIds.length < 1 || chatIds.length > 100 ||
        chatIds.some(id => !Number.isSafeInteger(id) || id === 0) ||
        !Number.isSafeInteger(period) || period < 0 || period > 31536000) {
      throw new Error('Invalid Telegram auto-delete selection');
    }
    const unique = [...new Set(chatIds)];
    let updated = 0;
    const failedChatIds: number[] = [];
    for (const chatId of unique) {
      try {
        await this.setChatHistoryTtl(chatId, period);
        updated++;
      } catch {
        failedChatIds.push(chatId);
      }
    }
    return { updated, failedChatIds };
  }

  async getDefaultHistoryTtl(): Promise<{ period: number }> {
    const result: any = await this.client.invoke(new Api.messages.GetDefaultHistoryTTL());
    const period = Number(result?.period);
    if (!Number.isSafeInteger(period) || period < 0 || period > 31536000) {
      throw new Error('Telegram returned an invalid default auto-delete timer');
    }
    return { period };
  }

  async setDefaultHistoryTtl(period: number): Promise<{ period: number }> {
    if (!Number.isSafeInteger(period) || period < 0 || period > 31536000) {
      throw new Error('Invalid Telegram default auto-delete period');
    }
    const result = await this.client.invoke(new Api.messages.SetDefaultHistoryTTL({ period }));
    if (!result) throw new Error('Telegram did not confirm the default auto-delete timer');
    return { period };
  }

  async getAvailableReactions(chatId?: number): Promise<Array<{ reaction: string; title: string; premium: boolean; inactive: boolean; customEmojiId?: string }>> {
    if (chatId !== undefined && (!Number.isSafeInteger(chatId) || chatId === 0)) throw new Error('Invalid reaction peer');
    const result = await this.client.invoke(new Api.messages.GetAvailableReactions({ hash: 0 }));
    if (!(result instanceof Api.messages.AvailableReactions) && (result as any)?.className !== 'messages.AvailableReactions') return [];
    const reactions = (result as Api.messages.AvailableReactions).reactions
      .filter((reaction): reaction is Api.AvailableReaction => reaction instanceof Api.AvailableReaction || (reaction as any)?.className === 'AvailableReaction')
      .map(reaction => ({ reaction: reaction.reaction, title: reaction.title, premium: Boolean(reaction.premium), inactive: Boolean(reaction.inactive) }));

    if (chatId === undefined) return reactions;
    try {
      const peer = await this.client.getInputEntity(this.resolvePeer(chatId));
      let full: any;
      if (peer instanceof Api.InputPeerChat) {
        full = (await this.client.invoke(new Api.messages.GetFullChat({ chatId: peer.chatId }))) as any;
      } else if (peer instanceof Api.InputPeerChannel) {
        full = (await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }))) as any;
      }
      const restrictions = full?.fullChat?.availableReactions;
      if (!restrictions) return reactions;
      const kind = restrictions.className;
      if (restrictions instanceof Api.ChatReactionsNone || kind === 'ChatReactionsNone') return [];
      if (restrictions instanceof Api.ChatReactionsSome || kind === 'ChatReactionsSome') {
        const allowedEmoji = new Set((restrictions.reactions || [])
          .filter((reaction: any) => reaction instanceof Api.ReactionEmoji || reaction?.className === 'ReactionEmoji')
          .map((reaction: any) => reaction.emoticon));
        const enabled = reactions.filter(item => allowedEmoji.has(item.reaction));
        const customIds: string[] = [...new Set<string>((restrictions.reactions || [])
          .filter((reaction: any) => reaction instanceof Api.ReactionCustomEmoji || reaction?.className === 'ReactionCustomEmoji')
          .map((reaction: any): string => String(reaction.documentId))
          .filter((id: string) => /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= (1n << 63n) - 1n))].slice(0, 64);
        if (!customIds.length) return enabled;
        const documents = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: customIds.map((id: string) => BigInt(id) as any) })) as any[];
        const titles = new Map<string, string>();
        for (const document of documents || []) {
          if (!(document instanceof Api.Document)) continue;
          const attribute: any = (document.attributes || []).find((item: any) => item?.className === 'DocumentAttributeCustomEmoji');
          if (attribute) titles.set(String(document.id), String(attribute.alt || '✨').slice(0, 32));
        }
        return [...enabled, ...customIds.map((id: string) => ({
          reaction: `custom:${id}`, title: titles.get(id) || '自定义 Emoji', premium: true, inactive: false, customEmojiId: id,
        }))];
      }
      return reactions;
    } catch {
      // Telegram still enforces the peer's reaction policy when a reaction is sent.
      return reactions;
    }
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
    scheduleOptions: { schedule?: number; scheduleRepeatPeriod?: number } = {},
  ): Promise<number | undefined> {
    if (pollOptions != null && (!pollOptions || typeof pollOptions !== 'object' || Array.isArray(pollOptions))) {
      throw new Error('Invalid Telegram poll settings');
    }
    const settings = pollOptions || {};
    const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
    const normalizedOptions = Array.isArray(options) ? options.map(option => typeof option === 'string' ? option.trim() : '') : [];
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !normalizedQuestion || normalizedQuestion.length > 300 ||
        normalizedOptions.length < 2 || normalizedOptions.length > 10 ||
        normalizedOptions.some(option => !option || option.length > 100) || new Set(normalizedOptions).size !== normalizedOptions.length ||
        (settings.isAnonymous != null && typeof settings.isAnonymous !== 'boolean') ||
        (settings.isMultipleChoice != null && typeof settings.isMultipleChoice !== 'boolean') ||
        (settings.isQuiz != null && typeof settings.isQuiz !== 'boolean') ||
        (settings.isQuiz && settings.isMultipleChoice) ||
        (settings.isQuiz && (!Number.isSafeInteger(settings.correctOptionIndex) || settings.correctOptionIndex! < 0 || settings.correctOptionIndex! >= normalizedOptions.length)) ||
        (settings.explanation != null && (typeof settings.explanation !== 'string' || settings.explanation.length > 200))) {
      throw new Error('Invalid Telegram poll');
    }
    if ((scheduleOptions.schedule != null && (!Number.isSafeInteger(scheduleOptions.schedule) || scheduleOptions.schedule <= 0)) ||
        (scheduleOptions.scheduleRepeatPeriod != null && (!scheduleOptions.schedule ||
          !isTelegramScheduleRepeatPeriod(scheduleOptions.scheduleRepeatPeriod)))) {
      throw new Error('Invalid Telegram scheduled poll');
    }
    const peer = this.resolvePeer(chatId);
    const answers = normalizedOptions.map((opt, idx) => new Api.PollAnswer({
      text: new Api.TextWithEntities({ text: opt, entities: [] }),
      option: Buffer.from([idx]),
    }));

    const isQuiz = Boolean(settings.isQuiz);
    const correctAnswers = isQuiz
      ? [Buffer.from([settings.correctOptionIndex!])]
      : undefined;

    const requestOptions = {
      peer,
      media: new Api.InputMediaPoll({
        poll: new Api.Poll({
          id: BigInt(Date.now()) as any,
          question: new Api.TextWithEntities({ text: normalizedQuestion, entities: [] }),
          answers,
          closed: false,
          publicVoters: settings.isAnonymous === false,
          multipleChoice: Boolean(settings.isMultipleChoice),
          quiz: isQuiz,
        }),
        correctAnswers,
        solution: settings.explanation?.trim() || undefined,
      }),
      message: '',
      ...(scheduleOptions.schedule ? { scheduleDate: scheduleOptions.schedule } : {}),
    };
    const request = scheduleOptions.scheduleRepeatPeriod != null
      ? new ModernApi.messages.SendMedia({
          ...requestOptions,
          randomId: bigInt(BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString()),
          scheduleRepeatPeriod: scheduleOptions.scheduleRepeatPeriod,
        } as any)
      : new Api.messages.SendMedia(requestOptions);
    const res = await this.client.invoke(request as any);
    return TelegramDriver.extractMessageIdFromUpdates(res) ?? (res as any)?.updates?.find((update: any) => update.id)?.id;
  }

  async editPoll(
    chatId: number,
    messageId: number,
    question: string,
    options: string[],
    pollOptions: { correctOptionIndex?: number; explanation?: string } = {},
  ): Promise<void> {
    if (!pollOptions || typeof pollOptions !== 'object' || Array.isArray(pollOptions)) pollOptions = {};
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof question !== 'string' || !question.trim() || question.trim().length > 300 ||
        !Array.isArray(options) || options.length < 2 || options.length > 10 ||
        options.some(option => typeof option !== 'string' || !option.trim() || option.trim().length > 100) ||
        new Set(options.map(option => option.trim())).size !== options.length ||
        (pollOptions.correctOptionIndex != null && (!Number.isSafeInteger(pollOptions.correctOptionIndex) || pollOptions.correctOptionIndex < 0 || pollOptions.correctOptionIndex >= options.length)) ||
        (pollOptions.explanation != null && (typeof pollOptions.explanation !== 'string' || pollOptions.explanation.length > 200))) {
      throw new Error('Invalid Telegram poll edit');
    }

    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message: any = messages?.[0];
    const media = message?.media;
    const poll = message?.poll || media?.poll;
    const results = media?.results;
    const countedVoters = (results?.results || []).reduce((sum: number, item: any) => sum + (Number(item?.voters) || 0), 0);
    const totalVoters = Math.max(Number(results?.totalVoters) || 0, countedVoters);
    if (!message?.out || message.fwdFrom || !poll || !Array.isArray(poll.answers) || !poll.question || !poll.id || poll.closed || totalVoters > 0) {
      throw new Error('Telegram poll can only be edited by its author before anyone votes');
    }

    const isQuiz = Boolean(poll.quiz);
    let correctOptionIndex = pollOptions.correctOptionIndex;
    if (isQuiz && correctOptionIndex == null) {
      const priorCorrect = (results?.results || []).findIndex((item: any) => item?.correct);
      if (priorCorrect >= 0 && priorCorrect < options.length) correctOptionIndex = priorCorrect;
    }
    if (isQuiz && (correctOptionIndex == null || correctOptionIndex < 0 || correctOptionIndex >= options.length)) {
      throw new Error('Choose the correct answer before saving this quiz');
    }

    const optionId = (value: any): Buffer => Buffer.from(value || []);
    const existingByText = new Map<string, Buffer>();
    for (const answer of poll.answers) {
      const text = String(answer?.text?.text ?? answer?.text ?? '').trim();
      const id = optionId(answer?.option);
      if (text && id.length) existingByText.set(text, id);
    }
    const usedIds = new Set<string>();
    const answers = options.map(rawOption => {
      const text = rawOption.trim();
      let id = existingByText.get(text);
      if (!id || usedIds.has(id.toString('hex'))) {
        do { id = randomBytes(8); } while (usedIds.has(id.toString('hex')));
      }
      usedIds.add(id.toString('hex'));
      const existing = poll.answers.find((answer: any) => String(answer?.text?.text ?? answer?.text ?? '').trim() === text);
      const answerText = existing && String(existing.text?.text ?? existing.text ?? '') === text
        ? existing.text
        : new Api.TextWithEntities({ text, entities: [] });
      return new Api.PollAnswer({ text: answerText, option: id });
    });
    const previousQuestion = String(poll.question?.text ?? poll.question ?? '');
    const editedQuestion = question.trim() === previousQuestion
      ? poll.question
      : new Api.TextWithEntities({ text: question.trim(), entities: [] });
    const editedPoll = new Api.Poll({
      id: poll.id,
      closed: false,
      publicVoters: Boolean(poll.publicVoters),
      multipleChoice: Boolean(poll.multipleChoice),
      quiz: isQuiz,
      question: editedQuestion,
      answers,
      closePeriod: poll.closePeriod,
      closeDate: poll.closeDate,
    });
    const previousSolution = String(media?.solution ?? results?.solution ?? '');
    const solution = pollOptions.explanation?.trim() || undefined;
    const solutionEntities = solution && solution === previousSolution
      ? (media?.solutionEntities ?? results?.solutionEntities)
      : undefined;
    await this.client.invoke(new Api.messages.EditMessage({
      peer,
      id: messageId,
      media: new Api.InputMediaPoll({
        poll: editedPoll,
        correctAnswers: isQuiz ? [answers[correctOptionIndex!].option] : undefined,
        solution,
        solutionEntities,
      }),
    }));
  }

  async sendTodoList(chatId: number, title: string, tasks: string[], options: { othersCanComplete?: boolean; othersCanAppend?: boolean } = {}): Promise<number | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof title !== 'string' || !title.trim() || title.length > 255 ||
        !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 10 ||
        tasks.some(task => typeof task !== 'string' || !task.trim() || task.length > 255) ||
        (options.othersCanComplete != null && typeof options.othersCanComplete !== 'boolean') ||
        (options.othersCanAppend != null && typeof options.othersCanAppend !== 'boolean')) {
      throw new Error('Invalid Telegram to-do list');
    }
    const peer = await this.storyAlbumPeer(chatId);
    const inputText = (text: string) => new ModernApi.TextWithEntities({ text: text.trim(), entities: [] });
    const todo = new ModernApi.TodoList({
      othersCanAppend: Boolean(options.othersCanAppend), othersCanComplete: Boolean(options.othersCanComplete),
      title: inputText(title),
      list: tasks.map((task, index) => new ModernApi.TodoItem({ id: index + 1, title: inputText(task) })),
    });
    const request = new Api.messages.SendMedia({
      peer: peer as any, media: new ModernApi.InputMediaTodo({ todo }) as any, message: '',
      randomId: randomBytes(8).readBigInt64LE() as any,
    });
    const result = await this.client.invoke(request);
    const sent = await (this.client as any)._getResponseMessage?.(request, result, peer);
    if (Number.isSafeInteger(Number(sent?.id)) && Number(sent.id) > 0) return Number(sent.id);
    const updates = (result as any)?.updates || [];
    const update = updates.find((entry: any) => entry?.className === 'UpdateMessageID') ||
      updates.find((entry: any) => entry?.message?.id != null) || updates.find((entry: any) => typeof entry?.id === 'number');
    const id = Number(update?.message?.id ?? update?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  async toggleTodoTask(chatId: number, messageId: number, taskId: number, completed: boolean): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !Number.isSafeInteger(taskId) || taskId < 1 || typeof completed !== 'boolean') throw new Error('Invalid Telegram to-do task');
    const messages = await this.client.getMessages(this.resolvePeer(chatId), { ids: [messageId] });
    const message: any = messages?.[0];
    const media = message?.media;
    if (media?.className !== 'MessageMediaToDo' || !media.todo?.list?.some((item: any) => Number(item.id) === taskId)) {
      throw new Error('Telegram to-do task was not found');
    }
    if (message.fwdFrom || (!message.out && !media.todo.othersCanComplete)) throw new Error('This Telegram to-do list is read-only');
    await this.client.invoke(new ModernApi.messages.ToggleTodoCompleted({
      peer: await this.storyAlbumPeer(chatId), msgId: messageId,
      completed: completed ? [taskId] : [], incompleted: completed ? [] : [taskId],
    }) as any);
  }

  async appendTodoTasks(chatId: number, messageId: number, tasks: string[]): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 10 ||
        tasks.some(task => typeof task !== 'string' || !task.trim() || task.length > 255)) throw new Error('Invalid Telegram to-do tasks');
    const messages = await this.client.getMessages(this.resolvePeer(chatId), { ids: [messageId] });
    const message: any = messages?.[0];
    const media = message?.media;
    if (media?.className !== 'MessageMediaToDo') throw new Error('Telegram to-do list was not found');
    if (message.fwdFrom || (!message.out && !media.todo?.othersCanAppend)) throw new Error('This Telegram to-do list does not allow adding tasks');
    const current = Array.isArray(media.todo?.list) ? media.todo.list : [];
    if (current.length + tasks.length > 10) throw new Error('Telegram to-do lists support up to 10 tasks');
    const firstId = current.reduce((max: number, item: any) => Math.max(max, Number(item?.id) || 0), 0) + 1;
    await this.client.invoke(new ModernApi.messages.AppendTodoList({
      peer: await this.storyAlbumPeer(chatId), msgId: messageId,
      list: tasks.map((task, index) => new ModernApi.TodoItem({
        id: firstId + index, title: new ModernApi.TextWithEntities({ text: task.trim(), entities: [] }),
      })),
    }) as any);
  }

  async editTodoList(chatId: number, messageId: number, title: string,
    tasks: Array<{ id?: number; title: string }>, options: { othersCanComplete?: boolean; othersCanAppend?: boolean } = {}): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof title !== 'string' || !title.trim() || title.length > 255 || !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 10 ||
        tasks.some(task => !task || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 255 ||
          (task.id != null && (!Number.isSafeInteger(task.id) || task.id < 1))) ||
        (options.othersCanComplete != null && typeof options.othersCanComplete !== 'boolean') ||
        (options.othersCanAppend != null && typeof options.othersCanAppend !== 'boolean')) throw new Error('Invalid Telegram to-do list edit');
    const messages = await this.client.getMessages(this.resolvePeer(chatId), { ids: [messageId] });
    const message: any = messages?.[0];
    const media = message?.media;
    if (!message?.out || message.fwdFrom || media?.className !== 'MessageMediaToDo') throw new Error('Telegram to-do list is not editable by this account');
    const current = Array.isArray(media.todo?.list) ? media.todo.list : [];
    const existingIds = new Set<number>(current.map((item: any) => Number(item.id)));
    const usedIds = new Set<number>();
    let nextId = Math.max(0, ...existingIds) + 1;
    const list = tasks.map(task => {
      let id = task.id;
      if (id != null) {
        if (!existingIds.has(id) || usedIds.has(id)) throw new Error('Telegram to-do item ID is stale or duplicated');
      } else {
        while (existingIds.has(nextId) || usedIds.has(nextId)) nextId++;
        id = nextId++;
      }
      usedIds.add(id);
      return new ModernApi.TodoItem({ id, title: new ModernApi.TextWithEntities({ text: task.title.trim(), entities: [] }) });
    });
    const todo = new ModernApi.TodoList({
      othersCanAppend: options.othersCanAppend ?? Boolean(media.todo.othersCanAppend),
      othersCanComplete: options.othersCanComplete ?? Boolean(media.todo.othersCanComplete),
      title: new ModernApi.TextWithEntities({ text: title.trim(), entities: [] }), list,
    });
    await this.client.invoke(new Api.messages.EditMessage({
      peer: await this.storyAlbumPeer(chatId) as any, id: messageId, media: new ModernApi.InputMediaTodo({ todo }) as any,
    }));
  }

  async sendVote(chatId: number, messageId: number, optionIndexes: number[]): Promise<void> {
    const peer = this.resolvePeer(chatId);
    // Telegram option IDs are opaque bytes, not necessarily array indexes.
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    const answers = message?.poll?.answers || message?.media?.poll?.answers;
    if (!Array.isArray(answers)) throw new Error('无法读取投票选项');
    const options = optionIndexes.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= answers.length || !answers[index]?.option) {
        throw new Error('无效的投票选项');
      }
      return Buffer.from(answers[index].option);
    });
    await this.client.invoke(
      new Api.messages.SendVote({
        peer,
        msgId: messageId,
        options,
      }),
    );
  }

  async getPollVotes(chatId: number, messageId: number, optionIndex: number, offset?: string, limit = 50): Promise<{
    count: number; voters: Array<{ user: UserRef; date: number }>; nextOffset?: string;
  }> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !Number.isSafeInteger(optionIndex) || optionIndex < 0 || (offset !== undefined && (offset.length > 256 || /[\u0000-\u001f]/.test(offset)))) {
      throw new Error('Invalid poll voter request');
    }
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    const poll = message?.poll || message?.media?.poll;
    const answers = poll?.answers;
    if (!poll || poll.publicVoters !== true) throw new Error('此投票未公开投票者');
    if (!Array.isArray(answers) || optionIndex >= answers.length || !answers[optionIndex]?.option) throw new Error('Invalid poll option');
    const result = await this.client.invoke(new Api.messages.GetPollVotes({
      peer, id: messageId, option: Buffer.from(answers[optionIndex].option), offset,
      limit: Math.max(1, Math.min(100, Math.trunc(limit) || 50)),
    }));
    const raw = result as Api.messages.VotesList;
    const users = new Map<number, UserRef>();
    for (const entity of raw.users || []) {
      const user = userFromEntity(entity as any);
      if (user) users.set(user.id, user);
    }
    const voters: Array<{ user: UserRef; date: number }> = [];
    for (const vote of raw.votes || []) {
      const peerUserId = (vote as any).peer?.userId;
      const userId = peerUserId == null ? undefined : Number(peerUserId.toString ? peerUserId.toString() : peerUserId);
      const user = userId === undefined ? undefined : users.get(userId);
      if (user) voters.push({ user, date: Number((vote as any).date) || 0 });
    }
    return { count: Number(raw.count) || 0, voters, nextOffset: raw.nextOffset || undefined };
  }

  async closePoll(chatId: number, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('Invalid poll close request');
    }
    const peer = this.resolvePeer(chatId);
    const messages = await this.client.getMessages(peer, { ids: [messageId] });
    const message = messages[0] as any;
    const poll = message?.poll || message?.media?.poll;
    if (!poll || !Array.isArray(poll.answers) || !poll.question || !poll.id) throw new Error('无法读取投票');
    if (poll.closed) return;
    const closedPoll = new Api.Poll({
      id: poll.id,
      closed: true,
      publicVoters: Boolean(poll.publicVoters),
      multipleChoice: Boolean(poll.multipleChoice),
      quiz: Boolean(poll.quiz),
      question: poll.question,
      answers: poll.answers,
    });
    await this.client.invoke(new Api.messages.EditMessage({
      peer,
      id: messageId,
      media: new Api.InputMediaPoll({
        poll: closedPoll,
        solution: message?.media?.solution ?? message?.media?.results?.solution,
        solutionEntities: message?.media?.solutionEntities ?? message?.media?.results?.solutionEntities,
      }),
    }));
  }

  async getQuickReplies(): Promise<Array<{ shortcutId: number; shortcut: string; count: number }>> {
    const result = await this.client.invoke(new Api.messages.GetQuickReplies({ hash: BigInt(0) as any })) as any;
    return (result?.quickReplies || []).filter((item: any) => Number.isSafeInteger(item?.shortcutId) && item.shortcutId > 0)
      .map((item: any) => ({ shortcutId: item.shortcutId, shortcut: String(item.shortcut || ''), count: Number(item.count) || 0 }));
  }

  async getQuickReplyMessages(shortcutId: number): Promise<Array<{ id: number; text: string; date: number; hasMedia: boolean; editable: boolean }>> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0) throw new Error('Invalid quick reply shortcut');
    const result = await this.client.invoke(new Api.messages.GetQuickReplyMessages({ shortcutId, hash: BigInt(0) as any })) as any;
    return (result?.messages || []).filter((message: any) => Number.isSafeInteger(message?.id) && message.id > 0)
      .map((message: any) => {
        const text = String(message.message || '');
        const hasMedia = Boolean(message.media);
        return { id: Number(message.id), text, date: (Number(message.date) || 0) * 1000, hasMedia, editable: Boolean(text) };
      });
  }

  async addQuickReplyMedia(shortcutId: number, uploadPath: string, fileName: string, mimeType: string, caption = ''): Promise<void> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || typeof caption !== 'string' || caption.length > 1024) {
      throw new Error('Invalid quick reply media');
    }
    const media = await this.createQuickReplyInputMedia(uploadPath, fileName, mimeType);
    await this.client.invoke(new Api.messages.SendMedia({
      peer: new Api.InputPeerSelf(), media, message: caption,
      randomId: randomBytes(8).readBigInt64LE() as any,
      quickReplyShortcut: new Api.InputQuickReplyShortcutId({ shortcutId }),
    }));
  }

  async replaceQuickReplyMedia(shortcutId: number, messageId: number, uploadPath: string, fileName: string, mimeType: string, caption = ''): Promise<void> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof caption !== 'string' || caption.length > 1024) throw new Error('Invalid quick reply media replacement');
    const media = await this.createQuickReplyInputMedia(uploadPath, fileName, mimeType);
    await this.client.invoke(new Api.messages.EditMessage({
      peer: new Api.InputPeerSelf(), id: messageId, media, message: caption, entities: [], quickReplyShortcutId: shortcutId,
    }));
  }

  private async createQuickReplyInputMedia(uploadPath: string, fileName: string, mimeType: string) {
    const name = path.basename(String(fileName || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(-200);
    const mime = String(mimeType || 'application/octet-stream').trim().toLowerCase();
    if (typeof uploadPath !== 'string' || !uploadPath || !name || !/^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/.test(mime)) {
      throw new Error('Invalid quick reply media');
    }
    const stat = fs.statSync(uploadPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) throw new Error('Invalid quick reply media file');
    const file = await this.client.uploadFile({ file: new CustomFile(name, stat.size, uploadPath), workers: 1 });
    if (/^image\/(jpeg|png|webp)$/.test(mime)) return new Api.InputMediaUploadedPhoto({ file });
    return new Api.InputMediaUploadedDocument({
      file, mimeType: mime, attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
    });
  }

  async createQuickReply(shortcut: string, text: string): Promise<void> {
    const name = shortcut.trim();
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(name) || typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Invalid quick reply content');
    }
    const canAdd = await this.client.invoke(new Api.messages.CheckQuickReplyShortcut({ shortcut: name }));
    if (canAdd === false) throw new Error('Telegram 当前不允许创建快捷回复');
    await this.client.invoke(new Api.messages.SendMessage({
      peer: new Api.InputPeerSelf(), message: text, randomId: randomBytes(8).readBigInt64LE() as any,
      quickReplyShortcut: new Api.InputQuickReplyShortcut({ shortcut: name }),
    }));
  }

  async addQuickReplyMessage(shortcutId: number, text: string): Promise<void> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || typeof text !== 'string' || !text.trim() || text.length > 4096) {
      throw new Error('Invalid quick reply content');
    }
    await this.client.invoke(new Api.messages.SendMessage({
      peer: new Api.InputPeerSelf(), message: text, randomId: randomBytes(8).readBigInt64LE() as any,
      quickReplyShortcut: new Api.InputQuickReplyShortcutId({ shortcutId }),
    }));
  }

  async editQuickReplyMessage(shortcutId: number, messageId: number, text: string): Promise<void> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof text !== 'string' || text.length > 4096) throw new Error('Invalid quick reply edit request');
    await this.client.invoke(new Api.messages.EditMessage({
      peer: new Api.InputPeerSelf(), id: messageId, message: text, quickReplyShortcutId: shortcutId, entities: [],
    }));
  }

  async deleteQuickReplyMessages(shortcutId: number, messageIds: number[]): Promise<void> {
    const ids = [...new Set(messageIds)];
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid quick reply delete request');
    await this.client.invoke(new Api.messages.DeleteQuickReplyMessages({ shortcutId, id: ids }));
  }

  async sendQuickReply(chatId: number, shortcutId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(shortcutId) || shortcutId <= 0) {
      throw new Error('Invalid quick reply request');
    }
    const result = await this.client.invoke(new Api.messages.GetQuickReplyMessages({ shortcutId, hash: BigInt(0) as any })) as any;
    const ids = [...new Set<number>((result?.messages || []).map((message: any) => Number(message?.id))
      .filter((id: number) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) throw new Error('此快捷回复没有可发送的消息');
    await this.client.invoke(new Api.messages.SendQuickReplyMessages({
      peer: this.resolvePeer(chatId), shortcutId, id: ids,
      randomId: ids.map(() => randomBytes(8).readBigInt64LE()) as any,
    }));
  }

  async renameQuickReply(shortcutId: number, shortcut: string): Promise<void> {
    const name = shortcut.trim();
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0 || !/^[a-zA-Z0-9_]{1,32}$/.test(name)) {
      throw new Error('Invalid quick reply shortcut');
    }
    const updated = await this.client.invoke(new Api.messages.EditQuickReplyShortcut({ shortcutId, shortcut: name }));
    if (updated === false) throw new Error('Telegram 未能更新快捷回复名称');
  }

  async deleteQuickReply(shortcutId: number): Promise<void> {
    if (!Number.isSafeInteger(shortcutId) || shortcutId <= 0) throw new Error('Invalid quick reply shortcut');
    const deleted = await this.client.invoke(new Api.messages.DeleteQuickReplyShortcut({ shortcutId }));
    if (deleted === false) throw new Error('Telegram 未能删除快捷回复');
  }

  async getScheduledMessages(chatId: number): Promise<Array<{ id: number; date: number; text: string; scheduleRepeatPeriod?: number }>> {
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('Invalid scheduled messages request');
    const result = await this.client.invoke(new ModernApi.messages.GetScheduledHistory({
      peer: this.resolvePeer(chatId), hash: bigInt.zero,
    } as any) as any) as any;
    return (result?.messages || []).filter((message: any) => Number.isSafeInteger(message?.id) && message.id > 0)
      .map((message: any) => ({
        id: Number(message.id), date: (Number(message.date) || 0) * 1000,
        ...(Number.isSafeInteger(message.scheduleRepeatPeriod) && message.scheduleRepeatPeriod > 0
          ? { scheduleRepeatPeriod: Number(message.scheduleRepeatPeriod) } : {}),
        text: String(message.message || formatDialogMessageSnippet(message) || '[计划消息]'),
      }));
  }

  async sendScheduledMessageNow(chatId: number, messageIds: number[]): Promise<void> {
    const ids = [...new Set(messageIds)];
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid scheduled message request');
    await this.client.invoke(new Api.messages.SendScheduledMessages({ peer: this.resolvePeer(chatId), id: ids }));
  }

  async deleteScheduledMessages(chatId: number, messageIds: number[]): Promise<void> {
    const ids = [...new Set(messageIds)];
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !ids.length || ids.length > 100 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid scheduled message request');
    await this.client.invoke(new Api.messages.DeleteScheduledMessages({ peer: this.resolvePeer(chatId), id: ids }));
  }

  async editScheduledMessage(
    chatId: number,
    messageId: number,
    text: string,
    scheduleOptions?: { parseMode?: SendOptions['parseMode']; schedule?: number; scheduleRepeatPeriod?: number | null },
  ): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        typeof text !== 'string' || text.length > 4096 ||
        (scheduleOptions?.schedule != null && (!Number.isSafeInteger(scheduleOptions.schedule) || scheduleOptions.schedule <= Math.floor(Date.now() / 1000))) ||
        (scheduleOptions?.scheduleRepeatPeriod != null && (!scheduleOptions.schedule ||
          !isTelegramScheduleRepeatPeriod(scheduleOptions.scheduleRepeatPeriod)))) {
      throw new Error('Invalid scheduled message edit request');
    }
    const peer = this.resolvePeer(chatId);
    const result = await this.client.invoke(new ModernApi.messages.GetScheduledMessages({ peer, id: [messageId] } as any) as any) as any;
    const message = (result?.messages || []).find((item: any) => Number(item?.id) === messageId);
    if (!message || !Number.isSafeInteger(message.date) || message.date <= 0) throw new Error('无法读取计划消息的发送时间');
    const schedule = scheduleOptions?.schedule ?? message.date;
    const repeatPeriod = scheduleOptions?.scheduleRepeatPeriod === undefined
      ? message.scheduleRepeatPeriod : scheduleOptions.scheduleRepeatPeriod;
    const formatted = prepareText(text, scheduleOptions?.parseMode ?? 'plain');
    const [messageText, entities] = await _parseMessageText(this.client, formatted.text, formatted.parseMode);
    await this.client.invoke(new ModernApi.messages.EditMessage({
      peer, id: messageId, message: String(messageText), entities, scheduleDate: schedule,
      ...(Number.isSafeInteger(repeatPeriod) && repeatPeriod > 0 ? { scheduleRepeatPeriod: repeatPeriod } : {}),
    } as any) as any);
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

  private mapStickerDocument(document: any): StickerItem | undefined {
    if (!(document instanceof Api.Document) || !document.accessHash) return undefined;
    const attributes: any[] = document.attributes || [];
    const sticker = attributes.find((attribute: any) => attribute?.className === 'DocumentAttributeSticker');
    if (!sticker) return undefined;
    const dimensions = attributes.find((attribute: any) => attribute?.className === 'DocumentAttributeImageSize');
    let thumbDataUri: string | undefined;
    const stripped: any = (document.thumbs || []).find((item: any) => item?.className === 'PhotoStrippedSize');
    if (stripped?.bytes) {
      try {
        const jpg = strippedPhotoToJpg(stripped.bytes);
        if (jpg?.length) thumbDataUri = `data:image/jpeg;base64,${Buffer.from(jpg).toString('base64')}`;
      } catch { /* The account-isolated thumbnail endpoint loads the image on demand. */ }
    }
    return {
      id: String(document.id), accessHash: String(document.accessHash),
      fileReference: document.fileReference ? Buffer.from(document.fileReference).toString('base64') : '',
      mimeType: String(document.mimeType || 'image/webp'), emoji: String(sticker.alt || '✨'),
      width: Number(dimensions?.w) || undefined, height: Number(dimensions?.h) || undefined, thumbDataUri,
    };
  }

  async getStickerCollections(): Promise<{ favorites: StickerItem[]; recent: StickerItem[] }> {
    const [favoritesResponse, recentResponse] = await Promise.all([
      this.client.invoke(new Api.messages.GetFavedStickers({ hash: BigInt(0) as any })) as Promise<any>,
      this.client.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) as any, attached: false })) as Promise<any>,
    ]);
    const map = (response: any) => (response?.stickers || []).flatMap((document: any) => {
      const sticker = this.mapStickerDocument(document);
      return sticker ? [sticker] : [];
    }).slice(0, 200);
    return {
      favorites: favoritesResponse instanceof Api.messages.FavedStickers ? map(favoritesResponse) : [],
      recent: recentResponse instanceof Api.messages.RecentStickers ? map(recentResponse) : [],
    };
  }

  async setStickerFavorite(docId: string, accessHash: string, fileRefBase64: string, favorite: boolean): Promise<void> {
    if (typeof docId !== 'string' || !/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) ||
        typeof accessHash !== 'string' || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) ||
        typeof fileRefBase64 !== 'string' || fileRefBase64.length > 8192 || typeof favorite !== 'boolean') {
      throw new Error('Invalid sticker favorite request');
    }
    const id = BigInt(docId), hash = BigInt(accessHash);
    if (id > 9223372036854775807n || hash < -9223372036854775808n || hash > 9223372036854775807n) {
      throw new Error('Invalid sticker favorite request');
    }
    const result = await this.client.invoke(new Api.messages.FaveSticker({
      id: new Api.InputDocument({ id: id as any, accessHash: hash as any,
        fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0) }),
      unfave: !favorite,
    }));
    if (result === false) throw new Error('Telegram 未确认贴纸收藏状态');
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

  async searchStickers(query: string, offset = 0, limit = 40): Promise<StickerSearchPage> {
    const normalized = typeof query === 'string' ? query.trim() : '';
    if (!normalized || normalized.length > 128 || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid Telegram sticker search');
    const response = await this.client.invoke(new Api.messages.SearchStickers({
      q: normalized, emoticon: '', langCode: ['en'], offset, limit, hash: BigInt(0) as any, emojis: false,
    })) as any;
    const stickers: StickerItem[] = (response?.stickers || []).flatMap((document: any) => {
      if (!(document instanceof Api.Document) || !document.accessHash) return [];
      const attributes: any[] = document.attributes || [];
      const sticker = attributes.find((attribute: any) => attribute?.className === 'DocumentAttributeSticker');
      if (!sticker) return [];
      const dimensions = attributes.find((attribute: any) => attribute?.className === 'DocumentAttributeImageSize');
      let thumbDataUri: string | undefined;
      const thumbs: any[] = document.thumbs || [];
      const stripped = thumbs.find((item: any) => item?.className === 'PhotoStrippedSize');
      if (stripped?.bytes) {
        try {
          const jpg = strippedPhotoToJpg(stripped.bytes);
          if (jpg?.length) thumbDataUri = `data:image/jpeg;base64,${Buffer.from(jpg).toString('base64')}`;
        } catch { /* load the Telegram thumbnail on demand */ }
      }
      return [{
        id: String(document.id), accessHash: String(document.accessHash),
        fileReference: document.fileReference ? Buffer.from(document.fileReference).toString('base64') : '',
        mimeType: String(document.mimeType || 'image/webp'), emoji: String(sticker.alt || '✨'),
        width: Number(dimensions?.w) || undefined, height: Number(dimensions?.h) || undefined, thumbDataUri,
      }];
    });
    const nextOffset = Number(response?.nextOffset);
    return { stickers, ...(Number.isSafeInteger(nextOffset) && nextOffset > offset ? { nextOffset } : {}) };
  }

  async searchCustomEmoji(emoticon: string): Promise<{ id: string; emoji: string }[]> {
    if (!isSingleEmoji(emoticon)) {
      throw new Error('Invalid custom emoji search');
    }
    const result = await this.client.invoke(new Api.messages.SearchCustomEmoji({ emoticon, hash: BigInt(0) as any })) as any;
    if (!(result instanceof Api.EmojiList) || !Array.isArray(result.documentId) || !result.documentId.length) return [];
    const ids = result.documentId.slice(0, 24).map((id: any) => BigInt(id.toString()) as any);
    const documents = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: ids })) as any[];
    return (documents || []).flatMap((document: any) => {
      if (!(document instanceof Api.Document) || !document.accessHash) return [];
      const attribute: any = (document.attributes || []).find((item: any) => item?.className === 'DocumentAttributeCustomEmoji');
      if (!attribute) return [];
      return [{ id: String(document.id), emoji: String(attribute.alt || emoticon).slice(0, 32) }];
    });
  }

  private async loadEmojiKeywordIndex(langCode: string): Promise<Array<{ keyword: string; emoticons: string[] }>> {
    const now = Date.now();
    const cached = this.emojiKeywordIndexes.get(langCode);
    if (cached && cached.expiresAt > now) return cached.entries;
    const pending = this.emojiKeywordLoads.get(langCode);
    if (pending) return pending;
    const epoch = this.emojiKeywordEpoch;
    const load = (async () => {
      const response = await this.client.invoke(new Api.messages.GetEmojiKeywords({ langCode })) as any;
      if (!(response instanceof Api.EmojiKeywordsDifference) || !Array.isArray(response.keywords)) {
        throw new Error('Telegram returned invalid Emoji keywords');
      }
      const entries = response.keywords.flatMap((entry: any) => {
        if (!(entry instanceof Api.EmojiKeyword) || typeof entry.keyword !== 'string' || !entry.keyword.trim() ||
            entry.keyword.length > 128 || !Array.isArray(entry.emoticons)) return [];
        const emoticons = [...new Set(entry.emoticons.filter((value: unknown): value is string => isSingleEmoji(value)))].slice(0, 32);
        return emoticons.length ? [{ keyword: entry.keyword.normalize('NFKC').trim().toLowerCase(), emoticons }] : [];
      }).slice(0, 20_000);
      if (epoch !== this.emojiKeywordEpoch) throw new Error('Telegram account stopped during Emoji search');
      this.emojiKeywordIndexes.set(langCode, { expiresAt: Date.now() + 12 * 60 * 60_000, entries });
      return entries;
    })();
    this.emojiKeywordLoads.set(langCode, load);
    try { return await load; }
    finally { if (this.emojiKeywordLoads.get(langCode) === load) this.emojiKeywordLoads.delete(langCode); }
  }

  async searchEmojiKeywords(query: string): Promise<string[]> {
    const cleaned = typeof query === 'string' ? query.normalize('NFKC').trim().toLowerCase() : '';
    if (!cleaned || cleaned.length > 64 || /[\u0000-\u001f]/.test(cleaned)) throw new Error('Invalid Emoji search');
    const responses = await Promise.allSettled(['zh-hans', 'en-us'].map(lang => this.loadEmojiKeywordIndex(lang)));
    const indexes = responses.flatMap((response, index) => {
      if (response.status === 'fulfilled') return [response.value];
      this.logger.debug({ langCode: ['zh-hans', 'en-us'][index], error: response.reason?.message }, 'Telegram Emoji keyword pack unavailable');
      return [];
    });
    if (!indexes.length) throw new Error('Telegram Emoji keyword search is unavailable');
    const ranked = new Map<string, number>();
    for (const entries of indexes) {
      for (const entry of entries) {
        if (!entry.keyword.includes(cleaned)) continue;
        const rank = entry.keyword === cleaned ? 0 : entry.keyword.startsWith(cleaned) ? 1 : 2;
        for (const emoji of entry.emoticons) {
          const previous = ranked.get(emoji);
          if (previous === undefined || rank < previous) ranked.set(emoji, rank);
        }
      }
    }
    return [...ranked].sort((left, right) => left[1] - right[1]).slice(0, 80).map(([emoji]) => emoji);
  }

  async getEmojiGroups(): Promise<Array<{ title: string; emoticons: string[] }>> {
    if (this.emojiGroupsCache && this.emojiGroupsCache.expiresAt > Date.now()) return this.emojiGroupsCache.groups;
    if (this.emojiGroupsLoad) return this.emojiGroupsLoad;
    const epoch = this.emojiKeywordEpoch;
    const load = (async () => {
      const response = await this.client.invoke(new Api.messages.GetEmojiGroups({ hash: 0 })) as any;
      if (!(response instanceof Api.messages.EmojiGroups) || !Array.isArray(response.groups)) return [];
      const groups = response.groups.flatMap((group: any) => {
        if (!(group instanceof Api.EmojiGroup || group instanceof Api.EmojiGroupGreeting) ||
            typeof group.title !== 'string' || !group.title.trim() || !Array.isArray(group.emoticons)) return [];
        const emoticons = [...new Set(group.emoticons.filter((value: unknown): value is string => isSingleEmoji(value)))].slice(0, 400);
        return emoticons.length ? [{ title: group.title.slice(0, 80), emoticons }] : [];
      }).slice(0, 24);
      if (epoch !== this.emojiKeywordEpoch) throw new Error('Telegram account stopped during Emoji catalog load');
      this.emojiGroupsCache = { expiresAt: Date.now() + 12 * 60 * 60_000, groups };
      return groups;
    })();
    this.emojiGroupsLoad = load;
    try { return await load; }
    finally { if (this.emojiGroupsLoad === load) this.emojiGroupsLoad = undefined; }
  }

  async sendCustomEmoji(chatId: number, emoticon: string, documentId: string): Promise<number | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !isSingleEmoji(emoticon) ||
        !/^\d{1,20}$/.test(documentId) || /^0+$/.test(documentId)) {
      throw new Error('Invalid custom emoji message');
    }
    const sent = await this.client.sendMessage(this.resolvePeer(chatId), {
      message: emoticon,
      parseMode: false,
      formattingEntities: [new Api.MessageEntityCustomEmoji({ offset: 0, length: emoticon.length, documentId: BigInt(documentId) as any })],
    });
    return (sent as any)?.id;
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
    if (!/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) || !this.selfId) return undefined;
    const hash = BigInt(accessHash);
    if (hash < -9223372036854775808n || hash > 9223372036854775807n) return undefined;
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const destPath = path.resolve('data', 'cache', 'stickers', `${namespace}_${docId}.webp`);
    const location = new Api.InputDocumentFileLocation({
      id: BigInt(docId) as any,
      accessHash: hash as any,
      fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0),
      thumbSize: '',
    });
    try {
      const downloaded = await downloadMediaToCache(destPath, temporaryPath =>
        withAwaitedFileWriter(temporaryPath, writer => this.client.downloadFile(location as any, { outputFile: writer as any })));
      return downloaded ? destPath : undefined;
    } catch (err: any) {
      this.logger.warn({ docId, error: err.message }, 'Failed to download sticker thumb');
      return undefined;
    }
  }

  async downloadCustomEmojiPreview(documentId: string): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!/^\d{1,20}$/.test(documentId) || /^0+$/.test(documentId) || !this.selfId) throw new Error('Invalid custom emoji document');
    const response = await this.client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: [BigInt(documentId) as any] })) as any;
    const document = (response || []).find((item: any) => item?.className === 'Document' && String(item.id) === documentId);
    if (!document?.accessHash) return undefined;
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const targetPath = path.resolve('data', 'cache', 'custom-emoji', `${namespace}_${documentId}.webp`);
    const fileReference = document.fileReference ? Buffer.from(document.fileReference) : Buffer.alloc(0);
    const photoThumbs = (document.thumbs || []).filter((thumb: any) =>
      ['PhotoSize', 'PhotoSizeProgressive'].includes(thumb?.className) && typeof thumb.type === 'string');
    const thumb = photoThumbs.find((item: any) => item.type === 'm') || photoThumbs[0];
    const downloaded = await downloadMediaToCache(targetPath, temporaryPath => withAwaitedFileWriter(temporaryPath, writer => {
      if (thumb) {
        const location = new Api.InputDocumentFileLocation({
          id: document.id, accessHash: document.accessHash, fileReference, thumbSize: thumb.type,
        });
        return this.client.downloadFile(location as any, { outputFile: writer as any });
      }
      if (!['image/webp', 'image/png', 'image/jpeg'].includes(String(document.mimeType || ''))) return Promise.resolve(undefined);
      return this.client.downloadMedia(document, { outputFile: writer as any });
    }));
    return downloaded ? { filePath: targetPath, mimeType: 'image/webp' } : undefined;
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

  async searchInlineGifs(chatId: number, query: string, offset = ''): Promise<{
    results: Array<{ token: string; saveToken: string; title: string; id: string; accessHash: string; fileReference: string; mimeType: string;
      duration?: number; width?: number; height?: number }>;
    nextOffset: string;
  }> {
    const cleanedQuery = typeof query === 'string' ? query.trim() : '';
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !cleanedQuery || cleanedQuery.length > 128 ||
        typeof offset !== 'string' || offset.length > 512) throw new Error('Invalid GIF search request');
    let bot = this.gifInlineBot;
    if (!bot) {
      const resolved = await this.client.invoke(new Api.contacts.ResolveUsername({ username: 'gif' })) as any;
      const entity = (resolved?.users || []).find((user: any) => (user instanceof Api.User || user?.className === 'User') && user.bot && user.accessHash);
      if (!entity) throw new Error('Telegram 的 GIF 搜索机器人不可用');
      bot = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
      this.gifInlineBot = bot;
    }
    const response = await this.client.invoke(new Api.messages.GetInlineBotResults({
      bot, peer: this.resolvePeer(chatId), query: cleanedQuery, offset,
    })) as any;
    if (!(response instanceof Api.messages.BotResults)) throw new Error('Telegram returned invalid GIF search results');
    const now = Date.now();
    for (const [token, pending] of this.pendingInlineGifs) if (pending.expiresAt <= now) this.pendingInlineGifs.delete(token);
    const results = (response.results || []).flatMap((item: any) => {
      if (!(item instanceof Api.BotInlineMediaResult) || !(item.document instanceof Api.Document) || typeof item.id !== 'string' || !item.id) return [];
      const doc = item.document;
      const mimeType = String(doc.mimeType || '').toLowerCase();
      if (!['video/mp4', 'video/webm'].includes(mimeType)) return [];
      const accessHash = String(doc.accessHash ?? '');
      const id = String(doc.id ?? '');
      if (!/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) || !/^\d{1,20}$/.test(id) || /^0+$/.test(id)) return [];
      const token = randomBytes(24).toString('base64url');
      const saveToken = randomBytes(24).toString('base64url');
      const queryId = BigInt(response.queryId.toString());
      const capability = { chatId, queryId, resultId: item.id, docId: id, accessHash, fileReference: doc.fileReference ? Buffer.from(doc.fileReference).toString('base64') : '', expiresAt: now + 5 * 60_000 };
      this.pendingInlineGifs.set(token, { ...capability, action: 'send' });
      this.pendingInlineGifs.set(saveToken, { ...capability, action: 'save' });
      const video: any = (doc.attributes || []).find((attribute: any) => attribute?.className === 'DocumentAttributeVideo');
      return [{
        token, saveToken, title: String(item.title || item.description || 'GIF').slice(0, 128), id, accessHash,
        fileReference: doc.fileReference ? Buffer.from(doc.fileReference).toString('base64') : '', mimeType,
        duration: video?.duration, width: video?.w, height: video?.h,
      }];
    }).slice(0, 30);
    while (this.pendingInlineGifs.size > 200) this.pendingInlineGifs.delete(this.pendingInlineGifs.keys().next().value!);
    return { results, nextOffset: typeof response.nextOffset === 'string' ? response.nextOffset : '' };
  }

  async sendInlineGif(chatId: number, token: string, replyTo?: number, topMsgId?: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) ||
        (replyTo != null && (!Number.isSafeInteger(replyTo) || replyTo <= 0)) ||
        (topMsgId != null && (!Number.isSafeInteger(topMsgId) || topMsgId <= 0 || chatId >= 0))) throw new Error('Invalid GIF send request');
    const pending = this.pendingInlineGifs.get(token);
    if (!pending || pending.action !== 'send' || pending.expiresAt <= Date.now() || pending.chatId !== chatId) throw new Error('GIF search result expired or belongs to another chat');
    this.pendingInlineGifs.delete(token);
    await this.client.invoke(new Api.messages.SendInlineBotResult({
      peer: this.resolvePeer(chatId), queryId: pending.queryId as any, id: pending.resultId,
      randomId: BigInt(`0x${randomBytes(8).toString('hex')}`) as any, clearDraft: true,
      ...(replyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: replyTo, ...(topMsgId ? { topMsgId } : {}) }) } : {}),
    }));
  }

  async saveInlineGif(chatId: number, token: string): Promise<boolean> {
    if (!Number.isSafeInteger(chatId) || chatId === 0 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
      throw new Error('Invalid GIF save request');
    }
    const pending = this.pendingInlineGifs.get(token);
    if (!pending || pending.action !== 'save' || pending.expiresAt <= Date.now() || pending.chatId !== chatId) {
      throw new Error('GIF search result expired or belongs to another chat');
    }
    if (pending.saved) return true;
    const saved = await this.saveGifDocument(pending.docId, pending.accessHash, pending.fileReference, false);
    pending.saved = saved;
    return saved;
  }

  async saveGifDocument(docId: string, accessHash: string, fileRefBase64: string, unsave = false): Promise<boolean> {
    if (!/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash) ||
        typeof fileRefBase64 !== 'string' || fileRefBase64.length > 4096 || typeof unsave !== 'boolean') throw new Error('Invalid GIF document');
    const hash = BigInt(accessHash);
    if (hash < -(1n << 63n) || hash > (1n << 63n) - 1n) throw new Error('Invalid GIF document');
    const result = await this.client.invoke(new Api.messages.SaveGif({
      id: new Api.InputDocument({ id: BigInt(docId) as any, accessHash: hash as any,
        fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0) }),
      unsave,
    }));
    if (result === false) throw new Error('Telegram did not update the saved GIFs');
    return true;
  }

  async downloadGifPreview(docId: string, accessHash: string, fileRefBase64: string, mimeType = 'video/mp4'): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!/^\d{1,20}$/.test(docId) || /^0+$/.test(docId) || !/^-?\d{1,20}$/.test(accessHash) || /^-?0+$/.test(accessHash)) throw new Error('Invalid GIF document');
    const parsedAccessHash = BigInt(accessHash);
    if (parsedAccessHash < -(1n << 63n) || parsedAccessHash > (1n << 63n) - 1n) throw new Error('Invalid GIF document');
    const safeMime = mimeType === 'video/webm' ? 'video/webm' : 'video/mp4';
    if (!this.selfId) throw new Error('Telegram account is not ready');
    const namespace = mediaCacheNamespace(this.config.telegram.sessionPath, this.selfId);
    const extension = safeMime === 'video/webm' ? 'webm' : 'mp4';
    const targetPath = path.resolve('data', 'cache', 'gifs', `${namespace}_${docId}.${extension}`);
    const location = new Api.InputDocumentFileLocation({
      id: BigInt(docId) as any,
      accessHash: parsedAccessHash as any,
      fileReference: fileRefBase64 ? Buffer.from(fileRefBase64, 'base64') : Buffer.alloc(0),
      thumbSize: '',
    });
    const downloaded = await downloadMediaToCache(targetPath, temporaryPath =>
      withAwaitedFileWriter(temporaryPath, writer => this.client.downloadFile(location as any, { outputFile: writer as any })));
    return downloaded ? { filePath: targetPath, mimeType: safeMime } : undefined;
  }

  async sendStickerDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number, topMsgId?: number): Promise<number | undefined> {
    if (topMsgId) await this.assertForumReply(chatId, topMsgId, replyTo || topMsgId);
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
        topMsgId,
      });
      try {
        await this.client.invoke(new Api.messages.SaveRecentSticker({ id: inputDoc, unsave: false }));
      } catch (error: any) {
        this.logger.debug({ docId, error: error?.message }, 'Telegram did not save the sent sticker to recents');
      }
      return (sent as any)?.id;
    } catch (err: any) {
      this.logger.error({ chatId, docId, error: err.message }, 'Failed to send sticker document');
      throw err;
    }
  }

  async sendGifDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number, topMsgId?: number): Promise<number | undefined> {
    if (topMsgId) await this.assertForumReply(chatId, topMsgId, replyTo || topMsgId);
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
        topMsgId,
      });
      return (sent as any)?.id;
    } catch (err: any) {
      this.logger.error({ chatId, docId, error: err.message }, 'Failed to send gif document');
      throw err;
    }
  }
}

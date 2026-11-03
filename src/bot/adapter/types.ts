/**
 * Platform-neutral message / event model.
 * The Telegram driver converts Telegram updates into these shapes so plugins
 * never depend on telegram-gramjs types directly.
 */

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';

export interface UserRef {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot: boolean;
  phone?: string;
}

export interface ChatRef {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  membersCount?: number;
  description?: string;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  userId?: number;
}

export type MediaType = 'photo' | 'video' | 'audio' | 'document' | 'voice' | 'sticker' | 'animation' | 'poll' | 'webpage';

export interface MediaAttachment {
  type: MediaType;
  fileId?: string;
  fileSize?: number;
  duration?: number;
  width?: number;
  height?: number;
  fileName?: string;
  mimeType?: string;
  stickerSetId?: string;
  stickerAccessHash?: string;
  stickerShortName?: string;
  isVideoSticker?: boolean;
  isAnimatedSticker?: boolean;
  stickerEmoji?: string;
  pollId?: string;
  question?: string;
  options?: Array<{
    text: string;
    optionIndex: number;
    voters: number;
    chosen?: boolean;
    correct?: boolean;
    pct: number;
  }>;
  totalVoters?: number;
  closed?: boolean;
  publicVoters?: boolean;
  multipleChoice?: boolean;
  isQuiz?: boolean;
  /** Voice waveform data (0-31 per bar) */
  waveform?: number[];
  /** Webpage link preview */
  webTitle?: string;
  webDescription?: string;
  webUrl?: string;
  webSiteName?: string;
  webPhotoThumb?: boolean;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  chosen?: boolean;
}

export interface ForwardHeader {
  fromName?: string;
  fromId?: number;
  channelTitle?: string;
  channelId?: number;
  postAuthor?: string;
  date?: number;
}

export interface ServiceAction {
  type: string; // 'joined' | 'left' | 'title_changed' | 'photo_changed' | 'pinned' | 'created' | ...
  text: string; // Localized display text
  users?: UserRef[];
}

export interface IncomingMessage {
  id: number;
  text: string;
  raw?: string;
  entities?: MessageEntity[];
  date: number;
  from: UserRef;
  chat: ChatRef;
  outgoing?: boolean;
  isReply?: boolean;
  replyToMessageId?: number;
  mentionedBot?: boolean;
  media?: MediaAttachment;
  reactions?: MessageReaction[];
  fwdFrom?: ForwardHeader;
  views?: number;
  forwards?: number;
  /** Service message (joined/left/title_changed etc.) */
  service?: ServiceAction;
  /** Album/group media group id */
  groupedId?: string;
  /** Whether outgoing message has been read by the other side */
  read?: boolean;
  /** Forum topic id (for supergroups with topics) */
  topicId?: number;
  /** Number of replies/comments (for channel posts) */
  replies?: number;
}

export interface NewChatParticipant {
  user: UserRef;
  inviter?: UserRef;
}

export interface SendOptions {
  parseMode?: 'markdown' | 'html';
  silent?: boolean;
  replyMarkup?: unknown;
  autoDeleteMs?: number;
  replyTo?: number;
  schedule?: number;
}

export interface MediaOptions extends SendOptions {
  caption?: string;
  fileName?: string;
  mimeType?: string;
  thumb?: string | Buffer;
  forceDocument?: boolean;
}

export interface AdminPermissions {
  changeInfo?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  addAdmins?: boolean;
  anonymous?: boolean;
  manageCall?: boolean;
  manageTopics?: boolean;
}

export interface ParticipantInfo {
  user: UserRef;
  role: 'owner' | 'admin' | 'member' | 'banned' | 'left';
  joinedDate?: number;
  kickedBy?: UserRef;
  promotedBy?: UserRef;
  adminPermissions?: AdminPermissions;
}

export interface DialogInfo {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  unreadCount: number;
  lastMessageDate?: number;
  pinned?: boolean;
  lastMessage?: string;
  lastSender?: string;
  isChannel?: boolean;
  /** Whether the user is currently online */
  online?: boolean;
  /** Last seen timestamp (ms) */
  lastSeen?: number;
  /** Highest read incoming message id */
  readInboxMaxId?: number;
  /** Highest read outgoing message id */
  readOutboxMaxId?: number;
  /** Whether the chat is muted */
  muted?: boolean;
  /** Folder id (0 = no folder, 1 = archive) */
  folderId?: number;
  /** Whether the chat is archived */
  archived?: boolean;
}

export interface UserStatus {
  userId: number;
  online: boolean;
  lastSeen?: number;
}

export interface CallbackQuery {
  id: string;
  from: UserRef;
  chat?: ChatRef;
  messageId?: number;
  data?: string;
}

export interface StickerItem {
  id: string;
  accessHash?: string;
  fileReference?: string;
  emoji?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  thumbDataUri?: string;
}

export interface StickerPackSummary {
  id: string;
  accessHash: string;
  title: string;
  shortName: string;
  count: number;
  thumbDocumentId?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
  isInstalled?: boolean;
}

export interface SavedGifItem {
  id: string;
  accessHash: string;
  fileReference: string;
  mimeType: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface StickerSetInfo {
  id: string;
  title: string;
  shortName: string;
  count: number;
  stickers: StickerItem[];
}

export interface UserPhotoEntry {
  id: string;
  date: number;
  width?: number;
  height?: number;
}

export interface StoryEntry {
  id: number;
  date: number;
  expireDate: number;
  caption?: string;
  isPinned?: boolean;
  mediaType?: string;
}

export interface PeerProfileDetails {
  id: number;
  title: string;
  username?: string;
  phone?: string;
  bio?: string;
  type: ChatType;
  memberCount?: number;
  commonChatsCount?: number;
  isVerified?: boolean;
  isPremium?: boolean;
  isBot?: boolean;
  hasPhoto: boolean;
  photosCount: number;
  pinnedMsgId?: number;
  stories?: StoryEntry[];
}

export interface GetMessagesOptions {
  limit?: number;
  offsetId?: number;
  ids?: number[];
  search?: string;
}

export interface BotAdapter {
  /** Connect / login. */
  start(): Promise<void>;

  /** Disconnect cleanly. */
  stop(): Promise<void>;

  /** Send a text reply, returning the resulting message id (or undefined). */
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;

  /** Reply to a specific message. */
  replyTo(chatId: number, replyToMsgId: number, text: string, options?: SendOptions): Promise<number | undefined>;

  /** Edit an existing message. */
  editMessage(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<number | undefined>;

  /** Delete a message. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;

  /** Delete multiple messages in batch. */
  deleteMessages(chatId: number, messageIds: number[]): Promise<void>;

  /** Subscribe to adapter events. Returns an unsubscribe function. */
  on<E extends keyof AdapterEventMap>(event: E, handler: (payload: AdapterEventMap[E]) => void): () => void;

  /** Resolve a user id to a UserRef (best-effort, may be undefined for unsaved users). */
  getUser(id: number): Promise<UserRef | undefined>;

  /** Resolve a chat id to a ChatRef. */
  getChat(id: number): Promise<ChatRef | undefined>;

  /** Get self user info. */
  getSelf(): UserRef | undefined;

  /** Get the underlying raw client — escape hatch for plugin authors. */
  raw<T = unknown>(): T;

  // --- 媒体能力 ---
  sendPhoto(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendVideo(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendAudio(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendFile(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendVoice(chatId: number, file: string | Buffer, options?: MediaOptions): Promise<number | undefined>;
  sendSticker(chatId: number, file: string | Buffer, options?: SendOptions): Promise<number | undefined>;
  downloadMedia(chatId: number, messageId: number, destPath: string): Promise<string | undefined>;
  downloadProfilePhoto(chatId: number, options?: { isBig?: boolean; outputFile?: string }): Promise<string | undefined>;
  getUserPhotos(userId: number, limit?: number): Promise<UserPhotoEntry[]>;
  downloadUserPhoto(userId: number, photoIndex: number, outputFile: string): Promise<string | undefined>;
  getPeerProfile(chatId: number): Promise<PeerProfileDetails>;
  getPeerStories(chatId: number): Promise<StoryEntry[]>;
  getChatMedia(chatId: number, filterType: 'music' | 'photos' | 'videos' | 'files', limit?: number): Promise<IncomingMessage[]>;
  downloadMediaFile(chatId: number, messageId: number, thumb?: boolean, destPath?: string): Promise<{ filePath: string; mimeType: string; fileName?: string } | undefined>;
  sendMedia(chatId: number, file: string | Buffer, mediaType: 'photo' | 'video' | 'audio' | 'document' | 'voice', options?: MediaOptions): Promise<number | undefined>;

  // --- 消息与历史操作 ---
  forwardMessage(fromChatId: number | string, toChatId: number | string, messageId: number): Promise<number | undefined>;
  forwardMessages(fromChatId: number | string, toChatId: number | string, messageIds: number[]): Promise<number[]>;
  pinMessage(chatId: number, messageId: number, silent?: boolean): Promise<void>;
  unpinMessage(chatId: number | string, messageId?: number): Promise<void>;
  getMessages(chatId: number, options?: GetMessagesOptions): Promise<IncomingMessage[]>;
  searchMessages(chatId: number, query: string, limit?: number): Promise<IncomingMessage[]>;
  markAsRead(chatId: number, maxId?: number): Promise<void>;

  // --- 群组与频道管理 ---
  banUser(chatId: number, userId: number, untilDate?: number): Promise<void>;
  unbanUser(chatId: number, userId: number): Promise<void>;
  kickUser(chatId: number, userId: number): Promise<void>;
  muteUser(chatId: number, userId: number, seconds: number): Promise<void>;
  unmuteUser(chatId: number, userId: number): Promise<void>;
  promoteUser(chatId: number, userId: number, perms?: AdminPermissions): Promise<void>;
  demoteUser(chatId: number, userId: number): Promise<void>;
  getParticipants(chatId: number, limit?: number): Promise<ParticipantInfo[]>;
  inviteUser(chatId: number, userId: number): Promise<void>;
  getChatMember(chatId: number, userId: number): Promise<ParticipantInfo | undefined>;
  leaveChat(chatId: number): Promise<void>;
  setChatTitle(chatId: number, title: string): Promise<void>;
  setChatDescription(chatId: number, description: string): Promise<void>;

  // --- 对话与联系人 ---
  getDialogs(limit?: number): Promise<DialogInfo[]>;
  getContacts(): Promise<UserRef[]>;

  // --- 账号自身与交互 ---
  setOnline(online: boolean): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
  updateProfile(opts: { firstName?: string; lastName?: string; bio?: string }): Promise<void>;
  updateProfilePhoto(file: string | Buffer): Promise<void>;
  reactToMessage(chatId: number, messageId: number, emoji?: string): Promise<void>;
  getStickerSet(shortName: string): Promise<StickerSetInfo | undefined>;

  // --- 贴纸包与动态图 ---
  getAllStickerSets(): Promise<StickerPackSummary[]>;
  getStickerSetDetails(setId?: string, accessHash?: string, shortName?: string): Promise<{ set: StickerPackSummary; stickers: StickerItem[] } | undefined>;
  downloadStickerThumb(docId: string, accessHash: string, fileRefBase64: string): Promise<string | undefined>;
  getSavedGifs(): Promise<SavedGifItem[]>;
  sendStickerDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number): Promise<number | undefined>;
  sendGifDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number): Promise<number | undefined>;
  installStickerSet(setId: string, accessHash: string): Promise<boolean>;
  uninstallStickerSet(setId: string, accessHash: string): Promise<boolean>;
}

export interface AdapterEventMap {
  message: IncomingMessage;
  'message:edited': IncomingMessage;
  'message:deleted': { chatId: number; messageIds: number[] };
  'message:reaction': { chat: ChatRef; messageId: number; user?: UserRef; emoji?: string };
  'callback:query': CallbackQuery;
  'user:status': UserStatus;
  'chat:action': { chat: ChatRef; user: UserRef; action: string };
  'chat:participant:left': { chat: ChatRef; user: UserRef };
  'chat:participant:joined': { chat: ChatRef; participant: NewChatParticipant };
  ready: { self: UserRef };
  disconnected: { reason?: string };
  error: { error: Error; context?: string };
}

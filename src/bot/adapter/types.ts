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

export interface OwnProfile extends UserRef {
  bio: string;
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
  documentId?: string;
  collapsed?: boolean;
}

export interface MessageFactCheck {
  needCheck: boolean;
  country?: string;
  text?: string;
  entities?: MessageEntity[];
  hash?: string;
}

export type MessageReportProgress =
  | { status: 'choose'; title: string; options: Array<{ token: string; text: string }> }
  | { status: 'comment'; token: string; optional: boolean }
  | { status: 'reported' };

export interface DiscussionGroupInfo {
  id: number;
  title: string;
  username?: string;
  membersCount?: number;
}

export interface DiscussionGroupState {
  linkedGroup?: DiscussionGroupInfo;
  groups: DiscussionGroupInfo[];
}

export type MediaType = 'photo' | 'video' | 'audio' | 'document' | 'voice' | 'sticker' | 'animation' | 'poll' | 'todo' | 'dice' | 'story' | 'webpage' | 'location' | 'contact' | 'game' | 'paid_media' | 'unsupported';

export interface MediaAttachment {
  type: MediaType;
  fileId?: string;
  fileSize?: number;
  duration?: number;
  roundVideo?: boolean;
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
  diceEmoji?: string;
  diceValue?: number;
  storyChatId?: number;
  storyId?: number;
  storyIsSelf?: boolean;
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
  /** Current account may stop a poll started by another participant. */
  canClose?: boolean;
  /** Own unanswered poll can be edited; the server verifies this before saving. */
  canEdit?: boolean;
  publicVoters?: boolean;
  multipleChoice?: boolean;
  isQuiz?: boolean;
  solution?: string;
  /** Voice waveform data (0-31 per bar) */
  waveform?: number[];
  /** Webpage link preview */
  webTitle?: string;
  webDescription?: string;
  webUrl?: string;
  webSiteName?: string;
  webPhotoThumb?: boolean;
  /** Coordinates are included only when the Telegram geo point is valid. */
  latitude?: number;
  longitude?: number;
  locationTitle?: string;
  locationAddress?: string;
  liveLocation?: boolean;
  liveLocationPeriod?: number;
  contactFirstName?: string;
  contactLastName?: string;
  contactPhone?: string;
  contactUserId?: string;
  gameTitle?: string;
  gameDescription?: string;
  gameShortName?: string;
  /** Telegram Stars required before the extended media can be opened. */
  paidMediaStars?: string;
  paidMediaItemCount?: number;
  paidMediaLocked?: boolean;
  paidMediaItems?: MediaAttachment[];
  todoTitle?: string;
  todoOthersCanAppend?: boolean;
  todoOthersCanComplete?: boolean;
  todoTitleEntities?: MessageEntity[];
  todoItems?: Array<{ id: number; title: string; entities?: MessageEntity[] }>;
  todoCompletions?: Array<{ id: number; completedBy?: number; date: number }>;
}

export interface MessageReaction {
  emoji: string;
  customEmojiId?: string;
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
  giftCode?: { slug: string; months: number; unclaimed: boolean; viaGiveaway: boolean };
}

export interface BotKeyboardButton {
  text: string;
  row: number;
  column: number;
  type: 'url' | 'callback' | 'game' | 'url_auth' | 'web_app' | 'simple_web_app' | 'copy' | 'user_profile' | 'request_peer' | 'unsupported';
  url?: string;
  copyText?: string;
  userId?: number;
  peerRequest?: BotPeerRequest;
}

export interface BotPeerRequest {
  kind: 'user' | 'group' | 'broadcast';
  maxQuantity: number;
  bot?: boolean;
  botParticipant?: boolean;
  premium?: boolean;
  creator?: boolean;
  hasUsername?: boolean;
  forum?: boolean;
  botAdminRights?: string[];
}

export interface BotReplyKeyboard {
  type: 'keyboard' | 'hide' | 'force';
  rows?: { text: string; type: 'text' | 'request_phone' | 'request_location' | 'request_poll' | 'request_peer' | 'user_profile' | 'simple_web_app' | 'unsupported'; row: number; column: number; quiz?: boolean; userId?: number; peerRequest?: BotPeerRequest; reason?: string }[][];
  singleUse?: boolean;
  selective?: boolean;
  placeholder?: string;
}

export interface IncomingMessage {
  id: number;
  text: string;
  raw?: string;
  entities?: MessageEntity[];
  factChecks?: MessageFactCheck[];
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
  /** Remote changes carried by Telegram forum topic service messages. */
  topicUpdate?: { title?: string; closed?: boolean; hidden?: boolean };
  /** Number of replies/comments (for channel posts) */
  replies?: number;
  /** Telegram marks channel posts with a linked discussion using this flag. */
  commentsEnabled?: boolean;
  /** Inline buttons; Telegram callback data is never sent to the browser. */
  botKeyboard?: BotKeyboardButton[][];
  replyKeyboard?: BotReplyKeyboard;
}

export interface NewChatParticipant {
  user: UserRef;
  inviter?: UserRef;
}

export interface SendOptions {
  parseMode?: 'plain' | 'markdown' | 'html';
  silent?: boolean;
  replyMarkup?: unknown;
  autoDeleteMs?: number;
  replyTo?: number;
  schedule?: number;
  /** Repeating scheduled-message period in seconds (requires schedule). */
  scheduleRepeatPeriod?: number;
  /** Telegram message effect ID, available on supported text and media sends. */
  effectId?: string;
}

export interface MediaOptions extends SendOptions {
  /** Channel post whose linked discussion receives this media comment. */
  commentTo?: number;
  /** Forum topic root message for topic-scoped media sends. */
  topMsgId?: number;
  caption?: string;
  fileName?: string;
  mimeType?: string;
  thumb?: string | Buffer;
  forceDocument?: boolean;
  /** Per-photo/video price in Telegram Stars for a broadcast channel's paid media. */
  paidStars?: number;
  /** Send a video as Telegram's circular video-note message. */
  videoNote?: boolean;
  /** Display a media caption above its attachment. */
  invertMedia?: boolean;
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
  postStories?: boolean;
  editStories?: boolean;
  deleteStories?: boolean;
}

export interface ParticipantInfo {
  user: UserRef;
  role: 'owner' | 'admin' | 'member' | 'banned' | 'left';
  /** Telegram may represent a restricted but still-present channel member as ChannelParticipantBanned. */
  isLeft?: boolean;
  joinedDate?: number;
  kickedBy?: UserRef;
  promotedBy?: UserRef;
  /** Basic groups only expose a single admin flag; channels and supergroups support granular rights. */
  supportsCustomAdminRights?: boolean;
  adminPermissions?: AdminPermissions;
}

export interface ParticipantsPage {
  count: number;
  participants: ParticipantInfo[];
  /** Actions the current account can perform in this group. Missing/unknown rights are false. */
  selfPermissions?: {
    isCreator: boolean;
    canInviteUsers: boolean;
    canBanUsers: boolean;
    canAddAdmins: boolean;
  };
  nextOffset?: number;
}

export interface CreateChatOptions {
  type: 'group' | 'supergroup' | 'channel';
  title: string;
  about?: string;
  userIds?: number[];
  forum?: boolean;
}

export interface JoinRequestInfo {
  user: UserRef;
  date: number;
  about?: string;
}

export interface JoinRequestsPage {
  count: number;
  requests: JoinRequestInfo[];
  nextCursor?: { date: number; userId: number };
}

export interface BannedParticipantInfo {
  user: UserRef;
  date: number;
  untilDate?: number;
}

export interface BannedParticipantsPage {
  count: number;
  participants: BannedParticipantInfo[];
  nextOffset?: number;
}

export interface ChatInviteLinkInfo {
  link: string;
  title?: string;
  date: number;
  expireDate?: number;
  usageLimit?: number;
  usage: number;
  requestNeeded: boolean;
  revoked: boolean;
}

export interface ChatInviteLinksPage {
  count: number;
  links: ChatInviteLinkInfo[];
  nextCursor?: { date: number; link: string };
}

export interface CloudDraft {
  text: string;
  /** Telegram timestamp in milliseconds. */
  date: number;
  entities: MessageEntity[];
  replyToMessageId?: number;
  /** Some Telegram-only information cannot be restored by the basic editor. */
  hasUnsupportedFeatures: boolean;
}

export interface DialogInfo {
  id: number;
  type: ChatType;
  /** The currently authorized Telegram account's Saved Messages peer. */
  isSelf?: boolean;
  title?: string;
  username?: string;
  unreadCount: number;
  /** ID of the most recent message, used to reconcile real-time updates. */
  lastMessageId?: number;
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
  /** Whether the peer is a saved contact (relevant to Telegram folders). */
  isContact?: boolean;
  isBot?: boolean;
  isPremium?: boolean;
  isCreator?: boolean;
  isBroadcast?: boolean;
  /** null means the server explicitly reports no draft; undefined is unknown. */
  draft?: CloudDraft | null;
  /** Whether this supergroup has Telegram forum topics enabled. */
  isForum?: boolean;
  /** Telegram auto-delete period for messages in this peer, in seconds. */
  ttlPeriod?: number;
}

export interface DialogFolder {
  id: number;
  title: string;
  emoticon?: string;
  color?: number;
  isShared?: boolean;
  isOwner?: boolean;
  pinnedPeers: string[];
  includePeers: string[];
  excludePeers: string[];
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
}

export interface DialogFolderTagState {
  enabled: boolean;
  premium: boolean;
}

export interface DialogFolderInvite {
  title: string;
  url: string;
  peerIds: string[];
}

export interface DialogFolderSharePeer {
  id: string;
  title: string;
  type: 'group' | 'channel';
}

export interface DialogFolderInvitePreviewPeer {
  id: string;
  title: string;
  type: 'private' | 'group' | 'channel';
  alreadyJoined: boolean;
}

export interface DialogFolderInvitePreview {
  title: string;
  emoticon?: string;
  alreadyImported: boolean;
  peers: DialogFolderInvitePreviewPeer[];
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

export interface StickerSearchPage {
  stickers: StickerItem[];
  nextOffset?: number;
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

export type StoryMediaArea =
  | ({ type: 'url'; url: string } & StoryMediaAreaPosition)
  | ({ type: 'reaction'; emoji: string } & StoryMediaAreaPosition)
  | ({ type: 'geo'; latitude: number; longitude: number } & StoryMediaAreaPosition)
  | ({ type: 'venue'; latitude: number; longitude: number; title: string; address: string } & StoryMediaAreaPosition)
  | ({ type: 'channel_post'; channelId: string; messageId: number } & StoryMediaAreaPosition)
  | ({ type: 'weather'; emoji: string; temperatureC: number } & StoryMediaAreaPosition)
  | ({ type: 'star_gift'; slug: string } & StoryMediaAreaPosition);

export interface StoryMediaAreaPosition {
  /** Telegram expresses story-area coordinates as percentages of the media. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export interface StoryEntry {
  id: number;
  date: number;
  expireDate: number;
  caption?: string;
  isPinned?: boolean;
  mediaType?: string;
  sentReaction?: string;
  mediaAreas?: StoryMediaArea[];
  viewsCount?: number;
  reactionsCount?: number;
  forwardsCount?: number;
}

export interface StoryAlbumEntry {
  id: number;
  title: string;
  coverType?: 'photo' | 'video';
}

export interface StoryAlbumStoriesPage {
  stories: StoryEntry[];
  count: number;
  nextOffset?: number;
}

export interface StoryFeedPeer {
  id: number;
  type: ChatType;
  title: string;
  username?: string;
  isSelf: boolean;
  isRead: boolean;
  isHidden: boolean;
  stories: StoryEntry[];
}

export interface StoryFeedPage {
  peers: StoryFeedPeer[];
  state: string;
  hasMore: boolean;
  count: number;
}

export interface StoryViewerEntry {
  user: UserRef;
  date: number;
  reaction?: string;
}

export interface StoryForwardEntry {
  type: 'forward' | 'repost';
  title: string;
  peerId?: number;
  messageId?: number;
  storyId?: number;
  date?: number;
  text?: string;
}

export interface StoryViewersPage {
  count: number;
  viewsCount: number;
  reactionsCount: number;
  forwardsCount: number;
  viewers: StoryViewerEntry[];
  forwards: StoryForwardEntry[];
  nextOffset?: string;
}

export interface PeerProfileDetails {
  id: number;
  title: string;
  isSelf?: boolean;
  username?: string;
  phone?: string;
  bio?: string;
  type: ChatType;
  memberCount?: number;
  /** Telegram auto-delete period for messages sent in this peer, in seconds. */
  ttlPeriod?: number;
  commonChatsCount?: number;
  isVerified?: boolean;
  isPremium?: boolean;
  isBot?: boolean;
  storiesHidden?: boolean;
  hasPhoto: boolean;
  photosCount: number;
  pinnedMsgId?: number;
  defaultBannedRights?: ChatDefaultBannedRights;
  slowmodeSeconds?: number;
  joinToSend?: boolean;
  joinRequest?: boolean;
  antiSpam?: boolean;
  participantsHidden?: boolean;
  stories?: StoryEntry[];
}

export interface ChatDefaultBannedRights {
  viewMessages: boolean;
  sendMessages: boolean;
  sendPlain: boolean;
  sendMedia: boolean;
  sendPhotos: boolean;
  sendVideos: boolean;
  sendRoundvideos: boolean;
  sendAudios: boolean;
  sendVoices: boolean;
  sendDocs: boolean;
  sendStickers: boolean;
  sendGifs: boolean;
  sendGames: boolean;
  sendInline: boolean;
  embedLinks: boolean;
  sendPolls: boolean;
  changeInfo: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  manageTopics: boolean;
}

export type SupergroupSetting = 'joinToSend' | 'joinRequest' | 'antiSpam' | 'participantsHidden';

export interface GetMessagesOptions {
  limit?: number;
  offsetId?: number;
  addOffset?: number;
  /** Telegram's exclusive timestamp cursor, in Unix seconds. */
  offsetDate?: number;
  ids?: number[];
  search?: string;
  searchFilter?: 'photos' | 'videos' | 'files' | 'links' | 'music' | 'voice' | 'round-video' | 'round-voice' | 'geo' | 'calls';
  /** Filter Saved Messages by a Telegram saved-reaction tag. */
  savedReaction?: SavedMessageTagReaction;
}

export type SavedMessageTagReaction =
  | { type: 'emoji'; value: string }
  | { type: 'custom'; value: string };

export interface SavedMessageTag {
  reaction: SavedMessageTagReaction;
  title?: string;
  count: number;
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
  deleteMessages(chatId: number, messageIds: number[], revoke?: boolean): Promise<void>;

  /** Change the pin/archive state of a dialog, not an individual message. */
  setDialogPinned(chatId: number, pinned: boolean): Promise<void>;
  setDialogArchived(chatId: number, archived: boolean): Promise<void>;
  /** Delete a private dialog, or leave a group/channel and remove its dialog. */
  deleteDialog(chatId: number): Promise<void>;

  /** Subscribe to adapter events. Returns an unsubscribe function. */
  on<E extends keyof AdapterEventMap>(event: E, handler: (payload: AdapterEventMap[E]) => void): () => void;

  /** Resolve a user id to a UserRef (best-effort, may be undefined for unsaved users). */
  getUser(id: number): Promise<UserRef | undefined>;

  /** Resolve a chat id to a ChatRef. */
  getChat(id: number): Promise<ChatRef | undefined>;

  /** Get self user info. */
  getSelf(): UserRef | undefined;
  getOwnProfile(): Promise<OwnProfile>;

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
  getStoryById(chatId: number, storyId: number): Promise<StoryEntry | undefined>;
  getStoryViewers(chatId: number, storyId: number, offset?: string, limit?: number, kind?: 'viewers' | 'reactions' | 'forwards'): Promise<StoryViewersPage>;
  exportStoryLink(chatId: number, storyId: number): Promise<string>;
  getChatMedia(chatId: number, filterType: 'music' | 'photos' | 'videos' | 'files', limit?: number): Promise<IncomingMessage[]>;
  downloadMediaFile(chatId: number, messageId: number, thumb?: boolean, destPath?: string, mediaIndex?: number): Promise<{ filePath: string; mimeType: string; fileName?: string } | undefined>;
  sendMedia(chatId: number, file: string | Buffer, mediaType: 'photo' | 'video' | 'audio' | 'document' | 'voice', options?: MediaOptions): Promise<number | undefined>;
  sendMediaAlbum(chatId: number, files: string[], options?: MediaOptions): Promise<number | undefined>;

  // --- 消息与历史操作 ---
  forwardMessage(fromChatId: number | string, toChatId: number | string, messageId: number): Promise<number | undefined>;
  forwardMessages(fromChatId: number | string, toChatId: number | string, messageIds: number[]): Promise<number[]>;
  pinMessage(chatId: number, messageId: number, silent?: boolean): Promise<void>;
  unpinMessage(chatId: number | string, messageId?: number): Promise<void>;
  getMessages(chatId: number, options?: GetMessagesOptions): Promise<IncomingMessage[]>;
  getMessageFactChecks(chatId: number, messageId: number): Promise<MessageFactCheck[]>;
  startMessageReport(chatId: number, messageId: number): Promise<MessageReportProgress>;
  continueMessageReport(token: string, comment?: string): Promise<MessageReportProgress>;
  getDiscussionGroupState(channelId: number): Promise<DiscussionGroupState>;
  linkDiscussionGroup(channelId: number, groupId: number): Promise<void>;
  unlinkDiscussionGroup(channelId: number): Promise<void>;
  updateTelegramBusinessWorkHours(timezoneId: string, weeklyOpen: Array<{ startMinute: number; endMinute: number }>): Promise<void>;
  updateTelegramBusinessLocation(address: string, latitude?: number, longitude?: number): Promise<void>;
  updateTelegramBusinessIntro(title: string, description: string, clear?: boolean): Promise<void>;
  createTelegramBusinessChatLink(title: string, message: string): Promise<{ title?: string; url?: string; message: string; views: number }>;
  editTelegramBusinessChatLink(slug: string, title: string, message: string): Promise<void>;
  deleteTelegramBusinessChatLink(slug: string): Promise<void>;
  updateTelegramBusinessGreetingMessage(shortcutId: number, noActivityDays: number, recipients: { existingChats: boolean; newChats: boolean; contacts: boolean; nonContacts: boolean }, clear?: boolean): Promise<void>;
  updateTelegramBusinessAwayMessage(shortcutId: number, offlineOnly: boolean, schedule: 'always' | 'outside_work_hours' | 'custom', startDate: number | undefined,
    endDate: number | undefined, recipients: { existingChats: boolean; newChats: boolean; contacts: boolean; nonContacts: boolean }, clear?: boolean): Promise<void>;
  searchMessages(chatId: number, query: string, limit?: number): Promise<IncomingMessage[]>;
  markAsRead(chatId: number, maxId?: number): Promise<void>;
  pressBotCallback(chatId: number, messageId: number, row: number, column: number): Promise<{ message?: string; alert?: boolean; url?: string }>;

  // --- 群组与频道管理 ---
  banUser(chatId: number, userId: number, untilDate?: number): Promise<void>;
  unbanUser(chatId: number, userId: number): Promise<void>;
  kickUser(chatId: number, userId: number): Promise<void>;
  muteUser(chatId: number, userId: number, seconds: number): Promise<void>;
  unmuteUser(chatId: number, userId: number): Promise<void>;
  promoteUser(chatId: number, userId: number, perms?: AdminPermissions): Promise<void>;
  demoteUser(chatId: number, userId: number): Promise<void>;
  getParticipants(chatId: number, limit?: number): Promise<ParticipantInfo[]>;
  getParticipantsPage(chatId: number, offset?: number, limit?: number, query?: string): Promise<ParticipantsPage>;
  createChat(options: CreateChatOptions): Promise<DialogInfo>;
  getBannedParticipants(chatId: number, offset?: number, limit?: number, query?: string): Promise<BannedParticipantsPage>;
  getChatInviteLinks(chatId: number, cursor?: { date: number; link: string }, limit?: number): Promise<ChatInviteLinksPage>;
  createChatInviteLink(chatId: number, options: { title?: string; expireDate?: number; usageLimit?: number; requestNeeded?: boolean }): Promise<ChatInviteLinkInfo>;
  editChatInviteLink(chatId: number, link: string, title: string): Promise<ChatInviteLinkInfo>;
  revokeChatInviteLink(chatId: number, link: string): Promise<void>;
  getJoinRequests(chatId: number, cursor?: { date: number; userId: number }, limit?: number, query?: string): Promise<JoinRequestsPage>;
  decideJoinRequest(chatId: number, userId: number, approved: boolean): Promise<void>;
  decideAllJoinRequests(chatId: number, approved: boolean): Promise<void>;
  inviteUser(chatId: number, userId: number): Promise<void>;
  getChatMember(chatId: number, userId: number): Promise<ParticipantInfo | undefined>;
  leaveChat(chatId: number): Promise<void>;
  setChatTitle(chatId: number, title: string): Promise<void>;
  setChatDescription(chatId: number, description: string): Promise<void>;
  setChatUsername(chatId: number, username: string): Promise<void>;
  setChatPhoto(chatId: number, uploadPath: string, fileName: string): Promise<void>;
  setChatDefaultBannedRights(chatId: number, rights: ChatDefaultBannedRights): Promise<void>;
  setChatSlowMode(chatId: number, seconds: number): Promise<void>;
  setSupergroupSetting(chatId: number, setting: SupergroupSetting, enabled: boolean): Promise<void>;

  // --- 对话与联系人 ---
  getDialogs(limit?: number, offset?: { peer: number | string; id: number; date: number }, folderId?: 0 | 1): Promise<DialogInfo[]>;
  getExplicitDialogs(peerIds: number[]): Promise<DialogInfo[]>;
  getDraft(chatId: number): Promise<CloudDraft | null>;
  saveDraft(chatId: number, text: string, options?: { replyToMessageId?: number; parseMode?: 'plain' | 'markdown' | 'html' }): Promise<void>;
  getDialogFolders(): Promise<DialogFolder[]>;
  saveDialogFolder(folder: Partial<DialogFolder> & Pick<DialogFolder, 'title'>): Promise<DialogFolder>;
  deleteDialogFolder(folderId: number): Promise<void>;
  reorderDialogFolders(folderIds: number[]): Promise<void>;
  getDialogFolderTagState(): Promise<DialogFolderTagState>;
  setDialogFolderTags(enabled: boolean): Promise<void>;
  getDialogFolderSharePeers(folderId: number): Promise<DialogFolderSharePeer[]>;
  getDialogFolderInvites(folderId: number): Promise<DialogFolderInvite[]>;
  createDialogFolderInvite(folderId: number, title: string, peerIds: string[]): Promise<DialogFolderInvite>;
  editDialogFolderInvite(folderId: number, url: string, title: string, peerIds: string[]): Promise<DialogFolderInvite>;
  deleteDialogFolderInvite(folderId: number, url: string): Promise<void>;
  checkDialogFolderInvite(url: string): Promise<DialogFolderInvitePreview>;
  joinDialogFolderInvite(url: string, peerIds: string[]): Promise<void>;
  searchDialogs(query: string, limit?: number): Promise<DialogInfo[]>;
  searchGlobalMessages(query: string, limit?: number, cursor?: { rate: number; peer: string; id: number }, searchFilter?: GetMessagesOptions['searchFilter']): Promise<{ messages: IncomingMessage[]; nextCursor?: { rate: number; peer: string; id: number } }>;
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
  getStickerCollections(): Promise<{ favorites: StickerItem[]; recent: StickerItem[] }>;
  setStickerFavorite(docId: string, accessHash: string, fileRefBase64: string, favorite: boolean): Promise<void>;
  searchStickers(query: string, offset?: number, limit?: number): Promise<StickerSearchPage>;
  getStickerSetDetails(setId?: string, accessHash?: string, shortName?: string): Promise<{ set: StickerPackSummary; stickers: StickerItem[] } | undefined>;
  downloadStickerThumb(docId: string, accessHash: string, fileRefBase64: string): Promise<string | undefined>;
  searchCustomEmoji(emoticon: string): Promise<{ id: string; emoji: string }[]>;
  sendCustomEmoji(chatId: number, emoticon: string, documentId: string): Promise<number | undefined>;
  downloadCustomEmojiPreview(documentId: string): Promise<{ filePath: string; mimeType: string } | undefined>;
  getSavedGifs(): Promise<SavedGifItem[]>;
  downloadGifPreview(docId: string, accessHash: string, fileRefBase64: string, mimeType?: string): Promise<{ filePath: string; mimeType: string } | undefined>;
  sendStickerDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number, topMsgId?: number): Promise<number | undefined>;
  sendGifDocument(chatId: number, docId: string, accessHash: string, fileRefBase64: string, replyTo?: number, topMsgId?: number): Promise<number | undefined>;
  installStickerSet(setId: string, accessHash: string): Promise<boolean>;
  uninstallStickerSet(setId: string, accessHash: string): Promise<boolean>;
}

export interface AdapterEventMap {
  'dialog:folders': Record<string, never>;
  'draft:updated': { chatId: number; draft: CloudDraft | null };
  message: IncomingMessage;
  'message:edited': IncomingMessage;
  'message:deleted': { chatId: number; messageIds: number[] };
  'message:read': { chatId: number; maxId: number };
  'stories:updated': { chatId: number; storyId?: number; maxReadId?: number };
  'stories:stealth': Record<string, never>;
  'forum:topics': { chatId: number };
  'chat:history-ttl': { chatId: number; period: number };
  'chat:wallpaper': { chatId: number };
  'chat:typing': { chatId: number; userId: number; action: string };
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

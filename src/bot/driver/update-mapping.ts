import { Api } from 'telegram';
import { getPeerId } from 'telegram/Utils';

export type ChatRawUpdate =
  | { kind: 'read'; chatId: number; maxId: number }
  | { kind: 'stories'; chatId: number; storyId?: number; maxReadId?: number }
  | { kind: 'storiesStealth' }
  | { kind: 'historyTtl'; chatId: number; period: number }
  | { kind: 'wallpaper'; chatId: number }
  | { kind: 'forumTopics'; chatId: number }
  | { kind: 'status'; userId: number; online: boolean; lastSeen?: number }
  | { kind: 'typing'; chatId: number; userId: number; action: string };

/** Map Telegram peer IDs to the same signed IDs used by dialogs and messages. */
export function mapChatRawUpdate(update: any): ChatRawUpdate | undefined {
  try {
    if (update?.className === 'UpdatePeerHistoryTTL' && update.peer) {
      const chatId = Number(getPeerId(update.peer));
      const rawPeriod = update.ttlPeriod == null ? 0 : Number(update.ttlPeriod);
      if (Number.isSafeInteger(chatId) && chatId !== 0 && Number.isSafeInteger(rawPeriod) && rawPeriod >= 0 && rawPeriod <= 31536000) {
        return { kind: 'historyTtl', chatId, period: rawPeriod };
      }
      return;
    }
    if (update?.className === 'UpdatePeerWallpaper' && update.peer) {
      const chatId = Number(getPeerId(update.peer));
      if (Number.isSafeInteger(chatId) && chatId !== 0) return { kind: 'wallpaper', chatId };
      return;
    }
    if (update?.className === 'UpdateStoriesStealthMode') return { kind: 'storiesStealth' };
    if (update?.className === 'UpdateStory' || update?.className === 'UpdateReadStories' || update?.className === 'UpdateSentStoryReaction') {
      if (!update.peer) return;
      const chatId = Number(getPeerId(update.peer));
      if (!Number.isSafeInteger(chatId) || chatId === 0) return;
      if (update.className === 'UpdateStory' || update.className === 'UpdateSentStoryReaction') {
        const storyId = Number(update.className === 'UpdateStory' ? update.story?.id : update.storyId);
        return { kind: 'stories', chatId, storyId: Number.isSafeInteger(storyId) && storyId > 0 ? storyId : undefined };
      }
      const maxReadId = Number(update.maxId);
      return { kind: 'stories', chatId, maxReadId: Number.isSafeInteger(maxReadId) && maxReadId > 0 ? maxReadId : undefined };
    }
    if (update?.className === 'UpdateChannelPinnedTopic' || update?.className === 'UpdateChannelPinnedTopics') {
      const channelId = Number(update.channelId);
      if (!Number.isSafeInteger(channelId) || channelId <= 0) return;
      return { kind: 'forumTopics', chatId: Number(getPeerId(new Api.PeerChannel({ channelId: BigInt(channelId) as any }))) };
    }
    if (update?.className === 'UpdateUserStatus') {
      const userId = Number(update.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0 || !update.status) return;
      const online = update.status.className === 'UserStatusOnline';
      const seconds = Number(update.status.wasOnline);
      const lastSeen = Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined;
      return { kind: 'status', userId, online, lastSeen };
    }
    let peer: any;
    if (update?.className === 'UpdateReadHistoryOutbox') peer = update.peer;
    else if (update?.className === 'UpdateReadChannelOutbox') peer = new Api.PeerChannel({ channelId: update.channelId });
    if (peer) {
      const chatId = Number(getPeerId(peer));
      const maxId = Number(update.maxId);
      if (Number.isSafeInteger(chatId) && chatId !== 0 && Number.isSafeInteger(maxId) && maxId > 0) return { kind: 'read', chatId, maxId };
      return;
    }
    let userId: number;
    if (update?.className === 'UpdateUserTyping') {
      peer = new Api.PeerUser({ userId: update.userId });
      userId = Number(getPeerId(peer));
    } else if (update?.className === 'UpdateChatUserTyping') {
      peer = new Api.PeerChat({ chatId: update.chatId });
      userId = Number(getPeerId(update.fromId));
    } else if (update?.className === 'UpdateChannelUserTyping') {
      peer = new Api.PeerChannel({ channelId: update.channelId });
      userId = Number(getPeerId(update.fromId));
    } else return;
    const chatId = Number(getPeerId(peer));
    if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(userId) || userId === 0) return;
    return { kind: 'typing', chatId, userId, action: update.action?.className || 'SendMessageTypingAction' };
  } catch { return; }
}

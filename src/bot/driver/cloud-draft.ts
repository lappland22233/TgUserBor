import { Api } from 'telegram';
import type { CloudDraft, MessageEntity } from '../adapter/types';

/** Translate Telegram drafts without ever hiding information the editor cannot restore. */
export function mapCloudDraft(draft: Api.TypeDraftMessage | undefined | null): CloudDraft | null {
  if (!draft) return null;
  const kind: string = draft.className;
  if (kind === 'DraftMessageEmpty') return null;
  if (kind !== 'DraftMessage') throw new Error('未知草稿类型');
  const value = draft as Api.DraftMessage;
  const entities: MessageEntity[] = (value.entities || []).map((entity: any) => ({
    type: String(entity.className), offset: Number(entity.offset), length: Number(entity.length),
    ...(typeof entity.url === 'string' ? { url: entity.url } : {}),
    ...(entity.userId != null ? { userId: Number(entity.userId) } : {}),
  }));
  const reply: any = value.replyTo;
  const basicReply = reply && reply.className === 'InputReplyToMessage' &&
    Number.isSafeInteger(reply.replyToMsgId) && reply.replyToMsgId > 0;
  const unsupportedReply = Boolean(reply && (!basicReply || reply.topMsgId != null || reply.replyToPeerId ||
    reply.quoteText != null || reply.quoteEntities?.length || reply.quoteOffset != null));
  return {
    text: value.message,
    date: Number(value.date || 0) * 1000,
    entities,
    ...(basicReply ? { replyToMessageId: reply.replyToMsgId } : {}),
    hasUnsupportedFeatures: Boolean(entities.length || unsupportedReply || value.media || value.effect || value.noWebpage || value.invertMedia),
  };
}

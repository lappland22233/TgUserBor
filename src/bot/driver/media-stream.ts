import { Api, TelegramClient } from 'telegram';

export const MEDIA_STREAM_CHUNK_BYTES = 256 * 1024;
export interface MediaStreamInfo {
  accountId: number;
  documentId: string;
  size: number;
  mimeType: string;
  mediaIndex?: number;
}

async function getDocument(client: TelegramClient, peer: any, messageId: number, mediaIndex?: number): Promise<{ media: Api.MessageMediaDocument; document: Api.Document } | undefined> {
  const messages = await client.getMessages(peer, { ids: [messageId] });
  let media: any = messages[0]?.media;
  if (media instanceof Api.MessageMediaPaidMedia) {
    if (!Number.isSafeInteger(mediaIndex) || mediaIndex! < 0 || mediaIndex! >= media.extendedMedia.length) return undefined;
    const extended = media.extendedMedia[mediaIndex!];
    if (!(extended instanceof Api.MessageExtendedMedia)) return undefined;
    media = extended.media;
  } else if (mediaIndex != null) return undefined;
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) return undefined;
  return { media, document: media.document };
}

/** Only audio/video documents with a known finite size are streamable. */
export async function getMediaStreamInfo(client: TelegramClient, peer: any, messageId: number, accountId: number, mediaIndex?: number): Promise<MediaStreamInfo | undefined> {
  if (mediaIndex != null && (!Number.isSafeInteger(mediaIndex) || mediaIndex < 0 || mediaIndex > 9)) return undefined;
  const found = await getDocument(client, peer, messageId, mediaIndex);
  if (!found) return undefined;
  const size = Number(found.document.size.toString());
  const mimeType = found.document.mimeType;
  if (!Number.isSafeInteger(size) || size <= 0 || !/^(video|audio)\/[a-z0-9.+-]+$/i.test(mimeType)) return undefined;
  return { accountId, documentId: found.document.id.toString(), size, mimeType, ...(mediaIndex == null ? {} : { mediaIndex }) };
}

/** Fetch a bounded segment; verify message and account identity on every pull. */
export async function getMediaStreamChunk(
  client: TelegramClient, peer: any, messageId: number, accountId: number,
  expected: MediaStreamInfo, offset: number, length: number,
): Promise<Buffer> {
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size <= 0 || accountId !== expected.accountId || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length <= 0 || length > MEDIA_STREAM_CHUNK_BYTES || offset + length > expected.size) {
    throw new Error('Invalid media stream request');
  }
  const found = await getDocument(client, peer, messageId, expected.mediaIndex);
  if (!found || found.document.id.toString() !== expected.documentId ||
      Number(found.document.size.toString()) !== expected.size || found.document.mimeType !== expected.mimeType) {
    throw new Error('Media changed or is no longer accessible');
  }
  // GramJS uses big-integer for offsets, while the size on Api.Document is
  // already a big-integer value. The generic iterator supports unaligned ranges.
  const start = found.document.size.subtract(found.document.size).add(offset);
  const iterator = client.iterDownload({ file: found.media, offset: start,
    chunkSize: MEDIA_STREAM_CHUNK_BYTES, requestSize: 512 * 1024, limit: 1 });
  for await (const chunk of iterator) {
    if (chunk.length < length) throw new Error('Unexpected end of media');
    return Buffer.from(chunk.subarray(0, length));
  }
  throw new Error('Unexpected end of media');
}

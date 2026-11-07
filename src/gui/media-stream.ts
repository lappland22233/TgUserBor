import type * as http from 'http';
import { MEDIA_STREAM_CHUNK_BYTES, type MediaStreamInfo } from '../bot/driver/media-stream';
import { parseByteRange } from './media-response';

type AccountActions = { accountAction(action: string, payload?: any): Promise<any> };

/** Stream a known Telegram document using bounded IPC pulls and HTTP backpressure. */
export async function streamTelegramMedia(
  req: http.IncomingMessage, res: http.ServerResponse, inst: AccountActions,
  chatId: number, messageId: number, info: MediaStreamInfo,
): Promise<void> {
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || !Number.isSafeInteger(info.accountId) ||
      typeof info.documentId !== 'string' || !/^(video|audio)\/[a-z0-9.+-]+$/i.test(info.mimeType)) {
    throw new Error('Invalid media metadata');
  }
  const range = req.headers.range ? parseByteRange(req.headers.range, info.size) : null;
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'private, no-store' });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : info.size - 1;
  const headers: Record<string, string> = {
    'Content-Type': info.mimeType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;

  let closed = false;
  const onClose = () => { closed = true; };
  res.on('close', onClose);
  try {
    for (let offset = start; offset <= end && !closed && !res.destroyed;) {
      const length = Math.min(MEDIA_STREAM_CHUNK_BYTES, end - offset + 1);
      const result = await inst.accountAction('get_media_stream_chunk', { chatId, messageId, info, offset, length });
      if (closed || res.destroyed) return;
      if (typeof result?.base64 !== 'string' || result.base64.length > Math.ceil(length / 3) * 4) {
        throw new Error('Invalid media chunk');
      }
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length !== length) throw new Error('Incomplete media chunk');
      if (!res.headersSent) res.writeHead(range ? 206 : 200, headers);
      offset += bytes.length;
      if (!res.write(bytes)) {
        await new Promise<void>((resolve, reject) => {
          const done = () => { cleanup(); resolve(); };
          const error = (err: Error) => { cleanup(); reject(err); };
          const cleanup = () => { res.off('drain', done); res.off('close', done); res.off('error', error); };
          res.once('drain', done); res.once('close', done); res.once('error', error);
        });
      }
    }
    if (!closed && !res.destroyed) res.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    throw err;
  } finally {
    res.off('close', onClose);
  }
}

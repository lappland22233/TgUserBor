import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

/** A cache namespace is bound to both the configured session and Telegram account. */
export function mediaCacheNamespace(sessionPath: string, userId: number): string {
  return createHash('sha256').update(JSON.stringify([path.resolve(sessionPath), userId])).digest('hex').slice(0, 24);
}

// An incomplete download is never visible under its final name. Simultaneous
// requests within a worker share one download and all wait for completion.
const downloads = new Map<string, Promise<boolean>>();

export async function downloadMediaToCache(target: string, download: (temporaryPath: string) => Promise<unknown>, maxAgeMs?: number): Promise<boolean> {
  const exists = async () => {
    try {
      const stat = await fs.stat(target);
      return stat.isFile() && stat.size > 0 && (maxAgeMs === undefined || Date.now() - stat.mtimeMs < maxAgeMs);
    } catch { return false; }
  };
  if (await exists()) return true;
  const existing = downloads.get(target);
  if (existing) return existing;

  const pending = (async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${randomUUID()}.part`;
    try {
      await download(temporaryPath);
      const stat = await fs.stat(temporaryPath);
      if (!stat.isFile() || stat.size === 0) return false;
      await fs.rename(temporaryPath, target);
      return true;
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  })();
  downloads.set(target, pending);
  try { return await pending; }
  finally { if (downloads.get(target) === pending) downloads.delete(target); }
}

/** GramJS awaits write() but not a Node WriteStream's asynchronous close(). */
export async function withAwaitedFileWriter<T>(target: string, write: (writer: { write: (chunk: Buffer) => Promise<void> }) => Promise<T>): Promise<T> {
  const file = await fs.open(target, 'wx');
  try { return await write({ write: (chunk: Buffer) => file.writeFile(chunk) }); }
  finally { await file.close(); }
}

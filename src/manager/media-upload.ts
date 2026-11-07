import * as fs from 'fs/promises';
import * as path from 'path';
import type { Readable } from 'stream';

export const MAX_STREAM_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const STREAM_UPLOAD_ROOT = path.resolve('data', 'cache', 'uploads', 'stream');
let lastStreamCleanup = 0;

async function uploadOwnerIsAlive(directory: string): Promise<boolean> {
  try {
    const pid = Number(await fs.readFile(path.join(directory, '.upload-owner'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (err: any) { return err?.code === 'EPERM'; }
  } catch { return false; }
}

async function cleanupAbandonedUploads(root: string): Promise<void> {
  const now = Date.now();
  if (now - lastStreamCleanup < 60 * 60_000) return;
  lastStreamCleanup = now;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('upload-')) continue;
    const dir = path.join(root, entry.name);
    try {
      if (now - (await fs.stat(dir)).mtimeMs > 24 * 60 * 60_000 && !await uploadOwnerIsAlive(dir)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } catch { /* A concurrent worker may already have removed it. */ }
  }
}

function safeUploadName(fileName: unknown): string {
  const name = path.basename(String(fileName || '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f]/g, '').slice(-200);
  return !name || name === '.' || name === '..' || name === '.upload-owner' || name === '.upload-owner-next' ? 'file.bin' : name;
}

/** Receive a bounded, length-prefixed JSON header followed by raw file bytes. */
export async function receiveStreamUpload(req: Readable, root = STREAM_UPLOAD_ROOT, maxBytes = MAX_STREAM_UPLOAD_BYTES): Promise<{ path: string; metadata: any }> {
  let directory = '';
  let file: fs.FileHandle | undefined;
  let target = '';
  let metadata: any;
  let header = Buffer.alloc(0);
  let metadataLength: number | undefined;
  let received = 0;
  try {
    // Preserve the HTTP socket on validation/size failures so callers can
    // return an error response; the remaining body is drained below.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!file) {
        header = Buffer.concat([header, data]);
        if (metadataLength === undefined && header.length >= 4) {
          metadataLength = header.readUInt32BE(0);
          if (!metadataLength || metadataLength > 65536) throw new Error('Invalid upload metadata');
        }
        if (metadataLength === undefined || header.length < 4 + metadataLength) {
          // The header is always bounded even if a peer streams arbitrary data.
          if (header.length > 65540) throw new Error('Invalid upload metadata');
          continue;
        }
        try { metadata = JSON.parse(header.subarray(4, 4 + metadataLength).toString('utf8')); }
        catch { throw new Error('Invalid upload metadata'); }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid upload metadata');
        data = header.subarray(4 + metadataLength);
        header = Buffer.alloc(0);
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await cleanupAbandonedUploads(root).catch(() => {});
        directory = await fs.mkdtemp(path.join(root, 'upload-'));
        // Directory mtimes do not change as file data is written. Record the
        // receiver immediately so even very slow uploads cannot be reaped.
        await fs.writeFile(path.join(directory, '.upload-owner'), String(process.pid), { flag: 'wx', mode: 0o600 });
        target = path.join(directory, safeUploadName(metadata.fileName));
        file = await fs.open(target, 'wx', 0o600);
      }
      received += data.length;
      if (received > maxBytes) throw new Error('Payload too large');
      if (data.length) await file.writeFile(data);
    }
    if (!file || !received) throw new Error('Missing file data');
    await file.close();
    file = undefined;
    return { path: target, metadata };
  } catch (err) {
    if (!req.destroyed) req.resume();
    if (file) await file.close().catch(() => {});
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Receive an album manifest followed by each file's raw bytes in order. */
export async function receiveStreamAlbumUpload(
  req: Readable,
  root = STREAM_UPLOAD_ROOT,
  maxFileBytes = MAX_STREAM_UPLOAD_BYTES,
): Promise<{ paths: string[]; metadata: any }> {
  let directory = '';
  let header = Buffer.alloc(0);
  let metadataLength: number | undefined;
  let metadata: any;
  let files: Array<{ fileName: string; size: number; mimeType: string }> = [];
  const usedNames = new Set<string>();
  let paths: string[] = [];
  let fileIndex = 0;
  let remaining = 0;
  let received = 0;
  let currentFile: fs.FileHandle | undefined;

  const openCurrentFile = async () => {
    if (fileIndex >= files.length) return;
    const record = files[fileIndex];
    remaining = record.size;
    const safeName = safeUploadName(record.fileName);
    const extension = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - extension.length);
    let uniqueName = safeName;
    let suffix = 2;
    while (usedNames.has(uniqueName.toLowerCase())) uniqueName = `${stem} (${suffix++})${extension}`;
    usedNames.add(uniqueName.toLowerCase());
    const target = path.join(directory, uniqueName);
    currentFile = await fs.open(target, 'wx', 0o600);
    paths.push(target);
  };
  const writeData = async (data: Buffer) => {
    while (data.length) {
      if (fileIndex >= files.length || !currentFile) throw new Error('Unexpected album upload data');
      const length = Math.min(remaining, data.length);
      await currentFile.writeFile(data.subarray(0, length));
      received += length;
      if (received > maxFileBytes * 10) throw new Error('Payload too large');
      data = data.subarray(length);
      remaining -= length;
      if (remaining === 0) {
        await currentFile.close(); currentFile = undefined;
        fileIndex++;
        await openCurrentFile();
      }
    }
  };

  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!metadata) {
        header = Buffer.concat([header, data]);
        if (metadataLength === undefined && header.length >= 4) {
          metadataLength = header.readUInt32BE(0);
          if (!metadataLength || metadataLength > 65536) throw new Error('Invalid upload metadata');
        }
        if (metadataLength === undefined || header.length < 4 + metadataLength) {
          if (header.length > 65540) throw new Error('Invalid upload metadata');
          continue;
        }
        try { metadata = JSON.parse(header.subarray(4, 4 + metadataLength).toString('utf8')); }
        catch { throw new Error('Invalid upload metadata'); }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(metadata.files) ||
            metadata.files.length < 2 || metadata.files.length > 10) throw new Error('Invalid album upload metadata');
        files = metadata.files;
        let total = 0;
        for (const record of files) {
          if (!record || typeof record.fileName !== 'string' || typeof record.mimeType !== 'string' ||
              !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > maxFileBytes) {
            throw new Error('Invalid album upload metadata');
          }
          total += record.size;
          if (!Number.isSafeInteger(total) || total > maxFileBytes * 10) throw new Error('Payload too large');
        }
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await cleanupAbandonedUploads(root).catch(() => {});
        directory = await fs.mkdtemp(path.join(root, 'upload-'));
        await fs.writeFile(path.join(directory, '.upload-owner'), String(process.pid), { flag: 'wx', mode: 0o600 });
        await openCurrentFile();
        data = header.subarray(4 + metadataLength);
        header = Buffer.alloc(0);
      }
      if (data.length) await writeData(data);
    }
    if (!metadata || fileIndex !== files.length || currentFile || received === 0) throw new Error('Missing album file data');
    return { paths, metadata };
  } catch (err) {
    if (!req.destroyed) req.resume();
    if (currentFile) await currentFile.close().catch(() => {});
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Only delete uploads created by this application, never a caller-supplied path. */
export async function cleanupStreamUpload(uploadPath: string): Promise<void> {
  if (!isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
  await fs.rm(path.dirname(path.resolve(uploadPath)), { recursive: true, force: true });
}

export async function markStreamUploadOwner(uploadPath: string, pid: number): Promise<void> {
  if (!isStreamUploadPath(uploadPath) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid staged upload owner');
  const directory = path.dirname(path.resolve(uploadPath));
  const next = path.join(directory, '.upload-owner-next');
  await fs.writeFile(next, String(pid), { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(next, path.join(directory, '.upload-owner'));
  } catch (err) {
    await fs.rm(next, { force: true }).catch(() => {});
    throw err;
  }
}

export async function cleanupStreamUploadIfOwnerExited(uploadPath: string): Promise<boolean> {
  if (!isStreamUploadPath(uploadPath)) throw new Error('Invalid staged upload');
  const directory = path.dirname(path.resolve(uploadPath));
  try { await fs.access(directory); } catch (err: any) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
  if (await uploadOwnerIsAlive(directory)) return false;
  await cleanupStreamUpload(uploadPath);
  return true;
}

/** Keep an in-flight upload until its worker finishes or exits. */
export function watchOrphanedStreamUpload(uploadPath: string): void {
  const check = async () => {
    try {
      if (await cleanupStreamUploadIfOwnerExited(uploadPath)) return;
    } catch { /* Retry transient filesystem errors. */ }
    const timer = setTimeout(check, 60_000);
    timer.unref();
  };
  void check();
}

export function isStreamUploadPath(uploadPath: string): boolean {
  const root = path.resolve(STREAM_UPLOAD_ROOT);
  const resolved = path.resolve(uploadPath);
  const directory = path.dirname(resolved);
  return path.dirname(directory) === root && /^upload-[A-Za-z0-9]{6}$/.test(path.basename(directory)) &&
    !['.upload-owner', '.upload-owner-next'].includes(path.basename(resolved));
}

/** Keep each upload in its own unpredictable directory and always remove it. */
export async function withTemporaryUpload<T>(
  uploadRoot: string,
  fileName: string,
  fileBase64: string,
  send: (filePath: string) => Promise<T>,
): Promise<T> {
  await fs.mkdir(uploadRoot, { recursive: true });
  const uploadDir = await fs.mkdtemp(path.join(uploadRoot, 'upload-'));
  try {
    const name = path.basename(String(fileName || '').replace(/\\/g, '/'))
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(-200);
    const safeName = !name || name === '.' || name === '..' ? 'file.bin' : name;
    const filePath = path.join(uploadDir, safeName);
    const data = Buffer.from(fileBase64.replace(/^data:.*?;base64,/, ''), 'base64');
    if (!data.length) throw new Error('Invalid file data');
    await fs.writeFile(filePath, data, { flag: 'wx' });
    return await send(filePath);
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
}

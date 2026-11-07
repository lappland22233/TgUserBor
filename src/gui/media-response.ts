/** Parse a single HTTP byte range. Invalid or multi-range requests are ignored. */
export function parseByteRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return 'unsatisfiable';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Number.isSafeInteger(suffix) ? Math.max(0, size - suffix) : 0, end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (requestedEnd < start) return 'unsatisfiable';
  return { start, end: Number.isSafeInteger(requestedEnd) ? Math.min(requestedEnd, size - 1) : size - 1 };
}

/** Avoid header injection while retaining Unicode names for modern browsers. */
export function mediaDownloadDisposition(fileName: string): string {
  const safe = Buffer.from(fileName, 'utf8').toString('utf8').replace(/[\x00-\x1f\x7f]/g, '') || 'download';
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

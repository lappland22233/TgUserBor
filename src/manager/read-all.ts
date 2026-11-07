import type { BotAdapter, DialogInfo } from '../bot/adapter/types';

export interface MarkAllReadResult {
  marked: number;
  failed: number;
  incompleteFolders: number[];
}

/** Mark the messages present in a paged snapshot; never hide partial failures. */
export async function markAllDialogsRead(adapter: Pick<BotAdapter, 'getDialogs' | 'markAsRead'>): Promise<MarkAllReadResult> {
  const result: MarkAllReadResult = { marked: 0, failed: 0, incompleteFolders: [] };
  const seen = new Set<string>();
  const pageSize = 100;
  for (const folder of [0, 1] as const) {
    let cursor: { peer: number | string; id: number; date: number } | undefined;
    const cursors = new Set<string>();
    // Guard against malformed or cyclic server pagination.
    for (let page = 0; page < 1000; page++) {
      let dialogs: DialogInfo[];
      try { dialogs = await adapter.getDialogs(pageSize, cursor, folder); }
      catch { result.incompleteFolders.push(folder); break; }
      for (const dialog of dialogs) {
        const key = String(dialog.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(dialog.unreadCount > 0)) continue;
        // Bound the operation to the newest message in the snapshot; new
        // messages arriving while this request runs must remain unread.
        if (!Number.isSafeInteger(dialog.lastMessageId) || !dialog.lastMessageId || dialog.lastMessageId < 1) {
          result.failed++;
          continue;
        }
        try { await adapter.markAsRead(dialog.id, dialog.lastMessageId); result.marked++; }
        catch { result.failed++; }
      }
      if (dialogs.length < pageSize) break;
      const last = [...dialogs].reverse().find(d => !d.pinned && d.id != null && d.lastMessageId && d.lastMessageDate);
      if (!last || !last.lastMessageId || !last.lastMessageDate) { result.incompleteFolders.push(folder); break; }
      const next = { peer: last.id, id: last.lastMessageId, date: last.lastMessageDate };
      const key = JSON.stringify(next);
      if (cursors.has(key)) { result.incompleteFolders.push(folder); break; }
      cursors.add(key);
      cursor = next;
      if (page === 999) result.incompleteFolders.push(folder);
    }
  }
  return result;
}

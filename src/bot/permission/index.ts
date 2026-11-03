import type { Database } from '../database';

export enum AccessLevel {
  OWNER = 0,
  ADMIN = 1,
  USER = 2,
  DENIED = 3,
}

export interface PermissionContext {
  userId: number;
  chatId?: number;
  isOwner: boolean;
  isAdmin?: boolean;
  pluginName?: string;
  commandName?: string;
}

export class PermissionManager {
  constructor(private readonly db: Database, private readonly ownerId: number) {}

  /**
   * Returns the most specific matching access level. Precedence:
   *   1. global row for the plugin (or 'default') = 0 (owner-only)
   *   2. per-user row for this plugin/command
   *   3. per-chat row for this plugin/command
   *   4. default (USER)
   */
  resolve(ctx: PermissionContext): AccessLevel {
    if (ctx.isOwner) return AccessLevel.OWNER;

    const stmt = this.db.raw().prepare(`
      SELECT level FROM permissions
      WHERE (scope = 'plugin'  AND plugin = ? AND target_id = 0)
         OR (scope = 'user'    AND plugin = ? AND target_id = ?)
         OR (scope = 'chat'    AND plugin = ? AND target_id = ?)
      ORDER BY
        CASE scope WHEN 'plugin' THEN 0 WHEN 'user' THEN 1 WHEN 'chat' THEN 2 ELSE 3 END
      LIMIT 1
    `);

    const pluginKey = ctx.pluginName ?? '*';
    const row = stmt.get(pluginKey, pluginKey, ctx.userId, pluginKey, ctx.chatId ?? 0) as
      | { level: number }
      | undefined;

    if (row) return row.level as AccessLevel;
    return AccessLevel.USER;
  }

  check(ctx: PermissionContext, required: AccessLevel = AccessLevel.USER): boolean {
    return this.resolve(ctx) <= required;
  }

  grant(scope: 'user' | 'chat' | 'plugin', targetId: number, plugin: string, level: AccessLevel): void {
    this.db
      .raw()
      .prepare(
        `INSERT INTO permissions (scope, target_id, plugin, level, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, target_id, plugin) DO UPDATE SET level = excluded.level`,
      )
      .run(scope, targetId, plugin, level, Date.now());
  }

  revoke(scope: 'user' | 'chat' | 'plugin', targetId: number, plugin: string): void {
    this.db
      .raw()
      .prepare('DELETE FROM permissions WHERE scope = ? AND target_id = ? AND plugin = ?')
      .run(scope, targetId, plugin);
  }

  list(): Array<{ scope: string; target_id: number; plugin: string; level: number }> {
    return this.db
      .raw()
      .prepare('SELECT scope, target_id, plugin, level FROM permissions ORDER BY scope, plugin, target_id')
      .all() as any;
  }
}

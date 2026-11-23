import type { Database } from '../database';

export function readPluginEnabled(db: Database, name: string): boolean | undefined {
  const row = db.raw().prepare('SELECT enabled FROM plugin_state WHERE name = ?').get(name) as
    { enabled: number | null } | undefined;
  return row?.enabled == null ? undefined : Boolean(row.enabled);
}

export function writePluginEnabled(db: Database, name: string, enabled: boolean): void {
  const now = Date.now();
  db.raw().prepare(`
    INSERT INTO plugin_state (name, enabled, loaded_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(name, enabled ? 1 : 0, now, now);
}

export function readPluginConfig(db: Database, name: string): Record<string, unknown> {
  const row = db.raw().prepare('SELECT config_json FROM plugin_state WHERE name = ?').get(name) as
    { config_json: string | null } | undefined;
  try {
    return row?.config_json ? JSON.parse(row.config_json) : {};
  } catch {
    return {};
  }
}

export function writePluginConfig(db: Database, name: string, config: Record<string, unknown>): void {
  const now = Date.now();
  db.raw().prepare(`
    INSERT INTO plugin_state (name, config_json, loaded_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `).run(name, JSON.stringify(config), now, now);
}

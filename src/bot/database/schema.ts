export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY,
        username    TEXT,
        first_name  TEXT,
        last_name   TEXT,
        is_bot      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id          INTEGER PRIMARY KEY,
        type        TEXT NOT NULL,
        title       TEXT,
        username    TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_state (
        name        TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        loaded_at   INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        chat_id     INTEGER NOT NULL,
        command     TEXT NOT NULL,
        plugin      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_command_usage_user ON command_usage(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_command_usage_cmd  ON command_usage(command, created_at);

      CREATE TABLE IF NOT EXISTS permissions (
        scope       TEXT NOT NULL,         -- 'global' | 'user' | 'chat' | 'plugin'
        target_id   INTEGER NOT NULL DEFAULT 0,
        plugin      TEXT,
        level       INTEGER NOT NULL,      -- 0=owner, 1=admin, 2=user, 3=disabled
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (scope, target_id, plugin)
      );
    `,
  },
  {
    version: 2,
    name: 'whitelist_table',
    up: `
      CREATE TABLE IF NOT EXISTS whitelist (
        user_id     INTEGER PRIMARY KEY,
        username    TEXT,
        remark      TEXT,
        created_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'notes_and_rate_limits',
    up: `
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL UNIQUE,
        content    TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        user_id      INTEGER NOT NULL,
        action_key   TEXT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        PRIMARY KEY (user_id, action_key)
      );
    `,
  },
  {
    version: 4,
    name: 'scheduled_tasks_table',
    up: `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id      INTEGER NOT NULL,
        interval_ms  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        repeat       INTEGER NOT NULL DEFAULT 1,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_by   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        last_run_at  INTEGER,
        next_run_at  INTEGER NOT NULL,
        time_spec    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat ON scheduled_tasks(chat_id);
    `,
  },
  {
    version: 5,
    name: 'scheduled_tasks_time_spec',
    up: `
      ALTER TABLE scheduled_tasks ADD COLUMN time_spec TEXT;
    `,
  },
];

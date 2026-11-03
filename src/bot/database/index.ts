import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './schema';

let DatabaseSyncClass: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqlite = require('node:sqlite');
  DatabaseSyncClass = sqlite.DatabaseSync;
} catch {
  // eslint-disable-next-line no-console
  console.error('\n' + '='.repeat(60));
  // eslint-disable-next-line no-console
  console.error('❌ 致命错误: 当前 Node.js 环境缺少内置的 "node:sqlite" 模块！');
  // eslint-disable-next-line no-console
  console.error(`当前检测到的版本: ${process.version}`);
  // eslint-disable-next-line no-console
  console.error('框架为了彻底免去 C++ 复杂编译与各种环境崩溃，采用 Node 官方内置 SQLite 引擎。');
  // eslint-disable-next-line no-console
  console.error('该特性要求 Node.js >= 22.5.0 (官方当前活跃长期支持版 Node 22 LTS)。');
  // eslint-disable-next-line no-console
  console.error('\n💡 极速解决方案 (在 Linux 终端执行一键升级):');
  // eslint-disable-next-line no-console
  console.error('   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs');
  // eslint-disable-next-line no-console
  console.error('='.repeat(60) + '\n');
  process.exit(1);
}

/**
 * Thin wrapper around Node's built-in `node:sqlite` module.
 * Using the built-in driver keeps the framework free of native build steps.
 */
export class Database {
  private readonly db: any;

  constructor(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSyncClass(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((r) => r.version),
    );

    const insert = this.db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.up);
        insert.run(migration.version, migration.name, Date.now());
        this.db.exec('COMMIT');
      } catch (err: any) {
        this.db.exec('ROLLBACK');
        if (err.message && err.message.includes('duplicate column name')) {
          insert.run(migration.version, migration.name, Date.now());
          continue;
        }
        throw err;
      }
    }
  }

  raw(): any {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

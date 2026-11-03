import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

import type { BotConfig, LogLevel } from './types';

const VALID_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parsePrefixes(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseLevel(raw: string): LogLevel {
  const lower = raw.toLowerCase() as LogLevel;
  if (!VALID_LEVELS.includes(lower)) {
    throw new Error(`Invalid log level: ${raw}`);
  }
  return lower;
}

function parseProxy(): BotConfig['telegram']['proxy'] {
  const typeRaw = (process.env.TG_PROXY_TYPE ?? '').toLowerCase().trim();
  const host = process.env.TG_PROXY_HOST?.trim();
  const portRaw = process.env.TG_PROXY_PORT?.trim();

  if (!host || !portRaw) return undefined;
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) return undefined;

  const type = typeRaw === 'mtproxy' ? 'mtproxy' : 'socks5';
  return {
    type,
    host,
    port,
    secret: process.env.TG_PROXY_SECRET?.trim(),
    username: process.env.TG_PROXY_USER?.trim(),
    password: process.env.TG_PROXY_PASS?.trim(),
  };
}

export function loadConfig(): BotConfig {
  loadDotEnv();

  const apiIdRaw = required('TG_API_ID', '0');
  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('TG_API_ID must be a positive integer');
  }

  const ownerRaw = required('TG_OWNER_ID', '0');
  const ownerId = Number.parseInt(ownerRaw, 10);
  if (!Number.isFinite(ownerId) || ownerId <= 0) {
    throw new Error('TG_OWNER_ID must be a positive integer');
  }

  return {
    telegram: {
      apiId,
      apiHash: required('TG_API_HASH'),
      sessionPath: path.resolve(process.cwd(), required('SESSION_PATH', './data/sessions/bot.session')),
      proxy: parseProxy(),
    },
    ownerId,
    log: {
      level: parseLevel(required('LOG_LEVEL', 'info')),
      dir: path.resolve(process.cwd(), required('LOG_DIR', './data/logs')),
    },
    db: {
      path: path.resolve(process.cwd(), required('DB_PATH', './data/db/bot.sqlite')),
    },
    plugin: {
      dir: path.resolve(process.cwd(), required('PLUGIN_DIR', './plugins')),
      hotReload: (process.env.PLUGIN_HOT_RELOAD ?? 'true').toLowerCase() === 'true',
    },
    command: {
      prefixes: parsePrefixes(required('COMMAND_PREFIXES', '.,/')),
    },
  };
}

export type { BotConfig, LogLevel } from './types';

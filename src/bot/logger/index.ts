import * as fs from 'fs';
import * as path from 'path';
import pino, { type Logger as PinoLogger } from 'pino';

import type { BotConfig } from '../config';

let rootLogger: PinoLogger | undefined;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildDestination(config: BotConfig): pino.DestinationStream {
  ensureDir(config.log.dir);
  const logFile = path.join(config.log.dir, 'bot.log');

  if (process.stdout.isTTY && !process.env.TGBOT_NO_PRETTY) {
    return pino.destination({
      dest: logFile,
      sync: true,
      mkdir: true,
    });
  }

  return pino.destination({
    dest: logFile,
    sync: true,
    mkdir: true,
  });
}

export function initLogger(config: BotConfig): PinoLogger {
  if (rootLogger) return rootLogger;

  const fileDest = buildDestination(config);
  const stdoutDest = pino.destination({ dest: 1, sync: false });

  const streams = [
    { stream: stdoutDest, level: config.log.level },
    { stream: fileDest, level: config.log.level },
  ];

  rootLogger = pino(
    {
      level: config.log.level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );

  rootLogger.info(
    { level: config.log.level, logDir: config.log.dir },
    'logger initialized',
  );
  return rootLogger;
}

export function getLogger(): PinoLogger {
  if (!rootLogger) {
    throw new Error('Logger has not been initialized. Call initLogger(config) first.');
  }
  return rootLogger;
}

export function childLogger(bindings: Record<string, unknown>): PinoLogger {
  return getLogger().child(bindings);
}

export type Logger = PinoLogger;

import { loadConfig } from './bot/config';
import { initLogger } from './bot/logger';
import { Bot } from './bot/core';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = initLogger(config);
  const bot = new Bot(config, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await bot.stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));

  await bot.start();
  logger.info('tguserbot-framework is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});

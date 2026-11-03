export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ProxyConfig {
  type: 'socks5' | 'mtproxy';
  host: string;
  port: number;
  secret?: string;
  username?: string;
  password?: string;
}

export interface BotConfig {
  telegram: {
    apiId: number;
    apiHash: string;
    sessionPath: string;
    proxy?: ProxyConfig;
  };
  ownerId: number;
  log: {
    level: LogLevel;
    dir: string;
  };
  db: {
    path: string;
  };
  plugin: {
    dir: string;
    hotReload: boolean;
  };
  command: {
    prefixes: string[];
  };
}

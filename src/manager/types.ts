import type { BotConfig } from '../bot/config';
import type { UserRef } from '../bot/adapter';

export type InstanceStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'NEEDS_PHONE'
  | 'NEEDS_QR'
  | 'NEEDS_CODE'
  | 'NEEDS_PASSWORD'
  | 'ONLINE'
  | 'ERROR';

export interface InstanceMetrics {
  cpuPercent?: number;
  memoryRss: number; // in bytes
  uptime: number; // in seconds
  messagesCount: number;
  commandsCount: number;
  pingLatency?: number;
}

export interface InstanceConfig {
  id: string; // unique slug e.g. "acc_1"
  name: string; // friendly display name e.g. "My Personal Account"
  apiId: number;
  apiHash: string;
  ownerId: number;
  sessionPath: string;
  dbPath: string;
  logPath: string;
  pluginDir: string;
  prefixes: string[];
  proxy?: BotConfig['telegram']['proxy'];
  autoStart: boolean;
  enabledPlugins?: string[]; // list of allowed/enabled plugins or undefined for all
  createdAt: number;
}

export interface InstanceInfo {
  config: InstanceConfig;
  status: InstanceStatus;
  metrics: InstanceMetrics;
  self?: UserRef;
  pid?: number;
  lastError?: string;
  pendingAuthStep?: 'phone' | 'code' | 'password';
}

// IPC Message Protocol
export type IPCToParent =
  | { type: 'STATUS_CHANGE'; status: InstanceStatus; error?: string }
  | { type: 'AUTH_REQUIRED'; step: 'phone' | 'code' | 'password'; hint?: string }
  | { type: 'AUTH_QR'; token: string; expires: number }
  | { type: 'AUTH_SUCCESS'; self: UserRef }
  | { type: 'METRICS'; data: Partial<InstanceMetrics> }
  | { type: 'LOG_EVENT'; level: string; msg: string; time: number; context?: any }
  | { type: 'RAW_EVENT'; event: { type: string; instId: string; message?: any; messageIds?: number[]; chatId?: number | string; maxId?: number; [key: string]: any } }
  | { type: 'PLUGIN_ACTION_RESULT'; actionId: string; success: boolean; error?: string }
  | { type: 'ACCOUNT_ACTION_RESULT'; actionId: string; success: boolean; data?: any; error?: string };

export type IPCToChild =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'AUTH_INPUT'; step: 'phone' | 'code' | 'password'; value: string }
  | { type: 'AUTH_QR_START' }
  | { type: 'PLUGIN_ACTION'; actionId: string; action: 'enable' | 'disable' | 'reload'; pluginName: string }
  | { type: 'ACCOUNT_ACTION'; actionId: string; action: string; payload?: any };


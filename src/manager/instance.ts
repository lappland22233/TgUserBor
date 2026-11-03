import * as path from 'path';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import type {
  InstanceConfig,
  InstanceInfo,
  InstanceStatus,
  InstanceMetrics,
  IPCToParent,
  IPCToChild,
} from './types';

export interface LogEntry {
  level: string;
  msg: string;
  time: number;
  instanceId: string;
}

export class ManagedInstance extends EventEmitter {
  readonly config: InstanceConfig;
  private status: InstanceStatus = 'STOPPED';
  private metrics: InstanceMetrics = {
    memoryRss: 0,
    uptime: 0,
    messagesCount: 0,
    commandsCount: 0,
  };
  private self?: InstanceInfo['self'];
  private lastError?: string;
  private child?: cp.ChildProcess;
  private logs: LogEntry[] = [];
  private readonly maxLogs = 500;
  private pendingPluginActions = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private pendingAccountActions = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();
  private pendingAuthStep?: 'phone' | 'code' | 'password';

  constructor(config: InstanceConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed && this.status !== 'STOPPED' && this.status !== 'ERROR') {
      try {
        if (this.child.pid && process.kill(this.child.pid, 0)) {
          return;
        }
      } catch {
        this.child = undefined;
        this.status = 'STOPPED';
      }
    }

    this.setStatus('STARTING');

    // Worker file location (points to compiled js in dist or ts via ts-node in dev)
    const workerScript = path.resolve(__dirname, 'worker.js');

    this.child = cp.fork(workerScript, [], {
      env: {
        ...process.env,
        INSTANCE_CONFIG: JSON.stringify(this.config),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.child.on('message', (msg: IPCToParent) => {
      this.handleIPC(msg);
    });

    this.child.on('error', (err) => {
      this.lastError = err.message;
      this.setStatus('ERROR');
      this.addLog('error', `Process error: ${err.message}`);
    });

    this.child.on('exit', (code, signal) => {
      this.child = undefined;
      this.pendingAuthStep = undefined;
      const wasOnline = this.status === 'ONLINE';
      this.setStatus('STOPPED');
      this.addLog('info', `Process exited with code ${code ?? 'none'} (signal: ${signal ?? 'none'})`);
      if (wasOnline && code !== 0) {
        this.lastError = `Unexpected exit with code ${code}`;
      }
    });

    if (this.child.stdout) {
      this.child.stdout.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this.addLog('info', text);
      });
    }

    if (this.child.stderr) {
      this.child.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this.addLog('error', text);
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.setStatus('STOPPED');
      return;
    }

    const child = this.child;
    this.sendIPC({ type: 'STOP' });

    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(killTimeout);
          this.child = undefined;
          this.setStatus('STOPPED');
          resolve();
        }
      };

      child.once('exit', done);

      // 2.5 秒后强制 SIGKILL，并在 3 秒内彻底结束等待，防止进程悬挂死锁
      const killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        setTimeout(done, 500);
      }, 2500);
    });

    this.child = undefined;
    this.pendingAuthStep = undefined;
    this.setStatus('STOPPED');
    this.addLog('info', 'Instance process stopped successfully');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  submitAuth(step: 'phone' | 'code' | 'password', value: string): void {
    this.sendIPC({ type: 'AUTH_INPUT', step, value });
    this.addLog('info', `Submitted auth for step: ${step}`);
  }

  pluginAction(action: 'enable' | 'disable' | 'reload', pluginName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.status !== 'ONLINE') {
        return reject(new Error(`Instance "${this.config.id}" is not online`));
      }

      const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.pendingPluginActions.set(actionId, { resolve, reject });

      this.sendIPC({
        type: 'PLUGIN_ACTION',
        actionId,
        action,
        pluginName,
      });

      // Timeout after 10s
      setTimeout(() => {
        const pending = this.pendingPluginActions.get(actionId);
        if (pending) {
          this.pendingPluginActions.delete(actionId);
          pending.reject(new Error(`Plugin action "${action}" timed out`));
        }
      }, 10_000);
    });
  }

  accountAction(action: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.status !== 'ONLINE') {
        return reject(new Error(`账号实例 "${this.config.id}" 未处于在线运行状态`));
      }

      const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.pendingAccountActions.set(actionId, { resolve, reject });

      this.sendIPC({
        type: 'ACCOUNT_ACTION',
        actionId,
        action,
        payload,
      });

      // Timeout after 15s
      setTimeout(() => {
        const pending = this.pendingAccountActions.get(actionId);
        if (pending) {
          this.pendingAccountActions.delete(actionId);
          pending.reject(new Error(`账号操作 "${action}" 响应超时`));
        }
      }, 15_000);
    });
  }

  private sendIPC(msg: IPCToChild): void {
    if (this.child && this.child.connected) {
      this.child.send(msg);
    }
  }

  private handleIPC(msg: IPCToParent): void {
    switch (msg.type) {
      case 'STATUS_CHANGE':
        if (msg.error) this.lastError = msg.error;
        this.setStatus(msg.status);
        break;
      case 'AUTH_REQUIRED':
        this.pendingAuthStep = msg.step;
        if (msg.step === 'phone') this.setStatus('NEEDS_PHONE');
        else if (msg.step === 'code') this.setStatus('NEEDS_CODE');
        else if (msg.step === 'password') this.setStatus('NEEDS_PASSWORD');
        this.emit('auth_required', { instanceId: this.config.id, step: msg.step, hint: msg.hint });
        this.addLog('warn', `Telegram login required: Please enter ${msg.step}`);
        break;
      case 'AUTH_SUCCESS':
        this.pendingAuthStep = undefined;
        this.self = msg.self;
        this.emit('auth_success', { instanceId: this.config.id, self: msg.self });
        this.addLog('info', `Logged in successfully as ${msg.self.firstName || msg.self.username} (ID: ${msg.self.id})`);
        break;
      case 'METRICS':
        this.metrics = { ...this.metrics, ...msg.data };
        this.emit('metrics', { instanceId: this.config.id, metrics: this.metrics });
        break;
      case 'LOG_EVENT':
        this.addLog(msg.level, msg.msg, msg.time);
        break;
      case 'RAW_EVENT':
        this.emit('raw_event', msg.event);
        break;
      case 'PLUGIN_ACTION_RESULT': {
        const pending = this.pendingPluginActions.get(msg.actionId);
        if (pending) {
          this.pendingPluginActions.delete(msg.actionId);
          if (msg.success) pending.resolve();
          else pending.reject(new Error(msg.error || 'Action failed'));
        }
        break;
      }
      case 'ACCOUNT_ACTION_RESULT': {
        const pending = this.pendingAccountActions.get(msg.actionId);
        if (pending) {
          this.pendingAccountActions.delete(msg.actionId);
          if (msg.success) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error || 'Account action failed'));
        }
        break;
      }
    }
  }

  private setStatus(status: InstanceStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('status_change', { instanceId: this.config.id, status, error: this.lastError });
    }
  }

  private addLog(level: string, msg: string, time: number = Date.now()): void {
    const entry: LogEntry = { level, msg, time, instanceId: this.config.id };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  getInfo(): InstanceInfo {
    return {
      config: this.config,
      status: this.status,
      metrics: this.metrics,
      self: this.self,
      pid: this.child?.pid,
      lastError: this.lastError,
      pendingAuthStep: this.pendingAuthStep,
    };
  }

  getLogs(limit: number = 200): LogEntry[] {
    return this.logs.slice(-limit);
  }
}


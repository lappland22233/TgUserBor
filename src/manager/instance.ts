import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
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
  private pendingAccountActions = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private pendingAuthStep?: 'phone' | 'code' | 'password';
  private qrAccessKey?: string;
  private qrLogin?: { token: string; expires: number };
  private logoutInProgress = false;

  constructor(config: InstanceConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.logoutInProgress) throw new Error('账号正在退出，请稍后再启动');
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
    const child = this.child;

    child.on('message', (msg: IPCToParent) => {
      if (this.child !== child) return;
      this.handleIPC(msg);
    });

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.rejectPendingAccountActions(new Error(`实例进程出错: ${err.message}`));
      this.lastError = err.message;
      this.setStatus('ERROR');
      this.addLog('error', `Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.rejectPendingAccountActions(new Error('实例进程已退出'));
      this.child = undefined;
      this.pendingAuthStep = undefined;
      this.clearQrLogin();
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
    if (this.logoutInProgress) throw new Error('账号正在退出，请稍后再操作');
    await this.stopWorker();
  }

  private async stopWorker(): Promise<void> {
    this.clearQrLogin();
    this.rejectPendingAccountActions(new Error('实例已停止'));
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
          if (this.child === child) {
            this.child = undefined;
            this.setStatus('STOPPED');
          }
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

    if (this.child === child) this.child = undefined;
    this.pendingAuthStep = undefined;
    this.setStatus('STOPPED');
    this.addLog('info', 'Instance process stopped successfully');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async logOut(): Promise<{ localSessionRemoved: boolean }> {
    if (this.logoutInProgress) throw new Error('账号正在退出');
    this.logoutInProgress = true;
    try {
      const result = await this.accountAction('log_out');
      // Once Telegram has revoked the authorization, stop this worker so the
      // reconnect watchdog and plugins cannot continue using it.
      this.self = undefined;
      this.lastError = undefined;
      await this.stopWorker();
      return { localSessionRemoved: result?.localSessionRemoved === true };
    } catch (err) {
      // The worker may still complete an in-flight Telegram request after an
      // IPC timeout. Stop it before permitting another start or retry.
      await this.stopWorker();
      this.self = undefined;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`退出未确认，实例已停止；请重新启动检查 Telegram 登录状态：${reason}`);
    } finally {
      this.logoutInProgress = false;
    }
  }

  async submitAuth(step: 'phone' | 'code' | 'password', value: string): Promise<void> {
    const child = this.child;
    if (!child?.connected || this.pendingAuthStep !== step) {
      throw new Error('当前没有等待此验证步骤，请刷新后重试');
    }
    // A step can only be submitted once; a retry becomes possible when the
    // worker emits a new AUTH_REQUIRED event or sending the IPC message fails.
    this.pendingAuthStep = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.send({ type: 'AUTH_INPUT', step, value }, (err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      if (this.child === child && !this.pendingAuthStep) this.pendingAuthStep = step;
      throw err;
    }
    this.addLog('info', `Submitted auth for step: ${step}`);
  }

  /** Start QR authentication only from the pending phone prompt. */
  async beginQrLogin(): Promise<string> {
    const child = this.child;
    if (!child?.connected || this.pendingAuthStep !== 'phone' || this.qrAccessKey) {
      throw new Error('当前不能开始二维码登录');
    }
    const key = crypto.randomBytes(32).toString('base64url');
    this.qrAccessKey = key;
    this.qrLogin = undefined;
    this.pendingAuthStep = undefined;
    this.setStatus('NEEDS_QR');
    try {
      await new Promise<void>((resolve, reject) => {
        child.send({ type: 'AUTH_QR_START' }, (err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      this.clearQrLogin();
      if (this.child === child && child.connected) {
        this.pendingAuthStep = 'phone';
        this.setStatus('NEEDS_PHONE');
      }
      throw err;
    }
    return key;
  }

  getQrLogin(key: string): { token: string; expires: number } | undefined {
    if (!this.validQrAccessKey(key)) throw new Error('无权访问二维码');
    if (!this.qrLogin || this.qrLogin.expires <= Date.now() / 1000) return undefined;
    return this.qrLogin;
  }

  async cancelQrLogin(key: string): Promise<void> {
    if (!this.validQrAccessKey(key)) throw new Error('二维码登录已结束或无权取消');
    // GramJS's QR polling cannot be aborted safely; stop its worker.
    await this.stop();
  }

  private validQrAccessKey(key: string): boolean {
    if (!this.qrAccessKey || typeof key !== 'string') return false;
    const expected = Buffer.from(this.qrAccessKey);
    const supplied = Buffer.from(key);
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  private clearQrLogin(): void {
    this.qrAccessKey = undefined;
    this.qrLogin = undefined;
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
      if (this.logoutInProgress && action !== 'log_out') {
        return reject(Object.assign(new Error('账号正在退出'), { code: 'ACTION_NOT_DISPATCHED' }));
      }
      if (!this.child || !this.child.connected || this.status !== 'ONLINE') {
        return reject(Object.assign(new Error(`账号实例 "${this.config.id}" 未处于在线运行状态`), { code: 'ACTION_NOT_DISPATCHED' }));
      }

      const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const timeoutMs = action === 'send_media_stream' || action === 'send_media_album_stream' ? 2 * 60 * 60_000 : (action === 'send_media' || action === 'mark_all_read' || action === 'delete_dialog') ? 5 * 60_000 : 15_000;
      const timer = setTimeout(() => {
        const pending = this.pendingAccountActions.get(actionId);
        if (pending) {
          this.pendingAccountActions.delete(actionId);
          pending.reject(new Error(`账号操作 "${action}" 响应超时`));
        }
      }, timeoutMs);
      timer.unref();
      this.pendingAccountActions.set(actionId, { resolve, reject, timer });

      const onSendError = (err: Error | null) => {
        if (!err) return;
        const pending = this.pendingAccountActions.get(actionId);
        if (!pending) return;
        this.pendingAccountActions.delete(actionId);
        clearTimeout(pending.timer);
        pending.reject(Object.assign(err, { code: 'ACTION_NOT_DISPATCHED' }));
      };
      try {
        this.child.send({ type: 'ACCOUNT_ACTION', actionId, action, payload }, onSendError);
      } catch (err) {
        onSendError(err as Error);
      }
    });
  }

  private rejectPendingAccountActions(error: Error): void {
    for (const pending of this.pendingAccountActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingAccountActions.clear();
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
        if (msg.status === 'ERROR' || msg.status === 'STOPPED') this.clearQrLogin();
        this.setStatus(msg.status);
        break;
      case 'AUTH_REQUIRED':
        this.clearQrLogin();
        this.pendingAuthStep = msg.step;
        if (msg.step === 'phone') this.setStatus('NEEDS_PHONE');
        else if (msg.step === 'code') this.setStatus('NEEDS_CODE');
        else if (msg.step === 'password') this.setStatus('NEEDS_PASSWORD');
        this.emit('auth_required', { instanceId: this.config.id, step: msg.step, hint: msg.hint });
        this.addLog('warn', `Telegram login required: Please enter ${msg.step}`);
        break;
      case 'AUTH_QR':
        if (this.qrAccessKey && this.status === 'NEEDS_QR') {
          this.qrLogin = { token: msg.token, expires: msg.expires };
        }
        break;
      case 'AUTH_SUCCESS':
        this.clearQrLogin();
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
          clearTimeout(pending.timer);
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


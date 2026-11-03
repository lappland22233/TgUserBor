import { EventEmitter } from 'events';
import { InstanceStore } from './store';
import { ManagedInstance } from './instance';
import type { InstanceConfig, InstanceInfo } from './types';

export class InstanceManager extends EventEmitter {
  readonly store: InstanceStore;
  private readonly instances = new Map<string, ManagedInstance>();

  constructor(baseDir?: string) {
    super();
    this.store = new InstanceStore(baseDir);
    this.initInstances();
  }

  private initInstances(): void {
    const configs = this.store.getAll();
    for (const cfg of configs) {
      this.attachInstance(cfg);
    }
  }

  private attachInstance(config: InstanceConfig): ManagedInstance {
    const inst = new ManagedInstance(config);

    inst.on('status_change', (data) => this.emit('status_change', data));
    inst.on('auth_required', (data) => this.emit('auth_required', data));
    inst.on('auth_success', (data) => this.emit('auth_success', data));
    inst.on('metrics', (data) => this.emit('metrics', data));
    inst.on('log', (data) => this.emit('log', data));
    inst.on('raw_event', (data) => this.emit('raw_event', data));

    this.instances.set(config.id, inst);
    return inst;
  }

  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const inst of this.instances.values()) {
      if (inst.config.autoStart) {
        promises.push(inst.start());
      }
    }
    await Promise.all(promises);
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const inst of this.instances.values()) {
      promises.push(inst.stop());
    }
    await Promise.all(promises);
  }

  getInstance(id: string): ManagedInstance | undefined {
    return this.instances.get(id);
  }

  getAll(): ManagedInstance[] {
    return Array.from(this.instances.values());
  }

  getAllInfo(): InstanceInfo[] {
    return Array.from(this.instances.values()).map((inst) => inst.getInfo());
  }

  createInstance(params: Omit<InstanceConfig, 'sessionPath' | 'dbPath' | 'logPath' | 'pluginDir' | 'createdAt'>): ManagedInstance {
    const config = this.store.create(params);
    const inst = this.attachInstance(config);
    this.emit('instance_created', inst.getInfo());
    return inst;
  }

  updateInstance(id: string, updates: Partial<InstanceConfig>): ManagedInstance {
    const updatedConfig = this.store.update(id, updates);
    const oldInst = this.instances.get(id);
    if (oldInst) {
      // If running, we might need restart, or simply update config reference
      Object.assign(oldInst.config, updatedConfig);
    }
    this.emit('instance_updated', oldInst?.getInfo());
    return oldInst!;
  }

  async deleteInstance(id: string): Promise<boolean> {
    const inst = this.instances.get(id);
    if (inst) {
      await inst.stop();
      this.instances.delete(id);
    }
    const deleted = this.store.delete(id);
    this.emit('instance_deleted', { instanceId: id });
    return deleted;
  }

  async broadcastPluginAction(action: 'enable' | 'disable' | 'reload', pluginName: string): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const inst of this.instances.values()) {
      if (inst.getInfo().status === 'ONLINE') {
        promises.push(inst.pluginAction(action, pluginName).catch(() => {}));
      }
    }
    await Promise.all(promises);
  }
}


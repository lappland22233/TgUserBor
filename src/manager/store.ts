import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { InstanceConfig } from './types';

export class InstanceStore {
  private readonly baseDir: string;
  private readonly registryFile: string;
  private instances: Map<string, InstanceConfig> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), 'data/instances');
    this.registryFile = path.join(this.baseDir, 'instances.json');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    this.load();
    this.maybeImportExistingEnv();
  }

  private load(): void {
    if (fs.existsSync(this.registryFile)) {
      try {
        const raw = fs.readFileSync(this.registryFile, 'utf-8');
        const list: InstanceConfig[] = JSON.parse(raw);
        for (const item of list) {
          this.instances.set(item.id, item);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to load instances registry:', err);
      }
    }
  }

  private save(): void {
    const list = Array.from(this.instances.values());
    fs.writeFileSync(this.registryFile, JSON.stringify(list, null, 2), 'utf-8');
  }

  private maybeImportExistingEnv(): void {
    if (this.instances.size > 0) return;

    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;

    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
      const apiId = Number.parseInt(parsed.TG_API_ID || '0', 10);
      const apiHash = parsed.TG_API_HASH;
      const ownerId = Number.parseInt(parsed.TG_OWNER_ID || '0', 10);

      if (apiId > 0 && apiHash && ownerId > 0) {
        const defaultId = 'default';
        const defaultDir = path.join(this.baseDir, defaultId);
        fs.mkdirSync(defaultDir, { recursive: true });

        // Copy or reuse existing session if present
        const existingSession = path.resolve(process.cwd(), parsed.SESSION_PATH || 'data/sessions/bot.session');
        const newSessionPath = path.join(defaultDir, 'bot.session');
        if (fs.existsSync(existingSession) && !fs.existsSync(newSessionPath)) {
          try {
            fs.copyFileSync(existingSession, newSessionPath);
          } catch {
            /* ignore */
          }
        }

        const config: InstanceConfig = {
          id: defaultId,
          name: 'Default Bot',
          apiId,
          apiHash,
          ownerId,
          sessionPath: newSessionPath,
          dbPath: path.join(defaultDir, 'bot.sqlite'),
          logPath: path.join(defaultDir, 'bot.log'),
          pluginDir: path.resolve(process.cwd(), parsed.PLUGIN_DIR || './plugins'),
          prefixes: (parsed.COMMAND_PREFIXES || '.,/').split(',').map((s) => s.trim()).filter(Boolean),
          autoStart: true,
          createdAt: Date.now(),
        };

        this.instances.set(defaultId, config);
        this.save();
      }
    } catch {
      /* ignore env import error */
    }
  }

  getAll(): InstanceConfig[] {
    return Array.from(this.instances.values());
  }

  get(id: string): InstanceConfig | undefined {
    return this.instances.get(id);
  }

  create(params: Omit<InstanceConfig, 'sessionPath' | 'dbPath' | 'logPath' | 'pluginDir' | 'createdAt'>): InstanceConfig {
    if (this.instances.has(params.id)) {
      throw new Error(`Instance with id "${params.id}" already exists`);
    }

    const instanceDir = path.join(this.baseDir, params.id);
    fs.mkdirSync(instanceDir, { recursive: true });

    const config: InstanceConfig = {
      ...params,
      sessionPath: path.join(instanceDir, 'bot.session'),
      dbPath: path.join(instanceDir, 'bot.sqlite'),
      logPath: path.join(instanceDir, 'bot.log'),
      pluginDir: path.resolve(process.cwd(), './plugins'),
      createdAt: Date.now(),
    };

    this.instances.set(params.id, config);
    this.save();
    return config;
  }

  update(id: string, updates: Partial<InstanceConfig>): InstanceConfig {
    const existing = this.instances.get(id);
    if (!existing) {
      throw new Error(`Instance "${id}" not found`);
    }

    const updated: InstanceConfig = {
      ...existing,
      ...updates,
      id: existing.id, // prevent changing id
      sessionPath: existing.sessionPath,
      dbPath: existing.dbPath,
      logPath: existing.logPath,
    };

    this.instances.set(id, updated);
    this.save();
    return updated;
  }

  delete(id: string): boolean {
    if (!this.instances.has(id)) return false;
    this.instances.delete(id);
    this.save();

    const instanceDir = path.join(this.baseDir, id);
    if (fs.existsSync(instanceDir)) {
      try {
        fs.rmSync(instanceDir, { recursive: true, force: true });
      } catch {
        /* ignore delete error */
      }
    }
    return true;
  }
}


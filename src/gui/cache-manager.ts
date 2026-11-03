import * as fs from 'fs';
import * as path from 'path';

export interface CacheStats {
  usedBytes: number;
  maxBytes: number;
  usedMB: number;
  maxMB: number;
  percent: number;
  fileCount: number;
  memDialogsCount: number;
  memChatsCount: number;
}

/**
 * TGuserBOT 服务端长期数据多级代理缓存管理器
 * 默认上限 5GB，支持 Web 实时调节、内存秒开索引与磁盘文件 LRU 淘汰
 */
export class CacheManager {
  private static instance?: CacheManager;

  // 默认最大容量：5GB (5 * 1024 * 1024 * 1024)
  private maxSizeBytes = 5 * 1024 * 1024 * 1024;
  private readonly baseDir: string;
  private readonly configFile: string;
  private readonly avatarsDir: string;
  private readonly thumbsDir: string;
  private readonly mediaDir: string;

  // 内存高速缓存
  private readonly dialogsCache = new Map<string, { data: any[]; updatedAt: number }>();
  private readonly messagesCache = new Map<string, { data: any[]; updatedAt: number }>();

  constructor(dataDir: string = path.resolve(process.cwd(), 'data')) {
    this.baseDir = path.join(dataDir, 'cache');
    this.configFile = path.join(dataDir, 'cache_config.json');
    this.avatarsDir = path.join(this.baseDir, 'avatars');
    this.thumbsDir = path.join(this.baseDir, 'thumbs');
    this.mediaDir = path.join(this.baseDir, 'media');

    this.ensureDirs();
    this.loadConfig();
  }

  static getInstance(dataDir?: string): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager(dataDir);
    }
    return CacheManager.instance;
  }

  private ensureDirs(): void {
    for (const d of [this.baseDir, this.avatarsDir, this.thumbsDir, this.mediaDir]) {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
      }
    }
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.maxSizeBytes === 'number' && parsed.maxSizeBytes > 0) {
          this.maxSizeBytes = parsed.maxSizeBytes;
        }
      }
    } catch {
      /* ignore */
    }
  }

  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify({ maxSizeBytes: this.maxSizeBytes }, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  /**
   * 动态设置最大缓存容量限制 (bytes)
   */
  setLimit(bytes: number): void {
    if (bytes >= 100 * 1024 * 1024) {
      // 最小 100MB
      this.maxSizeBytes = bytes;
      this.saveConfig();
      this.pruneIfNeeded();
    }
  }

  getMaxLimit(): number {
    return this.maxSizeBytes;
  }

  // ================= 内存级会话与历史消息缓存 =================

  setDialogs(instId: string, dialogs: any[]): void {
    this.dialogsCache.set(instId, { data: dialogs, updatedAt: Date.now() });
  }

  getDialogs(instId: string): any[] | null {
    const entry = this.dialogsCache.get(instId);
    return entry ? entry.data : null;
  }

  setRecentMessages(instId: string, chatId: number | string, messages: any[]): void {
    const key = `${instId}_${chatId}`;
    // 缓存最新 100 条
    const slice = messages.slice(-100);
    this.messagesCache.set(key, { data: slice, updatedAt: Date.now() });
  }

  getRecentMessages(instId: string, chatId: number | string): any[] | null {
    const key = `${instId}_${chatId}`;
    const entry = this.messagesCache.get(key);
    return entry ? entry.data : null;
  }

  prependMessage(instId: string, chatId: number | string, message: any): void {
    const key = `${instId}_${chatId}`;
    const entry = this.messagesCache.get(key);
    if (entry && Array.isArray(entry.data)) {
      if (!entry.data.some((m) => m.id === message.id)) {
        entry.data.push(message);
        if (entry.data.length > 150) entry.data.shift();
      }
    }
  }

  // ================= 磁盘级头像与缩略图缓存 =================

  getAvatarPath(instId: string, chatId: number | string): string {
    return path.join(this.avatarsDir, `${instId}_${chatId}.jpg`);
  }

  getThumbPath(instId: string, chatId: number | string, messageId: number | string): string {
    return path.join(this.thumbsDir, `${instId}_${chatId}_${messageId}.jpg`);
  }

  hasCachedFile(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  }

  saveCachedFile(filePath: string, buffer: Buffer): void {
    try {
      this.ensureDirs();
      const parentDir = path.dirname(filePath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(filePath, buffer);
      this.pruneIfNeeded();
    } catch {
      /* ignore */
    }
  }

  saveFile(fromPath: string, toPath: string): boolean {
    try {
      if (!fs.existsSync(fromPath)) return false;
      this.ensureDirs();
      const parentDir = path.dirname(toPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.copyFileSync(fromPath, toPath);
      this.pruneIfNeeded();
      return true;
    } catch {
      return false;
    }
  }

  // ================= 统计与 LRU 自动淘汰 =================

  getStats(): CacheStats {
    let usedBytes = 0;
    let fileCount = 0;

    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          try {
            usedBytes += fs.statSync(full).size;
            fileCount++;
          } catch {
            /* ignore */
          }
        }
      }
    };

    scanDir(this.avatarsDir);
    scanDir(this.thumbsDir);
    scanDir(this.mediaDir);

    const usedMB = Math.round((usedBytes / (1024 * 1024)) * 10) / 10;
    const maxMB = Math.round((this.maxSizeBytes / (1024 * 1024)) * 10) / 10;
    const percent = Math.min(100, Math.round((usedBytes / this.maxSizeBytes) * 100));

    return {
      usedBytes,
      maxBytes: this.maxSizeBytes,
      usedMB,
      maxMB,
      percent,
      fileCount,
      memDialogsCount: this.dialogsCache.size,
      memChatsCount: this.messagesCache.size,
    };
  }

  pruneIfNeeded(): void {
    try {
      const stats = this.getStats();
      if (stats.usedBytes <= this.maxSizeBytes) return;

      // 超过限制，按最后修改/访问时间升序排，清理最老旧的文件直至达到 85% 水位
      const targetBytes = Math.floor(this.maxSizeBytes * 0.85);
      const files: { path: string; size: number; mtime: number }[] = [];

      const collectFiles = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isFile()) {
            try {
              const st = fs.statSync(full);
              files.push({ path: full, size: st.size, mtime: st.mtimeMs });
            } catch {
              /* ignore */
            }
          }
        }
      };

      collectFiles(this.thumbsDir);
      collectFiles(this.mediaDir);
      collectFiles(this.avatarsDir);

      files.sort((a, b) => a.mtime - b.mtime);

      let currentBytes = stats.usedBytes;
      for (const f of files) {
        if (currentBytes <= targetBytes) break;
        try {
          fs.unlinkSync(f.path);
          currentBytes -= f.size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  clearAll(): void {
    this.dialogsCache.clear();
    this.messagesCache.clear();

    const cleanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        try {
          fs.unlinkSync(path.join(dir, e));
        } catch {
          /* ignore */
        }
      }
    };

    cleanDir(this.avatarsDir);
    cleanDir(this.thumbsDir);
    cleanDir(this.mediaDir);
  }
}


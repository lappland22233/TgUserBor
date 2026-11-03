import type { Database } from '../database';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export class RateLimiter {
  private readonly memoryCache = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly db?: Database) {}

  check(userId: number, actionKey: string, options: RateLimitOptions): boolean {
    const key = `${userId}:${actionKey}`;
    const now = Date.now();
    const entry = this.memoryCache.get(key);

    if (!entry || now - entry.windowStart > options.windowMs) {
      this.memoryCache.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= options.maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  reset(userId: number, actionKey?: string): void {
    if (actionKey) {
      this.memoryCache.delete(`${userId}:${actionKey}`);
    } else {
      const prefix = `${userId}:`;
      for (const k of this.memoryCache.keys()) {
        if (k.startsWith(prefix)) this.memoryCache.delete(k);
      }
    }
  }
}


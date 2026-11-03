export interface ScopedScheduler {
  delay(ms: number, fn: () => void | Promise<void>): () => void;
  interval(ms: number, fn: () => void | Promise<void>): () => void;
  schedule(id: string, ms: number, fn: () => void | Promise<void>): void;
  cancel(id: string): boolean;
  clear(): void;
}

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scopes = new Map<string, Set<() => void>>();

  delay(ms: number, fn: () => void | Promise<void>): () => void {
    const handle = setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Scheduler task error:', err);
      }
    }, ms);

    return () => clearTimeout(handle);
  }

  interval(ms: number, fn: () => void | Promise<void>): () => void {
    const handle = setInterval(async () => {
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Scheduler interval task error:', err);
      }
    }, ms);

    return () => clearInterval(handle);
  }

  schedule(id: string, ms: number, fn: () => void | Promise<void>): void {
    this.cancel(id);
    const handle = setTimeout(async () => {
      this.timers.delete(id);
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Scheduler task [${id}] error:`, err);
      }
    }, ms);
    this.timers.set(id, handle);
  }

  cancel(id: string): boolean {
    const handle = this.timers.get(id);
    if (!handle) return false;
    clearTimeout(handle);
    this.timers.delete(id);
    return true;
  }

  createScope(scopeName: string): ScopedScheduler {
    const cleanups = new Set<() => void>();
    this.scopes.set(scopeName, cleanups);

    const scoped: ScopedScheduler = {
      delay: (ms: number, fn: () => void | Promise<void>) => {
        let active = true;
        let cancelFn: () => void;
        const wrapped = async () => {
          if (!active) return;
          cleanups.delete(cancelFn);
          await fn();
        };
        cancelFn = this.delay(ms, wrapped);
        cleanups.add(cancelFn);
        return () => {
          active = false;
          cleanups.delete(cancelFn);
          cancelFn();
        };
      },

      interval: (ms: number, fn: () => void | Promise<void>) => {
        const cancelFn = this.interval(ms, fn);
        cleanups.add(cancelFn);
        return () => {
          cleanups.delete(cancelFn);
          cancelFn();
        };
      },

      schedule: (id: string, ms: number, fn: () => void | Promise<void>) => {
        const fullId = `${scopeName}:${id}`;
        let active = true;
        const cancelFn = () => {
          active = false;
          this.cancel(fullId);
        };
        cleanups.add(cancelFn);

        this.schedule(fullId, ms, async () => {
          if (!active) return;
          cleanups.delete(cancelFn);
          await fn();
        });
      },

      cancel: (id: string) => {
        const fullId = `${scopeName}:${id}`;
        return this.cancel(fullId);
      },

      clear: () => {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            /* ignore */
          }
        }
        cleanups.clear();
        this.scopes.delete(scopeName);
      },
    };

    return scoped;
  }

  shutdown(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();

    for (const cleanups of this.scopes.values()) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
      cleanups.clear();
    }
    this.scopes.clear();
  }
}


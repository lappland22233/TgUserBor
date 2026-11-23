export interface ScopedScheduler {
  delay(ms: number, fn: () => void | Promise<void>): () => void;
  interval(ms: number, fn: () => void | Promise<void>): () => void;
  schedule(id: string, ms: number, fn: () => void | Promise<void>): void;
  cancel(id: string): boolean;
  clear(): void;
  dispose(): void;
}

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scopes = new Map<string, ScopedScheduler>();

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
    this.scopes.get(scopeName)?.dispose();
    const timers = new Set<() => void>();
    const namedTimers = new Map<string, () => void>();
    let active = true;

    const cancel = (id: string): boolean => {
      const cancelTimer = namedTimers.get(id);
      if (!cancelTimer) return false;
      namedTimers.delete(id);
      cancelTimer();
      return true;
    };

    const scoped: ScopedScheduler = {
      delay: (ms, fn) => {
        if (!active) return () => {};
        const cancelTimer = this.delay(ms, async () => {
          timers.delete(cancelTimer);
          await fn();
        });
        timers.add(cancelTimer);
        return () => {
          timers.delete(cancelTimer);
          cancelTimer();
        };
      },

      interval: (ms, fn) => {
        if (!active) return () => {};
        const cancelTimer = this.interval(ms, fn);
        timers.add(cancelTimer);
        return () => {
          timers.delete(cancelTimer);
          cancelTimer();
        };
      },

      schedule: (id, ms, fn) => {
        if (!active) return;
        cancel(id);
        const cancelTimer = this.delay(ms, async () => {
          namedTimers.delete(id);
          await fn();
        });
        namedTimers.set(id, cancelTimer);
      },

      cancel,

      clear: () => {
        for (const cancelTimer of timers) cancelTimer();
        for (const cancelTimer of namedTimers.values()) cancelTimer();
        timers.clear();
        namedTimers.clear();
      },

      dispose: () => {
        if (!active) return;
        active = false;
        scoped.clear();
        this.scopes.delete(scopeName);
      },
    };

    this.scopes.set(scopeName, scoped);
    return scoped;
  }

  shutdown(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();

    for (const scope of this.scopes.values()) scope.dispose();
  }
}


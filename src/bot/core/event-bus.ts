import { EventEmitter } from 'events';

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface ListenerHandle {
  off(): void;
}

/**
 * Lightweight typed pub/sub used by the framework to fan out adapter events
 * to plugins. Plugins get a scoped bus, so listeners leak only within the plugin.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly wildcard = Symbol('wildcard');

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): ListenerHandle {
    this.emitter.on(event, handler as EventHandler);
    return {
      off: () => this.emitter.off(event, handler as EventHandler),
    };
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): ListenerHandle {
    const wrapped = ((payload: T) => {
      this.emitter.off(event, wrapped as EventHandler);
      void handler(payload);
    }) as EventHandler;
    this.emitter.on(event, wrapped);
    return { off: () => this.emitter.off(event, wrapped as EventHandler) };
  }

  onAny(handler: EventHandler<{ event: string; payload: unknown }>): ListenerHandle {
    this.emitter.on(this.wildcard, handler as EventHandler);
    return { off: () => this.emitter.off(this.wildcard, handler as EventHandler) };
  }

  emit<T = unknown>(event: string, payload: T): void {
    this.emitter.emit(event, payload);
    this.emitter.emit(this.wildcard, { event, payload });
  }

  removeAll(event?: string): void {
    if (event) this.emitter.removeAllListeners(event);
    else this.emitter.removeAllListeners();
  }
}

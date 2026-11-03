import type { BotAdapter, IncomingMessage } from '../adapter';
import type { EventBus, ListenerHandle } from '../core/event-bus';
import type { FilterFn } from '../filters';

export class Conversation {
  private active = true;
  private pendingListener?: ListenerHandle;

  constructor(
    private readonly chatId: number,
    private readonly userId: number,
    private readonly adapter: BotAdapter,
    private readonly bus: EventBus,
  ) {}

  async ask(prompt: string, timeoutMs = 60000): Promise<IncomingMessage> {
    if (!this.active) throw new Error('Conversation has ended');
    await this.adapter.sendMessage(this.chatId, prompt);
    return this.waitFor(() => true, timeoutMs);
  }

  async waitFor(filter?: FilterFn, timeoutMs = 60000): Promise<IncomingMessage> {
    if (!this.active) throw new Error('Conversation has ended');

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (this.pendingListener) {
          this.pendingListener.off();
          this.pendingListener = undefined;
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Conversation timed out'));
      }, timeoutMs);

      this.pendingListener = this.bus.on<IncomingMessage>('message', (msg) => {
        if (!this.active) {
          cleanup();
          return reject(new Error('Conversation has ended'));
        }
        if (msg.chat.id !== this.chatId) return;
        if (msg.from.id !== this.userId) return;

        if (!filter || filter(msg)) {
          cleanup();
          resolve(msg);
        }
      });
    });
  }

  end(): void {
    this.active = false;
    if (this.pendingListener) {
      this.pendingListener.off();
      this.pendingListener = undefined;
    }
  }
}


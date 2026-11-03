import type { IncomingMessage } from '../adapter';

export type MiddlewareFn = (msg: IncomingMessage, next: () => Promise<void>) => Promise<void> | void;

export class MiddlewareChain {
  private readonly middlewares: MiddlewareFn[] = [];

  use(fn: MiddlewareFn): void {
    this.middlewares.push(fn);
  }

  async run(msg: IncomingMessage, terminal: () => Promise<void>): Promise<void> {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;

      const fn = this.middlewares[i];
      if (fn) {
        await fn(msg, () => dispatch(i + 1));
      } else {
        await terminal();
      }
    };

    await dispatch(0);
  }
}


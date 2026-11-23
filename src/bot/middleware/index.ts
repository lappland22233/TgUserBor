import type { IncomingMessage } from '../adapter';

export type MiddlewareFn = (msg: IncomingMessage, next: () => Promise<void>) => Promise<void> | void;

export class MiddlewareChain {
  private middlewares: Array<{ fn: MiddlewareFn }> = [];

  use(fn: MiddlewareFn): () => void {
    const entry = { fn };
    this.middlewares = [...this.middlewares, entry];
    return () => {
      this.middlewares = this.middlewares.filter((middleware) => middleware !== entry);
    };
  }

  async run(msg: IncomingMessage, terminal: () => Promise<void>): Promise<void> {
    const middlewares = this.middlewares;
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;

      const fn = middlewares[i]?.fn;
      if (fn) {
        await fn(msg, () => dispatch(i + 1));
      } else {
        await terminal();
      }
    };

    await dispatch(0);
  }
}

import type { IncomingMessage } from '../adapter';

export type FilterFn = (msg: IncomingMessage) => boolean;

export const Filters = {
  text: (pattern?: string | RegExp): FilterFn => (msg) => {
    if (!msg.text) return false;
    if (!pattern) return Boolean(msg.text.trim());
    if (typeof pattern === 'string') return msg.text.includes(pattern);
    return pattern.test(msg.text);
  },

  command: (name?: string): FilterFn => (msg) => {
    const text = msg.text?.trim() ?? '';
    if (!text.startsWith('.') && !text.startsWith('/')) return false;
    if (!name) return true;
    const cmd = text.slice(1).split(/\s+/)[0]?.toLowerCase();
    return cmd === name.toLowerCase();
  },

  photo: (): FilterFn => (msg) => msg.media?.type === 'photo',
  video: (): FilterFn => (msg) => msg.media?.type === 'video',
  audio: (): FilterFn => (msg) => msg.media?.type === 'audio',
  document: (): FilterFn => (msg) => msg.media?.type === 'document',
  voice: (): FilterFn => (msg) => msg.media?.type === 'voice',
  sticker: (): FilterFn => (msg) => msg.media?.type === 'sticker',
  animation: (): FilterFn => (msg) => msg.media?.type === 'animation',

  media: (): FilterFn => (msg) => Boolean(msg.media),

  reply: (): FilterFn => (msg) => Boolean(msg.isReply),
  outgoing: (): FilterFn => (msg) => Boolean(msg.outgoing),
  incoming: (): FilterFn => (msg) => !msg.outgoing,

  private: (): FilterFn => (msg) => msg.chat.type === 'private',
  group: (): FilterFn => (msg) => msg.chat.type === 'group' || msg.chat.type === 'supergroup',
  channel: (): FilterFn => (msg) => msg.chat.type === 'channel',

  user: (idOrUsername: number | string): FilterFn => (msg) => {
    if (typeof idOrUsername === 'number') {
      return msg.from.id === idOrUsername;
    }
    const clean = idOrUsername.replace(/^@/, '').toLowerCase();
    return msg.from.username?.toLowerCase() === clean;
  },

  and: (...fns: FilterFn[]): FilterFn => (msg) => fns.every((fn) => fn(msg)),
  or: (...fns: FilterFn[]): FilterFn => (msg) => fns.some((fn) => fn(msg)),
  not: (fn: FilterFn): FilterFn => (msg) => !fn(msg),
};


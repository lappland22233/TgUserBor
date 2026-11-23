import type { IncomingMessage } from '../adapter';

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
  message: IncomingMessage;
}

export interface CommandArgDefinition {
  name: string;
  type?: string; // e.g. 'string' | 'number' | 'cron' | 'duration' | 'user' | 'boolean'
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface CommandDefinition {
  name: string;
  description?: string;
  usage?: string;
  args?: CommandArgDefinition[];
  examples?: string[];
  aliases?: string[];
  category?: string;
  /** Higher = runs later. Default 0. */
  priority?: number;
}

export interface CommandContext {
  command: ParsedCommand;
  reply: (text: string, options?: import('../adapter').SendOptions) => Promise<void>;
  replyHtml: (text: string, options?: import('../adapter').SendOptions) => Promise<void>;
  editOrReply: (text: string, options?: import('../adapter').SendOptions) => Promise<void>;
  bot: import('../core/bot').Bot;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;

export class CommandRegistry {
  private readonly commands = new Map<string, { def: CommandDefinition; handler: CommandHandler; plugin: string }>();
  private readonly aliases = new Map<string, string>();

  register(plugin: string, def: CommandDefinition, handler: CommandHandler): void {
    const key = def.name.toLowerCase();
    const existing = this.commands.get(key);
    if (existing) {
      throw new Error(`command "${def.name}" already registered (by plugin "${existing.plugin}")`);
    }
    if (this.aliases.has(key)) throw new Error(`command "${def.name}" conflicts with a registered alias`);

    const aliases = new Set<string>();
    if (Array.isArray(def.aliases)) {
      for (const alias of def.aliases) {
        if (typeof alias === 'string') aliases.add(alias.trim().toLowerCase());
      }
    }
    aliases.delete('');
    aliases.delete(key);
    for (const alias of aliases) this.checkAlias(alias, key);

    this.commands.set(key, { def, handler, plugin });
    for (const alias of aliases) this.aliases.set(alias, key);
  }

  alias(name: string, target: string): void {
    const key = name.trim().toLowerCase();
    const targetKey = target.trim().toLowerCase();
    if (!key || key === targetKey) return;
    this.checkAlias(key, targetKey);
    this.aliases.set(key, targetKey);
  }

  unregister(plugin: string): void {
    for (const [alias, target] of this.aliases) {
      if (this.commands.get(target)?.plugin === plugin) this.aliases.delete(alias);
    }
    for (const [key, entry] of this.commands) {
      if (entry.plugin === plugin) this.commands.delete(key);
    }
  }

  private checkAlias(key: string, target: string): void {
    if (this.commands.has(key)) throw new Error(`alias "${key}" conflicts with a registered command`);
    const existing = this.aliases.get(key);
    if (existing !== undefined && existing !== target) {
      throw new Error(`alias "${key}" already registered for command "${existing}"`);
    }
  }

  resolve(name: string): { def: CommandDefinition; handler: CommandHandler; plugin: string } | undefined {
    const lower = name.toLowerCase();
    const aliased = this.aliases.get(lower) ?? lower;
    return this.commands.get(aliased);
  }

  list(): Array<{
    name: string;
    plugin: string;
    description?: string;
    usage?: string;
    args?: CommandArgDefinition[];
    examples?: string[];
    aliases?: string[];
    category?: string;
  }> {
    return Array.from(this.commands.values()).map(({ def, plugin }) => ({
      name: def.name,
      plugin,
      description: def.description,
      usage: def.usage,
      args: def.args,
      examples: def.examples,
      aliases: def.aliases,
      category: def.category,
    }));
  }
}

export class CommandParser {
  private readonly effectivePrefixes: string[];

  constructor(prefixes: string[]) {
    const set = new Set<string>();
    for (const p of prefixes) {
      if (p && p.trim()) set.add(p.trim());
    }
    // By default support both '.' and '/' for seamless user experience
    set.add('.');
    set.add('/');
    this.effectivePrefixes = Array.from(set);
  }

  parse(message: IncomingMessage): ParsedCommand | undefined {
    const text = message.text ?? '';
    if (!text) return undefined;

    for (const prefix of this.effectivePrefixes) {
      if (!text.startsWith(prefix)) continue;
      const body = text.slice(prefix.length);
      const headEnd = body.search(/\s/);
      const rawName = (headEnd === -1 ? body : body.slice(0, headEnd)).trim();
      // Forgive compound prefixes like "/.ping" or "..ping"
      const name = rawName.replace(/^[./!]+/, '').trim();
      if (!name) continue;
      const rawArgs = headEnd === -1 ? '' : body.slice(headEnd + 1).trim();
      return {
        name,
        args: tokenize(rawArgs),
        rawArgs,
        message,
      };
    }
    return undefined;
  }
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

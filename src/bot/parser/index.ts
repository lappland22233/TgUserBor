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
    if (this.commands.has(key)) {
      throw new Error(`command "${def.name}" already registered (by plugin "${this.commands.get(key)!.plugin}")`);
    }
    this.commands.set(key, { def, handler, plugin });

    if (Array.isArray(def.aliases)) {
      for (const a of def.aliases) {
        if (a && a.trim()) {
          this.alias(a.trim(), def.name);
        }
      }
    }
  }

  alias(name: string, target: string): void {
    this.aliases.set(name.toLowerCase(), target.toLowerCase());
  }

  unregister(plugin: string): void {
    for (const [key, entry] of this.commands) {
      if (entry.plugin === plugin) this.commands.delete(key);
    }
    for (const [alias, target] of this.aliases) {
      const owner = this.commands.get(target)?.plugin;
      if (owner === plugin) this.aliases.delete(alias);
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

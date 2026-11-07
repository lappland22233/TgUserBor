import bigInt from 'big-integer';
import { Api } from 'telegram';

function isSingleEmojiLabel(value: string): boolean {
  if (!value || value.length > 32 || /\s/u.test(value) || !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value)) return false;
  try { return [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)].length === 1; }
  catch { return [...value].length <= 8; }
}

/** Parse only custom-emoji tokens, preserving all other text literally. */
export function parseCustomEmojiMarkup(source: string): [string, Api.TypeMessageEntity[]] {
  const entities: Api.TypeMessageEntity[] = [];
  const token = /\[([^\]\r\n]{1,32})\]\(tg:\/\/emoji\?id=([1-9]\d{0,19})\)/g;
  let text = '';
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    const start = match.index ?? 0;
    text += source.slice(cursor, start);
    const label = match[1];
    if (!isSingleEmojiLabel(label)) {
      text += match[0];
    } else {
      const offset = text.length;
      text += label;
      entities.push(new Api.MessageEntityCustomEmoji({ offset, length: label.length, documentId: bigInt(match[2]) }));
    }
    cursor = start + match[0].length;
  }
  text += source.slice(cursor);
  return [text, entities];
}

/**
 * Parse the markup produced by the web message editor into Telegram entities.
 * Offsets are JavaScript string lengths, which match Telegram's UTF-16 units.
 * Unmatched delimiters stay in the message and code contents are literal.
 */
export function parseEditorMarkdown(source: string): [string, Api.TypeMessageEntity[]] {
  let text = '';
  const entities: Api.TypeMessageEntity[] = [];

  const findClosing = (value: string, delimiter: string, start: number): number => {
    for (let i = start; i <= value.length - delimiter.length; i++) {
      if (value[i] === '\\') { i++; continue; }
      if (value.startsWith(delimiter, i)) return i;
    }
    return -1;
  };

  const parse = (value: string): void => {
    for (let i = 0; i < value.length;) {
      if (value[i] === '\\' && i + 1 < value.length && /[\\*_|~`[\]()<>]/.test(value[i + 1])) {
        text += value[i + 1];
        i += 2;
        continue;
      }

      if (value[i] === '>' && (i === 0 || value[i - 1] === '\n')) {
        const offset = text.length;
        let cursor = i;
        while (cursor < value.length && value[cursor] === '>' && (cursor === 0 || value[cursor - 1] === '\n')) {
          cursor++;
          if (value[cursor] === ' ') cursor++;
          const newline = value.indexOf('\n', cursor);
          const lineEnd = newline === -1 ? value.length : newline;
          parse(value.slice(cursor, lineEnd));
          if (newline === -1) { cursor = value.length; break; }
          const nextLine = newline + 1;
          if (nextLine < value.length && value[nextLine] === '>') {
            text += '\n';
            cursor = nextLine;
          } else {
            cursor = newline;
            break;
          }
        }
        const length = text.length - offset;
        if (length) entities.push(new Api.MessageEntityBlockquote({ offset, length, collapsed: false }));
        i = cursor;
        continue;
      }

      // Code is handled before inline markup and is never parsed recursively.
      const codeDelimiter = value.startsWith('```', i) ? '```' : value[i] === '`' ? '`' : null;
      if (codeDelimiter) {
        const close = findClosing(value, codeDelimiter, i + codeDelimiter.length);
        if (close !== -1) {
          let content = value.slice(i + codeDelimiter.length, close);
          if (codeDelimiter === '```') {
            // The editor inserts one line break around the selected block.
            if (content.startsWith('\n') && content.endsWith('\n') && content.length >= 2) {
              content = content.slice(1, -1);
            }
          }
          const offset = text.length;
          text += content;
          if (content.length) {
            entities.push(codeDelimiter === '```'
              ? new Api.MessageEntityPre({ offset, length: content.length, language: '' })
              : new Api.MessageEntityCode({ offset, length: content.length }));
          }
          i = close + codeDelimiter.length;
          continue;
        }
      }

      if (value[i] === '[') {
        const labelEnd = findClosing(value, '](', i + 1);
        const urlEnd = labelEnd === -1 ? -1 : findClosing(value, ')', labelEnd + 2);
        if (labelEnd > i + 1 && urlEnd > labelEnd + 2) {
          const label = value.slice(i + 1, labelEnd);
          const url = value.slice(labelEnd + 2, urlEnd);
          const offset = text.length;
          const customEmoji = /^tg:\/\/emoji\?id=([1-9]\d{0,19})$/.exec(url);
          const validCustomEmoji = Boolean(customEmoji && isSingleEmojiLabel(label));
          if (validCustomEmoji) {
            text += label;
            entities.push(new Api.MessageEntityCustomEmoji({ offset, length: label.length, documentId: bigInt(customEmoji![1]) }));
          } else {
            parse(label);
          }
          if (!validCustomEmoji && text.length > offset) {
            entities.push(new Api.MessageEntityTextUrl({ offset, length: text.length - offset, url }));
          }
          i = urlEnd + 1;
          continue;
        }
      }

      const mark = value.startsWith('**', i) ? { open: '**', close: '**', type: 'bold' }
        : value.startsWith('__', i) ? { open: '__', close: '__', type: 'italic' }
        : value.startsWith('~~', i) ? { open: '~~', close: '~~', type: 'strike' }
        : value.startsWith('||', i) ? { open: '||', close: '||', type: 'spoiler' }
        : value.startsWith('<u>', i) ? { open: '<u>', close: '</u>', type: 'underline' }
        : null;
      if (mark) {
        const close = findClosing(value, mark.close, i + mark.open.length);
        if (close !== -1) {
          const offset = text.length;
          parse(value.slice(i + mark.open.length, close));
          const length = text.length - offset;
          if (length) {
            const range = { offset, length };
            if (mark.type === 'bold') entities.push(new Api.MessageEntityBold(range));
            else if (mark.type === 'italic') entities.push(new Api.MessageEntityItalic(range));
            else if (mark.type === 'strike') entities.push(new Api.MessageEntityStrike(range));
            else if (mark.type === 'spoiler') entities.push(new Api.MessageEntitySpoiler(range));
            else entities.push(new Api.MessageEntityUnderline(range));
          }
          i = close + mark.close.length;
          continue;
        }
      }
      text += value[i++];
    }
  };

  parse(source);
  // Telegram does not allow code/pre entities to overlap other formatting.
  // Keep the code entity and drop overlapping decoration rather than sending
  // an invalid entity set. Other fully nested formatting remains supported.
  const code = entities.filter(entity => entity instanceof Api.MessageEntityCode || entity instanceof Api.MessageEntityPre);
  const safeEntities = entities.filter(entity => entity instanceof Api.MessageEntityCode || entity instanceof Api.MessageEntityPre || !code.some(block =>
    entity.offset < block.offset + block.length && block.offset < entity.offset + entity.length));
  safeEntities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return [text, safeEntities];
}

// GramJS accepts a custom parser with both methods. Outgoing messages only use parse.
export const editorMarkdownParser = {
  parse: parseEditorMarkdown,
  unparse: (text: string): string => text,
};

export const customEmojiParser = {
  parse: parseCustomEmojiMarkup,
  unparse: (text: string): string => text,
};

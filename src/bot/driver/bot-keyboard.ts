import { Api } from 'telegram';
import type { BotKeyboardButton, BotPeerRequest, BotReplyKeyboard } from '../adapter/types';

function mapBotPeerRequest(button: Api.KeyboardButtonRequestPeer): BotPeerRequest | undefined {
  const maxQuantity = Math.max(1, Math.min(10, Number(button.maxQuantity) || 1));
  const rights = (value: any): string[] => Object.keys(value?.pFlags || {}).filter(key => value.pFlags[key] === true).slice(0, 32);
  const bool = (value: any, key: string): Record<string, boolean> => typeof value?.[key] === 'boolean' ? { [key]: value[key] } : {};
  const type = button.peerType;
  if (type instanceof Api.RequestPeerTypeUser) return { kind: 'user', maxQuantity, ...bool(type, 'bot'), ...bool(type, 'premium') };
  if (type instanceof Api.RequestPeerTypeChat) return {
    kind: 'group', maxQuantity, ...bool(type, 'creator'), ...bool(type, 'botParticipant'),
    ...bool(type, 'hasUsername'), ...bool(type, 'forum'), botAdminRights: rights(type.botAdminRights),
  };
  if (type instanceof Api.RequestPeerTypeBroadcast) return {
    kind: 'broadcast', maxQuantity, ...bool(type, 'creator'), ...bool(type, 'hasUsername'), botAdminRights: rights(type.botAdminRights),
  };
  return undefined;
}

/** Map only inline keyboards; callback data remains server side. */
export function mapBotKeyboard(markup: Api.TypeReplyMarkup | undefined): BotKeyboardButton[][] | undefined {
  if (!(markup instanceof Api.ReplyInlineMarkup)) return undefined;
  return markup.rows.slice(0, 32).map((row, rowIndex) => row.buttons.slice(0, 16).map((button, columnIndex) => {
    const base = { text: String(button.text || '').slice(0, 256), row: rowIndex, column: columnIndex };
    if (button instanceof Api.KeyboardButtonUrl) return { ...base, type: 'url' as const, url: button.url };
    if (button instanceof Api.KeyboardButtonUrlAuth) return { ...base, type: 'url_auth' as const };
    if (button instanceof Api.KeyboardButtonCallback && !button.requiresPassword) return { ...base, type: 'callback' as const };
    if (button instanceof Api.KeyboardButtonGame) return { ...base, type: 'game' as const };
    if (button instanceof Api.KeyboardButtonSimpleWebView) return { ...base, type: 'simple_web_app' as const };
    if (button instanceof Api.KeyboardButtonWebView) return { ...base, type: 'web_app' as const };
    if (button instanceof Api.KeyboardButtonCopy) return { ...base, type: 'copy' as const, copyText: String(button.copyText || '').slice(0, 4096) };
    if (button instanceof Api.KeyboardButtonRequestPeer) {
      const peerRequest = mapBotPeerRequest(button);
      if (peerRequest) return { ...base, type: 'request_peer' as const, peerRequest };
    }
    if (button instanceof Api.KeyboardButtonUserProfile) {
      const userId = Number(button.userId);
      if (Number.isSafeInteger(userId) && userId > 0) return { ...base, type: 'user_profile' as const, userId };
    }
    return { ...base, type: 'unsupported' as const };
  }));
}

/** Only plain text reply buttons are actionable; sensitive requests are explicit. */
export function mapBotReplyKeyboard(markup: Api.TypeReplyMarkup | undefined): BotReplyKeyboard | undefined {
  if (markup instanceof Api.ReplyKeyboardHide) return { type: 'hide', selective: Boolean(markup.selective) };
  if (markup instanceof Api.ReplyKeyboardForceReply) return {
    type: 'force', singleUse: Boolean(markup.singleUse), selective: Boolean(markup.selective),
    placeholder: typeof markup.placeholder === 'string' ? markup.placeholder.slice(0, 64) : undefined,
  };
  if (!(markup instanceof Api.ReplyKeyboardMarkup)) return undefined;
  const rows = markup.rows.slice(0, 32).map((row, rowIndex) => row.buttons.slice(0, 16).map((button, columnIndex) => {
    const text = String(button.text || '').slice(0, 256);
    const position = { row: rowIndex, column: columnIndex };
    if (button instanceof Api.KeyboardButton) return { text, ...position, type: 'text' as const };
    if (button instanceof Api.KeyboardButtonRequestPhone) return { text, ...position, type: 'request_phone' as const };
    if (button instanceof Api.KeyboardButtonRequestGeoLocation) return { text, ...position, type: 'request_location' as const };
    if (button instanceof Api.KeyboardButtonRequestPoll) return { text, ...position, type: 'request_poll' as const, quiz: typeof button.quiz === 'boolean' ? button.quiz : undefined };
    if (button instanceof Api.KeyboardButtonRequestPeer) {
      const peerRequest = mapBotPeerRequest(button);
      if (peerRequest) return { text, ...position, type: 'request_peer' as const, peerRequest };
    }
    if (button instanceof Api.KeyboardButtonSimpleWebView) return { text, ...position, type: 'simple_web_app' as const };
    if (button instanceof Api.KeyboardButtonUserProfile) {
      const userId = Number(button.userId);
      if (Number.isSafeInteger(userId) && userId > 0) return { text, ...position, type: 'user_profile' as const, userId };
    }
    const kind = button.className;
    return { text, ...position, type: 'unsupported' as const, reason: '该按钮类型暂不支持' };
  }));
  return { type: 'keyboard', rows, singleUse: Boolean(markup.singleUse), selective: Boolean(markup.selective) };
}

/** Re-read the original button so a browser cannot supply arbitrary callback bytes. */
export function getBotCallbackData(markup: Api.TypeReplyMarkup | undefined, row: number, column: number): Buffer {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= 32 || column < 0 || column >= 16 || !(markup instanceof Api.ReplyInlineMarkup)) {
    throw new Error('无效的机器人按钮');
  }
  const button = markup.rows[row]?.buttons[column];
  if (!(button instanceof Api.KeyboardButtonCallback) || button.requiresPassword || !Buffer.isBuffer(button.data) || button.data.length > 64) {
    throw new Error('该机器人按钮不可用或需要额外验证');
  }
  return button.data;
}

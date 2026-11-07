import { randomBytes } from 'crypto';
import { Api, TelegramClient } from 'telegram';

const MAX_ACTIVE = 8;
const SESSION_TTL_MS = 120_000;

type PendingInvoice = { token: string; slug: string; formId: any; invoice: Api.InputInvoiceSlug; stars: string; title: string; description: string; expiresAt: number };
type Session = { peer: any; bot: any; botId: string; accountId: string; queryId?: any; simpleWebView: boolean; buttonText: string; expiresAt: number; timer?: NodeJS.Timeout; pendingCustomMethods?: number; phoneRequestPending?: boolean; invoicePreparing?: boolean; pendingInvoice?: PendingInvoice };

/** In-memory, worker-local capabilities. URLs and query IDs are never logged. */
export class MiniAppSessions {
  private readonly sessions = new Map<string, Session>();
  private pending = 0;
  private generation = 0;
  constructor(private readonly client: TelegramClient, private readonly accountId?: number) {}

  async open(chatId: number, messageId: number, row: number, column: number): Promise<{ capability: string; url: string; botId: string; accountId: string; simpleWebView: boolean; buttonText: string }> {
    if (!Number.isSafeInteger(chatId) || !chatId || !Number.isSafeInteger(messageId) || messageId <= 0 ||
        !Number.isInteger(row) || row < 0 || row >= 32 || !Number.isInteger(column) || column < 0 || column >= 16) {
      throw new Error('无效的 Mini App 按钮');
    }
    this.purgeExpired();
    if (this.sessions.size + this.pending >= MAX_ACTIVE) throw new Error('打开的 Mini App 过多');
    this.pending++;
    const generation = this.generation;
    try {
      const peer = await this.client.getInputEntity(chatId);
      const messages = await this.client.getMessages(peer, { ids: [messageId] });
      const message = messages[0];
      if (!message || message.id !== messageId ||
          (!(message.replyMarkup instanceof Api.ReplyInlineMarkup) && !(message.replyMarkup instanceof Api.ReplyKeyboardMarkup))) throw new Error('机器人消息不可用');
      const button = message.replyMarkup.rows[row]?.buttons[column];
      const simpleWebView = button instanceof Api.KeyboardButtonSimpleWebView;
      if (!(button instanceof Api.KeyboardButtonWebView) && !simpleWebView) throw new Error('该 Mini App 按钮不可用');
      // Inline-bot messages can be sent on behalf of a bot; otherwise the sender
      // must itself be a bot. Never accept a bot identity or URL from the page.
      const sender = message.viaBotId ? await this.client.getEntity(message.viaBotId) : await message.getSender();
      if (!(sender instanceof Api.User) || !sender.bot) throw new Error('无法确认机器人身份');
      const bot = await this.client.getInputEntity(sender);
      const result = simpleWebView
        ? await this.client.invoke(new Api.messages.RequestSimpleWebView({ bot, url: button.url, platform: 'web' }))
        : await this.client.invoke(new Api.messages.RequestWebView({ peer, bot, url: button.url, platform: 'web' }));
      if (generation !== this.generation) throw new Error('Mini App 会话已结束');
      if (!(result instanceof Api.WebViewResultUrl) || !isSafeMiniAppUrl(result.url) ||
          (!simpleWebView && (!result.queryId || String(result.queryId) === '0'))) {
        throw new Error('Telegram 未返回可用的 Mini App 会话');
      }
      const capability = randomBytes(32).toString('base64url');
      const botId = String(sender.id);
      const accountId = Number.isSafeInteger(this.accountId) && Number(this.accountId) > 0 ? String(this.accountId) : '';
      const buttonText = String(button.text || '').trim().slice(0, 64);
      const session: Session = { peer, bot, botId, accountId, queryId: result.queryId, simpleWebView, buttonText,
        expiresAt: Date.now() + (simpleWebView ? 30 * 60_000 : SESSION_TTL_MS) };
      this.sessions.set(capability, session);
      this.refreshExpiry(capability, session);
      return { capability, url: result.url, botId, accountId, simpleWebView, buttonText };
    } finally { this.pending--; }
  }

  async getBotMenuButton(chatId: number): Promise<{ available: boolean; text?: string }> {
    const menu = await this.readBotMenuButton(chatId);
    return menu ? { available: true, text: menu.button.text.trim().slice(0, 64) || '菜单' } : { available: false };
  }

  async openBotMenu(chatId: number): Promise<{ capability: string; url: string; botId: string; accountId: string; simpleWebView: false; buttonText: string }> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('Invalid bot menu peer');
    this.purgeExpired();
    if (this.sessions.size + this.pending >= MAX_ACTIVE) throw new Error('打开的 Mini App 过多');
    this.pending++;
    const generation = this.generation;
    try {
      const menu = await this.readBotMenuButton(chatId);
      if (!menu) throw new Error('机器人没有可用的菜单 Mini App');
      const result = await this.client.invoke(new Api.messages.RequestWebView({
        fromBotMenu: true, peer: menu.peer, bot: menu.bot, url: menu.button.url, platform: 'web',
      }));
      if (generation !== this.generation) throw new Error('Mini App 会话已结束');
      if (!(result instanceof Api.WebViewResultUrl) || !isSafeMiniAppUrl(result.url) || !result.queryId || String(result.queryId) === '0') {
        throw new Error('Telegram 未返回可用的 Mini App 会话');
      }
      const capability = randomBytes(32).toString('base64url');
      const botId = String(menu.entity.id);
      const accountId = Number.isSafeInteger(this.accountId) && Number(this.accountId) > 0 ? String(this.accountId) : '';
      const buttonText = String(menu.button.text || '').trim().slice(0, 64) || '菜单';
      const session: Session = { peer: menu.peer, bot: menu.bot, botId, accountId, queryId: result.queryId,
        simpleWebView: false, buttonText, expiresAt: Date.now() + SESSION_TTL_MS };
      this.sessions.set(capability, session);
      this.refreshExpiry(capability, session);
      return { capability, url: result.url, botId, accountId, simpleWebView: false, buttonText };
    } finally { this.pending--; }
  }

  private async readBotMenuButton(chatId: number): Promise<{ peer: any; bot: any; entity: Api.User; button: Api.BotMenuButton } | undefined> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('Invalid bot menu peer');
    const peer = await this.client.getInputEntity(chatId);
    const entity = await this.client.getEntity(peer);
    if (!(entity instanceof Api.User) || !entity.bot) return undefined;
    const bot = await this.client.getInputEntity(entity);
    if (!(bot instanceof Api.InputPeerUser) || String(bot.userId) !== String(entity.id)) return undefined;
    const userId = new Api.InputUser({ userId: bot.userId, accessHash: bot.accessHash });
    const button = await this.client.invoke(new Api.bots.GetBotMenuButton({ userId })) as any;
    if (!(button instanceof Api.BotMenuButton) || typeof button.text !== 'string' || !button.text.trim() || !isSafeMiniAppUrl(button.url)) return undefined;
    return { peer, bot, entity, button };
  }

  async prolong(capability: string): Promise<void> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session) throw new Error('Mini App 会话已过期');
    if (session.simpleWebView || !session.queryId) throw new Error('此 Mini App 不支持续期');
    try {
      const result = await this.client.invoke(new Api.messages.ProlongWebView({ peer: session.peer, bot: session.bot, queryId: session.queryId }));
      if (!result) throw new Error('Session ended');
      if (this.sessions.get(capability) === session) this.refreshExpiry(capability, session);
    } catch {
      this.close(capability);
      throw new Error('Mini App 会话已结束');
    }
  }

  async invokeCustomMethod(capability: string, method: string, paramsJson: string): Promise<string> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session || typeof method !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(method) ||
        typeof paramsJson !== 'string' || Buffer.byteLength(paramsJson, 'utf8') > 4096) {
      throw new Error('Mini App custom method is invalid');
    }
    try { JSON.parse(paramsJson); } catch { throw new Error('Mini App custom method parameters are invalid'); }
    session.pendingCustomMethods = Number(session.pendingCustomMethods) || 0;
    if (session.pendingCustomMethods >= 4) throw new Error('Too many Mini App requests');
    session.pendingCustomMethods++;
    try {
      const result = await this.client.invoke(new Api.bots.InvokeWebViewCustomMethod({
        bot: session.bot,
        customMethod: method,
        params: new Api.DataJSON({ data: paramsJson }),
      }));
      if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
      if (!(result instanceof Api.DataJSON) || typeof result.data !== 'string' || Buffer.byteLength(result.data, 'utf8') > 8192) {
        throw new Error('Telegram returned an invalid Mini App response');
      }
      return result.data;
    } finally { session.pendingCustomMethods = Math.max(0, session.pendingCustomMethods - 1); }
  }

  async sendWebViewData(capability: string, data: string): Promise<void> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session || !session.simpleWebView || typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 4096) {
      throw new Error('Mini App data is invalid');
    }
    await this.client.invoke(new Api.messages.SendWebViewData({
      bot: session.bot,
      buttonText: session.buttonText,
      data,
      randomId: randomBytes(8).readBigInt64LE() as any,
    }));
    if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
  }

  async canBotSendMessages(capability: string): Promise<boolean> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session) throw new Error('Mini App 会话已过期');
    const result = await this.client.invoke(new Api.bots.CanSendMessage({ bot: session.bot }));
    if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App 会话已结束');
    return result === true;
  }

  async checkDownloadFile(capability: string, fileName: string, url: string): Promise<boolean> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session) throw new Error('Mini App session ended');
    const safeName = typeof fileName === 'string' ? fileName.trim() : '';
    if (!safeName || safeName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(safeName) || !isSafeMiniAppUrl(url)) {
      throw new Error('Mini App download request is invalid');
    }
    const allowed = await this.client.invoke(new Api.bots.CheckDownloadFileParams({
      bot: session.bot,
      fileName: safeName,
      url,
    }));
    if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
    return allowed === true;
  }

  async allowBotSendMessages(capability: string): Promise<void> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session) throw new Error('Mini App 会话已过期');
    const allowed = await this.client.invoke(new Api.bots.CanSendMessage({ bot: session.bot }));
    if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App 会话已结束');
    if (allowed !== true) await this.client.invoke(new Api.bots.AllowSendMessage({ bot: session.bot }));
    if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App 会话已结束');
  }

  async requestPhone(capability: string): Promise<void> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session) throw new Error('Mini App 会话已过期');
    if (session.phoneRequestPending) throw new Error('Phone request already pending');
    session.phoneRequestPending = true;
    try {
      const self = await this.client.getMe();
      const phone = typeof self?.phone === 'string' ? self.phone.trim() : '';
      if (!/^\+?[0-9 ()-]{3,32}$/.test(phone) || phone.replace(/\D/g, '').length < 3 || !self.firstName) {
        throw new Error('The current Telegram account has no shareable phone number');
      }
      if (!(session.bot instanceof Api.InputPeerUser)) throw new Error('Mini App bot identity is unavailable');
      const botUser = new Api.InputUser({ userId: session.bot.userId, accessHash: session.bot.accessHash });
      await this.client.invoke(new Api.contacts.Unblock({ id: botUser }));
      if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
      await this.client.invoke(new Api.messages.SendMedia({
        peer: session.bot,
        media: new Api.InputMediaContact({ phoneNumber: phone, firstName: self.firstName, lastName: self.lastName || '', vcard: '' }),
        message: '',
        randomId: randomBytes(8).readBigInt64LE() as any,
      }));
      if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
    } finally { session.phoneRequestPending = false; }
  }

  async prepareInvoice(capability: string, slug: string): Promise<{ token: string; stars: string; title: string; description: string }> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session || typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(slug)) throw new Error('Mini App invoice is invalid');
    if (session.invoicePreparing || (session.pendingInvoice && session.pendingInvoice.expiresAt > Date.now())) {
      throw new Error('A Mini App invoice is already awaiting confirmation');
    }
    session.pendingInvoice = undefined;
    session.invoicePreparing = true;
    try {
      const invoice = new Api.InputInvoiceSlug({ slug });
      const form = await this.client.invoke(new Api.payments.GetPaymentForm({ invoice })) as any;
      if (this.sessions.get(capability) !== session || session.expiresAt <= Date.now()) throw new Error('Mini App session ended');
      // openInvoice may open many payment providers. This host only supports
      // Telegram Stars, where the amount and recipient can be independently
      // checked before asking the user to confirm.
      if (!(form instanceof Api.payments.PaymentFormStars) || form.formId == null ||
          String(form.botId) !== session.botId || !(form.invoice instanceof Api.Invoice) ||
          form.invoice.currency !== 'XTR' || !Array.isArray(form.invoice.prices) || !form.invoice.prices.length) {
        throw new Error('This Mini App invoice cannot be paid with Telegram Stars');
      }
      let amount = 0n;
      try {
        for (const price of form.invoice.prices) {
          if (!(price instanceof Api.LabeledPrice) || typeof price.label !== 'string' || !price.label.trim()) throw new Error('invalid price');
          const units = BigInt(String(price.amount));
          if (units <= 0n) throw new Error('invalid price');
          amount += units;
        }
      } catch { throw new Error('Telegram returned an invalid Stars invoice amount'); }
      if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error('Telegram returned an invalid Stars invoice amount');
      const token = randomBytes(24).toString('base64url');
      const pending: PendingInvoice = {
        token, slug, formId: form.formId, invoice, stars: amount.toString(),
        title: String(form.title || 'Telegram Stars 付款').slice(0, 256),
        description: String(form.description || '').slice(0, 1024),
        expiresAt: Date.now() + 120_000,
      };
      session.pendingInvoice = pending;
      return { token, stars: pending.stars, title: pending.title, description: pending.description };
    } finally { session.invoicePreparing = false; }
  }

  async confirmInvoice(capability: string, token: string): Promise<{ status: 'paid' | 'failed' }> {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    const pending = session?.pendingInvoice;
    if (!session || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token) || !pending ||
        pending.token !== token || pending.expiresAt <= Date.now()) throw new Error('Mini App invoice confirmation expired');
    // Consume before invoking Telegram so retries or concurrent clicks can never
    // submit the same payment form twice.
    session.pendingInvoice = undefined;
    try {
      const result = await this.client.invoke(new Api.payments.SendStarsForm({ formId: pending.formId, invoice: pending.invoice })) as any;
      return { status: result instanceof Api.payments.PaymentResult ? 'paid' : 'failed' };
    } catch { return { status: 'failed' }; }
  }

  cancelInvoice(capability: string, token: string): void {
    this.purgeExpired();
    const session = this.sessions.get(capability);
    if (!session || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return;
    if (session.pendingInvoice?.token === token) session.pendingInvoice = undefined;
  }

  close(capability: string): void {
    const session = this.sessions.get(capability);
    if (session?.timer) clearTimeout(session.timer);
    this.sessions.delete(capability);
  }
  closeAll(): void { this.generation++; for (const key of this.sessions.keys()) this.close(key); }
  closeQuery(queryId: unknown): void {
    if (queryId == null) return;
    for (const [key, session] of this.sessions) if (String(session.queryId) === String(queryId)) this.close(key);
  }
  private refreshExpiry(key: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    const ttl = session.simpleWebView ? 30 * 60_000 : SESSION_TTL_MS;
    session.expiresAt = Date.now() + ttl;
    session.timer = setTimeout(() => { if (this.sessions.get(key) === session) this.close(key); }, ttl);
    session.timer.unref();
  }
  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.close(key);
  }
}

/** Opaque sandbox still must not be pointed at this GUI or a local IP. */
export function isSafeMiniAppUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 16384) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const localName = host === 'localhost' || ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home', '.home.arpa']
      .some((suffix) => host.endsWith(suffix));
    return url.protocol === 'https:' && Boolean(host) && !url.username && !url.password &&
      !localName && host.includes('.') && !host.startsWith('[') &&
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  } catch { return false; }
}

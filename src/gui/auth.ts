import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';

/**
 * TGuserBOT Web GUI 访问鉴权管理服务
 * 提供基于安全 Token (密钥/密码) 的认证、Cookie 会话管理及防暴破比较
 */
export class GUIAuth {
  private secretToken: string;
  private readonly secretFilePath: string;

  constructor(dataDir: string) {
    this.secretFilePath = path.join(dataDir, 'gui_secret.token');
    this.secretToken = this.loadOrGenerateToken();
  }

  /**
   * 加载既有安全 Token 或生成高强度 32 字符安全凭证
   */
  private loadOrGenerateToken(): string {
    // 1. 优先读取系统环境变量 GUI_SECRET 或 GUI_TOKEN
    const envToken = process.env.GUI_SECRET || process.env.GUI_TOKEN;
    if (envToken && envToken.trim()) {
      return envToken.trim();
    }

    // 2. 从本地持久化文件中读取
    try {
      if (fs.existsSync(this.secretFilePath)) {
        const saved = fs.readFileSync(this.secretFilePath, 'utf8').trim();
        if (saved) return saved;
      }
    } catch {
      /* ignore */
    }

    // 3. 首次启动自动生成 128-bit (32 位十六进制) 高强度安全随机凭证
    const newToken = crypto.randomBytes(16).toString('hex');
    try {
      const dir = path.dirname(this.secretFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.secretFilePath, newToken, { mode: 0o600 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to write gui_secret.token:', err);
    }
    return newToken;
  }

  /**
   * 获取当前有效 Token
   */
  getToken(): string {
    return this.secretToken;
  }

  /**
   * 验证 HTTP 请求中附带的凭证是否有效
   * 支持:
   * 1. Header: Authorization: Bearer <token>
   * 2. URL Query: ?token=<token> (用于 SSE 和快速访问)
   * 3. Cookie: tg_gui_token=<token>
   */
  verifyRequest(req: http.IncomingMessage, url: URL): boolean {
    // 1. Header: Authorization: Bearer <token>
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        if (this.timingSafeCompare(parts[1], this.secretToken)) return true;
      }
    }

    // 2. Query param: ?token=<token>
    const queryToken = url.searchParams.get('token');
    if (queryToken && this.timingSafeCompare(queryToken, this.secretToken)) {
      return true;
    }

    // 3. Cookie: tg_gui_token=<token>
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').map((c) => c.trim());
      for (const c of cookies) {
        if (c.startsWith('tg_gui_token=')) {
          const val = c.substring('tg_gui_token='.length);
          if (this.timingSafeCompare(val, this.secretToken)) return true;
        }
      }
    }

    return false;
  }

  /**
   * 验证传入的纯文本 Token
   */
  verifyToken(inputToken: string): boolean {
    if (!inputToken || typeof inputToken !== 'string') return false;
    return this.timingSafeCompare(inputToken.trim(), this.secretToken);
  }

  /**
   * 防时序攻击的比对 (Timing Safe Equal)
   */
  private timingSafeCompare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}


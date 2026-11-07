import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { InstanceManager } from '../manager';
import { SSEHub } from './sse';
import { handleApiRoute } from './api';
import { checkIntranetAccess } from './ip-filter';
import { CacheManager } from './cache-manager';
import { ChatWSGateway } from './ws-chat';
import { isAllowedRequestOrigin } from './request-origin';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class GUIServer {
  private server?: http.Server;
  private readonly manager: InstanceManager;
  private readonly sse = new SSEHub();
  private readonly cache: CacheManager;
  private readonly wsGateway: ChatWSGateway;
  private readonly webDir: string;
  private readonly pluginsDir: string;
  private heartbeatCleanup?: () => void;

  constructor(options?: { baseDir?: string; webDir?: string; pluginsDir?: string }) {
    this.manager = new InstanceManager(options?.baseDir);
    this.cache = CacheManager.getInstance(options?.baseDir ? path.join(options.baseDir, 'data') : undefined);
    this.wsGateway = new ChatWSGateway(this.manager, this.cache);
    this.pluginsDir = options?.pluginsDir || path.resolve(process.cwd(), 'plugins');

    // Search for web directory (dist/gui/web or src/gui/web)
    const candidates = [
      options?.webDir,
      path.resolve(__dirname, 'web'),
      path.resolve(process.cwd(), 'src/gui/web'),
      path.resolve(process.cwd(), 'dist/gui/web'),
    ].filter(Boolean) as string[];

    this.webDir = candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) || candidates[0];

    this.wireEvents();
  }

  private wireEvents(): void {
    this.heartbeatCleanup = this.sse.startHeartbeat();

    this.manager.on('status_change', (d) => {
      this.sse.broadcast('status_change', d);
      this.sse.broadcast('status', d);
    });
    this.manager.on('auth_required', (d) => {
      this.sse.broadcast('auth_required', d);
      this.sse.broadcast('auth_prompt', d);
    });
    this.manager.on('auth_success', (d) => this.sse.broadcast('auth_success', d));
    this.manager.on('metrics', (d) => this.sse.broadcast('metrics', d));
    this.manager.on('log', (d) => this.sse.broadcast('log', d));
    this.manager.on('instance_created', (d) => this.sse.broadcast('instance_created', d));
    this.manager.on('instance_deleted', (d) => this.sse.broadcast('instance_deleted', d));
  }

  start(port: number = 3000, host: string = process.env.GUI_HOST || '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // --- 严格内网访问限制防线 ---
        const allowLan = process.env.GUI_ALLOW_LAN !== 'false'; // 默认允许局域网私网，设为 false 则仅限 127.0.0.1
        const trustProxy = process.env.GUI_TRUST_PROXY === 'true';

        const access = checkIntranetAccess(req, {
          allowPrivateNetwork: allowLan,
          trustProxy,
        });

        if (!access.allowed) {
          res.writeHead(403, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Connection': 'close',
          });
          res.end(`403 Forbidden: WebUI is strictly restricted to intranet access only. (Remote IP: ${access.clientIp})`);
          req.socket.destroy();
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // IP restrictions alone do not stop another website from sending a
        // browser request to a locally accessible control API.
        if (url.pathname.startsWith('/api/') && !isAllowedRequestOrigin(req, trustProxy)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden: request origin does not match this server.');
          return;
        }

        // 1. SSE Stream
        if (url.pathname === '/api/events') {
          this.sse.addClient(res);
          return;
        }

        // 2. REST API
        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApiRoute(req, res, this.manager, this.pluginsDir, this.cache);
          if (handled) return;
        }

        // 3. Static Web Files
        this.serveStatic(req, res, url.pathname);
      });

      // Large file bodies may legitimately take longer than Node's default
      // five-minute request timeout, especially on a slow local network.
      this.server.requestTimeout = 2 * 60 * 60_000;

      // WebSocket Upgrade: 支持最大双 WS 架构 (/ws/chat-stream 和 /ws/chat-rpc)
      this.server.on('upgrade', (req, socket, head) => {
        const allowLan = process.env.GUI_ALLOW_LAN !== 'false';
        const trustProxy = process.env.GUI_TRUST_PROXY === 'true';
        const access = checkIntranetAccess(req, { allowPrivateNetwork: allowLan, trustProxy });
        if (!access.allowed) {
          socket.destroy();
          return;
        }

        if (!isAllowedRequestOrigin(req, trustProxy)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/ws/chat-stream') {
          this.wsGateway.streamWss.handleUpgrade(req, socket, head, (ws) => {
            this.wsGateway.streamWss.emit('connection', ws, req);
          });
          return;
        }

        if (url.pathname === '/ws/chat-rpc') {
          this.wsGateway.rpcWss.handleUpgrade(req, socket, head, (ws) => {
            this.wsGateway.rpcWss.emit('connection', ws, req);
          });
          return;
        }

        socket.destroy();
      });

      this.server.on('error', (err: any) => {
        reject(err);
      });

      this.server.listen(port, host, async () => {
        const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
        // eslint-disable-next-line no-console
        console.log(`\n======================================================`);
        // eslint-disable-next-line no-console
        console.log(`🔒 TGuserBOT Web GUI is running [INTRANET-RESTRICTED]`);
        // eslint-disable-next-line no-console
        console.log(`🌐 Bound Host: ${host}:${port}`);
        // eslint-disable-next-line no-console
        console.log(`🌐 Local Access: http://127.0.0.1:${port}`);
        // eslint-disable-next-line no-console
        console.log(`🛡️ Access Policy: Local & Private LAN Only (Public IPs are Forbidden)`);
        // eslint-disable-next-line no-console
        console.log(`======================================================\n`);

        // Auto-start autoStart instances
        try {
          await this.manager.startAll();
        } catch {
          /* ignore */
        }

        resolve(port);
      });
    });
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = 'index.html';

    const filePath = path.join(this.webDir, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // Fallback to index.html for SPA client-side routing
      const indexPath = path.join(this.webDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Web UI not found. Please ensure src/gui/web/index.html exists.');
      }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatCleanup) {
      this.heartbeatCleanup();
      this.heartbeatCleanup = undefined;
    }
    await this.manager.stopAll();
    if (this.server) {
      if (typeof (this.server as any).closeAllConnections === 'function') {
        (this.server as any).closeAllConnections();
      }
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  openBrowser(port: number): void {
    const url = `http://localhost:${port}`;
    try {
      if (process.platform === 'win32') {
        cp.exec(`start ${url}`);
      } else if (process.platform === 'darwin') {
        cp.exec(`open ${url}`);
      } else {
        cp.exec(`xdg-open ${url}`);
      }
    } catch {
      /* ignore browser open error */
    }
  }
}

// Direct execution entry
if (require.main === module) {
  // 支持从 CLI 参数读取自由端口 (如 node dist/gui/server.js 3001 或 --port 3001)
  let cliPort: number | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--port' && process.argv[i + 1]) {
      const p = Number(process.argv[i + 1]);
      if (!isNaN(p) && p > 0 && p <= 65535) {
        cliPort = p;
        break;
      }
    }
    const num = Number(arg);
    if (!isNaN(num) && num > 0 && num <= 65535) {
      cliPort = num;
      break;
    }
  }

  const initialPort = cliPort || Number(process.env.GUI_PORT || 3000);
  const host = process.env.GUI_HOST || '127.0.0.1';
  const server = new GUIServer();

  const startWithAutoPort = async (p: number, attempts = 0): Promise<void> => {
    try {
      const actualPort = await server.start(p, host);
      if (!process.env.NO_OPEN_BROWSER) {
        server.openBrowser(actualPort);
      }
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        if (attempts < 10) {
          // eslint-disable-next-line no-console
          console.warn(`⚠️ 端口 ${p} 当前已被占用，正在自动切换至下一个可用端口 ${p + 1}...`);
          return startWithAutoPort(p + 1, attempts + 1);
        }
        // eslint-disable-next-line no-console
        console.error(`\n❌ 连续多次端口均已被系统其它进程占用！`);
        // eslint-disable-next-line no-console
        console.error(`💡 解决方案: 您可以在启动命令后直接指定任意自由端口，例如:`);
        // eslint-disable-next-line no-console
        console.error(`   ./start.sh gui 3005\n`);
      } else {
        // eslint-disable-next-line no-console
        console.error('Server start error:', err);
      }
      process.exit(1);
    }
  };

  startWithAutoPort(initialPort);

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('\nShutting down GUI server and all instances...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

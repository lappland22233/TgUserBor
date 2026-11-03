import * as http from 'http';

/**
 * 判断给定的 IP 字符串是否属于标准内网/私有地址 (RFC 1918 / RFC 4193 / RFC 3927)
 */
export function isPrivateOrLocalIP(rawIp: string): boolean {
  if (!rawIp) return false;

  // 清洗 IPv4-mapped IPv6 格式，如 ::ffff:192.168.1.1 -> 192.168.1.1
  let ip = rawIp.trim();
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // 1. 本机回环地址 (Loopback)
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
    return true;
  }

  // 2. IPv4 内网地址段判定
  const ipv4Parts = ip.split('.').map((p) => parseInt(p, 10));
  if (ipv4Parts.length === 4 && ipv4Parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [b0, b1] = ipv4Parts;

    // 10.0.0.0/8
    if (b0 === 10) return true;

    // 172.16.0.0/12 (172.16.0.0 ~ 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

    // 192.168.0.0/16
    if (b0 === 192 && b1 === 168) return true;

    // 127.0.0.0/8
    if (b0 === 127) return true;

    // 169.254.0.0/16 (Link-Local)
    if (b0 === 169 && b1 === 254) return true;

    // 0.0.0.0
    if (b0 === 0 && b1 === 0 && ipv4Parts[2] === 0 && ipv4Parts[3] === 0) return true;

    return false;
  }

  // 3. IPv6 私有/链路本地地址判定
  const lowerIp = ip.toLowerCase();
  // fc00::/7 (Unique Local Address, fc00 ~ fdff)
  if (lowerIp.startsWith('fc') || lowerIp.startsWith('fd')) return true;
  // fe80::/10 (Link-Local Address)
  if (lowerIp.startsWith('fe8') || lowerIp.startsWith('fe9') || lowerIp.startsWith('fea') || lowerIp.startsWith('feb')) {
    return true;
  }

  return false;
}

/**
 * 获取请求的真实对端 IP
 */
export function getClientIP(req: http.IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
      return realIp.trim();
    }
  }

  return req.socket.remoteAddress || '';
}

/**
 * 校验请求是否来自允许的内网环境
 * @param req http 请求
 * @param options 配置参数
 */
export function checkIntranetAccess(
  req: http.IncomingMessage,
  options: {
    allowPrivateNetwork?: boolean; // 是否允许局域网 (如 192.168.x.x)，为 false 则仅限 127.0.0.1
    trustProxy?: boolean;
    whitelist?: string[];
  } = {}
): { allowed: boolean; clientIp: string; reason?: string } {
  const clientIp = getClientIP(req, options.trustProxy);

  // 1. 自定义白名单
  if (options.whitelist && options.whitelist.includes(clientIp)) {
    return { allowed: true, clientIp };
  }

  // 清洗 IPv4-mapped IPv6
  let cleanIp = clientIp.trim();
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.slice(7);
  }

  // 2. 本机回环 IP
  const isLoopback = cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.startsWith('127.');
  if (isLoopback) {
    return { allowed: true, clientIp };
  }

  // 3. 局域网私网 IP
  if (options.allowPrivateNetwork !== false) {
    if (isPrivateOrLocalIP(clientIp)) {
      return { allowed: true, clientIp };
    }
  }

  return {
    allowed: false,
    clientIp,
    reason: options.allowPrivateNetwork === false
      ? 'WebUI configured for localhost only (127.0.0.1)'
      : 'Access denied: public internet IP addresses are strictly forbidden',
  };
}


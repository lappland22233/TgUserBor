import type { IncomingMessage } from 'http';
import type { TLSSocket } from 'tls';

/**
 * Browser requests to the control API and WebSocket must originate from the
 * served UI. Requests without browser origin metadata remain usable by local
 * CLI/API clients. Forwarded headers are only used when explicitly trusted.
 */
export function isAllowedRequestOrigin(req: IncomingMessage, trustProxy = false): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;

  let host = req.headers.host;
  let protocol = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
  if (trustProxy) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (typeof forwardedHost === 'string') host = forwardedHost.split(',')[0].trim();
    if (typeof forwardedProto === 'string') protocol = forwardedProto.split(',')[0].trim().toLowerCase();
  }
  if (!host || (protocol !== 'http' && protocol !== 'https')) return false;

  try {
    const supplied = new URL(origin);
    const expected = new URL(`${protocol}://${host}`);
    // Origin is a serialized origin, not a URL containing credentials or a path.
    if (supplied.origin === 'null' || supplied.username || supplied.password ||
        supplied.pathname !== '/' || supplied.search || supplied.hash ||
        expected.username || expected.password || expected.pathname !== '/' ||
        expected.search || expected.hash) return false;
    return supplied.origin === expected.origin;
  } catch {
    return false;
  }
}

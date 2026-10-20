/**
 * IP-Whitelist-Middleware (App-Ebene): erlaubt ist, was in der Whitelist des
 * authentifizierten API-Keys ODER in APP_IP_WHITELIST steht (Union).
 * Beide leer = keine Einschränkung.
 */
import type { RequestHandler } from 'express';
import { isIpAllowed, normalizeIp } from '../../security/ipWhitelist.js';

export function createIpWhitelistMiddleware(appWhitelist: string[]): RequestHandler {
  return (req, res, next) => {
    const keyList = req.apiKey?.ipWhitelist ?? [];
    const lists = [keyList, appWhitelist].filter((l) => l.length > 0);
    if (lists.length === 0) {
      next();
      return;
    }
    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    if (lists.some((list) => isIpAllowed(ip, list))) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        code: 'FORBIDDEN_IP',
        message: `Quell-IP ${normalizeIp(ip) || 'unbekannt'} ist nicht in der Whitelist`,
      },
    });
  };
}

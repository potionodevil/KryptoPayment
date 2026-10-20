/**
 * Express-App mit mehrschichtigem Security-Middleware-Stack:
 *   roher Body (HMAC) -> Security-Header -> /healthz
 *   -> /api/v1: HMAC-Auth -> IP-Whitelist -> Rate-Limit -> zod-Validierung -> Routen
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Router } from 'express';
import { ZodError } from 'zod';
import type { AppConfig } from '../config.js';
import type { InvoiceService, PaymentService } from '../services/contracts.js';
import { GatewayError } from '../core/stateMachine.js';
import { createAuthMiddleware, type ApiKeyStore } from './middleware/auth.js';
import { createIpWhitelistMiddleware } from './middleware/ipWhitelist.js';
import {
  createRateLimitMiddleware,
  type RateLimitStore,
} from './middleware/rateLimit.js';
import type { NonceStore } from '../security/nonce.js';
import { createInvoicesRouter } from './routes/invoices.js';
import { createAdminRouter } from './routes/admin.js';

export interface AppDeps {
  config: AppConfig;
  invoices: InvoiceService;
  payments: PaymentService;
  keys: ApiKeyStore;
  nonces: NonceStore;
  rateLimit: RateLimitStore;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  // Roher Body für die HMAC-Verifikation sichern (vor JSON-Parsing).
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(securityHeaders);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const auth = createAuthMiddleware({
    keys: deps.keys,
    nonces: deps.nonces,
    encryptionKey: deps.config.encryptionKey,
    clockSkewSec: deps.config.hmacClockSkewSec,
    nonceTtlSec: deps.config.nonceTtlSec,
  });
  const ipGuard = createIpWhitelistMiddleware(deps.config.appIpWhitelist);
  const rateLimit = createRateLimitMiddleware(deps.rateLimit, {
    limit: deps.config.rateLimit.max,
    windowSec: deps.config.rateLimit.windowSec,
    keyOf: (req) => req.apiKey?.keyId ?? req.ip ?? 'unknown',
  });

  const apiRouter = Router();
  // Reihenfolge ist sicherheitsrelevant: Auth -> IP -> Rate-Limit -> Validierung.
  apiRouter.use(auth, ipGuard, rateLimit);
  apiRouter.use(
    '/invoices',
    createInvoicesRouter({ invoices: deps.invoices, payments: deps.payments })
  );
  apiRouter.use('/admin', createAdminRouter({
    keys: deps.keys,
    encryptionKey: deps.config.encryptionKey,
  }));
  app.use('/api/v1', apiRouter);

  // 404 für alles außerhalb der API.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpunkt nicht gefunden' } });
  });

  // Zentraler Error-Handler: keine internen Details nach außen.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GatewayError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `Ungültige Anfrage — ${message}` },
      });
      return;
    }
    const anyErr = err as { status?: number; type?: string; message?: string };
    if (anyErr && typeof anyErr.status === 'number') {
      // Body-Parser-Fehler (ungültiges JSON, zu groß, ...)
      const code = anyErr.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'BAD_REQUEST';
      res.status(anyErr.status).json({
        error: { code, message: anyErr.message ?? 'Ungültige Anfrage' },
      });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Interner Serverfehler' } });
  });

  return app;
}

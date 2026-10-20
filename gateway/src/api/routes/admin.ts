/**
 * Admin-Routen: API-Key-Verwaltung (merchant-scoped).
 *   POST   /api/v1/admin/keys            — neuen Key erzeugen (Secret NUR hier sichtbar)
 *   GET    /api/v1/admin/keys            — Keys auflisten (ohne Secrets/Hashes)
 *   PATCH  /api/v1/admin/keys/:keyId     — IP-Whitelist ändern
 *   DELETE /api/v1/admin/keys/:keyId     — Key deaktivieren (revoken)
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { ApiKeyStore } from '../middleware/auth.js';
import { encryptSecret, generateSecret, hashSecret } from '../../security/hmac.js';
import { GatewayError } from '../../core/stateMachine.js';
import { validateBody } from '../middleware/validate.js';

const CreateKeyBody = z.object({
  ipWhitelist: z.array(z.string().min(1).max(128)).max(64).optional(),
});

const UpdateKeyBody = z.object({
  ipWhitelist: z.array(z.string().min(1).max(128)).max(64),
});

const KEY_ID_RE = /^kg_[0-9a-f]{18}$/;

export interface AdminRouterDeps {
  keys: ApiKeyStore;
  encryptionKey: string;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  function merchantOf(req: Parameters<Parameters<Router['get']>[1]>[0]): string {
    const merchantId = req.apiKey?.merchantId;
    if (!merchantId) {
      throw new GatewayError('UNAUTHORIZED', 'Kein authentifizierter Merchant', 401);
    }
    return merchantId;
  }

  // POST /api/v1/admin/keys
  router.post('/keys', validateBody(CreateKeyBody), async (req, res, next) => {
    try {
      const merchantId = merchantOf(req);
      const keyId = `kg_${randomBytes(9).toString('hex')}`;
      const secret = generateSecret();
      const record = await deps.keys.create({
        merchantId,
        keyId,
        keyHash: hashSecret(secret),
        secretEnc: encryptSecret(secret, deps.encryptionKey),
        ipWhitelist: req.body.ipWhitelist ?? [],
      });
      // Das Secret ist NUR in dieser Antwort sichtbar (key_hash/secret_enc werden gespeichert).
      res.status(201).json({
        keyId: record.keyId,
        secret,
        merchantId: record.merchantId,
        ipWhitelist: record.ipWhitelist,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/keys
  router.get('/keys', async (req, res, next) => {
    try {
      const merchantId = merchantOf(req);
      const keys = await deps.keys.listByMerchant(merchantId);
      res.json({
        keys: keys.map((k) => ({
          keyId: k.keyId,
          merchantId: k.merchantId,
          ipWhitelist: k.ipWhitelist,
          isActive: k.isActive,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/admin/keys/:keyId
  router.patch('/keys/:keyId', validateBody(UpdateKeyBody), async (req, res, next) => {
    try {
      const merchantId = merchantOf(req);
      const { keyId } = req.params;
      if (!KEY_ID_RE.test(keyId)) {
        throw new GatewayError('NOT_FOUND', 'API-Key nicht gefunden', 404);
      }
      const ok = await deps.keys.setIpWhitelist(merchantId, keyId, req.body.ipWhitelist);
      if (!ok) {
        throw new GatewayError('NOT_FOUND', 'API-Key nicht gefunden', 404);
      }
      res.json({ keyId, ipWhitelist: req.body.ipWhitelist });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/admin/keys/:keyId
  router.delete('/keys/:keyId', async (req, res, next) => {
    try {
      const merchantId = merchantOf(req);
      const { keyId } = req.params;
      if (!KEY_ID_RE.test(keyId)) {
        throw new GatewayError('NOT_FOUND', 'API-Key nicht gefunden', 404);
      }
      const ok = await deps.keys.revoke(merchantId, keyId);
      if (!ok) {
        throw new GatewayError('NOT_FOUND', 'API-Key nicht gefunden', 404);
      }
      res.json({ keyId, revoked: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

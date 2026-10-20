/**
 * HMAC-Auth-Middleware: jeder authentifizierte Request trägt
 * x-kg-key-id, x-kg-timestamp, x-kg-nonce, x-kg-signature.
 *
 * Prüfkette: Key laden -> Secret entschlüsseln -> Signatur + Timestamp-Skew
 * verifizieren -> Nonce atomar reservieren (Replay -> 401).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  AUTH_HEADERS,
  decryptSecret,
  hashSecret,
  verifyRequest,
} from '../../security/hmac.js';
import type { NonceStore } from '../../security/nonce.js';

export interface ApiKeyRecord {
  id: string;
  merchantId: string;
  keyId: string;
  keyHash: string;
  secretEnc: string;
  ipWhitelist: string[];
  isActive: boolean;
}

export type KeyExec = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: any[]; rowCount: number }>;

/** API-Key-Speicher: Auth-Lookup + Verwaltung (admin-Routen). */
export interface ApiKeyStore {
  findByKeyId(keyId: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(keyId: string): Promise<void>;
  create(rec: {
    merchantId: string;
    keyId: string;
    keyHash: string;
    secretEnc: string;
    ipWhitelist: string[];
  }): Promise<ApiKeyRecord>;
  listByMerchant(merchantId: string): Promise<ApiKeyRecord[]>;
  revoke(merchantId: string, keyId: string): Promise<boolean>;
  setIpWhitelist(merchantId: string, keyId: string, ipWhitelist: string[]): Promise<boolean>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Von der Auth-Middleware gesetzt — nie von Clients. */
      apiKey?: ApiKeyRecord;
      /** Klartext-Secret des authentifizierten Keys (nur im Request-Scope). */
      authSecret?: string;
      /** Roher Request-Body für die HMAC-Verifikation. */
      rawBody?: Buffer;
    }
  }
}

function mapKey(row: any): ApiKeyRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    keyId: row.key_id,
    keyHash: row.key_hash,
    secretEnc: row.secret_enc,
    ipWhitelist: Array.isArray(row.ip_whitelist) ? row.ip_whitelist : [],
    isActive: row.is_active === true,
  };
}

/** DB-Implementierung (ausschließlich parametrisierte Queries). */
export function createDbApiKeyStore(exec: KeyExec): ApiKeyStore {
  return {
    async findByKeyId(keyId) {
      const res = await exec('SELECT * FROM api_keys WHERE key_id = $1', [keyId]);
      return res.rows[0] ? mapKey(res.rows[0]) : null;
    },
    async touchLastUsed(keyId) {
      await exec('UPDATE api_keys SET last_used_at = now() WHERE key_id = $1', [keyId]);
    },
    async create(rec) {
      const res = await exec(
        'INSERT INTO api_keys (merchant_id, key_id, key_hash, secret_enc, ip_whitelist, is_active) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *',
        [rec.merchantId, rec.keyId, rec.keyHash, rec.secretEnc, rec.ipWhitelist]
      );
      return mapKey(res.rows[0]);
    },
    async listByMerchant(merchantId) {
      const res = await exec(
        'SELECT * FROM api_keys WHERE merchant_id = $1 ORDER BY created_at ASC',
        [merchantId]
      );
      return res.rows.map(mapKey);
    },
    async revoke(merchantId, keyId) {
      const res = await exec(
        'UPDATE api_keys SET is_active = FALSE WHERE key_id = $1 AND merchant_id = $2 RETURNING *',
        [keyId, merchantId]
      );
      return res.rowCount > 0;
    },
    async setIpWhitelist(merchantId, keyId, ipWhitelist) {
      const res = await exec(
        'UPDATE api_keys SET ip_whitelist = $3 WHERE key_id = $1 AND merchant_id = $2 RETURNING *',
        [keyId, merchantId, ipWhitelist]
      );
      return res.rowCount > 0;
    },
  };
}

export interface AuthDeps {
  keys: ApiKeyStore;
  nonces: NonceStore;
  encryptionKey: string;
  /** Erlaubte Timestamp-Abweichung (Sekunden) — HMAC_CLOCK_SKEW_SEC. */
  clockSkewSec: number;
  /** Lebensdauer benutzter Nonces (Default: 2x clockSkewSec). */
  nonceTtlSec?: number;
  now?: () => Date;
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createAuthMiddleware(deps: AuthDeps): RequestHandler {
  const nonceTtlSec = deps.nonceTtlSec ?? deps.clockSkewSec * 2;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const keyId = header(req, AUTH_HEADERS.keyId);
    const timestamp = header(req, AUTH_HEADERS.timestamp);
    const nonce = header(req, AUTH_HEADERS.nonce);
    const signature = header(req, AUTH_HEADERS.signature);

    if (!keyId || !timestamp || !nonce || !signature) {
      fail(res, 401, 'MISSING_AUTH_HEADERS', 'Signatur-Header fehlen');
      return;
    }

    const key = await deps.keys.findByKeyId(keyId);
    if (!key || !key.isActive) {
      fail(res, 401, 'UNKNOWN_API_KEY', 'API-Key unbekannt oder deaktiviert');
      return;
    }

    let secret: string;
    try {
      secret = decryptSecret(key.secretEnc, deps.encryptionKey);
    } catch {
      fail(res, 401, 'UNKNOWN_API_KEY', 'API-Key kann nicht entschlüsselt werden');
      return;
    }
    // Integritäts-Check: gespeicherter Hash muss zum Secret passen.
    if (hashSecret(secret) !== key.keyHash) {
      fail(res, 401, 'UNKNOWN_API_KEY', 'API-Key-Hash inkonsistent');
      return;
    }

    const now = deps.now ? deps.now() : new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const verification = verifyRequest(secret, {
      method: req.method,
      // Signierter Pfad = Pfad OHNE Query-String (exakt wie im API-Vertrag und
      // im WordPress-Plugin dokumentiert: build_path() liefert nur den Pfad).
      // Query-Parameter sind NICHT Bestandteil der Signatur und dürfen daher
      // keine Auth-/Authorisierungsentscheidung beeinflussen.
      path: req.originalUrl.split('?')[0],
      timestamp,
      nonce,
      body: req.rawBody ?? Buffer.alloc(0),
      signature,
      clockSkewSec: deps.clockSkewSec,
      nowSec,
    });
    if (!verification.valid) {
      const message =
        verification.reason === 'TIMESTAMP_SKEW'
          ? 'Timestamp außerhalb der erlaubten Abweichung'
          : verification.reason === 'MISSING_SIGNATURE'
            ? 'Signatur fehlt'
            : 'Signatur ungültig';
      fail(res, 401, verification.reason, message);
      return;
    }

    // Replay-Schutz: Nonce darf nur einmal verwendet werden (atomar).
    const fresh = await deps.nonces.consume(nonce, key.merchantId, nonceTtlSec);
    if (!fresh) {
      fail(res, 401, 'REPLAY_DETECTED', 'Nonce wurde bereits verwendet');
      return;
    }

    req.apiKey = key;
    req.authSecret = secret;
    void deps.keys.touchLastUsed(keyId).catch(() => undefined);
    next();
  };
}

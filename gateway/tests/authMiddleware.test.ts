import { describe, expect, it } from 'vitest';
import { createAuthMiddleware, createDbApiKeyStore, type AuthDeps } from '../src/api/middleware/auth.js';
import { createMemoryNonceStore } from '../src/security/nonce.js';
import { encryptSecret, hashSecret, signRequest } from '../src/security/hmac.js';
import type { DbClient } from '../src/services/contracts.js';
import { FakeDb } from './helpers/fakeDb.js';

const SECRET = 'super-secret-key';
const KEY_ID = 'kg_test_key';
const MERCHANT_ID = '11111111-1111-1111-1111-111111111111';
const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!';

function makeReq(opts: {
  method?: string;
  path?: string;
  body?: string;
  headers: Record<string, string>;
}) {
  return {
    method: opts.method ?? 'POST',
    originalUrl: opts.path ?? '/api/v1/invoices',
    headers: opts.headers,
    rawBody: Buffer.from(opts.body ?? ''),
    body: {},
    ip: '127.0.0.1',
  } as any;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

interface RunResult {
  nextCalled: boolean;
  res: any;
  req: any;
}

async function run(mw: any, req: any): Promise<RunResult> {
  const res = makeRes();
  let nextCalled = false;
  await new Promise<void>((resolve) => {
    void Promise.resolve(
      mw(req, res, () => {
        nextCalled = true;
        resolve();
      })
    ).then(() => {
      if (!nextCalled) resolve();
    });
  });
  return { nextCalled, res, req };
}

function setup(opts: { ipWhitelist?: string[]; isActive?: boolean } = {}) {
  const db = new FakeDb();
  db.seedApiKey({
    merchantId: MERCHANT_ID,
    keyId: KEY_ID,
    keyHash: hashSecret(SECRET),
    secretEnc: encryptSecret(SECRET, ENCRYPTION_KEY),
    ipWhitelist: opts.ipWhitelist ?? [],
    isActive: opts.isActive ?? true,
  });
  const keys = createDbApiKeyStore((text: string, params?: unknown[]) =>
    db.query(text, params as unknown[])
  );
  const nonces = createMemoryNonceStore();
  const deps: AuthDeps = {
    keys,
    nonces,
    encryptionKey: ENCRYPTION_KEY,
    clockSkewSec: 300,
  };
  return { db, deps, mw: createAuthMiddleware(deps) };
}

function goodHeaders(overrides: Partial<Parameters<typeof signRequest>[1]> & { signature?: string } = {}) {
  const body = overrides.body ?? '';
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const signature =
    overrides.signature ??
    signRequest(SECRET, {
      method: overrides.method ?? 'POST',
      path: overrides.path ?? '/api/v1/invoices',
      timestamp,
      nonce,
      body,
    });
  return {
    'x-kg-key-id': KEY_ID,
    'x-kg-timestamp': timestamp,
    'x-kg-nonce': nonce,
    'x-kg-signature': signature,
  };
}

describe('api/middleware/auth (HMAC + Replay-Schutz)', () => {
  it('akzeptiert gültig signierte Requests und hängt apiKey an', async () => {
    const { mw } = setup();
    const req = makeReq({ headers: goodHeaders({ body: '{"a":1}' }), body: '{"a":1}' });
    const out = await run(mw, req);
    expect(out.nextCalled).toBe(true);
    expect(out.req.apiKey.keyId).toBe(KEY_ID);
    expect(out.req.apiKey.merchantId).toBe(MERCHANT_ID);
  });

  it('fehlende Auth-Header -> 401 MISSING_AUTH_HEADERS', async () => {
    const { mw } = setup();
    const out = await run(mw, makeReq({ headers: {} }));
    expect(out.nextCalled).toBe(false);
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body.error.code).toBe('MISSING_AUTH_HEADERS');
  });

  it('unbekannter oder deaktivierter Key -> 401', async () => {
    const { mw } = setup();
    const headers = { ...goodHeaders(), 'x-kg-key-id': 'unknown' };
    const out = await run(mw, makeReq({ headers }));
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body.error.code).toBe('UNKNOWN_API_KEY');

    const off = setup({ isActive: false });
    const out2 = await run(off.mw, makeReq({ headers: goodHeaders() }));
    expect(out2.res.statusCode).toBe(401);
  });

  it('falsche Signatur -> 401 BAD_SIGNATURE', async () => {
    const { mw } = setup();
    const out = await run(mw, makeReq({ headers: goodHeaders({ signature: 'ab'.repeat(32) }) }));
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body.error.code).toBe('BAD_SIGNATURE');
  });

  it('Body-Manipulation nach Signatur -> 401 BAD_SIGNATURE', async () => {
    const { mw } = setup();
    const headers = goodHeaders({ body: '{"amount":1}' });
    const out = await run(mw, makeReq({ headers, body: '{"amount":9999}' }));
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body.error.code).toBe('BAD_SIGNATURE');
  });

  it('Timestamp-Skew > HMAC_CLOCK_SKEW_SEC -> 401 TIMESTAMP_SKEW', async () => {
    const { mw } = setup();
    const stale = String(Math.floor(Date.now() / 1000) - 400);
    const out = await run(mw, makeReq({ headers: goodHeaders({ timestamp: stale }) }));
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body.error.code).toBe('TIMESTAMP_SKEW');
  });

  it('Nonce-Wiederverwendung (Replay) -> 401 REPLAY_DETECTED', async () => {
    const { mw } = setup();
    const headers = goodHeaders({ nonce: 'fixed-nonce-1' });
    const first = await run(mw, makeReq({ headers }));
    expect(first.nextCalled).toBe(true);
    const second = await run(mw, makeReq({ headers }));
    expect(second.nextCalled).toBe(false);
    expect(second.res.statusCode).toBe(401);
    expect(second.res.body.error.code).toBe('REPLAY_DETECTED');
  });

  it('schreibt last_used_at (Key-Nutzung protokolliert)', async () => {
    const { db, mw } = setup();
    await run(mw, makeReq({ headers: goodHeaders() }));
    expect(db.apiKeys.get(KEY_ID)!.last_used_at).not.toBeNull();
  });
});

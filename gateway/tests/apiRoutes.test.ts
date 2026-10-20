import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/api/server.js';
import { createAuthMiddleware, createDbApiKeyStore } from '../src/api/middleware/auth.js';
import { createMemoryNonceStore } from '../src/security/nonce.js';
import { createMemoryRateLimitStore } from '../src/api/middleware/rateLimit.js';
import { createInvoiceService, type QuoteProvider } from '../src/core/invoiceService.js';
import { createPaymentService } from '../src/core/paymentService.js';
import { loadConfig } from '../src/config.js';
import { encryptSecret, hashSecret, signResponse } from '../src/security/hmac.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';
import { api, startTestServer, type TestServer } from './helpers/http.js';

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!!';
const SECRET = 'merchant-secret-abc';
const KEY_ID = 'kg_api_key_1';
const MERCHANT_ID = '22222222-2222-2222-2222-222222222222';

const quote: QuoteProvider = async () => ({ amountCrypto: '0.00250000', address: 'addr-int-1' });

function buildDeps(db: FakeDb, configOverrides: Record<string, string> = {}): AppDeps {
  const config = loadConfig({ ENCRYPTION_KEY, ...configOverrides });
  const txRunner = fakeTxRunner(db);
  return {
    config,
    invoices: createInvoiceService({ txRunner, quote, ttlSec: 900 }),
    payments: createPaymentService({ txRunner, requiredConfirmations: { BTC: 3 } }),
    keys: createDbApiKeyStore((text: string, params?: unknown[]) => db.query(text, params as unknown[])),
    nonces: createMemoryNonceStore(),
    rateLimit: createMemoryRateLimitStore(),
  };
}

describe('api/server — REST-Endpunkte (HTTP-Integration)', () => {
  let db: FakeDb;
  let server: TestServer;

  beforeAll(async () => {
    db = new FakeDb();
    db.seedApiKey({
      merchantId: MERCHANT_ID,
      keyId: KEY_ID,
      keyHash: hashSecret(SECRET),
      secretEnc: encryptSecret(SECRET, ENCRYPTION_KEY),
    });
    server = await startTestServer(createApp(buildDeps(db)));
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /healthz ist unauthentifiziert erreichbar', async () => {
    const res = await fetch(server.baseUrl + '/healthz');
    expect(res.status).toBe(200);
  });

  it('POST /api/v1/invoices erstellt eine Invoice (signierte Antwort)', async () => {
    const body = JSON.stringify({
      orderRef: 'order-100',
      amountFiat: '250.00',
      fiatCurrency: 'EUR',
      cryptoCurrency: 'BTC',
      chain: 'BTC',
    });
    const res = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/invoices',
      body,
    });
    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('AWAITING_PAYMENT');
    expect(res.body.paymentAddress).toBe('addr-int-1');
    expect(res.body.amountCrypto).toBe('0.00250000');
    // Antwort-Signatur ist mit dem API-Secret verifizierbar
    const expected = signResponse(
      SECRET,
      JSON.stringify({
        invoice: res.body.invoice,
        paymentAddress: res.body.paymentAddress,
        amountCrypto: res.body.amountCrypto,
        expiresAt: res.body.expiresAt,
      })
    );
    expect(res.body.signature).toBe(expected);
  });

  it('POST /api/v1/invoices validiert Eingaben via zod (400 ApiError)', async () => {
    const res = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/invoices',
      body: JSON.stringify({ orderRef: '', amountFiat: 'abc', chain: 'DOGE' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unsignierte Requests werden abgelehnt (401)', async () => {
    const res = await fetch(server.baseUrl + '/api/v1/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('Replay derselben Nonce wird abgelehnt (401 REPLAY_DETECTED)', async () => {
    const body = JSON.stringify({
      orderRef: 'order-replay',
      amountFiat: '1.00',
      fiatCurrency: 'EUR',
      cryptoCurrency: 'BTC',
      chain: 'BTC',
    });
    const opts = {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/invoices',
      body,
      nonce: 'replay-nonce-fixed',
    };
    const first = await api(server.baseUrl, opts);
    expect(first.status).toBe(201);
    const second = await api(server.baseUrl, opts);
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('REPLAY_DETECTED');
  });

  it('GET /api/v1/invoices/:id liefert eigene Invoice, fremde nur als 404', async () => {
    const create = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/invoices',
      body: JSON.stringify({
        orderRef: 'order-200',
        amountFiat: '10.00',
        fiatCurrency: 'EUR',
        cryptoCurrency: 'BTC',
        chain: 'BTC',
      }),
    });
    const id = create.body.invoice.id;
    const own = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'GET',
      path: `/api/v1/invoices/${id}`,
    });
    expect(own.status).toBe(200);
    expect(own.body.invoice.id).toBe(id);

    // Invoice eines anderen Merchants -> 404 (kein Leak)
    db.seedApiKey({
      merchantId: '33333333-3333-3333-3333-333333333333',
      keyId: 'kg_other_key',
      keyHash: hashSecret('other-secret'),
      secretEnc: encryptSecret('other-secret', ENCRYPTION_KEY),
    });
    const foreign = await api(server.baseUrl, {
      secret: 'other-secret',
      keyId: 'kg_other_key',
      method: 'GET',
      path: `/api/v1/invoices/${id}`,
    });
    expect(foreign.status).toBe(404);
  });

  it('POST /api/v1/invoices/:id/payments bucht Chain-Daten idempotent', async () => {
    const create = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/invoices',
      body: JSON.stringify({
        orderRef: 'order-300',
        amountFiat: '99.00',
        fiatCurrency: 'EUR',
        cryptoCurrency: 'BTC',
        chain: 'BTC',
      }),
    });
    const id = create.body.invoice.id;
    const payBody = JSON.stringify({
      chain: 'BTC',
      txid: 'tx-http-1',
      vout: 0,
      amount: '0.00250000',
      confirmations: 5,
    });
    const first = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: `/api/v1/invoices/${id}/payments`,
      body: payBody,
    });
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    expect(first.body.payment.status).toBe('CONFIRMED');

    const second = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: `/api/v1/invoices/${id}/payments`,
      body: payBody,
    });
    expect(second.body.applied).toBe(false); // Idempotenz

    const inv = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'GET',
      path: `/api/v1/invoices/${id}`,
    });
    expect(inv.body.invoice.status).toBe('CONFIRMED');
  });

  it('POST /api/v1/admin/keys erzeugt nutzbare API-Keys, DELETE revoked sie', async () => {
    const create = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'POST',
      path: '/api/v1/admin/keys',
      body: JSON.stringify({ ipWhitelist: ['127.0.0.1'] }),
    });
    expect(create.status).toBe(201);
    expect(create.body.keyId).toMatch(/^kg_/);
    expect(typeof create.body.secret).toBe('string');
    expect(create.body.secret.length).toBeGreaterThan(20);

    // Der neue Key funktioniert sofort
    const use = await api(server.baseUrl, {
      secret: create.body.secret,
      keyId: create.body.keyId,
      method: 'GET',
      path: '/api/v1/invoices/00000000-0000-0000-0000-000000000000',
    });
    expect(use.status).toBe(404); // auth ok, Invoice gibt es nicht

    // Listing zeigt KEINE Secrets
    const list = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'GET',
      path: '/api/v1/admin/keys',
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.keys)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(create.body.secret);

    // Revoke -> Key unbrauchbar
    const revoke = await api(server.baseUrl, {
      secret: SECRET,
      keyId: KEY_ID,
      method: 'DELETE',
      path: `/api/v1/admin/keys/${create.body.keyId}`,
    });
    expect(revoke.status).toBe(200);
    const after = await api(server.baseUrl, {
      secret: create.body.secret,
      keyId: create.body.keyId,
      method: 'GET',
      path: '/api/v1/invoices/00000000-0000-0000-0000-000000000000',
    });
    expect(after.status).toBe(401);
  });
});

describe('api/server — Rate-Limit über HTTP', () => {
  it('begrenzt Requests pro API-Key (429)', async () => {
    const db = new FakeDb();
    db.seedApiKey({
      merchantId: MERCHANT_ID,
      keyId: KEY_ID,
      keyHash: hashSecret(SECRET),
      secretEnc: encryptSecret(SECRET, ENCRYPTION_KEY),
    });
    const deps = buildDeps(db, { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SEC: '60' });
    const server = await startTestServer(createApp(deps));
    try {
      const opts = { secret: SECRET, keyId: KEY_ID, method: 'GET', path: '/api/v1/admin/keys' };
      expect((await api(server.baseUrl, opts)).status).toBe(200);
      expect((await api(server.baseUrl, opts)).status).toBe(200);
      const third = await api(server.baseUrl, opts);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await server.close();
    }
  });
});

describe('api/server — IP-Whitelist über HTTP', () => {
  it('lehnt Quell-IPs außerhalb der Whitelist ab (403) und lässt erlaubte zu', async () => {
    const db = new FakeDb();
    db.seedApiKey({
      merchantId: MERCHANT_ID,
      keyId: 'kg_restricted',
      keyHash: hashSecret('restricted-secret'),
      secretEnc: encryptSecret('restricted-secret', ENCRYPTION_KEY),
      ipWhitelist: ['10.0.0.0/8'],
    });
    db.seedApiKey({
      merchantId: MERCHANT_ID,
      keyId: 'kg_allowed',
      keyHash: hashSecret('allowed-secret'),
      secretEnc: encryptSecret('allowed-secret', ENCRYPTION_KEY),
      ipWhitelist: ['127.0.0.0/8'],
    });
    const server = await startTestServer(createApp(buildDeps(db)));
    try {
      const denied = await api(server.baseUrl, {
        secret: 'restricted-secret',
        keyId: 'kg_restricted',
        method: 'GET',
        path: '/api/v1/admin/keys',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN_IP');

      const allowed = await api(server.baseUrl, {
        secret: 'allowed-secret',
        keyId: 'kg_allowed',
        method: 'GET',
        path: '/api/v1/admin/keys',
      });
      expect(allowed.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('APP_IP_WHITELIST wirkt zusätzlich (Union aus App- und Key-Whitelist)', async () => {
    const db = new FakeDb();
    db.seedApiKey({
      merchantId: MERCHANT_ID,
      keyId: KEY_ID,
      keyHash: hashSecret(SECRET),
      secretEnc: encryptSecret(SECRET, ENCRYPTION_KEY),
    });
    const deps = buildDeps(db, { APP_IP_WHITELIST: '192.168.0.0/16' });
    const server = await startTestServer(createApp(deps));
    try {
      const res = await api(server.baseUrl, {
        secret: SECRET,
        keyId: KEY_ID,
        method: 'GET',
        path: '/api/v1/admin/keys',
      });
      // Key ohne Whitelist + App-Whitelist ohne Treffer -> abgelehnt
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_IP');
    } finally {
      await server.close();
    }
  });
});

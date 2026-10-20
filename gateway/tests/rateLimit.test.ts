import { describe, expect, it } from 'vitest';
import {
  createMemoryRateLimitStore,
  createRateLimitMiddleware,
  createRedisRateLimitStore,
} from '../src/api/middleware/rateLimit.js';

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

async function runMiddleware(
  mw: (req: any, res: any, next: (err?: unknown) => void) => void | Promise<void>,
  req: any
): Promise<{ res: any; nextCalled: boolean; err?: unknown }> {
  const res = mockRes();
  let nextCalled = false;
  let err: unknown;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    Promise.resolve(
      mw(req, res, (e?: unknown) => {
        if (e) err = e;
        nextCalled = true;
        done();
      })
    ).then(() => {
      // Middleware hat geantwortet (kein next) -> ebenfalls fertig
      if (!nextCalled) done();
    });
  });
  return { res, nextCalled, err };
}

describe('api/middleware/rateLimit', () => {
  it('Memory-Store: Fixed-Window limitiert pro Bucket', async () => {
    let now = 1000;
    const store = createMemoryRateLimitStore(() => now);
    const r1 = await store.consume('key-1', 3, 10);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    await store.consume('key-1', 3, 10);
    const r3 = await store.consume('key-1', 3, 10);
    expect(r3.remaining).toBe(0);
    const r4 = await store.consume('key-1', 3, 10);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSec).toBeGreaterThan(0);
    // Zweiter Bucket ist unabhängig
    expect((await store.consume('key-2', 3, 10)).allowed).toBe(true);
    // Nach Ablauf des Fensters wieder erlaubt
    now = 1011;
    expect((await store.consume('key-1', 3, 10)).allowed).toBe(true);
  });

  it('Middleware antwortet 429 mit ApiError nach Überschreitung', async () => {
    const store = createMemoryRateLimitStore();
    const mw = createRateLimitMiddleware(store, { limit: 2, windowSec: 60, keyOf: (req) => req.apiKey.keyId });
    const req = { apiKey: { keyId: 'k1' } };
    expect((await runMiddleware(mw, req)).nextCalled).toBe(true);
    expect((await runMiddleware(mw, req)).nextCalled).toBe(true);
    const third = await runMiddleware(mw, req);
    expect(third.nextCalled).toBe(false);
    expect(third.res.statusCode).toBe(429);
    expect(third.res.body.error.code).toBe('RATE_LIMITED');
  });

  it('Redis-Store: nutzt atomares eval-Lua mit Key pro Bucket', async () => {
    const counters = new Map<string, number>();
    const calls: any[] = [];
    const fakeRedis = {
      async eval(_script: string, _numKeys: number, key: string, limit: string) {
        calls.push({ key, limit });
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return [n > Number(limit) ? 0 : 1, n];
      },
    };
    const store = createRedisRateLimitStore(fakeRedis as never);
    const ok = await store.consume('k1', 1, 60);
    expect(ok.allowed).toBe(true);
    const denied = await store.consume('k1', 1, 60);
    // Fake zählt hoch, Auswertung erfolgt über den Lua-Rückgabewert
    expect(denied.allowed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0].key).toContain('k1');
  });
});

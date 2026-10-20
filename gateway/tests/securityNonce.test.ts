import { describe, expect, it } from 'vitest';
import { createDbNonceStore, createMemoryNonceStore } from '../src/security/nonce.js';
import { FakeDb } from './helpers/fakeDb.js';

describe('security/nonce (Replay-Schutz)', () => {
  it('Memory-Store: eine Nonce ist nur einmal gültig', async () => {
    const store = createMemoryNonceStore();
    expect(await store.consume('n1', 'm1', 300)).toBe(true);
    expect(await store.consume('n1', 'm1', 300)).toBe(false); // Replay -> abgelehnt
    expect(await store.consume('n2', 'm1', 300)).toBe(true);
  });

  it('Memory-Store: abgelaufene Nonce darf wiederverwendet werden', async () => {
    let now = 0;
    const store = createMemoryNonceStore(() => now);
    expect(await store.consume('n1', 'm1', 10)).toBe(true);
    now = 5;
    expect(await store.consume('n1', 'm1', 10)).toBe(false);
    now = 11; // TTL (10s) überschritten
    expect(await store.consume('n1', 'm1', 10)).toBe(true);
  });

  it('Memory-Store: purgeExpired räumt abgelaufene Nonces ab', async () => {
    let now = 0;
    const store = createMemoryNonceStore(() => now);
    await store.consume('n1', 'm1', 10);
    now = 100;
    await store.purgeExpired();
    expect(store.size()).toBe(0);
  });

  it('DB-Store: nutzt parametrisierte Queries und ON CONFLICT DO NOTHING', async () => {
    const db = new FakeDb();
    const store = createDbNonceStore((text, params) => db.query(text, params));
    expect(await store.consume('secret-nonce', 'm1', 300)).toBe(true);
    expect(await store.consume('secret-nonce', 'm1', 300)).toBe(false);

    // Sicherheits-Assertion: der Nonce-Wert darf NICHT im SQL-Text stehen
    for (const entry of db.log) {
      expect(entry.text).not.toContain('secret-nonce');
    }
    const inserts = db.log.filter((e) => e.text.startsWith('INSERT INTO nonce_cache'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].text).toContain('$1');
    expect(inserts[0].text).toContain('ON CONFLICT (nonce) DO NOTHING');
  });

  it('DB-Store: purgeExpired löscht per parametrisiertem DELETE', async () => {
    const db = new FakeDb();
    const store = createDbNonceStore((text, params) => db.query(text, params));
    await store.consume('n1', 'm1', -1); // sofort abgelaufen
    await store.purgeExpired();
    expect(db.nonces.size).toBe(0);
    const del = db.log.find((e) => e.text.startsWith('DELETE FROM nonce_cache'));
    expect(del).toBeDefined();
    expect(del!.text).toContain('$1');
    expect(del!.params).toHaveLength(1);
  });
});

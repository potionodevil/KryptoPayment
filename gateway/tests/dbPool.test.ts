import { afterEach, describe, expect, it } from 'vitest';
import { setPoolForTesting, tx } from '../src/db/pool.js';
import { loadSchemaSql, migrate } from '../src/db/migrate.js';
import { FakeDb, FakePool } from './helpers/fakeDb.js';

describe('db/pool.tx()', () => {
  afterEach(() => setPoolForTesting(null));

  it('führt BEGIN ... COMMIT aus und released den Client', async () => {
    const db = new FakeDb();
    const pool = new FakePool(db);
    setPoolForTesting(pool as never);
    const result = await tx(async (c) => {
      await c.query('SELECT * FROM invoices WHERE id = $1', ['x']);
      return 42;
    });
    expect(result).toBe(42);
    const texts = db.log.map((e) => e.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts).toContain('COMMIT');
    expect(texts).not.toContain('ROLLBACK');
    expect(pool.released).toBe(1);
  });

  it('rowLock:true setzt explizit READ COMMITTED (FOR UPDATE-Sperren)', async () => {
    const db = new FakeDb();
    setPoolForTesting(new FakePool(db) as never);
    await tx(async () => undefined, { rowLock: true });
    const texts = db.log.map((e) => e.text);
    expect(texts).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  });

  it('rollt bei Fehler zurück und rethrowt', async () => {
    const db = new FakeDb();
    const pool = new FakePool(db);
    setPoolForTesting(pool as never);
    await expect(
      tx(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const texts = db.log.map((e) => e.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(pool.released).toBe(1);
  });
});

describe('db/migrate', () => {
  it('loadSchemaSql liest schema.sql ein', () => {
    const sql = loadSchemaSql();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS invoices');
    expect(sql).toContain('UNIQUE (chain, txid, vout)');
    expect(sql).toContain('nonce_cache');
  });

  it('migrate() wendet das Schema auf einem DbClient an', async () => {
    const db = new FakeDb();
    await migrate(db);
    expect(db.schemaApplied).toContain('CREATE TABLE IF NOT EXISTS api_keys');
  });
});

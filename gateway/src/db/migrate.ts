/**
 * Migration: wendet schema.sql an.
 * Das Schema enthält BEGIN/COMMIT — daher läuft es als EIN Statement-Block
 * ohne umhüllende Transaktion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from '../services/contracts.js';
import { getPool } from './pool.js';

export function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'schema.sql'),
    resolve(process.cwd(), 'src/db/schema.sql'),
    resolve(process.cwd(), 'gateway/src/db/schema.sql'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }
  throw new Error(`schema.sql nicht gefunden (gesucht in: ${candidates.join(', ')})`);
}

/** Wendet schema.sql auf einem DbClient an (CREATE TABLE IF NOT EXISTS — idempotent). */
export async function migrate(client: DbClient): Promise<void> {
  await client.query(loadSchemaSql());
}

/** Wendet schema.sql über den initialisierten Pool an. */
export async function migrateWithPool(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(loadSchemaSql());
  } finally {
    client.release();
  }
}

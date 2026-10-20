/**
 * pg-Pool-Verwaltung + tx()-Hilfsfunktion.
 * tx() liefert einen DbClient im Transaktionsmodus (BEGIN ... COMMIT/ROLLBACK).
 */
import pg from 'pg';
import type { Pool as PgPool, PoolClient } from 'pg';
import type { DbClient, TxOptions } from '../services/contracts.js';

export type ExecFn = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: any[]; rowCount: number }>;

export type TxRunner = <T>(
  fn: (client: DbClient) => Promise<T>,
  opts?: TxOptions
) => Promise<T>;

let pool: PgPool | null = null;

export function initPool(connectionString: string, max = 10): PgPool {
  pool = new pg.Pool({ connectionString, max });
  return pool;
}

export function getPool(): PgPool {
  if (!pool) {
    throw new Error('DB-Pool nicht initialisiert — vorher initPool() aufrufen');
  }
  return pool;
}

/** Nur für Tests: Pool austauschen (FakePool) bzw. zurücksetzen. */
export function setPoolForTesting(p: PgPool | null): void {
  pool = p;
}

/** Einzelne Query außerhalb einer Transaktion. */
export const query: ExecFn = (text, params) =>
  getPool().query(text, (params ?? []) as unknown[]) as unknown as Promise<{
    rows: any[];
    rowCount: number;
  }>;

/**
 * Führt fn in EINER Datenbank-Transaktion aus.
 * Bei Fehler: ROLLBACK und erneutes Werfen. Der Client wird immer freigegeben.
 *
 * opts.rowLock=true setzt explizit READ COMMITTED: SELECT ... FOR UPDATE im
 * Callback sperrt die Zeile bis COMMIT; wartende Transaktionen lesen danach
 * den neuesten Stand (kein Lost Update, keine Phantom-Reads bei Zeilensperren).
 */
export async function tx<T>(
  fn: (client: DbClient) => Promise<T>,
  opts?: TxOptions
): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (opts?.rowLock) {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK-Fehler schlucken — Originalfehler ist relevanter
    }
    throw err;
  } finally {
    client.release();
  }
}

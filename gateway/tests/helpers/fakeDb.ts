/**
 * In-Memory DbClient-Mock gemäß services/contracts.ts.
 * Emuliert die von den Services verwendeten parametrisierten SQL-Statements
 * (INSERT ... ON CONFLICT DO NOTHING, SELECT ... FOR UPDATE, SUM-Aggregate)
 * gegen einfache Maps — KEIN echter DB-Zugriff in Tests.
 *
 * Wichtig: Der Fake matched die EXAKTEN SQL-Texte der Produktion. Dadurch
 * stellt jeder Test stillschweigend sicher, dass die Services parametrisierte
 * Statements ohne String-Konkatenation von Werten verwenden.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient, TxOptions } from '../../src/services/contracts.js';
import { addDecimalStrings } from '../../src/core/paymentService.js';

export interface QueryLogEntry {
  text: string;
  params: unknown[];
}

type Row = Record<string, any>;

export class FakeDb implements DbClient {
  invoices = new Map<string, Row>();
  payments: Row[] = [];
  nonces = new Map<string, Row>();
  apiKeys = new Map<string, Row>();
  schemaApplied = '';
  log: QueryLogEntry[] = [];
  /** Hook, um Nebenbedingungen (z.B. konkurrierende Writes) zu simulieren. */
  hooks: { before?: (text: string, params: unknown[], db: FakeDb) => void } = {};

  private seq = 0;
  private mutex: Promise<unknown> = Promise.resolve();
  private txSeq = 0;
  /** Row-Locks (SELECT ... FOR UPDATE) — werden bei COMMIT/ROLLBACK freigegeben. */
  private locks = new Map<string, { txId: string | null; waiters: Array<() => void> }>();

  /** Alle Queries laufen serialisiert (emuliert die Zeilen-Serialisierung der echten DB). */
  query(text: string, params: unknown[] = [], txId?: string): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    const isForUpdate =
      sql.toLowerCase() === 'select * from invoices where id = $1 for update';
    // Sperrerwerb läuft AUSSERHALB der Query-Chain, damit COMMIT eines
    // anderen Transaktion nicht blockiert wird (emuliert echtes FOR UPDATE).
    const acquire = isForUpdate
      ? this.acquireLock(`inv:${String(params[0])}`, txId ?? null)
      : Promise.resolve();
    return acquire.then(() =>
      this.enqueue(() => this.execute(sql, params, txId))
    );
  }

  /** Per-Transaktions-Client (pg-Client im Transaktionsmodus inkl. Row-Locks). */
  txClient(): DbClient & { txId: string } {
    const txId = `tx-${++this.txSeq}`;
    return {
      txId,
      query: (text: string, params?: unknown[]) => this.query(text, params, txId),
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private acquireLock(key: string, txId: string | null): Promise<void> {
    if (txId === null) return Promise.resolve(); // ohne Transaktion kein Sperren
    const attempt = (): Promise<void> => {
      const entry = this.locks.get(key);
      if (!entry) {
        this.locks.set(key, { txId, waiters: [] });
        return Promise.resolve();
      }
      if (entry.txId === txId) return Promise.resolve(); // eigene Sperre
      return new Promise<void>((resolve) => {
        entry.waiters.push(resolve);
      }).then(attempt);
    };
    return attempt();
  }

  private releaseLocks(txId: string): void {
    for (const [key, entry] of this.locks) {
      if (entry.txId === txId) {
        this.locks.delete(key);
        for (const wake of entry.waiters) wake();
      }
    }
  }

  // ---- Test-Helfer -------------------------------------------------------
  seedApiKey(opts: {
    merchantId: string;
    keyId: string;
    keyHash: string;
    secretEnc: string;
    ipWhitelist?: string[];
    isActive?: boolean;
  }): Row {
    const row: Row = {
      id: randomUUID(),
      merchant_id: opts.merchantId,
      key_id: opts.keyId,
      key_hash: opts.keyHash,
      secret_enc: opts.secretEnc,
      ip_whitelist: opts.ipWhitelist ?? [],
      is_active: opts.isActive ?? true,
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    this.apiKeys.set(opts.keyId, row);
    return row;
  }

  invoiceRow(id: string): Row | undefined {
    return this.invoices.get(id);
  }

  paymentRows(): Row[] {
    return [...this.payments];
  }

  // ---- SQL-Emulation -----------------------------------------------------
  private async execute(
    text: string,
    params: unknown[],
    txId?: string
  ): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.log.push({ text: sql, params });
    if (this.hooks.before) this.hooks.before(sql, params, this);
    const q = sql.toLowerCase();

    // Migration (schema.sql als ein Statement-Block)
    if (q.includes('create table if not exists')) {
      this.schemaApplied = sql;
      return { rows: [], rowCount: 0 };
    }
    // Transaktions-Steuerung (Row-Locks bei Transaktionsende freigeben)
    if (q === 'begin' || q === 'commit' || q === 'rollback' || q.startsWith('set transaction')) {
      if ((q === 'commit' || q === 'rollback') && txId) {
        this.releaseLocks(txId);
      }
      return { rows: [], rowCount: 0 };
    }

    // --- invoices ---------------------------------------------------------
    if (q.startsWith('insert into invoices')) {
      const conflictKey = `${String(params[0])}\u0000${String(params[1])}`;
      for (const row of this.invoices.values()) {
        if (`${String(row.merchant_id)}\u0000${String(row.order_ref)}` === conflictKey) {
          return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
        }
      }
      const now = new Date().toISOString();
      const row: Row = {
        id: randomUUID(),
        merchant_id: params[0],
        order_ref: params[1],
        amount_fiat: params[2],
        fiat_currency: params[3],
        amount_crypto: params[4],
        crypto_currency: params[5],
        chain: params[6],
        address: params[7],
        status: params[8],
        expires_at: params[9],
        paid_at: null,
        confirmed_at: null,
        version: 0,
        created_at: now,
        updated_at: now,
      };
      this.invoices.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('select * from invoices where id = $1')) {
      const row = this.invoices.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith('select * from invoices where merchant_id = $1 and order_ref = $2')) {
      for (const row of this.invoices.values()) {
        if (row.merchant_id === params[0] && row.order_ref === params[1]) {
          return { rows: [row], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (q.startsWith('update invoices set status')) {
      const row = this.invoices.get(String(params[0]));
      const expectedVersion = Number(params[2]);
      if (!row || row.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }; // Optimistic-Lock-Fehler
      }
      const now = new Date().toISOString();
      row.status = params[1];
      row.version = row.version + 1;
      row.updated_at = now;
      if (row.status === 'PAID' && row.paid_at === null) row.paid_at = now;
      if (row.status === 'CONFIRMED' && row.confirmed_at === null) row.confirmed_at = now;
      return { rows: [row], rowCount: 1 };
    }

    // --- payments ---------------------------------------------------------
    if (q.startsWith('insert into payments')) {
      for (const row of this.payments) {
        if (row.chain === params[1] && row.txid === params[2] && row.vout === Number(params[3])) {
          return { rows: [], rowCount: 0 }; // ON CONFLICT (chain,txid,vout) DO NOTHING
        }
      }
      const now = new Date().toISOString();
      const row: Row = {
        id: randomUUID(),
        invoice_id: params[0],
        chain: params[1],
        txid: params[2],
        vout: Number(params[3]),
        amount: params[4],
        confirmations: Number(params[5]),
        status: params[6],
        raw: null,
        detected_at: now,
        updated_at: now,
      };
      this.payments.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('select * from payments where chain = $1 and txid = $2 and vout = $3')) {
      const row = this.payments.find(
        (p) => p.chain === params[0] && p.txid === params[1] && p.vout === Number(params[2])
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith('update payments set confirmations')) {
      const row = this.payments.find(
        (p) => p.chain === params[0] && p.txid === params[1] && p.vout === Number(params[2])
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.confirmations = Math.max(row.confirmations, Number(params[3]));
      row.status = params[4];
      row.updated_at = new Date().toISOString();
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('select coalesce(sum(amount), 0) as total')) {
      const required = Number(params[1]);
      const relevant = this.payments.filter(
        (p) => p.invoice_id === params[0] && p.status !== 'REORGED'
      );
      let total = '0';
      for (const p of relevant) total = addDecimalStrings(total, String(p.amount));
      const countUnconfirmed = relevant.filter((p) => p.confirmations < required).length;
      return {
        rows: [{ total, count_all: relevant.length, count_unconfirmed: countUnconfirmed }],
        rowCount: 1,
      };
    }

    // --- nonce_cache ------------------------------------------------------
    if (q.startsWith('insert into nonce_cache')) {
      const nonce = String(params[0]);
      if (this.nonces.has(nonce)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      this.nonces.set(nonce, {
        nonce,
        merchant_id: params[1],
        expires_at: params[2],
        expiresTs: Date.parse(String(params[2])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('delete from nonce_cache')) {
      const cutoff = Date.parse(String(params[0]));
      let deleted = 0;
      for (const [k, v] of this.nonces) {
        if (v.expiresTs < cutoff) {
          this.nonces.delete(k);
          deleted++;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    // --- api_keys ---------------------------------------------------------
    if (q.startsWith('insert into api_keys')) {
      const keyId = String(params[1]);
      if (this.apiKeys.has(keyId)) {
        throw new Error('duplicate key_id');
      }
      const row: Row = {
        id: randomUUID(),
        merchant_id: params[0],
        key_id: keyId,
        key_hash: params[2],
        secret_enc: params[3],
        ip_whitelist: params[4] ?? [],
        is_active: true,
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      this.apiKeys.set(keyId, row);
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('select * from api_keys where key_id = $1')) {
      const row = this.apiKeys.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith('select * from api_keys where merchant_id = $1')) {
      const rows = [...this.apiKeys.values()].filter((r) => r.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (q.startsWith('update api_keys set last_used_at')) {
      const row = this.apiKeys.get(String(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      row.last_used_at = new Date().toISOString();
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('update api_keys set is_active')) {
      const row = this.apiKeys.get(String(params[0]));
      if (!row || row.merchant_id !== params[1]) return { rows: [], rowCount: 0 };
      row.is_active = false;
      return { rows: [row], rowCount: 1 };
    }
    if (q.startsWith('update api_keys set ip_whitelist')) {
      const row = this.apiKeys.get(String(params[0]));
      if (!row || row.merchant_id !== params[1]) return { rows: [], rowCount: 0 };
      row.ip_whitelist = params[2];
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`FakeDb: unbekanntes SQL-Statement: ${sql}`);
  }
}

/**
 * TxRunner-Ableitung für Tests: führt fn mit einem eigenen Transaktions-Client
 * aus und protokolliert BEGIN/COMMIT/ROLLBACK wie die echte tx()-Hilfsfunktion.
 * Row-Locks (SELECT ... FOR UPDATE) werden von FakeDb emuliert.
 */
export function fakeTxRunner(db: FakeDb) {
  return async <T>(fn: (client: DbClient) => Promise<T>, _opts?: TxOptions): Promise<T> => {
    const client = db.txClient();
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  };
}

/** Minimaler pg-Pool-Stub, um db/pool.ts (tx()) ohne echte DB zu testen. */
export class FakePool {
  released = 0;
  constructor(private readonly db: FakeDb) {}
  async connect(): Promise<{ query: DbClient['query']; release: () => void }> {
    const db = this.db;
    return {
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {
        this.released += 1;
      },
    };
  }
}

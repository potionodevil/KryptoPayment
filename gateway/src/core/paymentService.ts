/**
 * Payment-Core: erkennt eingehende Chain-Zahlungen und bucht sie IDEMPOTENT gut.
 *
 * Race-Condition-Härte:
 * - applyIncomingPayment läuft in EINER Transaktion mit SELECT ... FOR UPDATE
 *   auf der Invoice-Zeile (serialisiert konkurrierende Buchungen).
 * - INSERT ... ON CONFLICT (chain, txid, vout) DO NOTHING: eine TXO wird nie
 *   doppelt gutgeschrieben (UNIQUE-Constraint aus schema.sql).
 * - Statusberechnung per SUMME über alle Payment-Zeilen -> idempotent.
 *
 * Die Chain wird NUR als Daten übergeben (chain, txid, vout, amount,
 * confirmations) — keine Abhängigkeit zu src/chains.
 */
import type {
  DbClient,
  PaymentService as PaymentServiceContract,
} from '../services/contracts.js';
import type { Chain, Invoice, InvoiceStatus, Payment, PaymentStatus } from '../types/index.js';
import { tx as defaultTxRunner, type TxRunner } from '../db/pool.js';
import {
  findTransitionPath,
  GatewayError,
  isTerminal,
} from './stateMachine.js';
import {
  mapInvoice,
  SQL_SELECT_INVOICE_FOR_UPDATE,
  SQL_UPDATE_INVOICE_STATUS,
} from './invoiceService.js';

// ---------------------------------------------------------------------------
// Exakte Dezimal-Arithmetik: implementiert in core/decimal.ts und hier für
// Bestands-Imports (FakeDb, Tests) re-exportiert.
// ---------------------------------------------------------------------------

import { compareDecimalStrings } from './decimal.js';

export { addDecimalStrings, compareDecimalStrings } from './decimal.js';

// ---------------------------------------------------------------------------
// SQL (parametrisiert)
// ---------------------------------------------------------------------------

export const SQL_INSERT_PAYMENT =
  'INSERT INTO payments (invoice_id, chain, txid, vout, amount, confirmations, status) ' +
  'VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
  'ON CONFLICT (chain, txid, vout) DO NOTHING RETURNING *';

export const SQL_SELECT_PAYMENT_BY_TXO =
  'SELECT * FROM payments WHERE chain = $1 AND txid = $2 AND vout = $3';

export const SQL_UPDATE_PAYMENT_CONFIRMATIONS =
  'UPDATE payments SET confirmations = GREATEST(confirmations, $4), status = $5, updated_at = now() ' +
  'WHERE chain = $1 AND txid = $2 AND vout = $3 RETURNING *';

export const SQL_AGGREGATE_PAYMENTS =
  'SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count_all, ' +
  'COUNT(*) FILTER (WHERE confirmations < $2) AS count_unconfirmed ' +
  "FROM payments WHERE invoice_id = $1 AND status <> 'REORGED'";

// ---------------------------------------------------------------------------
// Defaults & Mapping
// ---------------------------------------------------------------------------

export const DEFAULT_REQUIRED_CONFIRMATIONS: Record<Chain, number> = {
  BTC: 3,
  LTC: 6,
  ETH: 12,
  SOL: 32,
  XMR: 10,
};

export function mapPayment(row: any): Payment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    chain: row.chain as Chain,
    txid: row.txid,
    vout: Number(row.vout),
    amount: String(row.amount),
    confirmations: Number(row.confirmations),
    status: row.status as PaymentStatus,
    detectedAt:
      row.detected_at instanceof Date
        ? row.detected_at.toISOString()
        : String(row.detected_at),
  };
}

export interface PaymentServiceDeps {
  txRunner?: TxRunner;
  /** Überschreibt die benötigten Bestätigungen je Chain. */
  requiredConfirmations?: Partial<Record<Chain, number>>;
}

export interface IncomingPayment {
  chain: Chain;
  txid: string;
  vout: number;
  amount: string;
  confirmations: number;
}

export function createPaymentService(deps: PaymentServiceDeps = {}): PaymentServiceContract {
  const txRunner: TxRunner = deps.txRunner ?? defaultTxRunner;
  const required: Record<Chain, number> = {
    ...DEFAULT_REQUIRED_CONFIRMATIONS,
    ...deps.requiredConfirmations,
  };

  const run = <T>(client: DbClient | undefined, fn: (c: DbClient) => Promise<T>): Promise<T> =>
    client ? fn(client) : txRunner(fn, { rowLock: true });

  function requiredFor(chain: Chain): number {
    return required[chain] ?? DEFAULT_REQUIRED_CONFIRMATIONS[chain] ?? 1;
  }

  /** Invoice-Zeile mit Row-Lock lesen (bis Transaktionsende gesperrt). */
  async function lockInvoice(c: DbClient, invoiceId: string): Promise<any | null> {
    const res = await c.query(SQL_SELECT_INVOICE_FOR_UPDATE, [invoiceId]);
    return res.rows[0] ?? null;
  }

  /** Führt ggf. mehrere gültige State-Übergänge hintereinander aus. */
  async function applyTransitionPath(c: DbClient, inv: any, path: InvoiceStatus[]): Promise<any> {
    let current = inv;
    for (const step of path) {
      const updated = await c.query(SQL_UPDATE_INVOICE_STATUS, [
        current.id,
        step,
        current.version,
      ]);
      if (updated.rowCount === 0) {
        throw new GatewayError(
          'CONCURRENT_MODIFICATION',
          'Invoice wurde parallel geändert — bitte erneut versuchen',
          409
        );
      }
      current = updated.rows[0];
    }
    return current;
  }

  /**
   * Zählt alle nicht-reorged Payments und leitet den Zielstatus ab:
   * Summe < amountCrypto -> PARTIALLY_PAID, Summe >= amountCrypto -> PAID,
   * vollständig + alle Bestätigungen vorhanden -> CONFIRMED.
   */
  async function recomputeLocked(c: DbClient, inv: any): Promise<any> {
    if (isTerminal(inv.status as InvoiceStatus)) {
      return inv; // EXPIRED/CANCELLED/CONFIRMED sind endgültig
    }
    const requiredConf = requiredFor(inv.chain as Chain);
    const agg = await c.query(SQL_AGGREGATE_PAYMENTS, [inv.id, requiredConf]);
    const total = String(agg.rows[0]?.total ?? '0');
    const unconfirmed = Number(agg.rows[0]?.count_unconfirmed ?? 0);
    const amountCrypto =
      inv.amount_crypto === null || inv.amount_crypto === undefined
        ? '0'
        : String(inv.amount_crypto);

    let goal: InvoiceStatus | null = null;
    const cmp = compareDecimalStrings(total, amountCrypto);
    if (cmp >= 0 && unconfirmed === 0) {
      goal = 'CONFIRMED';
    } else if (cmp >= 0) {
      goal = 'PAID';
    } else if (compareDecimalStrings(total, '0') > 0) {
      goal = 'PARTIALLY_PAID';
    }
    if (!goal || goal === inv.status) return inv;

    const path = findTransitionPath(inv.status as InvoiceStatus, goal);
    if (!path || path.length === 0) return inv;
    return applyTransitionPath(c, inv, path);
  }

  async function applyIncomingPayment(
    invoiceId: string,
    payment: IncomingPayment,
    client?: DbClient
  ): Promise<{ applied: boolean; payment: Payment }> {
    return run(client, async (c) => {
      const inv = await lockInvoice(c, invoiceId);
      if (!inv) {
        throw new GatewayError('INVOICE_NOT_FOUND', `Invoice ${invoiceId} nicht gefunden`, 404);
      }
      const requiredConf = requiredFor(payment.chain);
      const paymentStatus: PaymentStatus =
        payment.confirmations >= requiredConf ? 'CONFIRMED' : 'DETECTED';

      const inserted = await c.query(SQL_INSERT_PAYMENT, [
        invoiceId,
        payment.chain,
        payment.txid,
        payment.vout,
        payment.amount,
        payment.confirmations,
        paymentStatus,
      ]);

      let row: any;
      let applied = false;
      if (inserted.rowCount > 0) {
        applied = true;
        row = inserted.rows[0];
      } else {
        // TXO existiert bereits: KEINE erneute Gutschrift (Idempotenz).
        const existing = await c.query(SQL_SELECT_PAYMENT_BY_TXO, [
          payment.chain,
          payment.txid,
          payment.vout,
        ]);
        row = existing.rows[0];
        if (!row) {
          throw new GatewayError('PAYMENT_CONFLICT', 'Zahlung konnte nicht gelesen werden', 409);
        }
        if (row.invoice_id !== invoiceId) {
          // Eine TXO darf NIE zwei Invoices gutgeschrieben werden.
          throw new GatewayError(
            'TXO_ALREADY_USED',
            `TXO ${payment.chain}/${payment.txid}:${payment.vout} ist bereits einer anderen Invoice zugeordnet`,
            409
          );
        }
        // Bestätigungen dürfen wachsen (kein Geldfluss -> keine Doppelgutschrift).
        const updated = await c.query(SQL_UPDATE_PAYMENT_CONFIRMATIONS, [
          payment.chain,
          payment.txid,
          payment.vout,
          payment.confirmations,
          paymentStatus,
        ]);
        row = updated.rows[0] ?? row;
      }

      await recomputeLocked(c, inv);
      return { applied, payment: mapPayment(row) };
    });
  }

  async function recomputeInvoiceStatus(invoiceId: string, client?: DbClient): Promise<Invoice> {
    return run(client, async (c) => {
      const inv = await lockInvoice(c, invoiceId);
      if (!inv) {
        throw new GatewayError('INVOICE_NOT_FOUND', `Invoice ${invoiceId} nicht gefunden`, 404);
      }
      return mapInvoice(await recomputeLocked(c, inv));
    });
  }

  return { applyIncomingPayment, recomputeInvoiceStatus };
}

/** Singleton gegen den Live-Pool (Wiring in src/index.ts). */
export const paymentService: PaymentServiceContract = createPaymentService();

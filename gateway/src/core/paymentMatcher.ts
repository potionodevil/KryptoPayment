/**
 * Ordnet eingehende Blockchain-Zahlungen einer Invoice zu (Betrags-Matching).
 *
 * Forwarding-Modell (non-custodial): Alle Bestellungen zahlen direkt an die
 * statische Zieladresse der Invoice (req.targetAddress). Da aktive Invoices
 * derselben Chain/Currency EINDEUTIGE Beträge haben, erfolgt die Zuordnung über
 * den EXAKTEN Betrag (Vergleich in der kleinsten Einheit) + FIFO (älteste
 * zuerst). IDEMPOTENT & race-sicher: eine (chain, txid, vout) wird nie doppelt
 * verarbeitet (UNIQUE-Constraint + ON CONFLICT DO NOTHING + Advisory-Lock).
 *
 * Es werden NIE Guthaben gebucht — nur der Transaktions-Nachweis
 * (payments-Tabelle) + der Invoice-Status.
 */
import type {
  DbClient,
  PaymentMatcher as PaymentMatcherContract,
  PaymentService,
} from '../services/contracts.js';
import type { Chain } from '../types/index.js';
import { tx as defaultTxRunner, type TxRunner } from '../db/pool.js';
import { amountsEqual, compareDecimalStrings, isDecimalString } from './decimal.js';
import { SQL_ADVISORY_XACT_LOCK, forwardingLockKey } from './locking.js';
import { SQL_SELECT_INVOICE_FOR_UPDATE } from './invoiceService.js';
import {
  paymentService as defaultPaymentService,
  SQL_SELECT_PAYMENT_BY_TXO,
} from './paymentService.js';
import { GatewayError } from './stateMachine.js';

/** Kandidaten: unbezahlte Invoices derselben Chain/Currency, FIFO (älteste zuerst). */
export const SQL_SELECT_MATCH_CANDIDATES =
  'SELECT * FROM invoices WHERE chain = $1 AND crypto_currency = $2 ' +
  "AND status IN ('AWAITING_PAYMENT','PARTIALLY_PAID') ORDER BY created_at ASC, id ASC";

const MATCHABLE_STATUSES = new Set(['AWAITING_PAYMENT', 'PARTIALLY_PAID']);

export interface IncomingMatchPayment {
  chain: Chain;
  currency: string;
  txid: string;
  vout: number;
  amount: string;
  confirmations: number;
}

export interface PaymentMatcherDeps {
  txRunner?: TxRunner;
  /** Idempotente DB-Logik (applyIncomingPayment) wird wiederverwendet. */
  payments?: PaymentService;
}

export function createPaymentMatcher(
  deps: PaymentMatcherDeps = {}
): PaymentMatcherContract {
  const txRunner: TxRunner = deps.txRunner ?? defaultTxRunner;
  const payments: PaymentService = deps.payments ?? defaultPaymentService;

  async function matchAndApply(
    payment: IncomingMatchPayment
  ): Promise<{ matchedInvoiceId: string | null; applied: boolean }> {
    const amount = String(payment.amount).trim();
    if (!isDecimalString(amount)) {
      throw new GatewayError('VALIDATION_ERROR', `Ungültiger Betrag: ${payment.amount}`, 400);
    }
    const currency = payment.currency.trim().toUpperCase();
    const record = {
      chain: payment.chain,
      txid: payment.txid,
      vout: payment.vout,
      amount,
      confirmations: payment.confirmations,
    };

    return txRunner(async (c: DbClient) => {
      // Serialisierung pro (chain, currency) — race-sicher zu createInvoice
      // (Betrags-Nudge) und parallelen Zuordnungen derselben Chain/Currency.
      await c.query(SQL_ADVISORY_XACT_LOCK, [forwardingLockKey(payment.chain, currency)]);

      // Idempotenz: TXO bereits verarbeitet -> KEINE erneute Zuordnung.
      // Bestätigungen dürfen wachsen (kein Geldfluss -> keine Doppelgutschrift).
      const existing = await c.query(SQL_SELECT_PAYMENT_BY_TXO, [
        payment.chain,
        payment.txid,
        payment.vout,
      ]);
      if (existing.rowCount > 0) {
        const invoiceId = String(existing.rows[0].invoice_id);
        await payments.applyIncomingPayment(invoiceId, record, c);
        return { matchedInvoiceId: invoiceId, applied: false };
      }

      // Kandidaten: unbezahlte Invoices derselben Chain/Currency (FIFO).
      // 1) EXAKTE Betragsgleichheit (String-Vergleich in kleinster Einheit) — primär.
      // 2) Teilzahlung ("passender Betrag": Betrag <= amount_crypto) — älteste zuerst.
      const candidates = await c.query(SQL_SELECT_MATCH_CANDIDATES, [
        payment.chain,
        currency,
      ]);
      const eligible = candidates.rows.filter(
        (row: any) => compareDecimalStrings(amount, String(row.amount_crypto ?? '0')) <= 0
      );
      const ordered = [
        ...eligible.filter((row: any) => amountsEqual(String(row.amount_crypto ?? '0'), amount)),
        ...eligible.filter((row: any) => !amountsEqual(String(row.amount_crypto ?? '0'), amount)),
      ];
      for (const row of ordered) {
        // Row-Lock + Re-Check (SELECT ... FOR UPDATE)
        const locked = await c.query(SQL_SELECT_INVOICE_FOR_UPDATE, [row.id]);
        const inv = locked.rows[0];
        if (!inv || !MATCHABLE_STATUSES.has(String(inv.status))) continue;
        if (compareDecimalStrings(amount, String(inv.amount_crypto ?? '0')) > 0) continue;
        // Idempotente Buchung (UNIQUE(chain,txid,vout)) + Status-Recomputation:
        // Summe >= amount_crypto -> PAID (bei vollem Confirmations-Limit -> CONFIRMED),
        // Teilbetrag -> PARTIALLY_PAID.
        const res = await payments.applyIncomingPayment(String(inv.id), record, c);
        return { matchedInvoiceId: String(inv.id), applied: res.applied };
      }
      // Keine passende Invoice -> KEINE Buchung (non-custodial: nichts verwahrt).
      return { matchedInvoiceId: null, applied: false };
    }, { rowLock: true });
  }

  return { matchAndApply };
}

/** Singleton gegen den Live-Pool (Wiring in src/index.ts). */
export const paymentMatcher: PaymentMatcherContract = createPaymentMatcher();

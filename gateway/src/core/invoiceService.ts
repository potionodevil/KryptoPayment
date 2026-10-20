/**
 * Invoice-Core: erstellt und verwaltet Invoices race-condition-sicher.
 *
 * Forwarding-Modell (NON-CUSTODIAL): Die Zieladresse kommt mit der Anfrage
 * (req.targetAddress) und wird nur gespeichert — KEINE Adressableitung, KEINE
 * Keys, keine Verwahrung. Das Adress-FORMAT wird pro Chain geprüft
 * (core/addressProvider.ts).
 *
 * Alle Status-Änderungen laufen in EINER Transaktion mit SELECT ... FOR UPDATE
 * und optimistic locking über invoices.version.
 *
 * Betrags-Eindeutigkeit: Unter AKTIVEN (unbezahlten) Invoices derselben
 * Chain/Currency ist der Betrag eindeutig — kollidiert er, wird er um die
 * kleinste Einheit der Chain "genudged". Damit ist die Zuordnung eingehender
 * Zahlungen über den exakten Betrag (paymentMatcher) immer eindeutig.
 * Race-sicher über Transaktion + Advisory-Lock pro (chain, currency).
 */
import { z } from 'zod';
import type {
  DbClient,
  InvoiceService as InvoiceServiceContract,
} from '../services/contracts.js';
import type { Chain, CreateInvoiceRequest, Invoice, InvoiceStatus } from '../types/index.js';
import { tx as defaultTxRunner, type TxRunner } from '../db/pool.js';
import { assertValidAddress } from './addressProvider.js';
import { addMinUnit, compareDecimalStrings, isDecimalString } from './decimal.js';
import { SQL_ADVISORY_XACT_LOCK, forwardingLockKey } from './locking.js';
import { assertTransition, GatewayError, isTerminal } from './stateMachine.js';

// ---------------------------------------------------------------------------
// Parametrisierte SQL-Statements (NIE String-Konkatenation von Werten!)
// ---------------------------------------------------------------------------

export const SQL_INSERT_INVOICE =
  'INSERT INTO invoices (merchant_id, order_ref, amount_fiat, fiat_currency, amount_crypto, crypto_currency, chain, address, status, expires_at, version) ' +
  'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0) ' +
  'ON CONFLICT (merchant_id, order_ref) DO NOTHING RETURNING *';

export const SQL_SELECT_INVOICE_BY_ID = 'SELECT * FROM invoices WHERE id = $1';

export const SQL_SELECT_INVOICE_FOR_UPDATE =
  'SELECT * FROM invoices WHERE id = $1 FOR UPDATE';

export const SQL_SELECT_INVOICE_BY_ORDER_REF =
  'SELECT * FROM invoices WHERE merchant_id = $1 AND order_ref = $2';

/**
 * Aktive (unbezahlte) Invoices mit exakt kollidierendem Betrag.
 * Grundlage der Betrags-Eindeutigkeit; FOR UPDATE sperrt Kollisionszeilen.
 */
export const SQL_SELECT_ACTIVE_BY_AMOUNT =
  'SELECT id FROM invoices WHERE chain = $1 AND crypto_currency = $2 AND amount_crypto = $3 ' +
  "AND status IN ('CREATED','AWAITING_PAYMENT','PARTIALLY_PAID') FOR UPDATE";

/** Status-Update mit optimistic locking (version-Guard) + paid_at/confirmed_at. */
export const SQL_UPDATE_INVOICE_STATUS =
  'UPDATE invoices SET status = $2, version = version + 1, updated_at = now(), ' +
  "paid_at = CASE WHEN $2 = 'PAID' AND paid_at IS NULL THEN now() ELSE paid_at END, " +
  "confirmed_at = CASE WHEN $2 = 'CONFIRMED' AND confirmed_at IS NULL THEN now() ELSE confirmed_at END " +
  'WHERE id = $1 AND version = $3 RETURNING *';

// ---------------------------------------------------------------------------
// Validierung (zod) — zusätzlich zur Validierung in der API-Schicht
// ---------------------------------------------------------------------------

const CHAIN_VALUES = ['BTC', 'LTC', 'ETH', 'SOL', 'XMR'] as const;

const DECIMAL_RE = /^\d+(\.\d{1,18})?$/;

export const CreateInvoiceSchema = z.object({
  orderRef: z.string().min(1).max(255),
  amountFiat: z
    .string()
    .regex(DECIMAL_RE, 'amountFiat muss eine positive Dezimalzahl sein')
    .refine((s) => Number(s) > 0, 'amountFiat muss > 0 sein'),
  fiatCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  cryptoCurrency: z.string().min(2).max(10),
  chain: z.enum(CHAIN_VALUES),
  /** Forwarding-Zieladresse des Betreibers (wird auf der Invoice gespeichert). */
  targetAddress: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function mapInvoice(row: any): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderRef: row.order_ref,
    amountFiat: String(row.amount_fiat),
    fiatCurrency: row.fiat_currency,
    amountCrypto: row.amount_crypto === null || row.amount_crypto === undefined
      ? null
      : String(row.amount_crypto),
    cryptoCurrency: row.crypto_currency,
    chain: row.chain as Chain,
    address: row.address,
    status: row.status as InvoiceStatus,
    expiresAt: iso(row.expires_at),
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Quote-Provider (Kurs-Feed; wird per Injection verdrahtet)
// ---------------------------------------------------------------------------

export interface CryptoQuote {
  /** Exakter Krypto-Betrag als String (kein Float). */
  amountCrypto: string;
  /** @deprecated ignoriert — die Zieladresse kommt aus req.targetAddress. */
  address?: string;
}

export type QuoteProvider = (
  req: CreateInvoiceRequest,
  merchantId: string
) => Promise<CryptoQuote>;

/**
 * Platzhalter-Provider: 1:1-Kurs (amountFiat = amountCrypto).
 * In Produktion ersetzt (via setQuoteProvider) durch einen Kurs-Feed.
 * Es wird KEINE Adresse vergeben — non-custodial.
 */
export const defaultQuoteProvider: QuoteProvider = async (req) => ({
  amountCrypto: req.amountFiat,
});

let activeQuote: QuoteProvider = defaultQuoteProvider;

/** Verdrahtet den globalen Quote-Provider des Singleton-Services. */
export function setQuoteProvider(provider: QuoteProvider): void {
  activeQuote = provider;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface InvoiceServiceDeps {
  txRunner?: TxRunner;
  quote?: QuoteProvider;
  clock?: () => Date;
  /** Gültigkeit einer Invoice ab Erstellung (Sekunden). */
  ttlSec?: number;
}

/** Obergrenze Nudge-Versuche, bis ein Betrag eindeutig ist. */
const MAX_AMOUNT_NUDGES = 10_000;

/** Status aktiver (unbezahlter) Invoices — Grundlage der Betrags-Eindeutigkeit. */
const ACTIVE_STATUSES = new Set(['CREATED', 'AWAITING_PAYMENT', 'PARTIALLY_PAID']);

export function createInvoiceService(deps: InvoiceServiceDeps = {}): InvoiceServiceContract {
  const txRunner: TxRunner = deps.txRunner ?? defaultTxRunner;
  const clock = deps.clock ?? (() => new Date());
  const ttlSec = deps.ttlSec ?? 1800;
  const quote: QuoteProvider = deps.quote ?? ((req, merchantId) => activeQuote(req, merchantId));

  const run = <T>(client: DbClient | undefined, fn: (c: DbClient) => Promise<T>): Promise<T> =>
    client ? fn(client) : txRunner(fn, { rowLock: true });

  /**
   * Macht den Betrag unter AKTIVEN Invoices derselben Chain/Currency eindeutig:
   * Kollision -> + kleinste Einheit der Chain, bis frei (max. MAX_AMOUNT_NUDGES).
   */
  async function ensureUniqueActiveAmount(
    c: DbClient,
    chain: Chain,
    currency: string,
    initial: string
  ): Promise<string> {
    let amount = initial;
    for (let i = 0; ; i++) {
      const hit = await c.query(SQL_SELECT_ACTIVE_BY_AMOUNT, [chain, currency, amount]);
      if (hit.rowCount === 0) return amount;
      if (i >= MAX_AMOUNT_NUDGES) {
        throw new GatewayError(
          'AMOUNT_EXHAUSTED',
          `Betrag ${initial} für ${chain}/${currency} konnte nicht eindeutig gemacht werden`,
          409
        );
      }
      amount = addMinUnit(amount, chain);
    }
  }

  /** Idempotenz-Prüfung: gleiche order_ref nur mit gleichen Parametern erlaubt. */
  function assertCompatible(row: any, data: z.infer<typeof CreateInvoiceSchema>): void {
    const compatible =
      String(row.amount_fiat) === data.amountFiat &&
      row.fiat_currency === data.fiatCurrency.toUpperCase() &&
      row.chain === data.chain &&
      row.crypto_currency === data.cryptoCurrency.toUpperCase();
    if (!compatible) {
      throw new GatewayError(
        'ORDER_REF_CONFLICT',
        `order_ref "${data.orderRef}" wurde bereits mit anderen Parametern verwendet`,
        409
      );
    }
  }

  async function createInvoice(
    merchantId: string,
    req: CreateInvoiceRequest,
    client?: DbClient
  ): Promise<Invoice> {
    const parsed = CreateInvoiceSchema.safeParse(req);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new GatewayError('VALIDATION_ERROR', `Ungültige Invoice-Anfrage — ${msg}`, 400);
    }
    const data = parsed.data;
    const currency = data.cryptoCurrency.toUpperCase();
    // Forwarding: Zieladresse aus der Anfrage, nur FORMAT-Check pro Chain.
    const targetAddress = data.targetAddress.trim();
    assertValidAddress(data.chain, targetAddress);

    const qres = await quote({ ...req, ...data, targetAddress }, merchantId);
    let amountCrypto = String(qres.amountCrypto ?? '').trim();
    if (!isDecimalString(amountCrypto) || compareDecimalStrings(amountCrypto, '0') <= 0) {
      throw new GatewayError(
        'VALIDATION_ERROR',
        'amount_crypto muss eine positive Dezimalzahl sein',
        400
      );
    }
    const expiresAt = new Date(clock().getTime() + ttlSec * 1000).toISOString();

    return run(client, async (c) => {
      // Race-sicher: serialisiert Erstellungen pro (chain, currency)
      await c.query(SQL_ADVISORY_XACT_LOCK, [forwardingLockKey(data.chain, currency)]);

      // Idempotenz: gleiche (merchant_id, order_ref) liefert die bestehende Invoice.
      const existing = await c.query(SQL_SELECT_INVOICE_BY_ORDER_REF, [
        merchantId,
        data.orderRef,
      ]);
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        assertCompatible(row, data);
        return mapInvoice(row);
      }

      // Eindeutiger Betrag unter AKTIVEN Invoices derselben Chain/Currency
      amountCrypto = await ensureUniqueActiveAmount(c, data.chain, currency, amountCrypto);

      const inserted = await c.query(SQL_INSERT_INVOICE, [
        merchantId,
        data.orderRef,
        data.amountFiat,
        data.fiatCurrency.toUpperCase(),
        amountCrypto,
        currency,
        data.chain,
        targetAddress,
        'AWAITING_PAYMENT',
        expiresAt,
      ]);
      if (inserted.rowCount > 0) {
        return mapInvoice(inserted.rows[0]);
      }
      // ON-CONFLICT-Race um (merchant_id, order_ref) -> bestehende Invoice.
      const again = await c.query(SQL_SELECT_INVOICE_BY_ORDER_REF, [
        merchantId,
        data.orderRef,
      ]);
      const row = again.rows[0];
      if (!row) {
        throw new GatewayError('INVOICE_CONFLICT', 'Invoice konnte nicht erstellt werden', 409);
      }
      assertCompatible(row, data);
      return mapInvoice(row);
    });
  }

  async function getById(id: string, client?: DbClient): Promise<Invoice | null> {
    return run(client, async (c) => {
      const res = await c.query(SQL_SELECT_INVOICE_BY_ID, [id]);
      return res.rows[0] ? mapInvoice(res.rows[0]) : null;
    });
  }

  async function transition(
    id: string,
    to: InvoiceStatus,
    client?: DbClient
  ): Promise<Invoice> {
    return run(client, async (c) => {
      // Row-Lock bis Transaktionsende — serialisiert konkurrierende Übergänge.
      const locked = await c.query(SQL_SELECT_INVOICE_FOR_UPDATE, [id]);
      const row = locked.rows[0];
      if (!row) {
        throw new GatewayError('INVOICE_NOT_FOUND', `Invoice ${id} nicht gefunden`, 404);
      }
      if (isTerminal(row.status as InvoiceStatus) && row.status !== to) {
        // Terminalstatus sind endgültig — zusätzlich zur State-Machine absichern.
        assertTransition(row.status as InvoiceStatus, to);
      }
      assertTransition(row.status as InvoiceStatus, to);
      const updated = await c.query(SQL_UPDATE_INVOICE_STATUS, [id, to, row.version]);
      if (updated.rowCount === 0) {
        throw new GatewayError(
          'CONCURRENT_MODIFICATION',
          'Invoice wurde parallel geändert — bitte erneut versuchen',
          409
        );
      }
      return mapInvoice(updated.rows[0]);
    });
  }

  return { createInvoice, getById, transition };
}

/** Singleton gegen den Live-Pool (Wiring in src/index.ts). */
export const invoiceService: InvoiceServiceContract = createInvoiceService();

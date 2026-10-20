/**
 * Invoice-Core: erstellt und verwaltet Invoices race-condition-sicher.
 * Alle Status-Änderungen laufen in EINER Transaktion mit SELECT ... FOR UPDATE
 * und optimistic locking über invoices.version.
 */
import { z } from 'zod';
import type {
  DbClient,
  InvoiceService as InvoiceServiceContract,
} from '../services/contracts.js';
import type { Chain, CreateInvoiceRequest, Invoice, InvoiceStatus } from '../types/index.js';
import { tx as defaultTxRunner, type TxRunner } from '../db/pool.js';
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
// Quote-/Adress-Provider (Chain-Adapter werden per Injection verdrahtet)
// ---------------------------------------------------------------------------

export interface CryptoQuote {
  amountCrypto: string;
  address: string;
}

export type QuoteProvider = (
  req: CreateInvoiceRequest,
  merchantId: string
) => Promise<CryptoQuote>;

/**
 * Platzhalter-Provider: 1:1-Kurs und deterministische Pseudo-Adresse.
 * In Produktion ersetzt (z.B. via setQuoteProvider) durch Kurs-Feed +
 * Chain-Adapter (src/chains) — bewusst lose gekoppelt.
 */
export const defaultQuoteProvider: QuoteProvider = async (req) => ({
  amountCrypto: req.amountFiat,
  address: `kg-${req.chain.toLowerCase()}-pending`,
});

let activeQuote: QuoteProvider = defaultQuoteProvider;

/** Verdrahtet den globalen Quote-Provider des Singleton-Services. */
export function setQuoteProvider(provider: QuoteProvider): void {
  activeQuote = provider;
}

export interface InvoiceServiceDeps {
  txRunner?: TxRunner;
  quote?: QuoteProvider;
  clock?: () => Date;
  /** Gültigkeit einer Invoice ab Erstellung (Sekunden). */
  ttlSec?: number;
}

export function createInvoiceService(deps: InvoiceServiceDeps = {}): InvoiceServiceContract {
  const txRunner: TxRunner = deps.txRunner ?? defaultTxRunner;
  const clock = deps.clock ?? (() => new Date());
  const ttlSec = deps.ttlSec ?? 1800;
  const quote: QuoteProvider = deps.quote ?? ((req, merchantId) => activeQuote(req, merchantId));

  const run = <T>(client: DbClient | undefined, fn: (c: DbClient) => Promise<T>): Promise<T> =>
    client ? fn(client) : txRunner(fn, { rowLock: true });

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
    const { amountCrypto, address } = await quote({ ...req, ...data }, merchantId);
    const expiresAt = new Date(clock().getTime() + ttlSec * 1000).toISOString();

    return run(client, async (c) => {
      const inserted = await c.query(SQL_INSERT_INVOICE, [
        merchantId,
        data.orderRef,
        data.amountFiat,
        data.fiatCurrency.toUpperCase(),
        amountCrypto,
        data.cryptoCurrency.toUpperCase(),
        data.chain,
        address,
        'AWAITING_PAYMENT',
        expiresAt,
      ]);
      if (inserted.rowCount > 0) {
        return mapInvoice(inserted.rows[0]);
      }
      // Idempotenz: gleiche (merchant_id, order_ref) liefert die bestehende Invoice.
      const existing = await c.query(SQL_SELECT_INVOICE_BY_ORDER_REF, [
        merchantId,
        data.orderRef,
      ]);
      const row = existing.rows[0];
      if (!row) {
        throw new GatewayError('INVOICE_CONFLICT', 'Invoice konnte nicht erstellt werden', 409);
      }
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
      if (isTerminal(row.status) && row.status !== to) {
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

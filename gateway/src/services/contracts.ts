/**
 * Service-Verträge (Interfaces) zwischen API-Schicht und Core.
 * Beide Seiten programmieren gegen diese Signaturen — NICHT ändern,
 * ohne beide Seiten anzupassen. Grundlage der Parallel-Entwicklung.
 */
import type {
  Chain,
  CreateInvoiceRequest,
  Invoice,
  InvoiceStatus,
  Payment,
} from '../types/index.js';

/** Abstraktion einer DB-Transaktion (pg-Client im Transaktionsmodus). */
export interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

export interface TxOptions {
  /** Für SELECT ... FOR UPDATE — sperrt die betroffenen Zeilen. */
  rowLock?: boolean;
}

/**
 * Invoice-Core: erstellt und verwaltet Invoices race-condition-sicher.
 * Implementierung in src/core/invoiceService.ts.
 */
export interface InvoiceService {
  createInvoice(
    merchantId: string,
    req: CreateInvoiceRequest,
    client?: DbClient
  ): Promise<Invoice>;

  getById(id: string, client?: DbClient): Promise<Invoice | null>;

  /**
   * State-Transition innerhalb EINER Transaktion mit Row-Lock.
   * Wirft, wenn der Übergang laut State-Machine ungültig ist.
   */
  transition(
    id: string,
    to: InvoiceStatus,
    client?: DbClient
  ): Promise<Invoice>;
}

/**
 * Payment-Core: erkennt eingehende Zahlungen, schreibt idempotent gut.
 * Implementierung in src/core/paymentService.ts.
 *
 * applyIncomingPayment ist IDEMPOTENT: eine (chain, txid, vout)-Kombination
 * wird nie doppelt verarbeitet (UNIQUE-Constraint + ON CONFLICT DO NOTHING).
 */
export interface PaymentService {
  applyIncomingPayment(
    invoiceId: string,
    payment: {
      chain: Chain;
      txid: string;
      vout: number;
      amount: string;
      confirmations: number;
    },
    client?: DbClient
  ): Promise<{ applied: boolean; payment: Payment }>;

  /** Zählt bestätigte Zahlungen und aktualisiert den Invoice-Status. */
  recomputeInvoiceStatus(invoiceId: string, client?: DbClient): Promise<Invoice>;
}

/**
 * Chain-Watcher-Abstraktion. Jede Chain implementiert dieses Interface.
 * Implementierung in src/chains/*.ts, Registry in src/chains/registry.ts.
 */
export interface ChainWatcher {
  chain: Chain;
  /**
   * Prüft, ob auf der angegebenen Adresse eine Zahlung eingegangen ist.
   * Liefert erkannte Transaktionen (inkl. Bestätigungen).
   */
  fetchPayments(address: string, sinceBlock?: number): Promise<ChainPayment[]>;
  /** Erzeugt eine neue Empfangsadresse (falls die Chain das unterstützt). */
  deriveAddress?(merchantId: string): Promise<string>;
  /** Anzahl Bestätigungen für "sicher" auf dieser Chain. */
  requiredConfirmations(): number;
}

export interface ChainPayment {
  txid: string;
  vout: number;
  amount: string;      // native Einheit als String
  confirmations: number;
  blockHeight?: number;
}

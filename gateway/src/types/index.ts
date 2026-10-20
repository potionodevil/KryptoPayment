/**
 * Geteilte Typen & API-Vertrag für den Krypto Payment Gateway.
 * Diese Datei definiert die Schnittstellen, gegen die alle Module arbeiten.
 */

export type Chain = 'BTC' | 'LTC' | 'ETH' | 'SOL' | 'XMR';

export type InvoiceStatus =
  | 'CREATED'
  | 'AWAITING_PAYMENT'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'CANCELLED';

export type PaymentStatus = 'DETECTED' | 'CONFIRMED' | 'REORGED';

/** Erlaubte State-Übergänge (State-Machine). */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  CREATED: ['AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  AWAITING_PAYMENT: ['PARTIALLY_PAID', 'PAID', 'EXPIRED', 'CANCELLED'],
  PARTIALLY_PAID: ['PAID', 'EXPIRED', 'CANCELLED'],
  PAID: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export interface Invoice {
  id: string;
  merchantId: string;
  orderRef: string;
  amountFiat: string;      // NUMERIC als String (kein Float-Geld!)
  fiatCurrency: string;
  amountCrypto: string | null;
  cryptoCurrency: string;
  chain: Chain;
  address: string;
  status: InvoiceStatus;
  expiresAt: string;
  paidAt: string | null;
  confirmedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  chain: Chain;
  txid: string;
  vout: number;
  amount: string;
  confirmations: number;
  status: PaymentStatus;
  detectedAt: string;
}

/** Request: Invoice erstellen (vom WordPress-Plugin signiert). */
export interface CreateInvoiceRequest {
  orderRef: string;
  amountFiat: string;
  fiatCurrency: string;
  cryptoCurrency: string;
  chain: Chain;
  // optionale Fixierung des Kurses wird serverseitig ermittelt
}

/** Response: Invoice mit Zahlungsanweisungen. */
export interface CreateInvoiceResponse {
  invoice: Invoice;
  paymentAddress: string;
  amountCrypto: string;
  expiresAt: string;
  /** Signatur, mit der das Plugin die Antwort verifizieren kann. */
  signature: string;
}

/** Webhook-Event an den Shop. */
export interface WebhookEvent {
  event: 'invoice.created' | 'invoice.paid' | 'invoice.confirmed' | 'invoice.expired';
  invoiceId: string;
  orderRef: string;
  status: InvoiceStatus;
  amountCrypto: string;
  cryptoCurrency: string;
  txid?: string;
  timestamp: string;
}

/** Signatur-Schema für alle authentifizierten Requests (HMAC-SHA256). */
export interface AuthHeaders {
  'x-kg-key-id': string;       // public key identifier
  'x-kg-timestamp': string;     // unix seconds
  'x-kg-nonce': string;         // eindeutig pro Request
  'x-kg-signature': string;     // hex HMAC(secret, method+path+timestamp+nonce+bodyHash)
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

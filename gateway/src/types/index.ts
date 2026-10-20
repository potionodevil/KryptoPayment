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
  /**
   * Forwarding-Zieladresse (vom Betreiber im WordPress-Admin konfiguriert und
   * mit der Anfrage mitgeliefert). Der Kunde zahlt direkt an diese Adresse.
   * Das Gateway validiert das Format pro Chain, verwahrt aber nichts.
   */
  targetAddress: string;
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

/**
 * Forwarding-Modell: das Gateway leitet NUR weiter (non-custodial).
 * Pro Coin/Currency gibt der Betreiber eine statische Zieladresse vor
 * (eigene Wallet — das Gateway besitzt KEINE Keys, keine Verwahrung).
 * Kunden zahlen direkt an diese Adresse.
 */
export interface CoinAddressConfig {
  chain: Chain;
  currency: string;   // z.B. 'BTC', 'ETH', 'USDT', 'SOL', 'XMR'
  address: string;    // statische Auszahlungs-/Empfangsadresse des Betreibers
}

/**
 * Zuordnung einer eingehenden Blockchain-Zahlung zu einer Invoice.
 * Da alle Bestellungen eines Coins an DIESELBE Adresse zahlen, erfolgt die
 * Zuordnung über den exakten Betrag (+ FIFO bei identischen Beträgen).
 */
export interface PaymentMatch {
  invoiceId: string;
  chain: Chain;
  txid: string;
  vout: number;
  amount: string;         // exakter empfangener Betrag (String, kein Float)
  confirmations: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Adressformat-Validierung + Watch-Targets (non-custodial Forwarding).
 *
 * MODELL: Das Gateway besitzt KEINE Keys und leitet KEINE Adressen ab.
 * Die Zieladresse kommt mit jeder Invoice-Anfrage (req.targetAddress) und wird
 * ausschließlich auf der Invoice gespeichert. Diese Validierung prüft nur das
 * FORMAT pro Chain; die Watch-Targets werden aus AKTIVEN Invoices abgeleitet
 * (Quelle = Invoices, NICHT eine Env-Config).
 */
import type { DbClient } from '../services/contracts.js';
import type { Chain } from '../types/index.js';
import { tx as defaultTxRunner, type TxRunner } from '../db/pool.js';
import { GatewayError } from './stateMachine.js';

/** Zu überwachendes Ziel des Pollers: distinct (chain, currency, address). */
export interface WatchTarget {
  chain: Chain;
  currency: string;
  address: string;
}

// ---------------------------------------------------------------------------
// Adressformat-Validierung pro Chain (Format-Check, KEINE Checksummen-Mathematik)
// ---------------------------------------------------------------------------

const BECH32_DATA = '[ac-hj-np-z02-9]{11,71}';
const BASE58_CHAR = '[a-km-zA-HJ-NP-Z1-9]';

const ADDRESS_PATTERNS: Record<Chain, RegExp> = {
  // BTC: bech32 (bc1..., Testnet tb1/bcrt1) oder base58 (1..., 3..., m/n/2)
  BTC: new RegExp(`^(?:bc1|tb1|bcrt1)${BECH32_DATA}$|^[13mn2]${BASE58_CHAR}{25,34}$`, 'i'),
  // LTC: bech32 (ltc1...) oder base58 (L..., M..., 3...)
  LTC: new RegExp(`^(?:ltc1|tltc1)${BECH32_DATA}$|^[LM3]${BASE58_CHAR}{25,34}$`, 'i'),
  // ETH & ERC-20: 0x + 40 Hex
  ETH: /^0x[0-9a-fA-F]{40}$/,
  // SOL & SPL-Tokens: base58, 32-44 Zeichen
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  // XMR: base58, 95 (Standard/Sub) bzw. 106 (integriert) Zeichen, Präfix 4/5/8/9
  XMR: /^[4589][1-9A-HJ-NP-Za-km-z]{94,105}$/,
};

/** Format-Check pro Chain (trimmt Whitespace). */
export function isValidAddress(chain: Chain, address: string): boolean {
  const pattern = ADDRESS_PATTERNS[chain];
  if (!pattern) return false;
  return pattern.test(String(address ?? '').trim());
}

/** Wirft GatewayError(INVALID_ADDRESS) bei ungültigem Format für die Chain. */
export function assertValidAddress(chain: Chain, address: string): void {
  if (!isValidAddress(chain, address)) {
    throw new GatewayError(
      'INVALID_ADDRESS',
      `Ungültiges Adressformat für ${chain} — bitte eine gültige ${chain}-Adresse (Zieladresse des Betreibers) übergeben`,
      400
    );
  }
}

// ---------------------------------------------------------------------------
// Watch-Targets für den Poller: distinct (chain, currency, address) aller
// NICHT-TERMINALEN Invoices. PAID bleibt enthalten, damit Bestätigungen weiter
// wachsen (PAID -> CONFIRMED); nur CONFIRMED/EXPIRED/CANCELLED werden nicht mehr gepollt.
// ---------------------------------------------------------------------------

export const SQL_SELECT_WATCH_TARGETS =
  'SELECT DISTINCT chain, crypto_currency AS currency, address FROM invoices ' +
  "WHERE status IN ('CREATED','AWAITING_PAYMENT','PARTIALLY_PAID','PAID') " +
  'ORDER BY chain, currency, address';

function mapWatchTarget(row: any): WatchTarget {
  return {
    chain: row.chain as Chain,
    currency: String(row.currency),
    address: String(row.address),
  };
}

async function queryWatchTargets(c: DbClient): Promise<WatchTarget[]> {
  const res = await c.query(SQL_SELECT_WATCH_TARGETS);
  return res.rows.map(mapWatchTarget);
}

export interface WatchTargetService {
  /** Distinct (chain, currency, address) aller aktiven Invoices. */
  listWatchTargets(): Promise<WatchTarget[]>;
  /** Alias fürs Poller-Wiring (gleiche Daten, async). */
  listAddresses(): Promise<WatchTarget[]>;
}

export function createWatchTargetService(
  deps: { txRunner?: TxRunner } = {}
): WatchTargetService {
  const txRunner: TxRunner = deps.txRunner ?? defaultTxRunner;
  const listWatchTargets = (): Promise<WatchTarget[]> => txRunner(queryWatchTargets);
  return { listWatchTargets, listAddresses: listWatchTargets };
}

/**
 * Modul-Export gemäß Spec-Signatur `listWatchTargets()`.
 * Ohne expliziten Client gegen den Live-Pool (Wiring in src/index.ts).
 */
export function listWatchTargets(client?: DbClient): Promise<WatchTarget[]> {
  return client ? queryWatchTargets(client) : defaultTxRunner(queryWatchTargets);
}

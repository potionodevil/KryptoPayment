/**
 * Chain-spezifische Typen für die Chain-Watcher-Adapter.
 * Enthält auch die minimalen Strukturen für den injizierbaren fetch,
 * damit Tests ohne echte Netz-Calls gemockt werden können.
 */
import type { Chain } from '../types/index.js';

/** Minimaler HTTP-Response-Typ (Subset von fetch Response). */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

/** Minimaler Request-Init-Typ (Subset von fetch RequestInit). */
export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Injizierbare fetch-Funktion — Default ist das globale fetch (Node 26). */
export type FetchLike = (
  url: string,
  init?: RequestInitLike
) => Promise<HttpResponseLike>;

/** Basic-Auth-Zugangsdaten für RPC-Endpunkte (z.B. bitcoind). */
export interface RpcAuth {
  user: string;
  pass: string;
}

/** JSON-RPC-2.0-Anfrage. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

/** JSON-RPC-2.0-Fehlerobjekt. */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC-2.0-Antwort (defensiv getypt). */
export interface JsonRpcResponseBody {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: JsonRpcErrorObject | null;
}

/** Gemeinsame Optionen für alle Watcher. */
export interface BaseWatcherConfig {
  /** RPC-Endpunkt der Chain (z.B. http://bitcoind:8332). */
  rpcUrl: string;
  /** Optional: Basic-Auth für den RPC-Endpunkt. */
  auth?: RpcAuth;
  /** Optional: Standard-fetch überschreiben (Tests). */
  fetchImpl?: FetchLike;
  /** Optional: requiredConfirmations() überschreiben. */
  requiredConfirmations?: number;
}

/** Konfiguration für UTXO-Chains (BTC/LTC, bitcoind-Stil). */
export interface UtxoRpcConfig extends BaseWatcherConfig {}

/** Konfiguration für Ethereum. */
export interface EthWatcherConfig extends BaseWatcherConfig {
  /** Größe des Scan-Fensters (in Blöcken), wenn sinceBlock fehlt. */
  scanWindow?: number;
}

/** Konfiguration für Solana. */
export interface SolWatcherConfig extends BaseWatcherConfig {
  /** Maximale Anzahl Signaturen pro Abruf. */
  limit?: number;
}

/** Konfiguration für Monero (monero-wallet-RPC). */
export interface XmrWatcherConfig extends BaseWatcherConfig {}

/** Typ-Helper: Chain-Watcher-Konfiguration nach Chain. */
export type WatcherConfigFor<C extends Chain> = C extends 'BTC' | 'LTC'
  ? UtxoRpcConfig
  : C extends 'ETH'
    ? EthWatcherConfig
    : C extends 'SOL'
      ? SolWatcherConfig
      : XmrWatcherConfig;

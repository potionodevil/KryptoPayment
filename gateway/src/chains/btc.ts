/**
 * Bitcoin-Chain-Watcher (UTXO, bitcoind-Stil-JSON-RPC).
 *
 * Erkennung eingehender Zahlungen via `listunspent` auf der Zieladresse
 * (Adresse muss im Wallet als Watch-Only importiert sein).
 * Beträge werden satoshi-genau als String geliefert (kein Float-Geld).
 */
import type { ChainPayment, ChainWatcher } from '../services/contracts.js';
import type { Chain } from '../types/index.js';
import type { FetchLike, UtxoRpcConfig } from './types.js';
import { RpcError, formatUnits, jsonRpcCall, parseDecimalToUnits, toFiniteNumber } from './rpc.js';

/** Kleinste Einheit: 1 BTC/LTC = 1e8 Satoshi. */
export const COIN_DECIMALS = 8;

/**
 * Gemeinsame UTXO-Implementierung für bitcoind-kompatible Nodes
 * (Bitcoin, Litecoin). Chain-spezifische Defaults werden übergeben.
 */
export class UtxoWatcher implements ChainWatcher {
  readonly chain: Chain;
  protected readonly rpcUrl: string;
  protected readonly auth?: { user: string; pass: string };
  protected readonly fetchImpl: FetchLike;
  private readonly confs: number;

  constructor(chain: Chain, defaultConfirmations: number, config: UtxoRpcConfig) {
    if (!config?.rpcUrl) throw new Error(`Fehlende rpcUrl für ${chain}`);
    this.chain = chain;
    this.rpcUrl = config.rpcUrl;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.confs = config.requiredConfirmations ?? defaultConfirmations;
  }

  requiredConfirmations(): number {
    return this.confs;
  }

  /**
   * Liefert alle unverausgabten Outputs (UTXOs) an die Adresse.
   * `sinceBlock` filtert nach Bestätigungs-Höhe; unbestätigte Outputs
   * (ohne Höhe) bleiben enthalten.
   */
  async fetchPayments(address: string, sinceBlock?: number): Promise<ChainPayment[]> {
    if (!address || typeof address !== 'string') {
      throw new Error('Adresse erforderlich');
    }
    const result = await jsonRpcCall(
      this.rpcUrl,
      'listunspent',
      [0, 9999999, [address]],
      { fetchImpl: this.fetchImpl, auth: this.auth }
    );
    if (!Array.isArray(result)) {
      throw new RpcError(`Unerwartete listunspent-Antwort bei ${this.chain}`);
    }

    const payments: ChainPayment[] = [];
    for (const raw of result) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const txid = typeof entry.txid === 'string' ? entry.txid : '';
      if (!txid) continue;

      // Betrag: String oder Zahl — satoshi-exakt in String zurückführen
      let amount: string;
      try {
        const units = parseDecimalToUnits(entry.amount as string | number, COIN_DECIMALS);
        amount = formatUnits(units, COIN_DECIMALS);
      } catch {
        continue; // kaputter Betrag -> Eintrag überspringen
      }

      const vout = toFiniteNumber(entry.vout) ?? 0;
      const confirmations = Math.max(0, toFiniteNumber(entry.confirmations) ?? 0);
      const height = toFiniteNumber(entry.height);

      if (
        sinceBlock !== undefined &&
        height !== undefined &&
        height > 0 &&
        height < sinceBlock
      ) {
        continue;
      }

      const payment: ChainPayment = { txid, vout, amount, confirmations };
      if (height !== undefined && height > 0) payment.blockHeight = height;
      payments.push(payment);
    }
    return payments;
  }

  /** Erzeugt eine neue Empfangsadresse (bitcoind: getnewaddress, bech32). */
  async deriveAddress(merchantId: string): Promise<string> {
    const result = await jsonRpcCall(
      this.rpcUrl,
      'getnewaddress',
      [merchantId ?? '', 'bech32'],
      { fetchImpl: this.fetchImpl, auth: this.auth }
    );
    if (typeof result !== 'string' || !result) {
      throw new RpcError(`getnewaddress lieferte keine Adresse bei ${this.chain}`);
    }
    return result;
  }
}

/** Bitcoin: 3 Bestätigungen als "sicher". */
export class BtcWatcher extends UtxoWatcher {
  constructor(config: UtxoRpcConfig) {
    super('BTC', 3, config);
  }
}

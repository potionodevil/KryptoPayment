/**
 * Litecoin-Chain-Watcher (UTXO, bitcoind-kompatibel — gleiche Struktur wie BTC).
 * Litecoin bestätigt schneller, daher mehr Bestätigungen nötig (6).
 */
import type { UtxoRpcConfig } from './types.js';
import { UtxoWatcher } from './btc.js';

/** Litecoin: 6 Bestätigungen als "sicher". */
export class LtcWatcher extends UtxoWatcher {
  constructor(config: UtxoRpcConfig) {
    super('LTC', 6, config);
  }
}

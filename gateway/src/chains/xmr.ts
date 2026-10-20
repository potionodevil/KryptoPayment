/**
 * Monero-Chain-Watcher (monero-wallet-RPC).
 *
 * Erkennung eingehender Zahlungen via `get_transfers` (in + pool),
 * gefiltert auf die Zieladresse. Beträge: XMR-Dezimal-String
 * (12 Dezimalen, Piconero -> XMR).
 */
import type { ChainPayment, ChainWatcher } from '../services/contracts.js';
import type { FetchLike, XmrWatcherConfig } from './types.js';
import { formatUnits, jsonRpcCall, parseBigIntish, toFiniteNumber } from './rpc.js';

/** XMR hat 12 Dezimalstellen (Piconero). */
export const PICODERO_DECIMALS = 12;

export class XmrWatcher implements ChainWatcher {
  readonly chain = 'XMR' as const;
  private readonly rpcUrl: string;
  private readonly auth?: { user: string; pass: string };
  private readonly fetchImpl: FetchLike;
  private readonly confs: number;

  constructor(config: XmrWatcherConfig) {
    if (!config?.rpcUrl) throw new Error('Fehlende rpcUrl für XMR');
    this.rpcUrl = config.rpcUrl;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.confs = config.requiredConfirmations ?? 10;
  }

  requiredConfirmations(): number {
    return this.confs;
  }

  /**
   * Liefert eingehende XMR-Zahlungen an die Adresse.
   * `sinceBlock` filtert nach Höhe; Pool-Transaktionen (ohne Höhe) bleiben.
   */
  async fetchPayments(address: string, sinceBlock?: number): Promise<ChainPayment[]> {
    if (!address || typeof address !== 'string') {
      throw new Error('Adresse erforderlich');
    }

    const result = await this.call('get_transfers', { in: true, pool: true, pending: true });
    const obj = (result ?? {}) as Record<string, unknown>;
    // Eingehend: bestätigt ('in') + unbestätigt im Pool ('pool').
    // 'pending'/'out' sind ausgehend und werden ignoriert.
    const groups: unknown[] = [
      ...(Array.isArray(obj.in) ? obj.in : []),
      ...(Array.isArray(obj.pool) ? obj.pool : []),
    ];

    const payments: ChainPayment[] = [];
    for (const raw of groups) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw as Record<string, unknown>;
      if (t.address !== address) continue; // nur Zahlungen an die Zieladresse
      const txid = typeof t.txid === 'string' ? t.txid : '';
      if (!txid) continue;

      let amount: string;
      try {
        amount = formatUnits(parseBigIntish(t.amount), PICODERO_DECIMALS);
      } catch {
        continue; // kaputter Betrag -> Eintrag überspringen
      }

      const confirmations = Math.max(0, toFiniteNumber(t.confirmations) ?? 0);
      const height = toFiniteNumber(t.height);
      if (
        sinceBlock !== undefined &&
        height !== undefined &&
        height > 0 &&
        height < sinceBlock
      ) {
        continue;
      }

      const payment: ChainPayment = {
        txid,
        vout: 0, // Monero verschleiert Output-Indizes: 0 als Derivat
        amount,
        confirmations,
      };
      if (height !== undefined && height > 0) payment.blockHeight = height;
      payments.push(payment);
    }
    return payments;
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return jsonRpcCall(this.rpcUrl, method, params, {
      fetchImpl: this.fetchImpl,
      auth: this.auth,
    });
  }
}

/**
 * Solana-Chain-Watcher (JSON-RPC).
 *
 * Erkennung eingehender Zahlungen:
 *  1. getSignaturesForAddress — Signaturen an der Adresse
 *  2. getTransaction pro Signatur — Lamport-Delta der Adresse
 *     (postBalances - preBalances) als eingehender Betrag.
 *
 * Beträge: SOL-Dezimal-String (9 Dezimalen). `blockHeight` = Slot.
 */
import type { ChainPayment, ChainWatcher } from '../services/contracts.js';
import type { FetchLike, SolWatcherConfig } from './types.js';
import { formatUnits, jsonRpcCall, toFiniteNumber } from './rpc.js';

/** SOL hat 9 Dezimalstellen (Lamports). */
export const LAMPORT_DECIMALS = 9;

export class SolWatcher implements ChainWatcher {
  readonly chain = 'SOL' as const;
  private readonly rpcUrl: string;
  private readonly auth?: { user: string; pass: string };
  private readonly fetchImpl: FetchLike;
  private readonly confs: number;
  private readonly limit: number;

  constructor(config: SolWatcherConfig) {
    if (!config?.rpcUrl) throw new Error('Fehlende rpcUrl für SOL');
    this.rpcUrl = config.rpcUrl;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.confs = config.requiredConfirmations ?? 32;
    this.limit = config.limit ?? 25;
  }

  requiredConfirmations(): number {
    return this.confs;
  }

  /**
   * Liefert eingehende SOL-Zahlungen an die Adresse.
   * `sinceBlock` wird als Slot-Filter interpretiert.
   */
  async fetchPayments(address: string, sinceBlock?: number): Promise<ChainPayment[]> {
    if (!address || typeof address !== 'string') {
      throw new Error('Adresse erforderlich');
    }

    // 1) Signaturen an der Adresse holen
    const sigsRaw = await this.call('getSignaturesForAddress', [address, { limit: this.limit }]);
    const sigs = Array.isArray(sigsRaw) ? sigsRaw : [];

    const payments: ChainPayment[] = [];
    for (const raw of sigs) {
      if (!raw || typeof raw !== 'object') continue;
      const sig = raw as Record<string, unknown>;
      const signature = typeof sig.signature === 'string' ? sig.signature : '';
      if (!signature) continue;
      if (sig.err !== null && sig.err !== undefined) continue; // fehlgeschlagen
      const slot = toFiniteNumber(sig.slot);
      if (slot === undefined) continue;
      if (sinceBlock !== undefined && slot < sinceBlock) continue;

      // 2) Transaktion holen und Lamport-Delta der Adresse bestimmen
      const txRaw = await this.call('getTransaction', [
        signature,
        { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' },
      ]);
      if (!txRaw || typeof txRaw !== 'object') continue;
      const tx = txRaw as Record<string, unknown>;
      const meta = (tx.meta ?? {}) as Record<string, unknown>;
      const message = ((tx.transaction as Record<string, unknown> ?? {}) .message ?? {}) as Record<string, unknown>;
      const keysRaw = Array.isArray(message.accountKeys) ? message.accountKeys : [];
      const keys = keysRaw.map((k) =>
        typeof k === 'string' ? k : typeof k === 'object' && k !== null ? String((k as Record<string, unknown>).pubkey ?? '') : ''
      );
      const idx = keys.indexOf(address);
      if (idx < 0) continue;

      const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
      const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
      const preBal = toFiniteNumber(pre[idx]);
      const postBal = toFiniteNumber(post[idx]);
      if (preBal === undefined || postBal === undefined) continue;
      const delta = postBal - preBal;
      if (!Number.isFinite(delta) || delta <= 0) continue; // keine eingehende Zahlung

      const confirmations = this.resolveConfirmations(sig);
      const payment: ChainPayment = {
        txid: signature,
        vout: 0, // Solana hat keine vout-Semantik: eine Transaktion = eine Zahlung
        amount: formatUnits(BigInt(Math.round(delta)), LAMPORT_DECIMALS),
        confirmations,
        blockHeight: slot,
      };
      payments.push(payment);
    }
    return payments;
  }

  /**
   * Bestätigungen defensiv aus dem Signatur-Eintrag ableiten:
   * numerisches Feld verwenden, sonst finalisiert = requiredConfirmations.
   */
  private resolveConfirmations(sig: Record<string, unknown>): number {
    const confs = toFiniteNumber(sig.confirmations);
    if (confs !== undefined) return Math.max(0, confs);
    if (sig.confirmationStatus === 'finalized') return this.confs;
    return 0;
  }

  private async call(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    return jsonRpcCall(this.rpcUrl, method, params, {
      fetchImpl: this.fetchImpl,
      auth: this.auth,
    });
  }
}

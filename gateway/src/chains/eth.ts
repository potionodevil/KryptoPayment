/**
 * Ethereum-Chain-Watcher (account-basiert, JSON-RPC).
 *
 * Erkennt eingehende Zahlungen an eine Adresse:
 *  - Native ETH: Block-Scan (eth_getBlockByNumber mit Transaktionen),
 *    gefiltert auf to == Adresse und value > 0.
 *  - ERC-20: eth_getLogs mit Transfer-Event-Topic an die Zieladresse.
 *
 * Beträge: native ETH als ETH-Dezimal-String (18 Dezimalen),
 * ERC-20 als Token-Roh-Einheiten-String (Decimals werden NICHT skaliert,
 * da sie on-chain abgefragt werden müssten — s. Limitationen).
 */
import type { ChainPayment, ChainWatcher } from '../services/contracts.js';
import type { EthWatcherConfig, FetchLike } from './types.js';
import { RpcError, formatUnits, jsonRpcCall, parseBigIntish, toFiniteNumber } from './rpc.js';

/** ERC-20 Transfer(address,address,uint256) Event-Topic. */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** ETH hat 18 Dezimalstellen (wei). */
export const WEI_DECIMALS = 18;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Hex-String (0x...) für JSON-RPC-Blockparameter. */
function toHex(n: number): string {
  return '0x' + n.toString(16);
}

/** Padded 32-Byte-Topic für eine Adresse. */
function addressToTopic(address: string): string {
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
}

export class EthWatcher implements ChainWatcher {
  readonly chain = 'ETH' as const;
  private readonly rpcUrl: string;
  private readonly auth?: { user: string; pass: string };
  private readonly fetchImpl: FetchLike;
  private readonly confs: number;
  private readonly scanWindow: number;

  constructor(config: EthWatcherConfig) {
    if (!config?.rpcUrl) throw new Error('Fehlende rpcUrl für ETH');
    this.rpcUrl = config.rpcUrl;
    this.auth = config.auth;
    this.fetchImpl = config.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.confs = config.requiredConfirmations ?? 12;
    this.scanWindow = config.scanWindow ?? 200;
  }

  requiredConfirmations(): number {
    return this.confs;
  }

  /**
   * Liefert eingehende Native-ETH- und ERC-20-Zahlungen an die Adresse.
   * `sinceBlock` = letzte verarbeitete Blockhöhe (dezimal).
   */
  async fetchPayments(address: string, sinceBlock?: number): Promise<ChainPayment[]> {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      throw new Error(`Ungültige ETH-Adresse: ${address}`);
    }
    const addrLower = address.toLowerCase();

    // 1) Aktuelle Höhe ermitteln
    const tipRaw = await this.call('eth_blockNumber', []);
    const tipNum = toFiniteNumber(typeof tipRaw === 'string' ? Number(tipRaw) : tipRaw);
    if (tipNum === undefined) {
      throw new RpcError('eth_blockNumber lieferte keine gültige Höhe');
    }
    const tip = tipNum;

    const fromBlock = sinceBlock !== undefined ? sinceBlock : Math.max(0, tip - this.scanWindow + 1);

    const payments: ChainPayment[] = [];

    // 2) ERC-20 Transfers an die Adresse via eth_getLogs
    const logsRaw = await this.call('eth_getLogs', [
      {
        fromBlock: toHex(fromBlock),
        toBlock: 'latest',
        topics: [TRANSFER_TOPIC, null, addressToTopic(address)],
      },
    ]);
    if (Array.isArray(logsRaw)) {
      for (const raw of logsRaw) {
        if (!raw || typeof raw !== 'object') continue;
        const log = raw as Record<string, unknown>;
        const txid = typeof log.transactionHash === 'string' ? log.transactionHash : '';
        if (!txid) continue;
        const blockHeight = this.parseHexNumber(log.blockNumber);
        const logIndex = this.parseHexNumber(log.logIndex) ?? 0;
        let amount: string;
        try {
          amount = parseBigIntish(log.data).toString();
        } catch {
          continue;
        }
        if (amount === '0') continue;
        const payment: ChainPayment = {
          txid,
          vout: logIndex,
          amount,
          confirmations: blockHeight !== undefined ? Math.max(1, tip - blockHeight + 1) : 1,
        };
        if (blockHeight !== undefined) payment.blockHeight = blockHeight;
        payments.push(payment);
      }
    }

    // 3) Native ETH: Blöcke im Fenster nach Eingängen durchsuchen
    for (let h = fromBlock; h <= tip; h++) {
      const blockRaw = await this.call('eth_getBlockByNumber', [toHex(h), true]);
      if (!blockRaw || typeof blockRaw !== 'object') continue;
      const block = blockRaw as Record<string, unknown>;
      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      for (const raw of txs) {
        if (!raw || typeof raw !== 'object') continue;
        const tx = raw as Record<string, unknown>;
        const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : '';
        if (to !== addrLower) continue;
        let value: bigint;
        try {
          value = parseBigIntish(tx.value);
        } catch {
          continue;
        }
        if (value <= 0n) continue;
        const txid = typeof tx.hash === 'string' ? tx.hash : '';
        if (!txid) continue;
        const payment: ChainPayment = {
          txid,
          vout: this.parseHexNumber(tx.transactionIndex) ?? 0,
          amount: formatUnits(value, WEI_DECIMALS),
          confirmations: Math.max(1, tip - h + 1),
          blockHeight: h,
        };
        payments.push(payment);
      }
    }

    return payments;
  }

  private async call(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    return jsonRpcCall(this.rpcUrl, method, params, {
      fetchImpl: this.fetchImpl,
      auth: this.auth,
    });
  }

  /** Parst Hex-(0x...)- oder Dezimal-Blocknummern defensiv. */
  private parseHexNumber(value: unknown): number | undefined {
    try {
      const n = parseBigIntish(value);
      if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      return Number(n);
    } catch {
      return undefined;
    }
  }
}

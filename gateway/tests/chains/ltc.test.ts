/**
 * Tests für den Litecoin-Chain-Watcher (UTXO, gleiche Struktur wie BTC).
 */
import { describe, it, expect } from 'vitest';
import { LtcWatcher } from '../../src/chains/ltc.js';
import { mockRpcFetch } from './mockFetch.js';

const ADDR = 'ltc1qtestaddress000000000000000000000000';

describe('LtcWatcher', () => {
  it('hat chain LTC und requiredConfirmations 6', () => {
    const w = new LtcWatcher({ rpcUrl: 'http://localhost:9332', fetchImpl: mockRpcFetch({ listunspent: [] }).fetchImpl });
    expect(w.chain).toBe('LTC');
    expect(w.requiredConfirmations()).toBe(6);
  });

  it('nutzt LTC_RPC-Endpunkt und bildet listunspent-Request korrekt', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ listunspent: [] });
    const w = new LtcWatcher({ rpcUrl: 'http://ltc-node:9332', fetchImpl });
    await w.fetchPayments(ADDR);
    expect(calls[0].url).toBe('http://ltc-node:9332');
    expect(calls[0].method).toBe('listunspent');
    expect(calls[0].params).toEqual([0, 9999999, [ADDR]]);
  });

  it('parst UTXOs und formatiert Amounts als String', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        { txid: 'ltc1', vout: 2, amount: 12.5, confirmations: 10, height: 2500000 },
        { txid: 'ltc2', vout: 0, amount: '0.00000001', confirmations: 1 },
      ],
    });
    const payments = await new LtcWatcher({ rpcUrl: 'http://ltc-node:9332', fetchImpl }).fetchPayments(ADDR);
    expect(payments).toEqual([
      { txid: 'ltc1', vout: 2, amount: '12.5', confirmations: 10, blockHeight: 2500000 },
      { txid: 'ltc2', vout: 0, amount: '0.00000001', confirmations: 1 },
    ]);
  });

  it('filtert mit sinceBlock', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        { txid: 'old', vout: 0, amount: 1, confirmations: 50, height: 100 },
        { txid: 'new', vout: 0, amount: 1, confirmations: 3, height: 300 },
      ],
    });
    const payments = await new LtcWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 200);
    expect(payments.map((p) => p.txid)).toEqual(['new']);
  });

  it('führt KEINE Adressableitung durch (kein deriveAddress/getnewaddress)', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ listunspent: [] });
    const w = new LtcWatcher({ rpcUrl: 'http://x', fetchImpl });
    expect((w as unknown as Record<string, unknown>).deriveAddress).toBeUndefined();
    await w.fetchPayments(ADDR);
    expect(calls.map((c) => c.method)).toEqual(['listunspent']);
  });
});

/**
 * Tests für den Monero-Chain-Watcher (monero-wallet-RPC).
 */
import { describe, it, expect } from 'vitest';
import { XmrWatcher } from '../../src/chains/xmr.js';
import { mockRpcFetch } from './mockFetch.js';

const ADDR = '44XmrTestAddress0000000000000000000000000000000000000000000000000000000000000000000';

function xmrResponder() {
  return {
    get_transfers: {
      in: [
        {
          address: ADDR,
          amount: 1000000000000, // 1 XMR in Piconero (Zahl)
          confirmations: 15,
          height: 100,
          txid: 'xmr1',
          subaddr_index: { major: 0, minor: 1 },
        },
        {
          address: '44OtherAddress',
          amount: '5000000000000',
          confirmations: 20,
          height: 90,
          txid: 'xmr2',
        },
      ],
      pool: [
        {
          address: ADDR,
          amount: '123',
          height: 0,
          confirmations: 0,
          txid: 'xmr3',
        },
      ],
      pending: [
        {
          address: ADDR,
          amount: 999,
          txid: 'xmrOutgoing', // ausgehend -> darf NICHT erkannt werden
        },
      ],
    },
  };
}

describe('XmrWatcher', () => {
  it('hat chain XMR und requiredConfirmations 10', () => {
    const w = new XmrWatcher({ rpcUrl: 'http://localhost:18083', fetchImpl: mockRpcFetch(xmrResponder()).fetchImpl });
    expect(w.chain).toBe('XMR');
    expect(w.requiredConfirmations()).toBe(10);
  });

  it('bildet get_transfers-Request korrekt', async () => {
    const { fetchImpl, calls } = mockRpcFetch(xmrResponder());
    const w = new XmrWatcher({ rpcUrl: 'http://xmr-node:18083', fetchImpl });
    await w.fetchPayments(ADDR);
    expect(calls[0].method).toBe('get_transfers');
    expect(calls[0].url).toBe('http://xmr-node:18083');
    expect(calls[0].params).toEqual({ in: true, pool: true, pending: true });
  });

  it('erkennt eingehende Zahlungen der Adresse (in + pool), Amount als XMR-String', async () => {
    const { fetchImpl } = mockRpcFetch(xmrResponder());
    const payments = await new XmrWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR);
    expect(payments).toEqual([
      { txid: 'xmr1', vout: 0, amount: '1', confirmations: 15, blockHeight: 100 },
      { txid: 'xmr3', vout: 0, amount: '0.000000000123', confirmations: 0 },
    ]);
  });

  it('filtert mit sinceBlock (Pool-Transaktionen ohne Höhe bleiben)', async () => {
    const { fetchImpl } = mockRpcFetch(xmrResponder());
    const payments = await new XmrWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 50);
    expect(payments.map((p) => p.txid)).toEqual(['xmr1', 'xmr3']);
  });

  it('parst defensiv: kaputte Transfer-Einträge überspringen', async () => {
    const { fetchImpl } = mockRpcFetch({
      get_transfers: {
        in: [null, 'x', { txid: 'no-address', amount: 1 }, { address: ADDR, amount: 'keine-zahl' }],
        pool: [],
        pending: [],
      },
    });
    const payments = await new XmrWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR);
    expect(payments).toEqual([]);
  });

  it('deriveAddress: create_account + get_address', async () => {
    const { fetchImpl, calls } = mockRpcFetch((method: string) => {
      if (method === 'create_account') return { account_index: 3, address: ADDR };
      if (method === 'get_address') return { address: '44DerivedAddress' };
      throw new Error(`unerwartet: ${method}`);
    });
    const w = new XmrWatcher({ rpcUrl: 'http://x', fetchImpl });
    const addr = await w.deriveAddress?.('merchant-1');
    expect(addr).toBe('44DerivedAddress');
    expect(calls.map((c) => c.method)).toEqual(['create_account', 'get_address']);
    expect(calls[0].params).toEqual({ label: 'merchant-1' });
    expect(calls[1].params).toEqual({ account_index: 3, address_index: 0 });
  });
});

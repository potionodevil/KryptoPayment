/**
 * Tests für den Solana-Chain-Watcher (getSignaturesForAddress + getTransaction).
 */
import { describe, it, expect } from 'vitest';
import { SolWatcher } from '../../src/chains/sol.js';
import { mockRpcFetch } from './mockFetch.js';

const ADDR = 'TestAddr1111111111111111111111111111111111';

function solResponder() {
  const txs: Record<string, unknown> = {
    sig1: {
      slot: 100,
      transaction: { message: { accountKeys: ['OtherAccount111111111111111111111111111', ADDR] } },
      meta: { preBalances: [100, 5000000000], postBalances: [100, 6500000000] },
    },
    // accountKeys als Objekte (jsonParsed-artig) — muss auch funktionieren
    sig2: {
      slot: 90,
      transaction: {
        message: {
          accountKeys: [{ pubkey: 'OtherAccount111111111111111111111111111' }, { pubkey: ADDR }],
        },
      },
      meta: { preBalances: [0, 1000000000], postBalances: [0, 2000000000] },
    },
    // Delta <= 0 -> keine eingehende Zahlung
    sig5: {
      slot: 105,
      transaction: { message: { accountKeys: [ADDR] } },
      meta: { preBalances: [5000000000], postBalances: [4000000000] },
    },
    // ohne meta -> überspringen
    sig6: {
      slot: 106,
      transaction: { message: { accountKeys: [ADDR] } },
    },
  };
  return {
    getSignaturesForAddress: [
      { signature: 'sig1', slot: 100, err: null, confirmations: 5, confirmationStatus: 'confirmed' },
      { signature: 'sig2', slot: 90, err: null, confirmations: null, confirmationStatus: 'finalized' },
      { signature: 'sig3', slot: 120, err: { InstructionError: [0, 'Custom'] }, confirmations: null },
      { signature: 'sig4', slot: 50, err: null, confirmations: null, confirmationStatus: 'finalized' },
      { signature: 'sig5', slot: 105, err: null, confirmations: 7, confirmationStatus: 'confirmed' },
      { signature: 'sig6', slot: 106, err: null, confirmations: 7, confirmationStatus: 'confirmed' },
    ],
    getTransaction: (params: unknown) => {
      const sig = String((params as unknown[])[0]);
      return txs[sig] ?? null;
    },
  };
}

describe('SolWatcher', () => {
  it('hat chain SOL und requiredConfirmations 32', () => {
    const w = new SolWatcher({ rpcUrl: 'http://localhost:8899', fetchImpl: mockRpcFetch(solResponder()).fetchImpl });
    expect(w.chain).toBe('SOL');
    expect(w.requiredConfirmations()).toBe(32);
  });

  it('bildet Requests korrekt', async () => {
    const { fetchImpl, calls } = mockRpcFetch(solResponder());
    const w = new SolWatcher({ rpcUrl: 'http://sol-node:8899', fetchImpl });
    await w.fetchPayments(ADDR, 85);

    expect(calls[0].method).toBe('getSignaturesForAddress');
    expect(calls[0].url).toBe('http://sol-node:8899');
    expect(calls[0].params).toEqual([ADDR, { limit: 25 }]);

    const txCalls = calls.filter((c) => c.method === 'getTransaction');
    expect(txCalls.map((c) => (c.params as unknown[])[0])).toEqual(['sig1', 'sig2', 'sig5', 'sig6']);
    expect(txCalls[0].params).toEqual([
      'sig1',
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' },
    ]);
  });

  it('berechnet Amounts aus dem Lamport-Delta der Adresse (String, 9 Dezimalen)', async () => {
    const { fetchImpl } = mockRpcFetch(solResponder());
    const payments = await new SolWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 85);
    const p1 = payments.find((p) => p.txid === 'sig1');
    expect(p1).toEqual({ txid: 'sig1', vout: 0, amount: '1.5', confirmations: 5, blockHeight: 100 });
    const p2 = payments.find((p) => p.txid === 'sig2');
    expect(p2).toEqual({ txid: 'sig2', vout: 0, amount: '1', confirmations: 32, blockHeight: 90 });
  });

  it('überspringt fehlgeschlagene, ausgehende und kaputte Transaktionen', async () => {
    const { fetchImpl } = mockRpcFetch(solResponder());
    const payments = await new SolWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 85);
    // sig3: err gesetzt; sig4: slot < sinceBlock; sig5: Delta negativ; sig6: ohne meta
    expect(payments.map((p) => p.txid)).toEqual(['sig1', 'sig2']);
  });

  it('setzt Bestätigungen je nach Confirmation-Status defensiv', async () => {
    const { fetchImpl } = mockRpcFetch({
      getSignaturesForAddress: [
        { signature: 'a', slot: 10, err: null, confirmations: 2, confirmationStatus: 'confirmed' },
        { signature: 'b', slot: 11, err: null, confirmations: null, confirmationStatus: 'processed' },
        { signature: 'c', slot: 12, err: null, confirmations: null }, // unbekannt -> 0
      ],
      getTransaction: (params: unknown) => ({
        slot: 10,
        transaction: { message: { accountKeys: [ADDR] } },
        meta: { preBalances: [0], postBalances: [1000000000] },
      }),
    });
    const payments = await new SolWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR);
    expect(payments.find((p) => p.txid === 'a')?.confirmations).toBe(2);
    expect(payments.find((p) => p.txid === 'b')?.confirmations).toBe(0);
    expect(payments.find((p) => p.txid === 'c')?.confirmations).toBe(0);
  });
});

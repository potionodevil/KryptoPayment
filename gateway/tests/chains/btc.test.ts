/**
 * Tests für den Bitcoin-Chain-Watcher (bitcoind-JSON-RPC, UTXO).
 */
import { describe, it, expect } from 'vitest';
import { BtcWatcher } from '../../src/chains/btc.js';
import { RpcError } from '../../src/chains/rpc.js';
import { mockRpcFetch, mockRawFetch, jsonResponse } from './mockFetch.js';

const ADDR = 'bc1qtestaddress000000000000000000000000';

function makeWatcher(fetchImpl: any, rpcUrl = 'http://localhost:8332') {
  return new BtcWatcher({
    rpcUrl,
    auth: { user: 'rpcuser', pass: 'rpcpass' },
    fetchImpl,
  });
}

describe('BtcWatcher', () => {
  it('hat chain BTC und requiredConfirmations 3', () => {
    const w = makeWatcher(mockRpcFetch({ listunspent: [] }).fetchImpl);
    expect(w.chain).toBe('BTC');
    expect(w.requiredConfirmations()).toBe(3);
  });

  it('bildet listunspent-Request korrekt (inkl. Auth-Header)', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ listunspent: [] });
    const w = makeWatcher(fetchImpl, 'http://btc-node:8332');
    await w.fetchPayments(ADDR);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://btc-node:8332');
    expect(calls[0].method).toBe('listunspent');
    expect(calls[0].params).toEqual([0, 9999999, [ADDR]]);
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['authorization']).toBe(
      `Basic ${Buffer.from('rpcuser:rpcpass').toString('base64')}`
    );
  });

  it('parst UTXOs in ChainPayment-Objekte mit Amount-Strings', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        { txid: 'aaa', vout: 1, amount: 0.00123456, confirmations: 5, height: 800000 },
        { txid: 'bbb', vout: 0, amount: 0.5, confirmations: 0 },
      ],
    });
    const payments = await makeWatcher(fetchImpl).fetchPayments(ADDR);
    expect(payments).toEqual([
      { txid: 'aaa', vout: 1, amount: '0.00123456', confirmations: 5, blockHeight: 800000 },
      { txid: 'bbb', vout: 0, amount: '0.5', confirmations: 0 },
    ]);
  });

  it('formatiert Amounts deterministisch als String', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        { txid: 'a', vout: 0, amount: 1, confirmations: 1, height: 1 },
        { txid: 'b', vout: 0, amount: 0.00000001, confirmations: 1, height: 1 },
        { txid: 'c', vout: 0, amount: '0.25000000', confirmations: 1, height: 1 },
      ],
    });
    const payments = await makeWatcher(fetchImpl).fetchPayments(ADDR);
    expect(payments.map((p) => p.amount)).toEqual(['1', '0.00000001', '0.25']);
  });

  { /* Defensive-Parsing: kaputte Einträge werden übersprungen, Defaults gesetzt */ }
  it('parst defensiv: kaputte Einträge überspringen, Defaults setzen', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        null,
        'not-an-object',
        { vout: 3, amount: 1, confirmations: 1 }, // ohne txid -> skip
        { txid: 'ok', amount: 1 }, // ohne vout/confirmations -> Defaults
        { txid: 'x'.repeat(64), vout: 0, amount: 0.1, confirmations: 2, height: 7 },
      ],
    });
    const payments = await makeWatcher(fetchImpl).fetchPayments(ADDR);
    expect(payments).toEqual([
      { txid: 'ok', vout: 0, amount: '1', confirmations: 0 },
      { txid: 'x'.repeat(64), vout: 0, amount: '0.1', confirmations: 2, blockHeight: 7 },
    ]);
  });

  it('filtert mit sinceBlock nach Blockhöhe (unbestätigte bleiben)', async () => {
    const { fetchImpl } = mockRpcFetch({
      listunspent: [
        { txid: 'old', vout: 0, amount: 1, confirmations: 10, height: 100 },
        { txid: 'new', vout: 0, amount: 1, confirmations: 2, height: 200 },
        { txid: 'unconf', vout: 0, amount: 1, confirmations: 0 },
      ],
    });
    const payments = await makeWatcher(fetchImpl).fetchPayments(ADDR, 150);
    expect(payments.map((p) => p.txid)).toEqual(['new', 'unconf']);
  });

  it('wirft RpcError bei RPC-Fehlerobjekt', async () => {
    const { fetchImpl } = mockRawFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
    );
    await expect(makeWatcher(fetchImpl).fetchPayments(ADDR)).rejects.toThrow(RpcError);
  });

  it('wirft, wenn listunspent kein Array liefert', async () => {
    const { fetchImpl } = mockRpcFetch({ listunspent: { unexpected: true } });
    await expect(makeWatcher(fetchImpl).fetchPayments(ADDR)).rejects.toThrow(RpcError);
  });

  it('deriveAddress ruft getnewaddress(label, bech32)', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ getnewaddress: 'bc1qderived0000000000000000000000000' });
    const w = makeWatcher(fetchImpl);
    const addr = await w.deriveAddress?.('merchant-42');
    expect(addr).toBe('bc1qderived0000000000000000000000000');
    expect(calls[0].method).toBe('getnewaddress');
    expect(calls[0].params).toEqual(['merchant-42', 'bech32']);
  });
});

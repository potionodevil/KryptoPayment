/**
 * Tests für den Ethereum-Chain-Watcher (account-basiert, Native + ERC-20).
 */
import { describe, it, expect } from 'vitest';
import { EthWatcher, TRANSFER_TOPIC } from '../../src/chains/eth.js';
import { mockRpcFetch } from './mockFetch.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const PADDED = '0x0000000000000000000000001111111111111111111111111111111111111111';

function ethResponder(overrides: Record<string, unknown> = {}) {
  const blocks: Record<string, unknown> = {
    '0x12': { number: '0x12', transactions: [] },
    '0x13': {
      number: '0x13',
      transactions: [
        { hash: '0xnat1', to: ADDR, value: '0xde0b6b3a7640000', transactionIndex: '0x1' },
        { hash: '0xother', to: '0x2222222222222222222222222222222222222222', value: '0x5', transactionIndex: '0x2' },
        { hash: '0xzero', to: ADDR, value: '0x0', transactionIndex: '0x3' },
      ],
    },
    '0x14': { number: '0x14', transactions: [] },
    '0x10': { number: '0x10', transactions: [] },
    '0x11': { number: '0x11', transactions: [] },
    '0x0': { number: '0x0', transactions: [] },
  };
  return {
    eth_blockNumber: '0x14',
    eth_getLogs: [
      {
        transactionHash: '0xlog1',
        logIndex: '0x2',
        blockNumber: '0x12',
        address: '0xtoken',
        data: '0x0f4240',
      },
      { logIndex: '0x1', blockNumber: '0x12', data: '0x01' }, // ohne txid -> skip
    ],
    eth_getBlockByNumber: (params: unknown) => {
      const key = String((params as unknown[])[0]);
      if (!(key in blocks)) throw new Error(`unerwarteter Block ${key}`);
      return blocks[key];
    },
    ...overrides,
  };
}

describe('EthWatcher', () => {
  it('hat chain ETH und requiredConfirmations 12', () => {
    const w = new EthWatcher({ rpcUrl: 'http://localhost:8545', fetchImpl: mockRpcFetch(ethResponder()).fetchImpl });
    expect(w.chain).toBe('ETH');
    expect(w.requiredConfirmations()).toBe(12);
  });

  it('bildet Requests korrekt: blockNumber, getLogs (Transfer-Topic), Blöcke', async () => {
    const { fetchImpl, calls } = mockRpcFetch(ethResponder());
    const w = new EthWatcher({ rpcUrl: 'http://eth-node:8545', fetchImpl });
    await w.fetchPayments(ADDR, 18);

    expect(calls[0].method).toBe('eth_blockNumber');
    expect(calls[1].method).toBe('eth_getLogs');
    expect(calls[1].url).toBe('http://eth-node:8545');
    expect(calls[1].params).toEqual([
      {
        fromBlock: '0x12',
        toBlock: 'latest',
        topics: [TRANSFER_TOPIC, null, PADDED],
      },
    ]);
    const blockCalls = calls.filter((c) => c.method === 'eth_getBlockByNumber');
    expect(blockCalls.map((c) => c.params)).toEqual([
      ['0x12', true],
      ['0x13', true],
      ['0x14', true],
    ]);
  });

  it('parst ERC-20-Logs (vout = log_index, Amount = Token-Roh-Einheiten)', async () => {
    const { fetchImpl } = mockRpcFetch(ethResponder());
    const payments = await new EthWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 18);
    const erc20 = payments.find((p) => p.txid === '0xlog1');
    expect(erc20).toEqual({
      txid: '0xlog1',
      vout: 2,
      amount: '1000000', // 0x0f4240 = 1_000_000 Roh-Einheiten
      confirmations: 3, // tip 20 - block 18 + 1
      blockHeight: 18,
    });
  });

  it('parst native ETH-Zahlungen aus Blocks (vout = transactionIndex)', async () => {
    const { fetchImpl } = mockRpcFetch(ethResponder());
    const payments = await new EthWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 18);
    const native = payments.find((p) => p.txid === '0xnat1');
    expect(native).toEqual({
      txid: '0xnat1',
      vout: 1,
      amount: '1', // 0xde0b6b3a7640000 = 1 ETH
      confirmations: 2, // tip 20 - block 19 + 1
      blockHeight: 19,
    });
    // Fremd-Empfänger und 0-Transfers werden ignoriert
    expect(payments.some((p) => p.txid === '0xother')).toBe(false);
    expect(payments.some((p) => p.txid === '0xzero')).toBe(false);
  });

  it('parst defensiv: Logs ohne txid werden übersprungen', async () => {
    const { fetchImpl } = mockRpcFetch(ethResponder());
    const payments = await new EthWatcher({ rpcUrl: 'http://x', fetchImpl }).fetchPayments(ADDR, 18);
    expect(payments.every((p) => typeof p.txid === 'string' && p.txid.length > 0)).toBe(true);
    expect(payments).toHaveLength(1 + 1); // 1 Log + 1 native
  });

  it('nutzt ein Standard-Scanfenster, wenn sinceBlock fehlt', async () => {
    const { fetchImpl, calls } = mockRpcFetch(ethResponder());
    const w = new EthWatcher({ rpcUrl: 'http://x', fetchImpl, scanWindow: 5 });
    await w.fetchPayments(ADDR);
    const getLogs = calls.find((c) => c.method === 'eth_getLogs')!;
    expect((getLogs.params as any)[0].fromBlock).toBe('0x10'); // tip 20 - 5 + 1 = 16
  });

  it('wirft bei ungültiger Adresse', async () => {
    const { fetchImpl } = mockRpcFetch(ethResponder());
    const w = new EthWatcher({ rpcUrl: 'http://x', fetchImpl });
    await expect(w.fetchPayments('not-an-address')).rejects.toThrow();
    await expect(w.fetchPayments('0x1234')).rejects.toThrow();
  });
});

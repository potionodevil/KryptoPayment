/**
 * Tests für die Chain-Registry (Factory + Env-Konfiguration).
 */
import { describe, it, expect } from 'vitest';
import { ChainRegistry, createWatcher } from '../../src/chains/registry.js';
import { BtcWatcher } from '../../src/chains/btc.js';
import { LtcWatcher } from '../../src/chains/ltc.js';
import { EthWatcher } from '../../src/chains/eth.js';
import { SolWatcher } from '../../src/chains/sol.js';
import { XmrWatcher } from '../../src/chains/xmr.js';
import type { Chain } from '../../src/types/index.js';
import { mockRpcFetch } from './mockFetch.js';

const FULL_ENV = {
  BTC_RPC_URL: 'http://btc:8332',
  LTC_RPC_URL: 'http://ltc:9332',
  ETH_RPC_URL: 'http://eth:8545',
  SOL_RPC_URL: 'http://sol:8899',
  XMR_RPC_URL: 'http://xmr:18083',
};

describe('ChainRegistry.fromEnv', () => {
  it('baut für alle Chains Watcher aus den *_RPC_URL-Variablen', () => {
    const reg = ChainRegistry.fromEnv(FULL_ENV);
    expect(reg.chains().sort()).toEqual(['BTC', 'ETH', 'LTC', 'SOL', 'XMR']);
    expect(reg.get('BTC')).toBeInstanceOf(BtcWatcher);
    expect(reg.get('LTC')).toBeInstanceOf(LtcWatcher);
    expect(reg.get('ETH')).toBeInstanceOf(EthWatcher);
    expect(reg.get('SOL')).toBeInstanceOf(SolWatcher);
    expect(reg.get('XMR')).toBeInstanceOf(XmrWatcher);
  });

  it('wirft mit hilfreicher Meldung, wenn Endpunkte fehlen', () => {
    expect(() => ChainRegistry.fromEnv({ BTC_RPC_URL: 'http://btc:8332' })).toThrow(/ETH_RPC_URL/);
    expect(() => ChainRegistry.fromEnv({})).toThrow(/BTC_RPC_URL/);
    expect(() => ChainRegistry.fromEnv({})).toThrow(/XMR_RPC_URL/);
  });

  it('leitet RPC-Auth aus *_RPC_USER/_RPC_PASS ab', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ listunspent: [] });
    const reg = ChainRegistry.fromEnv(
      { ...FULL_ENV, BTC_RPC_USER: 'u', BTC_RPC_PASS: 'p' },
      { fetchImpl }
    );
    await reg.get('BTC').fetchPayments('bc1qaddr');
    expect(calls[0].headers['authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('leitet fetchImpl und Endpunkte an die Watcher durch', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ listunspent: [] });
    const reg = ChainRegistry.fromEnv(FULL_ENV, { fetchImpl });
    await reg.get('BTC').fetchPayments('bc1qaddr');
    expect(calls[0].url).toBe('http://btc:8332');
  });

  it('get() wirft bei unbekannter Chain', () => {
    const reg = ChainRegistry.fromEnv(FULL_ENV);
    expect(() => reg.get('DOGE' as Chain)).toThrow(/DOGE/);
    expect(reg.has('BTC')).toBe(true);
    expect(reg.has('DOGE' as Chain)).toBe(false);
  });

  it('erlaubt Registrierung eigener Watcher', () => {
    const reg = new ChainRegistry();
    const custom = {
      chain: 'BTC' as const,
      fetchPayments: async () => [],
      requiredConfirmations: () => 1,
    };
    reg.register(custom);
    expect(reg.get('BTC')).toBe(custom);
  });
});

describe('createWatcher', () => {
  it('erzeugt den passenden Watcher für jede Chain', () => {
    const { fetchImpl } = mockRpcFetch({ listunspent: [] });
    expect(createWatcher('BTC', { rpcUrl: 'http://a', fetchImpl })).toBeInstanceOf(BtcWatcher);
    expect(createWatcher('LTC', { rpcUrl: 'http://a', fetchImpl })).toBeInstanceOf(LtcWatcher);
    expect(createWatcher('ETH', { rpcUrl: 'http://a', fetchImpl })).toBeInstanceOf(EthWatcher);
    expect(createWatcher('SOL', { rpcUrl: 'http://a', fetchImpl })).toBeInstanceOf(SolWatcher);
    expect(createWatcher('XMR', { rpcUrl: 'http://a', fetchImpl })).toBeInstanceOf(XmrWatcher);
    expect(() => createWatcher('DOGE' as Chain, { rpcUrl: 'http://a' })).toThrow();
  });

  it('requiredConfirmations der Defaults stimmen pro Chain', () => {
    const { fetchImpl } = mockRpcFetch({ listunspent: [] });
    const cfg = { rpcUrl: 'http://a', fetchImpl };
    expect(createWatcher('BTC', cfg).requiredConfirmations()).toBe(3);
    expect(createWatcher('LTC', cfg).requiredConfirmations()).toBe(6);
    expect(createWatcher('ETH', cfg).requiredConfirmations()).toBe(12);
    expect(createWatcher('SOL', cfg).requiredConfirmations()).toBe(32);
    expect(createWatcher('XMR', cfg).requiredConfirmations()).toBe(10);
  });
});

/**
 * Tests für die geteilten RPC-/Einheiten-Helfer.
 */
import { describe, it, expect } from 'vitest';
import {
  RpcError,
  formatUnits,
  jsonRpcCall,
  parseBigIntish,
  parseDecimalToUnits,
} from '../../src/chains/rpc.js';
import { mockRpcFetch, mockRawFetch, jsonResponse } from './mockFetch.js';

describe('formatUnits', () => {
  it('formatiert kleinste Einheiten exakt als String (kein Float)', () => {
    expect(formatUnits(0n, 8)).toBe('0');
    expect(formatUnits(1n, 8)).toBe('0.00000001');
    expect(formatUnits(100000000n, 8)).toBe('1');
    expect(formatUnits(123456789n, 8)).toBe('1.23456789');
    expect(formatUnits(123000000n, 8)).toBe('1.23');
    expect(formatUnits(1500000000n, 9)).toBe('1.5');
    expect(formatUnits(100n, 0)).toBe('100');
  });

  it('behandelt negative Werte korrekt', () => {
    expect(formatUnits(-5n, 2)).toBe('-0.05');
  });
});

describe('parseBigIntish', () => {
  it('akzeptiert bigint, int-Zahlen, Dezimal- und Hex-Strings', () => {
    expect(parseBigIntish(42n)).toBe(42n);
    expect(parseBigIntish(42)).toBe(42n);
    expect(parseBigIntish('0xff')).toBe(255n);
    expect(parseBigIntish('-5')).toBe(-5n);
    expect(parseBigIntish('1000000000000')).toBe(1000000000000n);
    expect(parseBigIntish(0)).toBe(0n);
  });

  it('wirft bei ungültigen Werten', () => {
    expect(() => parseBigIntish(42.5)).toThrow();
    expect(() => parseBigIntish('abc')).toThrow();
    expect(() => parseBigIntish({})).toThrow();
    expect(() => parseBigIntish(null)).toThrow();
    expect(() => parseBigIntish(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});

describe('parseDecimalToUnits', () => {
  it('konvertiert BTC/LTC-Beträge (Dezimal-String oder Float) in Satoshi', () => {
    expect(parseDecimalToUnits(0.5, 8)).toBe(50000000n);
    expect(parseDecimalToUnits('0.10000000', 8)).toBe(10000000n);
    expect(parseDecimalToUnits('1', 8)).toBe(100000000n);
    expect(parseDecimalToUnits(1e-8, 8)).toBe(1n);
    expect(parseDecimalToUnits(0.00123456, 8)).toBe(123456n);
  });

  it('schneidet überschüssige Nachkommastellen ab (trunciert)', () => {
    expect(parseDecimalToUnits('0.00123456789', 8)).toBe(123456n);
  });

  it('wirft bei ungültigen Werten', () => {
    expect(() => parseDecimalToUnits('abc', 8)).toThrow();
    expect(() => parseDecimalToUnits(Number.NaN, 8)).toThrow();
    expect(() => parseDecimalToUnits('1e-8', 8)).toThrow();
  });
});

describe('jsonRpcCall', () => {
  const URL = 'http://localhost:8332';

  it('bildet den JSON-RPC-Request korrekt', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ getblockcount: 123 });
    const result = await jsonRpcCall(URL, 'getblockcount', [], { fetchImpl });
    expect(result).toBe(123);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].method).toBe('getblockcount');
    expect(calls[0].body.jsonrpc).toBe('2.0');
    expect(typeof calls[0].body.id).toBe('number');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['authorization']).toBeUndefined();
  });

  it('sendet Basic-Auth-Header, wenn Auth konfiguriert ist', async () => {
    const { fetchImpl, calls } = mockRpcFetch({ ping: 'pong' });
    await jsonRpcCall(URL, 'ping', [], {
      fetchImpl,
      auth: { user: 'rpcuser', pass: 'rpcpass' },
    });
    expect(calls[0].headers['authorization']).toBe(
      `Basic ${Buffer.from('rpcuser:rpcpass').toString('base64')}`
    );
  });

  it('liefert auch explizite null-Resultate zurück', async () => {
    const { fetchImpl } = mockRawFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
    await expect(jsonRpcCall(URL, 'getrawtransaction', ['x'], { fetchImpl })).resolves.toBeNull();
  });

  it('wirft RpcError mit RPC-Code bei JSON-RPC-Fehlerobjekt', async () => {
    const { fetchImpl } = mockRawFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
    );
    const err = await jsonRpcCall(URL, 'nope', [], { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).rpcCode).toBe(-32601);
    expect((err as RpcError).message).toContain('Method not found');
  });

  it('wirft bei HTTP-Fehlern und bei kaputter JSON-Antwort', async () => {
    const httpErr = mockRawFetch(() => jsonResponse({ error: 'boom' }, 500));
    await expect(jsonRpcCall(URL, 'x', [], { fetchImpl: httpErr.fetchImpl })).rejects.toThrow(RpcError);

    const badJson = mockRawFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token');
      },
      text: async () => '<html>not json</html>',
    }));
    await expect(jsonRpcCall(URL, 'x', [], { fetchImpl: badJson.fetchImpl })).rejects.toThrow(RpcError);
  });

  it('wirft, wenn weder result noch error vorhanden ist', async () => {
    const { fetchImpl } = mockRawFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1 }));
    await expect(jsonRpcCall(URL, 'x', [], { fetchImpl })).rejects.toThrow(RpcError);
  });
});

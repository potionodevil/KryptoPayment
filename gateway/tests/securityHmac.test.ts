import { describe, expect, it } from 'vitest';
import {
  bodyHash,
  canonicalString,
  decryptSecret,
  encryptSecret,
  generateSecret,
  hashSecret,
  hmacSha256Hex,
  sha256Hex,
  signRequest,
  verifyRequest,
} from '../src/security/hmac.js';

describe('security/hmac', () => {
  it('sha256Hex liefert den bekannten Vektor für Leerstring', () => {
    // Bekannter Testvektor: sha256('')
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hmacSha256Hex liefert den RFC-4231-Testvektor', () => {
    // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    );
  });

  it('signRequest/verifyRequest: gültige Signatur wird akzeptiert', () => {
    const secret = 'topsecret';
    const sig = signRequest(secret, {
      method: 'post',
      path: '/api/v1/invoices',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '{"a":1}',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const res = verifyRequest(secret, {
      method: 'POST',
      path: '/api/v1/invoices',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '{"a":1}',
      signature: sig,
      clockSkewSec: 300,
      nowSec: 1700000000,
    });
    expect(res.valid).toBe(true);
  });

  it('verifyRequest: manipulierter Body führt zu BAD_SIGNATURE', () => {
    const secret = 'topsecret';
    const sig = signRequest(secret, {
      method: 'POST',
      path: '/api/v1/invoices',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '{"a":1}',
    });
    const res = verifyRequest(secret, {
      method: 'POST',
      path: '/api/v1/invoices',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '{"a":2}',
      signature: sig,
      clockSkewSec: 300,
      nowSec: 1700000000,
    });
    expect(res).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('verifyRequest: abweichender Path oder Method wird nicht akzeptiert', () => {
    const secret = 'topsecret';
    const sig = signRequest(secret, {
      method: 'GET',
      path: '/api/v1/invoices/1',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '',
    });
    const res = verifyRequest(secret, {
      method: 'GET',
      path: '/api/v1/invoices/2',
      timestamp: '1700000000',
      nonce: 'n-1',
      body: '',
      signature: sig,
      clockSkewSec: 300,
      nowSec: 1700000000,
    });
    expect(res).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('verifyRequest: Timestamp-Skew außerhalb HMAC_CLOCK_SKEW_SEC wird abgelehnt', () => {
    const secret = 'topsecret';
    // Signatur immer über den tatsächlich verwendeten Timestamp bilden
    const sign = (timestamp: string) =>
      signRequest(secret, { method: 'GET', path: '/x', timestamp, nonce: 'n-1', body: '' });
    const verify = (timestamp: string) =>
      verifyRequest(secret, {
        method: 'GET',
        path: '/x',
        timestamp,
        nonce: 'n-1',
        body: '',
        signature: sign(timestamp),
        clockSkewSec: 300,
        nowSec: 1700000000,
      });
    // 301s in der Vergangenheit -> abgelehnt
    expect(verify('1699999699')).toEqual({
      valid: false,
      reason: 'TIMESTAMP_SKEW',
    });
    // 301s in der Zukunft -> abgelehnt
    expect(verify('1700000301')).toEqual({
      valid: false,
      reason: 'TIMESTAMP_SKEW',
    });
    // exakt 300s -> ok
    expect(verify('1699999700').valid).toBe(true);
  });

  it('verifyRequest: nicht-numerischer Timestamp wird abgelehnt', () => {
    const sig = signRequest('s', { method: 'GET', path: '/x', timestamp: 'abc', nonce: 'n', body: '' });
    const res = verifyRequest('s', {
      method: 'GET',
      path: '/x',
      timestamp: 'abc',
      nonce: 'n',
      body: '',
      signature: sig,
      clockSkewSec: 300,
      nowSec: 1700000000,
    });
    expect(res).toEqual({ valid: false, reason: 'TIMESTAMP_SKEW' });
  });

  it('canonicalString folgt METHOD+path+timestamp+nonce+sha256(body)', () => {
    expect(canonicalString('POST', '/p', '1', 'n', 'h')).toBe('POST/p1nh');
    expect(bodyHash('')).toBe(sha256Hex(''));
    expect(bodyHash('abc')).toBe(sha256Hex('abc'));
    expect(bodyHash(undefined)).toBe(sha256Hex(''));
  });

  it('encryptSecret/decryptSecret: Roundtrip, falscher Key schlägt fehl', () => {
    const enc = encryptSecret('my-secret', 'key-1');
    expect(enc).not.toContain('my-secret');
    expect(decryptSecret(enc, 'key-1')).toBe('my-secret');
    expect(() => decryptSecret(enc, 'key-2')).toThrow();
  });

  it('hashSecret entspricht sha256(secret) und generateSecret liefert genug Entropie', () => {
    expect(hashSecret('abc')).toBe(sha256Hex('abc'));
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUIRED_CONFIRMATIONS, loadConfig } from '../src/config.js';

describe('config (Env-Parsing)', () => {
  it('liefert sichere Defaults (HMAC_CLOCK_SKEW_SEC=300)', () => {
    const cfg = loadConfig({});
    expect(cfg.env).toBe('development');
    expect(cfg.port).toBe(8080);
    expect(cfg.hmacClockSkewSec).toBe(300);
    expect(cfg.redisUrl).toBeNull();
    expect(cfg.appIpWhitelist).toEqual([]);
    expect(cfg.nonceTtlSec).toBe(600);
    expect(cfg.requiredConfirmations.BTC).toBe(DEFAULT_REQUIRED_CONFIRMATIONS.BTC);
  });

  it('parset PORT, REDIS_URL, HMAC_CLOCK_SKEW_SEC und APP_IP_WHITELIST (CSV mit CIDR)', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      PORT: '9000',
      REDIS_URL: 'redis://localhost:6379',
      HMAC_CLOCK_SKEW_SEC: '60',
      APP_IP_WHITELIST: '10.0.0.0/8, 127.0.0.1',
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.redisUrl).toBe('redis://localhost:6379');
    expect(cfg.hmacClockSkewSec).toBe(60);
    expect(cfg.appIpWhitelist).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });

  it('parset REQUIRED_CONFIRMATIONS_<CHAIN> pro Chain', () => {
    const cfg = loadConfig({ REQUIRED_CONFIRMATIONS_BTC: '6', REQUIRED_CONFIRMATIONS_XMR: '3' });
    expect(cfg.requiredConfirmations.BTC).toBe(6);
    expect(cfg.requiredConfirmations.XMR).toBe(3);
    expect(cfg.requiredConfirmations.ETH).toBe(DEFAULT_REQUIRED_CONFIRMATIONS.ETH);
  });

  it('wirft bei ungültigem PORT oder HMAC_CLOCK_SKEW_SEC', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow();
    expect(() => loadConfig({ HMAC_CLOCK_SKEW_SEC: '-5' })).toThrow();
  });

  it('fordert ENCRYPTION_KEY in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow();
    const cfg = loadConfig({ NODE_ENV: 'production', ENCRYPTION_KEY: 'k'.repeat(32) });
    expect(cfg.env).toBe('production');
    expect(cfg.encryptionKey).toHaveLength(32);
  });
});

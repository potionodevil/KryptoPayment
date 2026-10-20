/**
 * Env-Parsing für das Gateway (dotenv + zod).
 * Alle sicherheitsrelevanten Parameter kommen ausschließlich aus der Umgebung.
 */
import 'dotenv/config';
import { z } from 'zod';
import type { Chain } from './types/index.js';
import { DEFAULT_REQUIRED_CONFIRMATIONS } from './core/paymentService.js';

export { DEFAULT_REQUIRED_CONFIRMATIONS };

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string | null;
  /** AES-Key für secret_enc der api_keys. */
  encryptionKey: string;
  /** Erlaubte Timestamp-Abweichung für HMAC-Signaturen (Sekunden). */
  hmacClockSkewSec: number;
  /** Lebensdauer einer Nonce im Replay-Schutz (Sekunden). */
  nonceTtlSec: number;
  /** Gültigkeit einer Invoice ab Erstellung (Sekunden). */
  invoiceTtlSec: number;
  /** App-weite IP/CIDR-Whitelist (zusätzlich zur Whititelist je API-Key). */
  appIpWhitelist: string[];
  rateLimit: { windowSec: number; max: number };
  /** Benötigte Bestätigungen je Chain bis CONFIRMED. */
  requiredConfirmations: Record<Chain, number>;
  trustProxy: boolean;
}

const positiveInt = (def: number, min = 1) =>
  z.coerce.number().int().min(min).max(1_000_000).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1).default('postgres://localhost:5432/krypto_gateway'),
  REDIS_URL: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().optional(),
  HMAC_CLOCK_SKEW_SEC: positiveInt(300),
  NONCE_TTL_SEC: positiveInt(600),
  INVOICE_TTL_SEC: positiveInt(1800),
  APP_IP_WHITELIST: z.string().default(''),
  RATE_LIMIT_WINDOW_SEC: positiveInt(60),
  RATE_LIMIT_MAX: positiveInt(120),
  TRUST_PROXY: z.string().optional(),
  REQUIRED_CONFIRMATIONS_BTC: z.coerce.number().int().min(0).optional(),
  REQUIRED_CONFIRMATIONS_LTC: z.coerce.number().int().min(0).optional(),
  REQUIRED_CONFIRMATIONS_ETH: z.coerce.number().int().min(0).optional(),
  REQUIRED_CONFIRMATIONS_SOL: z.coerce.number().int().min(0).optional(),
  REQUIRED_CONFIRMATIONS_XMR: z.coerce.number().int().min(0).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Ungültige Konfiguration — ${details}`);
  }
  const e = parsed.data;

  const encryptionKey = e.ENCRYPTION_KEY ?? (e.NODE_ENV === 'production' ? '' : 'dev-only-insecure-key');
  if (e.NODE_ENV === 'production' && !encryptionKey) {
    throw new Error('ENCRYPTION_KEY ist in production Pflicht');
  }

  const requiredConfirmations: Record<Chain, number> = { ...DEFAULT_REQUIRED_CONFIRMATIONS };
  const overrides: Array<[Chain, number | undefined]> = [
    ['BTC', e.REQUIRED_CONFIRMATIONS_BTC],
    ['LTC', e.REQUIRED_CONFIRMATIONS_LTC],
    ['ETH', e.REQUIRED_CONFIRMATIONS_ETH],
    ['SOL', e.REQUIRED_CONFIRMATIONS_SOL],
    ['XMR', e.REQUIRED_CONFIRMATIONS_XMR],
  ];
  for (const [chain, value] of overrides) {
    if (typeof value === 'number') requiredConfirmations[chain] = value;
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL ?? null,
    encryptionKey,
    hmacClockSkewSec: e.HMAC_CLOCK_SKEW_SEC,
    nonceTtlSec: e.NONCE_TTL_SEC,
    invoiceTtlSec: e.INVOICE_TTL_SEC,
    appIpWhitelist: e.APP_IP_WHITELIST.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rateLimit: { windowSec: e.RATE_LIMIT_WINDOW_SEC, max: e.RATE_LIMIT_MAX },
    requiredConfirmations,
    trustProxy: e.TRUST_PROXY === 'true',
  };
}

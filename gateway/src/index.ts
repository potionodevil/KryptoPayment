/**
 * Bootstrap: Konfiguration, DB-Pool, Migration, Wiring und HTTP-Server.
 */
import { loadConfig } from './config.js';
import { initPool, query, tx } from './db/pool.js';
import { migrateWithPool } from './db/migrate.js';
import { createApp } from './api/server.js';
import { createDbApiKeyStore } from './api/middleware/auth.js';
import { createDbNonceStore } from './security/nonce.js';
import {
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitStore,
} from './api/middleware/rateLimit.js';
import {
  createInvoiceService,
  defaultQuoteProvider,
  setQuoteProvider,
} from './core/invoiceService.js';
import { createPaymentService } from './core/paymentService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initPool(config.databaseUrl);
  await migrateWithPool();

  // Provider/Adapter (Kurse, Adressen) werden hier verdrahtet.
  setQuoteProvider(defaultQuoteProvider);

  const invoices = createInvoiceService({
    txRunner: tx,
    ttlSec: config.invoiceTtlSec,
  });
  const payments = createPaymentService({
    txRunner: tx,
    requiredConfirmations: config.requiredConfirmations,
  });

  let rateLimitStore: RateLimitStore = createMemoryRateLimitStore();
  if (config.redisUrl) {
    const { default: Redis } = await import('ioredis');
    rateLimitStore = createRedisRateLimitStore(new Redis(config.redisUrl));
  }

  const app = createApp({
    config,
    invoices,
    payments,
    keys: createDbApiKeyStore(query),
    nonces: createDbNonceStore(query),
    rateLimit: rateLimitStore,
  });

  // Regelmäßiges Aufräumen abgelaufener Nonces (Replay-Fenster).
  const purgeTimer = setInterval(() => {
    void createDbNonceStore(query).purgeExpired().catch(() => undefined);
  }, 60_000);
  purgeTimer.unref();

  const server = app.listen(config.port, () => {
    console.log(
      `Krypto Payment Gateway lauft auf :${config.port} (env=${config.env}, redis=${config.redisUrl ? 'an' : 'aus'})`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} empfangen — Server wird beendet`);
    clearInterval(purgeTimer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Bootstrap fehlgeschlagen:', err);
  process.exit(1);
});

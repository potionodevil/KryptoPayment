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
import { createPaymentMatcher } from './core/paymentMatcher.js';
import { createWatchTargetService } from './core/addressProvider.js';
import { ChainRegistry } from './chains/registry.js';
import { createPoller } from './watcher/poller.js';

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

  // Forwarding-Watcher (non-custodial): pollt die Zieladressen aktiver Invoices
  // über die Chain-Adapter und ordnet eingehende Zahlungen idempotent zu.
  const matcher = createPaymentMatcher({ txRunner: tx, payments });
  const watchTargets = createWatchTargetService({ txRunner: tx });

  let poller: { start(): void; stop(): void } | null = null;
  try {
    const chainRegistry = ChainRegistry.fromEnv(process.env);
    poller = createPoller({
      listWatchTargets: () => watchTargets.listWatchTargets(),
      matcher,
      chainRegistry,
      intervalMs: 30_000,
    });
  } catch (err) {
    // RPC-URLs fehlen: API läuft weiter, nur das Chain-Monitoring bleibt aus.
    console.warn(
      'Chain-Monitoring deaktiviert (RPC-URLs fehlen):',
      err instanceof Error ? err.message : err
    );
  }

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
      `Krypto Payment Gateway lauft auf :${config.port} (env=${config.env}, redis=${config.redisUrl ? 'an' : 'aus'}, monitoring=${poller ? 'an' : 'aus'})`
    );
  });

  // Chain-Monitoring starten (falls konfiguriert).
  poller?.start();

  const shutdown = (signal: string) => {
    console.log(`${signal} empfangen — Server wird beendet`);
    poller?.stop();
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

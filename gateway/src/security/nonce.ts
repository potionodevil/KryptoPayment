/**
 * Replay-Schutz: jede Nonce ist nur einmal gültig.
 * DB-Variante via nonce_cache (INSERT ... ON CONFLICT DO NOTHING = atomar),
 * In-Memory-Variante als Fallback/Tests.
 */

export type NonceExec = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: any[]; rowCount: number }>;

export interface NonceStore {
  /**
   * Reserviert die Nonce. true = jetzt gültig, false = bereits benutzt (Replay).
   * ttlSec bestimmt, wie lange die Nonce als "benutzt" gilt.
   */
  consume(nonce: string, merchantId: string, ttlSec: number): Promise<boolean>;
  /** Räumt abgelaufene Nonces ab (regelmäßig aufrufen). */
  purgeExpired(): Promise<void>;
}

/**
 * In-Memory-Nonce-Cache (unix seconds im Clock-Callback).
 * Achtung: nur prozesslokal — produktiv mit Redis/DB betreiben.
 */
export function createMemoryNonceStore(
  clock: () => number = () => Math.floor(Date.now() / 1000)
): NonceStore & { size(): number } {
  const used = new Map<string, number>(); // nonce -> gültig bis (unix sec)

  return {
    async consume(nonce: string, _merchantId: string, ttlSec: number): Promise<boolean> {
      const now = clock();
      const expiresAt = used.get(nonce);
      if (expiresAt !== undefined && expiresAt > now) {
        return false; // Replay
      }
      used.set(nonce, now + ttlSec);
      return true;
    },
    async purgeExpired(): Promise<void> {
      const now = clock();
      for (const [nonce, expiresAt] of used) {
        if (expiresAt <= now) used.delete(nonce);
      }
    },
    size(): number {
      return used.size;
    },
  };
}

/** DB-Nonce-Cache auf nonce_cache (PRIMARY KEY nonce -> Eindeutigkeit erzwungen). */
export function createDbNonceStore(exec: NonceExec): NonceStore {
  return {
    async consume(nonce: string, merchantId: string, ttlSec: number): Promise<boolean> {
      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      // Atomare Reservierung: bei Konflikt (bereits vorhanden) wird nichts eingefügt.
      const res = await exec(
        'INSERT INTO nonce_cache (nonce, merchant_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (nonce) DO NOTHING',
        [nonce, merchantId, expiresAt]
      );
      return res.rowCount === 1;
    },
    async purgeExpired(): Promise<void> {
      await exec('DELETE FROM nonce_cache WHERE expires_at < $1', [
        new Date().toISOString(),
      ]);
    },
  };
}

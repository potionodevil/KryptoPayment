/**
 * Sperr-Helfer für Race-Condition-Härte.
 *
 * Ein Advisory-Lock pro (chain, currency) serialisiert die Betrags-Vergabe
 * (createInvoice) und die Zahlungs-Zuordnung (paymentMatcher) innerhalb einer
 * Transaktion. pg_advisory_xact_lock wird bei COMMIT/ROLLBACK automatisch
 * freigegeben — kein Lock-Leak möglich.
 */
import type { Chain } from '../types/index.js';

export const SQL_ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

/** Serialisierungsschlüssel für (chain, currency). */
export function forwardingLockKey(chain: Chain, currency: string): string {
  return `fwd:${chain}:${String(currency).trim().toUpperCase()}`;
}

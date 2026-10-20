/**
 * Blockchain-Poller: das Herzstück der Zahlungserkennung.
 *
 * Forwarding-Modell (non-custodial): Der Poller fragt die Zieladressen aktiver
 * Invoices über die Chain-Adapter (ChainWatcher) ab und reicht jede erkannte
 * Zahlung an den PaymentMatcher weiter. Es gibt KEINE Adressableitung und
 * KEINE Keys — die Adressen stammen aus den Invoices (listWatchTargets).
 *
 * Robustheit:
 * - RPC-Fehler einzelner Adressen werden abgefangen; die übrigen Adressen
 *   und die folgenden Zyklen laufen ungestört weiter.
 * - Kein Doppel-Polling: läuft ein Zyklus noch, werden Intervall-Ticks
 *   übersprungen (keine überlappenden fetchPayments-Aufrufe).
 * - Idempotent: derselbe Start/Stop-Aufruf mehrfach ist harmlos; der
 *   Matcher ist für die Deduplizierung von Zahlungen zuständig.
 */
import type { ChainPayment, ChainWatcher } from '../services/contracts.js';
import type { Chain } from '../types/index.js';

/**
 * Abhängigkeiten des Pollers (Dependency Injection — in Tests fakbar).
 * Die Typen entsprechen exakt den Service-Verträgen in services/contracts.ts.
 */
export interface PollerDeps {
  /** Liefert die zu monitornenden (chain, currency, address)-Ziele (aktive Invoices). */
  listWatchTargets(): Promise<Array<{ chain: Chain; currency: string; address: string }>>;
  matcher: {
    matchAndApply(p: {
      chain: Chain;
      currency: string;
      txid: string;
      vout: number;
      amount: string;
      confirmations: number;
    }): Promise<{ matchedInvoiceId: string | null; applied: boolean }>;
  };
  chainRegistry: { get(chain: Chain): ChainWatcher };
  intervalMs: number;
}

/**
 * Erzeugt den Blockchain-Poller.
 *
 * start() führt sofort einen ersten Abfragezyklus aus und pollt danach
 * alle `intervalMs` erneut. stop() beendet das Polling; ein gerade laufender
 * Zyklus darf noch abschließen, es werden aber keine neuen gestartet.
 */
export function createPoller(deps: PollerDeps): { start(): void; stop(): void } {
  const { listWatchTargets, matcher, chainRegistry, intervalMs } = deps;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Ungültiges intervalMs für den Poller: ${intervalMs}`);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  /** Läuft gerade ein Zyklus? Dann werden Intervall-Ticks übersprungen. */
  let inFlight = false;

  /**
   * Ein Abfragezyklus: alle Adressen der Reihe nach abfragen und jede
   * erkannte Zahlung an den Matcher übergeben. Fehler pro Adresse/Zahlung
   * werden abgefangen, damit ein Ausfall nie den ganzen Zyklus killt.
   */
  async function runCycle(): Promise<void> {
    let targets: Array<{ chain: Chain; currency: string; address: string }>;
    try {
      targets = await listWatchTargets();
    } catch (err) {
      console.error(
        '[poller] listWatchTargets fehlgeschlagen:',
        err instanceof Error ? err.message : err
      );
      return;
    }
    for (const entry of targets) {
      // Watcher holen (kann bei unregistrierter Chain werfen) und abfragen
      let payments: ChainPayment[] | undefined;
      try {
        const watcher = chainRegistry.get(entry.chain);
        payments = await watcher.fetchPayments(entry.address);
      } catch (err) {
        // RPC-/Registry-Fehler: protokollieren, nächste Adresse weitermachen
        console.error(
          `[poller] Abfrage fehlgeschlagen (${entry.chain} ${entry.address}):`,
          err instanceof Error ? err.message : err
        );
        continue;
      }

      for (const p of payments ?? []) {
        try {
          await matcher.matchAndApply({
            chain: entry.chain,
            currency: entry.currency,
            txid: p.txid,
            vout: p.vout,
            amount: p.amount,
            confirmations: p.confirmations,
          });
        } catch (err) {
          // Matcher-Fehler (z.B. DB weg): protokollieren, nächste Zahlung
          console.error(
            `[poller] matchAndApply fehlgeschlagen (${entry.chain} ${p.txid}):`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  }

  /** Intervall-Tick: nur starten, wenn kein Zyklus mehr in der Luft ist. */
  function tick(): void {
    if (inFlight) return; // kein Doppel-Polling
    inFlight = true;
    void runCycle().finally(() => {
      inFlight = false;
    });
  }

  return {
    start(): void {
      if (timer !== null) return; // idempotent: kein zweiter Timer
      tick(); // sofort beim Start pollen
      timer = setInterval(tick, intervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

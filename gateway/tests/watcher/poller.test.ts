/**
 * Tests für den Blockchain-Poller (src/watcher/poller.ts).
 *
 * Der Poller iteriert die statischen Zieladressen, ruft pro (chain, address)
 * den ChainWatcher.fetchPayments auf und reicht jede Zahlung an den
 * PaymentMatcher weiter. TDD: diese Tests definieren den Vertrag.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { ChainPayment, ChainWatcher } from '../../src/services/contracts.js';
import type { Chain } from '../../src/types/index.js';
import type { PollerDeps } from '../../src/watcher/poller.js';
import { createPoller } from '../../src/watcher/poller.js';

/** Promise, dessen Auflösung der Test steuert (für Überlappungs-Tests). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeWatcher extends ChainWatcher {
  fetchPayments: Mock<(address: string, sinceBlock?: number) => Promise<ChainPayment[]>>;
}

function fakeWatcher(
  chain: Chain,
  payments: ChainPayment[] | Error | (() => Promise<ChainPayment[]>)
): FakeWatcher {
  const fetchPayments = vi.fn(async (_address: string, _sinceBlock?: number): Promise<ChainPayment[]> => {
    if (payments instanceof Error) throw payments;
    if (typeof payments === 'function') return payments();
    return payments;
  });
  return {
    chain,
    fetchPayments,
    requiredConfirmations: () => 3,
  } as unknown as FakeWatcher;
}

interface Harness {
  deps: PollerDeps;
  matchAndApply: Mock<(p: {
    chain: Chain;
    currency: string;
    txid: string;
    vout: number;
    amount: string;
    confirmations: number;
  }) => Promise<{ matchedInvoiceId: string | null; applied: boolean }>>;
  registryGet: Mock<(chain: Chain) => ChainWatcher>;
}

function makeHarness(
  watchers: Partial<Record<Chain, ChainWatcher>>,
  addresses: Array<{ chain: Chain; currency: string; address: string }>,
  intervalMs = 1000
): Harness {
  const matchAndApply = vi.fn(async (_p: unknown) => ({ matchedInvoiceId: null, applied: false }));
  const registryGet = vi.fn((chain: Chain): ChainWatcher => {
    const w = watchers[chain];
    if (!w) throw new Error(`Kein Chain-Watcher registriert für: ${chain}`);
    return w;
  });
  const deps: PollerDeps = {
    listWatchTargets: async () => addresses,
    matcher: { matchAndApply },
    chainRegistry: { get: registryGet },
    intervalMs,
  };
  return { deps, matchAndApply, registryGet };
}

const BTC_ADDR = { chain: 'BTC' as const, currency: 'BTC', address: 'bc1qStaticOperator' };
const LTC_ADDR = { chain: 'LTC' as const, currency: 'LTC', address: 'ltc1qStaticOperator' };

const PAYMENT_A: ChainPayment = { txid: 'txA', vout: 0, amount: '0.5', confirmations: 1, blockHeight: 100 };
const PAYMENT_B: ChainPayment = { txid: 'txB', vout: 3, amount: '1.25', confirmations: 7 };

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {}); // stille Fehlerprotokolle
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ruft fetchPayments für jede konfigurierte Adresse mit dem passenden Watcher auf', async () => {
    const btc = fakeWatcher('BTC', []);
    const ltc = fakeWatcher('LTC', []);
    const { deps } = makeHarness({ BTC: btc, LTC: ltc }, [BTC_ADDR, LTC_ADDR]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(btc.fetchPayments).toHaveBeenCalledTimes(1);
    expect(btc.fetchPayments).toHaveBeenCalledWith(BTC_ADDR.address);
    expect(ltc.fetchPayments).toHaveBeenCalledTimes(1);
    expect(ltc.fetchPayments).toHaveBeenCalledWith(LTC_ADDR.address);
    poller.stop();
  });

  it('pollt sofort beim Start und dann regelmäßig im Intervall', async () => {
    const btc = fakeWatcher('BTC', []);
    const { deps } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(1); // sofort beim Start

    await vi.advanceTimersByTimeAsync(1000);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(5); // 1 initial + 4 Intervalle
    poller.stop();
  });

  it('leitet jede erkannte Zahlung mit chain/currency an matcher.matchAndApply weiter', async () => {
    const btc = fakeWatcher('BTC', [PAYMENT_A, PAYMENT_B]);
    const { deps, matchAndApply } = makeHarness({ BTC: btc }, [BTC_ADDR]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(matchAndApply).toHaveBeenCalledTimes(2);
    expect(matchAndApply).toHaveBeenCalledWith({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'txA',
      vout: 0,
      amount: '0.5',
      confirmations: 1,
    });
    expect(matchAndApply).toHaveBeenCalledWith({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'txB',
      vout: 3,
      amount: '1.25',
      confirmations: 7,
    });
    poller.stop();
  });

  it('verwendet das currency-Feld der Adress-Konfiguration (nicht nur den Chain-Namen)', async () => {
    // ETH-Adresse, auf der z.B. USDT-Zahlungen eingehen
    const eth = fakeWatcher('ETH', [PAYMENT_A]);
    const usdtAddr = { chain: 'ETH' as const, currency: 'USDT', address: '0xStaticOperator' };
    const { deps, matchAndApply } = makeHarness({ ETH: eth }, [usdtAddr]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(matchAndApply).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ETH', currency: 'USDT' })
    );
    poller.stop();
  });

  it('überlebt RPC-Fehler: fehlerhafte Adresse verhindert nicht die übrigen', async () => {
    const broken = fakeWatcher('BTC', new Error('RPC down'));
    const ltc = fakeWatcher('LTC', [PAYMENT_B]);
    const { deps, matchAndApply } = makeHarness({ BTC: broken, LTC: ltc }, [BTC_ADDR, LTC_ADDR]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // LTC wurde trotz BTC-Fehler gepollt und die Zahlung weitergereicht
    expect(ltc.fetchPayments).toHaveBeenCalledTimes(1);
    expect(matchAndApply).toHaveBeenCalledTimes(1);
    expect(matchAndApply).toHaveBeenCalledWith(expect.objectContaining({ txid: 'txB' }));
    poller.stop();
  });

  it('läuft nach einem RPC-Fehler im nächsten Intervall normal weiter', async () => {
    const failing = { calls: 0 };
    const btc = fakeWatcher('BTC', async () => {
      failing.calls += 1;
      if (failing.calls <= 2) throw new Error('RPC timeout');
      return [PAYMENT_A];
    });
    const { deps, matchAndApply } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // Startzyklus + 1 Intervall fehlgeschlagen
    expect(matchAndApply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // nächster Zyklus: Fehler vorbei
    expect(matchAndApply).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('fängt Fehler der Registry (unregistrierte Chain) ab und macht weiter', async () => {
    const ltc = fakeWatcher('LTC', [PAYMENT_B]);
    // BTC ist absichtlich NICHT registriert -> registryGet wirft
    const { deps, matchAndApply, registryGet } = makeHarness({ LTC: ltc }, [BTC_ADDR, LTC_ADDR]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(registryGet).toHaveBeenCalledWith('BTC');
    expect(ltc.fetchPayments).toHaveBeenCalledTimes(1);
    expect(matchAndApply).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('fängt matcher-Fehler ab: eine kaputte Zahlung stoppt nicht die übrigen', async () => {
    const btc = fakeWatcher('BTC', [PAYMENT_A, PAYMENT_B]);
    const { deps, matchAndApply } = makeHarness({ BTC: btc }, [BTC_ADDR]);
    matchAndApply.mockRejectedValue(new Error('DB weg'));

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(matchAndApply).toHaveBeenCalledTimes(2); // beide versucht
    poller.stop();
  });

  it('stop() beendet das Polling (keine Zyklen mehr nach dem Stop)', async () => {
    const btc = fakeWatcher('BTC', []);
    const { deps } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(2); // eingefroren
  });

  it('stop() ist idempotent und start() kann danach neu starten', async () => {
    const btc = fakeWatcher('BTC', []);
    const { deps } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    poller.stop();
    poller.stop(); // zweites stop() wirft nicht
    await vi.advanceTimersByTimeAsync(3000);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(1); // nur der Startzyklus

    poller.start(); // Neustart
    await vi.advanceTimersByTimeAsync(0);
    expect(btc.fetchPayments).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('kein Doppel-Polling: überlappende Zyklen werden übersprungen', async () => {
    const gate = deferred<ChainPayment[]>();
    let openCalls = 0;
    const btc = fakeWatcher('BTC', () => {
      openCalls += 1;
      return gate.promise;
    });
    const { deps } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(openCalls).toBe(1);

    // Zyklus hängt noch — Intervall-Ticks dürfen NICHT nachpollen
    await vi.advanceTimersByTimeAsync(3000);
    expect(openCalls).toBe(1);

    gate.resolve([]);
    await vi.advanceTimersByTimeAsync(0); // Zyklus abschließen
    await vi.advanceTimersByTimeAsync(1000); // nächster Tick pollt wieder
    expect(openCalls).toBe(2);
    poller.stop();
  });

  it('start() ist idempotent: doppelter Start erzeugt keinen zweiten Timer', async () => {
    const btc = fakeWatcher('BTC', []);
    const { deps } = makeHarness({ BTC: btc }, [BTC_ADDR], 1000);

    const poller = createPoller(deps);
    poller.start();
    poller.start(); // zweiter Start darf keinen zweiten Timer anlegen
    await vi.advanceTimersByTimeAsync(1000);

    // 1 Startzyklus + 1 Intervall — NICHT verdoppelt
    expect(btc.fetchPayments).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('pollt alle Adressen derselben Chain mit derselben Adresseinstanz', async () => {
    // zwei statische Adressen auf derselben Chain (z.B. BTC + tBTC-Testlauf)
    const btc = fakeWatcher('BTC', [PAYMENT_A]);
    const secondAddr = { chain: 'BTC' as const, currency: 'BTC', address: 'bc1qSecond' };
    const { deps, matchAndApply } = makeHarness({ BTC: btc }, [BTC_ADDR, secondAddr]);

    const poller = createPoller(deps);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(btc.fetchPayments).toHaveBeenCalledTimes(2);
    expect(btc.fetchPayments).toHaveBeenNthCalledWith(1, BTC_ADDR.address);
    expect(btc.fetchPayments).toHaveBeenNthCalledWith(2, secondAddr.address);
    // Beide Adressen liefern dieselbe Zahlung -> Matcher entscheidet (idempotent),
    // der Poller reicht beide Beobachtungen weiter.
    expect(matchAndApply).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

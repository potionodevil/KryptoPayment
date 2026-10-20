import { describe, expect, it } from 'vitest';
import { createPaymentMatcher } from '../src/core/paymentMatcher.js';
import { createPaymentService } from '../src/core/paymentService.js';
import {
  createInvoiceService,
  SQL_INSERT_INVOICE,
  type QuoteProvider,
} from '../src/core/invoiceService.js';
import type { CreateInvoiceRequest } from '../src/types/index.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';

const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

/** Platzhalter-Kurs 1:1 — der Krypto-Betrag kommt als exakter String. */
const quote: QuoteProvider = async (req) => ({ amountCrypto: req.amountFiat });

function makeReq(overrides: Partial<CreateInvoiceRequest> = {}): CreateInvoiceRequest {
  return {
    orderRef: 'order-1',
    amountFiat: '10.00000000',
    fiatCurrency: 'EUR',
    cryptoCurrency: 'BTC',
    chain: 'BTC',
    targetAddress: BTC_ADDR,
    ...overrides,
  };
}

function setup() {
  const db = new FakeDb();
  const txRunner = fakeTxRunner(db);
  const invoices = createInvoiceService({ txRunner, quote, ttlSec: 900 });
  const payments = createPaymentService({ txRunner, requiredConfirmations: { BTC: 3 } });
  const matcher = createPaymentMatcher({ txRunner, payments });
  return { db, invoices, payments, matcher };
}

/** Direkt-Seed identischer Beträge (umgeht die Nudge-Logik der Erstellung). */
async function seedRawInvoice(db: FakeDb, orderRef: string, amount: string): Promise<string> {
  const res = await db.query(SQL_INSERT_INVOICE, [
    'merchant-1',
    orderRef,
    '100.00',
    'EUR',
    amount,
    'BTC',
    'BTC',
    BTC_ADDR,
    'AWAITING_PAYMENT',
    '2026-01-01T00:15:00.000Z',
  ]);
  return String(res.rows[0].id);
}

describe('core/paymentMatcher — Betrags-Matching (exakt + FIFO, non-custodial)', () => {
  it('ordnet eine Zahlung per EXAKTEM Betrag zu (Vergleich in kleinster Einheit)', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    const res = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '10', // '10' == '10.00000000' in kleinster Einheit
      confirmations: 0,
    });
    expect(res).toEqual({ matchedInvoiceId: inv.id, applied: true });
    expect((await invoices.getById(inv.id))!.status).toBe('PAID');
    expect(db.paymentRows()).toHaveLength(1);
    expect(db.paymentRows()[0].amount).toBe('10');
  });

  it('Betrag ohne passende Invoice (über amount_crypto) -> KEIN Match, KEINE Buchung', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    const res = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '12.00000000', // passt in KEINE Invoice
      confirmations: 5,
    });
    expect(res).toEqual({ matchedInvoiceId: null, applied: false });
    expect(db.paymentRows()).toHaveLength(0);
    expect((await invoices.getById(inv.id))!.status).toBe('AWAITING_PAYMENT');
  });

  it('EXAKTE Betragsgleichheit schlägt ältere Invoice mit größerem Betrag', async () => {
    const { invoices, matcher } = setup();
    const older = await invoices.createInvoice(
      'm',
      makeReq({ orderRef: 'big', amountFiat: '20.00000000' })
    );
    const exact = await invoices.createInvoice(
      'm',
      makeReq({ orderRef: 'exact', amountFiat: '10.00000000' })
    );
    const res = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-exact',
      vout: 0,
      amount: '10.00000000',
      confirmations: 0,
    });
    expect(res.matchedInvoiceId).toBe(exact.id); // nicht die ältere 20er-Invoice
    expect((await invoices.getById(older.id))!.status).toBe('AWAITING_PAYMENT');
    expect((await invoices.getById(exact.id))!.status).toBe('PAID');
  });

  it('FIFO: bei identischen Beträgen gewinnt die älteste Invoice', async () => {
    const { db, matcher } = setup();
    const idA = await seedRawInvoice(db, 'fifo-a', '10.00000000');
    const idB = await seedRawInvoice(db, 'fifo-b', '10.00000000');
    // Deterministische Alterung: A ist älter als B
    db.invoiceRow(idA)!.created_at = '2026-01-01T00:00:00.000Z';
    db.invoiceRow(idB)!.created_at = '2026-01-01T00:00:01.000Z';

    const first = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '10.00000000',
      confirmations: 0,
    });
    const second = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-2',
      vout: 0,
      amount: '10.00000000',
      confirmations: 0,
    });
    expect(first.matchedInvoiceId).toBe(idA);
    expect(second.matchedInvoiceId).toBe(idB);
    expect(db.paymentRows().map((p) => p.invoice_id)).toEqual([idA, idB]);
  });

  it('IDEMPOTENT: dieselbe (chain,txid,vout) wird nie doppelt verarbeitet', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    const pay = {
      chain: 'BTC' as const,
      currency: 'BTC',
      txid: 'tx-dup',
      vout: 0,
      amount: '10.00000000',
      confirmations: 0,
    };
    const first = await matcher.matchAndApply(pay);
    const second = await matcher.matchAndApply(pay);
    const third = await matcher.matchAndApply(pay);
    expect(first).toEqual({ matchedInvoiceId: inv.id, applied: true });
    expect(second).toEqual({ matchedInvoiceId: inv.id, applied: false });
    expect(third).toEqual({ matchedInvoiceId: inv.id, applied: false });
    expect(db.paymentRows()).toHaveLength(1);
    expect((await invoices.getById(inv.id))!.status).toBe('PAID'); // keine Doppelsumme
  });

  it('race: zwei parallele apply derselben TXO -> genau eine Verarbeitung', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    const pay = {
      chain: 'BTC' as const,
      currency: 'BTC',
      txid: 'tx-race',
      vout: 0,
      amount: '10.00000000',
      confirmations: 0,
    };
    const results = await Promise.all([matcher.matchAndApply(pay), matcher.matchAndApply(pay)]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.every((r) => r.matchedInvoiceId === inv.id)).toBe(true);
    expect(db.paymentRows()).toHaveLength(1);
    expect((await invoices.getById(inv.id))!.status).toBe('PAID');
  });

  it('race: zwei parallele Zahlungen, aber nur EINE passende Invoice -> eine Zuordnung', async () => {
    const { db, invoices, matcher } = setup();
    await invoices.createInvoice('m', makeReq());
    const [r1, r2] = await Promise.all([
      matcher.matchAndApply({
        chain: 'BTC',
        currency: 'BTC',
        txid: 'tx-a',
        vout: 0,
        amount: '10.00000000',
        confirmations: 0,
      }),
      matcher.matchAndApply({
        chain: 'BTC',
        currency: 'BTC',
        txid: 'tx-b',
        vout: 0,
        amount: '10.00000000',
        confirmations: 0,
      }),
    ]);
    const applied = [r1, r2].filter((r) => r.applied);
    const unmatched = [r1, r2].filter((r) => r.matchedInvoiceId === null);
    expect(applied).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(db.paymentRows()).toHaveLength(1);
  });

  it('Teilbetrag -> PARTIALLY_PAID', async () => {
    const { invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-part',
      vout: 0,
      amount: '4.00000000',
      confirmations: 5,
    });
    expect((await invoices.getById(inv.id))!.status).toBe('PARTIALLY_PAID');
  });

  it('Bestätigungen: PAID unter dem Limit, CONFIRMED beim Erreichen', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    // 1 Bestätigung < 3 (BTC-Limit) -> PAID, nicht CONFIRMED
    await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-conf',
      vout: 0,
      amount: '10.00000000',
      confirmations: 1,
    });
    expect((await invoices.getById(inv.id))!.status).toBe('PAID');

    // Bestätigungen wachsen über das Limit -> CONFIRMED (keine erneute Buchung)
    const again = await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-conf',
      vout: 0,
      amount: '10.00000000',
      confirmations: 3,
    });
    expect(again).toEqual({ matchedInvoiceId: inv.id, applied: false });
    const confirmed = (await invoices.getById(inv.id))!;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(db.paymentRows()).toHaveLength(1);
    expect(db.paymentRows()[0].confirmations).toBe(3);
  });

  it('Zahlung mit vollem Limit sofort -> PAID->CONFIRMED (State-Path)', async () => {
    const { invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-instant',
      vout: 0,
      amount: '10.00000000',
      confirmations: 3,
    });
    expect((await invoices.getById(inv.id))!.status).toBe('CONFIRMED');
  });

  it('bucht NIE Guthaben — nur Transaktions-Nachweis + Invoice-Status', async () => {
    const { db, invoices, matcher } = setup();
    const inv = await invoices.createInvoice('m', makeReq());
    await matcher.matchAndApply({
      chain: 'BTC',
      currency: 'BTC',
      txid: 'tx-evidence',
      vout: 1,
      amount: '10.00000000',
      confirmations: 0,
    });
    // Genau EINE Payment-Zeile als Transaktions-Nachweis ...
    expect(db.paymentRows()).toHaveLength(1);
    expect(db.paymentRows()[0]).toMatchObject({
      invoice_id: inv.id,
      chain: 'BTC',
      txid: 'tx-evidence',
      vout: 1,
      amount: '10.00000000',
      status: 'DETECTED',
    });
    // ... und nur der Status der Invoice ändert sich (keine Guthaben-Konten o.ä.)
    expect(db.invoices.size).toBe(1);
    expect((await invoices.getById(inv.id))!.status).toBe('PAID');
  });
});

import { describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  compareDecimalStrings,
  createPaymentService,
} from '../src/core/paymentService.js';
import { createInvoiceService, type QuoteProvider } from '../src/core/invoiceService.js';
import type { CreateInvoiceRequest } from '../src/types/index.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';

const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

const quote: QuoteProvider = async () => ({ amountCrypto: '10.00000000' });

function makeReq(overrides: Partial<CreateInvoiceRequest> = {}): CreateInvoiceRequest {
  return {
    orderRef: 'order-1',
    amountFiat: '100.00',
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
  const payments = createPaymentService({
    txRunner,
    requiredConfirmations: { BTC: 3 },
  });
  return { db, invoices, payments, txRunner };
}

async function seedInvoice(
  db: FakeDb,
  invoices: ReturnType<typeof createInvoiceService>,
  overrides: Partial<CreateInvoiceRequest> = {}
) {
  const inv = await invoices.createInvoice('merchant-1', makeReq(overrides));
  return inv;
}

describe('core/paymentService — Decimal-Helfer', () => {
  it('addDecimalStrings rechnet exakt (kein Float)', () => {
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
    expect(addDecimalStrings('1.000000000000000001', '1.000000000000000001')).toBe(
      '2.000000000000000002'
    );
    expect(addDecimalStrings('0', '10.5')).toBe('10.5');
    expect(addDecimalStrings('99999999999999999999', '1')).toBe('100000000000000000000');
  });

  it('compareDecimalStrings vergleicht korrekt', () => {
    expect(compareDecimalStrings('10', '10.0')).toBe(0);
    expect(compareDecimalStrings('10.1', '10.09')).toBe(1);
    expect(compareDecimalStrings('9.9', '10')).toBe(-1);
    expect(compareDecimalStrings('100.00000000', '100')).toBe(0);
  });
});

describe('core/paymentService.applyIncomingPayment', () => {
  it('bucht eine Zahlung gut und setzt PARTIALLY_PAID bei Teilbetrag', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    const res = await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '4.00000000',
      confirmations: 0,
    });
    expect(res.applied).toBe(true);
    expect(res.payment.status).toBe('DETECTED'); // 0 < 3 Bestätigungen
    expect(res.payment.amount).toBe('4.00000000');
    expect((await invoices.getById(inv.id))!.status).toBe('PARTIALLY_PAID');
  });

  it('setzt PAID bei vollständiger Summe und CONFIRMED bei genug Bestätigungen', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '6.00000000',
      confirmations: 1,
    });
    expect((await invoices.getById(inv.id))!.status).toBe('PARTIALLY_PAID');

    const res2 = await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-2',
      vout: 0,
      amount: '4.00000000',
      confirmations: 3,
    });
    expect(res2.applied).toBe(true);
    const paid = (await invoices.getById(inv.id))!;
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();

    // Bestätigungen der ersten TXO wachsen über das Limit -> CONFIRMED
    const res3 = await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-1',
      vout: 0,
      amount: '6.00000000',
      confirmations: 5,
    });
    expect(res3.applied).toBe(false); // TXO bekannt -> keine erneute Gutschrift
    expect(res3.payment.confirmations).toBe(5); // Bestätigungen werden aktualisiert
    const confirmed = (await invoices.getById(inv.id))!;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('IST IDEMPOTENT: dieselbe (chain,txid,vout) wird nie doppelt gutgeschrieben', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    const pay = { chain: 'BTC' as const, txid: 'tx-dup', vout: 0, amount: '10.00000000', confirmations: 3 };
    const first = await payments.applyIncomingPayment(inv.id, pay);
    const second = await payments.applyIncomingPayment(inv.id, pay);
    const third = await payments.applyIncomingPayment(inv.id, pay);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(third.applied).toBe(false);
    expect(db.paymentRows()).toHaveLength(1); // nur EINE Payment-Zeile
    const invAfter = (await invoices.getById(inv.id))!;
    expect(invAfter.status).toBe('CONFIRMED'); // 10 == 10, 3 >= 3
  });

  it('hält parallele Anwendung derselben TXO race-sicher (nur eine Gutschrift)', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    const pay = { chain: 'BTC' as const, txid: 'tx-race', vout: 0, amount: '10.00000000', confirmations: 0 };
    const results = await Promise.all([
      payments.applyIncomingPayment(inv.id, pay),
      payments.applyIncomingPayment(inv.id, pay),
      payments.applyIncomingPayment(inv.id, pay),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(db.paymentRows()).toHaveLength(1);
    expect((await invoices.getById(inv.id))!.status).toBe('PAID'); // Summe exakt 10
  });

  it('hält parallele Zahlungen (verschiedene TXOs) konsistent — SELECT ... FOR UPDATE', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    await Promise.all([
      payments.applyIncomingPayment(inv.id, {
        chain: 'BTC',
        txid: 'tx-a',
        vout: 0,
        amount: '0.1',
        confirmations: 0,
      }),
      payments.applyIncomingPayment(inv.id, {
        chain: 'BTC',
        txid: 'tx-b',
        vout: 0,
        amount: '0.2',
        confirmations: 0,
      }),
    ]);
    const lockQueries = db.log.filter((e) =>
      e.text.includes('SELECT * FROM invoices WHERE id = $1 FOR UPDATE')
    );
    expect(lockQueries.length).toBeGreaterThanOrEqual(2);
    expect(db.paymentRows()).toHaveLength(2);
    expect((await invoices.getById(inv.id))!.status).toBe('PARTIALLY_PAID');
  });

  it('eine TXO kann nicht zwei Invoices gutgeschrieben werden', async () => {
    const { db, invoices, payments } = setup();
    const inv1 = await seedInvoice(db, invoices);
    const inv2 = await seedInvoice(db, invoices, { orderRef: 'order-2' });
    const pay = { chain: 'BTC' as const, txid: 'tx-shared', vout: 0, amount: '1.0', confirmations: 0 };
    await payments.applyIncomingPayment(inv1.id, pay);
    await expect(payments.applyIncomingPayment(inv2.id, pay)).rejects.toMatchObject({
      code: 'TXO_ALREADY_USED',
    });
    expect(db.paymentRows()).toHaveLength(1);
  });

  it('verschiedene vouts derselben txid sind separate Zahlungen', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-multi',
      vout: 0,
      amount: '5.0',
      confirmations: 0,
    });
    await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-multi',
      vout: 1,
      amount: '5.0',
      confirmations: 0,
    });
    expect(db.paymentRows()).toHaveLength(2);
    expect((await invoices.getById(inv.id))!.status).toBe('PAID');
  });

  it('wirft bei unbekannter Invoice (INVOICE_NOT_FOUND)', async () => {
    const { payments } = setup();
    await expect(
      payments.applyIncomingPayment('00000000-0000-0000-0000-000000000009', {
        chain: 'BTC',
        txid: 'tx-x',
        vout: 0,
        amount: '1',
        confirmations: 0,
      })
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('terminaler Invoice-Status (EXPIRED) bleibt unverändert, Zahlung wird dokumentiert', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    await invoices.transition(inv.id, 'EXPIRED');
    const res = await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-late',
      vout: 0,
      amount: '10.0',
      confirmations: 5,
    });
    expect(res.applied).toBe(true);
    expect((await invoices.getById(inv.id))!.status).toBe('EXPIRED');
    expect(db.paymentRows()).toHaveLength(1);
  });

  it('recomputeInvoiceStatus ist idempotent und ohne Zahlung -> keine Änderung', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    const r1 = await payments.recomputeInvoiceStatus(inv.id);
    const r2 = await payments.recomputeInvoiceStatus(inv.id);
    expect(r1.status).toBe('AWAITING_PAYMENT');
    expect(r2.status).toBe('AWAITING_PAYMENT');
    expect(db.invoiceRow(inv.id)!.version).toBe(0); // keine unnötigen Updates
  });

  it('läuft in EINER Transaktion mit Row-Lock (BEGIN ... FOR UPDATE ... COMMIT)', async () => {
    const { db, invoices, payments } = setup();
    const inv = await seedInvoice(db, invoices);
    await payments.applyIncomingPayment(inv.id, {
      chain: 'BTC',
      txid: 'tx-tx',
      vout: 0,
      amount: '1',
      confirmations: 0,
    });
    const texts = db.log.map((e) => e.text);
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
  });
});

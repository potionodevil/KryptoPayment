import { describe, expect, it } from 'vitest';
import { createInvoiceService, type QuoteProvider } from '../src/core/invoiceService.js';
import { GatewayError, StateTransitionError } from '../src/core/stateMachine.js';
import type { CreateInvoiceRequest } from '../src/types/index.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';

const quote: QuoteProvider = async () => ({
  amountCrypto: '1.50000000',
  address: 'addr-test-1',
});

function makeReq(overrides: Partial<CreateInvoiceRequest> = {}): CreateInvoiceRequest {
  return {
    orderRef: 'order-1',
    amountFiat: '100.00',
    fiatCurrency: 'EUR',
    cryptoCurrency: 'BTC',
    chain: 'BTC',
    ...overrides,
  };
}

function setup() {
  const db = new FakeDb();
  const service = createInvoiceService({
    txRunner: fakeTxRunner(db),
    quote,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ttlSec: 900,
  });
  return { db, service };
}

describe('core/invoiceService', () => {
  it('createInvoice legt eine Invoice in AWAITING_PAYMENT an', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    expect(inv.status).toBe('AWAITING_PAYMENT');
    expect(inv.amountCrypto).toBe('1.50000000');
    expect(inv.address).toBe('addr-test-1');
    expect(inv.version).toBe(0);
    expect(inv.expiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(inv.merchantId).toBe('merchant-1');
    expect(db.invoices.size).toBe(1);
  });

  it('createInvoice ist idempotent bei gleicher (merchant_id, order_ref)', async () => {
    const { db, service } = setup();
    const a = await service.createInvoice('merchant-1', makeReq());
    const b = await service.createInvoice('merchant-1', makeReq());
    expect(b.id).toBe(a.id);
    expect(db.invoices.size).toBe(1);
  });

  it('createInvoice lehnt gleiche order_ref mit abweichendem Betrag ab', async () => {
    const { service } = setup();
    await service.createInvoice('merchant-1', makeReq());
    await expect(
      service.createInvoice('merchant-1', makeReq({ amountFiat: '999.00' }))
    ).rejects.toMatchObject({ code: 'ORDER_REF_CONFLICT' });
  });

  it('createInvoice validiert Eingaben (negativer Betrag, ungültige Chain)', async () => {
    const { service } = setup();
    await expect(
      service.createInvoice('m', makeReq({ amountFiat: '-1' }))
    ).rejects.toBeInstanceOf(GatewayError);
    await expect(
      service.createInvoice('m', makeReq({ chain: 'DOGE' as never }))
    ).rejects.toBeInstanceOf(GatewayError);
  });

  it('getById liefert die Invoice oder null', async () => {
    const { service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    expect((await service.getById(inv.id))?.orderRef).toBe('order-1');
    expect(await service.getById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('transition führt gültige Übergänge aus und inkrementiert version', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    const paid = await service.transition(inv.id, 'PAID');
    expect(paid.status).toBe('PAID');
    expect(paid.version).toBe(1);
    expect(paid.paidAt).not.toBeNull();
    const confirmed = await service.transition(inv.id, 'CONFIRMED');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.version).toBe(2);
    expect(confirmed.confirmedAt).not.toBeNull();
    // Row-Lock musste angefordert werden (Race-Condition-Härte)
    const lockQuery = db.log.find((e) => e.text.includes('SELECT * FROM invoices WHERE id = $1 FOR UPDATE'));
    expect(lockQuery).toBeDefined();
  });

  it('transition verwirft ungültige Übergänge (State-Machine)', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    await service.transition(inv.id, 'PAID');
    await expect(service.transition(inv.id, 'EXPIRED')).rejects.toBeInstanceOf(StateTransitionError);
    expect(db.invoiceRow(inv.id)!.status).toBe('PAID');
    expect(db.invoiceRow(inv.id)!.version).toBe(1);
  });

  it('transition bei unbekannter Invoice -> INVOICE_NOT_FOUND', async () => {
    const { service } = setup();
    await expect(
      service.transition('00000000-0000-0000-0000-000000000001', 'PAID')
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('Optimistic Locking: parallele Änderung -> CONCURRENT_MODIFICATION', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    // Simuliere konkurrierenden Writer zwischen SELECT und UPDATE
    db.hooks.before = (text, params) => {
      if (text.startsWith('UPDATE invoices SET status')) {
        db.invoiceRow(String(params[0]))!.version += 1;
      }
    };
    await expect(service.transition(inv.id, 'PAID')).rejects.toMatchObject({
      code: 'CONCURRENT_MODIFICATION',
    });
    db.hooks.before = undefined;
  });

  it('läuft in EINER Transaktion (BEGIN/COMMIT) und nutzt bei explizitem Client keine eigene', async () => {
    const { db, service } = setup();
    await service.createInvoice('merchant-1', makeReq());
    const texts = db.log.map((e) => e.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts).toContain('COMMIT');

    const before = db.log.length;
    const inv = await service.createInvoice('merchant-2', makeReq({ orderRef: 'o-2' }), db);
    await service.transition(inv.id, 'PAID', db); // expliziter Client -> kein eigenes BEGIN
    const newEntries = db.log.slice(before).map((e) => e.text);
    expect(newEntries).not.toContain('BEGIN');
  });

  it('SQL ist parametrisiert — keine Werte im Statement-Text', async () => {
    const { db, service } = setup();
    await service.createInvoice('merchant-secret-id', makeReq({ orderRef: 'secret-order' }));
    for (const entry of db.log) {
      expect(entry.text).not.toContain('secret-order');
      expect(entry.text).not.toContain('merchant-secret-id');
    }
  });
});

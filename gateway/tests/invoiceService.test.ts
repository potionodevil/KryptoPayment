import { describe, expect, it } from 'vitest';
import {
  createInvoiceService,
  SQL_INSERT_INVOICE,
  type QuoteProvider,
} from '../src/core/invoiceService.js';
import { GatewayError, StateTransitionError } from '../src/core/stateMachine.js';
import type { CreateInvoiceRequest } from '../src/types/index.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';

const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ETH_ADDR = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

/** Platzhalter-Kurs 1:1 — der Krypto-Betrag kommt als exakter String. */
const quote: QuoteProvider = async (req) => ({ amountCrypto: req.amountFiat });

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
  const service = createInvoiceService({
    txRunner: fakeTxRunner(db),
    quote,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    ttlSec: 900,
  });
  return { db, service };
}

describe('core/invoiceService — Forwarding (Zieladresse aus Request, non-custodial)', () => {
  it('createInvoice legt AWAITING_PAYMENT an und übernimmt req.targetAddress als Adresse', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq({ amountFiat: '1.50000000' }));
    expect(inv.status).toBe('AWAITING_PAYMENT');
    expect(inv.address).toBe(BTC_ADDR); // statisch aus Request — NICHT generiert
    expect(inv.amountCrypto).toBe('1.50000000');
    expect(inv.version).toBe(0);
    expect(inv.expiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(inv.merchantId).toBe('merchant-1');
    expect(db.invoices.size).toBe(1);
  });

  it('validiert das Adressformat pro Chain (ungültig -> INVALID_ADDRESS)', async () => {
    const { service } = setup();
    // BTC-Adresse auf ETH-Invoice -> ungültig
    await expect(
      service.createInvoice('m', makeReq({ chain: 'ETH', cryptoCurrency: 'ETH', targetAddress: BTC_ADDR }))
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    // kaputtes ETH-Format
    await expect(
      service.createInvoice('m', makeReq({ chain: 'ETH', cryptoCurrency: 'ETH', targetAddress: '0x123' }))
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    // leere Adresse -> Schema-Fehler
    await expect(
      service.createInvoice('m', makeReq({ targetAddress: '' }))
    ).rejects.toBeInstanceOf(GatewayError);
    // gültige ETH-Adresse geht durch
    const inv = await service.createInvoice(
      'm',
      makeReq({ orderRef: 'o-eth', chain: 'ETH', cryptoCurrency: 'ETH', targetAddress: ETH_ADDR })
    );
    expect(inv.address).toBe(ETH_ADDR);
  });

  it('setzt amount_crypto exakt als String übernommen (kein Float)', async () => {
    const { service } = setup();
    const inv = await service.createInvoice(
      'merchant-1',
      makeReq({ amountFiat: '1.234567890123456789' })
    );
    expect(inv.amountCrypto).toBe('1.234567890123456789');
  });

  // -------------------------------------------------------------------------
  // Betrags-Eindeutigkeit unter AKTIVEN Invoices derselben Chain/Currency
  // -------------------------------------------------------------------------

  it('nudged kollidierende Beträge um die kleinste Einheit (BTC: 1 sat)', async () => {
    const { service } = setup();
    const a = await service.createInvoice('m', makeReq({ orderRef: 'a', amountFiat: '10' }));
    const b = await service.createInvoice('m', makeReq({ orderRef: 'b', amountFiat: '10' }));
    expect(a.amountCrypto).toBe('10');
    expect(b.amountCrypto).toBe('10.00000001'); // + 0.00000001 BTC
  });

  it('Nudge häuft sich bei Mehrfachkollision (10, 10.00000001, 10.00000002)', async () => {
    const { service } = setup();
    const amounts: Array<string | null> = [];
    for (const ref of ['a', 'b', 'c']) {
      const inv = await service.createInvoice('m', makeReq({ orderRef: ref, amountFiat: '10' }));
      amounts.push(inv.amountCrypto);
    }
    expect(amounts).toEqual(['10', '10.00000001', '10.00000002']);
  });

  it('Eindeutigkeit gilt nur unter AKTIVEN Invoices — PAID blockiert Beträge nicht', async () => {
    const { service } = setup();
    const a = await service.createInvoice('m', makeReq({ orderRef: 'a', amountFiat: '10' }));
    await service.transition(a.id, 'PAID');
    const b = await service.createInvoice('m', makeReq({ orderRef: 'b', amountFiat: '10' }));
    expect(b.amountCrypto).toBe('10'); // keine Kollision mehr
  });

  it('Eindeutigkeit ist pro Chain+Currency — gleicher Betrag auf ETH bleibt unverändert', async () => {
    const { service } = setup();
    const a = await service.createInvoice('m', makeReq({ orderRef: 'a', amountFiat: '10' }));
    const b = await service.createInvoice(
      'm',
      makeReq({ orderRef: 'b', amountFiat: '10', chain: 'ETH', cryptoCurrency: 'ETH', targetAddress: ETH_ADDR })
    );
    expect(a.amountCrypto).toBe('10');
    expect(b.amountCrypto).toBe('10');
  });

  it('race: zwei parallele createInvoice mit gleichem Betrag bleiben eindeutig', async () => {
    const { db, service } = setup();
    const [a, b] = await Promise.all([
      service.createInvoice('m', makeReq({ orderRef: 'race-1', amountFiat: '10' })),
      service.createInvoice('m', makeReq({ orderRef: 'race-2', amountFiat: '10' })),
    ]);
    expect(new Set([a.amountCrypto, b.amountCrypto])).toEqual(new Set(['10', '10.00000001']));
    expect(db.invoices.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Idempotenz, State-Machine, Locking
  // -------------------------------------------------------------------------

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
    const lockQuery = db.log.find((e) =>
      e.text.includes('SELECT * FROM invoices WHERE id = $1 FOR UPDATE')
    );
    expect(lockQuery).toBeDefined();
  });

  it('transition verwirft ungültige Übergänge (State-Machine)', async () => {
    const { db, service } = setup();
    const inv = await service.createInvoice('merchant-1', makeReq());
    await service.transition(inv.id, 'PAID');
    await expect(service.transition(inv.id, 'EXPIRED')).rejects.toBeInstanceOf(
      StateTransitionError
    );
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
      expect(entry.text).not.toContain(BTC_ADDR);
    }
  });

  it('Test-Helper-Direktinserts werden vom Service korrekt gelesen', async () => {
    const { db, service } = setup();
    await db.query(SQL_INSERT_INVOICE, [
      'm',
      'raw-1',
      '5.00',
      'EUR',
      '0.5',
      'BTC',
      'BTC',
      BTC_ADDR,
      'AWAITING_PAYMENT',
      '2026-01-01T00:15:00.000Z',
    ]);
    const inv = await service.getById([...db.invoices.values()][0].id);
    expect(inv?.amountCrypto).toBe('0.5');
  });
});

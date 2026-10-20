import { describe, expect, it } from 'vitest';
import {
  assertValidAddress,
  createWatchTargetService,
  isValidAddress,
} from '../src/core/addressProvider.js';
import { SQL_INSERT_INVOICE } from '../src/core/invoiceService.js';
import { GatewayError } from '../src/core/stateMachine.js';
import type { Chain } from '../src/types/index.js';
import { FakeDb, fakeTxRunner } from './helpers/fakeDb.js';

const BTC_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BTC_BASE58 = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const LTC_BECH32 = 'ltc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const LTC_BASE58 = 'LMf9yPPm9wxDxGYqFQ6y4LZqH8YfFvBn';
const ETH_ADDR = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const SOL_ADDR = 'So11111111111111111111111111111111111111112';
// XMR: base58, 95 Zeichen (Standard-/Subadresse)
const XMR_ADDR = '4' + 'aBcDeFgHjKmNpQrStVwXyZ23456789'.repeat(3) + 'aBcD';

describe('core/addressProvider — Adressformat-Validierung pro Chain (non-custodial)', () => {
  it('akzeptiert gültige BTC-Adressen (bech32 und base58)', () => {
    expect(isValidAddress('BTC', BTC_BECH32)).toBe(true);
    expect(isValidAddress('BTC', BTC_BASE58)).toBe(true);
    expect(isValidAddress('BTC', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ')).toBe(true);
  });

  it('akzeptiert gültige LTC-, ETH-, SOL- und XMR-Adressen', () => {
    expect(isValidAddress('LTC', LTC_BECH32)).toBe(true);
    expect(isValidAddress('LTC', LTC_BASE58)).toBe(true);
    expect(isValidAddress('ETH', ETH_ADDR)).toBe(true);
    expect(isValidAddress('SOL', SOL_ADDR)).toBe(true);
    expect(isValidAddress('XMR', XMR_ADDR)).toBe(true);
    expect(XMR_ADDR).toHaveLength(95);
  });

  it('lehnt ungültiges Adressformat ab', () => {
    expect(isValidAddress('BTC', 'bc1q')).toBe(false); // zu kurz
    expect(isValidAddress('BTC', 'not-an-address')).toBe(false);
    expect(isValidAddress('BTC', '')).toBe(false);
    expect(isValidAddress('ETH', '0x123')).toBe(false); // zu kurz
    expect(isValidAddress('ETH', '742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false); // ohne 0x
    expect(isValidAddress('ETH', '0xZZ2d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false); // nicht hex
    expect(isValidAddress('SOL', 'So1111111111111111111111111111111111111111I')).toBe(false); // 'I' nicht base58
    expect(isValidAddress('XMR', '4' + 'a'.repeat(50))).toBe(false); // falsche Länge
  });

  it('eine Adressform der falschen Chain wird abgelehnt (BTC-Adresse auf ETH-Invoice)', () => {
    expect(isValidAddress('ETH', BTC_BECH32)).toBe(false);
    expect(isValidAddress('BTC', ETH_ADDR)).toBe(false);
    expect(isValidAddress('XMR', SOL_ADDR)).toBe(false);
  });

  it('assertValidAddress wirft GatewayError(INVALID_ADDRESS) mit klarem Hinweis', () => {
    expect(() => assertValidAddress('BTC', BTC_BECH32)).not.toThrow();
    try {
      assertValidAddress('ETH', BTC_BECH32);
      expect.unreachable('assertValidAddress muss bei ungültigem Format werfen');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code).toBe('INVALID_ADDRESS');
      expect((err as GatewayError).status).toBe(400);
      expect((err as GatewayError).message).toMatch(/ETH/);
    }
  });
});

// ---------------------------------------------------------------------------
// Watch-Targets: welche Adressen muss der Poller monitoren?
// Quelle sind die Invoices (req.targetAddress), NICHT eine Env-Config.
// ---------------------------------------------------------------------------

async function seedInvoice(
  db: FakeDb,
  opts: {
    orderRef: string;
    chain: Chain;
    currency: string;
    address: string;
    status?: string;
    amount?: string;
  }
): Promise<void> {
  await db.query(SQL_INSERT_INVOICE, [
    'merchant-1',
    opts.orderRef,
    '100.00',
    'EUR',
    opts.amount ?? '1.00',
    opts.currency,
    opts.chain,
    opts.address,
    opts.status ?? 'AWAITING_PAYMENT',
    '2026-01-01T00:15:00.000Z',
  ]);
}

describe('core/addressProvider.listWatchTargets — distinct Watch-Targets aktiver Invoices', () => {
  it('liefert distinct (chain, currency, address) aller AKTIVEN Invoices', async () => {
    const db = new FakeDb();
    const service = createWatchTargetService({ txRunner: fakeTxRunner(db) });
    await seedInvoice(db, { orderRef: 'o-1', chain: 'BTC', currency: 'BTC', address: BTC_BECH32 });
    await seedInvoice(db, { orderRef: 'o-2', chain: 'BTC', currency: 'BTC', address: BTC_BECH32 }); // Dublette
    await seedInvoice(db, {
      orderRef: 'o-3',
      chain: 'ETH',
      currency: 'USDT',
      address: ETH_ADDR,
      status: 'PARTIALLY_PAID',
    });

    const targets = await service.listWatchTargets();
    expect(targets).toHaveLength(2);
    expect(targets).toContainEqual({ chain: 'BTC', currency: 'BTC', address: BTC_BECH32 });
    expect(targets).toContainEqual({ chain: 'ETH', currency: 'USDT', address: ETH_ADDR });
  });

  it('behält PAID für wachsende Bestätigungen, schließt nur terminale Invoices aus', async () => {
    const db = new FakeDb();
    const service = createWatchTargetService({ txRunner: fakeTxRunner(db) });
    await seedInvoice(db, { orderRef: 'a', chain: 'BTC', currency: 'BTC', address: BTC_BECH32, status: 'PAID' });
    await seedInvoice(db, { orderRef: 'b', chain: 'BTC', currency: 'BTC', address: BTC_BASE58, status: 'CONFIRMED' });
    await seedInvoice(db, { orderRef: 'c', chain: 'BTC', currency: 'BTC', address: BTC_BASE58, status: 'EXPIRED' });
    await seedInvoice(db, { orderRef: 'd', chain: 'BTC', currency: 'BTC', address: BTC_BASE58, status: 'CANCELLED' });
    await seedInvoice(db, { orderRef: 'e', chain: 'BTC', currency: 'BTC', address: LTC_BECH32, status: 'CREATED' });

    const targets = await service.listWatchTargets();
    // PAID (BTC_BECH32) + CREATED (LTC_BECH32) bleiben; CONFIRMED/EXPIRED/CANCELLED (BTC_BASE58) raus.
    expect(targets).toContainEqual({ chain: 'BTC', currency: 'BTC', address: BTC_BECH32 });
    expect(targets).toContainEqual({ chain: 'BTC', currency: 'BTC', address: LTC_BECH32 });
    expect(targets).toHaveLength(2);
  });

  it('gleiche Adresse mit verschiedenen Currencies ergibt eigene Watch-Targets', async () => {
    const db = new FakeDb();
    const service = createWatchTargetService({ txRunner: fakeTxRunner(db) });
    await seedInvoice(db, { orderRef: 't-1', chain: 'ETH', currency: 'ETH', address: ETH_ADDR });
    await seedInvoice(db, { orderRef: 't-2', chain: 'ETH', currency: 'USDT', address: ETH_ADDR });

    const targets = await service.listWatchTargets();
    expect(targets).toHaveLength(2);
  });

  it('läuft in einer Transaktion und bleibt bei leerer DB leer', async () => {
    const db = new FakeDb();
    const service = createWatchTargetService({ txRunner: fakeTxRunner(db) });
    expect(await service.listWatchTargets()).toEqual([]);
    const texts = db.log.map((e) => e.text);
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
  });
});

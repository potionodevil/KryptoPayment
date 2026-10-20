import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  findTransitionPath,
  GatewayError,
  isTerminal,
  StateTransitionError,
} from '../src/core/stateMachine.js';
import { INVOICE_TRANSITIONS, type InvoiceStatus } from '../src/types/index.js';

describe('core/stateMachine', () => {
  it('erlaubt die definierten Übergänge aus INVOICE_TRANSITIONS', () => {
    expect(canTransition('CREATED', 'AWAITING_PAYMENT')).toBe(true);
    expect(canTransition('AWAITING_PAYMENT', 'PARTIALLY_PAID')).toBe(true);
    expect(canTransition('AWAITING_PAYMENT', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'CONFIRMED')).toBe(true);
  });

  it('verwehrt Übergänge, die nicht in INVOICE_TRANSITIONS stehen', () => {
    expect(canTransition('CREATED', 'PAID')).toBe(false);
    expect(canTransition('AWAITING_PAYMENT', 'CONFIRMED')).toBe(false);
    expect(canTransition('CONFIRMED', 'PAID')).toBe(false);
    expect(canTransition('EXPIRED', 'AWAITING_PAYMENT')).toBe(false);
  });

  it('definiert für jeden Status-Terminal keine ausgehenden Übergänge', () => {
    const terminal: InvoiceStatus[] = ['CONFIRMED', 'EXPIRED', 'CANCELLED'];
    for (const s of terminal) {
      expect(INVOICE_TRANSITIONS[s]).toHaveLength(0);
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal('PAID')).toBe(false);
  });

  it('assertTransition wirft StateTransitionError mit code INVALID_STATE_TRANSITION', () => {
    expect(() => assertTransition('PAID', 'EXPIRED')).toThrowError(StateTransitionError);
    try {
      assertTransition('PAID', 'EXPIRED');
    } catch (e) {
      const err = e as StateTransitionError;
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.message).toContain('PAID');
      expect(err.message).toContain('EXPIRED');
    }
  });

  it('findTransitionPath liefert den kürzesten gültigen Pfad', () => {
    expect(findTransitionPath('AWAITING_PAYMENT', 'CONFIRMED')).toEqual(['PAID', 'CONFIRMED']);
    expect(findTransitionPath('CREATED', 'CONFIRMED')).toEqual([
      'AWAITING_PAYMENT',
      'PAID',
      'CONFIRMED',
    ]);
    expect(findTransitionPath('PARTIALLY_PAID', 'CONFIRMED')).toEqual(['PAID', 'CONFIRMED']);
  });

  it('findTransitionPath liefert null bei unerreichbarem Ziel und [] bei gleichem Status', () => {
    expect(findTransitionPath('CONFIRMED', 'PAID')).toBeNull();
    expect(findTransitionPath('EXPIRED', 'PAID')).toBeNull();
    expect(findTransitionPath('PAID', 'PAID')).toEqual([]);
  });
});

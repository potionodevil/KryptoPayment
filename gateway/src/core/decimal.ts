/**
 * Exakte Dezimal-Arithmetik auf Strings (NUMERIC — kein Float-Geld!).
 * Alle Beträge werden als Strings geführt; gerechnet wird über BigInt-Skalierung.
 */
import type { Chain } from '../types/index.js';

function parseDec(s: string): { neg: boolean; int: string; frac: string } {
  const t = String(s).trim();
  const neg = t.startsWith('-');
  const body = neg ? t.slice(1) : t;
  const dot = body.indexOf('.');
  const int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  return { neg, int: int.length > 0 ? int : '0', frac };
}

function scaleOf(s: string): number {
  return parseDec(s).frac.length;
}

function toScaled(s: string, scale: number): bigint {
  const d = parseDec(s);
  const frac = (d.frac + '0'.repeat(scale)).slice(0, scale);
  const v = BigInt(d.int) * 10n ** BigInt(scale) + BigInt(frac === '' ? '0' : frac);
  return d.neg ? -v : v;
}

function fromScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  if (scale === 0) return (neg ? '-' : '') + abs.toString();
  const s = abs.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale);
  return (neg ? '-' : '') + `${int}.${frac}`;
}

/** Exakte Addition zweier Dezimal-Strings. */
export function addDecimalStrings(a: string, b: string): string {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return fromScaled(toScaled(a, scale) + toScaled(b, scale), scale);
}

/** Exakter Vergleich: -1 | 0 | 1. */
export function compareDecimalStrings(a: string, b: string): number {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const diff = toScaled(a, scale) - toScaled(b, scale);
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

/**
 * Gleichheit in der kleinsten Einheit: '10' === '10.00000000'.
 * Grundlage des exakten Betrags-Matchings im paymentMatcher.
 */
export function amountsEqual(a: string, b: string): boolean {
  return compareDecimalStrings(a, b) === 0;
}

/** Prüft positives/nicht-negatives Dezimalformat (max. 18 Nachkommastellen). */
export function isDecimalString(s: string): boolean {
  return /^\d+(\.\d{1,18})?$/.test(String(s).trim());
}

/**
 * Kleinste handelbare Einheit pro Chain (1 sat, 1 wei, 1 lamport, 1 piconero).
 * Wird beim Betrags-Nudge addiert, damit aktive Invoices eindeutige Beträge haben.
 */
export const CHAIN_MIN_UNIT: Record<Chain, string> = {
  BTC: '0.00000001', // 1 satoshi
  LTC: '0.00000001', // 1 litoshi
  ETH: '0.000000000000000001', // 1 wei
  SOL: '0.000000001', // 1 lamport
  XMR: '0.000000000001', // 1 piconero
};

/** Addiert `times`-mal die kleinste Einheit der Chain (Betrags-Nudge). */
export function addMinUnit(amount: string, chain: Chain, times = 1): string {
  let result = String(amount);
  for (let i = 0; i < times; i++) {
    result = addDecimalStrings(result, CHAIN_MIN_UNIT[chain]);
  }
  return result;
}

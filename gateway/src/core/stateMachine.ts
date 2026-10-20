/**
 * Validierte Invoice-State-Machine auf Basis von INVOICE_TRANSITIONS.
 * Alle Status-Änderungen MÜSSEN durch assertTransition/findTransitionPath laufen.
 */
import { INVOICE_TRANSITIONS, type InvoiceStatus } from '../types/index.js';

/** Basisklasse für alle Gateway-Fehler (wird von der API-Schicht auf HTTP gemappt). */
export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class StateTransitionError extends GatewayError {
  constructor(from: InvoiceStatus, to: InvoiceStatus) {
    super(
      'INVALID_STATE_TRANSITION',
      `Ungültiger Status-Übergang: ${from} -> ${to}`,
      409
    );
    this.name = 'StateTransitionError';
  }
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export function isTerminal(status: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[status] ?? []).length === 0;
}

export function allowedTransitions(from: InvoiceStatus): readonly InvoiceStatus[] {
  return INVOICE_TRANSITIONS[from] ?? [];
}

/**
 * Kürzester gültiger Übergangspfad (BFS) von `from` nach `to`.
 * Liefert [] wenn from === to, null wenn unerreichbar (z.B. aus Terminalstatus).
 */
export function findTransitionPath(
  from: InvoiceStatus,
  to: InvoiceStatus
): InvoiceStatus[] | null {
  if (from === to) return [];
  const queue: Array<{ status: InvoiceStatus; path: InvoiceStatus[] }> = [
    { status: from, path: [] },
  ];
  const seen = new Set<InvoiceStatus>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of INVOICE_TRANSITIONS[current.status] ?? []) {
      if (seen.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

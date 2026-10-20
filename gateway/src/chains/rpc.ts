/**
 * Geteilte RPC-Helfer: JSON-RPC-2.0-Transport über injizierbares fetch
 * sowie exakte Betragsformatierung (BigInt-basiert, KEIN Float-Geld).
 */
import type {
  FetchLike,
  JsonRpcResponseBody,
  RequestInitLike,
  RpcAuth,
} from './types.js';

/** Fehler bei RPC-Kommunikation oder unerwarteten RPC-Antworten. */
export class RpcError extends Error {
  /** JSON-RPC-Fehlercode (falls vorhanden). */
  rpcCode?: number;

  constructor(message: string, rpcCode?: number) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = rpcCode;
  }
}

let rpcIdCounter = 1;

/** Basic-Auth-Header aus Zugangsdaten. */
export function buildAuthHeader(auth: RpcAuth): Record<string, string> {
  const token = Buffer.from(`${auth.user}:${auth.pass}`, 'utf8').toString('base64');
  return { authorization: `Basic ${token}` };
}

/**
 * Führt einen JSON-RPC-2.0-Call aus.
 * Wirft RpcError bei HTTP-Fehlern, kaputtem JSON, error-Feldern
 * oder Antworten ohne result.
 */
export async function jsonRpcCall(
  url: string,
  method: string,
  params: unknown[] | Record<string, unknown>,
  opts: { fetchImpl: FetchLike; auth?: RpcAuth; id?: number }
): Promise<unknown> {
  const id = opts.id ?? rpcIdCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.auth ? buildAuthHeader(opts.auth) : {}),
  };
  const init: RequestInitLike = { method: 'POST', headers, body };

  let res;
  try {
    res = await opts.fetchImpl(url, init);
  } catch (err) {
    throw new RpcError(`RPC-Netzwerkfehler bei ${method}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new RpcError(`RPC-HTTP-Fehler ${res.status} bei ${method}`);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new RpcError(`Ungültige JSON-Antwort bei ${method}`);
  }

  const bodyObj = parsed as JsonRpcResponseBody;
  if (bodyObj && typeof bodyObj === 'object' && bodyObj.error) {
    throw new RpcError(
      `${method}: ${bodyObj.error.message ?? 'unbekannter RPC-Fehler'}`,
      typeof bodyObj.error.code === 'number' ? bodyObj.error.code : undefined
    );
  }
  if (!bodyObj || typeof bodyObj !== 'object' || !('result' in bodyObj)) {
    throw new RpcError(`Antwort ohne result bei ${method}`);
  }
  return bodyObj.result;
}

/**
 * Formatierung kleinster Einheiten als exakter Dezimal-String.
 * BigInt-Rechnung — keine Float-Rundungsartefakte.
 * Bsp.: formatUnits(123456789n, 8) === '1.23456789'
 */
export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Ungültige Dezimalstellen: ${decimals}`);
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (decimals === 0) return (negative ? '-' : '') + abs.toString();
  const padded = abs.toString().padStart(decimals + 1, '0');
  const intPart = padded.slice(0, -decimals);
  const fracPart = padded.slice(-decimals).replace(/0+$/, '');
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}

/**
 * Parst unbekannte Ganzzahl-Werte (bigint | int-Zahl | Dezimal-/Hex-String)
 * defensiv in ein BigInt. Wirft bei allem anderen.
 */
export function parseBigIntish(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`Keine Ganzzahl: ${value}`);
    if (!Number.isSafeInteger(value)) throw new Error(`Zahl außerhalb Safe-Integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^[+-]?\d+$/.test(s)) return BigInt(s);
    throw new Error(`Keine Ganzzahl: '${value}'`);
  }
  throw new Error(`Kein unterstützter Zahlenwert: ${typeof value}`);
}

/**
 * Parst einen Betrag in Dezimal-Schreibweise (String ODER Float)
 * in kleinste Einheiten (z.B. BTC-Float -> Satoshi).
 * Überschüssige Nachkommastellen werden abgeschnitten.
 */
export function parseDecimalToUnits(value: string | number, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Ungültige Dezimalstellen: ${decimals}`);
  }
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Keine gültige Zahl: ${value}`);
    // toFixed behandelt Exponentialschreibweise (z.B. 1e-8) korrekt
    s = value.toFixed(decimals);
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    throw new Error(`Kein unterstützter Betragstyp: ${typeof value}`);
  }

  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Ungültiger Dezimalbetrag: '${value}'`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2];
  const fracRaw = m[3] ?? '';
  const fracPart = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  return sign * BigInt(intPart + fracPart);
}

/** Defensiver Number-Coerces: liefert number oder undefined. */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

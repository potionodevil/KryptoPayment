/**
 * Test-Helper: injizierbarer fetch-Mock für JSON-RPC-Endpunkte.
 * In den Tests laufen KEINE echten Netz-Calls.
 */
import type {
  FetchLike,
  HttpResponseLike,
  RequestInitLike,
} from '../../src/chains/types.js';

export interface RecordedRpcCall {
  url: string;
  method: string;
  params: unknown;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Formatiert eine normale JSON-RPC-Antwort. */
export function jsonResponse(payload: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

type ResponderFn = (method: string, params: unknown) => unknown;

/**
 * Baut einen fetch-Mock, der JSON-RPC-Requests entgegennimmt und
 * per Responder (Methode -> Ergebnis oder Funktion) beantwortet.
 */
export function mockRpcFetch(
  responder: ResponderFn | Record<string, unknown | ((params: unknown) => unknown)>
): { fetchImpl: FetchLike; calls: RecordedRpcCall[] } {
  const calls: RecordedRpcCall[] = [];
  const fetchImpl: FetchLike = async (url: string, init?: RequestInitLike) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    const call: RecordedRpcCall = {
      url,
      method: String(body.method ?? ''),
      params: body.params,
      headers: init?.headers ?? {},
      body,
    };
    calls.push(call);

    let result: unknown;
    if (typeof responder === 'function') {
      result = (responder as ResponderFn)(call.method, call.params);
    } else {
      if (!(call.method in responder)) {
        throw new Error(`Unerwartete RPC-Methode im Test: ${call.method}`);
      }
      const entry = responder[call.method];
      result = typeof entry === 'function' ? (entry as (p: unknown) => unknown)(call.params) : entry;
    }
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result });
  };
  return { fetchImpl, calls };
}

/** Roher fetch-Mock für Fehlerfälle (HTTP-Fehler, kaputte JSON, ...). */
export function mockRawFetch(
  handler: (call: RecordedRpcCall) => HttpResponseLike
): { fetchImpl: FetchLike; calls: RecordedRpcCall[] } {
  const calls: RecordedRpcCall[] = [];
  const fetchImpl: FetchLike = async (url: string, init?: RequestInitLike) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    const call: RecordedRpcCall = {
      url,
      method: String(body.method ?? ''),
      params: body.params,
      headers: init?.headers ?? {},
      body,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

/**
 * HTTP-Testhelfer: startet die Express-App auf einem Ephemeral-Port und
 * erzeugt korrekt signierte HMAC-Requests (wie das WordPress-Plugin).
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import { signRequest } from '../../src/security/hmac.js';

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(app: Express): Promise<TestServer> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('kein Port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface SignedRequestOptions {
  secret: string;
  keyId: string;
  method: string;
  path: string;
  body?: string;
  nonce?: string;
  timestamp?: string;
  /** Überschreibt die Signatur (für Tamper-Tests). */
  signature?: string;
}

let nonceCounter = 0;

export function signedHeaders(opts: SignedRequestOptions): Record<string, string> {
  const body = opts.body ?? '';
  const nonce = opts.nonce ?? `nonce-${++nonceCounter}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    opts.signature ??
    signRequest(opts.secret, {
      method: opts.method,
      path: opts.path,
      timestamp,
      nonce,
      body,
    });
  const headers: Record<string, string> = {
    'x-kg-key-id': opts.keyId,
    'x-kg-timestamp': timestamp,
    'x-kg-nonce': nonce,
    'x-kg-signature': signature,
    'content-type': 'application/json',
  };
  return headers;
}

export async function api(
  baseUrl: string,
  opts: SignedRequestOptions & { expectStatus?: number }
): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + opts.path, {
    method: opts.method,
    headers: signedHeaders(opts),
    body: opts.method === 'GET' || opts.method === 'HEAD' ? undefined : opts.body,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

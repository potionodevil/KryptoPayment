/**
 * HMAC-SHA256-Signaturen für Requests/Responses + Secret-Verschlüsselung.
 *
 * Signatur = HMAC-SHA256(secret, METHOD + path + timestamp + nonce + sha256(body))
 * (exakt die Concatenation aus dem API-Vertrag, ohne Trennzeichen).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Header-Namen für signierte Requests (siehe types/index.ts AuthHeaders). */
export const AUTH_HEADERS = {
  keyId: 'x-kg-key-id',
  timestamp: 'x-kg-timestamp',
  nonce: 'x-kg-nonce',
  signature: 'x-kg-signature',
} as const;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** sha256 des (rohen) Request-Bodys — bei leerem Body sha256(''). */
export function bodyHash(body: string | Buffer | null | undefined): string {
  if (body === null || body === undefined) return sha256Hex('');
  return sha256Hex(body);
}

export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHashHex: string
): string {
  return `${method.toUpperCase()}${path}${timestamp}${nonce}${bodyHashHex}`;
}

export interface SignRequestInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer | null | undefined;
}

export function signRequest(secret: string, input: SignRequestInput): string {
  return hmacSha256Hex(
    secret,
    canonicalString(
      input.method,
      input.path,
      input.timestamp,
      input.nonce,
      bodyHash(input.body)
    )
  );
}

/** Signiert eine Response-Payload (z.B. CreateInvoiceResponse) für das Plugin. */
export function signResponse(secret: string, payload: string): string {
  return hmacSha256Hex(secret, payload);
}

export type VerifyFailureReason =
  | 'MISSING_SIGNATURE'
  | 'TIMESTAMP_SKEW'
  | 'BAD_SIGNATURE';

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason };

export interface VerifyRequestInput extends SignRequestInput {
  signature: string;
  clockSkewSec: number;
  nowSec?: number;
}

/**
 * Verifiziert Signatur + Timestamp-Skew. Die Nonce-Einmaligkeit prüft der
 * Replay-Schutz separat (security/nonce.ts) — diese Funktion ist zustandslos.
 */
export function verifyRequest(secret: string, input: VerifyRequestInput): VerifyResult {
  if (!input.signature) {
    return { valid: false, reason: 'MISSING_SIGNATURE' };
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(input.timestamp);
  if (!Number.isInteger(ts)) {
    return { valid: false, reason: 'TIMESTAMP_SKEW' };
  }
  if (Math.abs(nowSec - ts) > input.clockSkewSec) {
    return { valid: false, reason: 'TIMESTAMP_SKEW' };
  }
  const expected = signRequest(secret, input);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(input.signature, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }
  return { valid: true };
}

/** sha256(secret) hex — für api_keys.key_hash (kein Klartext-Secret). */
export function hashSecret(secret: string): string {
  return sha256Hex(secret);
}

const ENC_PREFIX = 'v1';

function deriveKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(keyMaterial).digest(); // 32 Bytes -> AES-256
}

/** AES-256-GCM-Verschlüsselung für api_keys.secret_enc. */
export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(enc: string, keyMaterial: string): string {
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) {
    throw new Error('Ungültiges secret_enc-Format');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Zufälliges Secret für neue API-Keys (256 Bit Entropie). */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

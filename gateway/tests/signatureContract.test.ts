/**
 * Regressionstest: verankert die HMAC-Signaturformel byte-genau.
 *
 * Diese Formel MUSS exakt mit dem WordPress-Plugin (class-kg-api.php,
 * sign_request()) übereinstimmen. Die goldenen Werte hier sind unabhängig
 * (node:crypto) und von der PHP-Seite (hash_hmac) berechnet und müssen
 * identisch sein. Eine Änderung an canonicalString() bricht diesen Test
 * bewusst, damit eine stillende Drift zwischen Backend und Plugin auffällt.
 *
 * String-to-Sign = METHOD + path + timestamp + nonce + sha256hex(body)
 * (ohne Trennzeichen, METHOD in Großbuchstaben, path OHNE Query-String).
 */
import { describe, expect, it } from 'vitest';
import {
  bodyHash,
  canonicalString,
  hmacSha256Hex,
  sha256Hex,
  signRequest,
} from '../src/security/hmac.js';

// Goldene Vektoren (unabhängig via node:crypto berechnet).
const SECRET = 'test-secret';
const METHOD = 'POST';
const PATH = '/api/v1/invoices';
const TIMESTAMP = '1700000000';
const NONCE = 'abc123';
const BODY = '{"orderRef":"42"}';

const EXPECTED_BODY_HASH =
  '7554147c29a91d35cee0216d1933615776f7cd78f9e72b188eded2386bc3fd9f';
const EXPECTED_STRING_TO_SIGN =
  'POST/api/v1/invoices1700000000abc123' + EXPECTED_BODY_HASH;
const EXPECTED_SIGNATURE =
  '6b2200b5311e3701569e07ae47d2f9b9b573a11a62dbe862c30b30ef897c3e1b';

describe('Signatur-Vertrag (Cross-Language mit WordPress-Plugin)', () => {
  it('bodyHash liefert sha256hex des exakten Bodys', () => {
    expect(bodyHash(BODY)).toBe(EXPECTED_BODY_HASH);
  });

  it('bodyHash eines leeren Bodys = sha256("")', () => {
    // Muss dem PHP hash("sha256","") entsprechen.
    expect(bodyHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(bodyHash(null)).toBe(bodyHash(''));
  });

  it('canonicalString = METHOD + path + timestamp + nonce + sha256(body), ohne Trennzeichen', () => {
    expect(
      canonicalString(METHOD, PATH, TIMESTAMP, NONCE, bodyHash(BODY))
    ).toBe(EXPECTED_STRING_TO_SIGN);
  });

  it('signRequest erzeugt den goldenen Hex-Wert (identisch zu PHP hash_hmac)', () => {
    const sig = signRequest(SECRET, {
      method: METHOD,
      path: PATH,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      body: BODY,
    });
    expect(sig).toBe(EXPECTED_SIGNATURE);
  });

  it('Methode wird unabhängig von der Schreibweise normalisiert', () => {
    const a = signRequest(SECRET, {
      method: 'post', // Kleinschreibung
      path: PATH,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      body: BODY,
    });
    expect(a).toBe(EXPECTED_SIGNATURE);
  });

  it('verschiedene Bodies ergeben verschiedene Signaturen', () => {
    const other = hmacSha256Hex(
      SECRET,
      canonicalString(METHOD, PATH, TIMESTAMP, NONCE, sha256Hex('{}'))
    );
    expect(other).not.toBe(EXPECTED_SIGNATURE);
  });
});

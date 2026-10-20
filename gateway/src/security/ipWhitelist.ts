/**
 * IP/CIDR-Whitelist-Prüfung auf App-Ebene (IPv4 + IPv6, CIDR-Support).
 */

/** Normalisiert Quell-IPs: Klammern und ::ffff:-Mapping entfernen. */
export function normalizeIp(ip: string): string {
  let s = (ip ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }
  if (s.toLowerCase().startsWith('::ffff:')) {
    const rest = s.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
      s = rest;
    }
  }
  return s;
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const v = Number(parts[i]);
    if (v > 255) return null;
    bytes[i] = v;
  }
  return bytes;
}

function parseIpv6(ip: string): Uint8Array | null {
  if (!ip.includes(':')) return null;
  const [head, tail, ...rest] = ip.split('::');
  if (rest.length > 0) return null; // mehr als ein '::'
  const expand = (part: string): number[] => {
    if (part === '') return [];
    return part.split(':').map((g) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
      return parseInt(g, 16);
    });
  };
  const headGroups = expand(head);
  const tailGroups = ip.includes('::') ? expand(tail) : headGroups;
  if (ip.includes('::') === false) {
    // ohne '::' müssen exakt 8 Gruppen da sein
    if (headGroups.length !== 8 || headGroups.some(Number.isNaN)) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      bytes[i * 2] = headGroups[i] >> 8;
      bytes[i * 2 + 1] = headGroups[i] & 0xff;
    }
    return bytes;
  }
  const total = headGroups.length + tailGroups.length;
  if (total > 8) return null;
  const groups = [...headGroups, ...new Array(8 - total).fill(0), ...tailGroups];
  if (groups.some(Number.isNaN)) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

function parseIp(ip: string): Uint8Array | null {
  const v4 = parseIpv4(ip);
  if (v4) return v4;
  return parseIpv6(ip);
}

/** Prüft, ob ip im CIDR-Bereich liegt (exakte Angabe ohne Präfix = exakter Vergleich). */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const normIp = normalizeIp(ip).toLowerCase();
  const normCidr = cidr.trim().toLowerCase();
  const slash = normCidr.indexOf('/');
  if (slash === -1) {
    return normIp === normalizeIp(normCidr);
  }
  const base = normalizeIp(normCidr.slice(0, slash));
  const prefix = Number(normCidr.slice(slash + 1));
  const ipBytes = parseIp(normIp);
  const cidrBytes = parseIp(base);
  if (!ipBytes || !cidrBytes || ipBytes.length !== cidrBytes.length) return false;
  const maxBits = ipBytes.length * 8;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false;

  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== cidrBytes[i]) return false;
  }
  const restBits = prefix & 7;
  if (restBits > 0) {
    const mask = (0xff << (8 - restBits)) & 0xff;
    if ((ipBytes[fullBytes] & mask) !== (cidrBytes[fullBytes] & mask)) return false;
  }
  return true;
}

/**
 * true wenn ip in der Whitelist steht ('*' = alles erlaubt).
 * Ungültige Einträge werden ignoriert (lehnen ab).
 */
export function isIpAllowed(ip: string, whitelist: readonly string[]): boolean {
  const normIp = normalizeIp(ip);
  if (!normIp) return false;
  for (const entry of whitelist) {
    const e = entry.trim();
    if (e === '*') return true;
    if (e.length === 0) continue;
    if (e.includes('/')) {
      if (isIpInCidr(normIp, e)) return true;
    } else if (normalizeIp(e).toLowerCase() === normIp.toLowerCase()) {
      return true;
    }
  }
  return false;
}

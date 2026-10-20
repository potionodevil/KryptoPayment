import { describe, expect, it } from 'vitest';
import { isIpAllowed, normalizeIp, isIpInCidr } from '../src/security/ipWhitelist.js';

describe('security/ipWhitelist', () => {
  it('normalizeIp entfernt ::ffff:-Mapping und Klammern', () => {
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('exakte IP-Übereinstimmung', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', [])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['*'])).toBe(true); // Wildcard
  });

  it('CIDR-Support IPv4: /8, /24, /32 und Grenzen', () => {
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('192.168.1.255', ['192.168.1.0/24'])).toBe(true);
    expect(isIpAllowed('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['1.2.3.4/32'])).toBe(true);
    expect(isIpAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true); // gemappt
  });

  it('CIDR-Support IPv6', () => {
    expect(isIpAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(isIpAllowed('2001:dead::1', ['2001:db8::/32'])).toBe(false);
    expect(isIpInCidr('2001:db8:0:0:0:0:0:1', '2001:db8::/32')).toBe(true);
  });

  it('ungültige Einträge werden ignoriert und lehnen ab', () => {
    expect(isIpAllowed('10.0.0.1', ['keine-ip', 'auch-schlecht/999'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['keine-ip', '10.0.0.0/8'])).toBe(true);
  });

  it('mehrere Einträge: jeder Treffer genügt', () => {
    expect(isIpAllowed('127.0.0.1', ['10.0.0.0/8', '127.0.0.1'])).toBe(true);
    expect(isIpAllowed('192.168.5.5', ['10.0.0.0/8', '127.0.0.1'])).toBe(false);
  });
});

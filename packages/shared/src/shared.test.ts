import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedIp, redact, safeEqualHex, sha256, signHmac } from './index.js';

describe('shared security helpers', () => {
  it('blocks private and metadata-adjacent addresses', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.1.2.3')).toBe(true);
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(() => assertPublicUrl('http://localhost/test')).toThrow();
  });

  it('redacts secret-shaped keys recursively', () => {
    expect(redact({ headers: { authorization: 'Bearer x' }, value: 1 })).toEqual({
      headers: { authorization: '[REDACTED]' },
      value: 1,
    });
  });

  it('signs canonical HMAC data deterministically', () => {
    const input = { method: 'POST', path: '/x', bodyHash: sha256('a'), timestamp: '1', nonce: 'n' };
    const a = signHmac('secret', input);
    const b = signHmac('secret', input);
    expect(safeEqualHex(a, b)).toBe(true);
  });
});

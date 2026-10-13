import { expect, it } from 'vitest';
import { csrfFor, newToken, sameSecret, seal, tokenHash, unseal } from './crypto.js';
import { requireModerator, requireVerified } from './service.js';
import type { Principal } from './model.js';
it('never makes session hashes into reusable bearer tokens and binds CSRF per session', () => {
  const token = newToken(); expect(token).toHaveLength(43); expect(tokenHash(token)).not.toBe(token);
  expect(csrfFor(token, 'server-key')).not.toBe(csrfFor(newToken(), 'server-key'));
  expect(sameSecret('one', 'two')).toBe(false); expect(sameSecret('one', 'one')).toBe(true);
});
it('encrypts queued email credentials and rejects authentication-tag corruption', () => {
  const plaintext = `https://example.test/reset#token=${newToken()}`;
  const encrypted = seal(plaintext, 'synthetic-encryption-test-secret');
  expect(encrypted).not.toContain('token='); expect(unseal(encrypted, 'synthetic-encryption-test-secret')).toBe(plaintext);
  expect(() => unseal(encrypted, 'different-secret')).toThrow();
});
it('never elevates an unverified or ordinary account through shared authorization', () => {
  const principal = { user: { verifiedAt: null, role: 'user' } } as Principal;
  expect(() => requireVerified(principal)).toThrow(); expect(() => requireModerator(principal)).toThrow();
  principal.user.verifiedAt = new Date(); expect(() => requireVerified(principal)).not.toThrow(); expect(() => requireModerator(principal)).toThrow();
  principal.user.role = 'moderator'; expect(() => requireModerator(principal)).not.toThrow();
});

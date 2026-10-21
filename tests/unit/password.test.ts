import { describe, expect, it } from 'vitest';

import { fakeVerify, hashPassword, verifyPassword } from '@/lib/auth/password';

describe('scrypt password hashing', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (per-password salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$0$0$0$AA==$AA==')).resolves.toBe(false);
  });

  it('exposes a timing-equalisation helper for unknown users', async () => {
    await expect(fakeVerify('some-password')).resolves.toBeUndefined();
  });
});

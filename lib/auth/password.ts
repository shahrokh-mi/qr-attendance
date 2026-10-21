import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** Promise wrapper with the full option signature (promisify drops it). */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * scrypt password hashing with per-password salt and a versioned, self-describing
 * format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * Parameters follow the Node.js documentation defaults (N=16384, r=8, p=1) which keep
 * one hash in the tens of milliseconds — affordable on the Hobby plan's CPU budget
 * while remaining expensive enough for an internal prototype. Raising N invalidates
 * nothing: verification reads the parameters from the stored string.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PARAMS.saltBytes);
  const hash = (await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1] as string, 10);
  const r = Number.parseInt(parts[2] as string, 10);
  const p = Number.parseInt(parts[3] as string, 10);
  if (![N, r, p].every((value) => Number.isFinite(value) && value > 0)) return false;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (expected.length === 0) return false;

  const actual = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Burns comparable CPU time when no user matches, so login timing does not reveal
 * whether a username exists.
 */
export async function fakeVerify(password: string): Promise<void> {
  await scrypt(password.normalize('NFKC'), randomBytes(16), 64, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
}

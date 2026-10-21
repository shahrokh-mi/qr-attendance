import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/lib/db';
import { displays, type DisplayRow } from '@/lib/db/schema';
import { appendCookie, clearCookie } from '@/lib/http/cookies';
import { hashToken } from './session';

/**
 * Entrance display identity.
 *
 * A display holds a restricted credential that authorises exactly one thing: reading
 * the current challenge. It cannot act as an employee and cannot call admin APIs.
 * Only the SHA-256 hash of the credential is stored.
 */
export const DISPLAY_COOKIE = 'qa_display';
const DISPLAY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function newDisplayCredential(): string {
  return randomBytes(32).toString('base64url');
}

export async function getDisplayByCredential(
  db: Database,
  credential: string | undefined,
): Promise<DisplayRow | null> {
  if (!credential) return null;
  const rows = await db
    .select()
    .from(displays)
    .where(
      and(
        eq(displays.credentialHash, hashToken(credential)),
        eq(displays.active, true),
        isNull(displays.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function attachDisplayCookie(response: Response, credential: string): void {
  appendCookie(response, DISPLAY_COOKIE, credential, {
    maxAge: DISPLAY_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  });
}

export function clearDisplayCookie(response: Response): void {
  clearCookie(response, DISPLAY_COOKIE);
}

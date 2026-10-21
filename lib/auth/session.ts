import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { getConfig } from '@/lib/config';
import type { Database } from '@/lib/db';
import { sessions, users, type UserRow } from '@/lib/db/schema';
import { ApiError, forbidden, unauthenticated } from '@/lib/http/errors';
import { appendCookie, clearCookie } from '@/lib/http/cookies';

export const SESSION_COOKIE = 'qa_session';

export interface SessionUser {
  id: string;
  username: string;
  employeeCode: string;
  displayName: string;
  role: 'admin' | 'employee';
  active: boolean;
  defaultPasswordPending: boolean;
  authenticatedAt: string;
  sessionTokenHash: string;
  sessionExpiresAt: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreatedSession {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Sessions store only the SHA-256 hash of the opaque token. */
export async function createSession(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<CreatedSession> {
  const config = getConfig();
  const token = newSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1000);
  await db.insert(sessions).values({
    tokenHash,
    userId,
    authenticatedAt: now,
    createdAt: now,
    expiresAt,
  });
  return { token, tokenHash, expiresAt };
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value || undefined;
}

export async function getSessionUser(
  db: Database,
  token: string | undefined,
  now = new Date(),
): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // An inactive user keeps a syntactically valid session; it must still be rejected.
  if (!row.user.active) return null;

  return toSessionUser(row.session.authenticatedAt, row.session.expiresAt, row.user, tokenHash);
}

function toSessionUser(
  authenticatedAt: Date,
  expiresAt: Date,
  user: UserRow,
  tokenHash: string,
): SessionUser {
  return {
    id: user.id,
    username: user.username,
    employeeCode: user.employeeCode,
    displayName: user.displayName,
    role: user.role === 'admin' ? 'admin' : 'employee',
    active: user.active,
    defaultPasswordPending: user.defaultPasswordPending,
    authenticatedAt: authenticatedAt.toISOString(),
    sessionTokenHash: tokenHash,
    sessionExpiresAt: expiresAt.toISOString(),
  };
}

export async function requireUser(db: Database, now = new Date()): Promise<SessionUser> {
  const user = await getSessionUser(db, await readSessionToken(), now);
  if (!user) throw unauthenticated();
  return user;
}

export async function requireAdmin(db: Database, now = new Date()): Promise<SessionUser> {
  const user = await requireUser(db, now);
  if (user.role !== 'admin') throw forbidden('Administrator access is required');
  return user;
}

export async function revokeSession(db: Database, tokenHash: string, now = new Date()) {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(
  db: Database,
  userId: string,
  now = new Date(),
  exceptTokenHash?: string,
) {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptTokenHash) conditions.push(ne(sessions.tokenHash, exceptTokenHash));
  await db.update(sessions).set({ revokedAt: now }).where(and(...conditions));
}

export function attachSessionCookie(response: Response, session: CreatedSession): void {
  const maxAge = Math.max(
    1,
    Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
  );
  appendCookie(response, SESSION_COOKIE, session.token, {
    maxAge,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  });
}

export function clearSessionCookie(response: Response): void {
  clearCookie(response, SESSION_COOKIE);
}

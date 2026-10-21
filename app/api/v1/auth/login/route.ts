import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { FLOW_COOKIE, getValidFlow } from '@/lib/auth/flow';
import { authUserPayload } from '@/lib/auth/payload';
import { fakeVerify, verifyPassword } from '@/lib/auth/password';
import {
  attachSessionCookie,
  createSession,
  hashToken,
  revokeSession,
  SESSION_COOKIE,
  type SessionUser,
} from '@/lib/auth/session';
import { findPendingAttempt } from '@/lib/attendance/attempts';
import { cleanupExpired } from '@/lib/cleanup';
import { withDatabaseWrite } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { jsonResponse, withApi } from '@/lib/http/api';
import { attachCsrfToken, newCsrfToken } from '@/lib/http/csrf';
import { ApiError } from '@/lib/http/errors';
import { rateLimit } from '@/lib/http/rate-limit';
import { clientIp, readJsonBody } from '@/lib/http/request';
import { asRecord, normalizeUsername, requiredString } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Username/password sign-in.
 *
 * - rate limited in memory (per instance: a documented weakening)
 * - rotates the session: any presented session is revoked before a new one is issued
 * - preserves a still-valid pending attendance attempt bound to this browser flow so
 *   a first-time scan completes immediately after login
 * - a failed login writes nothing (the handler runs in a rolled-back transaction)
 */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async ({ requestId }) => {
    const limit = rateLimit(`login:${clientIp(request)}`, 20, 60_000);
    if (!limit.allowed) {
      const response = jsonResponse(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many sign-in attempts. Please wait a moment and try again.',
            request_id: requestId,
          },
        },
        429,
      );
      response.headers.set('Retry-After', String(limit.retryAfterSeconds));
      return response;
    }

    const body = asRecord(await readJsonBody(request));
    const username = requiredString(body, 'username', { max: 80 });
    const password = requiredString(body, 'password', { trim: false, max: 256 });

    const flowCookie = request.cookies.get(FLOW_COOKIE)?.value;
    const presentedSession = request.cookies.get(SESSION_COOKIE)?.value;

    const outcome = await withDatabaseWrite(async (db) => {
      const normalized = normalizeUsername(username);
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.usernameNormalized, normalized))
        .limit(1);

      if (!user) {
        // Spend comparable CPU time so response timing does not reveal valid usernames.
        await fakeVerify(password);
        throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      }
      if (!user.active) {
        throw new ApiError(
          403,
          'account_inactive',
          'This account is disabled. Contact an administrator.',
        );
      }

      const now = new Date();
      if (presentedSession) await revokeSession(db, hashToken(presentedSession), now);

      const session = await createSession(db, user.id, now);
      const flow = await getValidFlow(db, flowCookie, now);
      const pending = flow ? await findPendingAttempt(db, flow.tokenHash, now) : null;

      // Opportunistic cleanup: rides inside this transaction, so a login is still a
      // single snapshot write. The daily cron covers deployments nobody signs in to.
      await cleanupExpired(db, now);

      const sessionUser: SessionUser = {
        id: user.id,
        username: user.username,
        employeeCode: user.employeeCode,
        displayName: user.displayName,
        role: user.role === 'admin' ? 'admin' : 'employee',
        active: user.active,
        defaultPasswordPending: user.defaultPasswordPending,
        authenticatedAt: now.toISOString(),
        sessionTokenHash: session.tokenHash,
        sessionExpiresAt: session.expiresAt.toISOString(),
      };

      return { session, user: sessionUser, pending };
    });

    const csrfToken = newCsrfToken();
    const response = jsonResponse({
      user: authUserPayload(outcome.user),
      csrf_token: csrfToken,
      pending_attempt: outcome.pending
        ? { id: outcome.pending.id, expires_at: outcome.pending.expiresAt.toISOString() }
        : null,
    });

    // Rotate the CSRF token on login so a pre-login token cannot be replayed.
    attachCsrfToken(response, csrfToken);
    attachSessionCookie(response, outcome.session);
    return response;
  });
}

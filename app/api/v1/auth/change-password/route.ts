import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  getSessionUser,
  revokeAllSessions,
  SESSION_COOKIE,
  type SessionUser,
} from '@/lib/auth/session';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/policy';
import { withDatabaseWrite } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { jsonResponse, withApi } from '@/lib/http/api';
import { ApiError } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, requiredString } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Changes the signed-in user's password and revokes every other session. */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const body = asRecord(await readJsonBody(request));
    const currentPassword = requiredString(body, 'current_password', {
      trim: false,
      max: 256,
    });
    const newPassword = requiredString(body, 'new_password', {
      trim: false,
      min: MIN_PASSWORD_LENGTH,
      max: 256,
    });

    const token = request.cookies.get(SESSION_COOKIE)?.value;

    const updated = await withDatabaseWrite(async (db) => {
      const sessionUser = await getSessionUser(db, token);
      if (!sessionUser) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');

      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id))
        .limit(1);
      if (!row) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');

      const valid = await verifyPassword(currentPassword, row.passwordHash);
      if (!valid) {
        throw new ApiError(400, 'invalid_credentials', 'The current password is incorrect');
      }

      const now = new Date();
      const passwordHash = await hashPassword(newPassword);
      await db
        .update(users)
        .set({
          passwordHash,
          defaultPasswordPending: false,
          updatedAt: now,
        })
        .where(eq(users.id, row.id));

      const current: SessionUser = sessionUser;
      await revokeAllSessions(db, row.id, now, current.sessionTokenHash);

      return { defaultPasswordPending: false };
    });

    return jsonResponse({ ok: true, ...updated });
  });
}

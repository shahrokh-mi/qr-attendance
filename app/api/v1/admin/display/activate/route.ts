import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';

import {
  attachDisplayCookie,
  newDisplayCredential,
} from '@/lib/auth/display';
import {
  clearSessionCookie,
  hashToken,
  requireAdmin,
  revokeSession,
  SESSION_COOKIE,
} from '@/lib/auth/session';
import { withDatabaseWrite } from '@/lib/db';
import { displays } from '@/lib/db/schema';
import { jsonResponse, withApi } from '@/lib/http/api';
import { ApiError } from '@/lib/http/errors';
import { rateLimit } from '@/lib/http/rate-limit';
import { clientIp, readJsonBody } from '@/lib/http/request';
import { asRecord, requiredString } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Provisions this browser as an entrance display.
 *
 * One request does three things: create the display row (storing only the credential
 * hash), hand this browser the restricted display cookie, and revoke the
 * administrator's session so the monitor that shows the QR is not left logged in as an
 * admin. The display credential can only read the challenge.
 */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const limit = rateLimit(`display-activate:${clientIp(request)}`, 10, 60_000);
    if (!limit.allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many display activations. Try again shortly.');
    }

    const body = asRecord(await readJsonBody(request));
    const label = requiredString(body, 'label', { min: 1, max: 80 });
    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;

    const provisioned = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      const credential = newDisplayCredential();
      const now = new Date();
      const [row] = await db
        .insert(displays)
        .values({
          id: randomUUID(),
          label,
          credentialHash: hashToken(credential),
          active: true,
          createdAt: now,
        })
        .returning();
      if (!row) throw new ApiError(500, 'internal_error', 'Could not provision the display');

      if (sessionToken) await revokeSession(db, hashToken(sessionToken), now);

      return { display: row, credential };
    });

    const response = jsonResponse(
      {
        display: {
          id: provisioned.display.id,
          label: provisioned.display.label,
          active: true,
          created_at: provisioned.display.createdAt.toISOString(),
        },
        session_revoked: true,
      },
      201,
    );
    attachDisplayCookie(response, provisioned.credential);
    clearSessionCookie(response);
    return response;
  });
}

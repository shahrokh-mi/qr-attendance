import { and, eq, isNull } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { clearDisplayCookie, DISPLAY_COOKIE } from '@/lib/auth/display';
import { hashToken, requireAdmin } from '@/lib/auth/session';
import { withDatabaseWrite } from '@/lib/db';
import { displays } from '@/lib/db/schema';
import { jsonResponse, withApi } from '@/lib/http/api';
import { notFound } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, isUuid, optionalString } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revokes an entrance display. Revocation invalidates its polling immediately — the
 * derived challenge is only served to an active display row.
 *
 * `display_id` is optional: without it the display bound to this browser's cookie is
 * revoked, which is the usual case when reclaiming a monitor.
 */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const body = asRecord(await readJsonBody(request));
    const requestedId = optionalString(body, 'display_id', { max: 64 });
    const credential = request.cookies.get(DISPLAY_COOKIE)?.value;

    const revoked = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      const now = new Date();

      if (requestedId) {
        if (!isUuid(requestedId)) throw notFound('Display not found');
        const [row] = await db
          .update(displays)
          .set({ active: false, revokedAt: now })
          .where(and(eq(displays.id, requestedId), isNull(displays.revokedAt)))
          .returning({ id: displays.id, label: displays.label });
        if (!row) throw notFound('Display not found');
        return row;
      }

      if (!credential) throw notFound('No display is bound to this browser');
      const [row] = await db
        .update(displays)
        .set({ active: false, revokedAt: now })
        .where(
          and(
            eq(displays.credentialHash, hashToken(credential)),
            isNull(displays.revokedAt),
          ),
        )
        .returning({ id: displays.id, label: displays.label });
      if (!row) throw notFound('Display not found');
      return row;
    });

    const response = jsonResponse({ revoked: { id: revoked.id, label: revoked.label } });
    clearDisplayCookie(response);
    return response;
  });
}

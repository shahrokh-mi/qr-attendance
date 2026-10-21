import type { NextRequest } from 'next/server';

import { clearFlowCookie } from '@/lib/auth/flow';
import {
  clearSessionCookie,
  getSessionUser,
  hashToken,
  revokeSession,
} from '@/lib/auth/session';
import { withDatabase, withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revokes the current session server-side and clears the cookie. */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const token = request.cookies.get('qa_session')?.value;

    if (token) {
      const user = await withDatabase((db) => getSessionUser(db, token));
      if (user) {
        await withDatabaseWrite((db) => revokeSession(db, hashToken(token)));
      }
    }

    const response = jsonResponse({ ok: true });
    clearSessionCookie(response);
    clearFlowCookie(response);
    return response;
  });
}

import type { NextRequest } from 'next/server';

import { authUserPayload } from '@/lib/auth/payload';
import { getSessionUser, SESSION_COOKIE } from '@/lib/auth/session';
import { withDatabase } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current user plus permissions. 401 when there is no live session. */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async ({ requestId }) => {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const user = await withDatabase((db) => getSessionUser(db, token));

    if (!user) {
      return jsonResponse(
        {
          error: {
            code: 'unauthenticated',
            message: 'Sign in to continue',
            request_id: requestId,
          },
        },
        401,
      );
    }

    return jsonResponse({ user: authUserPayload(user) });
  });
}

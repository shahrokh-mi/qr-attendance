import type { NextRequest } from 'next/server';

import { FLOW_COOKIE, getValidFlow } from '@/lib/auth/flow';
import { getSessionUser, SESSION_COOKIE } from '@/lib/auth/session';
import { exchangeChallenge } from '@/lib/attendance/attempts';
import { withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { ApiError } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, requiredString } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchanges a scanned QR for a pending attendance attempt.
 *
 * This happens before login so a first-time employee does not lose the scan while
 * typing credentials. The GET of /scan itself never writes: this POST is the only
 * thing that records the scan, and it is CSRF protected like every mutation.
 */
export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const body = asRecord(await readJsonBody(request));
    const challenge = requiredString(body, 'challenge', { min: 8, max: 128 });
    const flowCookie = request.cookies.get(FLOW_COOKIE)?.value;
    const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;

    const result = await withDatabaseWrite(async (db) => {
      const flow = await getValidFlow(db, flowCookie);
      if (!flow) {
        throw new ApiError(
          400,
          'bad_request',
          'This page lost its session binding. Reload the page and scan again.',
        );
      }
      const user = await getSessionUser(db, sessionCookie);
      const attempt = await exchangeChallenge(db, { challenge, flow });

      return {
        attempt_id: attempt.attemptId,
        display_id: attempt.displayId,
        expires_at: attempt.expiresAt.toISOString(),
        requires_login: user === null,
      };
    });

    return jsonResponse(result, 201);
  });
}

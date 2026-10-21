import type { NextRequest } from 'next/server';

import { FLOW_COOKIE, getValidFlow } from '@/lib/auth/flow';
import { authUserPayload } from '@/lib/auth/payload';
import { requireUser } from '@/lib/auth/session';
import { completeAttempt } from '@/lib/attendance/attempts';
import { todayEventsForUser } from '@/lib/attendance/history';
import { getConfig } from '@/lib/config';
import { withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { expired } from '@/lib/http/errors';
import { isUuid } from '@/lib/http/validate';
import { formatTimeInTimeZone } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Completes a pending attempt and records the raw attendance event.
 *
 * Idempotent: repeating the call for the same attempt returns the same event instead
 * of inserting another one. The employee identity comes exclusively from the session —
 * never from the request body — and `recorded_at` is the exchange time, not the phone's
 * clock.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return withApi(request, { mutating: true }, async () => {
    const { id } = await context.params;
    if (!isUuid(id)) {
      throw expired('attempt_not_found', 'That attendance attempt could not be found.');
    }

    const flowCookie = request.cookies.get(FLOW_COOKIE)?.value;
    const config = getConfig();

    const result = await withDatabaseWrite(async (db) => {
      const user = await requireUser(db);
      const flow = await getValidFlow(db, flowCookie);
      const receipt = await completeAttempt(db, {
        attemptId: id,
        user,
        flow,
      });
      const today = await todayEventsForUser(db, user.id);
      return { receipt, user, today };
    });

    return jsonResponse({
      receipt: {
        event_id: result.receipt.eventId,
        recorded_at: result.receipt.recordedAt,
        committed_at: result.receipt.committedAt,
        employee_code: result.receipt.employeeCode,
        display_id: result.receipt.displayId,
        already_completed: result.receipt.alreadyCompleted,
        recorded_time_local: formatTimeInTimeZone(
          new Date(result.receipt.recordedAt),
          config.displayTimezone,
        ),
      },
      user: authUserPayload(result.user),
      display_timezone: config.displayTimezone,
      today: result.today,
    });
  });
}

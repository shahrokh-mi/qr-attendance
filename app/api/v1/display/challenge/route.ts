import type { NextRequest } from 'next/server';

import { DISPLAY_COOKIE, getDisplayByCredential } from '@/lib/auth/display';
import { buildChallenge } from '@/lib/attendance/challenge';
import { getSettings } from '@/lib/attendance/settings';
import { getConfig } from '@/lib/config';
import { withDatabase } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { ApiError } from '@/lib/http/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The display's only capability.
 *
 * There is intentionally no unauthenticated way to read the current challenge: that
 * would let anyone fetch codes remotely without standing in front of the monitor.
 * Nothing is written here — the token is derived from (display id, interval start), so
 * polling once per second costs no database writes at all.
 */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const credential = request.cookies.get(DISPLAY_COOKIE)?.value;
    const config = getConfig();

    const payload = await withDatabase(async (db) => {
      const display = await getDisplayByCredential(db, credential);
      if (!display) {
        throw new ApiError(
          401,
          'unauthenticated',
          'This monitor is not provisioned as an entrance display. Ask an administrator to activate it.',
        );
      }
      const schedule = await getSettings(db);
      const nowMs = Date.now();

      return {
        ...buildChallenge({
          secret: config.qrChallengeSecret,
          displayId: display.id,
          displayLabel: display.label,
          baseUrl: config.publicBaseUrl,
          intervalSeconds: schedule.qrInterval,
          scheduleVersion: schedule.scheduleVersion,
          overlapSeconds: config.qrAcceptanceOverlapSeconds,
          nowMs,
        }),
        display_timezone: config.displayTimezone,
      };
    });

    return jsonResponse(payload);
  });
}

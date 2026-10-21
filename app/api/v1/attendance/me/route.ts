import type { NextRequest } from 'next/server';

import { requireUser } from '@/lib/auth/session';
import { queryHistory } from '@/lib/attendance/history';
import { getConfig } from '@/lib/config';
import { withDatabase } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { parseDateParam, parsePagination } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in employee's own raw events. The user id is taken from the session, so
 * there is no parameter that could be pointed at somebody else's history.
 *
 * Date filters are calendar days in DISPLAY_TIMEZONE, from-inclusive / to-exclusive.
 */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const searchParams = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(searchParams);
    const fromDate = parseDateParam(searchParams.get('from'), 'from');
    const toDate = parseDateParam(searchParams.get('to'), 'to');
    const config = getConfig();

    const result = await withDatabase(async (db) => {
      const user = await requireUser(db);
      const history = await queryHistory(db, {
        userId: user.id,
        fromDate,
        toDate,
        page,
        pageSize,
      });
      return {
        ...history,
        display_timezone: config.displayTimezone,
        employee: {
          id: user.id,
          display_name: user.displayName,
          employee_code: user.employeeCode,
        },
      };
    });

    return jsonResponse(result);
  });
}

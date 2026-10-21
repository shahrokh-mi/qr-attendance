import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/session';
import { queryHistory } from '@/lib/attendance/history';
import { getConfig } from '@/lib/config';
import { withDatabase } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { isUuid, parseDateParam, parsePagination } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** All employees' raw events with employee and date filters. Admin only. */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const searchParams = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(searchParams);
    const fromDate = parseDateParam(searchParams.get('from'), 'from');
    const toDate = parseDateParam(searchParams.get('to'), 'to');
    const employeeCode = searchParams.get('employee_code')?.trim() || undefined;
    const rawUserId = searchParams.get('user_id')?.trim();
    const userId = rawUserId && isUuid(rawUserId) ? rawUserId : undefined;
    const config = getConfig();

    const result = await withDatabase(async (db) => {
      await requireAdmin(db);
      const history = await queryHistory(db, {
        userId,
        employeeCode,
        fromDate,
        toDate,
        page,
        pageSize,
      });
      return { ...history, display_timezone: config.displayTimezone };
    });

    return jsonResponse(result);
  });
}

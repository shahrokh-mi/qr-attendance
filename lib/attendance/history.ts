import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import { getConfig } from '@/lib/config';
import type { Database } from '@/lib/db';
import { attendanceEvents, users } from '@/lib/db/schema';
import { addLocalDays, formatDateInTimeZone, parseLocalDate } from '@/lib/time';

/**
 * Attendance history queries.
 *
 * Date filters are calendar days in DISPLAY_TIMEZONE and are translated to a
 * from-inclusive / to-exclusive UTC range, so a Tehran day is exactly one day even
 * though everything is stored as UTC. Employees can only ever query their own rows:
 * the user id is not taken from the request.
 */

export interface HistoryQuery {
  userId?: string;
  employeeCode?: string;
  fromDate?: string | null;
  toDate?: string | null;
  page: number;
  pageSize: number;
}

export interface AttendanceEventDto {
  id: string;
  user_id: string;
  display_name: string;
  employee_code: string;
  display_id: string;
  recorded_at: string;
  committed_at: string;
}

export interface HistoryPage {
  items: AttendanceEventDto[];
  page: number;
  page_size: number;
  total: number;
}

function buildRange(fromDate: string | null | undefined, toDate: string | null | undefined) {
  const timezone = getConfig().displayTimezone;
  const from = parseLocalDate(fromDate ?? null, timezone);
  // `to` is inclusive as a calendar day: the upper bound is the next local midnight.
  const to = toDate ? addLocalDays(toDate, 1, timezone) : null;
  return { from, to, timezone };
}

export async function queryHistory(
  db: Database,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const { from, to } = buildRange(query.fromDate, query.toDate);

  const filters: SQL[] = [];
  if (query.userId) filters.push(eq(attendanceEvents.userId, query.userId));
  if (query.employeeCode) filters.push(employeeFilter(query.employeeCode));
  if (from) filters.push(gte(attendanceEvents.recordedAt, from));
  if (to) filters.push(lt(attendanceEvents.recordedAt, to));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totalRow] = await db
    .select({ value: count() })
    .from(attendanceEvents)
    .where(where);
  const total = totalRow?.value ?? 0;

  const rows = await db
    .select({
      id: attendanceEvents.id,
      userId: attendanceEvents.userId,
      displayId: attendanceEvents.displayId,
      recordedAt: attendanceEvents.recordedAt,
      committedAt: attendanceEvents.committedAt,
      employeeCodeSnapshot: attendanceEvents.employeeCodeSnapshot,
      displayName: users.displayName,
      employeeCode: users.employeeCode,
    })
    .from(attendanceEvents)
    .innerJoin(users, eq(users.id, attendanceEvents.userId))
    .where(where)
    .orderBy(desc(attendanceEvents.recordedAt), desc(attendanceEvents.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      display_name: row.displayName,
      // Snapshot taken at record time survives an employee-code change later.
      employee_code: row.employeeCodeSnapshot,
      display_id: row.displayId,
      recorded_at: row.recordedAt.toISOString(),
      committed_at: row.committedAt.toISOString(),
    })),
    page: query.page,
    page_size: query.pageSize,
    total,
  };
}

/** Events from local midnight today, used by the scan receipt. */
export async function todayEventsForUser(
  db: Database,
  userId: string,
): Promise<AttendanceEventDto[]> {
  const timezone = getConfig().displayTimezone;
  const today = formatDateInTimeZone(new Date(), timezone);
  const page = await queryHistory(db, {
    userId,
    fromDate: today,
    toDate: today,
    page: 1,
    pageSize: 50,
  });
  return page.items;
}

/** Employee filter support for the admin list (exact code match, case-insensitive). */
export function employeeFilter(value: string): SQL {
  return sql`lower(${users.employeeCode}) = ${value.toLowerCase()}`;
}

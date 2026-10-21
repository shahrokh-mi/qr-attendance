import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { HistoryTable } from '@/components/history-table';
import { Pagination } from '@/components/pagination';
import { Card, CardHeader, inputClass } from '@/components/ui';
import { queryHistory } from '@/lib/attendance/history';
import { getConfig } from '@/lib/config';
import { withDatabase } from '@/lib/db';
import { requirePageAdmin } from '@/lib/page-session';
import { todayInTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function AdminAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    employee_code?: string;
    page?: string;
  }>;
}) {
  const user = await requirePageAdmin();
  const params = await searchParams;
  const timeZone = getConfig().displayTimezone;
  const today = todayInTimeZone(timeZone);

  const from = params.from && DATE_PATTERN.test(params.from) ? params.from : today;
  const to = params.to && DATE_PATTERN.test(params.to) ? params.to : today;
  const employeeCode = params.employee_code?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const history = await withDatabase((db) =>
    queryHistory(db, {
      employeeCode,
      fromDate: from,
      toDate: to,
      page,
      pageSize: 50,
    }),
  );

  return (
    <AppShell
      user={user}
      title="All attendance"
      description="Every raw event from every employee. Filter by calendar day and employee code; totals count events, not people."
    >
      <Card>
        <CardHeader
          title="Events"
          description={`Times are shown in ${timeZone}. The stored value is always UTC.`}
          action={
            <form
              className="flex flex-wrap items-end gap-2"
              action="/admin/attendance"
              method="get"
            >
              <label className="text-[11px] text-mist-500">
                From
                <input
                  type="date"
                  name="from"
                  defaultValue={from}
                  className={`${inputClass} mt-1 h-8 py-1 text-xs`}
                />
              </label>
              <label className="text-[11px] text-mist-500">
                To
                <input
                  type="date"
                  name="to"
                  defaultValue={to}
                  className={`${inputClass} mt-1 h-8 py-1 text-xs`}
                />
              </label>
              <label className="text-[11px] text-mist-500">
                Employee code
                <input
                  name="employee_code"
                  defaultValue={employeeCode ?? ''}
                  placeholder="any"
                  className={`${inputClass} mt-1 h-8 w-28 py-1 text-xs`}
                />
              </label>
              <button
                type="submit"
                className="h-8 rounded-md border border-ink-600 px-3 text-xs font-medium text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
              >
                Apply
              </button>
              <Link
                href="/admin/attendance"
                className="h-8 rounded-md px-2 text-xs leading-8 text-mist-500 transition-colors hover:text-teal-200"
              >
                Reset
              </Link>
            </form>
          }
        />
        <HistoryTable events={history.items} timeZone={timeZone} showEmployee />
        <Pagination
          page={history.page}
          pageSize={history.page_size}
          total={history.total}
          basePath="/admin/attendance"
          params={{ from, to, employee_code: employeeCode }}
        />
      </Card>
    </AppShell>
  );
}

import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { HistoryTable } from '@/components/history-table';
import { Pagination } from '@/components/pagination';
import { Card, CardHeader, inputClass } from '@/components/ui';
import { queryHistory } from '@/lib/attendance/history';
import { getConfig } from '@/lib/config';
import { withDatabase } from '@/lib/db';
import { requirePageUser } from '@/lib/page-session';
import { formatTimeInTimeZone, todayInTimeZone } from '@/lib/time';

export const dynamic = 'force-dynamic';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The employee's own raw events. Only the signed-in user's rows are queried — there is
 * no parameter that could point this at another employee, and the query runs on the
 * server.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; page?: string }>;
}) {
  const user = await requirePageUser('/attendance');
  const params = await searchParams;
  const timeZone = getConfig().displayTimezone;
  const today = todayInTimeZone(timeZone);

  const from = params.from && DATE_PATTERN.test(params.from) ? params.from : today;
  const to = params.to && DATE_PATTERN.test(params.to) ? params.to : today;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const history = await withDatabase((db) =>
    queryHistory(db, { userId: user.id, fromDate: from, toDate: to, page, pageSize: 25 }),
  );

  const first = history.items[history.items.length - 1];
  const last = history.items[0];

  return (
    <AppShell
      user={user}
      title="My attendance"
      description="Every row is a raw event recorded when you scanned the entrance code. The time comes from the server, not your phone."
      actions={
        <div className="flex items-center gap-2 text-[11px] text-mist-500">
          <span className="rounded-full border border-ink-600 px-2.5 py-1 font-mono">
            {user.employeeCode}
          </span>
          <span className="rounded-full border border-ink-600 px-2.5 py-1">{timeZone}</span>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Events in range" value={String(history.total)} />
        <Stat
          label="First event"
          value={first ? formatTimeInTimeZone(new Date(first.recorded_at), timeZone) : '—'}
        />
        <Stat
          label="Latest event"
          value={last ? formatTimeInTimeZone(new Date(last.recorded_at), timeZone) : '—'}
        />
      </div>

      <Card>
        <CardHeader
          title="Events"
          description="Filter by calendar day in the display timezone. The range is inclusive of both dates."
          action={
            <form className="flex flex-wrap items-end gap-2" action="/attendance" method="get">
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
              <button
                type="submit"
                className="h-8 rounded-md border border-ink-600 px-3 text-xs font-medium text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
              >
                Apply
              </button>
              <Link
                href="/attendance"
                className="h-8 rounded-md px-2 text-xs leading-8 text-mist-500 transition-colors hover:text-teal-200"
              >
                Today
              </Link>
            </form>
          }
        />
        <HistoryTable events={history.items} timeZone={timeZone} showEmployee={false} />
        <Pagination
          page={history.page}
          pageSize={history.page_size}
          total={history.total}
          basePath="/attendance"
          params={{ from, to }}
        />
      </Card>

      <p className="text-center text-[11px] text-mist-500">
        Entry, exit, lateness and payroll are intentionally not derived from these events.
      </p>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-mist-500">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums text-mist-100">{value}</p>
    </Card>
  );
}

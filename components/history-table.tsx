import type { AttendanceEventDto } from '@/lib/attendance/history';
import { formatDateInTimeZone, formatTimeInTimeZone } from '@/lib/time';

import { EmptyState } from './ui';

/**
 * Raw attendance events. The wording is deliberate: "Attendance event", never
 * Check-in/Check-out — the system records events and infers nothing.
 */
export function HistoryTable({
  events,
  timeZone,
  showEmployee,
}: {
  events: AttendanceEventDto[];
  timeZone: string;
  showEmployee: boolean;
}) {
  if (events.length === 0) {
    return (
      <EmptyState title="No attendance events">
        Nothing was recorded in this range. Scan the QR code at the entrance to create one.
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-mist-500">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Date
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Recorded at
            </th>
            {showEmployee ? (
              <th scope="col" className="px-4 py-2.5 font-medium">
                Employee
              </th>
            ) : null}
            <th scope="col" className="px-4 py-2.5 font-medium">
              Event
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Committed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700/60">
          {events.map((event) => (
            <tr key={event.id} className="transition-colors hover:bg-ink-800/50">
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-mist-400">
                {formatDateInTimeZone(new Date(event.recorded_at), timeZone)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-sm tabular-nums text-mist-100">
                {formatTimeInTimeZone(new Date(event.recorded_at), timeZone)}
              </td>
              {showEmployee ? (
                <td className="px-4 py-2.5">
                  <span className="block text-xs text-mist-200">{event.display_name}</span>
                  <span className="font-mono text-[11px] text-mist-500">
                    {event.employee_code}
                  </span>
                </td>
              ) : null}
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-600/50 bg-teal-600/10 px-2 py-0.5 text-[11px] font-medium text-teal-200">
                  Attendance event
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-[11px] text-mist-500">
                {formatTimeInTimeZone(new Date(event.committed_at), timeZone)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

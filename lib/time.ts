/**
 * Timezone helpers. Storage is always UTC (`timestamptz`); day boundaries shown to
 * users are computed in DISPLAY_TIMEZONE.
 *
 * Asia/Tehran is UTC+03:30 with no DST today, but nothing here assumes a fixed offset:
 * the offset is resolved through Intl for the instant in question.
 */

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    // Intl renders midnight as 24 in some locales/engines.
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Offset of the zone at that instant, in milliseconds (positive east of UTC). */
function offsetMs(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight for the calendar day containing `date`. */
export function startOfDayInTimeZone(date: Date, timeZone: string): Date {
  const parts = localParts(date, timeZone);
  return zonedMidnight(parts.year, parts.month - 1, parts.day, timeZone);
}

/** UTC instant of local midnight for an explicit calendar date. */
export function zonedMidnight(
  year: number,
  monthIndex: number,
  day: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, monthIndex, day);
  const offset = offsetMs(new Date(guess), timeZone);
  // One correction pass handles DST transitions where the offset differs at midnight.
  const candidate = new Date(guess - offset);
  const corrected = offsetMs(candidate, timeZone);
  return corrected === offset ? candidate : new Date(guess - corrected);
}

/** Parses `YYYY-MM-DD` as local midnight in `timeZone`; null when absent. */
export function parseLocalDate(value: string | null, timeZone: string): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) throw new Error(`Invalid date ${value}`);
  return zonedMidnight(year, month - 1, day, timeZone);
}

/** Adds `days` calendar days in the zone (used for exclusive upper bounds). */
export function addLocalDays(value: string, days: number, timeZone: string): Date | null {
  const base = parseLocalDate(value, timeZone);
  if (!base) return null;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  return zonedMidnight(
    year as number,
    (month as number) - 1,
    (day as number) + days,
    timeZone,
  );
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = localParts(now, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

/** `HH:mm:ss` in the display timezone. */
export function formatTimeInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** `YYYY-MM-DD HH:mm` in the display timezone. */
export function formatDateTimeInTimeZone(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(
    parts.minute,
  )}`;
}

export function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

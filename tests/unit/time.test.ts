import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  formatDateInTimeZone,
  formatTimeInTimeZone,
  parseLocalDate,
  startOfDayInTimeZone,
  todayInTimeZone,
} from '@/lib/time';

describe('timezone day boundaries', () => {
  it('resolves Tehran midnight to the correct UTC instant', () => {
    // Asia/Tehran is UTC+03:30 (no DST since 2022).
    const midnight = parseLocalDate('2026-03-15', 'Asia/Tehran');
    expect(midnight?.toISOString()).toBe('2026-03-14T20:30:00.000Z');
  });

  it('maps an instant to the local calendar day, not the UTC day', () => {
    // 21:30 UTC is already the next day in Tehran.
    const instant = new Date('2026-03-15T21:30:00.000Z');
    expect(formatDateInTimeZone(instant, 'Asia/Tehran')).toBe('2026-03-16');
    expect(formatDateInTimeZone(instant, 'UTC')).toBe('2026-03-15');
  });

  it('computes the start of the local day from an instant', () => {
    const instant = new Date('2026-03-15T09:00:00.000Z');
    expect(startOfDayInTimeZone(instant, 'Asia/Tehran').toISOString()).toBe(
      '2026-03-14T20:30:00.000Z',
    );
  });

  it('produces an exclusive upper bound one local day later', () => {
    const next = addLocalDays('2026-03-15', 1, 'Asia/Tehran');
    expect(next?.toISOString()).toBe('2026-03-15T20:30:00.000Z');
  });

  it('formats times in the display timezone', () => {
    const instant = new Date('2026-03-15T04:05:06.000Z');
    expect(formatTimeInTimeZone(instant, 'Asia/Tehran')).toBe('07:35:06');
  });

  it('reports today in the display timezone', () => {
    const instant = new Date('2026-03-15T21:30:00.000Z');
    expect(todayInTimeZone('Asia/Tehran', instant)).toBe('2026-03-16');
  });
});

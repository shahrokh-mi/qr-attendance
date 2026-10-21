import { describe, expect, it } from 'vitest';

import {
  acceptableIntervals,
  buildChallenge,
  deriveChallengeToken,
  intervalStartSeconds,
  verifyChallenge,
} from '@/lib/attendance/challenge';

const SECRET = 'unit-test-secret-at-least-32-characters-long';
const DISPLAY = '11111111-2222-3333-4444-555555555555';

function token(nowMs: number, overrides: { intervalSeconds?: number; scheduleVersion?: number; displayId?: string } = {}) {
  const intervalSeconds = overrides.intervalSeconds ?? 5;
  return deriveChallengeToken(SECRET, {
    displayId: overrides.displayId ?? DISPLAY,
    scheduleVersion: overrides.scheduleVersion ?? 1,
    intervalSeconds,
    intervalStart: intervalStartSeconds(nowMs, intervalSeconds),
  });
}

describe('derived QR challenges', () => {
  it('is stable inside one interval and changes at the boundary', () => {
    const t0 = 1_700_000_000_000; // exact multiple of 5s
    const a = token(t0);
    const b = token(t0 + 4_999);
    const c = token(t0 + 5_000);

    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a).toHaveLength(32);
  });

  it('differs per display and per secret', () => {
    const t0 = 1_700_000_000_000;
    const base = token(t0);
    expect(token(t0, { displayId: 'other-display' })).not.toBe(base);
    expect(
      deriveChallengeToken('another-secret-at-least-32-characters!!', {
        displayId: DISPLAY,
        scheduleVersion: 1,
        intervalSeconds: 5,
        intervalStart: intervalStartSeconds(t0, 5),
      }),
    ).not.toBe(base);
  });

  it('accepts the previous interval only during the overlap window', () => {
    const interval = 5;
    const overlap = 3;
    const start = 1_700_000_000_000;
    const previousStart = intervalStartSeconds(start, interval);

    // 2s into the new interval: the previous one is still inside the 3s overlap.
    const inside = acceptableIntervals(start + interval * 1000 + 2_000, interval, overlap);
    expect(inside).toContain(previousStart);

    // 4s into the new interval: the overlap has passed.
    const outside = acceptableIntervals(start + interval * 1000 + 4_000, interval, overlap);
    expect(outside).not.toContain(previousStart);
    expect(outside).toEqual([previousStart + interval]);
  });

  it('verifies a token for the current interval and rejects it once expired', () => {
    const interval = 5;
    const overlap = 3;
    const nowMs = 1_700_000_012_000;
    const intervalStart = intervalStartSeconds(nowMs, interval);
    const value = token(nowMs);

    const accepted = verifyChallenge({
      secret: SECRET,
      token: value,
      displayIds: [DISPLAY],
      intervalSeconds: interval,
      scheduleVersion: 1,
      overlapSeconds: overlap,
      nowMs,
    });
    expect(accepted).toEqual({ displayId: DISPLAY, intervalStart });

    const tooLate = verifyChallenge({
      secret: SECRET,
      token: value,
      displayIds: [DISPLAY],
      intervalSeconds: interval,
      scheduleVersion: 1,
      overlapSeconds: overlap,
      nowMs: (intervalStart + interval + overlap) * 1000 + 1,
    });
    expect(tooLate).toBeNull();
  });

  it('invalidates outstanding tokens when the interval changes, even on a shared boundary', () => {
    // 1_700_000_010 000 is divisible by both 5 and 15, so the interval *boundaries*
    // alone would not distinguish the two schedules. The token binds the schedule.
    const nowMs = 1_700_000_010_000;
    const oldToken = token(nowMs, { intervalSeconds: 5 });

    expect(
      verifyChallenge({
        secret: SECRET,
        token: oldToken,
        displayIds: [DISPLAY],
        intervalSeconds: 15,
        scheduleVersion: 2,
        overlapSeconds: 3,
        nowMs,
      }),
    ).toBeNull();

    // Sanity: the very same boundary would otherwise produce a matching HMAC input.
    expect(intervalStartSeconds(nowMs, 5)).toBe(intervalStartSeconds(nowMs, 15));
  });

  it('invalidates outstanding tokens when only the schedule version changes', () => {
    const nowMs = 1_700_000_012_000;
    const oldToken = token(nowMs, { scheduleVersion: 1 });

    expect(
      verifyChallenge({
        secret: SECRET,
        token: oldToken,
        displayIds: [DISPLAY],
        intervalSeconds: 5,
        scheduleVersion: 2,
        overlapSeconds: 3,
        nowMs,
      }),
    ).toBeNull();
  });

  it('rejects a token from an unknown display', () => {
    const nowMs = 1_700_000_012_000;
    const value = token(nowMs, { displayId: 'some-other-display' });
    expect(
      verifyChallenge({
        secret: SECRET,
        token: value,
        displayIds: [DISPLAY],
        intervalSeconds: 5,
        scheduleVersion: 1,
        overlapSeconds: 3,
        nowMs,
      }),
    ).toBeNull();
  });

  it('builds a QR URL from configured values only', () => {
    const payload = buildChallenge({
      secret: SECRET,
      displayId: DISPLAY,
      displayLabel: 'Main entrance',
      baseUrl: 'https://attendance.example.com',
      intervalSeconds: 5,
      scheduleVersion: 3,
      overlapSeconds: 3,
      nowMs: 1_700_000_012_000,
    });

    expect(payload.qr_url.startsWith('https://attendance.example.com/scan?challenge=')).toBe(true);
    expect(payload.qr_interval).toBe(5);
    expect(payload.schedule_version).toBe(3);
    expect(new Date(payload.next_rotation).getTime()).toBeGreaterThan(
      new Date(payload.server_time).getTime(),
    );
    const intervalStart = intervalStartSeconds(1_700_000_012_000, 5);
    expect(new Date(payload.expires_at).getTime()).toBe((intervalStart + 5 + 3) * 1000);
  });
});

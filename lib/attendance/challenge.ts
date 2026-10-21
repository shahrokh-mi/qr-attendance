import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless QR challenges.
 *
 * A challenge is *derived*, never stored:
 *
 *   token = base64url(HMAC-SHA256(QR_CHALLENGE_SECRET, "qr1|" + display_id + "|" + interval_start))[0:32]
 *
 * This is the single most important decision of the design: persisting a challenge
 * row every five seconds would burn the free tier's 2,000 monthly advanced write
 * operations in a few hours. Deriving it means:
 *   - no write on display polling (one request per second, all free reads)
 *   - expiry enforced by arithmetic, no cleanup job
 *   - several employees can use the same displayed code; nothing is consumed
 *   - revoking a display or rotating the secret invalidates outstanding codes
 *
 * The security property is "cannot be guessed without the server secret", which is
 * what a stored random token would provide while costing a write per rotation.
 */

export const QR_INTERVAL_MIN_SECONDS = 3;
export const QR_INTERVAL_MAX_SECONDS = 60;

export function intervalStartSeconds(nowMs: number, intervalSeconds: number): number {
  const seconds = Math.floor(nowMs / 1000);
  return Math.floor(seconds / intervalSeconds) * intervalSeconds;
}

export function deriveChallengeToken(
  secret: string,
  input: {
    displayId: string;
    scheduleVersion: number;
    intervalSeconds: number;
    intervalStart: number;
  },
): string {
  // The schedule version and interval are part of the message on purpose: without them
  // an old code could stay valid after an admin changes the schedule whenever the
  // interval boundaries happen to coincide (5s -> 15s at a common boundary). Including
  // them makes "changing the schedule invalidates outstanding codes" exactly true.
  return createHmac('sha256', secret)
    .update(
      `qr1|${input.displayId}|v${input.scheduleVersion}|${input.intervalSeconds}|${input.intervalStart}`,
    )
    .digest('base64url')
    .slice(0, 32);
}

/**
 * Intervals whose token is still accepted at `now`.
 *
 * The previous interval stays valid for `overlap` seconds after it ends, so an
 * employee who scanned just as the code rotated is not punished for the round trip.
 */
export function acceptableIntervals(
  nowMs: number,
  intervalSeconds: number,
  overlapSeconds: number,
): number[] {
  const current = intervalStartSeconds(nowMs, intervalSeconds);
  const nowSeconds = nowMs / 1000;
  const previous = current - intervalSeconds;
  const previousStillValid = nowSeconds < previous + intervalSeconds + overlapSeconds;
  return previousStillValid ? [current, previous] : [current];
}

export interface ChallengePayload {
  token: string;
  display_id: string;
  display_label: string;
  qr_url: string;
  server_time: string;
  next_rotation: string;
  expires_at: string;
  qr_interval: number;
  schedule_version: number;
  acceptance_overlap: number;
}

export interface BuildChallengeInput {
  secret: string;
  displayId: string;
  displayLabel: string;
  baseUrl: string;
  intervalSeconds: number;
  scheduleVersion: number;
  overlapSeconds: number;
  nowMs: number;
}

export function buildChallenge(input: BuildChallengeInput): ChallengePayload {
  const intervalStart = intervalStartSeconds(input.nowMs, input.intervalSeconds);
  const token = deriveChallengeToken(input.secret, {
    displayId: input.displayId,
    scheduleVersion: input.scheduleVersion,
    intervalSeconds: input.intervalSeconds,
    intervalStart,
  });
  const expiresAtMs =
    (intervalStart + input.intervalSeconds + input.overlapSeconds) * 1000;
  const nextRotationMs = (intervalStart + input.intervalSeconds) * 1000;

  return {
    token,
    display_id: input.displayId,
    display_label: input.displayLabel,
    // Built only from validated configuration, never from a request Host header.
    qr_url: `${input.baseUrl}/scan?challenge=${encodeURIComponent(token)}`,
    server_time: new Date(input.nowMs).toISOString(),
    next_rotation: new Date(nextRotationMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    qr_interval: input.intervalSeconds,
    schedule_version: input.scheduleVersion,
    acceptance_overlap: input.overlapSeconds,
  };
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifiedChallenge {
  displayId: string;
  intervalStart: number;
}

/**
 * Recomputes the token for every active display and every acceptable interval.
 * Returns null when no combination matches, so the caller answers 410 without
 * revealing which part was wrong.
 */
export function verifyChallenge(input: {
  secret: string;
  token: string;
  displayIds: string[];
  intervalSeconds: number;
  scheduleVersion: number;
  overlapSeconds: number;
  nowMs: number;
}): VerifiedChallenge | null {
  if (!input.token || input.token.length < 8 || input.token.length > 128) return null;
  const intervals = acceptableIntervals(
    input.nowMs,
    input.intervalSeconds,
    input.overlapSeconds,
  );
  for (const displayId of input.displayIds) {
    for (const intervalStart of intervals) {
      const expected = deriveChallengeToken(input.secret, {
        displayId,
        scheduleVersion: input.scheduleVersion,
        intervalSeconds: input.intervalSeconds,
        intervalStart,
      });
      if (safeEquals(expected, input.token)) {
        return { displayId, intervalStart };
      }
    }
  }
  return null;
}

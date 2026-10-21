/**
 * In-memory, per-instance rate limiting.
 *
 * Deliberate, documented weakening: a database-backed counter would cost one Blob
 * advanced operation per attempt and exhaust the free tier. Counters therefore reset
 * on cold start and are not shared across instances, so brute-force protection is
 * best-effort. Sessions and password hashing remain the real defences.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  if (buckets.size > MAX_BUCKETS) {
    for (const [entryKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(entryKey);
    }
    if (buckets.size > MAX_BUCKETS) buckets.clear();
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/** Clears all counters; used by tests so suites do not leak state into each other. */
export function resetRateLimits(): void {
  buckets.clear();
}

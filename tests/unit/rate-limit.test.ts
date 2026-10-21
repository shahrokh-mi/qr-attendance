import { describe, expect, it } from 'vitest';

import { rateLimit, resetRateLimits } from '@/lib/http/rate-limit';

describe('in-memory rate limiting', () => {
  it('allows up to the limit inside one window, then rejects', () => {
    resetRateLimits();
    const now = 1_700_000_000_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(rateLimit('login:1.2.3.4', 3, 60_000, now).allowed).toBe(true);
    }
    const blocked = rateLimit('login:1.2.3.4', 3, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets when the window elapses', () => {
    resetRateLimits();
    const now = 1_700_000_000_000;
    rateLimit('login:5.6.7.8', 1, 60_000, now);
    expect(rateLimit('login:5.6.7.8', 1, 60_000, now).allowed).toBe(false);
    expect(rateLimit('login:5.6.7.8', 1, 60_000, now + 60_001).allowed).toBe(true);
  });

  it('keeps buckets independent per key', () => {
    resetRateLimits();
    const now = 1_700_000_000_000;
    rateLimit('login:a', 1, 60_000, now);
    expect(rateLimit('login:b', 1, 60_000, now).allowed).toBe(true);
  });
});

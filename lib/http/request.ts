import type { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';

/**
 * Client address used for rate-limit bucketing.
 *
 * On Vercel the socket address is the edge proxy, so the first hop of
 * `x-forwarded-for` is used — but only when TRUST_FORWARDED_FOR is enabled, because
 * the header is trivially spoofable when the app is exposed directly.
 */
export function clientIp(request: NextRequest): string {
  const config = getConfig();
  if (config.trustForwardedFor) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    const realIp = request.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
  }
  return 'local';
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

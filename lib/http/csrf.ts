import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';

import { ApiError } from './errors';
import { appendCookie, readCookie } from './cookies';

export const CSRF_COOKIE = 'qa_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const CSRF_TTL_SECONDS = 60 * 60 * 12;

export function newCsrfToken(): string {
  return `${randomUUID()}.${randomUUID()}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Double-submit CSRF: the token in the `qa_csrf` cookie must be echoed in the
 * `x-csrf-token` header. The cookie stays HttpOnly, so a script injected into the page
 * cannot read it — the token is handed to the app by `/api/v1/auth/csrf` and kept in
 * memory only.
 */
export async function assertCsrf(request: NextRequest): Promise<void> {
  const cookieToken = readCookie(request.cookies, CSRF_COOKIE);
  const headerToken = request.headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || !constantTimeEquals(cookieToken, headerToken)) {
    throw new ApiError(403, 'csrf_failed', 'Missing or invalid CSRF token. Reload the page.');
  }
  assertSameOrigin(request);
}

/**
 * Origin/Referer check against PUBLIC_BASE_URL. SameSite=Lax alone is not enough:
 * a top-level cross-site POST still carries the session cookie in some browsers.
 */
export function assertSameOrigin(request: NextRequest): void {
  const expected = getConfig().publicBaseUrl;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  let actual: string | null = null;
  if (origin) {
    actual = origin;
  } else if (referer) {
    try {
      actual = new URL(referer).origin;
    } catch {
      actual = null;
    }
  }

  if (!actual || actual !== expected) {
    throw new ApiError(403, 'csrf_failed', 'Cross-origin request rejected');
  }
}

/** Issues (or refreshes) the CSRF cookie and returns the token to hand to the client. */
export function attachCsrfToken(response: Response, existing?: string): string {
  const token = existing ?? newCsrfToken();
  appendCookie(response, CSRF_COOKIE, token, { maxAge: CSRF_TTL_SECONDS });
  return token;
}

export function readCsrfToken(request: NextRequest): string | undefined {
  return readCookie(request.cookies, CSRF_COOKIE);
}

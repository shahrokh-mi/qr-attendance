'use client';

/**
 * Browser-side API client.
 *
 * Every mutation carries the CSRF token issued by `/api/v1/auth/csrf`. The token lives
 * in module memory only — never in localStorage — and is refetched automatically when
 * the server rejects it (for example after signing in on another tab).
 */

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let csrfToken: string | null = null;

export async function ensureCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch('/api/v1/auth/csrf', { cache: 'no-store' });
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      'csrf_failed',
      'Could not establish a browser session. Reload the page.',
    );
  }
  const data = (await response.json()) as { csrf_token?: string };
  if (!data.csrf_token) {
    throw new ApiClientError(500, 'csrf_failed', 'Server did not issue a CSRF token.');
  }
  csrfToken = data.csrf_token;
  return csrfToken;
}

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['x-csrf-token'] = await ensureCsrf();
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    method,
    headers,
    cache: 'no-store',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }

  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } }).error ?? {};
    if (error.code === 'csrf_failed') csrfToken = null;
    throw new ApiClientError(
      response.status,
      error.code ?? 'internal_error',
      error.message ?? 'Request failed. Please retry.',
    );
  }

  // The server rotates the CSRF token on login; adopt it so the next mutation from this
  // page (for example completing the scanned attempt) uses the value the cookie now holds.
  const issued = (data as { csrf_token?: unknown }).csrf_token;
  if (typeof issued === 'string' && issued.length > 0) {
    csrfToken = issued;
  }

  return data as T;
}

/** Message for any thrown error, with a network hint when the server is unreachable. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof TypeError) return 'Cannot reach the server. Check the connection.';
  return 'Unexpected error. Please retry.';
}

export function errorCode(error: unknown): string {
  return error instanceof ApiClientError ? error.code : 'network_error';
}

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

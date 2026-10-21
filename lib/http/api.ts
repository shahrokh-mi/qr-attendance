import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { WriteConflictError } from '@/lib/db';
import { ApiError } from './errors';
import { assertCsrf } from './csrf';

/** Every JSON response is uncacheable: it may contain session or attendance state. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
          ...(error.details ?? {}),
        },
      },
      error.status,
    );
  }

  if (error instanceof WriteConflictError) {
    return jsonResponse(
      {
        error: {
          code: 'write_conflict',
          message:
            'Another attendance request was saved at the same time. Please try again.',
          request_id: requestId,
        },
      },
      409,
    );
  }

  console.error(
    JSON.stringify({
      scope: 'api',
      message: 'unhandled_error',
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );

  return jsonResponse(
    {
      error: {
        code: 'internal_error',
        message: 'Unexpected server error. Please retry.',
        request_id: requestId,
      },
    },
    500,
  );
}

export interface ApiHandlerOptions {
  /** State-changing request: enforce CSRF + same-origin before running the handler. */
  mutating?: boolean;
}

export type ApiHandler = (context: { requestId: string }) => Promise<Response>;

/**
 * Single wrapper for every route handler: assigns a request id, enforces CSRF and
 * origin for mutations, converts thrown ApiErrors into the documented error shape,
 * and guarantees `no-store` + `X-Request-Id` on the way out.
 */
export async function withApi(
  request: NextRequest,
  options: ApiHandlerOptions,
  handler: ApiHandler,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (options.mutating) {
      await assertCsrf(request);
    }
    const response = await handler({ requestId });
    return finalise(response, requestId);
  } catch (error) {
    return finalise(errorResponse(error, requestId), requestId);
  }
}

function finalise(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return new Response(response.body, { status: response.status, headers });
}

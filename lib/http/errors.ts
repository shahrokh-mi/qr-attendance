/**
 * Stable, documented API error codes (see docs/openapi.yaml).
 *
 * Every error the API returns carries a machine-readable `code`, a human message and
 * the request id, so the UI can render an actionable state without parsing prose.
 */
export type ErrorCode =
  | 'bad_request'
  | 'invalid_field'
  | 'invalid_credentials'
  | 'account_inactive'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'csrf_failed'
  | 'rate_limited'
  | 'invalid_challenge'
  | 'expired_challenge'
  | 'attempt_expired'
  | 'attempt_not_found'
  | 'attempt_completed'
  | 'conflict'
  | 'last_admin'
  | 'write_conflict'
  | 'storage_unavailable'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message = 'Malformed request', details?: Record<string, unknown>) =>
  new ApiError(400, 'bad_request', message, details);

export const invalidField = (field: string, message: string) =>
  new ApiError(400, 'invalid_field', message, { field });

export const unauthenticated = (message = 'Sign in to continue') =>
  new ApiError(401, 'unauthenticated', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);

export const expired = (code: ErrorCode, message: string) => new ApiError(410, code, message);

export const conflict = (code: ErrorCode, message: string) => new ApiError(409, code, message);

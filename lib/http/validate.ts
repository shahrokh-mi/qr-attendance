import { ApiError, invalidField } from './errors';

/**
 * Small hand-rolled validators. Deliberately dependency-free: the payloads are few
 * and shallow, and every rejection must produce an `invalid_field` code plus the
 * offending field name for the UI.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'bad_request', 'Expected a JSON object body');
  }
  return value as Record<string, unknown>;
}

interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  trim?: boolean;
}

export function requiredString(
  record: Record<string, unknown>,
  field: string,
  options: StringOptions = {},
): string {
  const raw = record[field];
  if (typeof raw !== 'string') throw invalidField(field, `${field} is required`);
  const value = options.trim === false ? raw : raw.trim();
  const min = options.min ?? 1;
  if (value.length < min) throw invalidField(field, `${field} must be at least ${min} characters`);
  const max = options.max ?? 200;
  if (value.length > max) throw invalidField(field, `${field} must be at most ${max} characters`);
  if (options.pattern && !options.pattern.test(value)) {
    throw invalidField(field, options.patternMessage ?? `${field} has an invalid format`);
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  field: string,
  options: StringOptions = {},
): string | undefined {
  if (record[field] === undefined || record[field] === null) return undefined;
  return requiredString(record, field, options);
}

export function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const raw = record[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw invalidField(field, `${field} must be a boolean`);
  return raw;
}

export function enumField<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  optional = false,
): T | undefined {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    if (optional) return undefined;
    throw invalidField(field, `${field} is required`);
  }
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw invalidField(field, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

export function integerField(
  record: Record<string, unknown>,
  field: string,
  options: { min: number; max: number; optional?: boolean },
): number | undefined {
  const raw = record[field];
  if (raw === undefined || raw === null) {
    if (options.optional) return undefined;
    throw invalidField(field, `${field} is required`);
  }
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < options.min ||
    value > options.max
  ) {
    throw invalidField(
      field,
      `${field} must be an integer between ${options.min} and ${options.max}`,
    );
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidField(record: Record<string, unknown> | null, field: string): string {
  const raw = record?.[field];
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw invalidField(field, `${field} must be a UUID`);
  }
  return raw.toLowerCase();
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Usernames are case-insensitive; the normalised form is what the DB is unique on. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function parsePagination(searchParams: URLSearchParams): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const rawPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const rawSize = Number.parseInt(searchParams.get('page_size') ?? '25', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(Math.max(Number.isFinite(rawSize) ? rawSize : 25, 1), 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateParam(value: string | null, field: string): string | null {
  if (!value) return null;
  if (!DATE_RE.test(value)) throw invalidField(field, `${field} must be YYYY-MM-DD`);
  return value;
}

/**
 * Runtime configuration. Every value is read once per process from the environment,
 * validated, and never exposed to the client bundle (this module is server-only).
 */

export type StorageMode = 'file' | 'blob';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`Environment variable ${name} must be a boolean`);
}

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

function baseUrl(name: string, fallback?: string): string {
  const raw = optional(name) ?? fallback;
  if (!raw) throw new Error(`Missing required environment variable ${name}`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL, received "${raw}"`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  // Normalise: no trailing slash, origin only.
  return parsed.origin;
}

export interface AppConfig {
  publicBaseUrl: string;
  storageMode: StorageMode;
  snapshotPath: string;
  blobToken?: string;
  localDataDir: string;
  qrChallengeSecret: string;
  sessionTtlSeconds: number;
  pendingAttemptTtlSeconds: number;
  qrAcceptanceOverlapSeconds: number;
  displayTimezone: string;
  cookieSecure: boolean;
  trustForwardedFor: boolean;
  bootstrapAdminPassword: string;
  cronSecret?: string;
  nodeEnv: string;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const storageMode = (optional('STORAGE_MODE') ??
    (nodeEnv === 'production' && optional('BLOB_READ_WRITE_TOKEN')
      ? 'blob'
      : 'file')) as StorageMode;

  if (storageMode !== 'file' && storageMode !== 'blob') {
    throw new Error('STORAGE_MODE must be "file" or "blob"');
  }

  const secret = optional('QR_CHALLENGE_SECRET');
  if (!secret) {
    throw new Error(
      'QR_CHALLENGE_SECRET is required; generate one with `openssl rand -base64 48`',
    );
  }
  if (secret.length < 32) {
    throw new Error('QR_CHALLENGE_SECRET must be at least 32 characters');
  }

  const blobToken = optional('BLOB_READ_WRITE_TOKEN');
  if (storageMode === 'blob' && !blobToken) {
    // Fail closed: never silently fall back to ephemeral local state in production.
    throw new Error(
      'STORAGE_MODE=blob requires BLOB_READ_WRITE_TOKEN. Refusing to start with ephemeral storage.',
    );
  }

  const timezone = optional('DISPLAY_TIMEZONE') ?? 'Asia/Tehran';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`DISPLAY_TIMEZONE "${timezone}" is not a valid IANA timezone`);
  }

  const config: AppConfig = {
    publicBaseUrl: baseUrl(
      'PUBLIC_BASE_URL',
      nodeEnv === 'production' ? undefined : 'http://localhost:3000',
    ),
    storageMode,
    snapshotPath: optional('SNAPSHOT_PATH') ?? 'db/snapshot.tar.gz',
    blobToken,
    localDataDir: optional('LOCAL_DATA_DIR') ?? './data/pglite',
    qrChallengeSecret: secret,
    sessionTtlSeconds: positiveInt('SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
    pendingAttemptTtlSeconds: positiveInt('PENDING_ATTEMPT_TTL_SECONDS', 120),
    qrAcceptanceOverlapSeconds: positiveInt('QR_ACCEPTANCE_OVERLAP_SECONDS', 3),
    displayTimezone: timezone,
    cookieSecure: bool('COOKIE_SECURE', nodeEnv === 'production'),
    trustForwardedFor: bool('TRUST_FORWARDED_FOR', false),
    bootstrapAdminPassword: optional('BOOTSTRAP_ADMIN_PASSWORD') ?? 'admin',
    cronSecret: optional('CRON_SECRET'),
    nodeEnv,
  };

  cached = config;
  return config;
}

/** Test-only: drop the memoised configuration so a new environment can be read. */
export function resetConfigForTests(): void {
  cached = null;
}

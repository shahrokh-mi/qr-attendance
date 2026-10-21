import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Postgres schema executed by PGlite. Timestamps are `timestamptz` and always hold
 * UTC instants; local day boundaries are computed in the presentation layer from
 * DISPLAY_TIMEZONE.
 *
 * IDs are application-generated UUIDs (no database defaults) so migrations stay
 * portable and PGlite never needs an extension.
 */

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    employeeCode: text('employee_code').notNull().unique(),
    username: text('username').notNull(),
    usernameNormalized: text('username_normalized').notNull().unique(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    defaultPasswordPending: boolean('default_password_pending')
      .notNull()
      .default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('users_role_check', sql`${table.role} in ('admin', 'employee')`),
    index('users_employee_code_idx').on(table.employeeCode),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authenticatedAt: timestamptz('authenticated_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Pre-authentication browser binding. A pending attendance attempt is only completed
 * by a browser that holds the flow cookie whose hash is stored on the attempt.
 */
export const browserFlows = pgTable(
  'browser_flows',
  {
    tokenHash: text('token_hash').primaryKey(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [index('browser_flows_expires_idx').on(table.expiresAt)],
);

/** Singleton row (id = 'singleton') holding the QR rotation schedule. */
export const settings = pgTable(
  'settings',
  {
    id: text('id').primaryKey(),
    qrInterval: integer('qr_interval').notNull().default(5),
    scheduleVersion: integer('schedule_version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'settings_qr_interval_check',
      sql`${table.qrInterval} between 3 and 60`,
    ),
  ],
);

/** Provisioned entrance display. Only the SHA-256 hash of the credential is stored. */
export const displays = pgTable(
  'displays',
  {
    id: uuid('id').primaryKey(),
    label: text('label').notNull(),
    credentialHash: text('credential_hash').notNull().unique(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [index('displays_active_idx').on(table.active)],
);

/**
 * A scanned challenge that has been exchanged for a pending attendance attempt.
 * `challenge_interval_start` (epoch seconds) and `display_id` are kept for audit even
 * if the schedule or the display later changes.
 */
export const attendanceAttempts = pgTable(
  'attendance_attempts',
  {
    id: uuid('id').primaryKey(),
    challengeIntervalStart: bigint('challenge_interval_start', {
      mode: 'number',
    }).notNull(),
    displayId: uuid('display_id').notNull(),
    browserFlowHash: text('browser_flow_hash').notNull(),
    capturedAt: timestamptz('captured_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    completedUserId: uuid('completed_user_id'),
    completedEventId: uuid('completed_event_id'),
  },
  (table) => [
    index('attendance_attempts_expires_idx').on(table.expiresAt),
    index('attendance_attempts_flow_idx').on(table.browserFlowHash),
  ],
);

/**
 * Raw attendance event. No entry/exit inference, no duration, no payroll meaning.
 * `attempt_id` is unique: it is the idempotency key for one scanned attempt.
 */
export const attendanceEvents = pgTable(
  'attendance_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    employeeCodeSnapshot: text('employee_code_snapshot').notNull(),
    displayId: uuid('display_id').notNull(),
    attemptId: uuid('attempt_id').notNull().unique(),
    recordedAt: timestamptz('recorded_at').notNull(),
    committedAt: timestamptz('committed_at').notNull(),
  },
  (table) => [
    index('attendance_events_user_time_idx').on(
      table.userId,
      table.recordedAt,
      table.id,
    ),
    index('attendance_events_time_idx').on(table.recordedAt, table.id),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DisplayRow = typeof displays.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type AttendanceAttemptRow = typeof attendanceAttempts.$inferSelect;
export type AttendanceEventRow = typeof attendanceEvents.$inferSelect;

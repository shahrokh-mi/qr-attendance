import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';

import { getConfig } from '@/lib/config';
import type { Database } from '@/lib/db';
import {
  attendanceAttempts,
  attendanceEvents,
  displays,
  users,
} from '@/lib/db/schema';
import type { FlowBinding } from '@/lib/auth/flow';
import type { SessionUser } from '@/lib/auth/session';
import { ApiError, conflict, expired, notFound, unauthenticated } from '@/lib/http/errors';
import { verifyChallenge } from './challenge';
import { getSettings } from './settings';

/**
 * Attendance attempt lifecycle.
 *
 *   POST /attendance/attempts            exchange a valid challenge -> pending attempt
 *   POST /attendance/attempts/:id/complete  authenticated, idempotent -> raw event
 *
 * Exchange happens before login so a first-time employee does not lose the scan while
 * typing credentials. The pending attempt lives for PENDING_ATTEMPT_TTL (2 minutes)
 * measured from exchange; the QR's own 5-second rotation does not matter afterwards.
 *
 * recorded_at is the server time of the exchange (when the employee actually scanned);
 * committed_at is when authentication and the insert finished. Phone clocks are never
 * trusted and no client-supplied time or identity is read.
 */

export interface ExchangedAttempt {
  attemptId: string;
  displayId: string;
  intervalStart: number;
  capturedAt: Date;
  expiresAt: Date;
}

export async function exchangeChallenge(
  db: Database,
  input: { challenge: string; flow: FlowBinding; now?: Date },
): Promise<ExchangedAttempt> {
  const config = getConfig();
  const now = input.now ?? new Date();
  const schedule = await getSettings(db);

  const activeDisplays = await db
    .select({ id: displays.id })
    .from(displays)
    .where(and(eq(displays.active, true), isNull(displays.revokedAt)));

  if (activeDisplays.length === 0) {
    throw expired(
      'invalid_challenge',
      'No entrance display is active. Ask an administrator to provision one.',
    );
  }

  const verified = verifyChallenge({
    secret: config.qrChallengeSecret,
    token: input.challenge,
    displayIds: activeDisplays.map((display) => display.id),
    intervalSeconds: schedule.qrInterval,
    scheduleVersion: schedule.scheduleVersion,
    overlapSeconds: config.qrAcceptanceOverlapSeconds,
    nowMs: now.getTime(),
  });

  if (!verified) {
    throw expired(
      'expired_challenge',
      'This QR code is no longer valid. Scan the code shown on the display again.',
    );
  }

  const attemptId = randomUUID();
  const expiresAt = new Date(now.getTime() + config.pendingAttemptTtlSeconds * 1000);

  await db.insert(attendanceAttempts).values({
    id: attemptId,
    challengeIntervalStart: verified.intervalStart,
    displayId: verified.displayId,
    browserFlowHash: input.flow.tokenHash,
    capturedAt: now,
    expiresAt,
  });

  return {
    attemptId,
    displayId: verified.displayId,
    intervalStart: verified.intervalStart,
    capturedAt: now,
    expiresAt,
  };
}

/** Newest uncompleted attempt bound to this browser flow, if still inside its window. */
export async function findPendingAttempt(
  db: Database,
  flowHash: string,
  now = new Date(),
): Promise<{ id: string; expiresAt: Date } | null> {
  const rows = await db
    .select({ id: attendanceAttempts.id, expiresAt: attendanceAttempts.expiresAt })
    .from(attendanceAttempts)
    .where(
      and(
        eq(attendanceAttempts.browserFlowHash, flowHash),
        isNull(attendanceAttempts.completedEventId),
        gt(attendanceAttempts.expiresAt, now),
      ),
    )
    .orderBy(desc(attendanceAttempts.capturedAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface CompletedReceipt {
  eventId: string;
  recordedAt: string;
  committedAt: string;
  displayId: string;
  employeeCode: string;
  alreadyCompleted: boolean;
}

/**
 * Completes one pending attempt. Idempotent per attempt: repeating the call returns
 * the same event, and a unique constraint on `attendance_events.attempt_id` makes a
 * second insert impossible even under a race.
 */
export async function completeAttempt(
  db: Database,
  input: {
    attemptId: string;
    user: SessionUser;
    flow: FlowBinding | null;
    now?: Date;
  },
): Promise<CompletedReceipt> {
  const now = input.now ?? new Date();
  const { attemptId, user, flow } = input;

  if (!flow) {
    // No browser binding at all: never reveal whether the attempt exists.
    throw unauthenticated('Sign in and scan the code again.');
  }

  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(attendanceAttempts)
      .where(eq(attendanceAttempts.id, attemptId))
      .for('update')
      .limit(1);

    if (!attempt) throw notFound('That attendance attempt could not be found.');
    // A stolen attempt id without the matching flow cookie is indistinguishable
    // from a missing attempt.
    if (attempt.browserFlowHash !== flow.tokenHash) {
      throw notFound('That attendance attempt could not be found.');
    }

    if (attempt.completedEventId) {
      if (attempt.completedUserId && attempt.completedUserId !== user.id) {
        throw conflict('attempt_completed', 'This attendance attempt was already claimed.');
      }
      const [existing] = await tx
        .select()
        .from(attendanceEvents)
        .where(eq(attendanceEvents.id, attempt.completedEventId))
        .limit(1);
      if (existing) {
        return {
          eventId: existing.id,
          recordedAt: existing.recordedAt.toISOString(),
          committedAt: existing.committedAt.toISOString(),
          displayId: existing.displayId,
          employeeCode: existing.employeeCodeSnapshot,
          alreadyCompleted: true,
        };
      }
    }

    if (attempt.expiresAt.getTime() <= now.getTime()) {
      throw expired(
        'attempt_expired',
        'This scan expired before it was confirmed. Scan the code on the display again.',
      );
    }

    const eventId = randomUUID();
    await tx.insert(attendanceEvents).values({
      id: eventId,
      userId: user.id,
      employeeCodeSnapshot: user.employeeCode,
      displayId: attempt.displayId,
      attemptId: attempt.id,
      recordedAt: attempt.capturedAt,
      committedAt: now,
    });

    await tx
      .update(attendanceAttempts)
      .set({ completedUserId: user.id, completedEventId: eventId })
      .where(eq(attendanceAttempts.id, attempt.id));

    return {
      eventId,
      recordedAt: attempt.capturedAt.toISOString(),
      committedAt: now.toISOString(),
      displayId: attempt.displayId,
      employeeCode: user.employeeCode,
      alreadyCompleted: false,
    };
  });
}

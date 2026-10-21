import { and, eq, isNull, lt, or } from 'drizzle-orm';

import type { Database } from '@/lib/db';
import { attendanceAttempts, browserFlows, sessions } from '@/lib/db/schema';

/**
 * Retention schedule (documented in the README):
 *   - sessions: purged 30 days after expiry or revocation
 *   - browser flows: purged 1 day after expiry
 *   - uncompleted attempts: purged 1 day after expiry
 *
 * Attendance events are never touched. This runs from one daily cron and inline in
 * existing write transactions; it never schedules its own write.
 */

const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  sessions: number;
  flows: number;
  attempts: number;
}

export async function cleanupExpired(db: Database, now = new Date()): Promise<CleanupResult> {
  const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
  const shortCutoff = new Date(now.getTime() - SHORT_RETENTION_MS);

  const removedSessions = await db
    .delete(sessions)
    .where(
      or(lt(sessions.expiresAt, sessionCutoff), lt(sessions.revokedAt, sessionCutoff)),
    )
    .returning({ tokenHash: sessions.tokenHash });

  const removedFlows = await db
    .delete(browserFlows)
    .where(lt(browserFlows.expiresAt, shortCutoff))
    .returning({ tokenHash: browserFlows.tokenHash });

  const removedAttempts = await db
    .delete(attendanceAttempts)
    .where(
      and(
        isNull(attendanceAttempts.completedEventId),
        lt(attendanceAttempts.expiresAt, shortCutoff),
      ),
    )
    .returning({ id: attendanceAttempts.id });

  return {
    sessions: removedSessions.length,
    flows: removedFlows.length,
    attempts: removedAttempts.length,
  };
}

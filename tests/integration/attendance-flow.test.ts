import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  completeAttempt,
  exchangeChallenge,
  findPendingAttempt,
} from '@/lib/attendance/attempts';
import { deriveChallengeToken, intervalStartSeconds } from '@/lib/attendance/challenge';
import { getSettings } from '@/lib/attendance/settings';
import { hashPassword } from '@/lib/auth/password';
import { hashToken, type SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/db/bootstrap';
import { DatabaseController } from '@/lib/db/controller';
import { attendanceEvents, displays, users } from '@/lib/db/schema';
import { MemorySnapshotStore } from '@/lib/db/store';

const SECRET = process.env.QR_CHALLENGE_SECRET as string;

/**
 * End-to-end behaviour of the scan flow at the domain level: exchange a derived
 * challenge for a pending attempt, then complete it as an authenticated employee.
 *
 * These are the acceptance criteria that do not need a browser: one attempt produces at
 * most one event, the event is bound to the session identity, the exchange timestamp is
 * preserved, expired codes and attempts create nothing, and a second employee scanning
 * the same displayed code gets an independent event.
 */

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: overrides.id ?? randomUUID(),
    username: 'employee',
    employeeCode: 'EMP-1',
    displayName: 'Employee One',
    role: 'employee',
    active: true,
    defaultPasswordPending: false,
    authenticatedAt: new Date().toISOString(),
    sessionTokenHash: hashToken('token'),
    sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

async function setup() {
  const store = new MemorySnapshotStore();
  const controller = new DatabaseController({
    store,
    seed: (db) => seedDatabase(db, 'admin'),
    logger: () => {},
  });

  const displayId = randomUUID();
  const employeeId = randomUUID();

  await controller.withDatabase(
    async (db) => {
      const now = new Date();
      await db.insert(displays).values({
        id: displayId,
        label: 'Main entrance',
        credentialHash: hashToken('display-credential'),
        active: true,
        createdAt: now,
      });
      await db.insert(users).values({
        id: employeeId,
        employeeCode: 'EMP-100',
        username: 'ali',
        usernameNormalized: 'ali',
        displayName: 'Ali Rezaei',
        passwordHash: await hashPassword('employee-password'),
        role: 'employee',
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    },
    { mode: 'write' },
  );

  const interval = await controller.withDatabase(async (db) => (await getSettings(db)).qrInterval);

  return { controller, store, displayId, employeeId, interval };
}

function tokenAt(
  displayId: string,
  nowMs: number,
  interval: number,
  scheduleVersion = 1,
): string {
  return deriveChallengeToken(SECRET, {
    displayId,
    scheduleVersion,
    intervalSeconds: interval,
    intervalStart: intervalStartSeconds(nowMs, interval),
  });
}

describe('attendance attempt lifecycle', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  it('records exactly one raw event from one scanned code', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-1', tokenHash: hashToken('flow-1') };
    const user = sessionUser({ id: ctx.employeeId, employeeCode: 'EMP-100' });

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );

    expect(attempt.displayId).toBe(ctx.displayId);
    expect(attempt.capturedAt.getTime()).toBe(now.getTime());

    // Complete two seconds later: recorded_at must still be the exchange time.
    const committedAt = new Date(now.getTime() + 2_000);
    const receipt = await ctx.controller.withDatabase(
      (db) => completeAttempt(db, { attemptId: attempt.attemptId, user, flow, now: committedAt }),
      { mode: 'write' },
    );

    expect(receipt.alreadyCompleted).toBe(false);
    expect(receipt.recordedAt).toBe(now.toISOString());
    expect(receipt.committedAt).toBe(committedAt.toISOString());

    const rows = await ctx.controller.withDatabase(async (db) =>
      db.select().from(attendanceEvents),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ctx.employeeId);
    expect(rows[0]?.employeeCodeSnapshot).toBe('EMP-100');
    expect(rows[0]?.attemptId).toBe(attempt.attemptId);
    expect(rows[0]?.recordedAt.toISOString()).toBe(now.toISOString());
  });

  it('is idempotent: completing the same attempt twice yields one event', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-2', tokenHash: hashToken('flow-2') };
    const user = sessionUser({ id: ctx.employeeId });

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );

    const first = await ctx.controller.withDatabase(
      (db) => completeAttempt(db, { attemptId: attempt.attemptId, user, flow, now }),
      { mode: 'write' },
    );
    const second = await ctx.controller.withDatabase(
      (db) =>
        completeAttempt(db, {
          attemptId: attempt.attemptId,
          user,
          flow,
          now: new Date(now.getTime() + 5_000),
        }),
      { mode: 'write' },
    );

    expect(second.eventId).toBe(first.eventId);
    expect(second.alreadyCompleted).toBe(true);

    const [row] = await ctx.controller.withDatabase(async (db) =>
      db.select({ value: count() }).from(attendanceEvents),
    );
    expect(row?.value).toBe(1);
  });

  it('refuses completion from a browser that does not hold the flow binding', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-3', tokenHash: hashToken('flow-3') };
    const otherFlow = { token: 'stolen', tokenHash: hashToken('stolen') };
    const user = sessionUser({ id: ctx.employeeId });

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );

    await expect(
      ctx.controller.withDatabase(
        (db) => completeAttempt(db, { attemptId: attempt.attemptId, user, flow: otherFlow, now }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    // A missing flow is treated as unauthenticated rather than "attempt not found".
    await expect(
      ctx.controller.withDatabase(
        (db) => completeAttempt(db, { attemptId: attempt.attemptId, user, flow: null, now }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 401 });

    const [row] = await ctx.controller.withDatabase(async (db) =>
      db.select({ value: count() }).from(attendanceEvents),
    );
    expect(row?.value).toBe(0);
  });

  it('creates no event for an expired attempt', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-4', tokenHash: hashToken('flow-4') };
    const user = sessionUser({ id: ctx.employeeId });

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );

    await expect(
      ctx.controller.withDatabase(
        (db) =>
          completeAttempt(db, {
            attemptId: attempt.attemptId,
            user,
            flow,
            // Pending attempt TTL is 120s; three minutes is past it.
            now: new Date(now.getTime() + 180_000),
          }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 410, code: 'attempt_expired' });
  });

  it('rejects a code after its interval and overlap have passed', async () => {
    const now = new Date();
    const intervalStart = intervalStartSeconds(now.getTime(), ctx.interval);
    const challenge = deriveChallengeToken(SECRET, {
      displayId: ctx.displayId,
      scheduleVersion: 1,
      intervalSeconds: ctx.interval,
      intervalStart,
    });
    const flow = { token: 'flow-5', tokenHash: hashToken('flow-5') };

    // Five seconds past the interval end + 3s overlap.
    await expect(
      ctx.controller.withDatabase(
        (db) =>
          exchangeChallenge(db, {
            challenge,
            flow,
            now: new Date((intervalStart + ctx.interval + 4) * 1000),
          }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 410, code: 'expired_challenge' });
  });

  it('lets several employees use the same displayed code independently', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const alice = sessionUser({ id: ctx.employeeId, employeeCode: 'EMP-100' });
    const bobId = randomUUID();
    await ctx.controller.withDatabase(
      async (db) => {
        await db.insert(users).values({
          id: bobId,
          employeeCode: 'EMP-200',
          username: 'bob',
          usernameNormalized: 'bob',
          displayName: 'Bob',
          passwordHash: 'scrypt$1$1$1$AA==$AA==',
          role: 'employee',
          active: true,
          createdAt: now,
          updatedAt: now,
        });
      },
      { mode: 'write' },
    );
    const bob = sessionUser({ id: bobId, employeeCode: 'EMP-200', displayName: 'Bob' });

    const aliceFlow = { token: 'alice', tokenHash: hashToken('alice') };
    const bobFlow = { token: 'bob', tokenHash: hashToken('bob') };

    const aliceAttempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow: aliceFlow, now }),
      { mode: 'write' },
    );
    const bobAttempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow: bobFlow, now }),
      { mode: 'write' },
    );

    expect(aliceAttempt.attemptId).not.toBe(bobAttempt.attemptId);

    await ctx.controller.withDatabase(
      (db) => completeAttempt(db, { attemptId: aliceAttempt.attemptId, user: alice, flow: aliceFlow, now }),
      { mode: 'write' },
    );
    await ctx.controller.withDatabase(
      (db) => completeAttempt(db, { attemptId: bobAttempt.attemptId, user: bob, flow: bobFlow, now }),
      { mode: 'write' },
    );

    const rows = await ctx.controller.withDatabase(async (db) =>
      db.select().from(attendanceEvents).orderBy(attendanceEvents.userId),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(2);
  });

  it('finds a pending attempt only while it is still inside its window', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-6', tokenHash: hashToken('flow-6') };

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );

    const pending = await ctx.controller.withDatabase((db) =>
      findPendingAttempt(db, flow.tokenHash, now),
    );
    expect(pending?.id).toBe(attempt.attemptId);

    const stale = await ctx.controller.withDatabase((db) =>
      findPendingAttempt(db, flow.tokenHash, new Date(now.getTime() + 180_000)),
    );
    expect(stale).toBeNull();
  });

  it('invalidates outstanding codes when the schedule interval changes', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-7', tokenHash: hashToken('flow-7') };

    await ctx.controller.withDatabase(
      async (db) => {
        await db.execute(
          sql`update settings set qr_interval = 15, schedule_version = schedule_version + 1 where id = 'singleton'`,
        );
      },
      { mode: 'write' },
    );

    await expect(
      ctx.controller.withDatabase(
        (db) => exchangeChallenge(db, { challenge, flow, now }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 410, code: 'expired_challenge' });
  });

  it('refuses to exchange when no display is active', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-8', tokenHash: hashToken('flow-8') };

    await ctx.controller.withDatabase(
      (db) => db.update(displays).set({ active: false }).where(eq(displays.id, ctx.displayId)),
      { mode: 'write' },
    );

    await expect(
      ctx.controller.withDatabase(
        (db) => exchangeChallenge(db, { challenge, flow, now }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 410, code: 'invalid_challenge' });
  });

  it('persists events across a cold instance (snapshot durability)', async () => {
    const now = new Date();
    const challenge = tokenAt(ctx.displayId, now.getTime(), ctx.interval);
    const flow = { token: 'flow-9', tokenHash: hashToken('flow-9') };
    const user = sessionUser({ id: ctx.employeeId });

    const attempt = await ctx.controller.withDatabase(
      (db) => exchangeChallenge(db, { challenge, flow, now }),
      { mode: 'write' },
    );
    await ctx.controller.withDatabase(
      (db) => completeAttempt(db, { attemptId: attempt.attemptId, user, flow, now }),
      { mode: 'write' },
    );

    // New controller = new serverless instance booting from the stored snapshot.
    const revived = new DatabaseController({
      store: ctx.store,
      seed: (db) => seedDatabase(db, 'admin'),
      logger: () => {},
    });
    const rows = await revived.withDatabase(async (db) => db.select().from(attendanceEvents));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ctx.employeeId);
  });
});

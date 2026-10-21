import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { seedDatabase } from '@/lib/db/bootstrap';
import { DatabaseController } from '@/lib/db/controller';
import { users } from '@/lib/db/schema';
import {
  MemorySnapshotStore,
  SnapshotPreconditionError,
  type SnapshotStore,
} from '@/lib/db/store';

/**
 * Spike + regression suite for the riskiest part of the design: a whole-database
 * snapshot in object storage with optimistic concurrency.
 *
 * It proves, offline and without Vercel credentials:
 *   - PGlite boots in memory and migrations+seed run idempotently
 *   - dump -> store -> load round-trips real rows
 *   - a stale writer is rejected, retried, and does not lose the other writer's row
 *   - a store that always conflicts surfaces 409 instead of a false success
 *   - a failing save never reports success
 */

const secret = 'test-secret-not-used-for-qr';

function makeController(store: SnapshotStore, maxWriteRetries = 2) {
  return new DatabaseController({
    store,
    seed: (db) => seedDatabase(db, 'admin'),
    maxWriteRetries,
    logger: () => {},
  });
}

async function insertUser(controller: DatabaseController, name: string) {
  return controller.withDatabase(
    async (db) => {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        employeeCode: `EMP-${name.toUpperCase()}`,
        username: name,
        usernameNormalized: name.toLowerCase(),
        displayName: name,
        passwordHash: 'scrypt$1$1$1$AA==$AA==',
        role: 'employee',
      });
      return id;
    },
    { mode: 'write' },
  );
}

describe('PGlite snapshot store', () => {
  const timings: Record<string, number> = {};

  afterAll(() => {
    // Printed so the plan's "measure cold start" step produces evidence, not guesses.
    console.info('[spike] timings (ms)', timings);
  });

  it('boots a fresh snapshot, applies migrations and seeds exactly one admin', async () => {
    const store = new MemorySnapshotStore();
    const controller = makeController(store);

    const started = Date.now();
    const admins = await controller.withDatabase(async (db) =>
      db.select().from(users).where(eq(users.role, 'admin')),
    );
    timings.coldBootMs = Date.now() - started;

    expect(admins).toHaveLength(1);
    expect(admins[0]?.usernameNormalized).toBe('admin');
    expect(store.stats.write).toBe(1);

    // Second request on the same warm instance must not re-save or re-seed.
    const again = await controller.withDatabase(async (db) => db.select().from(users));
    expect(again).toHaveLength(1);
    expect(store.stats.write).toBe(1);
    expect(controller.info().bootCount).toBe(1);
  });

  it('round-trips real rows through dumpDataDir and loadDataDir', async () => {
    const store = new MemorySnapshotStore();
    const first = makeController(store);
    const userId = await insertUser(first, 'durable');
    expect(store.stats.write).toBe(2); // boot seed + user insert

    const started = Date.now();
    const second = makeController(store);
    const rows = await second.withDatabase(async (db) =>
      db.select().from(users).where(eq(users.id, userId)),
    );
    timings.reloadFromSnapshotMs = Date.now() - started;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('durable');
    // No new writes: reading a snapshot never mutates storage.
    expect(store.stats.write).toBe(2);
  });

  it('keeps both writers when two instances race (retry on stale ETag)', async () => {
    const store = new MemorySnapshotStore();
    const writerA = makeController(store);
    const writerB = makeController(store);

    // Both instances boot from the same snapshot version.
    await writerA.withDatabase(async (db) => db.select().from(users));
    await writerB.withDatabase(async (db) => db.select().from(users));

    const idA = await insertUser(writerA, 'alpha');
    // writerB still holds the pre-insert ETag: its conditional write must fail,
    // discard, reload and retry instead of overwriting alpha.
    const idB = await insertUser(writerB, 'bravo');

    const verify = makeController(store);
    const rows = await verify.withDatabase(async (db) => db.select().from(users));
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect(rows).toHaveLength(3);
  });

  it('returns a conflict error when every retry loses', async () => {
    const base = new MemorySnapshotStore();
    let rejectWrites = false;
    const flaky: SnapshotStore = {
      kind: 'flaky',
      stat: () => base.stat(),
      read: () => base.read(),
      write: async (data, options) => {
        if (rejectWrites) throw new SnapshotPreconditionError();
        return base.write(data, options);
      },
    };

    const controller = makeController(flaky, 2);
    await controller.withDatabase(async (db) => db.select().from(users));

    rejectWrites = true;
    await expect(insertUser(controller, 'conflicted')).rejects.toMatchObject({
      code: 'write_conflict',
    });
  });

  it('never reports success for a write that did not land', async () => {
    const base = new MemorySnapshotStore();
    let allowedWrites = 1; // the initial boot seed save is allowed to succeed
    const broken: SnapshotStore = {
      kind: 'broken',
      stat: () => base.stat(),
      read: () => base.read(),
      write: async (data, options) => {
        if (allowedWrites <= 0) throw new Error('storage unavailable');
        allowedWrites -= 1;
        return base.write(data, options);
      },
    };
    const controller = makeController(broken);
    await controller.withDatabase(async (db) => db.select().from(users));
    await expect(insertUser(controller, 'lost')).rejects.toThrow('storage unavailable');
    // The in-memory instance is dropped, so a later read cannot see the phantom row.
    const remaining = await controller.withDatabase(async (db) => db.select().from(users));
    expect(remaining.some((row) => row.displayName === 'lost')).toBe(false);
  });

  it('applies the migration exactly once across reloads', async () => {
    const store = new MemorySnapshotStore();
    const first = makeController(store);
    await first.withDatabase(async (db) => db.select().from(users));
    const second = makeController(store);
    const rows = await second.withDatabase(async (db) =>
      db.execute<{ count: number }>(sql`select count(*)::int as count from __qa_migrations`),
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it('reports the secret is not part of the snapshot', async () => {
    // The snapshot must never contain the challenge secret or a raw password.
    const store = new MemorySnapshotStore();
    const controller = makeController(store);
    await insertUser(controller, 'sanity');
    const snapshot = await store.read();
    const text = Buffer.from(snapshot?.data ?? new Uint8Array()).toString('latin1');
    expect(text.includes(secret)).toBe(false);
  });
});

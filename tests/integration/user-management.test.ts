import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDisplayByCredential } from '@/lib/auth/display';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  createSession,
  getSessionUser,
  hashToken,
  revokeAllSessions,
} from '@/lib/auth/session';
import { seedDatabase } from '@/lib/db/bootstrap';
import { DatabaseController } from '@/lib/db/controller';
import { displays, users } from '@/lib/db/schema';
import { MemorySnapshotStore } from '@/lib/db/store';
import { createUser, listUsers, resetPassword, updateUser } from '@/lib/users';

/**
 * User administration rules from the acceptance criteria: unique identities, last-admin
 * protection, and session revocation on deactivation or password reset. These are the
 * checks that stop an administrator from locking everybody (including themselves) out.
 */

async function setup() {
  const store = new MemorySnapshotStore();
  const controller = new DatabaseController({
    store,
    seed: (db) => seedDatabase(db, 'admin'),
    logger: () => {},
  });
  return { controller, store };
}

async function adminId(controller: DatabaseController): Promise<string> {
  return controller.withDatabase(async (db) => {
    const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
    if (!admin) throw new Error('no admin');
    return admin.id;
  });
}

describe('user administration', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  it('creates employees with unique username and employee code', async () => {
    const created = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'Sara',
          employeeCode: 'EMP-10',
          displayName: 'Sara Ahmadi',
          password: 'sara-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );

    // Usernames are stored normalised for uniqueness so case cannot create a second
    // account, while the original spelling is kept for display.
    expect(created.username).toBe('Sara');
    const listed = await ctx.controller.withDatabase((db) =>
      listUsers(db, { page: 1, pageSize: 10 }),
    );
    expect(
      listed.items.some((item) => item.username.toLowerCase() === 'sara'),
    ).toBe(true);

    await expect(
      ctx.controller.withDatabase(
        (db) =>
          createUser(db, {
            username: 'SARA',
            employeeCode: 'EMP-11',
            displayName: 'Duplicate',
            password: 'another-password',
            role: 'employee',
          }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      ctx.controller.withDatabase(
        (db) =>
          createUser(db, {
            username: 'someone',
            employeeCode: 'emp-10',
            displayName: 'Duplicate code',
            password: 'another-password',
            role: 'employee',
          }),
        { mode: 'write' },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('never returns password hashes or session secrets in user DTOs', async () => {
    const created = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'noah',
          employeeCode: 'EMP-20',
          displayName: 'Noah',
          password: 'noah-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );
    expect(Object.keys(created).sort()).toEqual(
      [
        'active',
        'created_at',
        'default_password_pending',
        'display_name',
        'employee_code',
        'id',
        'role',
        'updated_at',
        'username',
      ].sort(),
    );
    expect(JSON.stringify(created)).not.toContain('scrypt$');
  });

  it('refuses to demote or deactivate the last active administrator', async () => {
    const admin = await adminId(ctx.controller);

    await expect(
      ctx.controller.withDatabase((db) => updateUser(db, admin, { role: 'employee' }), {
        mode: 'write',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'last_admin' });

    await expect(
      ctx.controller.withDatabase((db) => updateUser(db, admin, { active: false }), {
        mode: 'write',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'last_admin' });
  });

  it('allows demoting an admin once another active admin exists', async () => {
    const admin = await adminId(ctx.controller);
    await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'secondadmin',
          employeeCode: 'EMP-30',
          displayName: 'Second Admin',
          password: 'second-admin-password',
          role: 'admin',
        }),
      { mode: 'write' },
    );

    const demoted = await ctx.controller.withDatabase(
      (db) => updateUser(db, admin, { role: 'employee' }),
      { mode: 'write' },
    );
    expect(demoted.role).toBe('employee');
  });

  it('deactivation revokes existing sessions immediately', async () => {
    const admin = await adminId(ctx.controller);
    const employee = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'temp',
          employeeCode: 'EMP-40',
          displayName: 'Temp',
          password: 'temp-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );

    const session = await ctx.controller.withDatabase(
      (db) => createSession(db, employee.id),
      { mode: 'write' },
    );

    const before = await ctx.controller.withDatabase((db) =>
      getSessionUser(db, session.token),
    );
    expect(before?.username).toBe('temp');

    await ctx.controller.withDatabase((db) => updateUser(db, employee.id, { active: false }), {
      mode: 'write',
    });

    const after = await ctx.controller.withDatabase((db) => getSessionUser(db, session.token));
    expect(after).toBeNull();
    void admin;
  });

  it('a password reset revokes sessions and installs a working password', async () => {
    const employee = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'resetme',
          employeeCode: 'EMP-50',
          displayName: 'Reset Me',
          password: 'original-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );

    const session = await ctx.controller.withDatabase(
      (db) => createSession(db, employee.id),
      { mode: 'write' },
    );

    await ctx.controller.withDatabase(
      (db) => resetPassword(db, employee.id, 'brand-new-password'),
      { mode: 'write' },
    );

    const stale = await ctx.controller.withDatabase((db) =>
      getSessionUser(db, session.token),
    );
    expect(stale).toBeNull();

    const stored = await ctx.controller.withDatabase(async (db) => {
      const [row] = await db.select().from(users).where(eq(users.id, employee.id)).limit(1);
      return row?.passwordHash as string;
    });
    await expect(verifyPassword('brand-new-password', stored)).resolves.toBe(true);
    await expect(verifyPassword('original-password', stored)).resolves.toBe(false);
  });

  it('revokeAllSessions can spare the current session', async () => {
    const employee = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'multi',
          employeeCode: 'EMP-60',
          displayName: 'Multi',
          password: 'multi-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );

    const keep = await ctx.controller.withDatabase((db) => createSession(db, employee.id), {
      mode: 'write',
    });
    const drop = await ctx.controller.withDatabase((db) => createSession(db, employee.id), {
      mode: 'write',
    });

    await ctx.controller.withDatabase(
      (db) => revokeAllSessions(db, employee.id, new Date(), keep.tokenHash),
      { mode: 'write' },
    );

    const kept = await ctx.controller.withDatabase((db) => getSessionUser(db, keep.token));
    const dropped = await ctx.controller.withDatabase((db) => getSessionUser(db, drop.token));
    expect(kept).not.toBeNull();
    expect(dropped).toBeNull();
  });

  it('rejects an expired session', async () => {
    const employee = await ctx.controller.withDatabase(
      (db) =>
        createUser(db, {
          username: 'expiring',
          employeeCode: 'EMP-70',
          displayName: 'Expiring',
          password: 'expiring-password',
          role: 'employee',
        }),
      { mode: 'write' },
    );

    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const session = await ctx.controller.withDatabase((db) => createSession(db, employee.id, past), {
      mode: 'write',
    });

    const resolved = await ctx.controller.withDatabase((db) =>
      getSessionUser(db, session.token),
    );
    expect(resolved).toBeNull();
  });

  it('a revoked display credential can no longer read the challenge', async () => {
    const displayId = randomUUID();
    await ctx.controller.withDatabase(
      async (db) => {
        await db.insert(displays).values({
          id: displayId,
          label: 'Lobby',
          credentialHash: hashToken('display-secret'),
          active: true,
        });
      },
      { mode: 'write' },
    );

    const active = await ctx.controller.withDatabase((db) =>
      getDisplayByCredential(db, 'display-secret'),
    );
    expect(active?.id).toBe(displayId);

    await ctx.controller.withDatabase(
      (db) =>
        db
          .update(displays)
          .set({ active: false, revokedAt: new Date() })
          .where(eq(displays.id, displayId)),
      { mode: 'write' },
    );

    const revoked = await ctx.controller.withDatabase((db) =>
      getDisplayByCredential(db, 'display-secret'),
    );
    expect(revoked).toBeNull();
  });

  it('keeps the admin password across a cold instance', async () => {
    const admin = await adminId(ctx.controller);
    await ctx.controller.withDatabase(
      async (db) => {
        const passwordHash = await hashPassword('changed-in-first-instance');
        await db
          .update(users)
          .set({ passwordHash, defaultPasswordPending: false })
          .where(eq(users.id, admin));
      },
      { mode: 'write' },
    );

    const revived = new DatabaseController({
      store: ctx.store,
      seed: (db) => seedDatabase(db, 'admin'),
      logger: () => {},
    });
    const stored = await revived.withDatabase(async (db) => {
      const [row] = await db.select().from(users).where(eq(users.id, admin)).limit(1);
      return { hash: row?.passwordHash as string, pending: row?.defaultPasswordPending };
    });

    await expect(verifyPassword('changed-in-first-instance', stored.hash)).resolves.toBe(true);
    // Seeding must not resurrect the default flag on an existing account.
    expect(stored.pending).toBe(false);
  });
});

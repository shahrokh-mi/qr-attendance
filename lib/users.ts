import { and, count, eq, ilike, or, sql } from 'drizzle-orm';

import { hashPassword } from '@/lib/auth/password';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/policy';
import { revokeAllSessions } from '@/lib/auth/session';
import type { Database } from '@/lib/db';
import { users, type UserRow } from '@/lib/db/schema';
import { conflict, invalidField, notFound } from '@/lib/http/errors';
import { normalizeUsername } from '@/lib/http/validate';

/**
 * User administration. Responses never include password hashes, session secrets or
 * display credentials, so the DTO is an explicit allow-list rather than a spread.
 */

export interface UserDto {
  id: string;
  username: string;
  employee_code: string;
  display_name: string;
  role: 'admin' | 'employee';
  active: boolean;
  default_password_pending: boolean;
  created_at: string;
  updated_at: string;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    employee_code: row.employeeCode,
    display_name: row.displayName,
    role: row.role === 'admin' ? 'admin' : 'employee',
    active: row.active,
    default_password_pending: row.defaultPasswordPending,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ListUsersQuery {
  search?: string | null;
  page: number;
  pageSize: number;
}

export async function listUsers(db: Database, query: ListUsersQuery) {
  const search = query.search?.trim();
  const where = search
    ? or(
        ilike(users.username, `%${search}%`),
        ilike(users.displayName, `%${search}%`),
        ilike(users.employeeCode, `%${search}%`),
      )
    : undefined;

  const [totalRow] = await db.select({ value: count() }).from(users).where(where);
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(users.displayName)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    items: rows.map(toUserDto),
    page: query.page,
    page_size: query.pageSize,
    total: totalRow?.value ?? 0,
  };
}

export interface CreateUserInput {
  username: string;
  employeeCode: string;
  displayName: string;
  password: string;
  role: 'admin' | 'employee';
  active?: boolean;
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
  now = new Date(),
): Promise<UserDto> {
  const usernameNormalized = normalizeUsername(input.username);
  const existing = await db
    .select({ id: users.id, username: users.usernameNormalized, code: users.employeeCode })
    .from(users)
    .where(
      or(
        eq(users.usernameNormalized, usernameNormalized),
        sql`lower(${users.employeeCode}) = ${input.employeeCode.toLowerCase()}`,
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const clash = existing[0] as { username: string; code: string };
    if (clash.username.toLowerCase() === usernameNormalized) {
      throw conflict('conflict', 'That username is already taken');
    }
    throw conflict('conflict', 'That employee code is already taken');
  }

  const passwordHash = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      employeeCode: input.employeeCode,
      username: input.username.trim(),
      usernameNormalized,
      displayName: input.displayName,
      passwordHash,
      role: input.role,
      active: input.active ?? true,
      defaultPasswordPending: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) throw new Error('Failed to create user');
  return toUserDto(row);
}

export interface UpdateUserInput {
  username?: string;
  employeeCode?: string;
  displayName?: string;
  role?: 'admin' | 'employee';
  active?: boolean;
}

export async function updateUser(
  db: Database,
  userId: string,
  input: UpdateUserInput,
  now = new Date(),
): Promise<UserDto> {
  const [current] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!current) throw notFound('User not found');

  const nextRole = input.role ?? (current.role as 'admin' | 'employee');
  const nextActive = input.active ?? current.active;

  // Last-admin protection: the system must never be left without an active admin.
  const losingAdmin =
    current.role === 'admin' && current.active && (nextRole !== 'admin' || !nextActive);
  if (losingAdmin && (await activeAdminCount(db)) <= 1) {
    throw conflict(
      'last_admin',
      'This is the last active administrator. Promote another user first.',
    );
  }

  if (input.username) {
    const normalized = normalizeUsername(input.username);
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.usernameNormalized, normalized)))
      .limit(1);
    if (clash.length > 0 && clash[0]?.id !== userId) {
      throw conflict('conflict', 'That username is already taken');
    }
  }

  if (input.employeeCode) {
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.employeeCode}) = ${input.employeeCode.toLowerCase()}`)
      .limit(1);
    if (clash.length > 0 && clash[0]?.id !== userId) {
      throw conflict('conflict', 'That employee code is already taken');
    }
  }

  const [row] = await db
    .update(users)
    .set({
      ...(input.username
        ? { username: input.username.trim(), usernameNormalized: normalizeUsername(input.username) }
        : {}),
      ...(input.employeeCode ? { employeeCode: input.employeeCode } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: now,
    })
    .where(eq(users.id, userId))
    .returning();

  if (!row) throw notFound('User not found');

  // Deactivation must not leave live sessions behind.
  if (input.active === false) {
    await revokeAllSessions(db, userId, now);
  }

  return toUserDto(row);
}

export async function resetPassword(
  db: Database,
  userId: string,
  newPassword: string,
  now = new Date(),
): Promise<UserDto> {
  const [current] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!current) throw notFound('User not found');
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw invalidField('password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const passwordHash = await hashPassword(newPassword);
  const [row] = await db
    .update(users)
    .set({ passwordHash, defaultPasswordPending: false, updatedAt: now })
    .where(eq(users.id, userId))
    .returning();
  if (!row) throw notFound('User not found');
  await revokeAllSessions(db, userId, now);
  return toUserDto(row);
}

export async function activeAdminCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true)));
  return row?.value ?? 0;
}

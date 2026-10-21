import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';

import { hashPassword } from '@/lib/auth/password';
import type { Database } from './controller';
import { settings, users } from './schema';

export const SETTINGS_SINGLETON_ID = 'singleton';
export const DEFAULT_QR_INTERVAL_SECONDS = 5;

/**
 * Idempotent boot seed. Runs on every cold start (after migrations) and must be safe
 * to run repeatedly: it creates the settings row and the initial administrator only
 * when they are absent, and never resets an existing password.
 */
export async function seedDatabase(db: Database, adminPassword: string): Promise<void> {
  await db
    .insert(settings)
    .values({ id: SETTINGS_SINGLETON_ID, qrInterval: DEFAULT_QR_INTERVAL_SECONDS })
    .onConflictDoNothing();

  const [existing] = await db.select({ value: count() }).from(users);
  if ((existing?.value ?? 0) > 0) return;

  const passwordHash = await hashPassword(adminPassword);
  await db
    .insert(users)
    .values({
      id: randomUUID(),
      employeeCode: 'ADMIN',
      username: 'admin',
      usernameNormalized: 'admin',
      displayName: 'Administrator',
      passwordHash,
      role: 'admin',
      active: true,
      // The UI keeps showing a "change the default password" notice until it changes.
      defaultPasswordPending: adminPassword === 'admin',
    })
    .onConflictDoNothing();
}

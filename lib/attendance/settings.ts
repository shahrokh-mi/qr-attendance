import { eq } from 'drizzle-orm';

import { DEFAULT_QR_INTERVAL_SECONDS, SETTINGS_SINGLETON_ID } from '@/lib/db/bootstrap';
import type { Database } from '@/lib/db';
import { settings, type SettingsRow } from '@/lib/db/schema';

/** The schedule lives in one row; changing it is the only settings write. */
export async function getSettings(db: Database): Promise<SettingsRow> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.id, SETTINGS_SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (row) return row;
  // Defensive: a snapshot created before the settings seed still serves a schedule.
  return {
    id: SETTINGS_SINGLETON_ID,
    qrInterval: DEFAULT_QR_INTERVAL_SECONDS,
    scheduleVersion: 1,
    updatedAt: new Date(0),
  };
}

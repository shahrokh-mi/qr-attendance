import { and, desc, eq, isNull } from 'drizzle-orm';
import type { NextRequest } from 'next/server';

import { DISPLAY_COOKIE } from '@/lib/auth/display';
import { hashToken, requireAdmin } from '@/lib/auth/session';
import {
  QR_INTERVAL_MAX_SECONDS,
  QR_INTERVAL_MIN_SECONDS,
} from '@/lib/attendance/challenge';
import { getSettings } from '@/lib/attendance/settings';
import { getConfig } from '@/lib/config';
import { withDatabase, withDatabaseWrite } from '@/lib/db';
import { displays, settings } from '@/lib/db/schema';
import { jsonResponse, withApi } from '@/lib/http/api';
import { invalidField } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, integerField } from '@/lib/http/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * QR rotation schedule plus the provisioned displays.
 *
 * Changing the interval bumps `schedule_version`; the interval boundaries change, so
 * every derived token changes with them. Outstanding unexchanged codes become invalid
 * without any cleanup write.
 */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const credential = request.cookies.get(DISPLAY_COOKIE)?.value;
    const config = getConfig();

    const result = await withDatabase(async (db) => {
      await requireAdmin(db);
      const schedule = await getSettings(db);

      const rows = await db
        .select({
          id: displays.id,
          label: displays.label,
          active: displays.active,
          createdAt: displays.createdAt,
          revokedAt: displays.revokedAt,
        })
        .from(displays)
        .orderBy(desc(displays.createdAt));

      let thisBrowserDisplayId: string | null = null;
      if (credential) {
        const [match] = await db
          .select({ id: displays.id })
          .from(displays)
          .where(
            and(
              eq(displays.credentialHash, hashToken(credential)),
              eq(displays.active, true),
              isNull(displays.revokedAt),
            ),
          )
          .limit(1);
        thisBrowserDisplayId = match?.id ?? null;
      }

      return {
        qr_interval: schedule.qrInterval,
        schedule_version: schedule.scheduleVersion,
        updated_at: schedule.updatedAt.toISOString(),
        interval_bounds: { min: QR_INTERVAL_MIN_SECONDS, max: QR_INTERVAL_MAX_SECONDS },
        display_timezone: config.displayTimezone,
        acceptance_overlap_seconds: config.qrAcceptanceOverlapSeconds,
        displays: rows.map((row) => ({
          id: row.id,
          label: row.label,
          active: row.active,
          created_at: row.createdAt.toISOString(),
          revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
        })),
        this_browser_display_id: thisBrowserDisplayId,
      };
    });

    return jsonResponse(result);
  });
}

export async function PATCH(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const body = asRecord(await readJsonBody(request));
    const interval = integerField(body, 'qr_interval', {
      min: QR_INTERVAL_MIN_SECONDS,
      max: QR_INTERVAL_MAX_SECONDS,
    });
    if (interval === undefined) {
      throw invalidField('qr_interval', 'qr_interval is required');
    }

    const current = await withDatabase(async (db) => {
      await requireAdmin(db);
      return getSettings(db);
    });

    // No-op answers come from a read: an unchanged interval must not cost a snapshot
    // upload (each write is one advanced Blob operation on the free tier).
    if (current.qrInterval === interval) {
      return jsonResponse({
        qr_interval: current.qrInterval,
        schedule_version: current.scheduleVersion,
        updated_at: current.updatedAt.toISOString(),
        changed: false,
      });
    }

    const result = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      const schedule = await getSettings(db);
      if (schedule.qrInterval === interval) {
        return {
          qr_interval: schedule.qrInterval,
          schedule_version: schedule.scheduleVersion,
          updated_at: schedule.updatedAt.toISOString(),
          changed: false,
        };
      }
      const now = new Date();
      const [row] = await db
        .update(settings)
        .set({
          qrInterval: interval,
          scheduleVersion: schedule.scheduleVersion + 1,
          updatedAt: now,
        })
        .where(eq(settings.id, schedule.id))
        .returning();
      return {
        qr_interval: row?.qrInterval ?? interval,
        schedule_version: row?.scheduleVersion ?? schedule.scheduleVersion + 1,
        updated_at: now.toISOString(),
        changed: true,
      };
    });

    return jsonResponse(result);
  });
}

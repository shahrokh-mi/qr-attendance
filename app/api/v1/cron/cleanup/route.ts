import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { cleanupExpired } from '@/lib/cleanup';
import { getConfig } from '@/lib/config';
import { withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { ApiError } from '@/lib/http/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily cleanup, guarded by CRON_SECRET.
 *
 * Vercel Hobby allows one cron per project, once per day, so this is the only
 * scheduled write in the system. It performs a single bounded write (one snapshot
 * upload) and never touches attendance events.
 */
async function handle(request: NextRequest) {
  return withApi(request, {}, async () => {
    const config = getConfig();
    if (!config.cronSecret) {
      throw new ApiError(503, 'forbidden', 'CRON_SECRET is not configured');
    }
    const header = request.headers.get('authorization') ?? '';
    const expected = `Bearer ${config.cronSecret}`;
    const provided = Buffer.from(header);
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      throw new ApiError(401, 'unauthenticated', 'Invalid cron credentials');
    }

    const removed = await withDatabaseWrite((db) => cleanupExpired(db));
    return jsonResponse({ ok: true, removed });
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

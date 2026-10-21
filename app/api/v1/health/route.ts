import type { NextRequest } from 'next/server';

import { getDatabaseController } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Minimal health probe: no secrets, no database boot (that would cost a cold start). */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const info = getDatabaseController().info();
    return jsonResponse({
      status: 'ok',
      server_time: new Date().toISOString(),
      database: { loaded: info.loaded, boot_count: info.bootCount },
    });
  });
}

import type { NextRequest } from 'next/server';

import { withApi } from '@/lib/http/api';
import { notFound } from '@/lib/http/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Catch-all for unmatched API paths.
 *
 * Without it Next would answer with its HTML 404 page, which breaks API clients that
 * expect the documented error envelope. Any method on any unknown `/api/v1/...` path
 * returns JSON.
 */
async function handle(request: NextRequest) {
  return withApi(request, {}, async () => {
    throw notFound(`No API route for ${request.nextUrl.pathname}`);
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;

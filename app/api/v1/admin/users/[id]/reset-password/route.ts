import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/session';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/policy';
import { withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, requiredString, uuidField } from '@/lib/http/validate';
import { resetPassword } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin password reset. Revokes every session the user currently holds. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return withApi(request, { mutating: true }, async () => {
    const { id } = await context.params;
    const userId = uuidField({ id }, 'id');
    const body = asRecord(await readJsonBody(request));
    const password = requiredString(body, 'password', {
      trim: false,
      min: MIN_PASSWORD_LENGTH,
      max: 256,
    });

    const user = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      return resetPassword(db, userId, password);
    });

    return jsonResponse({ user });
  });
}

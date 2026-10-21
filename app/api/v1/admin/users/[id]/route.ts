import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/session';
import { withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { readJsonBody } from '@/lib/http/request';
import { asRecord, enumField, optionalBoolean, optionalString, uuidField } from '@/lib/http/validate';
import { updateUser } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['admin', 'employee'] as const;

/** Edits profile fields, role and active status. Deactivation revokes sessions. */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return withApi(request, { mutating: true }, async () => {
    const { id } = await context.params;
    const body = asRecord(await readJsonBody(request));
    const userId = uuidField({ id }, 'id');

    const update = {
      username: optionalString(body, 'username', { min: 2, max: 60 }),
      employeeCode: optionalString(body, 'employee_code', { min: 1, max: 40 }),
      displayName: optionalString(body, 'display_name', { min: 1, max: 120 }),
      role: enumField(body, 'role', ROLES, true) as 'admin' | 'employee' | undefined,
      active: optionalBoolean(body, 'active'),
    };

    const updated = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      return updateUser(db, userId, update);
    });

    return jsonResponse({ user: updated });
  });
}

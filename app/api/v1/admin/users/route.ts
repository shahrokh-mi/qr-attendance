import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/auth/session';
import { withDatabase, withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { readJsonBody } from '@/lib/http/request';
import {
  asRecord,
  enumField,
  optionalBoolean,
  parsePagination,
  requiredString,
} from '@/lib/http/validate';
import { createUser, listUsers } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROLES = ['admin', 'employee'] as const;

export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const searchParams = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(searchParams);
    const search = searchParams.get('search');

    const result = await withDatabase(async (db) => {
      await requireAdmin(db);
      return listUsers(db, { search, page, pageSize });
    });

    return jsonResponse(result);
  });
}

export async function POST(request: NextRequest) {
  return withApi(request, { mutating: true }, async () => {
    const body = asRecord(await readJsonBody(request));
    const input = {
      username: requiredString(body, 'username', { min: 2, max: 60 }),
      employeeCode: requiredString(body, 'employee_code', { min: 1, max: 40 }),
      displayName: requiredString(body, 'display_name', { min: 1, max: 120 }),
      password: requiredString(body, 'password', {
        trim: false,
        min: 8,
        max: 256,
      }),
      role: enumField(body, 'role', ROLES) as 'admin' | 'employee',
      active: optionalBoolean(body, 'active') ?? true,
    };

    const created = await withDatabaseWrite(async (db) => {
      await requireAdmin(db);
      return createUser(db, input);
    });

    return jsonResponse({ user: created }, 201);
  });
}

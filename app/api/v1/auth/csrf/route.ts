import type { NextRequest } from 'next/server';

import { createFlow, FLOW_COOKIE, attachFlowCookie, getValidFlow } from '@/lib/auth/flow';
import { withDatabase, withDatabaseWrite } from '@/lib/db';
import { jsonResponse, withApi } from '@/lib/http/api';
import { attachCsrfToken, readCsrfToken } from '@/lib/http/csrf';
import { newCsrfToken } from '@/lib/http/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Establishes the browser flow (so a scan can be bound before login) and hands the
 * client a CSRF token. The CSRF cookie is HttpOnly and is echoed back in an
 * `x-csrf-token` header on mutations — a double submit that page script cannot forge.
 */
export async function GET(request: NextRequest) {
  return withApi(request, {}, async () => {
    const existingCsrf = readCsrfToken(request);
    const csrfToken = existingCsrf ?? newCsrfToken();

    const flowCookie = request.cookies.get(FLOW_COOKIE)?.value;
    let flow = await withDatabase((db) => getValidFlow(db, flowCookie));
    let createdFlow = false;

    if (!flow) {
      // One write per browser flow, not per request: the row lives for two hours.
      flow = await withDatabaseWrite((db) => createFlow(db));
      createdFlow = true;
    }

    const response = jsonResponse({
      csrf_token: csrfToken,
      flow_created: createdFlow,
      server_time: new Date().toISOString(),
    });
    attachCsrfToken(response, csrfToken);
    if (createdFlow) attachFlowCookie(response, flow.token);
    return response;
  });
}

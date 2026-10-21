import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';

import type { Database } from '@/lib/db';
import { browserFlows } from '@/lib/db/schema';
import { appendCookie, clearCookie } from '@/lib/http/cookies';
import { hashToken } from './session';

/**
 * Pre-authentication browser binding.
 *
 * A scanned attendance attempt is never completed from an attempt id alone: it also
 * requires this cookie, whose hash is stored on the attempt. That stops a leaked or
 * guessed attempt id from being redeemed in another browser.
 */
export const FLOW_COOKIE = 'qa_flow';
const FLOW_TTL_SECONDS = 60 * 60 * 2;

export function newFlowToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface FlowBinding {
  token: string;
  tokenHash: string;
}

/** Returns the binding when the cookie still maps to a live flow row. */
export async function getValidFlow(
  db: Database,
  token: string | undefined,
  now = new Date(),
): Promise<FlowBinding | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await db
    .select({ tokenHash: browserFlows.tokenHash })
    .from(browserFlows)
    .where(and(eq(browserFlows.tokenHash, tokenHash), gt(browserFlows.expiresAt, now)))
    .limit(1);
  return rows.length > 0 ? { token, tokenHash } : null;
}

/** Inserts a fresh flow row; caller must run this inside a write-mode request. */
export async function createFlow(db: Database, now = new Date()): Promise<FlowBinding> {
  const token = newFlowToken();
  const tokenHash = hashToken(token);
  await db.insert(browserFlows).values({
    tokenHash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + FLOW_TTL_SECONDS * 1000),
  });
  return { token, tokenHash };
}

export function attachFlowCookie(response: Response, token: string): void {
  appendCookie(response, FLOW_COOKIE, token, {
    maxAge: FLOW_TTL_SECONDS,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  });
}

export function clearFlowCookie(response: Response): void {
  clearCookie(response, FLOW_COOKIE);
}

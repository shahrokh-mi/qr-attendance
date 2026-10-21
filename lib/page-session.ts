import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getSessionUser, SESSION_COOKIE, type SessionUser } from '@/lib/auth/session';
import { withDatabase } from '@/lib/db';

/** Server-component gate: redirects to /login when there is no live session. */
export async function requirePageUser(returnTo?: string): Promise<SessionUser> {
  const store = await cookies();
  const user = await withDatabase((db) => getSessionUser(db, store.get(SESSION_COOKIE)?.value));
  if (!user) {
    redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login');
  }
  return user;
}

/** Server-component gate for admin pages: employees are sent to their own history. */
export async function requirePageAdmin(): Promise<SessionUser> {
  const user = await requirePageUser();
  if (user.role !== 'admin') redirect('/attendance');
  return user;
}

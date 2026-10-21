import { redirect } from 'next/navigation';

import { requirePageUser } from '@/lib/page-session';

export const dynamic = 'force-dynamic';

/** Entry point: the only two things this app starts with are history and sign-in. */
export default async function HomePage() {
  await requirePageUser();
  redirect('/attendance');
}

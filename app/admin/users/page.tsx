import { AppShell } from '@/components/app-shell';
import { UsersClient } from '@/components/users-client';
import { requirePageAdmin } from '@/lib/page-session';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const user = await requirePageAdmin();

  return (
    <AppShell
      user={user}
      title="Users"
      description="Pre-register the employees who may record attendance. There is no public sign-up; every account is created here."
    >
      <UsersClient />
    </AppShell>
  );
}

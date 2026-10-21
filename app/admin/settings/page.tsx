import { AppShell } from '@/components/app-shell';
import { SettingsClient } from '@/components/settings-client';
import { requirePageAdmin } from '@/lib/page-session';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const user = await requirePageAdmin();

  return (
    <AppShell
      user={user}
      title="Settings"
      description="Rotation schedule and entrance display provisioning. One company, one entrance in this version; the display identity exists so more can be added later."
    >
      <SettingsClient />
    </AppShell>
  );
}

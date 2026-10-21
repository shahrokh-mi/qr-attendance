import { ChangePasswordForm } from '@/components/change-password-form';
import { AppShell } from '@/components/app-shell';
import { Card, CardHeader } from '@/components/ui';
import { requirePageUser } from '@/lib/page-session';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requirePageUser('/account');

  return (
    <AppShell
      user={user}
      title="Account"
      description="Your employee identity, session details and password."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader title="Identity" description="Stable identifiers used for attendance." />
          <dl className="space-y-3 px-5 py-4 text-sm">
            <Row label="Display name" value={user.displayName} />
            <Row label="Employee code" value={user.employeeCode} mono />
            <Row label="Username" value={user.username} mono />
            <Row label="Role" value={user.role} />
            <Row
              label="Signed in"
              value={new Date(user.authenticatedAt).toISOString().replace('T', ' ').slice(0, 19)}
              mono
            />
            <Row
              label="Session expires"
              value={new Date(user.sessionExpiresAt).toISOString().replace('T', ' ').slice(0, 19)}
              mono
            />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Password"
            description="Changing your password signs out every other browser."
          />
          <ChangePasswordForm />
        </Card>
      </div>

      <p className="text-[11px] leading-relaxed text-mist-500">
        Sessions are opaque random tokens; only a SHA-256 hash is stored on the server. The
        session cookie is HttpOnly and SameSite=Lax, so page scripts cannot read it.
      </p>
    </AppShell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-700/50 pb-2 last:border-0">
      <dt className="text-xs text-mist-500">{label}</dt>
      <dd className={`text-right text-xs text-mist-100 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

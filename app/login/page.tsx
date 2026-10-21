import Link from 'next/link';

import { Brand } from '@/components/brand';
import { LoginForm } from '@/components/login-form';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="qa-fade-up space-y-2">
        <Link href="/login" className="inline-flex">
          <Brand />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-mist-100">Sign in</h1>
        <p className="text-sm text-mist-400">
          Attendance is recorded from the QR code at the entrance. Signing in here records
          nothing by itself.
        </p>
      </div>

      <Card className="qa-fade-up p-5">
        {params.reason === 'session-expired' ? (
          <p className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
            Your session ended. Sign in again to continue.
          </p>
        ) : null}
        <LoginForm next={params.next} />
      </Card>

      <p className="text-center text-[11px] text-mist-500">
        Raw events only — no entry/exit inference, no payroll calculation.
      </p>
    </main>
  );
}

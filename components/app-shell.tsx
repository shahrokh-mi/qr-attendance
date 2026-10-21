import Link from 'next/link';
import type { ReactNode } from 'react';

import { AppNav } from './app-nav';
import { Alert } from './ui';

export function AppShell({
  user,
  title,
  description,
  actions,
  children,
}: {
  user: {
    displayName: string;
    employeeCode: string;
    role: 'admin' | 'employee';
    defaultPasswordPending: boolean;
  };
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <AppNav
        user={{
          displayName: user.displayName,
          employeeCode: user.employeeCode,
          role: user.role,
          defaultPasswordPending: user.defaultPasswordPending,
        }}
      />
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <header className="qa-fade-up flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">
              {title}
            </h1>
            {description ? (
              <p className="max-w-2xl text-xs leading-relaxed text-mist-400">{description}</p>
            ) : null}
          </div>
          {actions}
        </header>

        {user.defaultPasswordPending ? (
          <Alert
            tone="warning"
            title="You are using the default password"
            action={
              <Link
                href="/account"
                className="rounded-md border border-amber-400/40 px-2.5 py-1 text-[11px] font-medium text-amber-400 hover:bg-amber-400/10"
              >
                Change password
              </Link>
            }
          >
            This account still uses the password it was initialised with. Change it before
            this deployment is reachable from outside your network.
          </Alert>
        ) : null}

        {children}
      </main>
    </div>
  );
}

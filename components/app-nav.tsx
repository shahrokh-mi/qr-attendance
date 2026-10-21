'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Brand } from './brand';
import { buttonClass, cn } from './ui';

export interface NavUser {
  displayName: string;
  employeeCode: string;
  role: 'admin' | 'employee';
  defaultPasswordPending: boolean;
}

const NAV_ITEMS = [
  { href: '/attendance', label: 'My attendance', admin: false },
  { href: '/admin/attendance', label: 'All attendance', admin: true },
  { href: '/admin/users', label: 'Users', admin: true },
  { href: '/admin/settings', label: 'Settings', admin: true },
];

export function AppNav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [signingOut, setSigningOut] = useState(false);

  const items = NAV_ITEMS.filter((item) => !item.admin || user.role === 'admin');

  async function signOut() {
    setSigningOut(true);
    try {
      // Logout is a mutation: it needs the CSRF token issued by /auth/csrf.
      const csrfResponse = await fetch('/api/v1/auth/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json()) as { csrf_token?: string };
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf.csrf_token ?? '' },
        cache: 'no-store',
      });
    } finally {
      startTransition(() => {
        router.replace('/login');
        router.refresh();
      });
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link href="/attendance" className="shrink-0">
          <Brand />
        </Link>

        <nav className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto text-sm sm:order-none sm:mx-0 sm:w-auto">
          {items.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== '/attendance' && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-teal-500/12 text-teal-200'
                    : 'text-mist-400 hover:bg-ink-800 hover:text-mist-100',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/account"
            className="hidden text-right sm:block"
            title={`${user.employeeCode} · ${user.role}`}
          >
            <span className="block text-xs font-medium text-mist-200">{user.displayName}</span>
            <span className="block text-[11px] text-mist-500">
              {user.employeeCode} · {user.role}
            </span>
          </Link>
          {user.defaultPasswordPending ? (
            <Link
              href="/account"
              className="hidden rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-400 sm:inline"
            >
              Change default password
            </Link>
          ) : null}
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut || pending}
            className={buttonClass('secondary', 'sm')}
          >
            {signingOut || pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </header>
  );
}

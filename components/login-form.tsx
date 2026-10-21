'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, errorMessage } from '@/lib/api-client';
import { Alert, Button, Field, inputClass } from '@/components/ui';
import { useHydrated } from '@/components/use-hydrated';

interface LoginResponse {
  user: { id: string; display_name: string; role: 'admin' | 'employee' };
  pending_attempt: { id: string; expires_at: string } | null;
}

export type LoginResult = LoginResponse;

/**
 * Sign-in form.
 *
 * With `onSuccess` the caller takes over (the scan page completes its attempt and shows
 * the receipt in place). Without it the form completes any pending attendance attempt
 * the server found for this browser flow, then navigates to history — so a first-time
 * employee never has to scan twice.
 */
export function LoginForm({
  next,
  onSuccess,
}: {
  next?: string;
  onSuccess?: (result: LoginResult) => void | Promise<void>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: { username, password },
      });

      if (onSuccess) {
        await onSuccess(result);
        return;
      }

      if (result.pending_attempt) {
        try {
          await api(`/api/v1/attendance/attempts/${result.pending_attempt.id}/complete`, {
            method: 'POST',
          });
        } catch {
          // The scan may have expired while signing in. The session is still valid;
          // history is the right destination and the employee can scan again.
        }
      }

      router.replace(next && next.startsWith('/') ? next : '/attendance');
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error ? <Alert tone="error" title="Sign-in failed">{error}</Alert> : null}

      <Field label="Username" htmlFor="username">
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className={inputClass}
          placeholder="e.g. admin"
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
          placeholder="••••••••"
        />
      </Field>

      <Button type="submit" size="lg" className="w-full" disabled={busy || !hydrated}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-center text-[11px] leading-relaxed text-mist-500">
        Accounts are created by an administrator. There is no public registration.
      </p>
    </form>
  );
}

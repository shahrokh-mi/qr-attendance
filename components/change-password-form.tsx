'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api-client';
import { Alert, Button, Field, inputClass } from '@/components/ui';
import { useHydrated } from '@/components/use-hydrated';

/** Self-service password change. The server revokes every other session afterwards. */
export function ChangePasswordForm() {
  const hydrated = useHydrated();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setDone(false);

    if (newPassword !== confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }

    setBusy(true);
    try {
      await api('/api/v1/auth/change-password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 px-5 py-5">
      {error ? (
        <Alert tone="error" title="Password not changed">
          {error}
        </Alert>
      ) : null}
      {done ? (
        <Alert tone="success" title="Password changed">
          Other sessions were signed out. This browser stays signed in.
        </Alert>
      ) : null}

      <Field label="Current password" htmlFor="current_password">
        <input
          id="current_password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="New password" htmlFor="new_password" hint="at least 8 characters">
        <input
          id="new_password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="Confirm new password" htmlFor="confirm_password">
        <input
          id="confirm_password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className={inputClass}
        />
      </Field>

      <Button type="submit" disabled={busy || !hydrated}>
        {busy ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  );
}

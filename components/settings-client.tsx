'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Spinner,
  inputClass,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useHydrated } from '@/components/use-hydrated';

interface DisplayRow {
  id: string;
  label: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
}

interface SettingsResponse {
  qr_interval: number;
  schedule_version: number;
  updated_at: string;
  interval_bounds: { min: number; max: number };
  display_timezone: string;
  acceptance_overlap_seconds: number;
  displays: DisplayRow[];
  this_browser_display_id: string | null;
}

/**
 * QR schedule and entrance display provisioning.
 *
 * Two things worth knowing while using this screen:
 *  - shortening the interval immediately invalidates every code already on a display;
 *  - activating a display signs this browser out, because the monitor must not stay
 *    logged in as an administrator.
 */
export function SettingsClient() {
  const hydrated = useHydrated();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [interval, setIntervalValue] = useState('5');
  const [label, setLabel] = useState('Main entrance');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<SettingsResponse>('/api/v1/admin/settings');
      setSettings(result);
      setIntervalValue(String(result.qr_interval));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveInterval() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ qr_interval: number; changed: boolean }>(
        '/api/v1/admin/settings',
        { method: 'PATCH', body: { qr_interval: Number(interval) } },
      );
      setNotice(
        result.changed
          ? `Rotation interval set to ${result.qr_interval}s. Codes already displayed are invalid immediately.`
          : `Rotation interval is already ${result.qr_interval}s.`,
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activateDisplay() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/v1/admin/display/activate', { method: 'POST', body: { label } });
      // Full navigation: the new display cookie must be used by the display page, and
      // this browser's admin session has just been revoked by the server.
      window.location.href = '/display';
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  async function revokeDisplay(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/v1/admin/display/revoke', { method: 'POST', body: { display_id: id } });
      setNotice('Display revoked. It can no longer fetch the current code.');
      setConfirmRevoke(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !settings) {
    return (
      <Card className="px-5 py-8">
        <Spinner label="Loading settings…" />
      </Card>
    );
  }

  if (!settings) {
    return (
      <Alert tone="error" title="Settings unavailable">
        {error ?? 'The settings could not be loaded.'}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="error" title="Action failed">
          {error}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success" title={notice} /> : null}

      <Card>
        <CardHeader
          title="QR rotation"
          description="The code on the entrance display changes on this interval. Shorter intervals are harder to screenshot and reuse; longer intervals are easier to scan."
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[12rem_1fr]">
          <Field
            label="Interval (seconds)"
            htmlFor="qr-interval"
            hint={`${settings.interval_bounds.min}–${settings.interval_bounds.max}`}
          >
            <input
              id="qr-interval"
              type="number"
              min={settings.interval_bounds.min}
              max={settings.interval_bounds.max}
              value={interval}
              onChange={(event) => setIntervalValue(event.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="space-y-2 text-xs leading-relaxed text-mist-400">
            <p>
              Every code is derived from the display identity and the current interval —
              nothing is stored per rotation. Changing this value bumps the schedule version,
              so codes already on a display stop working immediately.
            </p>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-mist-500">
              <div>
                schedule version <span className="text-mist-200">{settings.schedule_version}</span>
              </div>
              <div>
                acceptance overlap{' '}
                <span className="text-mist-200">{settings.acceptance_overlap_seconds}s</span>
              </div>
              <div>
                timezone <span className="text-mist-200">{settings.display_timezone}</span>
              </div>
            </dl>
            <Button size="sm" onClick={saveInterval} disabled={busy || !hydrated}>
              {busy ? 'Saving…' : 'Save interval'}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Entrance displays"
          description="A display is a browser holding a restricted credential: it can read the current code and nothing else. Activating signs this browser out."
        />
        {settings.displays.length === 0 ? (
          <EmptyState title="No display provisioned">
            Open this page on the monitor that will show the code, then activate it below.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-700/60">
            {settings.displays.map((display) => (
              <li
                key={display.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-mist-100">{display.label}</p>
                  <p className="font-mono text-[11px] text-mist-500">
                    {display.id.slice(0, 8)} · created{' '}
                    {display.created_at.slice(0, 16).replace('T', ' ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={display.active ? 'teal' : 'danger'}>
                    {display.active ? 'active' : 'revoked'}
                  </Badge>
                  {display.active ? (
                    confirmRevoke === display.id ? (
                      <span className="flex items-center gap-1.5">
                        <Button size="sm" variant="danger" disabled={!hydrated} onClick={() => revokeDisplay(display.id)}>
                          Confirm revoke
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirmRevoke(display.id)}
                      >
                        Revoke
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-end gap-3 border-t border-ink-700/70 bg-ink-900/40 px-5 py-4">
          <div className="min-w-56 flex-1">
            <Field label="Display label" htmlFor="display-label" hint="shown on the entrance screen">
              <input
                id="display-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className={inputClass}
                maxLength={80}
              />
            </Field>
          </div>
          <Button onClick={activateDisplay} disabled={busy || !hydrated || label.trim().length === 0}>
            {busy ? 'Activating…' : 'Activate this browser as display'}
          </Button>
        </div>
        <p className="border-t border-ink-700/70 px-5 py-3 text-[11px] leading-relaxed text-mist-500">
          You will be signed out here and sent to the full-screen display. To come back,
          sign in again on another browser or on this one after revoking the display.
        </p>
      </Card>
    </div>
  );
}

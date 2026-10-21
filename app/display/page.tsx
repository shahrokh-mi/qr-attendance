'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

interface Challenge {
  token: string;
  display_id: string;
  display_label: string;
  qr_url: string;
  server_time: string;
  next_rotation: string;
  expires_at: string;
  qr_interval: number;
  schedule_version: number;
  acceptance_overlap: number;
  display_timezone: string;
}

type ConnectionState = 'connecting' | 'live' | 'offline' | 'unprovisioned';

/**
 * Full-screen entrance display.
 *
 * The challenge is derived server-side from (display id, interval start), so polling
 * once per second costs no database writes. The QR is rendered locally with the
 * `qrcode` package — no third-party script, image or font is loaded on this page, and
 * the URL never leaves this origin (Referrer-Policy: no-referrer on /display).
 *
 * The code is only presented as usable while the server is reachable and the derived
 * expiry has not passed. A five-second rotation is fraud deterrence, not proof of
 * physical presence.
 */
export default function DisplayPage() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [offsetMs, setOffsetMs] = useState(0);

  const stoppedRef = useRef(false);

  // 1. Poll the challenge once per second.
  useEffect(() => {
    stoppedRef.current = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const response = await fetch('/api/v1/display/challenge', { cache: 'no-store' });
        if (response.status === 401 || response.status === 403) {
          setConnection('unprovisioned');
          setChallenge(null);
          setQrDataUrl(null);
          return;
        }
        if (!response.ok) throw new Error('bad status');
        const data = (await response.json()) as Challenge;
        setChallenge(data);
        setOffsetMs(new Date(data.server_time).getTime() - Date.now());
        setConnection('live');
        setMessage(null);
      } catch {
        setConnection((current) => (current === 'unprovisioned' ? current : 'offline'));
        setMessage('Cannot reach the server. This code may already be invalid.');
      } finally {
        if (!stoppedRef.current) timer = window.setTimeout(poll, 1000);
      }
    }

    void poll();
    return () => {
      stoppedRef.current = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // 2. Render the QR locally whenever the token changes.
  useEffect(() => {
    if (!challenge) return;
    let cancelled = false;
    QRCode.toDataURL(challenge.qr_url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 1024,
      color: { dark: '#041210', light: '#f2fffc' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [challenge]);

  // 3. Clock for the countdown and the on-screen time.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);

  const serverNow = now + offsetMs;
  const nextRotation = challenge ? new Date(challenge.next_rotation).getTime() : 0;
  const expiresAt = challenge ? new Date(challenge.expires_at).getTime() : 0;
  const remainingMs = Math.max(0, nextRotation - serverNow);
  const usable =
    connection === 'live' && challenge !== null && serverNow < expiresAt && remainingMs > 0;
  const progress = challenge ? Math.min(1, remainingMs / (challenge.qr_interval * 1000)) : 0;

  if (connection === 'unprovisioned') {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-400">
            qr-attendance
          </p>
          <h1 className="text-xl font-semibold text-mist-100">This monitor is not a display</h1>
          <p className="text-sm leading-relaxed text-mist-400">
            An administrator must activate this browser as an entrance display from Settings.
            Activation signs that administrator out of this browser.
          </p>
          <Link
            href="/login"
            className="inline-block rounded-lg border border-ink-600 px-4 py-2 text-xs font-medium text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
          >
            Go to sign-in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="qa-display-grid flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-5 sm:px-10">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`h-2.5 w-2.5 rounded-full ${
              connection === 'live' ? 'bg-teal-400' : 'bg-rose-400'
            }`}
          />
          <div>
            <p className="text-sm font-medium text-mist-100">
              {challenge?.display_label ?? 'Entrance display'}
            </p>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-mist-500">
              {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting' : 'offline'}
              {challenge ? ` · rotates every ${challenge.qr_interval}s` : ''}
            </p>
          </div>
        </div>

        <div className="text-right">
          <p className="font-mono text-2xl tabular-nums text-mist-100 sm:text-3xl">
            {new Intl.DateTimeFormat('en-GB', {
              timeZone: challenge?.display_timezone ?? 'UTC',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(new Date(serverNow))}
          </p>
          <p className="font-mono text-[11px] text-mist-500">
            {challenge?.display_timezone ?? 'UTC'}
          </p>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-10">
        <div className="text-center">
          <h1 className="text-lg font-medium text-mist-100 sm:text-xl">
            Scan to record your attendance
          </h1>
          <p className="mt-1 text-xs text-mist-400">
            Open the camera on your phone and point it at the code. No app required.
          </p>
        </div>

        <div className="relative">
          <div
            className={`relative rounded-2xl bg-[#f2fffc] p-3 shadow-[0_30px_80px_-40px_rgba(45,212,191,0.55)] transition-opacity duration-200 sm:p-4 ${
              usable ? 'opacity-100' : 'opacity-30'
            }`}
          >
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Attendance QR code"
                className="h-[46vh] w-[46vh] max-h-[520px] max-w-[520px]"
              />
            ) : (
              <div className="grid h-[46vh] w-[46vh] max-h-[520px] max-w-[520px] place-items-center text-xs text-ink-800">
                Preparing code…
              </div>
            )}
          </div>

          {!usable ? (
            <div className="absolute inset-0 grid place-items-center rounded-2xl bg-ink-950/70 px-4 text-center">
              <div className="space-y-1">
                <p className="text-sm font-medium text-mist-100">
                  {connection === 'live' ? 'Refreshing code…' : 'Code unavailable'}
                </p>
                <p className="text-xs text-mist-400">
                  {connection === 'live'
                    ? 'Wait for the next code before scanning.'
                    : 'The server is unreachable. Do not scan this code.'}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="w-full max-w-md space-y-2">
          <div className="h-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full bg-teal-400 transition-[width] duration-200 ease-linear"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between font-mono text-[11px] text-mist-500">
            <span>
              {connection === 'live'
                ? `next code in ${(remainingMs / 1000).toFixed(1)}s`
                : connection === 'connecting'
                  ? 'connecting…'
                  : 'offline'}
            </span>
            <span>
              {challenge ? `schedule v${challenge.schedule_version}` : '—'}
            </span>
          </div>
          {message ? (
            <p className="text-center text-[11px] text-rose-400">{message}</p>
          ) : (
            <p className="text-center text-[11px] text-mist-500">
              Scanning records a raw event with the server time. Nothing is inferred.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

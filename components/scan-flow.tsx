'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { LoginForm } from '@/components/login-form';
import { Alert, Badge, Card, Spinner } from '@/components/ui';
import { api, errorCode, errorMessage, formatTime } from '@/lib/api-client';

interface AttemptResponse {
  attempt_id: string;
  display_id: string;
  expires_at: string;
  requires_login: boolean;
}

interface CompleteResponse {
  receipt: {
    event_id: string;
    recorded_at: string;
    recorded_time_local: string;
    employee_code: string;
    already_completed: boolean;
  };
  user: { display_name: string; employee_code: string };
  today: Array<{ id: string; recorded_at: string; recorded_time_local?: string }>;
  display_timezone: string;
}

type Phase = 'starting' | 'login' | 'completing' | 'done' | 'error';

/**
 * The scan landing flow.
 *
 *   read challenge -> establish CSRF/browser flow -> exchange for a pending attempt
 *   -> complete automatically (session present) or sign in first (2 minute window)
 *
 * The GET that renders this page records nothing: the POST exchange does, and only after
 * the server has validated the challenge by recomputation. The challenge is stripped from
 * the address bar after exchange so a refresh cannot submit a second event.
 *
 * Not using an effect-driven `startedRef` alone would double-exchange under React
 * StrictMode in development, which is why the ref guard exists.
 */
export function ScanFlow() {
  const searchParams = useSearchParams();
  const challenge = searchParams.get('challenge');

  const [phase, setPhase] = useState<Phase>('starting');
  const [attempt, setAttempt] = useState<{ id: string; expires_at: string } | null>(null);
  const [receipt, setReceipt] = useState<CompleteResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const startedRef = useRef(false);

  const complete = useCallback(async (attemptId: string) => {
    setPhase('completing');
    try {
      const result = await api<CompleteResponse>(
        `/api/v1/attendance/attempts/${attemptId}/complete`,
        { method: 'POST' },
      );
      setReceipt(result);
      setPhase('done');
    } catch (cause) {
      const code = errorCode(cause);
      if (code === 'unauthenticated') {
        // The session vanished between exchange and completion: ask to sign in again.
        setAttempt((current) =>
          current ?? { id: attemptId, expires_at: new Date().toISOString() },
        );
        setPhase('login');
        return;
      }
      setError({
        code,
        message:
          code === 'attempt_expired' || code === 'expired_challenge'
            ? 'This scan is no longer valid. Scan the QR code on the display again.'
            : errorMessage(cause),
      });
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function run() {
      if (!challenge) {
        setError({
          code: 'missing_challenge',
          message:
            'Open this page by scanning the QR code shown on the entrance display. Point your phone camera at the code.',
        });
        setPhase('error');
        return;
      }

      try {
        const attemptResult = await api<AttemptResponse>('/api/v1/attendance/attempts', {
          method: 'POST',
          body: { challenge },
        });

        // Strip the token from the address bar and history so a refresh, a shared link or
        // a screenshot cannot replay the scan.
        window.history.replaceState({}, '', '/scan');
        setAttempt({ id: attemptResult.attempt_id, expires_at: attemptResult.expires_at });

        if (attemptResult.requires_login) {
          setPhase('login');
          return;
        }
        await complete(attemptResult.attempt_id);
      } catch (cause) {
        setError({ code: errorCode(cause), message: errorMessage(cause) });
        setPhase('error');
      }
    }

    void run();
  }, [challenge, complete]);

  useEffect(() => {
    if (phase !== 'login' || !attempt) return;
    const deadline = new Date(attempt.expires_at).getTime();
    const tick = () => setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [phase, attempt]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-5 px-4 py-10">
      <div className="qa-fade-up space-y-1 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-400">
          qr-attendance
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-mist-100">
          {phase === 'done' ? 'Attendance recorded' : 'Recording your attendance'}
        </h1>
      </div>

      <Card className="qa-fade-up p-5">
        <div className="space-y-4">
          {phase === 'starting' ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner label="Validating the code on the display…" />
              <p className="text-xs text-mist-500">This takes a moment.</p>
            </div>
          ) : null}

          {phase === 'completing' ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner label="Recording the event…" />
              <p className="text-xs text-mist-500">
                Waiting for the server to confirm the insert.
              </p>
            </div>
          ) : null}

          {phase === 'login' ? (
            <div className="space-y-4">
              <Alert tone="info" title="One more step">
                Sign in to attach this scan to your employee record.
                {secondsLeft !== null ? (
                  <span className="mt-1 block font-mono text-[11px] text-mist-400">
                    This scan is held for {secondsLeft}s.
                  </span>
                ) : null}
              </Alert>
              <LoginForm
                onSuccess={async (result) => {
                  const id = result.pending_attempt?.id ?? attempt?.id;
                  if (!id) {
                    setError({
                      code: 'attempt_not_found',
                      message: 'That scan is no longer held. Scan the QR code again.',
                    });
                    setPhase('error');
                    return;
                  }
                  await complete(id);
                }}
              />
            </div>
          ) : null}

          {phase === 'done' && receipt ? (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-2 py-2">
                <span className="relative grid h-12 w-12 place-items-center rounded-full bg-teal-500/15 qa-pulse-ring">
                  <svg viewBox="0 0 24 24" className="h-6 w-6 text-teal-300" fill="none">
                    <path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <p className="font-mono text-3xl font-semibold tabular-nums text-mist-100">
                  {receipt.receipt.recorded_time_local}
                </p>
                <p className="text-sm text-mist-300">{receipt.user.display_name}</p>
                <p className="font-mono text-[11px] text-mist-500">
                  {receipt.user.employee_code}
                </p>
              </div>

              <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-4 py-3">
                <div className="flex items-center justify-between text-xs text-mist-400">
                  <span>Attendance event</span>
                  <Badge tone="teal">Recorded</Badge>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-mist-500">
                  A raw event with the server timestamp. Nothing was inferred — no entry or
                  exit, no duration.
                </p>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-mist-300">Today</p>
                {receipt.today.length === 0 ? (
                  <p className="text-xs text-mist-500">No other events today.</p>
                ) : (
                  <ul className="divide-y divide-ink-700/70 overflow-hidden rounded-lg border border-ink-700">
                    {receipt.today.map((event) => (
                      <li
                        key={event.id}
                        className="flex items-center justify-between bg-ink-900/40 px-4 py-2 text-xs"
                      >
                        <span className="font-mono tabular-nums text-mist-200">
                          {event.recorded_time_local ??
                            formatTime(event.recorded_at, receipt.display_timezone)}
                        </span>
                        <span className="text-mist-500">Attendance event</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Link
                href="/attendance"
                className="block rounded-lg bg-teal-500 px-4 py-2.5 text-center text-sm font-medium text-ink-950 transition-colors hover:bg-teal-400"
              >
                View my attendance
              </Link>
            </div>
          ) : null}

          {phase === 'error' && error ? (
            <div className="space-y-4">
              <Alert tone="error" title="Attendance not recorded">
                {error.message}
              </Alert>
              <p className="text-xs leading-relaxed text-mist-400">
                Nothing was saved. The code on the display changes every few seconds — scan
                the current code, not a screenshot.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/attendance"
                  className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-medium text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
                >
                  My attendance
                </Link>
                <Link
                  href="/login"
                  className="rounded-lg border border-ink-600 px-3 py-2 text-xs font-medium text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
                >
                  Sign in
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <p className="text-center text-[11px] text-mist-500">
        Server time is authoritative. Your phone clock is never used.
      </p>
    </main>
  );
}

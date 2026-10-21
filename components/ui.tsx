import type { ReactNode } from 'react';

/** Tiny class-name joiner; avoids a dependency for a handful of variants. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-teal-500 text-ink-950 hover:bg-teal-400 focus-visible:bg-teal-400 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]',
  secondary:
    'bg-ink-800 text-mist-100 border border-ink-600 hover:border-teal-600 hover:text-teal-200',
  ghost: 'text-mist-300 hover:text-teal-200 hover:bg-ink-800',
  danger: 'bg-rose-400/10 text-rose-400 border border-rose-400/35 hover:bg-rose-400/20',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button type={type} className={cn(buttonClass(variant, size), className)} {...props}>
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-ink-700/80 bg-ink-850/80 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_18px_40px_-30px_rgba(0,0,0,0.9)] backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700/70 px-5 py-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-wide text-mist-100">{title}</h2>
        {description ? (
          <p className="max-w-2xl text-xs leading-relaxed text-mist-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-mist-300">
        {children}
      </label>
      {hint ? <span className="text-[11px] text-mist-500">{hint}</span> : null}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-900/80 px-3 py-2 text-sm text-mist-100 placeholder:text-mist-500 transition-colors hover:border-ink-600 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/25';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

const ALERT_TONES: Record<AlertTone, string> = {
  info: 'border-ink-600 bg-ink-800/70 text-mist-200',
  success: 'border-teal-600/60 bg-teal-600/10 text-teal-200',
  warning: 'border-amber-400/40 bg-amber-400/10 text-amber-400',
  error: 'border-rose-400/40 bg-rose-400/10 text-rose-400',
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', ALERT_TONES[tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {title ? <p className="font-medium">{title}</p> : null}
          {children ? <div className="text-xs leading-relaxed opacity-90">{children}</div> : null}
        </div>
        {action}
      </div>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'teal' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'border-ink-600 bg-ink-800 text-mist-300',
    teal: 'border-teal-600/60 bg-teal-600/10 text-teal-200',
    warning: 'border-amber-400/40 bg-amber-400/10 text-amber-400',
    danger: 'border-rose-400/40 bg-rose-400/10 text-rose-400',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-mist-400">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-600 border-t-teal-400"
      />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-medium text-mist-200">{title}</p>
      {children ? <p className="max-w-sm text-xs text-mist-400">{children}</p> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} hint={hint}>
        {label}
      </Label>
      {children}
    </div>
  );
}

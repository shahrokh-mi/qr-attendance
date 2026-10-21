/** Wordmark: a small QR glyph plus the product name. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden
        className="relative grid h-8 w-8 place-items-center rounded-lg border border-teal-600/50 bg-ink-800"
      >
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor">
          <g strokeWidth="1.8" className="text-teal-300">
            <rect x="3" y="3" width="6.5" height="6.5" rx="1.4" />
            <rect x="14.5" y="3" width="6.5" height="6.5" rx="1.4" />
            <rect x="3" y="14.5" width="6.5" height="6.5" rx="1.4" />
          </g>
          <g strokeWidth="1.8" className="text-teal-500">
            <path d="M14.5 14.5h2.5v2.5h-2.5z" />
            <path d="M19 19h2v2h-2z" />
            <path d="M14.5 20.5h1.5M20.5 14.5V16" />
          </g>
        </svg>
      </span>
      {!compact ? (
        <span className="font-mono text-sm font-semibold tracking-tight text-mist-100">
          qr-attendance
        </span>
      ) : null}
    </span>
  );
}

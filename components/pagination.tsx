import Link from 'next/link';

/** Server-rendered pagination that preserves the current filters. */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) {
    return (
      <p className="px-5 py-3 text-[11px] text-mist-500">
        {total} {total === 1 ? 'event' : 'events'}
      </p>
    );
  }

  const buildHref = (targetPage: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    if (targetPage > 1) search.set('page', String(targetPage));
    const query = search.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const linkClass =
    'rounded-md border border-ink-600 px-2.5 py-1.5 text-xs text-mist-300 transition-colors hover:border-teal-600 hover:text-teal-200';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700/70 px-5 py-3">
      <p className="text-[11px] text-mist-500">
        Page {page} of {pages} · {total} {total === 1 ? 'event' : 'events'}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={buildHref(page - 1)} className={linkClass}>
            Previous
          </Link>
        ) : (
          <span className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-mist-500 opacity-50">
            Previous
          </span>
        )}
        {page < pages ? (
          <Link href={buildHref(page + 1)} className={linkClass}>
            Next
          </Link>
        ) : (
          <span className="rounded-md border border-ink-700 px-2.5 py-1.5 text-xs text-mist-500 opacity-50">
            Next
          </span>
        )}
      </div>
    </div>
  );
}

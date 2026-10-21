'use client';

import { useEffect, useState } from 'react';

/**
 * True once the component is running in the browser.
 *
 * Forms hold credentials and trigger mutations, so their submit buttons stay disabled
 * until React has hydrated. Without this a click (or Enter) that lands before hydration
 * makes the browser perform a native form submission — which would put a password in the
 * URL. Playwright's actionability checks wait for `enabled`, so tests are unaffected.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

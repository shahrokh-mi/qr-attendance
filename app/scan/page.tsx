import { Suspense } from 'react';

import { ScanFlow } from '@/components/scan-flow';
import { Spinner } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Public scan landing. No session is required: a first-time employee exchanges the QR
 * for a pending attempt here, then signs in.
 */
export default function ScanPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center">
          <Spinner label="Opening…" />
        </main>
      }
    >
      <ScanFlow />
    </Suspense>
  );
}

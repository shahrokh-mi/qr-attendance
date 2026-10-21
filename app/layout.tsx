import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'qr-attendance',
  description:
    'Entrance QR attendance: raw server-timestamped events, no inference, no payroll.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#05090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

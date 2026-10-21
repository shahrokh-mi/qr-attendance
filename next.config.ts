import type { NextConfig } from 'next';

/**
 * Security headers. CSP keeps everything self-hosted: the app loads no third-party
 * scripts, fonts or images, and the scan/display routes must stay fully offline-capable
 * with respect to third parties.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts. In development React also needs eval() to
  // reconstruct call stacks for its debugging overlays; production never does.
  process.env.NODE_ENV === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Tailwind and React inline styles are used for the QR layout.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const baseSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Development only: allow the dev server to be reached by IP as well as localhost
  // (phone-on-the-same-Wi-Fi testing, Playwright on 127.0.0.1). No effect in production.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // PGlite ships WASM + a Postgres data tarball that it reads from its own package
  // directory at runtime; bundling it breaks those lookups.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Trace the WASM runtime and the embedded Postgres assets into the serverless
  // function bundle. Without this the function boots with a missing postgres.wasm.
  outputFileTracingIncludes: {
    '/api/v1/**/*': ['./node_modules/@electric-sql/pglite/dist/**/*'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: baseSecurityHeaders,
      },
      {
        // The scan landing page never leaks its URL (and therefore its challenge)
        // to any third party through the Referer header.
        source: '/scan',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/api/v1/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
      {
        // The database snapshot lives in Blob, not in a static asset.
        source: '/display',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
};

export default nextConfig;

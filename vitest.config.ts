import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname as string),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // PGlite boots are heavy; keep the integration suites serial.
    pool: 'forks',
    fileParallelism: false,
    // Deterministic configuration for every suite (lib/config reads these once).
    env: {
      QR_CHALLENGE_SECRET: 'test-secret-at-least-thirty-two-characters',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      STORAGE_MODE: 'file',
      COOKIE_SECURE: 'false',
      TRUST_FORWARDED_FOR: 'false',
      DISPLAY_TIMEZONE: 'Asia/Tehran',
      BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      CRON_SECRET: 'test-cron-secret',
      NODE_ENV: 'test',
    },
  },
});

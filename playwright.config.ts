import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * End-to-end suite. It runs against a real Next.js dev server with a disposable local
 * snapshot directory, so it exercises the same code path a phone would: cookies, CSRF,
 * the derived challenge, the create-on-scan journey and role separation.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PUBLIC_BASE_URL: baseURL,
      STORAGE_MODE: 'file',
      LOCAL_DATA_DIR: './data/e2e',
      QR_CHALLENGE_SECRET: 'e2e-secret-at-least-thirty-two-characters',
      COOKIE_SECURE: 'false',
      TRUST_FORWARDED_FOR: 'false',
      DISPLAY_TIMEZONE: 'Asia/Tehran',
      BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      CRON_SECRET: 'e2e-cron-secret',
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});

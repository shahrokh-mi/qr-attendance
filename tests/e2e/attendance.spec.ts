import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The journeys a small company actually performs:
 *   1. admin signs in, changes the schedule, creates employees
 *   2. a monitor is provisioned as the entrance display
 *   3. the first scan signs an employee in and records one event
 *   4. later scans need no sign-in
 *   5. employees cannot reach admin surfaces; admins see every event
 *   6. mutations without a CSRF token are refused, and deep links are served
 */

const ADMIN = { username: 'admin', password: 'admin' };
const EMPLOYEE = { username: 'ali', password: 'employee-password' };

async function signIn(page: Page, user: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/attendance$/);
}

async function challengeFor(context: BrowserContext): Promise<string> {
  const response = await context.request.get('/api/v1/display/challenge');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { qr_url: string; token: string };
  expect(body.qr_url).toContain('/scan?challenge=');
  return body.qr_url;
}

test.describe.configure({ mode: 'serial' });

test('admin signs in, is warned about the default password, and creates an employee', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await expect(page.getByText('You are using the default password')).toBeVisible();

  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'New user' }).click();
  await page.getByLabel('Employee code').fill('EMP-100');
  await page.getByLabel('Display name').fill('Ali Rezaei');
  await page.getByLabel('Initial password').fill(EMPLOYEE.password);
  await page.getByLabel('Role').selectOption('employee');
  // Username last: the label also exists in the row editor once it opens.
  await page.getByLabel('Username').fill(EMPLOYEE.username);
  await page.getByRole('button', { name: 'Create user' }).click();

  await expect(page.getByText('Ali Rezaei')).toBeVisible();
  await expect(page.getByText('EMP-100')).toBeVisible();
});

test('the schedule interval can be changed and is persisted', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/admin/settings');

  const interval = page.getByLabel('Interval (seconds)');
  await interval.fill('7');
  await page.getByRole('button', { name: 'Save interval' }).click();
  await expect(page.getByText(/Rotation interval set to 7s/)).toBeVisible();

  // Reload: the value must come from the database, not from component state.
  await page.reload();
  await expect(page.getByLabel('Interval (seconds)')).toHaveValue('7');

  // Restore a short interval so the scan test does not race a slow CI machine.
  await page.getByLabel('Interval (seconds)').fill('15');
  await page.getByRole('button', { name: 'Save interval' }).click();
});

test('employee scans, signs in once, and later scans without signing in', async ({ browser }) => {
  // --- provision the monitor -------------------------------------------------------
  const displayContext = await browser.newContext();
  const displayPage = await displayContext.newPage();
  await signIn(displayPage, ADMIN);
  await displayPage.goto('/admin/settings');
  await displayPage.getByLabel('Display label').fill('Main entrance');
  await displayPage.getByRole('button', { name: 'Activate this browser as display' }).click();
  await expect(displayPage).toHaveURL(/\/display$/);
  await expect(displayPage.getByText('Scan to record your attendance')).toBeVisible();

  // The admin session on this monitor is revoked by the activation request.
  const adminStillValid = await displayContext.request.get('/api/v1/auth/me');
  expect(adminStillValid.status()).toBe(401);

  // --- first scan: sign in, then the receipt appears -------------------------------
  const employeeContext = await browser.newContext();
  const employeePage = await employeeContext.newPage();

  const firstScanUrl = await challengeFor(displayContext);
  await employeePage.goto(firstScanUrl);
  await expect(employeePage.getByText('One more step')).toBeVisible();
  await employeePage.getByLabel('Username').fill(EMPLOYEE.username);
  await employeePage.getByLabel('Password').fill(EMPLOYEE.password);
  await employeePage.getByRole('button', { name: 'Sign in' }).click();

  await expect(employeePage.getByText('Attendance recorded')).toBeVisible();
  // The challenge must be stripped from the address bar after exchange.
  await expect(employeePage).toHaveURL(/\/scan$/);

  await employeePage.getByRole('link', { name: 'View my attendance' }).click();
  await expect(employeePage).toHaveURL(/\/attendance/);
  await expect(employeePage.getByText('Attendance event').first()).toBeVisible();

  // --- second scan, already signed in: no login form --------------------------------
  const secondScanUrl = await challengeFor(displayContext);
  await employeePage.goto(secondScanUrl);
  await expect(employeePage.getByText('Attendance recorded')).toBeVisible();
  await expect(employeePage.getByText('One more step')).toHaveCount(0);

  await employeePage.getByRole('link', { name: 'View my attendance' }).click();
  await expect(employeePage.getByText('Attendance event')).toHaveCount(2);

  await displayContext.close();
  await employeeContext.close();
});

test('roles are enforced on the server, not just the UI', async ({ browser }) => {
  const employeeContext = await browser.newContext();
  const employeePage = await employeeContext.newPage();
  await signIn(employeePage, EMPLOYEE);

  // Page-level: employees are redirected away from admin routes.
  await employeePage.goto('/admin/users');
  await expect(employeePage).toHaveURL(/\/attendance$/);

  // API-level: a direct call is refused even with a valid CSRF token.
  const csrf = await employeeContext.request.get('/api/v1/auth/csrf');
  const { csrf_token: token } = (await csrf.json()) as { csrf_token: string };
  const listResponse = await employeeContext.request.get('/api/v1/admin/users');
  expect(listResponse.status()).toBe(403);

  const createResponse = await employeeContext.request.post('/api/v1/admin/users', {
    headers: { 'x-csrf-token': token },
    data: {
      username: 'sneaky',
      employee_code: 'EMP-999',
      display_name: 'Sneaky',
      password: 'sneaky-password',
      role: 'admin',
    },
  });
  expect(createResponse.status()).toBe(403);

  // Employees only ever see their own events.
  const mine = await employeeContext.request.get('/api/v1/attendance/me');
  expect(mine.ok()).toBeTruthy();
  const mineBody = (await mine.json()) as { items: Array<{ employee_code: string }> };
  expect(mineBody.items.length).toBeGreaterThan(0);
  expect(mineBody.items.every((item) => item.employee_code === 'EMP-100')).toBe(true);

  await employeeContext.close();
});

test('admin sees all events and mutations without CSRF are refused', async ({ browser, page }) => {
  await signIn(page, ADMIN);
  await page.goto('/admin/attendance');
  await expect(page.getByText('Ali Rezaei').first()).toBeVisible();

  const anonymous = await browser.newContext();
  const csrfResponse = await anonymous.request.get('/api/v1/auth/csrf');
  expect(csrfResponse.ok()).toBeTruthy();

  const withoutToken = await anonymous.request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  expect(withoutToken.status()).toBe(403);
  const body = (await withoutToken.json()) as { error: { code: string } };
  expect(body.error.code).toBe('csrf_failed');

  await anonymous.close();
});

test('deep links render and API 404s stay JSON', async ({ page, request }) => {
  await page.goto('/scan');
  await expect(
    page.getByText(/scanning the QR code shown on the entrance display/i),
  ).toBeVisible();

  await page.goto('/attendance');
  await expect(page).toHaveURL(/\/login/);

  const missing = await request.get('/api/v1/does-not-exist');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');

  const health = await request.get('/api/v1/health');
  expect(health.ok()).toBeTruthy();
});

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Logs the SU in once and caches the Firebase session (cookies + IndexedDB)
  // so auth-gated tests skip the login flow per-test. No-op when
  // E2E_SU_EMAIL/PASSWORD aren't set — gated tests skip themselves.
  globalSetup: './e2e/_setup/global.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    // Cheap smoke tests — run on every PR via the `e2e` CI job.
    {
      name: 'smoke',
      testMatch: /.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Auth-gated CRUD against Firebase staging — heavier; CI job
    // `configuracoes-e2e` runs this only when relevant paths change
    // (see paths filter in .github/workflows/ci.yml).
    {
      name: 'configuracoes',
      testMatch: /configuracoes\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});

// DELIBERATE CI FAILURE TEST — to be reverted once failure-log posting is verified
const __DELIBERATE_CI_FAILURE_TEST__ = ;

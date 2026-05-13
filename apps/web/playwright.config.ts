import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

// Persisted login session produced by `e2e/global-setup.ts`. Specs that
// need an *unauthenticated* session override this to a blank state.
const STORAGE_STATE = 'e2e/.auth/user.json';

export default defineConfig({
  testDir: './e2e',
  // Smoke + globalSetup do real network round-trips against staging.
  // Next 16 dev mode compiles each route on first hit; CI cold compiles
  // can spike >30s, so we give specs 60s. expect() timeouts stay tight.
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    // Default: every spec runs as the seeded test user. Specs that need to
    // assert unauthenticated behaviour set `test.use({ storageState: { ... } })`.
    storageState: STORAGE_STATE,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        port: PORT,
        reuseExistingServer: !process.env.CI,
        // Next 16 cold-compiles every imported module on first request; in
        // CI we've seen this exceed the previous 60s budget. 180s gives
        // headroom while still failing the run if dev never comes up.
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});

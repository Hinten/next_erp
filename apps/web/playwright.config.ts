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
  // `list` keeps the in-job step output readable; `html` is the
  // browsable report in the artifact; `json` is a machine-readable dump
  // you can paste into a chat to share the exact failure without needing
  // to browse the HTML report.
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['json', { outputFile: 'playwright-report/results.json' }],
      ]
    : 'list',
  // Composed setup: runs the legacy tenant/user seed (E2E_USER_*) and the
  // SU login session (E2E_SU_*). Each step skips itself when its env is
  // not set, so the two CI jobs can each provide only their own secrets.
  globalSetup: './e2e/_setup/combined.ts',
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
    // Per-schema TableView/ObjectView CRUD suites. Each runs in its own CI
    // workflow (.github/workflows/<schema>-e2e.yml), gated on the schema +
    // TableView/ObjectView + data-layer paths.
    {
      name: 'clientes',
      testMatch: /clientes\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'categorias',
      testMatch: /categorias\.e2e\.spec\.ts$/,
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

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
  // CI gets 2 retries; local gets 1 — local networks (and the real Firebase
  // round-trips every spec makes) are less stable than CI's, so a single
  // retry absorbs a transient blip without masking a deterministic failure.
  retries: process.env.CI ? 2 : 1,
  // One worker locally. Each worker cold-compiles routes against the single
  // Next dev server; more than ~2 suites compiling at once overwhelms it
  // (connection resets, 40s compiles). CI's runners cope with 4. A fast local
  // machine can override with `--workers=N`.
  workers: process.env.CI ? 4 : 1,
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
  // Composed setup: seeds the tenant + mints the ephemeral test user, and
  // logs the SU in (E2E_SU_*). Each step skips itself when its env is not set.
  globalSetup: './e2e/_setup/combined.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    // retain-on-failure keeps a trace for every failed attempt (not just the
    // retry), so a flake that passes on retry is still debuggable. Pairs with
    // the production-build CI serving + client source maps (E2E_SOURCEMAPS).
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Default: every spec runs as the seeded test user. Specs that need to
    // assert unauthenticated behaviour set `test.use({ storageState: { ... } })`.
    storageState: STORAGE_STATE,
  },
  projects: [
    // Suites are split across two e2e workflows by domain (e2e-cadastros.yml,
    // e2e-vendas.yml), running concurrently with the offline `CI` workflow
    // (not gated on it) and serving a production build. A plain local
    // `playwright test` still runs every project below = full coverage.
    //
    // Smoke specs (cheap; login.smoke / auth-guard.smoke opt out of the
    // authenticated session per-spec via `test.use`). → e2e-cadastros.yml
    {
      name: 'smoke',
      testMatch: /.*\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Auth-gated User+Cargo CRUD (uses the SU storageState, set in the spec).
    // → e2e-vendas.yml
    {
      name: 'configuracoes',
      testMatch: /configuracoes\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Schema-driven TableView/ObjectView CRUD suites, split into two domain
    // projects so the two workflows run disjoint halves concurrently. The
    // domain lives in the filename suffix — a new CRUD spec is auto-collected
    // by naming it `<x>.cadastros.e2e.spec.ts` or `<x>.vendas.e2e.spec.ts`;
    // no config edit needed.
    {
      // Master-data domain → e2e-cadastros.yml
      name: 'crud-cadastros',
      testMatch: /\.cadastros\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Sales / fiscal / config domain → e2e-vendas.yml
      name: 'crud-vendas',
      testMatch: /\.vendas\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Estoque server-owned write path (the `aplicarEstoque` callable). Runs
      // ONLY against the Firebase Emulator Suite (→ e2e-emulator.yml), where the
      // callable is served locally — no staging deploy needed. Its filename ends
      // in `.emulator.e2e.spec.ts`, so the staging `crud-cadastros` project no
      // longer collects it; a plain local `playwright test` still runs it.
      name: 'emulator',
      testMatch: /\.emulator\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // LOCAL-ONLY perf/leak project (the PR 7 checkout 1000-item harness spec,
      // `*.local.spec.ts`). No CI workflow passes `--project=local-perf`, so CI
      // never runs it — wall-time + DOM-node budgets are machine-dependent. CI
      // gates the scan ALGORITHM instead via the op-count test in
      // `@delfrance/schemas` (`checkoutEngine.perf.test.ts`). Run it locally with
      // `playwright test --project=local-perf` (needs the dev server: the
      // harness route is dev-only). No other project matches `.local.spec.ts`.
      name: 'local-perf',
      testMatch: /\.local\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // Local dev serves with `pnpm dev`. CI overrides this with
        // `PLAYWRIGHT_WEB_CMD='pnpm exec next start --port 3000'` to serve a
        // production build — no per-route cold compile, so it answers fast.
        command: process.env.PLAYWRIGHT_WEB_CMD ?? 'pnpm dev',
        port: PORT,
        reuseExistingServer: !process.env.CI,
        // Next 16 dev cold-compiles every imported module on first request; in
        // CI we've seen this exceed the previous 60s budget. 180s gives
        // headroom while still failing the run if the server never comes up.
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});

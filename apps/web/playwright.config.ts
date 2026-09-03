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
  // ⚠️ A committed `test.only` runs ONE test and silently skips the rest of its
  // file — and Playwright's default for this option is `false`, so before #1445
  // the `E2E gate (cadastros|vendas|emulator)` check reported GREEN for a lane
  // that had stopped running its suite. That is the silent-pass class the whole
  // `ci-lanes` design exists to prevent ("CI green" means "the suite passed"),
  // and it was the one instance of it nothing guarded. Failing the RUN in CI is
  // the half a lint rule cannot cover, since `.only` can also arrive through a
  // `--grep` or a merge that never touches a linted line.
  //
  // CI only: locally, `.only` is the normal way to iterate on one spec.
  forbidOnly: !!process.env.CI,
  // CI gets 2 retries; local gets 1 — local networks (and the real Firebase
  // round-trips every spec makes) are less stable than CI's, so a single
  // retry absorbs a transient blip without masking a deterministic failure.
  retries: process.env.CI ? 2 : 1,
  // One worker locally. Each worker cold-compiles routes against the single
  // Next dev server; more than ~2 suites compiling at once overwhelms it
  // (connection resets, 40s compiles). CI's runners cope with 4. A fast local
  // machine can override with `--workers=N`.
  //
  // PLAYWRIGHT_WORKERS lets a CI lane tune this without editing the shared
  // config — the lanes have very different shapes (staging round-trips vs. four
  // emulators plus a Next server on one runner), so one number cannot be right
  // for all of them. ⚠️ Raise it per lane only on a measured before/after of
  // BOTH wall clock and the retry-rescued count: these suites are network-bound,
  // so more workers can buy throughput — or just add contention and convert
  // passes into retries, which is invisible in the duration alone.
  workers: Number(process.env.PLAYWRIGHT_WORKERS) || (process.env.CI ? 4 : 1),
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
      // Master-data domain → e2e-cadastros.yml. Excludes recalcular-precos
      // (see `crud-cadastros-recalculo` below) — that spec needs the whole
      // catalog quiescent, so it can't share this project's parallel pool.
      name: 'crud-cadastros',
      testMatch: /\.cadastros\.e2e\.spec\.ts$/,
      testIgnore: /recalcular-precos\.cadastros\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Bulk price recalculation (#544): `Aplicar` scans + writes EVERY
      // parent produto in the shared `produtos` collection with no
      // per-spec scoping (the screen exposes none — see the spec's own top
      // comment). If it ran fullyParallel alongside the rest of
      // `crud-cadastros`, its writes would race their seed/assert/cleanup
      // windows — a stray `precos` key can land on another spec's
      // still-alive produto and break its strict equality assertions
      // (observed against produto-preco.cadastros.e2e.spec.ts).
      // `dependencies` makes Playwright run every `crud-cadastros` test
      // (including each spec's `afterAll` cleanup) to completion FIRST, so
      // by the time this spec's `Aplicar` fires the shared catalog is
      // quiescent.
      name: 'crud-cadastros-recalculo',
      testMatch: /recalcular-precos\.cadastros\.e2e\.spec\.ts$/,
      dependencies: ['crud-cadastros'],
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
    // OPT-IN perf/leak project (the checkout 1000-item harness spec,
    // `*.local.spec.ts`). Playwright runs EVERY configured project when no
    // `--project` is passed, so this one is only ADDED to the list when
    // `CHECKOUT_PERF=1` — an unguarded project would drag the slow,
    // machine-dependent 1000-scan spec into every plain local `playwright test`.
    // CI never runs it either way: each workflow passes explicit `--project=`
    // args (see e2e-reusable.yml). CI gates the scan ALGORITHM instead, via the
    // op-count test in `@delfrance/schemas` (`checkoutEngine.perf.test.ts`).
    // Run it with (needs the dev server — the harness route is dev-only):
    //   CHECKOUT_PERF=1 playwright test --project=local-perf
    ...(process.env.CHECKOUT_PERF === '1'
      ? [
          {
            name: 'local-perf',
            testMatch: /\.local\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
  webServer: [
    ...(process.env.PLAYWRIGHT_BASE_URL
      ? []
      : [
          {
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
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
          },
        ]),
    // configuracoes.spec.ts drives the admin endpoints (user creation + claims
    // refresh), which live in apps/integrations on :3001 — apps/web has no route
    // handlers at all, so without this server those calls 404 against :3000 and
    // the suite fails on a status assertion. Opt-in via the env var, mirroring
    // PLAYWRIGHT_WEB_CMD above: only the vendas CI lane sets it (see
    // e2e-reusable.yml's `integrations` input). Unset locally, where root
    // `pnpm dev` already serves :3001 — and where the client falls back to
    // http://localhost:3001 in development anyway.
    ...(process.env.PLAYWRIGHT_INTEGRATIONS_CMD
      ? [
          {
            command: process.env.PLAYWRIGHT_INTEGRATIONS_CMD,
            port: 3001,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
          },
        ]
      : []),
  ],
});

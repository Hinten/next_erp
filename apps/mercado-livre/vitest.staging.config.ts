import path from 'node:path';
import { defineConfig } from 'vitest/config';

import { loadRepoRootEnv } from '@delfrance/config-vitest/env';

// Mercado Livre STAGING suite — the `*.staging.test.ts` files, run against the
// REAL staging Firestore (Enterprise edition) by `ML staging Enterprise queries`
// in .github/workflows/ci-mercado-livre.yml, or locally by `test:staging`.
//
// Why a fourth suite: the offline suite fakes Firestore, and the emulator suites
// (`*.firestore.test.ts`, `*.tasks.test.ts`) run the STANDARD-edition emulator,
// which auto-creates every index and refuses pipelines. Neither can show what
// Enterprise does with a query — a missing index there does not fail, it
// full-scans and bills the scan — so the plans and cursors of the #1200 audit's
// classic queries had never been observed anywhere. That is this suite's job.
//
// Disjoint from the other three BY SUFFIX: `vitest.config.ts` excludes
// `**/*.staging.test.ts` (it matches that config's `*.test.ts` include), and the
// two emulator configs only include their own suffix. A name ending in
// `.staging.test.ts` can match neither of theirs.
//
// Credentials come from the repo-root `.env` + `.env.local` (the
// `@delfrance/config-vitest` loader the NF-e suites use), shell env winning:
// `FIREBASE_PROJECT_ID` plus `FIREBASE_SERVICE_ACCOUNT` (inline JSON) or
// `FIREBASE_SERVICE_ACCOUNT_PATH` (resolved against the repo root here, so the
// conventional `.ignore/service_account.json` works from this app's cwd).
// Without them every suite SKIPS locally — and FAILS in CI, see
// vitest.staging.setup.ts.
//
// ⚠️ Never set `passWithNoTests`, and never add `--changed`/`--related` to the
// script — each forces it true, and a mis-globbed `include` would exit 0.
const envFromFiles = loadRepoRootEnv({
  configFileUrl: import.meta.url,
  resolveRelativePaths: ['FIREBASE_SERVICE_ACCOUNT_PATH'],
});

export default defineConfig({
  test: {
    name: '@delfrance/mercado-livre-app:staging',
    environment: 'node',
    // Same anchored shape as the emulator configs (an unanchored `**/` walks
    // node_modules), with the mirror-image root-level entry: a root-level
    // `*.staging.test.ts` must not match NO config.
    include: ['{app,lib,functions}/**/*.staging.test.ts', '*.staging.test.ts'],
    setupFiles: ['./vitest.staging.setup.ts'],
    env: { ...envFromFiles, ...process.env },
    // Real network, real project: a cold gRPC channel + token mint, then a few
    // dozen round trips per suite. Generous so "slow" never reads as "broken" —
    // and ⚠️ BOUNDED BY THE CI JOB: `ML staging Enterprise queries`
    // (ci-mercado-livre.yml) sets `timeout-minutes` to cover the SUM of these
    // (6 cases × 60s + beforeAll 120s + afterAll 120s = 10 min) plus install, so
    // a hung staging call times out HERE and `afterAll`'s cleanup still runs. A
    // runner kill skips it, leaving rows on staging and a `cancelled` gate.
    // Raise one of these, or add a case, and re-check that job's budget.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Suites share one staging project; serialise FILES so two of them never
    // contend for the same quota window. Isolation between RUNS (CI push + PR,
    // two developers) is each suite's own per-run id prefix.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});

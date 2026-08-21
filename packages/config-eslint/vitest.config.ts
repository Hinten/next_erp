import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/config-eslint',
    environment: 'node',
    include: ['rules/**/*.test.js'],
    // ⚠️ Not the default 5000ms. Nine of the guards here are repo-state scans
    // that shell out to `git` over the whole tree; `lib/repo-scan.js` memoizes
    // the spawn so each file pays it once, but "once" is still 0.2-0.5s idle on
    // Windows and several times that with 23 test files running in parallel
    // worker threads. At 5000ms the tail crossed the line and a DIFFERENT guard
    // flaked each run — always `Test timed out in 5000ms`, never an assertion.
    //
    // This is headroom for a legitimately I/O-bound test, NOT a relaxed
    // assertion: every anti-vacuity floor in these files is untouched. A guard
    // that genuinely hangs still fails, just after 30s instead of 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

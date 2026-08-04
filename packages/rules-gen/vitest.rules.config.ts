import { defineConfig } from 'vitest/config';

// Rules behavior suite — runs ONLY under `firebase emulators:exec --config
// firebase.rules.json` (see that file at the repo root). The dedicated
// `*.rules.test.ts` extension + this separate config keep it out of the offline
// unit run: this package's `test` script points at vitest.config.ts, so nothing
// turbo runs picks these up — same isolation pattern as apps/functions'
// test:storage.
export default defineConfig({
  test: {
    name: '@delfrance/rules-gen:rules',
    environment: 'node',
    include: ['test/**/*.rules.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Emulator state is shared, so don't parallelize across files.
    fileParallelism: false,
  },
});

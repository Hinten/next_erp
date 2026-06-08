import { defineConfig } from 'vitest/config';

// Storage integration suite — runs ONLY under `firebase emulators:exec`
// (firestore + storage + functions emulators). The dedicated `*.storage.test.ts`
// extension keeps these out of the offline unit run. Pipeline-free queries only
// (the Firestore emulator does not support pipeline expressions).
export default defineConfig({
  test: {
    name: '@delfrance/functions:storage',
    environment: 'node',
    include: ['src/**/*.storage.test.ts'],
    setupFiles: ['./vitest.storage.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Emulator state is shared, so don't parallelize across files.
    fileParallelism: false,
  },
});

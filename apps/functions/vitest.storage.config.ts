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
    // ⚠️ This must exceed the LONGEST CHAIN of trigger waits any single test
    // performs, not one wait — otherwise Vitest's timeout wins the race and you
    // get `Test timed out in Ns` instead of the poller's own
    // `timed out waiting for 2 historicoEstadoPedido row(s); saw 1`, which is the
    // difference between a diagnosis and a shrug.
    //
    // The longest chains are three sequential deliveries (registrarHistoricoPedido's
    // "records one row in each trail…", and resizeProductImage's per-variant loops)
    // at TRIGGER_DELIVERY_TIMEOUT_MS = 45s each, plus the fixed quiet windows —
    // so 180s clears it. Per-test `}, 60_000)` overrides used to carry this job
    // file-by-file; they were removed because two of the four polling files never
    // had any, and those were the ones running with NEGATIVE margin (pedidoHistory
    // could chain 2 x 15s against this 30s default).
    //
    // A first invocation also pays the functions emulator's cold start on top of
    // delivery — see #1201, which measured the whole distribution.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Emulator state is shared, so don't parallelize across files.
    fileParallelism: false,
  },
});

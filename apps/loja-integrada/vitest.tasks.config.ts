import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Loja Integrada EMULATOR suites — run ONLY under
// `firebase emulators:exec --config firebase.loja-integrada.tasks.json
//  --only firestore,functions,tasks` (.github/workflows/ci-loja-integrada.yml).
//
// Split from the offline suite on purpose: this one pays for the functions
// emulator loading the Loja Integrada codebase plus the artifact build that has
// to precede it, while `pnpm test` stays fast and offline.
//
// ⚠️ TWO suffixes, ONE config, ONE job. `vitest.config.ts` EXCLUDES both
// `**/*.tasks.test.ts` and `**/*.firestore.test.ts`, and this config includes
// both — so a file with either suffix runs here, and a file matching neither
// glob runs in NO job at all. A Firestore-only proof can therefore share the
// round-trip job's emulators: no second config, no second port, no second check
// name and no extra clause in the lane's gate manifest. Step 3 has no Firestore
// trigger that a shared emulator could disturb; the day one lands, give it a
// config of its own rather than letting a trigger fire inside another suite.
//
// Each file's `beforeEach` wipes the collections it reads, because the files
// share one emulator and run one at a time (`fileParallelism: false`).
export default defineConfig({
  test: {
    name: '@delfrance/loja-integrada-app:tasks',
    environment: 'node',
    include: ['{app,lib,functions}/**/*.{tasks,firestore}.test.ts', '*.{tasks,firestore}.test.ts'],
    // The fail-loud emulator gates, the pinned project/database, the read-switch
    // refusals and the non-localhost fetch kill-switch. All of them matter more
    // here, not less: this lane boots the real functions codebase, and the read
    // switch is the layer that keeps a dispatched function from calling out.
    setupFiles: ['./vitest.tasks.setup.ts'],
    // Generous: a task dispatch has a cold-start floor of ~1.5-2s on top of the
    // enqueue, and `getServiceAccount()` attempts a real token endpoint before
    // falling back to the emulated service account.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One emulator, shared: every file clears what it reads, so two files at
    // once would wipe each other's rows.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});

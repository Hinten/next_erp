import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Amazon EMULATOR suites — run ONLY under
// `firebase emulators:exec --config firebase.amazon.tasks.json
//  --only firestore,functions,tasks` (.github/workflows/ci-amazon.yml).
//
// Split from the offline suite on purpose: this one pays for the functions
// emulator loading the Amazon codebase plus the artifact build that has to
// precede it, while `pnpm test` stays fast and offline.
//
// ⚠️ TWO suffixes, ONE config, ONE job. `vitest.config.ts` EXCLUDES both
// `**/*.tasks.test.ts` and `**/*.firestore.test.ts`, and this config includes
// both — so a file with either suffix runs here, and a file matching neither
// glob runs in NO job at all. A Firestore-only proof can therefore share the
// round-trip job's emulators: no second config, no second port, no second check
// name and no extra clause in the lane's gate manifest. `lib/amazon/estrutura.test.ts`
// pins this include and that exclude, so neither can drift into overlapping (an
// emulator suite collected offline skips green) or into a gap.
//
// The Amazon codebase has no Firestore trigger, so a suite's writes fire
// nothing in the functions emulator; only a task a suite enqueues runs there.
// Each file's `beforeEach` deletes what it reads, because the files share one
// emulator and run one at a time (`fileParallelism: false`).
export default defineConfig({
  test: {
    name: '@delfrance/amazon-app:tasks',
    environment: 'node',
    // The same zone pin as the offline config: a date assertion is never
    // evaluated in the zone it asserts.
    env: { TZ: 'UTC' },
    include: ['{app,lib,functions}/**/*.{tasks,firestore}.test.ts', '*.{tasks,firestore}.test.ts'],
    // The fail-loud emulator gates, the pinned project/database, the read-switch
    // refusals and the non-localhost fetch kill-switch. All of them matter more
    // here, not less: this lane boots the real functions codebase, and the read
    // switch is the layer that keeps a dispatched function from calling out.
    setupFiles: ['./vitest.tasks.setup.ts'],
    // Generous: a task dispatch has a cold-start floor of ~1.5-2s on top of the
    // enqueue, and the Admin SDK's first enqueue resolves a service account
    // before falling back to the emulated one.
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

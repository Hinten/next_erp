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
// ⚠️ Since step 20 the codebase has a Firestore trigger,
// `onIntegracaoAmazonChanged`, and the functions emulator loads it, so it fires
// on EVERY suite's `integracao` writes here (besides any task a suite
// enqueues). Staying in one job is a COST choice, not a necessity: a
// Firestore-only config without the functions emulator is possible, but it
// costs a second `emulators:exec`, a check name and a gate-manifest row, and
// only the `.firestore.` suites could move there — `*.tasks.test.ts` needs the
// functions emulator, which loads the whole codebase, trigger included.
// Sharing stays safe under three rules:
//   - a suite that writes `integracao` docs uses conta ids NO other suite seeds;
//   - the step-3/4 suites seed Amazon contas with no filial and no
//     `dataCadastro`, which the shared core plans as `incompleto`: the trigger
//     only READS there (and a deleted conta with no freight doc is
//     `nao-encontrado`). A suite that seeds a COMPLETE conta makes the trigger
//     write `int_frete`, and so becomes a trigger suite;
//   - a suite whose writes fire the trigger awaits the trigger's LAST write
//     before it ends: every case polls for its expected positive state, and the
//     teardown waits for the deactivation its conta delete causes
//     (`functions/src/onIntegracaoAmazonChanged.tasks.test.ts`), so no
//     reconcile spills into the next file.
//
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

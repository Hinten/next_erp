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
// name and no extra clause in the lane's gate manifest.
//
// ⚠️ Since step 20 the codebase has a Firestore trigger,
// `onIntegracaoLojaIntegradaChanged`, and the functions emulator loads it, so it
// fires on EVERY suite's `integracao` writes here. Staying in one job is a COST
// choice, not a necessity: a Firestore-only config without the functions
// emulator is possible (Mercado Livre runs its `*.firestore.test.ts` that way),
// but it costs a second `emulators:exec`, a check name and a gate-manifest row,
// and only the `.firestore.` suites could move there — `*.tasks.test.ts` needs
// the functions emulator, which loads the whole codebase, trigger included.
// Sharing stays safe under three rules:
//   - a suite that writes `integracao` docs uses conta ids NO other suite seeds;
//   - the step-3 suites seed Loja Integrada contas with no filial and no
//     `dataCadastro`, which the shared core plans as `incompleto`: the trigger
//     only READS there (and a deleted conta with no freight doc is
//     `nao-encontrado`). A suite that seeds a COMPLETE conta makes the trigger
//     write `int_frete`, and so becomes a trigger suite;
//   - a suite whose writes fire the trigger awaits the trigger's LAST write
//     before it ends: every case polls for its expected positive state, and the
//     teardown waits for the deactivation its conta delete causes
//     (`functions/src/onIntegracaoLojaIntegradaChanged.tasks.test.ts`), so no
//     reconcile spills into the next file.
//
// ⚠️ Since step 7 a SECOND Firestore trigger loads too,
// `onHistoricoFreteLojaIntegrada`, on every CREATE of
// `pedidos/*/historicoFtIni/*` — with the lane's write valve at `dry-run`, it
// reads the pedido and enqueues onto the writes queue, whose run ends as a row in
// `notificacoesEscritaLojaIntegrada`. Today only
// `functions/src/filaEscrita.tasks.test.ts` creates such rows. A suite that does:
//   - uses pedidos and contas no other suite seeds;
//   - awaits the row its event ends in before it ends (a history row with no
//     awaited effect would land its task in the NEXT file's emulator state);
//   - remembers that the writes queue's varredura re-runs EVERY `failed` and
//     `deferred` row of that collection, not only its own.
//
// Each file's `beforeEach` deletes what it reads, because the files
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

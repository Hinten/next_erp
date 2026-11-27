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
// ⚠️ Since step 9 a THIRD one loads, the anchor `onProdutoLojaIntegradaLinkChanged`,
// on every write of `produtos/*/produtolojaintegrada/*`: a counting link's create
// writes its conta into the produto's `integracoesComProduto`, and losing the
// last one removes it. Today `lib/lojaIntegrada/pedidos/importarPedido.firestore.test.ts`,
// `lib/lojaIntegrada/importacao/completar.firestore.test.ts` and the anchor's own suite
// write link docs. A suite that does:
//   - uses produtos no other suite seeds;
//   - awaits the anchor's write on each seeded produto UNCONDITIONALLY before it
//     asserts on that produto or races a precondition on it;
//   - ends by deleting its links and awaiting the anchor's last write before its
//     produtos go (`lib/lojaIntegrada/testing/ancoraLi.ts`).
//
// ⚠️ And a FOURTH, `onImportacaoLojaIntegradaCriada`, on every CREATE of
// `importacoesLojaIntegrada/*` — it enqueues a dispatch onto the READS queue for
// a job created `pendente` (the dispatch then stops at the read switch and stamps
// the job `falhou/chamadas-desligadas`). So a suite seeds its jobs `executando`
// (or ended), which the trigger ignores with zero reads, unless that dispatch is
// what it awaits — as `functions/src/importacao.tasks.test.ts` does, with job ids
// no other suite uses, awaiting each one's stamp before it ends.
// ONE import suite also writes link documents, so the anchor fires on it:
// `lib/lojaIntegrada/importacao/completar.firestore.test.ts` (the complete step's
// creates write their links in their own batch; the adoption path and the add-child
// test link existing produtos). It keeps the THIRD trigger's rules: produtos whose
// ids derive from SKUs no other suite uses; after every step that links a produto,
// the anchor's write awaited on THAT produto before anything asserts on it or races
// a precondition on it; and every case ending with its links deleted and the conta
// leaving each array awaited before its produtos go. Its one job is seeded
// `executando`, so the job trigger ignores it.
//
// ⚠️ Since step 12 (PR 12-e) the codebase loads a third queue,
// `filaEstoqueLojaIntegrada`, and `lib/lojaIntegrada/estoque/processarEstoque.tasks.test.ts`
// runs the stock send run IN PROCESS (its valve and the read switch on as PARAMETERS only).
// It seeds an `integracao` conta (incomplete: the conta trigger only reads), produtos with
// `estoques` records and link docs — so it keeps the THIRD trigger's rules above (its own
// produtos, the anchor's add awaited before the run, the links deleted and the conta's
// leaving awaited before the produtos go) — and one case enqueues a `deriva` follow-up
// through the real producer root. Since PR 12-f the lane sets the stock valve to `dry-run`,
// so that dispatched task runs its ERP reads and stops at its write context (the read switch
// is off): it writes nothing, so it cannot spill into another file.
//
// ⚠️ Since step 12 (PR 12-f) a FIFTH trigger loads, the stock trigger `onEstoqueLojaIntegrada`,
// on every write of `produtos/*/estoques/*` — every suite's stock records, today
// `processarEstoque.tasks.test.ts` and the trigger's own suite,
// `lib/lojaIntegrada/estoque/gatilhoEstoque.tasks.test.ts`. At the lane's `dry-run` valve it
// reads its cached depósito map (one `integracao` query per 15 minutes per emulator worker),
// the produto's links and the kits header, and may enqueue send runs (which stop at their
// write context and write nothing) and, for a component with a seeded kits header, ONE
// `estoque-kits` fan-out — whose only write is the global stagger slot
// `reconcileEstoqueLojaIntegrada/atual`. So a suite that writes stock records:
//   - uses produtos (and a conta and a depósito) no other suite seeds;
//   - never seeds a kits header for a component whose records another suite moves, and never
//     moves a record from positive to 0 under an existing sharded or over-ceiling header (that
//     is a fan-out the deployed trigger enqueues on its own timing);
//   - deletes `sincEstoqueLojaIntegrada/{conta}` (headers and shards) BEFORE any of its stock
//     records, then the slot document, the produtos and the conta — and if it lets the
//     DEPLOYED fan-out write the slot, awaits that write before the next case wipes it;
//   - asserts only what its own run decides: the deployed trigger's map may be warm from an
//     earlier file without this suite's conta, so the trigger's work is driven IN PROCESS
//     (the cache reset per case), and only the dispatched fan-out is observed in the emulator.
//
// ⚠️ Since step 12 (PR 12-g) a SIXTH rule set: the daily stock reconcile.
//   - The conta trigger gains a depósito-change ARM: an UPDATE of a Loja Integrada conta whose
//     depósito becomes another one enqueues ONE reconcile run on the READS queue (a CREATE never
//     fires, which is why every suite that seeds a conta with a depósito does it by a create).
//     That dispatched run walks EVERY link and conta in the emulator, writes each conta's
//     `sincEstoqueLojaIntegrada/{conta}` snapshot and kits map, and its store phase stops at the
//     read switch. So a suite that moves a conta's depósito awaits that run's end (the run
//     document released) before it ends, and seeds no links while it runs.
//   - The run document `reconcileEstoqueLojaIntegrada/atual` is the kit fan-out's slot document
//     too: a reconcile suite wipes it before AND after each case, and asserts the run's `contas`
//     is exactly its own conta before reading a per-conta counter.
//   - `lib/lojaIntegrada/estoque/reconcile/reconcileEstoque.tasks.test.ts` drives the chain IN
//     PROCESS with its hand-offs RECORDED (never the real reads root), so no deployed dispatch
//     drives the same lease beside it; its sends go through the real STOCK root (dispatched in
//     the lane at `dry-run`, they stop at their write context). It keeps the third and fifth
//     trigger's rules (its own produtos, the anchor awaited, the sync documents deleted before
//     the records) and writes only an INLINE kits header, so no fan-out ever follows.
//
// ⚠️ Since step 13 (PR 13-d) the codebase loads a FOURTH queue, `filaPrecoLojaIntegrada`, and
// `lib/lojaIntegrada/preco/processarPreco.tasks.test.ts` runs the price send run IN PROCESS (its
// valve and the read switch on as PARAMETERS only). It seeds an `integracao` conta by a CREATE
// (incomplete, so the conta trigger only reads; a create never fires its depósito arm), produtos
// carrying `precos` and link docs — so it keeps the THIRD trigger's rules above (its own
// produtos, the anchor's add awaited before the run, the links deleted and the conta's leaving
// awaited before the produtos go) — and NO stock records, so the stock trigger never fires on
// it. One case enqueues a `deriva` follow-up through the real price producer root; the lane sets
// the price valve to `dry-run`, so that dispatched task runs its ERP reads and stops at its write
// context (the read switch is off): it writes nothing, so it cannot spill into another file.
//
// ⚠️ Since step 13 (PR 13-e) a SIXTH trigger loads, the price trigger `onPrecoLojaIntegrada`, on
// EVERY write of `produtos/*` — every suite's produto documents, the anchor's own array writes
// included. Its relevance gate reads the payload alone: a create, a delete, and an update that moves
// no tabela entry, no propagation flag and no parent (the anchor's writes, a name, a mirror field)
// stop there with zero reads. Past it, at the lane's `dry-run` price valve, it reads its cached
// conta map (one `integracao` query per 15 minutes per emulator worker) and, only for a conta that is
// ACTIVE, names a normal tabela AND appears in the produto's anchor, at most one masked parent read
// or one family query, then enqueues send runs onto `filaPrecoLojaIntegrada` — which, dispatched,
// stop at their write context (the read switch is off) and write nothing. A conta with no normal
// tabela is inert. So a suite that writes produtos:
//   - seeds them by a CREATE (after a delete) and never UPDATES `precos`,
//     `propagatePriceToChildren` or `paiId` on a produto whose anchor names a conta with a normal
//     tabela — today only `lib/lojaIntegrada/preco/processarPreco.tasks.test.ts` and the trigger's
//     own suite seed such a conta, and neither edits a price field in the emulator;
//   - seeds a conta with a normal tabela only under ids no other suite uses, by a create;
//   - asserts only what its own in-process run decides: the deployed trigger's map may be warm from
//     an earlier file without this suite's conta, so the trigger's work is driven IN PROCESS
//     (`lib/lojaIntegrada/preco/gatilhoPreco.tasks.test.ts`, the cache reset per case), each
//     event's before and after handed in.
//
// ⚠️ Since step 13 (PR 13-f1) the daily reconcile carries the PRICE arm too: one run walks the
// ERP once for both flows, and the lane's `dry-run` price valve makes every DISPATCHED reconcile
// run (today the stock suite's depósito-arm case) price each conta of its list that names a normal
// tabela — its walk's price snapshot, the parents' reads, the price end. A seventh rule set, kept
// by `lib/lojaIntegrada/estoque/reconcile/reconcilePreco.tasks.test.ts`, which drives the price
// arm IN PROCESS (its valves as PARAMETERS, its hand-offs recorded):
//   - conta, depósito, tabela and produto ids no other suite seeds;
//   - the conta seeded by a CREATE (a create never fires the depósito arm) with no filial, so the
//     conta trigger only reads;
//   - produtos created and NEVER updated on `precos`, `propagatePriceToChildren` or `paiId`, so the
//     price trigger stops at its relevance gate with zero reads; no stock record, so the stock
//     trigger never fires;
//   - every link created with its anchor write awaited (the third trigger's rules);
//   - the run document `reconcileEstoqueLojaIntegrada/atual` AND the price slot
//     `reconcileEstoqueLojaIntegrada/slot-preco` wiped before and after every case;
//   - the teardown deletes the conta's price documents (`sincPrecoLojaIntegrada/{conta}` and its
//     buckets) FIRST, then its stock ones, the links (the anchor's last write awaited), the
//     produtos, the conta and its avisos;
//   - its conta HAS a depósito, so it would join any dispatched run's conta list: the files run one
//     at a time and the conta is gone at its teardown, which keeps the stock suite's exact
//     `run.contas` assertion true. So a suite that seeds a conta with a depósito and a normal tabela
//     deletes it before it ends, like any conta with a depósito.
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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitGrep } from './lib/repo-scan.js';

/**
 * Every `onTaskDispatched` in the repo must declare its `invoker` (#1133), and
 * every functions build must inline the value the helper reads.
 *
 * ## Why this is a test and not an ESLint rule
 *
 * The bug class is not "this file is wrong" — it is "these NINE call sites in
 * FIVE codebases disagree". #1108 is the worked example: it removed a stale
 * region fall-through from `mlTasks.ts` and left the four copy-pasted siblings
 * alone, and because each sibling had its own test pinning its own stale
 * default, four queues aimed at a region with no Cloud Tasks and CI stayed
 * green. A per-file lint rule cannot express "these seven agree"; that IS the
 * defect. Same shape as `runtime-deps-pinned.test.js` (six manifests must agree)
 * and `reserva-arithmetic-inventory.test.js`.
 *
 * ## The invariant being protected
 *
 * `invoker` is what makes `firebase deploy` grant `roles/run.invoker` on the
 * function's Cloud Run service — the DISPATCH leg — and
 * `roles/cloudtasks.enqueuer` on its queue. Without it both are a manual gcloud
 * command a human has to remember, per project, per function, and the failure
 * mode is the invisible one: the enqueue succeeds, nothing writes a failure
 * document, the failures-only collection stays empty, and the only evidence is
 * a 403 WARNING in the function's own log (#1131).
 */

/** Path → what the function is, so a new one has to be read, not just listed. */
const INVENTORY = {
  'apps/functions/src/access/processAccessOperation.ts':
    'Access propagation, enqueued by the operation-created trigger, worker continuations and watchdog (functions runtime SA).',
  // ---- codebase `mercado-livre` (apps/mercado-livre/functions) -------------
  'apps/mercado-livre/functions/src/processNotification.ts':
    'The ML webhook notification handler. Enqueued by the receiver route AND by two onSchedule sweeps (order backfill, missed_feeds) running as the FUNCTIONS runtime SA.',
  'apps/mercado-livre/functions/src/processMassImport.ts':
    '"Importar todos os anuncios". Enqueued by the /importar-todos route and re-enqueued by ITSELF (self-continuation), so two identities dispatch it.',
  'apps/mercado-livre/functions/src/processPriceSync.ts':
    'Per-produto price push. Enqueued by /atualizar-precos, plus a self-continuation and a 429-pause re-enqueue.',
  'apps/mercado-livre/functions/src/processNfeUpload.ts':
    'NF-e XML upload to ML. Enqueued by /enviar-nfe AND by the `onNfeAprovada` Firestore trigger, which runs as the functions runtime SA.',
  'apps/mercado-livre/functions/src/sendStock.ts':
    'Stock push. Enqueued by the three onSchedule stock sweeps (functions runtime SA) and self-re-enqueued on a 429.',

  // ---- codebase `mercado-pago` --------------------------------------------
  'apps/mercado-pago/functions/src/processNotification.ts':
    'The Mercado Pago IPN handler. Enqueued by the receiver route only.',

  // ---- codebase `melhor-envio` -------------------------------------------
  'apps/melhor-envio/functions/src/processNotification.ts':
    'The Melhor Envio order-status webhook handler. Enqueued by the receiver route only.',

  // ---- codebase `shopee` --------------------------------------------------
  'apps/shopee/functions/src/processNotification.ts':
    'The Shopee push notification handler. Enqueued by the receiver route and, since step 17, the reclamacao/acao route (one synthetic code 29 after a seller action) — both under the App Hosting runtime SA — AND by the functions runtime SA: six onSchedule producers (the lost-push sweep and the order backfill, step 4; the escrow-settlement sweep, step 6; the stuck-reservation sweep, step 8; the auto-arrange sweep, step 15b; the returns sweep, step 17) and the handler ITSELF since step 7 (one synthetic code 3 when a shipment push — or, since step 17, a return push — finds no pedido, also reached by the inline re-drives of the reprocess sweep) — so two identities dispatch it.',
  'apps/shopee/functions/src/processMassImport.ts':
    'The Shopee mass product import ("importar todos os anuncios", master-plan step 9). Enqueued by the /importar-todos route under the App Hosting runtime SA and re-enqueued by ITSELF — for every scan/drain continuation AND for the rate-limit pause (scheduleDelaySeconds) — so two identities dispatch it.',
  'apps/shopee/functions/src/sendStock.ts':
    'The Shopee stock push (master-plan step 12). Enqueued by the three onSchedule stock sweeps (functions runtime SA) and self-re-enqueued on a rate-limit pause — the burst arm and the pause rung both re-enqueue onto this queue with scheduleDelaySeconds — so two identities dispatch it. The manual push (/enviar-estoque) runs IN-PROCESS and never enqueues.',
  'apps/shopee/functions/src/processPriceSync.ts':
    'The Shopee account-wide price job ("atualizar precos", master-plan step 13). Enqueued by the /atualizar-precos route (App Hosting runtime SA) and re-enqueued by ITSELF for every plan/drain continuation, the burst pause and the daily park (scheduleDelaySeconds) — two identities. The manual price push (/enviar-precos) runs IN-PROCESS and never enqueues.',
  'apps/shopee/functions/src/processNfeUpload.ts':
    'The Shopee NF-e XML upload (master-plan step 14). Enqueued by the onNfeAprovadaShopee Firestore trigger (functions runtime SA) and by the /enviar-nfe route (App Hosting runtime SA), and re-enqueued by ITSELF for the SERPRO wait on error #5, the burst pause, the daily park and the ~15-min recheck (scheduleDelaySeconds) — two identities. The enviar:nfe CLI runs the handler IN-PROCESS and enqueues nothing.',

  // ---- codebase `whatsapp` ------------------------------------------------
  'apps/whatsapp/functions/src/processNotification.ts':
    'The WhatsApp Cloud API notification handler. Enqueued by the receiver route only.',

  // ---- codebase `loja-integrada` -------------------------------------------
  'apps/loja-integrada/functions/src/filaLeitura.ts':
    'The Loja Integrada reads queue (filaLeituraLojaIntegrada, order intake). Enqueued by the order poller (functions runtime SA); the App Hosting runtime SA joins in step 4 (the inbound webhook), and the credential routes only re-drive Firestore rows.',
  'apps/loja-integrada/functions/src/filaEscrita.ts':
    'The Loja Integrada writes queue (filaEscritaLojaIntegrada, master-plan step 7: the status write-back and its in-queue varredura). Enqueued by the onHistoricoFreteLojaIntegrada Firestore trigger (one named rastreio task per freight history row) and by the varrerEscritasLojaIntegrada onSchedule timer (one named varredura task per tick) — both the functions runtime SA, and nothing else; the varredura re-runs rows inside the queue and never enqueues.',

  // ---- codebase `amazon` --------------------------------------------------
  'apps/amazon/functions/src/filaLeitura.ts':
    'The Amazon reads queue (filaLeituraAmazon, order intake). Enqueued by the push receiver route (App Hosting runtime SA) and by the 15-minute backstop poll pollAmazonOrders (functions runtime SA, through functions/src/agendador.ts). The reprocess sweep re-drives rows inline and never enqueues.',

  // ---- codebase `nfe` -----------------------------------------------------
  'apps/nfe/functions/src/reconciliar.ts':
    'The async SEFAZ reconciler. Enqueued by three apps/nfe routes AND re-enqueued by itself while cStat=105 / CC-e 136.',

  // ---- codebase `storage` (apps/functions) --------------------------------
  'apps/functions/src/estoques/aplicarBalanco.ts':
    'processarBalanco. Enqueued by the `finalizarBalanco` callable and re-enqueued by itself at the time-budget boundary.',
  'apps/functions/src/produtos/kitRollup.ts':
    'recalcularDimensoesKit. Enqueued by the `onProdutoChanged` Firestore trigger (functions runtime SA) and re-enqueued by ITSELF for every continuation page and for the nested-kit cascade.',
};

/**
 * Source only. A test may reference `onTaskDispatched` while asserting on it;
 * inventorying tests would be noise that hides a real new call site. The
 * `rules/*` exclusion also keeps out `__fixtures__/tasks-invoker/`, which only
 * the near-miss block at the bottom scans.
 */
const PATHSPECS = ['*.ts', ':(exclude)*.test.ts', ':(exclude)packages/config-eslint/rules/*'];

/**
 * A CALL of `onTaskDispatched`, with or without a type argument —
 * `onTaskDispatched(`, `onTaskDispatched<Payload>(`, and the form prettier prints
 * when the type argument does not fit on one line, with `onTaskDispatched<` and
 * `>(` on different lines.
 *
 * ⚠️ The type argument is why this is a regex at all. The guard used to
 * `git grep` the literal `onTaskDispatched(`, and a typed call —
 * `onTaskDispatched<unknown>(`, which is what the Loja Integrada codebase first
 * wrote (#1891/#1892) — slipped past EVERY assertion in this file at once: the
 * UNLISTED check, the invoker spread, and the codebase discovery the floors
 * count. It surfaced only because the same change also added its INVENTORY row
 * and raised the floor ("STALE entry", "only 17 task files"); a typed task
 * function added without those would have deployed with no `invoker` while
 * this file stayed green.
 *
 * - `\b` in front and the `\s*` / `<` / `(` after the name are what keep
 *   `onTaskDispatchedX(` and `myonTaskDispatched(` out: tolerating a type
 *   argument must not widen into "any identifier containing the name". A
 *   namespace call (`tasks.onTaskDispatched(`) still matches — `.` is a word
 *   boundary.
 * - `[\s\S]*?` is lazy and spans lines on purpose, so a NESTED type argument
 *   (`<Record<K, V>>`) closes at the right `>` and a line-broken one is seen
 *   whole. Its only failure mode is matching MORE, which reports loudly as
 *   UNLISTED; matching less is the silent failure this regex exists to retire.
 * - Prose (`` `onTaskDispatched` ``, `onTaskDispatched.rateLimits`) is not a
 *   call and does not match. Comments are deliberately NOT stripped first: a
 *   comment that spells out the literal call shape still counts, and that fails
 *   loudly — whereas a comment stripper fooled by a `/*` inside a string literal
 *   would drop a real call silently.
 */
const TASK_CALL_RE = /\bonTaskDispatched\s*(?:<[\s\S]*?>)?\s*\(/;

/**
 * Non-vacuity floor. Every assertion below is driven by `taskFunctionFiles()`,
 * so a `git grep` that silently matches nothing would make the whole file pass
 * having checked NOTHING — the "green job that ran zero tests" shape. These are
 * a floor, not an inventory: they only ever need raising.
 */
const MIN_TASK_FILES = 20;
const MIN_CODEBASES = 9;

function read(file) {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/**
 * Files under `pathspecs` that merely NAME `onTaskDispatched` — the candidates
 * `discoverTaskFiles` then decides on.
 *
 * Deliberately the bare identifier as a fixed string: every spelling of a call
 * contains the name on SOME line, so this stage cannot be the one that misses a
 * call. It also nominates every docblock that only mentions the function (~60
 * files today), which `TASK_CALL_RE` then drops.
 * @param {readonly string[]} pathspecs
 */
function taskCandidateFiles(pathspecs) {
  return gitGrep({ patterns: 'onTaskDispatched', pathspecs, mode: 'fixed' });
}

/**
 * Files under `pathspecs` that CALL `onTaskDispatched` (see `TASK_CALL_RE`),
 * sorted.
 *
 * Two stages, and the split is the fix: `git grep` is LINE-oriented, so no grep
 * pattern can see a type argument that prettier has broken across lines
 * (`__fixtures__/tasks-invoker/typed-call-line-broken.ts`). The call shape is
 * therefore matched in JS over the whole file, and the grep only nominates.
 * @param {readonly string[]} pathspecs
 */
function discoverTaskFiles(pathspecs) {
  return taskCandidateFiles(pathspecs).filter((f) => TASK_CALL_RE.test(read(f)));
}

/** The files among `files` that do not spread the invoker helper into their options. */
function missingInvokerSpread(files) {
  return files.filter((f) => !read(f).includes('...tasksInvokerOptions()'));
}

/**
 * ⚠️ Called from EIGHT assertions below (four of them via `codebaseRoots()`), so
 * the answer is computed once per run of this file. `lib/repo-scan.js` already
 * memoizes the `git grep` spawn — this used to be nine `git grep --untracked`
 * per run, which on Windows under the parallel suite is several seconds of pure
 * process cost and is what made the guard flake on the 5s default timeout (see
 * that module's header) — and this memo spares re-reading the ~60 candidates.
 * Sound for the same reason: the repo does not change while the suite runs.
 * @type {string[] | undefined}
 */
let taskFiles;
function taskFunctionFiles() {
  taskFiles ??= discoverTaskFiles(PATHSPECS);
  return taskFiles;
}

/**
 * The functions codebases, DISCOVERED from the task files rather than listed.
 *
 * ⚠️ This is the whole point. Enumerating the seven `build.mjs` and the seven
 * `tasksInvoker.ts` would leave a SIXTH codebase checked by `INVENTORY` (its
 * task function is forced into the list, and forced to spread the helper) while
 * nothing asserted its build carries the `define`. That state passes every
 * assertion here and still ships `invoker` silently omitted, because an
 * un-`define`d `process.env.TASKS_INVOKER_SA` is `undefined` during codebase
 * analysis and the helper degrades to `{}`. Discovering is what makes the guard
 * cover a codebase nobody remembered to add — the same reason
 * `runtime-deps-pinned.test.js:91` unions `git ls-files` instead of listing
 * manifests.
 *
 * A codebase root is the nearest ancestor of a task file that owns a
 * `build.mjs` — that file is what performs the inlining, so it defines the unit.
 */
function codebaseRoots() {
  const roots = new Map(); // root → the task file that led us there
  const orphans = [];
  for (const file of taskFunctionFiles()) {
    let dir = dirname(file);
    let found = null;
    while (dir && dir !== '.' && dir !== '/') {
      if (existsSync(resolve(REPO_ROOT, dir, 'build.mjs'))) {
        found = dir;
        break;
      }
      dir = dirname(dir);
    }
    if (found) {
      if (!roots.has(found)) roots.set(found, file);
    } else {
      orphans.push(file);
    }
  }
  return { roots: [...roots.keys()].sort(), orphans };
}

describe('every onTaskDispatched declares its Cloud Tasks invoker (#1133)', () => {
  it('has no UNLISTED task function', () => {
    const unlisted = taskFunctionFiles().filter((f) => !(f in INVENTORY));
    expect(
      unlisted,
      [
        'These files declare an `onTaskDispatched` and are not in INVENTORY. A task',
        'function needs `...tasksInvokerOptions()` in its options, or its Cloud Run',
        'service deploys with NO roles/run.invoker binding — and that failure is',
        'silent: the enqueue succeeds, nothing writes a failure document, and the only',
        'evidence is a 403 WARNING in the function own log.',
        '',
        'Add the file here with a one-liner saying WHO enqueues it (the App Hosting',
        'runtime SA, the functions runtime SA, or both), then wire the spread.',
        'Offending files:',
        ...unlisted.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE entry for a file that no longer declares one', () => {
    const current = new Set(taskFunctionFiles());
    const stale = Object.keys(INVENTORY).filter((f) => !current.has(f));
    expect(
      stale,
      [
        'These INVENTORY entries no longer declare an `onTaskDispatched` — renamed,',
        'deleted, or converted. Remove them so the inventory keeps being read as',
        'current rather than decoration:',
        ...stale.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('spreads tasksInvokerOptions() at EVERY call site', () => {
    const missing = missingInvokerSpread(Object.keys(INVENTORY));
    expect(
      missing,
      [
        'These task functions do not spread `...tasksInvokerOptions()` into their',
        'options, so they deploy with no invoker binding and silently fall back to the',
        'manual gcloud grant in DEPLOY.md:',
        ...missing.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('the invoker value reaches the bundle (#1133)', () => {
  it('discovered enough to be checking anything at all', () => {
    // Everything below is driven by the discovery above, so a `git grep` that
    // matched nothing would pass every assertion having verified NOTHING. These
    // floors turn that into a failure. Raise them when a codebase is added.
    const files = taskFunctionFiles();
    const { roots } = codebaseRoots();
    expect(
      files.length,
      `only ${files.length} task files discovered — is the grep broken?`,
    ).toBeGreaterThanOrEqual(MIN_TASK_FILES);
    expect(
      roots.length,
      `only ${roots.length} codebases discovered: ${roots.join(', ')}`,
    ).toBeGreaterThanOrEqual(MIN_CODEBASES);
  });

  it('has no task function outside a codebase that can inline the value', () => {
    const { orphans } = codebaseRoots();
    expect(
      orphans,
      [
        'These task functions have no `build.mjs` in any ancestor directory, so',
        'nothing can inline `TASKS_INVOKER_SA` for them and `invoker` can only ever',
        'be omitted. Either they belong in a functions codebase, or that codebase',
        'needs a build script:',
        ...orphans.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('is inlined by EVERY discovered functions build', () => {
    // Function options are evaluated during Firebase's codebase analysis, before
    // any env exists — a runtime `process.env` read is `undefined` there. Same
    // reason `FUNCTIONS_REGION` is `define`d. A build that forgets it emits a
    // bundle whose invoker is silently absent.
    const missing = codebaseRoots()
      .roots.map((root) => `${root}/build.mjs`)
      .filter((f) => !read(f).includes("'process.env.TASKS_INVOKER_SA': JSON.stringify("));
    expect(
      missing,
      [
        'These build.mjs files do not `define` process.env.TASKS_INVOKER_SA, so the',
        'helper reads `undefined` during codebase analysis and every task function in',
        'that codebase deploys with no invoker — while every other assertion here',
        'passes, which is exactly the hole this discovery closes:',
        ...missing.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('keeps EVERY discovered copy of the helper IDENTICAL', () => {
    // This is the #1108 guard. N copies each pinned by its own local test is
    // exactly the configuration in which a fix lands in one and CI stays green.
    const helpers = codebaseRoots().roots.map((root) => `${root}/src/tasksInvoker.ts`);
    const absent = helpers.filter((f) => !existsSync(resolve(REPO_ROOT, f)));
    expect(
      absent,
      [
        'These functions codebases declare an `onTaskDispatched` but have no',
        '`src/tasksInvoker.ts`. Copy it verbatim from a sibling:',
        ...absent.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);

    const normalised = helpers.map((f) => read(f).replace(/\r\n/g, '\n'));
    const drifted = helpers.filter((_, i) => normalised[i] !== normalised[0]);
    expect(
      drifted,
      [
        `These copies of tasksInvoker.ts differ from ${helpers[0]}. They cannot be`,
        'collapsed into one module — the build.mjs scripts are standalone and import',
        'nothing — so byte-equality is the only thing holding them together.',
        'Apply the change to all of them:',
        ...drifted.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('never assigns back to the esbuild-defined expression', () => {
    // esbuild substitutes EVERY read of `process.env.TASKS_INVOKER_SA`, so an
    // assignment compiles to `"x" = "x"` and warns — #1108 hit exactly this with
    // the region. The helper must only ever read it.
    const assigning = codebaseRoots()
      .roots.map((root) => `${root}/src/tasksInvoker.ts`)
      .filter(
        (f) =>
          existsSync(resolve(REPO_ROOT, f)) &&
          /process\.env\.TASKS_INVOKER_SA\s*\??=[^=]/.test(read(f)),
      );
    expect(
      assigning,
      `These files assign to the esbuild-defined expression: ${assigning.join(', ')}`,
    ).toEqual([]);
  });
});

describe('discovery sees a typed call, and only a call (near-miss fixtures)', () => {
  // The same `discoverTaskFiles` / `missingInvokerSpread` the inventory above
  // runs, pointed at committed fixtures instead of the repo. Every real task
  // function today is untyped, so without these nothing would notice the
  // matcher regressing to the literal `onTaskDispatched(` — the repo scan
  // would stay green over exactly the shape it then misses.
  const DIR = 'packages/config-eslint/rules/__fixtures__/tasks-invoker';
  const SPEC = [`${DIR}/*.ts`];
  const CALLS = [
    `${DIR}/typed-call-line-broken.ts`,
    `${DIR}/typed-call-no-invoker.ts`,
    `${DIR}/typed-call.ts`,
    `${DIR}/untyped-call.ts`,
  ];

  it('discovers the typed, line-broken typed and untyped calls — and nothing else', () => {
    expect(discoverTaskFiles(SPEC)).toEqual(CALLS);
  });

  it('keeps each call fixture naming the function ONCE, on its code line', () => {
    // A comment that spells out the call shape counts as a call (on purpose —
    // see TASK_CALL_RE), so a call fixture whose comment did would be
    // discovered THROUGH THE COMMENT and keep passing with the matcher broken.
    // That is exactly how a first draft of these fixtures passed a `[^>]*`
    // matcher that cannot see the line-broken call.
    for (const f of CALLS) expect(read(f).match(/onTaskDispatched/g), f).toHaveLength(1);
  });

  it('drops the near misses at the MATCHER, not by never reading them', () => {
    // Both files name the function, so the candidate grep MUST nominate them;
    // only the call shape may keep them out. Without this half, the exact list
    // above would also pass if the grep stopped reaching them at all.
    const nearMisses = [`${DIR}/comment-mention.ts`, `${DIR}/identifier-near-miss.ts`];
    expect(taskCandidateFiles(SPEC)).toEqual(expect.arrayContaining(nearMisses));
    for (const f of nearMisses) expect(discoverTaskFiles(SPEC)).not.toContain(f);
  });

  it('flags the typed call that does not spread the invoker', () => {
    expect(missingInvokerSpread(discoverTaskFiles(SPEC))).toEqual([
      `${DIR}/typed-call-no-invoker.ts`,
    ]);
  });
});

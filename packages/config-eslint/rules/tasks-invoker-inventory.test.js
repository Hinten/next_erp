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
 * green. A per-file lint rule cannot express "these five agree"; that IS the
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

  // ---- codebase `whatsapp` ------------------------------------------------
  'apps/whatsapp/functions/src/processNotification.ts':
    'The WhatsApp Cloud API notification handler. Enqueued by the receiver route only.',

  // ---- codebase `nfe` -----------------------------------------------------
  'apps/nfe/functions/src/reconciliar.ts':
    'The async SEFAZ reconciler. Enqueued by three apps/nfe routes AND re-enqueued by itself while cStat=105 / CC-e 136.',

  // ---- codebase `storage` (apps/functions) --------------------------------
  'apps/functions/src/estoques/aplicarBalanco.ts':
    'processarBalanco. Enqueued by the `finalizarBalanco` callable and re-enqueued by itself at the time-budget boundary.',
};

/**
 * Source only. A test may reference `onTaskDispatched` while asserting on it;
 * inventorying tests would be noise that hides a real new call site.
 */
const PATHSPECS = ['*.ts', ':(exclude)*.test.ts', ':(exclude)packages/config-eslint/rules/*'];

/**
 * Non-vacuity floor. Every assertion below is driven by `taskFunctionFiles()`,
 * so a `git grep` that silently matches nothing would make the whole file pass
 * having checked NOTHING — the "green job that ran zero tests" shape. These are
 * a floor, not an inventory: they only ever need raising.
 */
const MIN_TASK_FILES = 9;
const MIN_CODEBASES = 5;

function read(file) {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/**
 * ⚠️ Called from EIGHT assertions below (four of them via `codebaseRoots()`).
 * That is only affordable because `lib/repo-scan.js` memoizes the spawn: this
 * used to be nine `git grep --untracked` per run of this file, which on Windows
 * under the parallel suite is several seconds of pure process cost and is what
 * made the guard flake on the 5s default timeout. See that module's header.
 */
function taskFunctionFiles() {
  return gitGrep({ patterns: 'onTaskDispatched(', pathspecs: PATHSPECS });
}

/**
 * The functions codebases, DISCOVERED from the task files rather than listed.
 *
 * ⚠️ This is the whole point. Enumerating the five `build.mjs` and the five
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
    const missing = Object.keys(INVENTORY).filter(
      (f) => !read(f).includes('...tasksInvokerOptions()'),
    );
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

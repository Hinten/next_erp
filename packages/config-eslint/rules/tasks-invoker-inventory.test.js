import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

/** The five esbuild scripts that must inline the value the helper reads. */
const BUILDS = [
  'apps/mercado-livre/functions/build.mjs',
  'apps/mercado-pago/functions/build.mjs',
  'apps/whatsapp/functions/build.mjs',
  'apps/nfe/functions/build.mjs',
  'apps/functions/build.mjs',
];

/** The five copies of the helper, which must stay identical. */
const HELPERS = [
  'apps/mercado-livre/functions/src/tasksInvoker.ts',
  'apps/mercado-pago/functions/src/tasksInvoker.ts',
  'apps/whatsapp/functions/src/tasksInvoker.ts',
  'apps/nfe/functions/src/tasksInvoker.ts',
  'apps/functions/src/tasksInvoker.ts',
];

/**
 * Source only. A test may reference `onTaskDispatched` while asserting on it;
 * inventorying tests would be noise that hides a real new call site.
 */
const PATHSPECS = ['*.ts', ':(exclude)*.test.ts', ':(exclude)packages/config-eslint/rules/*'];

function read(file) {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

function taskFunctionFiles() {
  try {
    return execFileSync('git', ['grep', '-l', 'onTaskDispatched(', '--', ...PATHSPECS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch (err) {
    // execFileSync throws on a non-zero exit; git grep exits 1 with no matches.
    if (err instanceof Error && 'status' in err && err.status === 1) return [];
    throw err;
  }
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
  it('is inlined by EVERY functions build', () => {
    // Function options are evaluated during Firebase's codebase analysis, before
    // any env exists — a runtime `process.env` read is `undefined` there. Same
    // reason `FUNCTIONS_REGION` is `define`d. A build that forgets it emits a
    // bundle whose invoker is silently absent.
    const missing = BUILDS.filter(
      (f) => !read(f).includes("'process.env.TASKS_INVOKER_SA': JSON.stringify("),
    );
    expect(
      missing,
      [
        'These build.mjs files do not `define` process.env.TASKS_INVOKER_SA, so the',
        'helper reads `undefined` during codebase analysis and every task function in',
        'that codebase deploys with no invoker:',
        ...missing.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('keeps the five helper copies IDENTICAL', () => {
    // This is the #1108 guard. Five copies each pinned by its own local test is
    // exactly the configuration in which a fix lands in one and CI stays green.
    const normalised = HELPERS.map((f) => read(f).replace(/\r\n/g, '\n'));
    const drifted = HELPERS.filter((_, i) => normalised[i] !== normalised[0]);
    expect(
      drifted,
      [
        `These copies of tasksInvoker.ts differ from ${HELPERS[0]}. They cannot be`,
        'collapsed into one module — the five build.mjs scripts are standalone and',
        'import nothing — so byte-equality is the only thing holding them together.',
        'Apply the change to all five:',
        ...drifted.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('never assigns back to the esbuild-defined expression', () => {
    // esbuild substitutes EVERY read of `process.env.TASKS_INVOKER_SA`, so an
    // assignment compiles to `"x" = "x"` and warns — #1108 hit exactly this with
    // the region. The helper must only ever read it.
    const assigning = HELPERS.filter((f) =>
      /process\.env\.TASKS_INVOKER_SA\s*\??=[^=]/.test(read(f)),
    );
    expect(
      assigning,
      `These files assign to the esbuild-defined expression: ${assigning.join(', ')}`,
    ).toEqual([]);
  });
});

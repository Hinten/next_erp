/**
 * Deploy preflight: what must be true about the ENVIRONMENT before a Cloud
 * Functions codebase is bundled and shipped.
 *
 * Sibling of `env-files.mjs`, which owns the same question for FILES. Both are
 * shared by all five `prepare-deploy.mjs`, and both fail the predeploy hook
 * outright rather than degrading — for the same reason: a deploy artifact is
 * uploaded and run, and a wrong one is discovered in production or not at all.
 *
 * ## WHY THIS EXISTS
 *
 * Every build-time value in this repo is a silent `||` default. `build.mjs` reads
 * `process.env.X || '<default>'` and esbuild `define`s the result, because
 * Firebase evaluates function options during codebase analysis, before any env
 * exists. That design is right, but it means **forgetting an export is
 * indistinguishable from choosing the default** — and for some of these values,
 * the difference only shows up as silence in production:
 *
 *   - `TASKS_INVOKER_SA` unset  -> `invoker` omitted -> `roles/run.invoker` never
 *     granted -> Cloud Tasks dispatches, the service answers 403, the enqueue had
 *     already returned success so NOTHING writes a failure document, and the only
 *     evidence is a warning in the function's own log (#1131, #1133).
 *   - a task/schedule region where Cloud Tasks does not exist -> every
 *     `onTaskDispatched`/`onSchedule` in the codebase fails to deploy while the
 *     Firestore triggers succeed (#1108: 11 of 15 functions, at once).
 *   - `FIREBASE_DATABASE_ID` wrong -> the trigger binds `(default)`, a database
 *     that does not exist here, and simply never fires.
 *
 * A `console.warn` is not a signal for any of these: it scrolls past in deploy
 * output and the deploy still succeeds.
 *
 * ## WHERE IT RUNS, AND WHY THAT PLACEMENT
 *
 * From the `predeploy` ARRAY of the five `firebase.*.deploy.json`, ahead of
 * `prepare-deploy.mjs`. The deploy config is what defines a deploy, so the guard
 * fires exactly when deploying and needs no opt-out flag:
 *
 *   - `ci-mercado-livre.yml` builds the emulator artifact by calling
 *     `prepare-deploy.mjs` DIRECTLY, and predeploy hooks do not run under
 *     `emulators:exec` (that workflow says so itself).
 *   - `turbo run build` reaches `build.mjs`, never a deploy config.
 *
 * So no CI lane sees this, and `build.mjs` keeps its warn-only behaviour for
 * local `node build.mjs` inspection. An env escape hatch was considered and
 * REJECTED: #1059 is the worked example of an env escape disabling a guard in the
 * one job that needed it.
 *
 * ⚠️ The defaults below are DUPLICATED from each `build.mjs` so the printed table
 * can show what will actually be baked in. `preflight.test.js` reads both and
 * fails if they disagree — never edit one alone.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regions that do NOT offer Cloud Tasks and Cloud Scheduler, so no
 * `onTaskDispatched` or `onSchedule` can live there.
 *
 * ⚠️ Deliberately MINIMAL — one measured entry, not a transcription of a docs
 * page. A false positive here blocks a legitimate deploy, which is worse than the
 * silence this guard exists to break. `us-east5` is here because it was measured:
 * the first ML production deploy failed 5 `onTaskDispatched` + 6 `onSchedule`
 * functions at once and left the 4 Firestore triggers untouched, and that
 * asymmetric failure list WAS the diagnosis. Add a region only with the same
 * quality of evidence.
 */
const REGIONS_WITHOUT_TASKS = new Set(['us-east5']);

/**
 * Per codebase: the build-time values, their `build.mjs` defaults, and which one
 * governs the TASK/SCHEDULE functions (the only one the region check applies to).
 *
 * `tasksRegionVar` is not always `*_TASKS_REGION`: only `mercado-livre` inlines a
 * separate one. In `mercado-pago` and `whatsapp` the task functions inherit
 * `setGlobalOptions({ region: FUNCTIONS_REGION })`, so FUNCTIONS_REGION is the
 * region their queues would be created in — which is why their `us-east5` default
 * is a latent broken deploy (#1121) that this preflight now refuses up front,
 * instead of 5 confusing per-function errors partway through.
 */
const CODEBASES = {
  'mercado-livre': {
    deployConfig: 'firebase.mercado-livre.deploy.json',
    buildScript: 'apps/mercado-livre/functions/build.mjs',
    deployDoc: 'apps/mercado-livre/functions/DEPLOY.md',
    inlined: {
      FUNCTIONS_REGION: 'us-east5',
      MERCADO_LIVRE_TASKS_REGION: 'us-east1',
      FIREBASE_DATABASE_ID: 'default',
    },
    tasksRegionVar: 'MERCADO_LIVRE_TASKS_REGION',
    // The variable the ENQUEUER reads, on the App Hosting backend. Set in
    // apphosting.yaml / the console, NOT in the deploy shell — so this script
    // cannot read it and can only print what it must equal.
    backendVar: 'MERCADO_LIVRE_TASKS_REGION',
    backendManifest: 'apps/mercado-livre/apphosting.yaml',
    // Read from the DEPLOYING shell and baked into onTaskDispatched.rateLimits
    // by firebase-tools' local trigger analysis — not an esbuild define, but the
    // same "silent default" shape, and equally invisible after the fact.
    // ⚠️ Source of truth: `envInt(...)` in bulkEstoquePlan.ts, drift-checked.
    deployShell: {
      MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES: '2',
      MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND: '2',
    },
    deployShellSource: 'apps/mercado-livre/lib/marketplace/bulkEstoquePlan.ts',
    // Read at RUNTIME by the enqueuer inside the deployed function, so a value in
    // `.env.deploy` (copied into the artifact by prepare-deploy.mjs) overrides
    // the inlined one. Printed, not validated — this script cannot see that file.
    runtimeOverrides: [],
  },
  'mercado-pago': {
    deployConfig: 'firebase.mercado-pago.deploy.json',
    buildScript: 'apps/mercado-pago/functions/build.mjs',
    deployDoc: 'apps/mercado-pago/functions/DEPLOY.md',
    inlined: { FUNCTIONS_REGION: 'us-east5' },
    tasksRegionVar: 'FUNCTIONS_REGION',
    backendVar: 'MERCADO_PAGO_TASKS_REGION',
    backendManifest: 'apps/mercado-pago/apphosting.yaml',
    deployShell: {},
    runtimeOverrides: ['MERCADO_PAGO_TASKS_REGION'],
  },
  whatsapp: {
    deployConfig: 'firebase.whatsapp.deploy.json',
    buildScript: 'apps/whatsapp/functions/build.mjs',
    deployDoc: 'apps/whatsapp/functions/DEPLOY.md',
    inlined: { FUNCTIONS_REGION: 'us-east5', FIREBASE_DATABASE_ID: 'default' },
    tasksRegionVar: 'FUNCTIONS_REGION',
    backendVar: 'WHATSAPP_TASKS_REGION',
    backendManifest: 'apps/whatsapp/apphosting.yaml',
    deployShell: {},
    runtimeOverrides: ['WHATSAPP_TASKS_REGION'],
  },
  nfe: {
    deployConfig: 'firebase.nfe.deploy.json',
    buildScript: 'apps/nfe/functions/build.mjs',
    deployDoc: 'apps/nfe/functions/DEPLOY.md',
    inlined: { FUNCTIONS_REGION: 'us-east1' },
    tasksRegionVar: 'FUNCTIONS_REGION',
    backendVar: 'NFE_TASKS_REGION',
    backendManifest: 'apps/nfe/apphosting.yaml',
    deployShell: {},
    runtimeOverrides: ['NFE_TASKS_REGION'],
  },
  storage: {
    deployConfig: 'firebase.functions.deploy.json',
    buildScript: 'apps/functions/build.mjs',
    deployDoc: 'apps/functions/DEPLOY.md',
    inlined: { FUNCTIONS_REGION: 'us-east1' },
    tasksRegionVar: 'FUNCTIONS_REGION',
    // No App Hosting backend enqueues this one — `processarBalanco` is enqueued
    // by the `finalizarBalanco` callable and by itself, both inside the codebase.
    backendVar: null,
    backendManifest: null,
    deployShell: {},
    // ⚠️ The one queue with NO sweep behind it, and its region has a runtime
    // override the inlined value does not cover.
    runtimeOverrides: ['BALANCO_TASKS_REGION'],
  },
};

/**
 * Blank and whitespace-only count as unset.
 *
 * ⚠️ This is NOT the same rule as `build.mjs`, and the difference matters. There
 * the expression is a bare `process.env.X || '<default>'` with no `trim()`, so
 * `''` falls through but `'   '` does NOT — a whitespace-only export is inlined
 * verbatim. `checkWhitespace` below turns that divergence into an error rather
 * than letting this table print a default the build will not use.
 */
function valueOf(env, name) {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * A value that is non-empty but not equal to its trimmed form is inlined WITH the
 * whitespace by `build.mjs`, while this script would report the trimmed value —
 * so the table would be lying about what the bundle gets. That is a genuine
 * "your export is not what will be baked in" condition, not a style nit.
 */
/** The region the queue/schedule functions will be created in. */
function tasksRegionOf(spec, env) {
  return valueOf(env, spec.tasksRegionVar) ?? spec.inlined[spec.tasksRegionVar] ?? '(unknown)';
}

function checkWhitespace(env, names) {
  const errors = [];
  for (const name of names) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw === '' || raw === raw.trim()) continue;
    errors.push(
      [
        `${name} is ${JSON.stringify(raw)} — it has surrounding whitespace, and`,
        '`build.mjs` inlines it VERBATIM (its expression is a bare `process.env.X ||',
        "'<default>'`, with no trim). The bundle would get the padded string while",
        'this table reported the trimmed one. Export it without the whitespace.',
      ].join('\n'),
    );
  }
  return errors;
}

/**
 * Resolve every build-time value for `codebase` and decide whether the deploy may
 * proceed. Pure: takes the env, returns rows + errors, prints nothing.
 *
 * @returns {{rows: Array<{name: string, value: string, source: string}>, errors: string[], tasksRegion: string}}
 */
export function preflight(codebase, env = process.env) {
  const spec = CODEBASES[codebase];
  if (!spec) {
    throw new Error(
      `Unknown functions codebase '${codebase}'. Known: ${Object.keys(CODEBASES).join(', ')}.`,
    );
  }

  const rows = [];
  const errors = [];

  const invoker = valueOf(env, 'TASKS_INVOKER_SA');
  rows.push({
    name: 'TASKS_INVOKER_SA',
    value: invoker ?? '(unset)',
    source: invoker ? 'env' : 'MISSING',
  });
  if (!invoker) {
    errors.push(
      [
        'TASKS_INVOKER_SA is not set, so `invoker` would be OMITTED from every',
        'onTaskDispatched in this codebase and the deploy would grant NO',
        'roles/run.invoker. That failure is SILENT: Cloud Tasks dispatches, the',
        'Cloud Run service answers 403, the enqueue already returned success, and',
        'nothing anywhere writes a failure document.',
        '',
        'Export it, comma-separated, naming EVERY enqueuer — the App Hosting',
        'runtime SA (the receiver routes) AND the functions runtime SA (the sweeps,',
        'the Firestore triggers and every self-continuation):',
        '',
        '  export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"',
        '',
        `Both emails and the rest: ${spec.deployDoc}.`,
      ].join('\n'),
    );
  }

  for (const [name, fallback] of Object.entries(spec.inlined)) {
    const set = valueOf(env, name);
    rows.push({
      name,
      value: set ?? fallback,
      source: set ? 'env' : 'build.mjs default',
    });
  }
  for (const [name, fallback] of Object.entries(spec.deployShell)) {
    const set = valueOf(env, name);
    rows.push({
      name,
      value: set ?? fallback,
      source: set ? 'env' : 'code default',
    });
  }

  // Runtime overrides are listed so the table is not read as complete. This
  // script cannot resolve them: they are read INSIDE the deployed function, and
  // `.env.deploy` (copied into the artifact by prepare-deploy.mjs) can set them
  // to something the inlined region disagrees with — the same silent drop, one
  // layer down. Validating that file is `env-files.mjs`' territory.
  for (const name of spec.runtimeOverrides) {
    rows.push({ name, value: `(falls back to ${tasksRegionOf(spec, env)})`, source: 'runtime' });
  }

  errors.push(...checkWhitespace(env, Object.keys(spec.inlined)));

  const tasksRegion =
    valueOf(env, spec.tasksRegionVar) ?? spec.inlined[spec.tasksRegionVar] ?? '(unknown)';
  if (REGIONS_WITHOUT_TASKS.has(tasksRegion)) {
    errors.push(
      [
        `${spec.tasksRegionVar} resolves to '${tasksRegion}', which has NO Cloud Tasks`,
        'and no Cloud Scheduler. Every onTaskDispatched and onSchedule in this',
        'codebase would fail to deploy, while the Firestore triggers succeeded — the',
        'asymmetric failure list from #1108.',
        '',
        `  export ${spec.tasksRegionVar}=us-east1   # or another region offering both`,
      ].join('\n'),
    );
  }

  return { rows, errors, tasksRegion };
}

/** Fixed-width table so the values are readable, not buried in deploy output. */
export function formatRows(rows) {
  const width = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `  ${r.name.padEnd(width)}  ${r.value}  [${r.source}]`).join('\n');
}

/**
 * The cross-check this script CANNOT perform: the enqueuer lives in the App
 * Hosting backend, whose env is set in `apphosting.yaml` / the console, not in
 * the deploy shell. A mismatch makes the Admin SDK resolve `us-central1` and the
 * task is SILENTLY DROPPED.
 *
 * ⚠️ This must fire for EVERY codebase with a backend enqueuer, not just
 * mercado-livre. The region abort above tells a mercado-pago/whatsapp operator to
 * `export FUNCTIONS_REGION=us-east1`, which moves the queue — while their
 * backends set no region variable at all, so the enqueuer keeps resolving the
 * `us-east5` code default. Obeying the remedy would CREATE the very mismatch this
 * PR fixed for mercado-livre, and a note that returned null for those two would
 * have said nothing about it.
 */
export function crossCheckNote(codebase, tasksRegion) {
  const spec = CODEBASES[codebase];
  if (!spec?.backendVar) return null;
  return [
    `⚠️  The queue/schedule functions are being created in ${tasksRegion}.`,
    `    The App Hosting BACKEND enqueues against ${spec.backendVar}, and it must`,
    `    resolve to the SAME region — otherwise the Admin SDK falls back to`,
    '    us-central1 and the task is silently dropped, with the route reporting',
    '    success (#1108).',
    '',
    `    Set it in ${spec.backendManifest} (or the console), then redeploy the`,
    `    backend:  ${spec.backendVar}=${tasksRegion}`,
  ].join('\n');
}

/** True when this module was run directly (`node tools/deploy-env/preflight.mjs x`). */
function isMain() {
  // ⚠️ Compare RESOLVED paths, never `file://${process.argv[1]}` — that string is
  // a no-op on Windows (drive letters + backslashes never match), which makes the
  // whole guard silently skip while exiting 0.
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const codebase = process.argv[2];
  /* eslint-disable no-console -- deploy hook output; this IS the deliverable */

  // Validated here rather than caught below: a bad argument is a typo in a
  // `firebase.*.deploy.json` predeploy line, and it must not reach `preflight()`
  // and surface as a stack trace an operator has to decode. Everything else that
  // could throw is a genuine bug and is deliberately left to propagate — a
  // catch-all here would swallow it and let the deploy proceed unchecked.
  if (!Object.prototype.hasOwnProperty.call(CODEBASES, codebase ?? '')) {
    console.error(
      `\n✖ deploy preflight: unknown codebase '${codebase ?? '(none)'}'.\n` +
        `  Usage: node tools/deploy-env/preflight.mjs <${Object.keys(CODEBASES).join('|')}>\n`,
    );
    process.exit(1);
  }

  const { rows, errors, tasksRegion } = preflight(codebase);
  console.log(`\ndeploy preflight — codebase '${codebase}'\n`);
  console.log(formatRows(rows));
  const note = crossCheckNote(codebase, tasksRegion);
  if (note) console.log(`\n${note}`);
  if (errors.length > 0) {
    console.error(`\n✖ deploy preflight FAILED for '${codebase}':\n`);
    for (const e of errors) console.error(`${e}\n`);
    process.exit(1);
  }
  console.log('\n✓ deploy preflight passed\n');
  /* eslint-enable no-console */
}

export { CODEBASES, REGIONS_WITHOUT_TASKS };

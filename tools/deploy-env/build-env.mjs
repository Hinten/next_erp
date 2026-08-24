/**
 * Where the BUILD-TIME env may come from: an optional repo-root `.env.functions`.
 *
 * Third sibling in this package. `env-files.mjs` owns which `.env*` files may sit
 * INSIDE a deploy artifact; `preflight.mjs` owns whether the env is fit to deploy;
 * this one owns where that env is allowed to be read from in the first place.
 *
 * ## WHY A FILE AT ALL, WHEN `.env.local` IS BANNED
 *
 * Function options are evaluated during Firebase's codebase analysis, before any
 * env exists, so `build.mjs` inlines them with an esbuild `define` read from
 * `process.env`. That left `export`-in-the-deploy-shell as the only supply route —
 * and forgetting the export is exactly the failure #1148 turned into a hard abort.
 * A file is the ergonomic fix.
 *
 * It must NOT be `.env.local`, and the reason is not taste. The deploy artifact is
 * uploaded to the project's `gcf-sources-*` bucket AND baked in plaintext into the
 * Cloud Run revision, so anything the build reads can leak; `.env.local` holds
 * credentials, which is why `env-files.mjs` ignores it and no `build.mjs` has ever
 * loaded it.
 *
 * ⚠️ A repo-ROOT file is structurally safe from that. Every `prepare-deploy.mjs`
 * calls `copyDeployEnv(pkgDir, deployDir)` with the FUNCTIONS PACKAGE directory
 * (`apps/<app>/functions`), never the root — so a root file is never scanned, never
 * copied, and cannot reach the cloud. That is the property this file depends on;
 * if the artifact builder ever learns to scan the root, this design is void.
 *
 * ⚠️ `turbo.json` lists this file under `globalDependencies`. `apps/functions` is
 * the one workspace whose `build` turbo CACHES, and turbo hashes the ENV VAR, not
 * the file — so without that entry a cached `dist/` built from a different
 * `.env.functions` would be replayed. (turbo.json rejects unknown keys, so it
 * cannot carry a `"//"` comment of its own — this is that comment.)
 *
 * ## WHY A KEY WHITELIST, AND WHY UNKNOWN IS AN ERROR
 *
 * Structural safety stops the FILE from shipping. It does not stop a value from
 * shipping: whatever lands in `process.env` here is `define`d into the bundle by
 * esbuild and uploaded. So a secret pasted into `.env.functions` WOULD leak, in
 * plaintext, in the Cloud Run revision.
 *
 * The whitelist is what makes that impossible rather than merely discouraged, and
 * an unknown key is refused loudly for the same reason `env-files.mjs` rejects an
 * unexpected `.env*` name instead of ignoring it: a warning about a leaked
 * credential scrolls past, and the whole point of this PR series is that a
 * scrolling warning is not a signal.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A refusal to load the file, as opposed to any other failure.
 *
 * Named so callers can narrow on it (root `CLAUDE.md` rule 6: no generic catch).
 * The preflight prints it as an operator message; a `build.mjs` lets it fail the
 * build, which is the correct outcome there.
 */
export class BuildEnvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildEnvError';
  }
}

/** The operator-authored file. Gitignored; `.env.functions.example` is the template. */
export const BUILD_ENV_FILE = '.env.functions';

/**
 * The ONLY keys this file may set — every one a build-time value that some
 * `build.mjs` inlines or that `onTaskDispatched` reads at deploy time.
 *
 * ⚠️ Deliberately excludes anything naming the deploy TARGET (project id,
 * credentials, service-account paths). Those stay with `.env.local` / the
 * `--project` flag; widening this set is how the file stops being auditable.
 *
 * ⚠️ Nothing here may be credential material. `build-env.test.js` asserts that
 * against the same secret-suffix rule `env-example-split.test.js` uses —
 * `TASKS_INVOKER_SA` is a service-account EMAIL, which is an identifier, not a key.
 */
export const BUILD_ENV_KEYS = new Set([
  'TASKS_INVOKER_SA',
  'FUNCTIONS_REGION',
  'FIREBASE_DATABASE_ID',
  'MERCADO_LIVRE_TASKS_REGION',
]);

/**
 * ⚠️ Read by firebase-tools' TRIGGER ANALYSIS, which this file cannot reach.
 *
 * `rateLimits` is evaluated in the options object at module load — inside the
 * `firebase-functions` child that `firebase deploy` spawns AFTER the predeploy
 * hooks. That child is a SIBLING of this process and inherits the DEPLOY SHELL's
 * env, so nothing a predeploy hook writes to its own `process.env` is visible to
 * it. Worse, these two are read as `envInt(name, 2)` →
 * `process.env[name]` — COMPUTED access, which esbuild's `define` cannot rewrite
 * either, so they are not inlined the way the keys above are.
 *
 * Accepting them here would produce a value that looks configured and is not —
 * the exact failure class this whole subsystem exists to remove. They are refused
 * with instructions instead.
 */
export const SHELL_ONLY_KEYS = new Set([
  'MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND',
  'MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES',
]);

/**
 * ⚠️ Read at RUNTIME, inside the deployed function.
 *
 * No `build.mjs` `define`s these; each codebase's `options.ts` defaults them to
 * the inlined region at module load. Their real supply route is the artifact's
 * own `.env.deploy`, which `env-files.mjs` copies. Setting them here would do
 * nothing at all.
 */
export const RUNTIME_KEYS = new Set([
  'MERCADO_PAGO_TASKS_REGION',
  'WHATSAPP_TASKS_REGION',
  'NFE_TASKS_REGION',
  'BALANCO_TASKS_REGION',
  'KIT_ROLLUP_TASKS_REGION',
]);

/**
 * `KEY=value` lines; comments and blanks are not declarations.
 *
 * ⚠️ Split on `/\r?\n/`, never `'\n'`. `core.autocrlf=true` here, so a Windows
 * checkout smudges this file to CRLF and a `'\n'` split leaves a trailing `\r` on
 * every value — which would then be inlined into the bundle. The same bug once
 * made `env-example-split.test.js` pass vacuously for every local developer while
 * staying green in CI, whose checkout is LF.
 *
 * ⚠️ Strips ONE matching pair of surrounding quotes: this repo's own `.env.local`
 * writes `FIREBASE_PROJECT_ID="veste-france-debug"`, so an operator will copy that
 * habit here, and an unstripped quote would be baked into the region literal.
 */
export function parseBuildEnv(text) {
  const entries = [];
  const malformed = [];
  // ⚠️ Strip a UTF-8 BOM. PowerShell's `>` and `Out-File` write one here, and it
  // would otherwise make the first key `﻿TASKS_INVOKER_SA` — rejected with a
  // message naming a key that looks identical to the one the operator typed.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // ⚠️ Accept a leading `export `. Every DEPLOY.md, this module's own rejection
    // text and `.env.example` all tell the operator to type
    // `export TASKS_INVOKER_SA="…"`, so that is the line they will paste in here.
    // Refusing the exact syntax we taught them would be hostile; silently dropping
    // it is worse, which is what the `malformed` branch below is for.
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      malformed.push(`  line ${index + 1}: ${JSON.stringify(line)}`);
      continue;
    }
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key: match[1], value });
  }

  // ⚠️ A line that does not parse is an ERROR, never a skip. Skipping is the one
  // outcome this whole subsystem exists to forbid: for TASKS_INVOKER_SA a dropped
  // line at least aborts later as MISSING, but for FUNCTIONS_REGION or
  // MERCADO_LIVRE_TASKS_REGION it falls back to the build default, prints
  // `[build.mjs default]` and EXITS 0 — a deploy to the wrong region with the file
  // sitting right there, saying otherwise.
  if (malformed.length > 0) {
    throw new BuildEnvError(
      [
        `${BUILD_ENV_FILE} has ${malformed.length === 1 ? 'a line' : 'lines'} it cannot parse:`,
        '',
        ...malformed,
        '',
        'Expected `KEY=value`, one per line (a leading `export ` is fine, and `#`',
        'starts a comment). Keys are UPPER_SNAKE_CASE.',
        '',
        'This is an error rather than a skipped line on purpose: a dropped',
        'FUNCTIONS_REGION would silently fall back to the build default and deploy',
        'to the wrong region, with the file in front of you saying otherwise.',
      ].join('\n'),
    );
  }
  return entries;
}

/**
 * Apply `<repoRoot>/.env.functions` onto `env`, and report what it set.
 *
 * A missing file is a SILENT no-op — CI lanes, fresh clones and the emulator
 * artifact build all run without one, and none of them should care.
 *
 * ⚠️ The real environment WINS. A value already exported is left alone, so `CI`
 * (which exports these directly) is unaffected and a one-off
 * `FUNCTIONS_REGION=… firebase deploy` still overrides the file. "Already set"
 * means non-blank, matching `build.mjs`'s `||` semantics rather than `??`.
 *
 * @returns {{file: string|null, applied: string[], skipped: string[]}}
 */
export function loadBuildEnv(repoRoot = REPO_ROOT, env = process.env) {
  const file = join(repoRoot, BUILD_ENV_FILE);
  if (!existsSync(file)) return { file: null, applied: [], skipped: [] };

  const entries = parseBuildEnv(readFileSync(file, 'utf8'));

  // Three-way, like `classifyEnvFile`: a key that is merely UNKNOWN and a key that
  // is known-but-delivered-another-way need different instructions. Telling an
  // operator "unknown key" about a name that is real, just unreachable from here,
  // sends them to fix the spelling of something spelled correctly.
  const rejected = entries.map((e) => e.key).filter((k) => !BUILD_ENV_KEYS.has(k));
  if (rejected.length > 0) {
    const shellOnly = rejected.filter((k) => SHELL_ONLY_KEYS.has(k));
    const runtime = rejected.filter((k) => RUNTIME_KEYS.has(k));
    const unknown = rejected.filter((k) => !SHELL_ONLY_KEYS.has(k) && !RUNTIME_KEYS.has(k));

    const lines = [
      `${BUILD_ENV_FILE} contains ${rejected.length === 1 ? 'a key' : 'keys'} it cannot ` +
        `deliver: ${rejected.map((k) => JSON.stringify(k)).join(', ')}.`,
      '',
      'This file is read by the predeploy hooks, so it can only supply values that a',
      '`build.mjs` inlines with an esbuild `define`. Accepting anything else would',
      'produce a value that LOOKS configured and is not.',
      '',
    ];
    if (shellOnly.length > 0) {
      lines.push(
        `  ${shellOnly.join(', ')}`,
        '    → read by firebase-tools TRIGGER ANALYSIS, in a sibling process that',
        '      inherits the deploy shell, not this hook. Export it in the shell you',
        '      run `firebase deploy` from.',
        '',
      );
    }
    if (runtime.length > 0) {
      lines.push(
        `  ${runtime.join(', ')}`,
        '    → read at RUNTIME inside the deployed function. Put it in that',
        "      codebase's `.env.deploy`, which is copied into the artifact.",
        '',
      );
    }
    if (unknown.length > 0) {
      lines.push(
        `  ${unknown.join(', ')}`,
        '    → not a build-time name. If it is non-secret build-time config, add it',
        '      to BUILD_ENV_KEYS in tools/deploy-env/build-env.mjs and to',
        `      ${BUILD_ENV_FILE}.example. If it is credential material it belongs in`,
        '      Secret Manager — never in a file the build reads, because the bundle',
        '      is uploaded to the gcf-sources bucket AND stored in plaintext on the',
        '      Cloud Run revision.',
        '',
      );
    }
    lines.push(`Accepted here: ${[...BUILD_ENV_KEYS].sort().join(', ')}.`);
    throw new BuildEnvError(lines.join('\n'));
  }

  const applied = [];
  const skipped = [];
  for (const { key, value } of entries) {
    if (value === '') continue;
    const current = env[key];
    if (typeof current === 'string' && current.trim() !== '') {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { file, applied, skipped };
}

/**
 * Read a build-time region variable, or REFUSE the build.
 *
 * ⚠️ **There is deliberately no default.** Every `build.mjs` used to carry one
 * (`process.env.FUNCTIONS_REGION || 'us-east1'`), and that literal is how this
 * project drifted into three regions without anything ever failing: a default
 * guarantees the `options.ts` throw can never fire, so a forgotten variable
 * deploys to whichever region the literal happens to name rather than stopping.
 *
 * The failure it protects against is silent on both sides. A function deployed to
 * the wrong region still deploys; an enqueuer pointed at the wrong region does not
 * raise — the Admin SDK resolves `us-central1`, the queue does not exist there, and
 * the task is DROPPED while the route still answers 200 (#1108). Neither shows up
 * in a log you would think to read. A build that stops is the only cheap signal
 * available, so this throws where a default would have quietly succeeded.
 *
 * Trims, because the value reaches an esbuild `define` and a trailing space would
 * be baked into the bundle as part of the region id. Blank is treated as unset for
 * the same reason `loadBuildEnv` does: it matches the `||` semantics the callers
 * had before, so an exported-but-empty variable cannot pass for configured.
 *
 * @param {string} name  The variable to read, e.g. `'FUNCTIONS_REGION'`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} The trimmed region id.
 * @throws {BuildEnvError} When unset or blank.
 */
export function requireBuildRegion(name, env = process.env) {
  const value = env[name]?.trim();
  if (value) return value;

  throw new BuildEnvError(
    [
      `${name} is not set, so this build has no region to inline.`,
      '',
      'There is no default on purpose: the region is inlined into the bundle at',
      'build time, and a wrong one fails SILENTLY at runtime — a task enqueued',
      'against a queue that does not exist is dropped while the route still',
      'returns 200 (#1108).',
      '',
      'Supply it one of three ways:',
      `  - export ${name}=<region>            # the deploy shell`,
      `  - ${name}=<region>                   # ${BUILD_ENV_FILE}, at the repo root`,
      '  - set it in the workflow `env:` block  # CI',
      '',
      'The region is a per-project decision, not a constant — see ADR 0013 and',
      'issue #1115 for which one this project uses and why.',
    ].join('\n'),
  );
}

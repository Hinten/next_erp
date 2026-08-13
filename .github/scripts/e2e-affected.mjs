#!/usr/bin/env node
/**
 * Decide whether an e2e lane has to run for a given PR diff.
 *
 * WHY THIS EXISTS. The e2e lanes used to be gated by a top-level `paths:` filter
 * — a hand-written list of directories somebody once believed `apps/web` depended
 * on. It was wrong: `apps/web` imports `@delfrance/integrations-nfe` (33 files),
 * `@delfrance/integrations-freight-br` (15) and `@delfrance/storage` (12), and not
 * one of those was listed. Worse, a top-level `paths:` that does not match means
 * GitHub never instantiates the workflow, so it publishes NO check run at all —
 * not a failure, not a skip, nothing. "CI green" therefore did not imply
 * "e2e passed", and no required status check could ever be pinned to a lane that
 * reports nothing.
 *
 * The list did not rot because lists are bad. It rotted because it was a human's
 * guess at a dependency closure that nothing re-checked. So this script does not
 * keep a list: it WALKS the `workspace:*` graph from the lane's roots, every run.
 * Add a dependency to `apps/web` tomorrow and the closure grows by itself. There
 * is nothing left to keep in sync.
 *
 * DIRECTION OF FAILURE. Every uncertainty runs the suite. A path that belongs to
 * no known workspace — a root config, `firestore.rules`, a new top-level
 * directory nobody anticipated — runs it. Only two things skip: a path attributed
 * to a workspace OUTSIDE the lane's closure, and a short list of provably inert
 * documentation/tooling paths. Getting the skip wrong ships unverified code;
 * getting the run wrong costs one CI run.
 *
 * Usage (see .github/workflows/e2e-*.yml):
 *   node .github/scripts/e2e-affected.mjs --roots @delfrance/web --files list.txt
 */

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Directories scanned for workspace manifests. Mirrors `pnpm-workspace.yaml`'s
 * `packages:` globs. `packages/integrations` is listed separately because the
 * channel packages are one level deeper than everything else in `packages/`.
 */
export const WORKSPACE_GLOB_ROOTS = ['apps', 'packages', 'packages/integrations', 'tools'];

/**
 * Paths that cannot affect a Playwright run, checked BEFORE workspace attribution
 * so that e.g. `apps/web/README.md` counts as inert rather than as a change to
 * `apps/web`.
 *
 * Deliberately short and deliberately boring. Everything here is still covered by
 * `pnpm format:check` in ci.yml — it is not going unchecked, it is just not e2e's
 * business. Note what is NOT here: `.github/**` is absent on purpose, so a change
 * to any workflow re-runs the lane and the lane self-tests on the PR that edits it.
 */
export const INERT_PATTERNS = [
  /\.md$/,
  /^\.claude\//,
  /^\.changeset\//,
  /^\.husky\//,
  /^\.vscode\//,
  /^\.grok\//,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.editorconfig$/,
  /^\.prettierignore$/,
  /^\.git-blame-ignore-revs$/,
];

export function isInert(file) {
  return INERT_PATTERNS.some((re) => re.test(file));
}

/**
 * Read every workspace manifest into `{ name -> { dir, workspaceDeps } }`.
 *
 * `dir` is repo-relative and always POSIX-separated: it is compared against the
 * GitHub files API's paths, which are POSIX regardless of the runner's OS.
 */
export function loadWorkspaces(repoRoot) {
  const workspaces = new Map();
  for (const globRoot of WORKSPACE_GLOB_ROOTS) {
    const abs = path.join(repoRoot, globRoot);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(abs, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!json.name) continue;
      const all = { ...json.dependencies, ...json.devDependencies };
      workspaces.set(json.name, {
        dir: `${globRoot}/${entry.name}`,
        workspaceDeps: Object.entries(all)
          .filter(([, spec]) => String(spec).startsWith('workspace:'))
          .map(([dep]) => dep),
      });
    }
  }
  return workspaces;
}

/**
 * Transitive `workspace:*` closure of `roots`, inclusive of the roots themselves.
 *
 * A root naming no known workspace THROWS rather than resolving to an empty
 * closure: a typo'd root would otherwise make every path look "outside" and the
 * lane would skip forever while reporting green — the exact defect this file
 * exists to remove.
 */
export function closureOf(workspaces, roots) {
  const unknown = roots.filter((r) => !workspaces.has(r));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --roots: ${unknown.join(', ')}. Known workspaces: ${[...workspaces.keys()].sort().join(', ')}`,
    );
  }
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of workspaces.get(name)?.workspaceDeps ?? []) walk(dep);
  };
  roots.forEach(walk);
  return seen;
}

/**
 * The workspace owning `file`, by longest matching directory prefix.
 *
 * Longest-match matters: `packages/integrations/nfe/src/x.ts` must attribute to
 * `@delfrance/integrations-nfe`, not to some shallower entry. Returns null when no
 * workspace owns the path — root configs, `firestore.rules`, `.github/**` — which
 * the caller treats as "run".
 */
export function attributeFile(workspaces, file) {
  let best = null;
  for (const [name, { dir }] of workspaces) {
    if (file === dir || file.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.dir.length) best = { name, dir };
    }
  }
  return best;
}

/**
 * The verdict. `rows` is the per-path attribution table that gets printed into the
 * job summary — it is what makes a skip auditable instead of invisible.
 */
/**
 * Is `file` some OTHER lane's workflow definition?
 *
 * `.github/**` is deliberately not inert, so a lane re-runs when its own
 * definition changes and self-tests on the PR that edits it. But that was
 * originally implemented as "unattributable therefore run", which fired EVERY
 * lane for ANY workflow file: PR #1030 touched only `claude.yml` and
 * `claude-code-review.yml` — an on-demand review bot — and ran all three e2e
 * lanes. `.github/**` was the single biggest trigger in a 30-PR sample, hitting 17.
 *
 * So a lane's own workflow, plus shared machinery under `.github/scripts/` and
 * `.github/actions/`, still triggers it; another lane's workflow does not.
 * Everything else unattributable stays fail-safe and runs.
 */
function isOtherLaneWorkflow(file, selfPaths) {
  if (!file.startsWith('.github/workflows/')) return false;
  // No declaration, no narrowing. An empty `selfPaths` falls back to the
  // conservative "unattributable therefore run", NOT to "every workflow belongs to
  // somebody else" — otherwise a lane that forgets `--self` silently stops
  // re-running on edits to its own definition, which is a skip-direction failure.
  if (selfPaths.length === 0) return false;
  return !selfPaths.some((p) => file === p);
}

export function decide({ workspaces, closure, files, selfPaths = [] }) {
  const rows = [];
  let trigger = null;

  for (const file of files) {
    let verdict;
    if (isInert(file)) {
      verdict = { kind: 'inert', detail: 'documentation / tooling' };
    } else if (isOtherLaneWorkflow(file, selfPaths)) {
      verdict = { kind: 'outside', detail: "another lane's workflow definition" };
    } else {
      const owner = attributeFile(workspaces, file);
      if (!owner) {
        verdict = { kind: 'run', detail: 'belongs to no workspace (root config, rules, CI)' };
      } else if (closure.has(owner.name)) {
        verdict = { kind: 'run', detail: `${owner.name} (in closure)` };
      } else {
        verdict = { kind: 'outside', detail: `${owner.name} (outside closure)` };
      }
    }
    rows.push({ file, ...verdict });
    if (verdict.kind === 'run' && !trigger) trigger = { file, detail: verdict.detail };
  }

  if (trigger) {
    return {
      runE2e: true,
      reason: `${files.length} changed path(s); \`${trigger.file}\` requires this lane — ${trigger.detail}.`,
      rows,
    };
  }
  return {
    runE2e: false,
    reason: `all ${files.length} changed path(s) are inert or belong to workspaces outside this lane's dependency closure.`,
    rows,
  };
}

/**
 * The inverse mode: run only when a changed path sits under one of `prefixes`.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A RETURN TO THE OLD `paths:` LIST.
 * `decide()` answers "could this change possibly affect the lane?", and its safe
 * direction is RUN — a wrong answer there ships unverified code. Exactly one job
 * has the opposite economics: `nfe-live` emits real documents at SEFAZ
 * homologacao, which rate-limits (cStat=656). There, running unnecessarily is the
 * expensive mistake and skipping is cheap, because the offline NF-e suite has
 * already run and the gate states out loud that the live suite did not.
 *
 * Measured over 30 merged PRs: the dependency closure of
 * `@delfrance/integrations-nfe` fires on 14 of them, because that package depends
 * on `@delfrance/schemas` and `@delfrance/core`, which change constantly. It is
 * therefore useless as a narrowing device — hence this literal-prefix mode, which
 * fires on 3.
 *
 * Use this for NOTHING ELSE. Every other decision goes through `decide()`. A
 * hand-written list is tolerable here only because being wrong means "we did not
 * call SEFAZ", never "we shipped untested code".
 */
export function decideByPaths({ files, prefixes }) {
  const rows = [];
  let trigger = null;

  for (const file of files) {
    if (isInert(file)) {
      rows.push({ file, kind: 'inert', detail: 'documentation / tooling' });
      continue;
    }
    const hit = prefixes.find((p) => file === p || file.startsWith(p.endsWith('/') ? p : p + '/'));
    if (hit) {
      rows.push({ file, kind: 'run', detail: 'matches ' + hit });
      if (!trigger) trigger = { file, detail: hit };
    } else {
      rows.push({ file, kind: 'outside', detail: "outside this job's declared paths" });
    }
  }

  if (trigger) {
    return {
      runE2e: true,
      reason:
        files.length + ' changed path(s); `' + trigger.file + '` is under `' + trigger.detail + '`.',
      rows,
    };
  }
  return {
    runE2e: false,
    reason:
      'none of the ' +
      files.length +
      " changed path(s) are under this job's declared paths (" +
      prefixes.join(', ') +
      ').',
    rows,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // `kind` only labels the job-summary heading. It defaults to E2E so the three
  // e2e lanes keep their output byte-for-byte; the domain lanes pass `--kind CI`
  // so their summaries do not announce themselves as e2e.
  const args = { roots: [], onlyPaths: [], self: [], files: null, lane: 'e2e', kind: 'E2E' };
  const FLAGS = new Set(['--roots', '--only-paths', '--self', '--files', '--lane', '--kind']);
  let current = null;
  for (const token of argv) {
    if (FLAGS.has(token)) {
      current = token.slice(2);
      continue;
    }
    if (current === 'roots') args.roots.push(token);
    else if (current === 'only-paths') args.onlyPaths.push(token);
    else if (current === 'self') args.self.push(token);
    else if (current === 'files') args.files = token;
    else if (current === 'lane') args.lane = token;
    else if (current === 'kind') args.kind = token;
  }
  return args;
}

function emit({ runE2e, reason, rows, lane, kind = 'E2E' }) {
  const value = runE2e ? 'true' : 'false';
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run_e2e=${value}\nreason=${reason}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### ${kind} scope — ${lane}`, '', `\`run_e2e = ${value}\` — ${reason}`, ''];
    if (rows?.length) {
      // The attribution table is the audit trail. A lane that skipped must be able
      // to show WHY, path by path, or "green without running" is unverifiable again.
      lines.push(
        '<details><summary>Path attribution</summary>',
        '',
        '| path | verdict |',
        '| --- | --- |',
        ...rows.map((r) => `| \`${r.file}\` | ${r.kind} — ${r.detail} |`),
        '',
        '</details>',
      );
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  console.log(`run_e2e=${value} :: ${reason}`);
}

export function main(argv, repoRoot) {
  const { roots, onlyPaths, self: selfPaths, files: filesPath, lane, kind } = parseArgs(argv);

  // Exactly one mode. Passing both would silently favour one and make the other
  // look like it had been honoured.
  if (roots.length > 0 && onlyPaths.length > 0) {
    throw new Error('--roots and --only-paths are mutually exclusive');
  }
  if (roots.length === 0 && onlyPaths.length === 0) {
    throw new Error('one of --roots or --only-paths is required');
  }
  if (!filesPath) throw new Error('--files is required');

  const raw = readFileSync(filesPath, 'utf8');
  const files = [...new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean))];

  // No paths means we could not learn what changed — never a reason to skip.
  if (files.length === 0) {
    emit({ runE2e: true, reason: 'the changed-file list was empty — running the suite (fail safe).', rows: [], lane, kind });
    return;
  }

  if (onlyPaths.length > 0) {
    emit({ ...decideByPaths({ files, prefixes: onlyPaths }), lane, kind });
    return;
  }

  const workspaces = loadWorkspaces(repoRoot);
  const closure = closureOf(workspaces, roots);
  emit({ ...decide({ workspaces, closure, files, selfPaths }), lane, kind });
}

// `process.argv[1]` is undefined when this module is imported from a context with
// no script path (`node -e`, a REPL, some runners), and `pathToFileURL(undefined)`
// THROWS — which made the module unimportable there. CI always passes a path, so
// this was latent rather than breaking, but the guard costs nothing. (`pathToFileURL`
// rather than a file:// template literal is itself deliberate: the naive form
// silently never matches on Windows.)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  try {
    main(process.argv.slice(2), repoRoot);
  } catch (err) {
    // A crash here must not become a skip. Report the failure AND run the suite:
    // the gate reads `run_e2e`, so the lane stays honest even when this script is
    // the thing that broke.
    emit({
      runE2e: true,
      reason: `the scope script failed (${err.message}) — running the suite (fail safe).`,
      rows: [],
      lane: 'error',
    });
    console.error(err);
  }
}

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
export function decide({ workspaces, closure, files }) {
  const rows = [];
  let trigger = null;

  for (const file of files) {
    let verdict;
    if (isInert(file)) {
      verdict = { kind: 'inert', detail: 'documentation / tooling' };
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { roots: [], files: null, lane: 'e2e' };
  let current = null;
  for (const token of argv) {
    if (token === '--roots' || token === '--files' || token === '--lane') {
      current = token.slice(2);
      continue;
    }
    if (current === 'roots') args.roots.push(token);
    else if (current === 'files') args.files = token;
    else if (current === 'lane') args.lane = token;
  }
  return args;
}

function emit({ runE2e, reason, rows, lane }) {
  const value = runE2e ? 'true' : 'false';
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run_e2e=${value}\nreason=${reason}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### E2E scope — ${lane}`, '', `\`run_e2e = ${value}\` — ${reason}`, ''];
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
  const { roots, files: filesPath, lane } = parseArgs(argv);

  if (roots.length === 0) throw new Error('--roots is required');
  if (!filesPath) throw new Error('--files is required');

  const raw = readFileSync(filesPath, 'utf8');
  const files = [...new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean))];

  // No paths means we could not learn what changed — never a reason to skip.
  if (files.length === 0) {
    emit({ runE2e: true, reason: 'the changed-file list was empty — running the suite (fail safe).', rows: [], lane });
    return;
  }

  const workspaces = loadWorkspaces(repoRoot);
  const closure = closureOf(workspaces, roots);
  emit({ ...decide({ workspaces, closure, files }), lane });
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
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

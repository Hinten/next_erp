import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// lint-staged runs from the git repository root and passes ABSOLUTE file paths.
const ROOT = process.cwd();

// Workspaces that ship their own ESLint flat config. ESLint 9 flat config is
// resolved from the CWD, so a single `eslint` invoked at the repo root would
// NOT pick up these per-package configs — each staged file has to be linted
// with the CWD set to its owning workspace.
//
// ⚠️ DISCOVERED, not hand-written, and that is the fix rather than a tidy-up.
// The list used to be literal and had drifted in both directions: it still named
// the five marketplace scaffolds deleted in #815, and it was MISSING
// `packages/ai`, `tools/cmun-table` and `tools/deploy-env` — three workspaces
// that each ship a flat config and a `lint` script, whose staged files
// therefore got Prettier only and skipped the `--max-warnings 0` gate entirely.
// Nothing failed either way, which is exactly the shape
// `rules/lib/repo-scan.js` warns about: "a guard that only checks a
// hand-written list cannot catch the thing nobody remembered to add."
//
// Sorted longest-first so a nested workspace (`packages/integrations/nfe`)
// matches before any shorter prefix (`packages/integrations`).
const WORKSPACE_GLOBS = ['apps', 'packages', 'packages/integrations', 'tools'];

const ESLINT_WORKSPACES = WORKSPACE_GLOBS.flatMap((dir) => {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${dir}/${e.name}`)
    .filter((ws) => existsSync(path.join(ROOT, ws, 'eslint.config.mjs')));
}).sort((a, b) => b.length - a.length);

// ⚠️ `.js`/`.mjs`/`.cjs` are included deliberately. They used to be absent, so
// every custom rule and backstop under `packages/config-eslint/rules` and the
// five `apps/*/functions/scripts/prepare-deploy.mjs` were never linted at
// commit time — including by the error-level core `no-unused-vars` that #1445
// re-enabled for exactly that surface.
const CODE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// POSIX single-quote escaping: wrap in single quotes and replace every embedded
// single quote with `'\''`. This keeps names containing spaces, `$`, backticks,
// quotes, etc. intact as they pass through lint-staged's own shell parsing —
// applied to both the file arguments and the whole inner `sh -c` command.
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/** @param {string[]} stagedFiles absolute paths of the staged files */
export default function lintStaged(stagedFiles) {
  const commands = [];

  // 1) Prettier formats every staged file. `--ignore-unknown` skips file types
  //    Prettier can't parse; `.prettierignore` is still honoured for the rest.
  if (stagedFiles.length > 0) {
    commands.push(`prettier --write --ignore-unknown ${stagedFiles.map(sq).join(' ')}`);
  }

  // 2) ESLint --fix, grouped by owning workspace. Code files that live outside
  //    any ESLint-config workspace get Prettier only — that is repo-root files
  //    and `.github/scripts/**` / `.claude/hooks/**`, which belong to no
  //    workspace and which no root flat config covers.
  //    ⚠️ It used to name `packages/core` and `packages/ui` as the examples.
  //    Both ship an `eslint.config.mjs` and are discovered above — `packages/ui`
  //    is a workspace this same PR adds hook rules to — so the examples were
  //    exactly backwards and would send the next reader hunting a hole that is
  //    not there.
  const byWorkspace = new Map();
  for (const abs of stagedFiles) {
    if (!CODE_RE.test(abs)) continue;
    const rel = path.relative(ROOT, abs);
    const ws = ESLINT_WORKSPACES.find((w) => rel === w || rel.startsWith(w + path.sep));
    if (!ws) continue;
    if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
    // Path relative to the workspace dir, since the command cd's into it.
    byWorkspace.get(ws).push(path.relative(ws, rel));
  }

  // ⚠️ `--no-warn-ignored` is load-bearing, not tidiness. `--max-warnings 0`
  //    counts the `File ignored because of a matching ignore pattern` warning,
  //    so staging a file its workspace deliberately ignores fails the hook with
  //    a message about nothing. `packages/integrations/nfe/src/codegen/generate.mjs`
  //    is the live case — it is tracked, ESLint-ignored, and hand-edited on every
  //    MOC bump, so `git commit` on a MOC bump would die. (Pre-existing for the
  //    package's ignored `.ts` files; widening CODE_RE above to `.mjs` is what
  //    made it reachable there too.) lint-staged only ever passes files the
  //    developer deliberately staged, so skipping the ignored ones silently is
  //    the intended behaviour.
  for (const [ws, files] of byWorkspace) {
    const inner = `cd ${sq(ws)} && eslint --fix --max-warnings 0 --no-warn-ignored ${files.map(sq).join(' ')}`;
    commands.push(`sh -c ${sq(inner)}`);
  }

  return commands;
}

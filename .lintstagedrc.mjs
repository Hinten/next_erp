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
  //    any ESLint-config workspace (e.g. packages/core, packages/ui) have no
  //    config to run against, so they get Prettier only.
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

  for (const [ws, files] of byWorkspace) {
    const inner = `cd ${sq(ws)} && eslint --fix --max-warnings 0 ${files.map(sq).join(' ')}`;
    commands.push(`sh -c ${sq(inner)}`);
  }

  return commands;
}

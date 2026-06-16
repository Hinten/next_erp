import path from 'node:path';

// lint-staged runs from the git repository root and passes ABSOLUTE file paths.
const ROOT = process.cwd();

// Workspaces that ship their own ESLint flat config. ESLint 9 flat config is
// resolved from the CWD, so a single `eslint` invoked at the repo root would
// NOT pick up these per-package configs — each staged file has to be linted
// with the CWD set to its owning workspace. Sorted longest-first so the more
// specific `packages/integrations/nfe` matches before any shorter prefix.
const ESLINT_WORKSPACES = [
  'apps/web',
  'apps/integrations',
  'apps/nfe',
  'apps/webchat',
  'packages/integrations/nfe',
  'packages/integrations/freight-br',
].sort((a, b) => b.length - a.length);

const CODE_RE = /\.(ts|tsx|mts|cts)$/;

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
  //    any ESLint-config workspace (e.g. packages/schemas) have no config to
  //    run against, so they get Prettier only.
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

// `cd <workspace> && eslint <args…>` — without a shell.
//
// `.lintstagedrc.mjs` emits one task per workspace:
//
//   node packages/config-eslint/lint-staged/eslint-in-workspace.mjs <ws> <eslint args…>
//
// where `<ws>` is a repo-relative workspace directory and everything after it is
// handed to THAT workspace's own ESLint verbatim, with the CWD set to the
// workspace so ESLint 9 resolves the workspace's flat config.
//
// ⚠️ Why a script and not `sh -c 'cd <ws> && eslint …'`: lint-staged does NOT
// run a task through a shell. `lib/getSpawnedTask.js` splits the task string
// with `string-argv` and spawns argv[0] directly — and string-argv honours
// `'…'` and `"…"` but has no escape of ANY kind. The `sh -c` form relied on the
// POSIX `'\''` idiom, which string-argv shreds: `sh` received `-c` plus the
// fragment `cd `, ran `cd` with no argument (→ `$HOME`, exit 0), and ESLint
// never ran. That was the shape from the gate's first commit (2026-06-08), so
// the pre-commit `--max-warnings 0` ratchet had never once executed. Changing
// directory here, in Node, leaves nothing for a parser to get wrong; the only
// thing that still crosses string-argv is plain argv tokens, which
// `.lintstagedrc.mjs` quotes in the one dialect string-argv actually speaks.
// `rules/lint-staged-argv.test.js` and `rules/lint-staged-gate-runs.test.js`
// hold that line.
//
// ⚠️ Every lookup below fails CLOSED (non-zero exit, message on stderr). A gate
// that exits 0 when it cannot find its own tool is precisely the defect this
// file replaces, so "no eslint here" must refuse the commit, not wave it on.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository root, from this file's own location rather than
// `process.cwd()`, so the runner means the same thing whatever directory it is
// spawned from.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** @param {string} message */
function refuse(message) {
  process.stderr.write(`eslint-in-workspace: ${message}\n`);
  process.exit(2);
}

/**
 * The workspace's OWN eslint bin — the one its `lint` script runs — found the
 * way Node resolves a bare `eslint` from the workspace directory, but bounded
 * at the repository root. ⚠️ The bound matters: a worktree lives INSIDE the
 * main checkout (`.claude/worktrees/<name>`), so an unbounded walk (which is
 * what `createRequire(...).resolve` does) would silently borrow the parent
 * checkout's ESLint when this one's install is stale.
 *
 * @param {string} wsDir absolute workspace directory
 * @returns {string | null} absolute path of `bin/eslint.js`, or null
 */
function resolveEslintBin(wsDir) {
  for (let dir = wsDir; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', 'eslint', 'package.json');
    if (existsSync(pkg)) {
      const { bin } = JSON.parse(readFileSync(pkg, 'utf8'));
      return path.join(path.dirname(pkg), typeof bin === 'string' ? bin : bin.eslint);
    }
    if (path.relative(ROOT, dir) === '' || path.dirname(dir) === dir) return null;
  }
}

const [ws, ...eslintArgs] = process.argv.slice(2);
if (!ws) refuse('usage: eslint-in-workspace.mjs <workspace> <eslint args…>');

const wsDir = path.resolve(ROOT, ws);
if (path.relative(ROOT, wsDir).startsWith('..')) refuse(`${ws} is outside the repository`);
if (!existsSync(path.join(wsDir, 'eslint.config.mjs'))) refuse(`${ws} has no eslint.config.mjs`);

const bin = resolveEslintBin(wsDir);
if (!bin) refuse(`cannot resolve eslint from ${ws} — run \`pnpm install\``);

const { status, error } = spawnSync(process.execPath, [bin, ...eslintArgs], {
  cwd: wsDir,
  stdio: 'inherit',
});
if (error) throw error;
// `status` is null when ESLint died on a signal — that is a failure too.
process.exit(status ?? 1);

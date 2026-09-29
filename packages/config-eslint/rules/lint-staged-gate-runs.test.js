import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESLINT_IN_WORKSPACE, LINT_STAGED_DIR } from './lib/lint-staged.js';
import { REPO_ROOT } from './lib/repo-scan.js';

/**
 * Repo invariant: staging a file ESLint rejects makes the pre-commit hook FAIL.
 *
 * ## Why this needs its own guard
 *
 * For its whole life until this guard, the ESLint half of `.lintstagedrc.mjs`
 * never executed — lint-staged split its `sh -c '…'` task with a parser that
 * has no escape, `sh` ran a bare `cd`, and the task reported COMPLETED (see
 * `lint-staged-argv.test.js`). Every existing guard asserted on what the config
 * RETURNED; none asserted on what happened when lint-staged ran it. A model of
 * lint-staged's parser closes that particular hole, but it is still a model, so
 * this runs the real thing: the real `lint-staged` binary, against the real
 * `.lintstagedrc.mjs` and the real runner, spawning the real ESLint.
 *
 * It does so in a THROWAWAY repository, never this one. Running lint-staged here
 * would mean staging a probe in the developer's index and writing a file into a
 * live workspace that a concurrent `turbo run lint` would then report. The
 * scratch repo carries copies of the two files under test at their real
 * repo-relative paths, one workspace `apps/probe` that the config discovers
 * through the same `apps/*` scan as a real one, and this package's ESLint
 * LINKED into that workspace's `node_modules` the way pnpm links it.
 *
 * Each case asserts on the RULE ID in the output as well as the exit code, so a
 * failure for an unrelated reason (Prettier missing, the runner refusing) can
 * never satisfy a "must fail" case — and the clean case is the anti-vacuity
 * anchor that proves the harness can pass at all.
 */

let repo;
let eslintLink;

/** The environment every child gets. */
function childEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  // Vitest sets NODE_ENV=test, which switches lint-staged to its test renderer;
  // a real `git commit` never has it.
  delete env.NODE_ENV;
  // ⚠️ Drop every GIT_* variable. Under a git hook (or `git rebase --exec`)
  // GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE are set, and they would point the
  // scratch repo's git commands straight back at the REAL repository's index.
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  // Prettier comes from this repo's root `.bin`; the scratch repo has none.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [join(REPO_ROOT, 'node_modules', '.bin'), env[pathKey]].join(delimiter);
  return env;
}

const git = (...args) =>
  execFileSync('git', args, { cwd: repo, env: childEnv(), encoding: 'utf8', stdio: 'pipe' });

/** Write `rel` into the scratch repo and stage it — and ONLY it. */
function stageOnly(rel, content) {
  git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '.');
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git('add', '--', rel);
}

/** Run the real pre-commit command, the way `.husky/pre-commit` does. */
function runLintStaged() {
  const bin = join(LINT_STAGED_DIR, 'bin', 'lint-staged.js');
  const r = spawnSync(process.execPath, [bin, '--no-stash'], {
    cwd: repo,
    env: childEnv(),
    encoding: 'utf8',
  });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lint-staged-gate-')));
  for (const rel of ['.lintstagedrc.mjs', ESLINT_IN_WORKSPACE]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), join(repo, rel));
  }

  const ws = join(repo, 'apps', 'probe');
  mkdirSync(join(ws, 'node_modules'), { recursive: true });
  writeFileSync(
    join(ws, 'eslint.config.mjs'),
    [
      'export default [',
      "  { ignores: ['generated/**'] },",
      "  { rules: { 'no-unused-vars': 'error', 'prefer-const': 'error', 'no-console': 'warn' } },",
      '];',
      '',
    ].join('\n'),
  );
  // 'junction' is what lets this work on Windows without admin rights; POSIX
  // ignores the type argument.
  eslintLink = join(ws, 'node_modules', 'eslint');
  const eslintDir = realpathSync(join(REPO_ROOT, 'packages/config-eslint/node_modules/eslint'));
  symlinkSync(eslintDir, eslintLink, 'junction');

  git('init', '-q');
});

afterAll(() => {
  if (!repo) return;
  // ⚠️ Unlink ESLint BEFORE the recursive delete, so no implementation of that
  // delete ever gets the chance to walk through the link into the pnpm store.
  if (eslintLink) unlinkSync(eslintLink);
  rmSync(repo, { recursive: true, force: true });
});

describe('the pre-commit ESLint gate actually runs', () => {
  it('fails a staged file with an ESLint error — through an awkward filename', () => {
    // A space and a single quote: the two characters the old `'\''` escaping
    // existed to carry, and the ones string-argv treats specially.
    stageOnly("apps/probe/src/it's a probe.js", 'const unused = 1;\nexport {};\n');
    const { status, output } = runLintStaged();
    expect(output).toContain('no-unused-vars');
    expect(output).toContain("it's a probe.js");
    expect(status).not.toBe(0);
  });

  it('fails a staged file whose ONLY problem is a warning (the --max-warnings 0 ratchet)', () => {
    // CI's `turbo run lint` never fails on a warning; this hook is the one
    // place a warn-level rule gates anything, so it must.
    stageOnly('apps/probe/src/warn.js', "console.log('x');\n");
    const { status, output } = runLintStaged();
    expect(output).toContain('no-console');
    expect(status).not.toBe(0);
  });

  it('passes a clean file, with ESLint --fix applied and re-staged', () => {
    // Anti-vacuity anchor for the two failures above: the harness CAN pass. The
    // `let` is a fixable `prefer-const` error, so a pass also proves ESLint ran
    // with `--fix` in the workspace and lint-staged staged its fix.
    stageOnly('apps/probe/src/clean.js', 'let fixed = 1;\nexport default fixed;\n');
    const { status, output } = runLintStaged();
    expect(status, output).toBe(0);
    expect(git('show', ':apps/probe/src/clean.js')).toContain('const fixed = 1;');
  });

  it('passes a staged file its workspace deliberately ignores (--no-warn-ignored)', () => {
    // `--max-warnings 0` counts ESLint's "File ignored" warning, so without the
    // flag staging an ignored file (nfe's `codegen/generate.mjs` on every MOC
    // bump) would fail the hook about nothing.
    stageOnly('apps/probe/generated/out.js', 'const unused = 1;\nexport {};\n');
    const { status, output } = runLintStaged();
    expect(status, output).toBe(0);
  });

  it('the runner fails CLOSED when the workspace has no ESLint installed', () => {
    // A stale install (a fresh worktree that skipped `pnpm install`) must
    // refuse the commit, not wave it through: a gate that exits 0 when it
    // cannot find its own tool is the defect this whole suite is about.
    const ws = join(repo, 'apps', 'no-eslint');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'eslint.config.mjs'), 'export default [];\n');
    const r = spawnSync(
      process.execPath,
      [join(repo, ESLINT_IN_WORKSPACE), 'apps/no-eslint', 'x.js'],
      { cwd: repo, env: childEnv(), encoding: 'utf8' },
    );
    expect(r.stderr).toContain('cannot resolve eslint from apps/no-eslint');
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(ws, 'eslint.config.mjs'), 'utf8')).toBe('export default [];\n');
  });
});

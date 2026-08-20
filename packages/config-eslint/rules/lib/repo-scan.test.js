import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  __repoScanMissCount,
  __resetRepoScanCache,
  gitCheckAttr,
  gitGrep,
  gitLsFiles,
  runGit,
} from './repo-scan.js';

/**
 * Guard for the guards' shared scanner.
 *
 * The nine repo-state tests in the parent directory each call their discovery
 * function from several `it()`s; before this module every one of those calls
 * was its own `git` process, and the resulting cost is what made the workspace
 * suite flake on Vitest's default 5000ms timeout (see `repo-scan.js`).
 *
 * ⚠️ The memoization assertions below count CACHE MISSES, not results. Asserting
 * that two calls return the same array would pass just as well with the memo
 * deleted — the repo does not change between them — so it would guard nothing.
 * The miss counter is the only thing that can tell the two apart.
 *
 * Misses rather than process spawns on purpose: a retried command spawns two or
 * three processes for one logical call, and counting attempts would red these
 * assertions under exactly the contention the retry absorbs. Proven in
 * `repo-scan.retry.test.js`, which is where the retry itself is covered.
 */

/** Narrow, cheap scope: this directory only. */
const SELF = ['packages/config-eslint/rules/lib/*'];
/**
 * ⚠️ Assembled at runtime, never written out whole. `SELF` includes THIS file,
 * so a literal sentinel would match itself and the no-match tests below would
 * be asserting the opposite of what they claim.
 */
const NO_SUCH_STRING = ['zzz', 'no', 'such', 'string', 'zzz'].join('-');

describe('REPO_ROOT', () => {
  it('is the repo root, four levels up from rules/lib/', () => {
    // The `..` count is exactly the kind of thing that breaks silently: a wrong
    // root makes every pathspec match nothing, which reads as "clean".
    expect(existsSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'packages/config-eslint/rules/lib/repo-scan.js'))).toBe(
      true,
    );
  });
});

describe('the git spawn is memoized', () => {
  it('runs git ONCE for N identical calls', () => {
    __resetRepoScanCache();
    const first = gitGrep({ patterns: 'export function', pathspecs: SELF });
    expect(__repoScanMissCount()).toBe(1);

    for (let i = 0; i < 5; i += 1) gitGrep({ patterns: 'export function', pathspecs: SELF });
    expect(__repoScanMissCount()).toBe(1);

    // ...and the memo is not just handing back an empty answer.
    expect(first).toContain('packages/config-eslint/rules/lib/required-index.js');
  });

  it('does NOT collapse calls that differ', () => {
    __resetRepoScanCache();
    gitGrep({ patterns: 'export function', pathspecs: SELF });
    gitGrep({ patterns: 'deriveRequiredIndex', pathspecs: SELF });
    expect(__repoScanMissCount()).toBe(2);
  });

  it('ORs several patterns in ONE spawn', () => {
    __resetRepoScanCache();
    const both = gitGrep({ patterns: ['collectionGroupOf', 'MAX_ATTEMPTS'], pathspecs: SELF });
    expect(__repoScanMissCount()).toBe(1);
    expect(both).toContain('packages/config-eslint/rules/lib/required-index.js');
    expect(both).toContain('packages/config-eslint/rules/lib/repo-scan.js');
  });
});

describe('exit codes', () => {
  it('maps the TOLERATED exit code onto an empty result', () => {
    // `git grep` exits 1 when nothing matched. That is the answer, not a failure.
    expect(gitGrep({ patterns: NO_SUCH_STRING, pathspecs: SELF })).toEqual([]);
  });

  it('does not tolerate an exit code it was not told about', () => {
    // 128, not 1. A blanket "any non-zero means empty" would turn a broken git
    // invocation into a vacuous green across every guard in the directory.
    expect(() =>
      runGit(['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch-zzz'], {
        tolerateExitCode: 1,
      }),
    ).toThrow();
  });

  it('throws when nothing is tolerated at all', () => {
    expect(() => runGit(['grep', '-l', '-e', NO_SUCH_STRING, '--', ...SELF])).toThrow();
  });
});

describe('gitLsFiles', () => {
  it('unions tracked with untracked-but-not-ignored', () => {
    const found = gitLsFiles(SELF);
    expect(found).toContain('packages/config-eslint/rules/lib/required-index.js');
    // Present whether or not this module has been committed yet — which is the
    // point of the `--others --exclude-standard` pass.
    expect(found).toContain('packages/config-eslint/rules/lib/repo-scan.js');
  });

  it('returns forward slashes on every platform, including Windows', () => {
    // Callers compare these as raw strings; a back-slashed path would red every
    // assertion locally while staying green on the Linux runner.
    expect(gitLsFiles(SELF).every((p) => !p.includes('\\'))).toBe(true);
  });
});

describe('gitCheckAttr', () => {
  it('answers an empty path list without spawning git', () => {
    __resetRepoScanCache();
    expect(gitCheckAttr('eol', [])).toEqual({});
    expect(__repoScanMissCount()).toBe(0);
  });

  it('reads the attribute .gitattributes pins, and reports unset paths', () => {
    const attrs = gitCheckAttr('eol', ['.husky/pre-commit', 'package.json']);
    expect(attrs['.husky/pre-commit']).toBe('lf');
    expect(attrs['package.json']).toBe('unspecified');
  });
});

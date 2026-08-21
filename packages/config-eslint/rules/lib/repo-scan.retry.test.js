import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The retry half of `repo-scan.js`, with `git` mocked.
 *
 * Separate file because `vi.mock` is per-module-registry: `repo-scan.test.js`
 * drives the REAL git and must keep doing so, since a mocked scanner proves
 * nothing about pathspecs or exit codes. Nothing here spawns a process.
 *
 * ⚠️ Why this file exists at all. Review of #1198 caught that `cacheMisses` was
 * being incremented INSIDE the retry loop, so it counted attempts: a retried
 * command reported 2 or 3, and the `toBe(1)` assertions in `repo-scan.test.js`
 * would have gone red under precisely the lock contention and process pressure
 * the retry was added to absorb — a new flake surface inside a flake fix, and
 * one that reads as "the memo is broken" when the memo is fine. The counter now
 * increments once per cache miss; `counts ONE miss for a command that was
 * retried` below is what stops that regressing.
 */

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));

const { __repoScanMissCount, __resetRepoScanCache, runGit } = await import('./repo-scan.js');

/**
 * The shape `execFileSync` throws: an Error carrying `status` (the child's exit
 * code) or, for a spawn-level failure, `code` and no `status` at all.
 * @param {{ status?: number, code?: string, stderr?: string }} fields
 */
function gitError(fields) {
  return Object.assign(new Error('mock git failure'), fields);
}

/** No exit status = the process never ran. EAGAIN under process pressure. */
const SPAWN_FAILURE = () => gitError({ code: 'EAGAIN', stderr: '' });

/** git's own "someone else is holding this repo". */
const LOCK_FAILURE = () =>
  gitError({ status: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists." });

beforeEach(() => {
  execFileSync.mockReset();
  __resetRepoScanCache();
});

describe('transient failures are retried', () => {
  it('recovers from a spawn-level failure', () => {
    execFileSync.mockImplementationOnce(() => {
      throw SPAWN_FAILURE();
    });
    execFileSync.mockReturnValueOnce('ok\n');

    expect(runGit(['ls-files'])).toBe('ok\n');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('recovers from an index.lock collision', () => {
    execFileSync.mockImplementationOnce(() => {
      throw LOCK_FAILURE();
    });
    execFileSync.mockReturnValueOnce('ok\n');

    expect(runGit(['ls-files'])).toBe('ok\n');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('⚠️ counts ONE miss for a command that was retried', () => {
    // THE REGRESSION GUARD. Two processes, one logical call — so one miss.
    // Counting attempts here is what would red `repo-scan.test.js`'s `toBe(1)`
    // assertions under contention.
    execFileSync.mockImplementationOnce(() => {
      throw SPAWN_FAILURE();
    });
    execFileSync.mockReturnValueOnce('ok\n');

    runGit(['ls-files']);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(__repoScanMissCount()).toBe(1);
  });

  it('gives up after MAX_ATTEMPTS instead of retrying forever', () => {
    execFileSync.mockImplementation(() => {
      throw SPAWN_FAILURE();
    });

    expect(() => runGit(['ls-files'])).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(3);
    // Still one miss: we went to git once for this key and it did not answer.
    expect(__repoScanMissCount()).toBe(1);
  });
});

describe('non-transient failures are NOT retried', () => {
  it('does not retry a plain non-zero exit', () => {
    // Exit 1 from `git grep` is an ANSWER. Retrying it would burn two more
    // scans to be told the same thing.
    execFileSync.mockImplementation(() => {
      throw gitError({ status: 1, stderr: '' });
    });

    expect(() => runGit(['grep', '-l', '-e', 'nope'])).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 128 whose stderr is not a lock', () => {
    execFileSync.mockImplementation(() => {
      throw gitError({ status: 128, stderr: 'fatal: Needed a single revision' });
    });

    expect(() => runGit(['rev-parse', '--verify', 'nope'])).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not retry our own maxBuffer ceiling', () => {
    // ENOBUFS has no `status` either, so without the explicit carve-out it
    // would look exactly like a spawn failure and be retried three times.
    execFileSync.mockImplementation(() => {
      throw gitError({ code: 'ENOBUFS' });
    });

    expect(() => runGit(['ls-files'])).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing git binary', () => {
    execFileSync.mockImplementation(() => {
      throw gitError({ code: 'ENOENT' });
    });

    expect(() => runGit(['ls-files'])).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('tolerateExitCode', () => {
  it('maps the named exit code onto empty stdout, and still counts one miss', () => {
    execFileSync.mockImplementation(() => {
      throw gitError({ status: 1, stderr: '' });
    });

    expect(runGit(['grep', '-l', '-e', 'nope'], { tolerateExitCode: 1 })).toBe('');
    // ⚠️ This is the path a post-call increment would miss entirely: the call
    // throws and returns from the catch, so it never reaches a counter placed
    // after `execFileSync`. It DID run git, so it must count.
    expect(__repoScanMissCount()).toBe(1);
  });

  it('memoizes the tolerated-empty result too', () => {
    execFileSync.mockImplementation(() => {
      throw gitError({ status: 1, stderr: '' });
    });

    runGit(['grep', '-l', '-e', 'nope'], { tolerateExitCode: 1 });
    runGit(['grep', '-l', '-e', 'nope'], { tolerateExitCode: 1 });
    // A no-match answer that is not cached means every caller re-scans for it.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(__repoScanMissCount()).toBe(1);
  });
});

// Shared, MEMOIZED repo discovery for the repo-state guards in this directory.
//
// ## Why this module exists
//
// Every guard here derives its own scope by shelling out to `git` — that is the
// whole design (`runtime-deps-pinned.test.js` unions `ls-files` instead of
// listing manifests; `tasks-invoker-inventory.test.js` discovers codebases
// instead of enumerating them) because a guard that only checks a hand-written
// list cannot catch the thing nobody remembered to add.
//
// What it did NOT do was remember the answer. Each `it()` called the discovery
// function fresh, and each call spawned one or two `git` processes:
// `tasks-invoker-inventory` ran nine `git grep --untracked` over the tree,
// `env-example-location` ten `git ls-files`, `shebang-files-lf` re-read the
// first two bytes of all 2738 tracked files twice.
//
// On Windows a single `git grep --untracked` over this tree costs 200-450ms
// idle. With 23 test files in parallel worker threads all spawning `git`,
// single tests measured 0.6-2.8s and the tail crossed Vitest's default 5000ms
// `testTimeout`. The suite failed roughly one run in three, and a DIFFERENT
// guard tipped over each time.
//
// ⚠️ READ THE FAILURE TYPE, NOT THE NAME. The test that tipped over was most
// often an ANTI-VACUITY anchor ("discovered enough to be checking anything at
// all", "the scanner actually finds shebang files"), because those are the ones
// that run two scans back to back. That makes the flake read as "discovery
// returned fewer results under load" — it never did. Every failure was
// `Error: Test timed out in 5000ms`, and "fixing" it by lowering an anchor
// would have deleted the guard to silence its own cost.
//
// ## Why memoizing is sound
//
// These guards assert on REPO STATE, which does not change while the suite
// runs — that is the premise every one of them is already built on. So the
// second identical `git` invocation may safely hand back the first one's
// stdout. The cache is per worker thread (Vitest isolates module registries per
// test file), so it collapses the N calls INSIDE a file to one; it does not and
// need not span files.
//
// ## The two smaller hardenings
//
// `maxBuffer` is raised well past the default 1 MiB. It was NOT the cause here
// (`git ls-files -z`, the largest read, is 139 KB) and an overrun throws
// `ENOBUFS` rather than truncating silently — but the ceiling is per-invocation
// and a future whole-tree `grep -n` could reach it, so it is bought cheaply.
//
// Transient spawn/lock failures are retried. `git grep` does not take
// `.git/index.lock`, but it does READ the index, and a concurrent porcelain
// command (an editor's background fetch, a `lint-staged` run) can catch it
// mid-rewrite; on Windows a process-creation storm can also fail with no exit
// status at all. Both are retried; a real non-zero exit is not.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root. This file sits at `packages/config-eslint/rules/lib/`, so FOUR up. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** 64 MiB. See the header note — insurance, not the fix. */
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 100;

/** `JSON.stringify([args, input, tolerateExitCode])` → stdout. */
const memo = new Map();

/** How many `git` processes were actually spawned. Read by this module's guard. */
let spawnCount = 0;

/** Test seam. Nothing in a normal run should need this. */
export function __resetRepoScanCache() {
  memo.clear();
  spawnCount = 0;
}

/** Test seam: proves the memo is doing what the whole module exists to do. */
export function __repoScanSpawnCount() {
  return spawnCount;
}

/**
 * Block the calling thread. These helpers are deliberately synchronous — every
 * consumer is a synchronous `it()` body — so the backoff has to be too.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The child's exit code, or `undefined` when the process never produced one
 * (a spawn-level failure).
 * @param {unknown} err
 * @returns {number | undefined}
 */
function exitCodeOf(err) {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const { status } = /** @type {{ status?: unknown }} */ (err);
  return typeof status === 'number' ? status : undefined;
}

/**
 * Is this failure worth a second attempt?
 *
 * ⚠️ Deliberately narrow. Retrying a genuine git error just fails three times
 * slower, and retrying a `git grep` that exited 1 would be wrong outright —
 * that exit code is an ANSWER ("no matches"), handled by `tolerateExitCode`.
 * @param {unknown} err
 */
function isTransient(err) {
  if (typeof err !== 'object' || err === null) return false;
  const { code, stderr } = /** @type {{ code?: unknown, stderr?: unknown }} */ (err);
  // Our own ceiling, and "git is not installed". Neither improves on a retry.
  if (code === 'ENOBUFS' || code === 'ENOENT') return false;
  // No exit status at all = the process never ran. On Windows that is the shape
  // of EAGAIN under process pressure, and of a scanner holding `git.exe`.
  if (exitCodeOf(err) === undefined) return true;
  // git's own "someone else is holding this repo" family.
  return (
    exitCodeOf(err) === 128 &&
    /index\.lock|cannot lock|Unable to create|another git process/i.test(String(stderr ?? ''))
  );
}

/**
 * Run one `git` command from the repo root and return its stdout, memoized.
 *
 * @param {string[]} args
 * @param {{ input?: string, tolerateExitCode?: number }} [options]
 *   `tolerateExitCode` maps ONE non-zero exit onto empty stdout — `git grep`
 *   exits 1 when nothing matched, which is the result we want, not a failure.
 * @returns {string}
 */
export function runGit(args, options = {}) {
  const { input, tolerateExitCode } = options;
  const key = JSON.stringify([args, input ?? null, tolerateExitCode ?? null]);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  for (let attempt = 1; ; attempt += 1) {
    try {
      spawnCount += 1;
      const stdout = execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        // ⚠️ `execFileSync` INHERITS stderr by default, which does two bad
        // things: git's diagnostics land in the middle of the test reporter's
        // output, and `err.stderr` comes back null — so `isTransient`'s lock
        // check below could never fire. Pipe all three.
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
      });
      memo.set(key, stdout);
      return stdout;
    } catch (err) {
      // ⚠️ The `!== undefined` matters: `exitCodeOf` also returns `undefined`
      // for a spawn failure, so a bare equality would tolerate a git that never
      // ran and hand every caller an empty result — a vacuous green.
      if (tolerateExitCode !== undefined && exitCodeOf(err) === tolerateExitCode) {
        memo.set(key, '');
        return '';
      }
      if (attempt >= MAX_ATTEMPTS || !isTransient(err)) throw err;
      sleepSync(RETRY_BACKOFF_MS * attempt);
    }
  }
}

/** `-E`, `--fixed-strings`, or git's default basic-regex matching. */
const MODE_FLAGS = {
  basic: [],
  extended: ['-E'],
  fixed: ['--fixed-strings'],
};

/**
 * `git grep` over the INDEX plus untracked-but-not-ignored files.
 *
 * ⚠️ `--untracked` is load-bearing for every caller: plain `git grep` searches
 * TRACKED files only, so a violation that has not been `git add`ed yet is
 * invisible and the pre-commit run gives no feedback on the very change
 * introducing it. Ignored paths stay excluded.
 *
 * Patterns are passed as `-e <pat>` (git ORs them), which both allows several
 * patterns in ONE spawn and stops a pattern beginning with `-` being read as a
 * flag.
 *
 * @param {{
 *   patterns: string | readonly string[],
 *   pathspecs: readonly string[],
 *   mode?: 'basic' | 'extended' | 'fixed',
 *   list?: boolean,
 * }} spec `list: true` (default) → `-l`, sorted paths. `list: false` → `-n`
 *   `path:line:text`, left in git's own order because it feeds a message.
 * @returns {string[]}
 */
export function gitGrep({ patterns, pathspecs, mode = 'basic', list = true }) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const stdout = runGit(
    [
      'grep',
      list ? '-l' : '-n',
      '--no-color',
      '--untracked',
      ...MODE_FLAGS[mode],
      ...pats.flatMap((p) => ['-e', p]),
      '--',
      ...pathspecs,
    ],
    { tolerateExitCode: 1 },
  );
  const lines = stdout.split('\n').filter(Boolean);
  return list ? lines.sort() : lines;
}

/**
 * Paths matching a pathspec: tracked, unioned with untracked-but-not-ignored so
 * a NEW file is caught before it is committed.
 *
 * ⚠️ git emits forward slashes on every platform, including Windows. Callers
 * compare these as RAW STRINGS — running them through `path.join`/`resolve`
 * first would back-slash them on Windows and red every assertion locally while
 * staying green in CI.
 *
 * @param {string | readonly string[]} pathspecs
 * @param {{ includeUntracked?: boolean }} [options]
 * @returns {string[]}
 */
export function gitLsFiles(pathspecs, { includeUntracked = true } = {}) {
  const specs = Array.isArray(pathspecs) ? pathspecs : [pathspecs];
  const ls = (/** @type {string[]} */ extra) =>
    runGit(['ls-files', ...extra, '--', ...specs])
      .split('\n')
      .filter(Boolean);
  const tracked = ls([]);
  if (!includeUntracked) return tracked;
  return [...new Set([...tracked, ...ls(['--others', '--exclude-standard'])])];
}

/**
 * Every tracked path, NUL-delimited.
 *
 * ⚠️ `-z`, not a newline split. Without it `git ls-files` C-quotes any path
 * holding a non-ASCII byte — the NF-e reference PDFs come back as the literal
 * `"...Valida\303\247\303\243o..."`, quotes included — and every such path then
 * fails to open.
 * @returns {string[]}
 */
export function gitLsFilesZ() {
  return runGit(['ls-files', '-z']).split('\0').filter(Boolean);
}

/**
 * `{ path: value }` for one gitattribute, over the given paths, in ONE call.
 *
 * `-z` on both sides: NUL-delimited in and out, so a path containing a space or
 * a quote cannot be mis-split. Output is a flat NUL-separated stream of
 * (path, attr, value) triples.
 * @param {string} attr
 * @param {readonly string[]} paths
 * @returns {Record<string, string>}
 */
export function gitCheckAttr(attr, paths) {
  if (paths.length === 0) return {};
  const raw = runGit(['check-attr', attr, '--stdin', '-z'], { input: [...paths].join('\0') });
  const parts = raw.split('\0');
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i + 2 < parts.length; i += 3) out[parts[i]] = parts[i + 2];
  return out;
}

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { eslintTasks } from './lib/lint-staged.js';
import { REPO_ROOT } from './lib/repo-scan.js';

/**
 * Repo invariant: `.lintstagedrc.mjs` groups staged files by workspace using
 * FORWARD SLASHES, whatever separator the host platform hands it.
 *
 * ## Why this needs its own guard
 *
 * The config discovers workspace names with a literal `/`
 * (`` `${dir}/${e.name}` ``) but derives the staged file's path from
 * `path.relative`, which returns the PLATFORM separator. On Windows that made
 * `apps\web\app\x.ts`.startsWith(`'apps/web' + '\\'`) permanently false:
 * `byWorkspace` stayed empty, only the Prettier command was emitted, and the
 * ESLint half of the pre-commit hook never ran on a single Windows commit.
 *
 * That hook was then the ONLY place `--max-warnings 0` was applied (`CI lint`
 * joined it in #1704). The bug therefore switched off every warn-level rule
 * (`no-console`, the `delfrance/*` ratchets, `react-hooks/exhaustive-deps`) for
 * Windows developers, silently — and it still would switch off the commit-time
 * half of that gate, leaving a warning to surface only as a red PR.
 *
 * ⚠️ `lint-staged-covers-workspaces.test.js` cannot protect the fix. It
 * exercises whatever `path.sep` the HOST has, and on Linux CI that is `/` —
 * where `toPosix` is the identity and `` `${w}/` `` is character-for-character
 * `w + path.sep`. Pre-fix and post-fix emit byte-identical commands there. So
 * rewriting the loop back to `rel.startsWith(w + path.sep)` keeps all nine
 * lanes green while the gate quietly dies on Windows again: the same
 * silent-pass shape the sibling guard exists to catch, except it only caught it
 * because a human happened to run vitest on Windows.
 *
 * This file simulates win32 on any host instead, so the regression reds CI.
 */

// Pretend we are on Windows: `path.relative` returns `\` and `path.sep` is `\`,
// while `join` stays REAL so the config's workspace discovery still hits this
// filesystem (a win32 `join` would build `/repo\apps`, which `existsSync` misses
// on Linux, and the suite would pass vacuously with zero workspaces found).
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal();
  const win = { ...actual.default, relative: actual.default.win32.relative, sep: '\\' };
  return { ...actual, default: win, ...win };
});

// ⚠️ Same reason as the sibling guard: `.lintstagedrc.mjs` reads `process.cwd()`
// at import time because lint-staged always invokes it from the repo root.
const cwdBefore = process.cwd();
process.chdir(REPO_ROOT);
const { default: lintStaged } = await import('../../../.lintstagedrc.mjs');
process.chdir(cwdBefore);

/** An absolute staged path as Windows would hand it over: backslash-separated. */
const winAbs = (relPath) => resolve(REPO_ROOT, relPath).split('/').join('\\');

/**
 * Only the ESLint runs, split by lint-staged's own parser (see
 * `lib/lint-staged.js` for why a string match is not enough). ⚠️ The Prettier
 * command legitimately carries the ABSOLUTE staged paths exactly as the
 * platform gave them (`C:\…\lib\x.ts`), so asserting "no backslashes anywhere"
 * would fail on correct output.
 */
const eslintRuns = (relPath) => eslintTasks(lintStaged([winAbs(relPath)]));

describe('lint-staged groups by workspace under Windows separators', () => {
  it('emits an eslint run for a backslash-separated staged path', () => {
    // If the mock failed to apply this fails loudly rather than passing
    // vacuously: under a real POSIX `path` the backslash path is not absolute,
    // resolves under the cwd, and matches the wrong workspace entirely.
    const runs = eslintRuns('apps/web/lib/__probe__.ts');
    expect(runs.map((t) => t.ws)).toEqual(['apps/web']);
  });

  it('hands ESLint POSIX separators, not the platform ones', () => {
    // `path.relative` produced the workspace-relative path with backslashes;
    // the emitted command is meant to be identical on every platform.
    const [{ ws, args }] = eslintRuns('apps/web/lib/__probe__.ts');
    expect(args.at(-1)).toBe('lib/__probe__.ts');
    expect([ws, ...args].join(' ')).not.toContain('\\');
  });

  it('still prefers the longest matching workspace', () => {
    // `packages/integrations/nfe` must beat `packages/integrations`; normalising
    // separators must not disturb the longest-first ordering.
    const runs = eslintRuns('packages/integrations/nfe/src/__probe__.ts');
    expect(runs.map((t) => t.ws)).toEqual(['packages/integrations/nfe']);
  });

  it('still applies the --max-warnings 0 ratchet on Windows', () => {
    // The whole point: the commit-time half of the `--max-warnings 0` gate.
    const [{ args }] = eslintRuns('apps/web/lib/__probe__.ts');
    expect(args.join(' ')).toContain('--max-warnings 0');
  });
});

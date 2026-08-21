import { closeSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitCheckAttr, gitLsFilesZ } from './lib/repo-scan.js';

/**
 * Every tracked file that opens with `#!` must check out with LF endings.
 *
 * WHY. A shebang declares a POSIX interpreter, and every consumer of one breaks
 * on CRLF — in three different ways this repo has now hit:
 *
 *   1. Git for Windows cannot spawn a CRLF hook at all: "cannot spawn
 *      .husky/pre-commit: Exec format error", which silently breaks every commit.
 *   2. `bash` reading a CRLF script gets a trailing `$'\r'` on every line, so
 *      `.github/scripts/*.sh` misbehaves locally while passing on the Linux runner.
 *   3. ⚠️ The quiet one. `vite`'s SSR transform locates the end of a shebang with
 *      `const hashbangRE = /^#!.*\n/`, and in JS `.` does not match `\r`. On a
 *      CRLF checkout that never matches, so `fileStartIndex` falls back to 0 and
 *      the hoisted `__vite_ssr_import__` statements are injected BEFORE the `#!`.
 *      The shebang is then no longer on line 1, which is a syntax error. Vitest
 *      surfaces a bare `SyntaxError: Invalid or unexpected token` — no file, no
 *      frame — and the suite collects ZERO tests.
 *
 * (3) was live and invisible: `packages/config-eslint/rules/e2e-affected.test.js`
 * imports `.github/scripts/e2e-affected.mjs`, so on Windows its 17 tests did not
 * run while CI ran them green. `core.autocrlf=true` is what makes the two
 * platforms disagree, and `.gitattributes` is the only thing that overrides it.
 *
 * WHY A GUARD AND NOT JUST THE RULES. `.gitattributes` is a per-path allowlist;
 * a new shebang file simply is not covered by it, and nothing says so. This test
 * derives the set from the repo — first two bytes of every tracked file — so the
 * rules cannot fall behind the files.
 */

let shebangCache = null;

/**
 * Tracked paths whose first two bytes are `#!`.
 *
 * Deliberately unguarded: `openSync` throwing means a tracked path is missing
 * from the working tree, which is a broken checkout, not a case to skip over
 * quietly — and skipping it silently would shrink the set this guard checks.
 * Verified there is nothing legitimate to tolerate: the repo has no submodules
 * and every `git ls-files -s` entry is a regular blob (100644/100755).
 *
 * ⚠️ TRACKED-ONLY, and deliberately unlike its four neighbours. The other
 * repo-scanning guards here (`env-example-location`, `ci-lane-gates`,
 * `runtime-deps-pinned`, `apphosting-next-pinned`) union `ls-files` with
 * `ls-files --others --exclude-standard` to catch a new file before it is
 * committed. They can afford it because each scopes by a narrow pathspec — the
 * `.env.example` glob, the per-app `apphosting.yaml` glob — while this one scans
 * the whole tree, so `--others` would turn any untracked scratch `foo.sh` in
 * someone's working directory into a red build.
 *
 * The trade is small in the direction that matters: `.gitattributes` governs
 * checkout, and an untracked file has never been checked out — the invariant is
 * meaningless until git manages it. The moment it is staged it appears in
 * `ls-files`, and CI always checks out a commit, so nothing can reach `main`
 * unpinned. The only gap is a local `pnpm test` run before `git add`.
 */
function shebangFiles() {
  // Memoized: this opens EVERY tracked file, and both assertions below need the
  // result. Re-running it per `it()` is what put this file within reach of the
  // default 5s timeout under the parallel suite — see `lib/repo-scan.js`.
  if (shebangCache) return shebangCache;
  const out = [];
  const buf = Buffer.alloc(2);
  for (const file of gitLsFilesZ()) {
    const fd = openSync(resolve(REPO_ROOT, file), 'r');
    try {
      const n = readSync(fd, buf, 0, 2, 0);
      if (n === 2 && buf[0] === 0x23 && buf[1] === 0x21) out.push(file);
    } finally {
      closeSync(fd);
    }
  }
  shebangCache = out.sort();
  return shebangCache;
}

/** `{ path: eolAttr }` for the given paths, in ONE `git check-attr` call. */
function eolAttrs(paths) {
  return gitCheckAttr('eol', paths);
}

describe('shebang files check out with LF', () => {
  // ------------------------------------------------------------------
  // 0. Positive control. Without this, a discovery bug that finds nothing
  //    makes the real assertion below pass over an empty set.
  // ------------------------------------------------------------------
  it('the scanner actually finds shebang files, and only those', () => {
    const found = shebangFiles();

    expect(found.length).toBeGreaterThan(0);
    // A known member, so "found something" cannot be satisfied by junk.
    expect(found).toContain('.github/scripts/e2e-affected.mjs');
    // ...and a known non-member: this very file starts with `import`.
    expect(found).not.toContain('packages/config-eslint/rules/shebang-files-lf.test.js');

    // The attribute reader must distinguish, or assertion 1 is vacuous too.
    const attrs = eolAttrs(['.github/scripts/e2e-affected.mjs', 'package.json']);
    expect(attrs['.github/scripts/e2e-affected.mjs']).toBe('lf');
    expect(attrs['package.json']).toBe('unspecified');
  });

  // ------------------------------------------------------------------
  // 1. The invariant.
  // ------------------------------------------------------------------
  it('every tracked file starting with #! is pinned to eol=lf', () => {
    const found = shebangFiles();
    const attrs = eolAttrs(found);
    const offenders = found.filter((f) => attrs[f] !== 'lf');

    expect(
      offenders,
      [
        'A tracked file starts with `#!` but is not pinned to LF in `.gitattributes`.',
        '',
        'With `core.autocrlf=true` (the Windows default) that file checks out as',
        'CRLF, and every consumer of a shebang breaks on CRLF:',
        '',
        '  - Git for Windows cannot spawn it ("Exec format error").',
        "  - `bash` gets a trailing $'\\r' on every line.",
        "  - vite's SSR transform fails to strip it (`/^#!.*\\n/` — `.` does not",
        '    match `\\r`), hoists imports in front of it, and the file becomes a',
        '    syntax error. Vitest then reports a bare `SyntaxError: Invalid or',
        '    unexpected token` and collects ZERO tests from the importing suite.',
        '',
        'The last one is silent on CI (LF) and only red on Windows, so it reads as',
        "someone else's broken file rather than as a line-ending problem.",
        '',
        ...offenders.map((o) => `  - ${o} → eol is \`${attrs[o] ?? '<none>'}\``),
        '',
        'Add a rule to `.gitattributes`, then RE-MATERIALISE the working copy —',
        'adding the attribute alone does not rewrite an existing checkout, so the',
        'bug survives until you do.',
        '',
        '  per file:    rm <f> && git checkout -- <f>',
        '  whole tree:  git rm --cached -r . && git reset --hard',
        '',
        '⚠️ Two things that look like they would work and do not, both measured:',
        '`git add --renormalize .` re-applies the clean filter into the INDEX only',
        'and never touches the disk (and is a strict no-op here, since the blobs',
        'are already LF). `git rm --cached <f> && git checkout -- <f>` cannot work',
        'in either order: `checkout` reads FROM the index, which `rm --cached` just',
        'emptied, so it fails with "pathspec did not match any file(s) known to',
        'git". A bare `git reset --hard` is not dependable either — it rewrites the',
        'file only when git currently considers it modified, which after the',
        'attribute lands it may not.',
      ].join('\n'),
    ).toEqual([]);
  });
});

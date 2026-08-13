import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

/**
 * Tracked paths whose first two bytes are `#!`.
 *
 * Deliberately unguarded: `openSync` throwing means a tracked path is missing
 * from the working tree, which is a broken checkout, not a case to skip over
 * quietly — and skipping it silently would shrink the set this guard checks.
 * Verified there is nothing legitimate to tolerate: the repo has no submodules
 * and every `git ls-files -s` entry is a regular blob (100644/100755).
 */
function shebangFiles() {
  // ⚠️ `-z`, not a newline split. Without it `git ls-files` C-quotes any path
  // holding a non-ASCII byte — the NF-e reference PDFs come back as the literal
  // `"...Valida\303\247\303\243o..."`, quotes included — and every such path
  // then fails to open. Silently skipping those (the shape this had first) would
  // shrink the very set this guard exists to keep total.
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  const out = [];
  const buf = Buffer.alloc(2);
  for (const file of tracked) {
    const fd = openSync(resolve(REPO_ROOT, file), 'r');
    try {
      const n = readSync(fd, buf, 0, 2, 0);
      if (n === 2 && buf[0] === 0x23 && buf[1] === 0x21) out.push(file);
    } finally {
      closeSync(fd);
    }
  }
  return out.sort();
}

/** `{ path: eolAttr }` for the given paths, in ONE `git check-attr` call. */
function eolAttrs(paths) {
  if (paths.length === 0) return {};
  // `-z` on both sides: NUL-delimited in and out, so a path containing a space
  // or a quote cannot be mis-split. Output is a flat NUL-separated stream of
  // (path, attr, value) triples.
  const raw = execFileSync('git', ['check-attr', 'eol', '--stdin', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: paths.join('\0'),
  });
  const parts = raw.split('\0');
  const out = {};
  for (let i = 0; i + 2 < parts.length; i += 3) out[parts[i]] = parts[i + 2];
  return out;
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
        'Add a rule to `.gitattributes`, then re-checkout the file so the working',
        'copy is actually rewritten: `git rm --cached <f> && git checkout -- <f>`,',
        'or `git add --renormalize .`. Adding the attribute alone does NOT rewrite',
        'an existing working copy, so the bug survives until you do.',
      ].join('\n'),
    ).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: `CI lint` fails on a WARNING, not only on an error.
 *
 * ## Why this needs a guard
 *
 * Every warn-level rule in this repo is a ratchet (`no-console`, the
 * `delfrance/*` warns, `react-hooks/*`), and #1704 brought every one of them to
 * ZERO. What keeps them there is `--max-warnings 0`, and ESLint without it
 * exits 0 on any number of warnings. Until #1704 the only place the flag was
 * passed was the pre-commit hook — whose ESLint half, it turned out, had never
 * run at all (#1709) — so 157 warnings accumulated with every gate green.
 *
 * The hook now works, but `--no-verify`, a cloud agent and a web edit all skip
 * it. `ci.yml`'s `CI lint` is the half nothing can skip, and deleting the flag
 * from it fails nothing: the job stays green over every warning. So this reds
 * CI instead.
 *
 * The flag reaches the workspaces through turbo's passthrough, which appends it
 * to the END of every package's `lint` script. That is only correct while each
 * script is a single `eslint` invocation: a `lint` script of `eslint . && tsc`
 * would hand the flag to `tsc` and leave ESLint unbounded again. So the second
 * half pins the shape of the scripts, not just the workflow line.
 *
 * Line-scanned rather than YAML-parsed, like the other workflow guards here.
 */

const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');

/** The lines of `ci.yml`'s `CI lint` job, from its `name:` to the next job. */
function ciLintJobLines() {
  const lines = readFileSync(CI_YML, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{4}name:\s*CI lint\s*$/.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\s{2}[\w-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** Every workspace `lint` script, straight from git. */
function lintScripts() {
  return gitLsFiles(['**/package.json'])
    .filter((f) => !f.includes('/node_modules/'))
    .map((f) => ({
      f,
      script: JSON.parse(readFileSync(resolve(REPO_ROOT, f), 'utf8')).scripts?.lint,
    }))
    .filter((x) => typeof x.script === 'string');
}

describe('CI lint enforces --max-warnings 0', () => {
  it('finds the CI lint job (anti-vacuity)', () => {
    expect(ciLintJobLines().length).toBeGreaterThan(5);
  });

  it('forwards --max-warnings 0 to every workspace through turbo passthrough', () => {
    const runs = ciLintJobLines().filter((l) => /\bturbo run lint\b/.test(l));
    expect(runs).toHaveLength(1);
    // After the `--`: before it, turbo would read the flag as its own.
    expect(runs[0]).toMatch(/turbo run lint\b.*\s--\s+(?:.*\s)?--max-warnings[ =]0\b/);
  });

  it('keeps every workspace lint script a single eslint invocation', () => {
    const scripts = lintScripts().filter(({ f }) => f !== 'package.json');
    // Anti-vacuity: the workspaces were actually found.
    expect(scripts.length).toBeGreaterThan(25);
    const chained = scripts.filter(({ script }) => !/^eslint\b[^&|;]*$/.test(script));
    expect(chained).toEqual([]);
  });
});

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

// ⚠️ `.lintstagedrc.mjs` reads `process.cwd()` at import time, because
// lint-staged always invokes it from the repository root. Vitest runs with the
// cwd set to this workspace, so the module has to be imported with the cwd it
// is really given — otherwise every path it computes is relative to the wrong
// base and the assertions below fail for a reason that has nothing to do with
// the invariant.
const cwdBefore = process.cwd();
process.chdir(REPO_ROOT);
const { default: lintStaged } = await import('../../../.lintstagedrc.mjs');
process.chdir(cwdBefore);

/**
 * Repo invariant: the pre-commit ESLint gate reaches every workspace that has a
 * flat config, and every file extension those configs lint.
 *
 * ## Why this needs a guard
 *
 * `.lintstagedrc.mjs` is the ONLY place `--max-warnings 0` is applied anywhere
 * in this repo — `ci.yml` runs a bare `pnpm turbo run lint`. So it is the sole
 * enforcement of every warn-level rule (`no-console`, the four `delfrance`
 * ratchets, `react-hooks/exhaustive-deps`), and a workspace missing from its
 * list loses all of them silently. Nothing fails; the files are simply passed
 * over.
 *
 * It had drifted in both directions. The list still named the five marketplace
 * scaffolds deleted in #815, and it was missing `packages/ai`,
 * `tools/cmun-table` and `tools/deploy-env` — three workspaces that each ship
 * an `eslint.config.mjs` and a `lint` script. Its own comment claimed it was
 * "every workspace except apps/docs and packages/config-tsconfig", which had
 * stopped being true, and two more comments named `packages/core` and
 * `packages/ui` as having no config when both do.
 *
 * The config now DISCOVERS its workspaces, so the drift cannot recur in the
 * missing direction. This asserts that, and asserts the extension filter too:
 * `.js`/`.mjs` were excluded outright, which meant every custom rule and
 * backstop in this directory — and the five `prepare-deploy.mjs` scripts —
 * were never linted at commit time, including by the core `no-unused-vars`
 * #1445 re-enabled for precisely that surface.
 *
 * A test rather than a lint rule: the invariant compares a JS module's computed
 * output against the shape of the working tree, which ESLint never sees.
 */

/** Every workspace directory that ships a flat config, straight from git. */
const configured = gitLsFiles(['**/eslint.config.mjs'])
  .filter((f) => !f.includes('/node_modules/'))
  .map((f) => f.replace(/\/eslint\.config\.mjs$/, ''))
  .sort();

/**
 * Undo the config's POSIX single-quote escaping (`'` -> `'\''`), which wraps the
 * whole inner `sh -c` command. Without this every `cd '<ws>'` assertion below
 * fails for a quoting reason rather than a coverage one.
 */
const unescape = (cmd) => cmd.split(String.raw`'\''`).join("'");

/** Ask the real config which commands it would produce for one file. */
function commandsFor(relPath) {
  return lintStaged([resolve(REPO_ROOT, relPath)]).map(unescape);
}

describe('lint-staged covers every ESLint workspace', () => {
  it('discovers a non-trivial number of workspaces (anti-vacuity)', () => {
    expect(configured.length).toBeGreaterThan(25);
  });

  it('runs eslint for a TypeScript file in every configured workspace', () => {
    const uncovered = configured.filter((ws) => {
      const probe = `${ws}/__lint_staged_probe__.ts`;
      return !commandsFor(probe).some((c) => c.includes(`cd '${ws}'`) && c.includes('eslint'));
    });
    expect(uncovered).toEqual([]);
  });

  it('runs eslint for a plain-JS file too', () => {
    // packages/config-eslint is ~59 .js files — every custom rule and every
    // backstop in this directory. They were excluded by the extension filter.
    const cmds = commandsFor('packages/config-eslint/rules/__probe__.js');
    expect(cmds.some((c) => c.includes("cd 'packages/config-eslint'"))).toBe(true);

    const mjs = commandsFor('tools/deploy-env/__probe__.mjs');
    expect(mjs.some((c) => c.includes("cd 'tools/deploy-env'"))).toBe(true);
  });

  it('still applies the --max-warnings 0 ratchet', () => {
    // The whole point of the pre-commit gate: CI never fails on a warning, so
    // dropping this flag would silently retire every warn-level rule.
    const cmds = commandsFor('apps/web/lib/__probe__.ts');
    expect(cmds.some((c) => c.includes('--max-warnings 0'))).toBe(true);
  });

  it('names no workspace that no longer exists', () => {
    // The five #815 scaffolds were listed for months after deletion. Discovery
    // makes that impossible, so this asserts the property rather than the list.
    for (const ws of configured) {
      expect(existsSync(resolve(REPO_ROOT, ws, 'eslint.config.mjs'))).toBe(true);
    }
  });
});

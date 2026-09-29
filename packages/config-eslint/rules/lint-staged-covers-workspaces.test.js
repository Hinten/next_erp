import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { eslintTasks } from './lib/lint-staged.js';
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
 * `.lintstagedrc.mjs` is one of the two places `--max-warnings 0` is applied —
 * the other is `CI lint` (`turbo run lint -- --max-warnings 0`, since #1704) —
 * and the only one that answers at commit time, before a push. So it is where
 * every warn-level rule (`no-console`, the `delfrance` ratchets,
 * `react-hooks/exhaustive-deps`) reaches the developer first, and a workspace
 * missing from its list loses that silently: nothing fails, the files are
 * simply passed over, and the warning surfaces only as a red PR.
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
 * Ask the real config which ESLint runs it would produce for one file, as
 * lint-staged's own parser splits them.
 *
 * ⚠️ This used to undo the config's `'\''` escaping by hand and then grep the
 * STRING for `cd '<ws>'` — reading the command as a shell would. lint-staged
 * uses no shell, so that string never meant what it said: every assertion here
 * passed while the ESLint task it described ran a bare `cd` and exited 0
 * (`lint-staged-argv.test.js`).
 */
function eslintRunsFor(relPath) {
  return eslintTasks(lintStaged([resolve(REPO_ROOT, relPath)]));
}

describe('lint-staged covers every ESLint workspace', () => {
  it('discovers a non-trivial number of workspaces (anti-vacuity)', () => {
    expect(configured.length).toBeGreaterThan(25);
  });

  it('runs eslint for a TypeScript file in every configured workspace', () => {
    const uncovered = configured.filter((ws) => {
      const probe = `${ws}/__lint_staged_probe__.ts`;
      return !eslintRunsFor(probe).some((t) => t.ws === ws);
    });
    expect(uncovered).toEqual([]);
  });

  it('runs eslint for a plain-JS file too', () => {
    // packages/config-eslint is ~59 .js files — every custom rule and every
    // backstop in this directory. They were excluded by the extension filter.
    const js = eslintRunsFor('packages/config-eslint/rules/__probe__.js');
    expect(js.map((t) => t.ws)).toEqual(['packages/config-eslint']);

    const mjs = eslintRunsFor('tools/deploy-env/__probe__.mjs');
    expect(mjs.map((t) => t.ws)).toEqual(['tools/deploy-env']);
  });

  it('still applies the --max-warnings 0 ratchet', () => {
    // The whole point of the pre-commit gate: without this flag a warning
    // passes the commit and is found only by `CI lint`, after the push.
    // Asserted on adjacent argv entries, which is how ESLint will receive them.
    const [{ args }] = eslintRunsFor('apps/web/lib/__probe__.ts');
    expect(args.slice(args.indexOf('--max-warnings'), args.indexOf('--max-warnings') + 2)).toEqual([
      '--max-warnings',
      '0',
    ]);
  });

  it('names no workspace that no longer exists', () => {
    // The five #815 scaffolds were listed for months after deletion. Discovery
    // makes that impossible, so this asserts the property rather than the list.
    for (const ws of configured) {
      expect(existsSync(resolve(REPO_ROOT, ws, 'eslint.config.mjs'))).toBe(true);
    }
  });
});

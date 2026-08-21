import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * Nothing executable may reach for a `.env.secrets*` file, and no `.env*` copy may
 * be written as a prefix match.
 *
 * The ESLint rule `delfrance/no-env-secrets-access` covers JS/TS. This covers what
 * ESLint cannot parse at all — GitHub workflows, firebase configs, shell scripts,
 * package manifests — and it is a test rather than a rule for exactly the reason
 * stated in `env-example-location.test.js`: failing the test fails CI the same way
 * a lint error would.
 *
 * WHY THE SECOND ASSERTION EXISTS. `apps/nfe/functions/scripts/prepare-deploy.mjs`
 * used to select files to ship to the cloud with
 * `f.startsWith('.env') && f !== '.env.local' && f !== '.env.example'` — a denylist,
 * so every `.env*` name the repo ever invents was opt-OUT of being uploaded to the
 * project's `gcf-sources-*` bucket. `.env.secrets` matched it. The shape, not just
 * that one instance, is what has to stay gone.
 */

/**
 * Files whose job IS to name the pattern: the allowlist classifier that rejects
 * these files, the ESLint rule that bans them, and these tests. Kept in sync with
 * `ALLOW_LIST` in `no-env-secrets-access.js` — that rule and this test are two
 * halves of one guard and must not disagree about the carve-out.
 *
 * Markdown and the `.env*` templates are not scanned at all (see PATHSPECS): docs
 * SHOULD name the file, that is how an operator learns it exists.
 */
const EXCLUDED = [':(exclude)packages/config-eslint/rules/*', ':(exclude)tools/deploy-env/*'];

/**
 * The surface ESLint cannot parse. Deliberately NOT `*.md` (docs SHOULD name the
 * file — that is how an operator learns it exists) and deliberately NOT JS/TS:
 * `delfrance/no-env-secrets-access` already owns those, and it owns them BETTER,
 * because it matches string and template literals in the AST. A text grep over
 * source would also hit the explanatory comments that exist precisely to tell the
 * next reader why the guard is there.
 */
const CONFIG_PATHSPECS = ['*.sh', '*.yml', '*.yaml', '*.json'];

/** Where a copy loop can be written — the shape check below scans these instead. */
const CODE_PATHSPECS = ['*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx'];

/**
 * `git grep` over the INDEX plus untracked-but-not-ignored files, so a violation is
 * caught before it is ever committed — see `lib/repo-scan.js`, which owns the
 * spawn, the memo and the "exit 1 means no matches" handling for every guard here.
 */
function scan(patterns, pathspecs) {
  return gitGrep({
    patterns,
    pathspecs: [...pathspecs, ...EXCLUDED],
    mode: 'fixed',
    list: false,
  });
}

describe('.env.secrets is unreachable from executable code', () => {
  // ------------------------------------------------------------------
  // 0. POSITIVE CONTROL. Both assertions below assert an EMPTY result, which is
  //    the one shape that passes just as happily when the scan is broken as
  //    when the repo is clean — a wrong pathspec, an exclusion that swallows
  //    the tree, a `git grep` that never ran. Neither surface has any other
  //    proof it was read, so prove it here: shorter patterns that MUST match.
  // ------------------------------------------------------------------
  it('the scan actually reaches both surfaces', () => {
    // `.env` (not `.env.secrets`) — workflows and firebase configs name the
    // template files constantly.
    expect(scan('.env', CONFIG_PATHSPECS).length).toBeGreaterThan(0);
    // `startsWith(` (not `startsWith('.env`) — over a hundred source files.
    expect(scan('startsWith(', CODE_PATHSPECS).length).toBeGreaterThan(0);
  });

  it('no workflow, config, script or manifest references it', () => {
    const hits = scan('.env.secrets', CONFIG_PATHSPECS);
    expect(
      hits,
      [
        'A `.env.secrets*` file must never be read, copied, globbed or resolved by',
        'anything automated: whatever a predeploy hook puts in a deploy artifact is',
        'uploaded to the gcf-sources bucket and baked in plaintext into the Cloud Run',
        'revision. Deploy-time env belongs in `.env.deploy` — see',
        'tools/deploy-env/env-files.mjs. Offending lines:',
        ...hits.map((h) => `  - ${h}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('no `.env*` selection is written as a prefix match', () => {
    // Both quote styles in ONE spawn (`git grep` ORs its `-e` patterns). Two
    // separate scans is what made this the slowest `it()` in the workspace and
    // the one that tipped over the default 5s timeout most often.
    const hits = scan(["startsWith('.env", 'startsWith(".env'], CODE_PATHSPECS);
    expect(
      hits,
      [
        'Selecting `.env*` files by prefix is a DENYLIST: every new `.env*` name the',
        'repo invents is opt-OUT of being shipped to the cloud, which is how',
        '`.env.secrets` came to be copyable in the first place. Use the anchored',
        'allowlist in tools/deploy-env/env-files.mjs (`classifyEnvFile`). Offending lines:',
        ...hits.map((h) => `  - ${h}`),
      ].join('\n'),
    ).toEqual([]);
  });
});

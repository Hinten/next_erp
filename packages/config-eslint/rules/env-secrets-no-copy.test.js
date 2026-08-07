import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
 * caught before it is ever committed. Exit code 1 means "no matches", which is the
 * outcome we want — anything else is a real failure worth surfacing.
 */
function gitGrep(pattern, pathspecs) {
  try {
    return execFileSync(
      'git',
      [
        'grep',
        '--no-color',
        '-n',
        '--fixed-strings',
        '--untracked',
        pattern,
        '--',
        ...pathspecs,
        ...EXCLUDED,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // execFileSync throws on a non-zero exit; git grep exits 1 with no matches.
    if (err instanceof Error && 'status' in err && err.status === 1) return [];
    throw err;
  }
}

describe('.env.secrets is unreachable from executable code', () => {
  it('no workflow, config, script or manifest references it', () => {
    const hits = gitGrep('.env.secrets', CONFIG_PATHSPECS);
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
    const hits = [
      ...gitGrep("startsWith('.env", CODE_PATHSPECS),
      ...gitGrep('startsWith(".env', CODE_PATHSPECS),
    ];
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

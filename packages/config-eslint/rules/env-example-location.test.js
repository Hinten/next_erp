import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo convention: ONE root template SET — `.env.example` (non-secret config) plus
 * `.env.secrets.example` (credential material), both at the repo root and nowhere
 * else. Every app's dev server loads the repo-root `.env.local`
 * (`dotenv -e ../../.env.local`), so an app-level copy of either documents vars in
 * a place nothing reads — and drifts. This backstop is a test rather than an ESLint
 * rule because ESLint only parses JS/TS and never sees `.env*` files; failing the
 * test fails CI exactly like a lint error would.
 *
 * #730 burned the original five app-level copies down to the ONE entry below. The
 * split into two root files came later and does not weaken that: it is still one
 * template set at the root, divided by sensitivity rather than by app. Which key
 * belongs in which file is `env-example-split.test.js`; this file is only about
 * WHERE the templates live.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The only justification for a non-root `.env.example` is a **nested Cloud
 * Functions codebase**: its target is that codebase's own `.env`, which
 * firebase loads as the function's DEPLOY-TIME runtime env. The repo-root
 * `.env.local` never reaches it, so documenting those names in the root file
 * would point the reader at a file that does nothing for them.
 *
 * Nothing else belongs here. A new app var goes into the ROOT `.env.example`,
 * in an app-titled section.
 */
const ALLOWED_NON_ROOT = new Set(['apps/nfe/functions/.env.example']);

/**
 * Ask git, rather than walking the filesystem: a walk has to carry a
 * skip-list, and the local-only directories it must skip are exactly the ones
 * that produce false positives (`.old/` — the gitignored Flutter reference —
 * carries its own `next-rewrite` copies of three app-level `.env.example`
 * files; so do `node_modules`, `.deploy/`, and `.claude/worktrees` checkouts).
 * `git ls-files` sees only this worktree's tracked files, and the `--others`
 * pass catches a NEW file before it is committed (`.gitignore` un-ignores
 * `.env.example`, so a new one is never invisible here).
 *
 * Semantics are the INDEX, not the disk: deleting a file without staging it
 * still reads as present. That is the intended scope — the convention is about
 * what the repo ships — and it matches what CI sees, since CI checks out a
 * commit. Reproduce a deletion with `git rm`, not `mv`.
 */
function findByPathspec(pathspec) {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', pathspec], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

function findEnvExamples() {
  return findByPathspec('*.env.example');
}

/**
 * Separate pathspec, not a widened one: `*.env.example` cannot match
 * `.env.secrets.example`, and widening it to `*.env*.example` would also start
 * matching names this convention has no opinion about.
 */
function findSecretsExamples() {
  return findByPathspec('*.env.secrets.example');
}

describe('.env.example location convention', () => {
  it('allows only the repo-root .env.example (plus the nested-functions carve-out)', () => {
    const found = findEnvExamples();
    const offenders = found.filter((p) => p !== '.env.example' && !ALLOWED_NON_ROOT.has(p));
    expect(
      offenders,
      [
        'App-level .env.example files are not allowed — the repo convention is ONE',
        'root .env.example (apps load the repo-root .env.local via dotenv).',
        'Move these vars into an app-titled section of the ROOT .env.example and',
        'delete the file (see #730):',
        ...offenders.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
    // The root file itself must exist — the convention has an anchor.
    expect(found).toContain('.env.example');
  });

  it('allows only the repo-root .env.secrets.example', () => {
    // The `*.env.example` pathspec above does NOT match `.env.secrets.example`
    // (the suffix is `.secrets.example`), so without this the credential template
    // would be invisible to the very convention it has to obey — and an app-level
    // copy of THAT file is worse than an app-level copy of the config one.
    const found = findSecretsExamples();
    expect(
      found.filter((p) => p !== '.env.secrets.example'),
      [
        'App-level .env.secrets.example files are not allowed. There is ONE root',
        'template set (config + secrets); a per-app copy documents credentials in a',
        'place nothing loads, and every copy is one more file to forget to blank.',
      ].join('\n'),
    ).toEqual([]);
    expect(found).toContain('.env.secrets.example');
  });

  it('allows only the repo-root .env.functions.example', () => {
    // The THIRD root template (#1133 follow-up): build-time config for the
    // Cloud Functions deploy, read by tools/deploy-env/build-env.mjs. It is a
    // deliberate addition to the "one root template set", not a fourth
    // population — it is split by WHEN the value is read (deploy-time, into the
    // bundle) rather than by sensitivity, which is why neither existing template
    // could hold it.
    const found = findByPathspec('*.env.functions.example');
    expect(
      found.filter((p) => p !== '.env.functions.example'),
      'App-level .env.functions.example files are not allowed — the loader only ever\nreads the repo ROOT file.',
    ).toEqual([]);
    expect(found).toContain('.env.functions.example');
  });

  it('has no UNKNOWN .env*.example anywhere', () => {
    // ⚠️ The three assertions above each use an EXACT pathspec, so a template with
    // a new infix is invisible to all of them. `.env.functions.example` was
    // exactly that: `*.env.example` does not match it, so it would have joined the
    // convention by slipping past it rather than by being allowed. This catch-all
    // is what makes the next one a decision instead of an accident.
    const known = new Set([
      '.env.example',
      '.env.secrets.example',
      '.env.functions.example',
      ...ALLOWED_NON_ROOT,
    ]);
    const offenders = findByPathspec('*.env*.example').filter((p) => !known.has(p));
    expect(
      offenders,
      [
        'These .env*.example templates are not part of the documented set. Add the',
        'name to `known` above WITH a comment saying what reads it, or delete it:',
        ...offenders.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('the carve-out list only shrinks: every entry still exists', () => {
    // A consolidated file whose entry lingers here would silently re-allow a
    // future regression at that path — force the entry's removal in the same
    // change that deletes the file.
    const found = new Set(findEnvExamples());
    const stale = [...ALLOWED_NON_ROOT].filter((p) => !found.has(p));
    expect(stale, `Remove consolidated entries from ALLOWED_NON_ROOT: ${stale.join(', ')}`).toEqual(
      [],
    );
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { typeAware } from '../index.js';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: an import that is EMITTED for no reason fails something.
 *
 * ## The premise, which is what actually makes these rules load-bearing
 *
 * `packages/config-tsconfig/base.json` sets `verbatimModuleSyntax: true`, and
 * every workspace inherits it. That option cuts both ways, and only one half is
 * widely understood.
 *
 * The understood half: importing something that is ONLY a type without the
 * `type` keyword is TS error 1484. So the correctness argument people usually
 * reach for `consistent-type-imports` to get is already made by the compiler
 * here — `turbo run typecheck` being green IS the proof there are none.
 *
 * The half nothing checked: `verbatimModuleSyntax` emits import statements
 * VERBATIM. It elides the specifiers it can and leaves the statement behind.
 * So this —
 *
 *   import { type A, type B } from './x';
 *
 * — emits `import './x';`, a real runtime module load that exists purely
 * because of how the import was spelled. It typechecks, lints, builds and runs.
 * There were 34 of these when the rule was turned on, and nothing anywhere in
 * the repo reported a single one.
 *
 * ⚠️ This is why the third assertion below matters more than the first two:
 * **turning `verbatimModuleSyntax` off would silently remove the entire reason
 * these rules exist**, and the rules themselves would keep passing. A guard
 * that only pinned the rules would be pinning the conclusion while leaving the
 * premise free to move.
 *
 * ⚠️ `warn` would be no substitute for `error`, which is why the severities are
 * asserted: no lint script in this repo passes `--max-warnings`, so
 * `turbo run lint` never fails on a warning.
 *
 * Nothing fails when any of this is switched back off — that is the whole
 * reason this file is a test rather than a comment.
 */

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** The single config object `typeAware()` produces. */
const block = (opts) => {
  const out = typeAware('/irrelevant', opts);
  expect(out, 'typeAware() should still return exactly one config object').toHaveLength(1);
  return out[0];
};

describe('type-import hygiene is enabled', () => {
  it('sets no-import-type-side-effects to error', () => {
    expect(block().rules['@typescript-eslint/no-import-type-side-effects']).toBe('error');
  });

  it('sets import/no-duplicates to error', () => {
    expect(block().rules['import/no-duplicates']).toBe('error');
  });
});

describe('the plugins those rules need are registered, and only when they should be', () => {
  /**
   * ⚠️ Same version is NOT the same instance, which is the whole reason
   * `registerPlugin` has to gate `import` as well as `@typescript-eslint`.
   *
   * `eslint-plugin-import@2.32.0` resolves to two different physical copies in
   * this repo — this package's peer context is `@typescript-eslint/parser`,
   * `eslint-config-next`'s is `eslint-import-resolver-typescript` — so pnpm
   * hands out two distinct module objects and ESLint's duplicate check compares
   * by identity. Registering `import` unconditionally throws "Cannot redefine
   * plugin" in all 8 Next apps rather than silently deduping.
   */
  it('registers both plugins by default, for workspaces that do not spread next', () => {
    expect(Object.keys(block().plugins ?? {}).sort()).toEqual(['@typescript-eslint', 'import']);
  });

  it('registers NEITHER when registerPlugin is false, which is what the 8 Next apps pass', () => {
    expect(Object.keys(block({ registerPlugin: false }).plugins ?? {})).toEqual([]);
  });

  it('every workspace that spreads eslint-config-next passes registerPlugin: false', () => {
    // Reading the configs rather than trusting a count: a new Next app that
    // forgets the flag fails at config-load time, which is loud — but it fails
    // for whoever runs lint next, not for whoever added the app.
    //
    // ⚠️ Matched against the CALL TEXT, and neither of the two obvious
    // shortcuts works here:
    //
    //  - a plain `src.includes('registerPlugin: false')` matches the comment
    //    every one of these configs carries directly above the call, so it
    //    passes against a config whose code no longer does it;
    //  - stripping comments first is WORSE. `apps/web/eslint.config.mjs`
    //    contains the glob string 'app/**\u002F*.{ts,tsx}', and the `/*` inside
    //    it opens a block comment that a naive stripper runs to the next `*/`,
    //    swallowing the real call. Same trap the root CLAUDE.md notes for globs
    //    inside comments, arriving from the other direction.
    const CALL = /\.\.\.typeAware\([^)]*\)/g;
    const configs = gitLsFiles(['apps/*/eslint.config.mjs']);
    const offenders = configs.filter((rel) => {
      const src = read(rel);
      if (!src.includes("from 'eslint-config-next'")) return false;
      const calls = src.match(CALL) ?? [];
      return calls.length === 0 || !calls.every((c) => c.includes('registerPlugin: false'));
    });
    expect(offenders, 'these spread eslint-config-next without registerPlugin: false').toEqual([]);
  });
});

describe('the premise those rules rest on', () => {
  it('verbatimModuleSyntax is still on in the shared tsconfig base', () => {
    const base = JSON.parse(read('packages/config-tsconfig/base.json'));
    expect(
      base.compilerOptions?.verbatimModuleSyntax,
      'verbatimModuleSyntax is what makes an unmarked type import a real runtime ' +
        'emit. Turning it off does not break the rules above — it makes them ' +
        'pointless, silently.',
    ).toBe(true);
  });
});

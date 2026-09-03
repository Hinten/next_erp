import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import config, { typeAware, baseRestrictedImportPaths } from '../index.js';
import { REPO_ROOT } from './lib/repo-scan.js';

/**
 * Repo invariant: a dead import fails SOMETHING, automatically.
 *
 * ## Why this needs a guard at all
 *
 * Before #1445 it failed nothing. Three mechanisms that would each normally
 * catch an unused import were all off at once, and every one of them looked
 * deliberate in isolation:
 *
 *  - core `no-unused-vars` was `'off'` in the base block — correct on its own,
 *    since it double-reports on TypeScript, but the line carried no comment
 *    saying what was meant to replace it;
 *  - `@typescript-eslint/no-unused-vars` was assumed to arrive with
 *    `eslint-config-next` and never did. Its FLAT export registers the plugin
 *    and the parser but sets no unused-vars rule; the rule lives only in the
 *    `eslint-config-next/typescript` eslintrc export, which nothing spreads;
 *  - `noUnusedLocals` was set in no tsconfig in the chain.
 *
 * The worked example is #1442: it removed a block that used `useQuery` and
 * orphaned the import, which then survived `turbo run typecheck` (28/28),
 * `turbo run lint` (30/30, zero errors) and 3013 apps/web tests. A reviewer
 * reading the diff caught it, which is not a mechanism.
 *
 * That is the signature this file exists for — an invariant that is stated,
 * true today, and **invisible when violated**. Deleting any one of the
 * assertions below restores exactly the silent state #1445 describes: nothing
 * fails, nothing warns, and the next dead import ships.
 *
 * ⚠️ `warn` is not a substitute for `error` here and the guard checks the
 * severity for that reason: no lint script in this repo passes
 * `--max-warnings`, so `turbo run lint` never fails on a warning. Only
 * `.lintstagedrc.mjs` does, and only for files that happen to be staged.
 *
 * A test rather than an ESLint rule because the invariant spans a JS config
 * module, a JSON tsconfig and a Playwright config — none of which ESLint reads
 * as a unit. Failing the test fails CI exactly like a lint error would.
 */

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** The single `rules` object in the base block (the one with no `files` key). */
const baseRules = config.find((c) => c.rules && !c.files)?.rules ?? {};

/** Every block that scopes rules to plain-JS files. */
const jsBlocks = config.filter(
  (c) => Array.isArray(c.files) && c.files.some((f) => String(f).includes('js')),
);

describe('unused-variable detection is enabled', () => {
  it('typeAware() enables @typescript-eslint/no-unused-vars as an ERROR', () => {
    const rules = typeAware('/tmp')[0].rules;
    const entry = rules['@typescript-eslint/no-unused-vars'];
    expect(entry, 'the TS unused-vars rule must be in typeAware()').toBeDefined();
    expect(entry[0]).toBe('error');
  });

  it('the ^_ escape hatch is configured for every binding kind', () => {
    const [, opts] = typeAware('/tmp')[0].rules['@typescript-eslint/no-unused-vars'];
    // The repo writes `_ctx` / `_config` / `_exhaustive` by hand; each of these
    // covers a different binding position, and a missing one turns that
    // position's deliberate-unused convention into an error.
    expect(opts.argsIgnorePattern).toBe('^_');
    expect(opts.varsIgnorePattern).toBe('^_');
    expect(opts.caughtErrorsIgnorePattern).toBe('^_');
    expect(opts.destructuredArrayIgnorePattern).toBe('^_');
  });

  it('the core rule stays off for TypeScript but is re-enabled for plain JS', () => {
    // Off in the unscoped block: the core rule cannot see type positions and
    // reports every type-only import as unused.
    expect(baseRules['no-unused-vars']).toBe('off');

    // ...and back on for `.js`/`.mjs`/`.cjs`, which `typeAware()` cannot reach.
    // That surface is not incidental: it is every custom rule and backstop in
    // this directory, plus the five `apps/*/functions/scripts/prepare-deploy.mjs`.
    const jsRule = jsBlocks.map((b) => b.rules?.['no-unused-vars']).find(Boolean);
    expect(jsRule, 'no JS-scoped block re-enables the core rule').toBeDefined();
    expect(jsRule[0]).toBe('error');
    expect(jsRule[1].varsIgnorePattern).toBe('^_');
  });

  it('noUnusedLocals is set in the shared tsconfig base', () => {
    const base = JSON.parse(read('packages/config-tsconfig/base.json'));
    expect(base.compilerOptions.noUnusedLocals).toBe(true);
  });

  it('every workspace tsconfig inherits it (none overrides it back off)', () => {
    // The flag reaches 27 workspaces through the four shared bases. An
    // individual tsconfig turning it off again would be invisible.
    const overrides = ['nextjs.json', 'node.json', 'react-library.json']
      .map((f) => [f, JSON.parse(read(`packages/config-tsconfig/${f}`))])
      .filter(([, j]) => j.compilerOptions?.noUnusedLocals === false);
    expect(overrides).toEqual([]);
  });
});

describe('focused tests cannot go green', () => {
  it('the no-focused-test rule is registered as an ERROR', () => {
    expect(baseRules['delfrance/no-focused-test']).toBe('error');
  });

  it('playwright forbids .only in CI', () => {
    // Playwright's own default is `false`. Without this the E2E gate reports
    // green for a suite a single `test.only` has stopped running.
    const cfg = read('apps/web/playwright.config.ts');
    expect(cfg).toMatch(/forbidOnly:\s*!!process\.env\.CI/);
  });
});

describe('import boundaries that flat config can silently drop', () => {
  it('the base Cloud Storage ban is exported for re-spreading', () => {
    expect(baseRestrictedImportPaths.some((p) => p.name === 'firebase/storage')).toBe(true);
  });

  it('every app that re-declares no-restricted-imports spreads it back in', () => {
    // Flat config replaces a rule by NAME. Five backends added a
    // `firebase-admin/firestore` restriction and, in doing so, turned the base's
    // Cloud Storage ban off for themselves — while the base file's own comment
    // warned about that exact trap. A comment could not hold this; the spread
    // plus this assertion can.
    const apps = [
      'web',
      'integrations',
      'melhor-envio',
      'mercado-livre',
      'mercado-pago',
      'whatsapp',
    ];
    //
    // ⚠️ The check is for the SPREAD, not merely the identifier: deleting the
    // `...` while leaving the import is precisely the edit that reintroduces the
    // bug, and an `includes('baseRestrictedImportPaths')` test passes straight
    // through it. (Found by mutating this assertion rather than by reasoning.)
    const missing = apps.filter((a) => {
      const src = read(`apps/${a}/eslint.config.mjs`);
      return (
        src.includes("'no-restricted-imports'") && !/\.\.\.baseRestrictedImportPaths/.test(src)
      );
    });
    expect(missing).toEqual([]);
  });

  it('getFirestore must always be given a database id', () => {
    // Enterprise names the database `default`, not the `(default)` sentinel a
    // bare call resolves — so a 0-/1-argument call yields a handle whose every
    // operation fails `5 NOT_FOUND`.
    expect(baseRules['delfrance/require-firestore-database-id']).toBe('error');
  });
});

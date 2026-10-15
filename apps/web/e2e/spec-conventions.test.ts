import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #722: an e2e spec must assert a BEHAVIOUR, never a DEPLOYMENT STATE.
 *
 * `produto-preco.cadastros.e2e.spec.ts` once carried a test literally named
 * "shows the empty state in the cost-history modal (no trigger deployed on
 * staging)". It asserted a fact about the environment, not about the code — so
 * the day the `storage` codebase shipped `onProdutoChanged` (for #308), the
 * modal grew rows and that assertion became permanently false. It then failed on
 * EVERY PR until `5c682b5d` deleted it, and cost PR #719 a full investigation
 * because a stale branch reran the old copy against the new backend.
 *
 * The rule, and the tell: if a test's NAME has to explain what is or is not
 * deployed, it is the wrong test. Assert what the code does; if you need the
 * real trigger output, assert it deterministically in the emulator lane
 * (`*.emulator.e2e.spec.ts`), which owns its own backend.
 *
 * This runs under Vitest (`e2e/**\/*.test.ts`), not Playwright — offline, in
 * ci.yml's `CI test` job. See apps/web/CLAUDE.md rule 8.
 */

/**
 * Deliberate exceptions, matched against the full title. Adding an entry means
 * "this title names a deployment fact ON PURPOSE and I accept that it will rot
 * when the deployment changes" — which is almost never what you want. Prefer
 * rewriting the test to assert behaviour.
 */
export const ALLOWED_DEPLOYMENT_TITLES: string[] = [];

/** Phrases that betray an assertion about deployment state rather than behaviour. */
const DEPLOYMENT_FACT = /\bdeploy(?:ed|s|ing|ment|ado|ada|ados|adas)?\b|\b(?:no|sem)\s+trigger\b/i;

/**
 * `test(...)`, `test.describe(...)`, `test.describe.serial(...)`, `it.skip(...)`
 * and friends — capture the first string-literal argument, which is the title.
 */
const TITLE_CALL = /\b(?:test|describe|it)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return specFiles(full);
    return entry.isFile() && entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

function titlesIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(TITLE_CALL)) {
    const title = match[2];
    if (title) found.push(title);
  }
  return found;
}

describe('e2e spec conventions', () => {
  const files = specFiles(E2E_DIR);

  // A meta-test that scans nothing passes vacuously — which is exactly how this
  // guard would rot. Anchor it to the suite actually existing.
  it('finds the Playwright specs it is supposed to police', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('has no test title asserting a deployment state instead of a behaviour', () => {
    const offenders = files.flatMap((file) =>
      titlesIn(file)
        .filter((title) => DEPLOYMENT_FACT.test(title))
        .filter((title) => !ALLOWED_DEPLOYMENT_TITLES.includes(title))
        .map((title) => `${path.relative(E2E_DIR, file)} → ${title}`),
    );

    expect(
      offenders,
      [
        'An e2e spec must assert a BEHAVIOUR, never a DEPLOYMENT STATE (#722).',
        'These titles name what is or is not deployed, so they will pass until the',
        'deployment changes and then fail on every PR:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'Rewrite the test to assert what the code does. If you need the real',
        'trigger output, assert it in the emulator lane (*.emulator.e2e.spec.ts),',
        'which owns its own backend. See apps/web/CLAUDE.md rule 8.',
      ].join('\n'),
    ).toEqual([]);
  });
});

/**
 * A seed/cleanup helper with no consumer is a spec that never got committed.
 *
 * `seedShopeeFixtures` / `cleanupShopeeFixtures` were committed while their sole
 * importer — `canais-shopee.vendas.e2e.spec.ts` — stayed UNTRACKED (a
 * `git commit -am` skips a new file). Nothing anywhere said so: both helpers
 * are `export`ed, and an unused *export* trips neither
 * `@typescript-eslint/no-unused-vars` nor `noUnusedLocals`. The
 * `.vendas.e2e.spec.ts` suffix is the ONLY thing that routes a spec to the
 * `E2E gate (vendas)` lane, so the lane simply had one spec fewer and reported
 * green over a screen it never opened — the silent-pass class the whole
 * `ci-lanes` design exists to prevent.
 *
 * The check runs against the CHECKED-OUT tree, which is exactly why it works:
 * in a worktree holding the uncommitted spec it passes, and in CI — where only
 * tracked files exist — it fails until the spec is committed. Deleting the
 * helpers instead (a deliberately deferred spec) satisfies it just as well.
 */

/**
 * Fixture helpers that are exported for a reason other than a spec importing
 * them. Adding an entry means "this export is deliberately consumed by nothing
 * in `e2e/`" — which, for a seed helper, is almost never true.
 */
export const ALLOWED_UNUSED_FIXTURE_HELPERS: string[] = [];

/** `export async function seedFooFixtures(` / `export function cleanupFooFixtures(`. */
const FIXTURE_HELPER_DECL = /^export\s+(?:async\s+)?function\s+((?:seed|cleanup)\w*Fixtures)\b/gm;

const SEED_DATA = path.join(E2E_DIR, '_helpers', 'seed-data.ts');

/** This file, excluded from its own scan — see the `consumers` comment below. */
const SELF = fileURLToPath(import.meta.url);

/** An `import … from` whose specifier ends in `seed-data`, in any relative form. */
const IMPORTS_SEED_DATA = /from\s+['"][^'"]*\bseed-data['"]/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('e2e fixture helpers', () => {
  const declared = [...readFileSync(SEED_DATA, 'utf8').matchAll(FIXTURE_HELPER_DECL)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));

  // Same anchor as above: a scan that finds nothing passes vacuously.
  it('finds the exported fixture helpers it is supposed to police', () => {
    expect(declared.length).toBeGreaterThan(10);
  });

  it('has no exported seed/cleanup helper without a consumer', () => {
    // Two exclusions, both load-bearing. The declaring file itself, obviously —
    // and THIS file, which names the two Shopee helpers in the docblock above
    // and even quotes an import specifier as an example: scanning itself made
    // the guard pass vacuously against the exact case it was written for.
    // Requiring a real `import … from '…/seed-data'` narrows the rest, so a
    // helper reached through another helper still counts while prose never does.
    const consumers = tsFiles(E2E_DIR)
      .filter(
        (file) =>
          path.resolve(file) !== path.resolve(SEED_DATA) &&
          path.resolve(file) !== path.resolve(SELF),
      )
      .map((file) => readFileSync(file, 'utf8'))
      .filter((source) => IMPORTS_SEED_DATA.test(source));

    const orphans = declared
      .filter((name) => !ALLOWED_UNUSED_FIXTURE_HELPERS.includes(name))
      .filter((name) => {
        const used = new RegExp(String.raw`\b${name}\b`);
        return !consumers.some((source) => used.test(source));
      });

    expect(
      orphans,
      [
        'These fixture helpers are exported from e2e/_helpers/seed-data.ts and',
        'imported by nothing in e2e/ — almost always a spec that was written but',
        'never committed (an unused EXPORT fails neither ESLint nor tsc):',
        '',
        ...orphans.map((name) => `  - ${name}`),
        '',
        'Commit the spec that uses them, or delete the helpers if the spec is',
        'deliberately deferred. Until then the E2E lane its filename suffix',
        'selects runs one spec fewer and still reports green.',
      ].join('\n'),
    ).toEqual([]);
  });
});

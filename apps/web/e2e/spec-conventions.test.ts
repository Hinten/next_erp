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

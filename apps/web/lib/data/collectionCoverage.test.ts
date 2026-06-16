import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_DOMAINS, PRODUTO_SUBCOLLECTION_NAMES } from '@delfrance/schemas';
import { GRUPO_ECONOMICO_COLLECTION_PATH } from '@delfrance/core/tenant';

/**
 * Drift guard (#160): every Firestore collection this app reads/writes must be
 * covered by a generated `firestore.rules` match block. A collection the app
 * uses but the generator doesn't know about is default-denied at runtime —
 * exactly the bug that made produto deletion fail ("Missing or insufficient
 * permissions"): the marketplace subcollections were defined only here and were
 * absent from `@delfrance/schemas` `ALL_DOMAINS`.
 *
 * Strategy: scan every `defineCollection({ path: … })` in `lib/data` and assert
 * its path is in the covered set (ALL_DOMAINS + the hand-written extra blocks in
 * `@delfrance/rules-gen`, only `grupoEconomico` today). Heuristic but fail
 * closed — an unknown path identifier or an uncovered literal fails CI.
 */

/** Normalize `{placeholder}` → `{}` so paths compare regardless of wildcard name. */
const norm = (p: string): string => p.replace(/\{[^}]*\}/g, '{}');

const COVERED = new Set<string>([
  ...ALL_DOMAINS.map((d) => norm(d.meta.collectionPath)),
  // grupoEconomico is a hand-written EXTRA_MATCH_BLOCK in @delfrance/rules-gen.
  norm(GRUPO_ECONOMICO_COLLECTION_PATH),
]);

/** Identifiers used as `path:` we can't resolve statically — map the known ones. */
const PATH_IDENTIFIERS: Record<string, string> = {
  GRUPO_ECONOMICO_COLLECTION_PATH,
};

const dataDir = dirname(fileURLToPath(import.meta.url));

function collectPaths(): { staticPaths: string[]; dynamicCount: number; identifiers: string[] } {
  const staticPaths: string[] = [];
  const identifiers: string[] = [];
  let dynamicCount = 0;
  for (const file of readdirSync(dataDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(join(dataDir, file), 'utf8');
    if (!src.includes('defineCollection(')) continue;
    for (const m of src.matchAll(/\bpath:\s*(.+?)\s*$/gm)) {
      const raw = m[1];
      if (raw === undefined) continue;
      const expr = raw.replace(/,\s*$/, '').trim();
      if (expr.startsWith("'") || expr.startsWith('"')) {
        staticPaths.push(expr.slice(1, -1));
      } else if (expr.startsWith('`')) {
        const inner = expr.slice(1, -1);
        if (inner.includes('${'))
          dynamicCount += 1; // dynamic builder (marketplace)
        else staticPaths.push(inner);
      } else {
        identifiers.push(expr);
      }
    }
  }
  return { staticPaths, dynamicCount, identifiers };
}

describe('apps/web collection coverage (rules drift guard #160)', () => {
  const { staticPaths, dynamicCount, identifiers } = collectPaths();

  it('finds the data-layer defineCollection paths', () => {
    expect(staticPaths.length).toBeGreaterThan(10);
  });

  it('every static defineCollection path is covered by the generated rules', () => {
    const uncovered = [...new Set(staticPaths)].filter((p) => !COVERED.has(norm(p)));
    expect(uncovered, 'register these collections in @delfrance/schemas ALL_DOMAINS').toEqual([]);
  });

  it('every path identifier resolves to a covered collection', () => {
    const uncovered = identifiers.filter((id) => {
      const resolved = PATH_IDENTIFIERS[id];
      return resolved === undefined || !COVERED.has(norm(resolved));
    });
    expect(uncovered, 'add the identifier→path mapping here and register the collection').toEqual(
      [],
    );
  });

  it('the produto marketplace subcollections (dynamic path) are all covered', () => {
    // The builder emits `produtos/{produtoId}/${name}` over the shared
    // PRODUTO_SUBCOLLECTION_NAMES; assert each expansion is covered.
    expect(dynamicCount).toBeGreaterThan(0); // the dynamic builder still exists
    const uncovered = PRODUTO_SUBCOLLECTION_NAMES.map((n) => `produtos/{produtoId}/${n}`).filter(
      (p) => !COVERED.has(norm(p)),
    );
    expect(uncovered).toEqual([]);
  });
});

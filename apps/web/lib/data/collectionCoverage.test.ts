import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_DOMAINS,
  PRODUTO_SUBCOLLECTION_NAMES,
  historicoModificacaoMeta,
  historicoModificacaoPedidoMeta,
} from '@delfrance/schemas';
import { GRUPO_ECONOMICO_COLLECTION_PATH } from '@delfrance/core/tenant';

/**
 * Drift guard (#160): every Firestore collection this app reads/writes must be
 * covered by a generated `firestore.rules` match block. A collection the app
 * uses but the generator doesn't know about is default-denied at runtime —
 * exactly the bug that made produto deletion fail ("Missing or insufficient
 * permissions"): the marketplace subcollections were defined only here and were
 * absent from `@delfrance/schemas` `ALL_DOMAINS`.
 *
 * Strategy: scan every `defineCollection({ path: … })` under `apps/web/lib` and
 * assert its path is in the covered set (ALL_DOMAINS + the hand-written extra
 * blocks in `@delfrance/rules-gen`, only `grupoEconomico` today). Heuristic but
 * fail closed — an unknown path identifier or an uncovered literal fails CI.
 *
 * The scan is recursive over the whole `lib/` tree, not just `lib/data` (#174):
 * #148 defined its history collections under `lib/produtos/*` and was caught
 * only because they were also in `ALL_DOMAINS`; a future collection handle
 * defined anywhere in `lib/` would otherwise slip through uncovered. `app/` is
 * deliberately out of scope — page components may create throwaway
 * `defineCollection` handles solely to reuse a converter (e.g.
 * `pagamentos/page.tsx`), whose `path` is a placeholder, not a real collection.
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
  'historicoModificacaoMeta.collectionPath': historicoModificacaoMeta.collectionPath,
  'historicoModificacaoPedidoMeta.collectionPath': historicoModificacaoPedidoMeta.collectionPath,
};

const dataDir = dirname(fileURLToPath(import.meta.url));
// Scan the whole `lib/` tree (#174), not just `lib/data` — dataDir is
// `apps/web/lib/data`, so its parent is `apps/web/lib`.
const libDir = dirname(dataDir);

/**
 * Recursively list every non-test `.ts`/`.tsx` file under `root`. `.tsx` is
 * included so the scan matches its documented scope — a `defineCollection`
 * handle in a `.tsx` module (page/component-adjacent code does host them, e.g.
 * `app/pagamentos/page.tsx`) must not bypass the guard.
 */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Skip hidden dirs and build/dependency output; nothing there defines
      // a source-level collection handle.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      out.push(...walkTsFiles(join(root, entry.name)));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(join(root, entry.name));
    }
  }
  return out;
}

function collectPaths(): {
  staticPaths: string[];
  dynamicCount: number;
  identifiers: string[];
  scannedDirs: Set<string>;
} {
  const staticPaths: string[] = [];
  const identifiers: string[] = [];
  const scannedDirs = new Set<string>();
  let dynamicCount = 0;
  for (const file of walkTsFiles(libDir)) {
    // Top-level `lib/` subdirectory this file lives under (for the recursion
    // self-check below).
    scannedDirs.add(relative(libDir, file).split(sep)[0] ?? '');
    const src = readFileSync(file, 'utf8');
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
  return { staticPaths, dynamicCount, identifiers, scannedDirs };
}

describe('apps/web collection coverage (rules drift guard #160)', () => {
  const { staticPaths, dynamicCount, identifiers, scannedDirs } = collectPaths();

  it('finds the data-layer defineCollection paths', () => {
    expect(staticPaths.length).toBeGreaterThan(10);
  });

  it('scans the whole lib/ tree, not just lib/data (#174)', () => {
    // A flat `lib/data`-only scan would report just `data`; the recursive walk
    // must descend into sibling lib/ subdirectories so a collection handle
    // defined outside lib/data (as in #148's lib/produtos/*) cannot slip
    // through uncovered.
    expect(scannedDirs.has('data')).toBe(true);
    expect(scannedDirs.size).toBeGreaterThan(1);
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

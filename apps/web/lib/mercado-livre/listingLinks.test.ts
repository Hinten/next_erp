import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  estadoLabel,
  publishSummary,
  isStockLatched,
  listingModel,
  listingPermalink,
  parseEstado,
  refMatchesIntegracao,
} from './listingLinks';

describe('refMatchesIntegracao', () => {
  it('accepts both the stored documents/ form and the bare one', () => {
    expect(refMatchesIntegracao('documents/integracao/conta-1', 'conta-1')).toBe(true);
    expect(refMatchesIntegracao('integracao/conta-1', 'conta-1')).toBe(true);
  });

  it('rejects another account and an absent ref', () => {
    expect(refMatchesIntegracao('documents/integracao/conta-2', 'conta-1')).toBe(false);
    expect(refMatchesIntegracao(null, 'conta-1')).toBe(false);
    expect(refMatchesIntegracao('', 'conta-1')).toBe(false);
  });

  it('does not match on a suffix that is not a path segment', () => {
    expect(refMatchesIntegracao('documents/integracao/outra-conta-1', 'conta-1')).toBe(false);
  });
});

describe('parseEstado / estadoLabel', () => {
  it('labels a known estado code', () => {
    expect(parseEstado('p')).toBe('p');
    expect(estadoLabel('p')).toBe('Publicado');
    expect(estadoLabel('E')).toBe('Erro');
  });

  it('soft-parses an unknown code instead of throwing', () => {
    // The Flutter app can hold values this schema has never seen.
    expect(parseEstado('zz')).toBeNull();
    expect(estadoLabel('zz')).toBe('zz');
    expect(estadoLabel(null)).toBe('Desconhecido');
  });
});

describe('listingModel', () => {
  it('distinguishes the two coexisting models', () => {
    expect(listingModel({ isUserProductModel: true })).toBe('user-products');
    expect(listingModel({ isUserProductModel: false })).toBe('legacy');
    expect(listingModel({})).toBe('legacy');
  });
});

describe('isStockLatched', () => {
  it('is latched only for a PUBLISHED listing in error', () => {
    expect(isStockLatched({ estado: 'E', id: 'MLB1' })).toBe(true);
    expect(isStockLatched({ estado: 'E', id: null })).toBe(false); // never published
    expect(isStockLatched({ estado: 'p', id: 'MLB1' })).toBe(false);
  });
});

describe('listingPermalink', () => {
  it('builds the legacy URL from the stored id with no round trip', () => {
    expect(listingPermalink({ id: 'MLB777', isUserProductModel: false })).toBe(
      'https://produto.mercadolivre.com.br/MLB-777',
    );
  });

  it('never builds a User Products page, even for a família', () => {
    // The inverted assertion. A UP (`MLBU…`) is a *product*, not an offer, so
    // `/up/<MLBU>` has nothing to sell and renders indisponível whenever that
    // member's items are paused or closed. A família id addresses nothing public
    // either, so the honest answer here is null and the backend resolves it —
    // see the ⚠️ on `listingPermalink`.
    expect(listingPermalink({ id: '6264141844942250', isUserProductModel: true })).toBeNull();
  });

  it('links a member item, which resolves and redirects', () => {
    expect(
      listingPermalink(
        { id: '6264141844942250', isUserProductModel: true },
        { firstMemberItemId: 'MLB999' },
      ),
    ).toBe('https://produto.mercadolivre.com.br/MLB-999');
  });

  it('returns null when there is nothing to link to yet', () => {
    expect(listingPermalink({ id: null, isUserProductModel: false })).toBeNull();
    expect(listingPermalink({ id: 'MLB1', isUserProductModel: true })).toBeNull();
    // A UP family id is NOT an MLB item id — never build a product URL from it.
    expect(listingPermalink({ id: 'sem-digitos', isUserProductModel: false })).toBeNull();
  });
});

describe('publishSummary (#798)', () => {
  it('a single item keeps naming it', () => {
    expect(publishSummary({ itemId: 'MLB1', estado: 'p', itemIds: ['MLB1'] })).toBe(
      'Anúncio MLB1 — Publicado.',
    );
  });

  it('a User-Products family reports the COUNT, not a family id', () => {
    // `itemId` is the family id there, which means nothing to an operator — and
    // the child links carrying the real item ids are not on screen.
    expect(
      publishSummary({ itemId: '4260899048783356', estado: 'p', itemIds: ['MLB1', 'MLB2'] }),
    ).toBe('2 anúncios (1 por variação) — Publicado.');
  });

  it('reports closed listings, singular and plural', () => {
    expect(
      publishSummary({
        itemId: 'F1',
        estado: 'p',
        itemIds: ['MLB1', 'MLB2'],
        orfaosEncerrados: ['MLB9'],
      }),
    ).toMatch(/1 anúncio encerrado \(variação removida\)\.$/);
    expect(
      publishSummary({
        itemId: 'F1',
        estado: 'p',
        itemIds: ['MLB1'],
        orfaosEncerrados: ['MLB9', 'MLB8'],
      }),
    ).toMatch(/2 anúncios encerrados \(variação removida\)\.$/);
  });

  it('degrades to the old sentence when the backend predates #798', () => {
    // apps/web calls the DEPLOYED channel backend, not this checkout — a
    // revision without the new fields must not render "undefined anúncios".
    expect(publishSummary({ itemId: 'MLB1', estado: 'pa' })).toBe('Anúncio MLB1 — Pausado.');
  });
});

/**
 * The `apps/web` half of the User-Products-page guard.
 *
 * ⚠️ It lives HERE, not beside its twin in
 * `apps/mercado-livre/lib/marketplace/anuncios/anuncioUrl.test.ts`, and the split
 * is the whole point. `ci.yml` excludes `@delfrance/mercado-livre-app` from
 * `turbo run test` (line 101 — an exclusion `ci-mercado-livre.yml` owns), and that
 * lane derives its scope from the `workspace:*` closure of the ML app, which does
 * NOT contain `apps/web`. So a PR that reintroduced
 * `mercadolivre.com.br/up/<userProductId>` in this file's own module would have
 * run the ML-side assertion nowhere at all — not a red check, not a skip, simply
 * never executed, which is the silent-pass shape the root `CLAUDE.md` CI rules
 * exist to prevent. This workspace's `test` task runs in `ci.yml` on every PR,
 * unfiltered, so the guard now rides a lane its own diff always triggers.
 *
 * The duplication is deliberate, and the same trade `mlbProductUrl` already makes
 * across these two surfaces: a shared helper would need a package, and a guard
 * that cannot run is worth less than one written twice.
 */
describe('apps/web builds no User Products page URL', () => {
  const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage', 'test-results']);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  /** Block comments hold the JSDoc; a `//` line is stripped whole. */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

  it('never constructs mercadolivre.com.br/up/', () => {
    // `lib/mercado-livre` → `lib` → the app root.
    const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const scanned = sourceFiles(appRoot);

    // A guard that scans nothing rejects nothing — fail here rather than pass
    // vacuously if this path ever stops resolving.
    expect(scanned.length).toBeGreaterThan(100);

    const offenders = scanned.filter((file) =>
      stripComments(readFileSync(file, 'utf8')).includes('mercadolivre.com.br/up/'),
    );

    expect(offenders).toEqual([]);
  });
});

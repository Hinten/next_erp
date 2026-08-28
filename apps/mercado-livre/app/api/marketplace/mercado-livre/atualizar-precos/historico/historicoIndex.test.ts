/**
 * The composite index this route needs, DERIVED from the route's own source and
 * compared against `firestore.indexes.json`.
 *
 * Why a bespoke guard rather than an existing one: the two repo-wide index
 * backstops both key on `meta.defaultQuery` (the `delfrance/default-query-needs-index`
 * lint rule and `packages/schemas/src/defaultQuery.indexes.test.ts`), and
 * `enviosPrecoMercadoLivre` has no `CollectionMetadata` at all — it is admin-only
 * and deliberately outside `ALL_DOMAINS`. So a hand-written `.where().orderBy()`
 * in a route is exactly the shape nothing else covers.
 *
 * ⚠️ And it has NO runtime signal either. On Firestore Enterprise a missing
 * composite does not throw `FAILED_PRECONDITION` and offers no one-click link —
 * it silently full-scans, and Enterprise bills data scanned, so the mistake
 * lands on the invoice. The emulator auto-creates composites, so
 * `ci-mercado-livre.yml` cannot catch it either. This file is the only place it
 * surfaces.
 *
 * Modelled on guard D of
 * `packages/data/src/admin/notifications/notificationGuardrails.test.ts`,
 * including its discipline of testing the DETECTOR: a regex that silently stops
 * matching would manufacture a green guard, so the parser has both a
 * known-good and a known-bad control below.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../../../..');

const routeSource = readFileSync(resolve(HERE, 'route.ts'), 'utf8');

interface IndexField {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

/**
 * Read the query's shape out of the route source: the `where` equality field and
 * the `orderBy` field + direction. Deriving it rather than restating it is the
 * whole point — a hand-copied expectation drifts silently the day someone flips
 * the sort, which is precisely the change that invalidates the index.
 */
export function derivarCamposDoIndice(src: string): IndexField[] | null {
  // ⚠️ `matchAll`, not `exec`. `exec` returns the FIRST match only, so a second
  // equality filter added later — `.where('status', '==', …)` beside the
  // existing one — would leave this deriving the two-field shape while the real
  // requirement became `(integracaoId, status, startedAt DESC)`. The guard would
  // stay green and the query would full-scan with no runtime signal, which is
  // exactly the failure this file exists to catch.
  const igualdades = [...src.matchAll(/\.where\(\s*'([A-Za-z0-9_.]+)'\s*,\s*'=='/g)].map(
    (m) => m[1]!,
  );
  const order = /\.orderBy\(\s*'([A-Za-z0-9_.]+)'\s*,\s*'(asc|desc)'\s*\)/.exec(src);
  if (igualdades.length === 0 || !order) return null;
  return [
    // Sorted only for determinism: Firestore treats the equality PREFIX as
    // order-insensitive, so the sort cannot make a satisfying index look wrong.
    ...[...new Set(igualdades)].sort().map<IndexField>((f) => ({
      fieldPath: f,
      order: 'ASCENDING',
    })),
    { fieldPath: order[1]!, order: order[2] === 'desc' ? 'DESCENDING' : 'ASCENDING' },
  ];
}

const indexes = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'firestore.indexes.json'), 'utf8')) as {
    indexes?: Array<{ collectionGroup?: string; queryScope?: string; fields?: IndexField[] }>;
  }
).indexes;

describe('the historico route has its composite index', () => {
  it('firestore.indexes.json is readable and non-empty', () => {
    // Without this, an unreadable/empty file would make every check below pass
    // by finding nothing to disagree with.
    expect(Array.isArray(indexes)).toBe(true);
    expect(indexes!.length).toBeGreaterThan(0);
  });

  it('the query shape is still derivable from route.ts', () => {
    // A guard whose parser stops matching reports "nothing missing" forever.
    expect(derivarCamposDoIndice(routeSource)).not.toBeNull();
  });

  it('declares (integracaoId ASC, startedAt DESC) for enviosPrecoMercadoLivre', () => {
    const required = derivarCamposDoIndice(routeSource)!;

    const found = indexes!.some(
      (idx) =>
        idx.collectionGroup === 'enviosPrecoMercadoLivre' &&
        idx.queryScope === 'COLLECTION' &&
        Array.isArray(idx.fields) &&
        idx.fields.length === required.length &&
        idx.fields.every(
          (f, i) => f.fieldPath === required[i]!.fieldPath && f.order === required[i]!.order,
        ),
    );

    if (found) return;
    expect.fail(
      `Missing the Firestore composite this route's query needs. Enterprise creates no ` +
        `indexes automatically and a missing one does NOT throw — it full-scans and bills ` +
        `the scan. Add to the "indexes" array of firestore.indexes.json, then run ` +
        `\`firebase deploy --only firestore:indexes\`:\n` +
        JSON.stringify(
          {
            collectionGroup: 'enviosPrecoMercadoLivre',
            queryScope: 'COLLECTION',
            fields: required,
          },
          null,
          2,
        ),
    );
  });

  // ⚠️ Enterprise omits the implicit trailing `__name__` field, so index JSON
  // copied from Standard-edition docs is wrong. Every sibling entry in this file
  // stops at its real fields; this pins that the new one does too.
  it('declares no trailing __name__ field, which Enterprise omits', () => {
    const nossos = indexes!.filter((idx) => idx.collectionGroup === 'enviosPrecoMercadoLivre');
    expect(nossos.length).toBeGreaterThan(0);
    for (const idx of nossos) {
      expect(idx.fields?.map((f) => f.fieldPath)).not.toContain('__name__');
    }
  });

  describe('the derivation itself', () => {
    it('reads the direction, not just the field name', () => {
      expect(derivarCamposDoIndice(`.where('a', '==', x).orderBy('b', 'desc')`)).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'DESCENDING' },
      ]);
      // The known-BAD control: flipping the sort must produce a DIFFERENT
      // requirement, or the guard would accept an index that cannot serve the
      // query. `indexSatisfies`-style order-blindness is the bug this rules out.
      expect(derivarCamposDoIndice(`.where('a', '==', x).orderBy('b', 'asc')`)).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'ASCENDING' },
      ]);
    });

    it('returns null when there is no query to derive from', () => {
      expect(derivarCamposDoIndice(`const x = 1;`)).toBeNull();
      expect(derivarCamposDoIndice(`.where('a', '==', x)`)).toBeNull();
    });

    it('⭐ picks up a SECOND equality filter, which `exec` would have missed', () => {
      // The whole point of the guard: adding `.where('status','==',…)` changes
      // the required index to a three-field one. Deriving only the first
      // equality would keep asserting the two-field shape — green, while the
      // query full-scans with no runtime signal.
      expect(
        derivarCamposDoIndice(
          `.where('integracaoId', '==', id).where('status', '==', s).orderBy('startedAt', 'desc')`,
        ),
      ).toEqual([
        { fieldPath: 'integracaoId', order: 'ASCENDING' },
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'startedAt', order: 'DESCENDING' },
      ]);
    });

    it('does not double-count a repeated equality field', () => {
      expect(
        derivarCamposDoIndice(`.where('a', '==', x).where('a', '==', y).orderBy('b', 'desc')`),
      ).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'DESCENDING' },
      ]);
    });
  });
});

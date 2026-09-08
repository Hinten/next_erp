import { describe, expect, it } from 'vitest';
import * as registry from './index';
import type { CollectionMetadata } from './types';

/**
 * Every `defaultQuery.orderBy` field must MATERIALIZE a value when a writer
 * omits it — otherwise the document has no such key on disk, and a classic
 * Firestore `orderBy` silently EXCLUDES documents missing the ordered field.
 *
 * This is not a style rule. It is the precondition for `TableView`'s live
 * (streaming) path. Today the default listing is a Pipelines `.sort`, which
 * treats an absent field as `null` and KEEPS the row (`types.ts` RECENCY_SORT,
 * and the pipelines skill: "absent field sorts as null"). A classic `orderBy`
 * does the opposite. So moving a screen from pipeline to `onSnapshot` NARROWS
 * its result set — with no error, no failing test and no index signal.
 *
 * The repo has already paid a `tools/migrations` run for exactly this:
 * `produtoSchema.ultimaModificacao` was `.nullable().optional()` with no
 * `.default(null)`, Zod dropped the key whenever a writer did not supply one,
 * and imported produtos "never appeared in DESC listings" (#861, #1213).
 * `VariationManager` children, every fixture seeder and every pre-#861 ML
 * import were the producers.
 *
 * ⚠️ `.nullable()` is NOT enough and `.optional()` is the trap: a stored `null`
 * is fine (the key exists), only an ABSENT key hides a row. Declare
 * `.nullable().default(null)`, never `.nullable().optional()` alone.
 *
 * ⚠️ This guards the SCHEMA, i.e. what this app writes from here on. It cannot
 * see documents already on disk, nor the legacy corpus arriving at the cutover
 * (root CLAUDE.md rule 8) — those need a backfill.
 */

interface Bundle {
  schema: {
    shape?: Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
  };
  meta: CollectionMetadata;
}

function isBundle(value: unknown): value is Bundle {
  if (!value || typeof value !== 'object') return false;
  const v = value as { schema?: unknown; meta?: { collectionPath?: unknown } };
  return !!v.schema && typeof v.meta?.collectionPath === 'string';
}

const bundles: Bundle[] = [];
const seen = new Set<string>();
for (const value of Object.values(registry)) {
  if (isBundle(value) && !seen.has(value.meta.collectionPath)) {
    seen.add(value.meta.collectionPath);
    bundles.push(value);
  }
}

describe('defaultQuery sort keys are always present', () => {
  it('found the registry', () => {
    expect(bundles.length).toBeGreaterThan(15);
  });

  const offenders: string[] = [];
  const checked: string[] = [];

  for (const { schema, meta } of bundles) {
    for (const o of meta.defaultQuery?.orderBy ?? []) {
      // Nested paths (`a.b`) are not top-level shape keys; a classic orderBy on
      // one is equally exclusion-prone, but no defaultQuery declares one today.
      const field = schema.shape?.[o.field];
      if (!field) continue;
      const r = field.safeParse(undefined);
      const materializes = !r.success || r.data !== undefined;
      checked.push(`${meta.collectionPath}.${o.field}`);
      if (!materializes) offenders.push(`${meta.collectionPath}.${o.field} (${o.direction})`);
    }
  }

  it('checks every declared sort key', () => {
    expect(checked.length).toBeGreaterThan(15);
  });

  it('has no sort key that Zod drops when omitted', () => {
    expect(
      offenders,
      'these fields are `.optional()` without a `.default()`, so a writer that ' +
        'omits them produces a document with NO such key — and a classic ' +
        '`orderBy` excludes it from the list entirely. Declare ' +
        '`.nullable().default(null)`.',
    ).toEqual([]);
  });
});

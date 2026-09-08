import { describe, expect, it } from 'vitest';
import * as registry from './index';
import type { CollectionMetadata } from './types';

/**
 * Every field a CLASSIC Firestore `orderBy` runs against must MATERIALIZE a
 * value when a writer omits it — otherwise the document has no such key on
 * disk, and `orderBy` silently EXCLUDES it.
 *
 * A pipeline `.sort` does the opposite: it treats an absent field as `null` and
 * KEEPS the row (`types.ts` RECENCY_SORT, and the pipelines skill: "absent
 * field sorts as null"). So the two engines disagree about which documents
 * exist, with no error, no failing test and no index signal.
 *
 * The repo has already paid a `tools/migrations` run for exactly this:
 * `produtoSchema.ultimaModificacao` was `.nullable().optional()` with no
 * `.default(null)`, Zod dropped the key whenever a writer did not supply one,
 * and imported produtos "never appeared in DESC listings" (#861, #1213).
 * `VariationManager` children, every fixture seeder and every pre-#861 ML
 * import were the producers — all writers that bypass the assumption these
 * fields' comments make.
 *
 * TWO query classes are covered, and they are not the same set:
 *
 *  1. `meta.defaultQuery.orderBy` — a pipeline today, so absence is currently
 *     harmless there; it becomes load-bearing when a screen streams (#40).
 *  2. The `TableView` UPDATE MONITOR — `orderBy(field, 'desc').limit(1)` built
 *     by `useCollectionMonitor` — which is CLASSIC **today**. Its field is
 *     resolved by `TableView` as: prefer `ultimaModificacao`, else `timestamp`.
 *     A dropped key there hides the row from the staleness check right now.
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

/** Screens that render a TableView — the ones with a declared list query. */
const listBundles = bundles.filter((b) => b.meta.defaultQuery);

/** `undefined` in → a value out? (required, or carrying a `.default()`). */
function materializes(field: { safeParse(v: unknown): { success: boolean; data?: unknown } }) {
  const r = field.safeParse(undefined);
  return !r.success || r.data !== undefined;
}

const HINT =
  'declare `.nullable().default(null)`, never a bare `.optional()`: Zod drops an ' +
  'omitted `.optional()` key, and a classic `orderBy` excludes documents that ' +
  'lack the ordered field.';

describe('sort keys are always present', () => {
  // ⚠️ Pinned near the real counts, not at a token floor. At `> 15` roughly
  // three quarters of the registry could stop being discovered — an `isBundle`
  // shape change, a barrel refactor — while every assertion below still passed
  // over the remnant. These numbers only ever grow; raise them when they do.
  it('discovers the whole registry', () => {
    expect(bundles.length).toBeGreaterThanOrEqual(61);
    expect(listBundles.length).toBeGreaterThanOrEqual(20);
  });

  it('has no defaultQuery sort key that Zod drops when omitted', () => {
    const offenders: string[] = [];
    const unknownKeys: string[] = [];
    let checked = 0;
    for (const { schema, meta } of listBundles) {
      for (const o of meta.defaultQuery?.orderBy ?? []) {
        // A nested path is not a top-level shape key. It is equally
        // exclusion-prone, but nothing can be read off the shape for it.
        if (o.field.includes('.')) continue;
        const field = schema.shape?.[o.field];
        if (!field) {
          // NOT skippable: an orderBy naming a field no document has returns
          // the EMPTY SET on the classic path, and sorts everything as `null`
          // on the pipeline. `deriveRequiredIndex` takes the name at face
          // value, so nothing else catches a typo or a renamed field.
          unknownKeys.push(`${meta.collectionPath}.${o.field}`);
          continue;
        }
        checked++;
        if (!materializes(field)) offenders.push(`${meta.collectionPath}.${o.field}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(unknownKeys, 'orderBy names a field that is not in the schema shape').toEqual([]);
    expect(offenders, HINT).toEqual([]);
  });

  it('has no TableView update-monitor field that Zod drops when omitted', () => {
    // Mirrors `TableView`'s `resolvedMonitorField`: prefer `ultimaModificacao`,
    // else `timestamp`, else no monitor. That query is CLASSIC today, so this
    // is a live exclusion, not a future one.
    const offenders: string[] = [];
    let checked = 0;
    for (const { schema, meta } of listBundles) {
      const shape = schema.shape ?? {};
      const field = shape.ultimaModificacao ?? shape.timestamp;
      if (!field) continue;
      checked++;
      if (!materializes(field)) {
        const name = shape.ultimaModificacao ? 'ultimaModificacao' : 'timestamp';
        offenders.push(`${meta.collectionPath}.${name}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(offenders, HINT).toEqual([]);
  });
});

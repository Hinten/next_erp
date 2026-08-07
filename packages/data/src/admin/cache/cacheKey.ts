/**
 * Stable string encoding for read-cache keys.
 *
 * `createReadCache` keys a plain `Map`, so an object key would compare by
 * reference and never hit. Everything therefore goes through {@link cacheKeyOf},
 * which flattens a primitive or a (nested) tuple into one string.
 *
 * The encoding is **injective**: two different keys never collapse to the same
 * string. That matters because a collision is a silently WRONG cached value, not
 * a miss. Two properties buy it:
 *
 *  - every leaf carries a type tag, so `1` and `'1'` differ;
 *  - the four structural characters (`\` `|` `[` `]`) are backslash-escaped
 *    inside a leaf, so `['a|b']` differs from `['a', 'b']`.
 *
 * Hand-rolled rather than `safe-stable-stringify` / `JSON.stringify`: no
 * dependency, and JSON is not injective over our key space anyway
 * (`undefined` disappears from objects, `-0` becomes `0`).
 */

/**
 * Anything usable as a cache key. Tuples nest, which is how a query key carries
 * one entry per predicate value.
 */
export type CacheKey = string | number | boolean | null | undefined | readonly CacheKey[];

/** The structural characters that must not appear raw inside a leaf. */
const STRUCTURAL = /[\\|[\]]/g;

function escapeLeaf(value: string): string {
  return value.replace(STRUCTURAL, (char) => `\\${char}`);
}

/**
 * Encode a key as a stable, injective string.
 *
 * Leaves are type-tagged (`s:` string, `n:` number, `b:` boolean, `z:` nullish)
 * and tuples are wrapped in `[…]` with `|` between elements:
 *
 * ```ts
 * cacheKeyOf('abc')            // 's:abc'
 * cacheKeyOf(42)               // 'n:42'
 * cacheKeyOf(['integracao', 7]) // '[s:integracao|n:7]'
 * ```
 *
 * Two documented flattenings, both harmless for Firestore keys: `-0` encodes as
 * `n:0` (Firestore treats them as one number), and `NaN` encodes as `n:NaN`
 * (every `NaN` is the same key — it would never match a stored value anyway).
 */
export function cacheKeyOf(key: CacheKey): string {
  if (typeof key === 'string') return `s:${escapeLeaf(key)}`;
  if (typeof key === 'number') return `n:${String(key)}`;
  if (typeof key === 'boolean') return `b:${String(key)}`;
  if (key === null) return 'z:null';
  if (key === undefined) return 'z:undefined';
  return `[${key.map(cacheKeyOf).join('|')}]`;
}

/**
 * Key for a cached QUERY, namespaced by the collection it reads.
 *
 * A Firestore `Query` cannot be introspected to derive its own key — the admin
 * SDK keeps its filters on an internal field, and this package holds
 * `firebase-admin` at arm's length (type-only imports). So the contract is
 * explicit: **pass the same values you fed the predicates**, in a fixed order.
 *
 * ```ts
 * // .where('tipo','==',tipo).where('user_id','==',userId).where('ativo','==',true)
 * queryCacheKey(integracaoCollection.resolvePath({}), tipo, userId, true);
 * ```
 *
 * Leaving a predicate value out is the one way to get a wrong hit, so keep the
 * call adjacent to the query it describes.
 */
export function queryCacheKey(
  collectionPath: string,
  ...predicateValues: readonly CacheKey[]
): string {
  return cacheKeyOf([collectionPath, ...predicateValues]);
}

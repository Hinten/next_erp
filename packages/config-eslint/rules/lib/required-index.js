// Pure derivation of the Firestore composite index a collection's
// `defaultQuery` requires. Single-sourced here (plain ESM JS + a hand-written
// sibling `.d.ts`) so BOTH consumers share one implementation:
//   - the `default-query-needs-index` ESLint rule (this package, JS), and
//   - the `@delfrance/schemas` meta-test (TS, deep-imports this file via
//     `@delfrance/config-eslint/rules/lib/required-index.js`).
//
// Firestore index matching rules baked in (verified against Firebase docs for
// the Enterprise edition this project uses):
//   - Equality (`where`) fields come first, in their declared order, each
//     ASCENDING. (Firestore allows any permutation among equality fields; we
//     standardize on declared order so the authored index file is canonical.)
//   - `orderBy` fields follow, each with its exact direction — an ASCENDING
//     index entry does not serve `orderBy desc`.
//   - Enterprise does NOT append the implicit trailing `__name__` field that
//     Standard edition does, so we compare fields as-written but tolerate one
//     explicit trailing `__name__` entry in a candidate.

/**
 * @param {'asc' | 'desc'} direction
 * @returns {'ASCENDING' | 'DESCENDING'}
 */
function toOrder(direction) {
  return direction === 'desc' ? 'DESCENDING' : 'ASCENDING';
}

/**
 * Leaf collection id of a (possibly nested) Firestore path. Index definitions
 * key off the collection group id, which is the last path segment —
 * `clientes/{clienteId}/enderecos` → `enderecos`.
 * @param {string} collectionPath
 * @returns {string}
 */
export function collectionGroupOf(collectionPath) {
  const segments = collectionPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : collectionPath;
}

/**
 * Derive the single composite index a default query needs.
 * @param {string} collectionPath
 * @param {{ where?: ReadonlyArray<{ field: string }>, orderBy: ReadonlyArray<{ field: string, direction: 'asc' | 'desc' }> }} defaultQuery
 * @returns {import('./required-index.js').RequiredIndex}
 */
export function deriveRequiredIndex(collectionPath, defaultQuery) {
  /** @type {import('./required-index.js').RequiredIndexField[]} */
  const fields = [];
  for (const w of defaultQuery.where ?? []) {
    fields.push({ fieldPath: w.field, order: 'ASCENDING' });
  }
  for (const o of defaultQuery.orderBy) {
    fields.push({ fieldPath: o.field, order: toOrder(o.direction) });
  }
  return {
    collectionGroup: collectionGroupOf(collectionPath),
    queryScope: 'COLLECTION',
    fields,
  };
}

/**
 * Strip a single trailing `__name__` field (Standard edition appends it; we
 * tolerate it on candidates for parity with hand-authored / CLI-normalized
 * index files).
 * @param {ReadonlyArray<{ fieldPath?: string, order?: string }>} fields
 * @returns {ReadonlyArray<{ fieldPath?: string, order?: string }>}
 */
function stripTrailingName(fields) {
  if (fields.length > 0 && fields[fields.length - 1]?.fieldPath === '__name__') {
    return fields.slice(0, -1);
  }
  return fields;
}

/**
 * Does a parsed `firestore.indexes.json` entry satisfy a required index?
 * @param {unknown} candidate
 * @param {import('./required-index.js').RequiredIndex} required
 * @returns {boolean}
 */
export function indexSatisfies(candidate, required) {
  if (!candidate || typeof candidate !== 'object') return false;
  const c =
    /** @type {{ collectionGroup?: string, queryScope?: string, fields?: Array<{ fieldPath?: string, order?: string }> }} */ (
      candidate
    );
  if (c.collectionGroup !== required.collectionGroup) return false;
  // Default scope is COLLECTION when omitted.
  if ((c.queryScope ?? 'COLLECTION') !== required.queryScope) return false;
  const candidateFields = stripTrailingName(c.fields ?? []);
  if (candidateFields.length !== required.fields.length) return false;
  return required.fields.every((rf, i) => {
    const cf = candidateFields[i];
    return cf?.fieldPath === rf.fieldPath && cf?.order === rf.order;
  });
}

/**
 * Pretty-print a required index as a ready-to-paste `firestore.indexes.json`
 * entry (2-space indented).
 * @param {import('./required-index.js').RequiredIndex} required
 * @returns {string}
 */
export function formatIndexJson(required) {
  return JSON.stringify(required, null, 2);
}

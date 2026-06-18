/**
 * Subset of a doc's values containing only the keys RHF flagged as dirty.
 * Used to build a Firestore `update()` patch that doesn't clobber untouched
 * fields.
 *
 * Heads up: react-hook-form's `dirtyFields` is a DeepMap (booleans at the
 * leaves), not a value-vs-default diff. A nested object marked dirty means
 * "at least one descendant changed" — we shallow-copy the whole nested
 * value rather than try to compute a deep patch, because Firestore's update
 * semantics merge top-level keys but replace nested objects wholesale.
 */
export function pickDirty<T extends Record<string, unknown>>(
  values: T,
  dirtyFields: Partial<Record<keyof T, unknown>>,
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(dirtyFields) as Array<keyof T>) {
    if (dirtyFields[key]) out[key] = values[key];
  }
  return out;
}

/**
 * `Object.keys(x).length === 0` with a clearer call site. `null`-valued
 * keys count as present (the whole point of the NullClearButton is to
 * persist a null).
 */
export function isEmpty(obj: object): boolean {
  return Object.keys(obj).length === 0;
}

// Structural equality (`deriveOnSave`'s changed-field check) is the canonical
// `valuesEqual` in `@delfrance/core`; re-exported here so `./diff` consumers
// (ObjectView, the ui barrel) keep their import path.
export { valuesEqual } from '@delfrance/core';

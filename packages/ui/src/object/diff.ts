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

/**
 * Structural equality for form/Firestore values: primitives (including
 * `BigInt`, which `JSON.stringify` would throw on), `Date` (by epoch),
 * arrays and plain objects. Used by `deriveOnSave` to decide whether a
 * derived field actually changed — never serializes, so it can't crash on
 * non-JSON values.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b) &&
    !(a instanceof Date) &&
    !(b instanceof Date)
  ) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

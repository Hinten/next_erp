/**
 * Structural equality for plain data values — the canonical, framework-agnostic
 * deep compare used for change detection that must never serialize: the pedido
 * concurrency guard (`@delfrance/data`), the form dirty check (`@delfrance/ui`).
 *
 * Handles primitives (including `BigInt`, which `JSON.stringify` throws on),
 * `Date` (compared by epoch), arrays (positional) and plain objects
 * (key-set + recursive, order-independent). Anything else falls back to `===`.
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

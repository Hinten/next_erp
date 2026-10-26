/**
 * The ONE comparator of JSON values in this app: {@link deepEqual}.
 *
 * The write engine (`core/escrita.ts`) compares what it wrote with what it
 * reads back, and the fixture scanner (`fixtures/piiScan.ts`) compares a body
 * with its own re-redaction. Both decide "is this the same value?" with this
 * function, so the answer cannot drift between two copies.
 *
 * ## What it folds: key ORDER, and nothing else
 *
 *  - equal: objects with the same own keys holding equal values, in any key
 *    order; arrays of equal elements in the same order; the same primitive;
 *  - distinct: arrays in another order, a number and its string (`1` vs `'1'`,
 *    `'10.00'` vs `'10'`), `null` vs an absent key, `''` vs `null`, `{}` vs `[]`,
 *    a code with a trailing space or in another case.
 *
 * ⚠️ Folding MORE is the dangerous direction for both callers: a write read
 * back as "the same" would skip a correction, and a leaked value read as
 * "unchanged" would reach a committed fixture. A wider fold belongs in the
 * caller, named, with its own inventory row
 * (`packages/config-eslint/rules/equivalence-fold-inventory.test.js`).
 *
 * ## A dependency-free leaf, on purpose
 *
 * It imports nothing, so the pure planners and the capture sanitizer can use it
 * without pulling a client, Firestore or a network module into their import
 * closures (`estrutura.test.ts` walks the sanitizer's). Pure and total over
 * JSON values: no clock, no I/O, no environment. Only OWN keys count — a key a
 * value merely inherits is not one of its keys.
 */

const ehObjetoJson = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether `a` and `b` are the same JSON value, key order ignored (module
 * header). Primitives by strict equality: no coercion.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!ehObjetoJson(a) || !ehObjetoJson(b)) return false;
  const chavesA = Object.keys(a);
  if (chavesA.length !== Object.keys(b).length) return false;
  return chavesA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

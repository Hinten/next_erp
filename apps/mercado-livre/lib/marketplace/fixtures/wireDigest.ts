/**
 * A structural digest of an ML response body: every leaf path mapped to the set
 * of JSON types observed there.
 *
 * ## Why not "does our Zod schema still parse it?"
 * Because that assertion **cannot fail**, and shipping it would be worse than
 * shipping nothing. `packages/integrations/mercado-livre/src/types.ts` is
 * pervasively `.passthrough()` with `.nullable().optional()` fields — by design,
 * so ML adding a key never breaks production. The cost of that tolerance is that
 * a schema parse is blind to exactly the drift a wire fixture exists to catch:
 * ML could delete `payments[].date_last_modified` tomorrow and every parse would
 * stay green.
 *
 * So the assertion is the SHAPE, recorded independently of the schemas.
 *
 * ## What a line looks like
 * ```
 * buyer.id: number
 * buyer.nickname: string
 * payments[].date_last_modified: string
 * payments[].date_of_expiration: null|string
 * variations: []
 * ```
 *
 * Three encodings carry most of the value:
 *
 *  - **`null` is its own type**, never folded into the value type. "ML sent
 *    null" and "ML omitted the key" are different facts — the first appears as
 *    `path: null`, the second as no line at all — and telling them apart is the
 *    entire reason these bodies are captured raw.
 *  - **An array contributes `[]` to its path** and its elements' shapes are
 *    UNIONED, so a heterogeneous array is visible rather than sampled. An
 *    **empty** array records as `path: []`, which is how the run's finding that
 *    every User-Products item returns `variations: []` becomes a pinned fact.
 *  - **Types union across occurrences**: `null|string` says ML sends the key
 *    sometimes populated and sometimes not, which is a materially different
 *    contract from `string`.
 */
import type { WireValue } from './redact';

/** JSON types plus the two empty-container markers. */
export type WireTypeName = 'string' | 'number' | 'boolean' | 'null' | '[]' | '{}';

/** Leaf path → every type observed at it. Paths use `[]` for array descent. */
export type WireShape = Map<string, Set<WireTypeName>>;

function add(shape: WireShape, path: string, type: WireTypeName): void {
  const existing = shape.get(path);
  if (existing) existing.add(type);
  else shape.set(path, new Set([type]));
}

function walk(value: WireValue, path: string, shape: WireShape): void {
  if (value === null) {
    add(shape, path, 'null');
    return;
  }
  if (Array.isArray(value)) {
    // An empty array is a FACT, not an absence — see the header.
    if (value.length === 0) {
      add(shape, path, '[]');
      return;
    }
    for (const entry of value) walk(entry, `${path}[]`, shape);
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      add(shape, path, '{}');
      return;
    }
    for (const key of keys) walk(value[key] as WireValue, path ? `${path}.${key}` : key, shape);
    return;
  }
  add(shape, path, typeof value as WireTypeName);
}

/** The shape of one body, as a path → types map. */
export function wireShape(value: WireValue): WireShape {
  const shape: WireShape = new Map();
  walk(value, '', shape);
  return shape;
}

/** Merge shapes — how a census across many fixtures is built. */
export function mergeShapes(shapes: readonly WireShape[]): WireShape {
  const out: WireShape = new Map();
  for (const shape of shapes) {
    for (const [path, types] of shape) for (const type of types) add(out, path, type);
  }
  return out;
}

/**
 * The committed, diffable rendering: one sorted `path: type|type` line each.
 *
 * ⚠️ Sorted and deterministic on purpose. This is what makes a refreshed fixture
 * reviewable — a reviewer reads a handful of changed shape lines instead of
 * diffing seven thousand lines of JSON by eye, which is the review nobody does.
 */
export function renderShape(shape: WireShape): string {
  return [...shape.entries()]
    .map(([path, types]) => `${path || '<root>'}: ${[...types].sort().join('|')}`)
    .sort()
    .join('\n');
}

/** `wireShape` + `renderShape`, the common case. */
export function wireDigest(value: WireValue): string {
  return renderShape(wireShape(value));
}

/** The types observed at `path`, or an empty set when the path never appears. */
export function typesAt(shape: WireShape, path: string): ReadonlySet<WireTypeName> {
  return shape.get(path) ?? new Set<WireTypeName>();
}

/**
 * True when `path` appears in `shape` carrying at least one NON-null type.
 *
 * ⚠️ The non-null qualifier is the point. A field ML always sends as `null` is
 * present in the digest but tells a caller nothing about the value's type, and
 * treating it as "covered" is how a contract assertion goes quietly vacuous.
 */
export function isPopulated(shape: WireShape, path: string): boolean {
  const types = typesAt(shape, path);
  return [...types].some((t) => t !== 'null');
}

/**
 * True when `path` is itself a recorded leaf **or** the prefix of one.
 *
 * ⚠️ This exists because the shape is LEAF-ONLY, and that bites exactly where it
 * matters most. A populated `payments` array contributes `payments[].id`,
 * `payments[].status`, … and **no line at `payments` itself** — so
 * `typesAt(shape, 'payments')` is empty on an order that plainly has payments,
 * and a presence assertion written the obvious way reports the single most
 * important field in the money map as missing. Container presence is a prefix
 * question, never a lookup.
 */
export function hasPathOrDescendants(shape: WireShape, path: string): boolean {
  if (shape.has(path)) return true;
  for (const key of shape.keys()) {
    if (key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) return true;
  }
  return false;
}

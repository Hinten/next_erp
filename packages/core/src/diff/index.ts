import { valuesEqual } from '../equality';

/**
 * Generic document diff — the pure core behind Firestore-trigger
 * modification-history recording (`apps/functions`'s
 * `buildModificationEntry`/`recordModification`).
 *
 * Shallow BY DEFAULT: it reports which top-level fields changed and their
 * old/new values wholesale, mirroring how a Firestore `update()`/`set(...,
 * { merge: true })` patch is shaped (parallel to `@delfrance/ui`'s `pickDirty`,
 * which shallow-copies a whole dirty nested value for the same reason).
 *
 * A caller may opt ONE field at a time into a bounded descent via
 * {@link DiffOptions.expand} — see {@link ExpandSpec}. With no `expand` the
 * output is byte-identical to the shallow-only version this replaced, which is
 * what keeps the produto history (`onProdutoChanged`) unchanged while the
 * pedido history descends into `itens`.
 */
export interface FieldChange {
  old: unknown;
  new: unknown;
}

export interface DocumentDiff {
  kind: 'create' | 'update' | 'delete';
  campos: string[];
  changes: Record<string, FieldChange>;
}

/** Sentinel key marking a `FieldChange` side that was too large to store verbatim. */
export const TRUNCATED_VALUE_KEY = '_truncated';

/** Default ceiling (UTF-8 JSON-encoded bytes) before a field value is truncated. */
export const DEFAULT_MAX_VALUE_BYTES = 40_000;

/**
 * Default per-field cap on expanded changes. Past it the field collapses back
 * to ONE coarse whole-value change — i.e. exactly the shallow behaviour — so
 * the pathological case degrades to the design that shipped before `expand`
 * existed rather than to an unbounded `campos` array.
 */
export const DEFAULT_MAX_EXPANDED_CHANGES = 100;

/** Joins a field name to a descended sub-key: `itens.<itemKey>.<subfield>`. */
export const EXPANDED_KEY_SEPARATOR = '.';

/**
 * Prefix for the positional key an element gets when `identify` cannot name it
 * (returns `null`/empty, or the element is not an object). Deliberately unlike
 * any real id so a synthesized key is recognizable in stored history.
 */
export const POSITIONAL_KEY_PREFIX = '@';

/** Separates a repeated element key from its occurrence ordinal: `#1~2`. */
export const OCCURRENCE_SEPARATOR = '~';

/**
 * How ONE top-level field is descended into. Shape-directed rather than
 * recursive, and depth is fixed per variant: a document here is full of
 * `z.unknown()` / `z.record(z.string(), z.unknown())` passthrough blobs
 * (`itemDoPedido.imposto`, `freteInicial.externalOptionData`), and a
 * depth-limited generic walk would descend into unbounded provider payloads and
 * mint garbage keys. Two variants cover both real shapes and cannot surprise.
 *
 * Either variant falls back to ONE coarse whole-field change — never throws —
 * when the stored value does not match the declared shape (a `null`, a missing
 * field, a corrupt type). So `freteInicial: null -> {...}` is one change, not a
 * per-key explosion.
 */
export type ExpandSpec =
  | {
      /** A flat object: descend exactly one level, into its own keys. */
      kind: 'object';
      /** Sub-keys never worth recording (stamps, denormalizations). */
      ignore?: ReadonlyArray<string>;
    }
  | {
      /** A `Record<groupKey, Element[]>` — e.g. `pedido.itens`. */
      kind: 'mapOfArrays';
      /**
       * Stable id for ONE raw stored element, or `null` to fall back to a
       * positional key. Called for every element of both revisions; the diff is
       * then computed between elements sharing a key, so the id must survive an
       * edit. Elements are visited in a deterministic order (group keys sorted,
       * then array index) and a repeated id gets an occurrence suffix, so an
       * `identify` that returns a constant still produces a stable — if
       * meaningless — pairing rather than a nondeterministic one.
       */
      identify(item: Record<string, unknown>, mapKey: string, index: number): string | null;
      /** Element sub-keys never worth recording. */
      ignore?: ReadonlyArray<string>;
    };

export interface DiffOptions {
  ignore?: ReadonlyArray<string>;
  maxValueBytes?: number;
  /**
   * Opt-in per top-level field. A field absent from this map — or the whole
   * option being absent — takes the shallow path unchanged.
   */
  expand?: Readonly<Record<string, ExpandSpec>>;
  /** Per-field ceiling on expanded changes; see {@link DEFAULT_MAX_EXPANDED_CHANGES}. */
  maxExpandedChanges?: number;
}

// `JSON.stringify` throws on a bare BigInt ("Do not know how to serialize a
// BigInt"); stringify it explicitly instead so a bigint value (e.g. a
// permission bitmask) can still be size-checked and stored.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? String(value) : value;
}

// `null` return means "could not be JSON-serialized" (e.g. a circular
// structure) — narrowed to `TypeError`, the specific error JSON.stringify
// raises for that case, so anything else still propagates.
function jsonByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value, bigintReplacer)).length;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * `undefined` becomes `null` (Firestore/JSON can't carry `undefined`). An
 * oversized or unserializable value (e.g. a circular structure) becomes a
 * truncation sentinel rather than blowing up the history write.
 */
function coerceValue(value: unknown, maxValueBytes: number): unknown {
  if (value === undefined) return null;
  const bytes = jsonByteLength(value);
  if (bytes === null) {
    return { [TRUNCATED_VALUE_KEY]: true, _bytes: -1 };
  }
  if (bytes > maxValueBytes) {
    return { [TRUNCATED_VALUE_KEY]: true, _bytes: bytes };
  }
  return value;
}

/**
 * A value we may descend into: a non-null, non-array, non-Date object. Mirrors
 * `valuesEqual`'s own plain-object test so "structurally equal" and
 * "descendable" can never disagree about what an object is.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Shared per-call knobs, so the expanders don't re-read `opts` for each field. */
interface ExpandContext {
  maxValueBytes: number;
  maxExpandedChanges: number;
}

function positionalKey(mapKey: string, index: number): string {
  return `${POSITIONAL_KEY_PREFIX}${mapKey}[${index}]`;
}

/**
 * Diff two revisions of ONE flat object, one level deep.
 * `null` => could not expand; the caller emits a coarse whole-field change.
 * `{}`   => only ignored sub-keys moved; the field contributes nothing at all.
 */
function expandObject(
  field: string,
  before: unknown,
  after: unknown,
  spec: Extract<ExpandSpec, { kind: 'object' }>,
  ctx: ExpandContext,
): Record<string, FieldChange> | null {
  if (!isPlainRecord(before) || !isPlainRecord(after)) return null;

  const ignore = new Set(spec.ignore ?? []);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of ignore) keys.delete(key);

  const out: Record<string, FieldChange> = {};
  let count = 0;
  for (const key of [...keys].sort()) {
    if (valuesEqual(before[key], after[key])) continue;
    if (++count > ctx.maxExpandedChanges) return null;
    out[`${field}${EXPANDED_KEY_SEPARATOR}${key}`] = {
      old: coerceValue(before[key], ctx.maxValueBytes),
      new: coerceValue(after[key], ctx.maxValueBytes),
    };
  }
  return out;
}

/**
 * Flatten a `Record<groupKey, Element[]>` revision into `elementKey -> element`.
 *
 * ⚠️ Group keys are SORTED before scanning. `Object.keys` order on a map read
 * back from Firestore is wire order, not a contract, and the occurrence suffix
 * below is assigned in scan order — so without the sort a redelivery of the SAME
 * CloudEvent could pair elements differently and write a doc that is no longer
 * content-identical, breaking the deterministic-id idempotency the whole history
 * design rests on.
 *
 * `null` => a group value was not an array; the caller falls back to coarse.
 */
function keyElements(
  map: Record<string, unknown>,
  identify: Extract<ExpandSpec, { kind: 'mapOfArrays' }>['identify'],
): Map<string, unknown> | null {
  const out = new Map<string, unknown>();
  const seen = new Map<string, number>();

  for (const mapKey of Object.keys(map).sort()) {
    const list = map[mapKey];
    if (!Array.isArray(list)) return null;
    list.forEach((item, index) => {
      const named = isPlainRecord(item) ? identify(item, mapKey, index) : null;
      const raw = named != null && named !== '' ? named : positionalKey(mapKey, index);
      const occurrence = seen.get(raw) ?? 0;
      seen.set(raw, occurrence + 1);
      out.set(occurrence === 0 ? raw : `${raw}${OCCURRENCE_SEPARATOR}${occurrence}`, item);
    });
  }
  return out;
}

/**
 * Diff two revisions of a `Record<groupKey, Element[]>` by element identity.
 *
 * An element present on one side only yields ONE whole-element change
 * (`<field>.<key>` = `{old: null, new: element}` or the reverse) rather than a
 * per-sub-field breakdown, which would be noise for a brand-new line and would
 * multiply `campos` by the element's field count. An element present on both
 * yields one change per changed sub-field.
 *
 * A pure reorder inside a group is INVISIBLE by construction: identity does not
 * depend on position, so nothing pairs differently. That is intended — every
 * reader of `pedido.itens` sorts by `ordem`, so a meaningful reorder shows up as
 * an `ordem` change on the elements that moved.
 */
function expandMapOfArrays(
  field: string,
  before: unknown,
  after: unknown,
  spec: Extract<ExpandSpec, { kind: 'mapOfArrays' }>,
  ctx: ExpandContext,
): Record<string, FieldChange> | null {
  if (!isPlainRecord(before) || !isPlainRecord(after)) return null;

  const beforeItems = keyElements(before, spec.identify);
  const afterItems = keyElements(after, spec.identify);
  if (beforeItems === null || afterItems === null) return null;

  const ignore = new Set(spec.ignore ?? []);
  const out: Record<string, FieldChange> = {};
  let count = 0;

  const keys = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].sort();
  for (const key of keys) {
    const prefix = `${field}${EXPANDED_KEY_SEPARATOR}${key}`;
    const beforeItem = beforeItems.get(key);
    const afterItem = afterItems.get(key);

    // Added, removed, or a corrupt element on either side (a bare string inside
    // the array): compare and store the element WHOLE. Descending into a
    // non-object is what would throw, so this is also the safety net.
    if (!isPlainRecord(beforeItem) || !isPlainRecord(afterItem)) {
      if (valuesEqual(beforeItem, afterItem)) continue;
      if (++count > ctx.maxExpandedChanges) return null;
      out[prefix] = {
        old: coerceValue(beforeItem, ctx.maxValueBytes),
        new: coerceValue(afterItem, ctx.maxValueBytes),
      };
      continue;
    }

    const subKeys = new Set([...Object.keys(beforeItem), ...Object.keys(afterItem)]);
    for (const ignored of ignore) subKeys.delete(ignored);
    for (const subKey of [...subKeys].sort()) {
      if (valuesEqual(beforeItem[subKey], afterItem[subKey])) continue;
      if (++count > ctx.maxExpandedChanges) return null;
      out[`${prefix}${EXPANDED_KEY_SEPARATOR}${subKey}`] = {
        old: coerceValue(beforeItem[subKey], ctx.maxValueBytes),
        new: coerceValue(afterItem[subKey], ctx.maxValueBytes),
      };
    }
  }
  return out;
}

/**
 * Diffs two plain-object document snapshots. `before`/`after` undefined signals
 * a create/delete respectively; both undefined, or no changed fields once
 * `opts.ignore` and structural equality are applied, return `null` — callers use
 * that to skip writing a history entry entirely.
 *
 * ⚠️ For an EXPANDED field, `campos` carries BOTH the coarse field name and every
 * fine key, while `changes` carries only the fine keys — so
 * `campos !== Object.keys(changes)`. That asymmetry is deliberate:
 * `array-contains` cannot prefix-scan, so without the coarse entry the query
 * "which entries touched the items at all" would be impossible to express.
 */
export function diffDocumentFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  opts?: DiffOptions,
): DocumentDiff | null {
  if (before === undefined && after === undefined) return null;

  const kind: DocumentDiff['kind'] =
    before === undefined ? 'create' : after === undefined ? 'delete' : 'update';
  const ignore = new Set(opts?.ignore ?? []);
  const maxValueBytes = opts?.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  const ctx: ExpandContext = {
    maxValueBytes,
    maxExpandedChanges: opts?.maxExpandedChanges ?? DEFAULT_MAX_EXPANDED_CHANGES,
  };

  const fields = new Set<string>();
  for (const key of Object.keys(before ?? {})) fields.add(key);
  for (const key of Object.keys(after ?? {})) fields.add(key);
  for (const key of ignore) fields.delete(key);

  const campos: string[] = [];
  const changes: Record<string, FieldChange> = {};
  for (const field of fields) {
    const beforeValue = before?.[field];
    const afterValue = after?.[field];
    if (valuesEqual(beforeValue, afterValue)) continue;

    const spec = opts?.expand?.[field];
    if (spec !== undefined) {
      const expanded =
        spec.kind === 'object'
          ? expandObject(field, beforeValue, afterValue, spec, ctx)
          : expandMapOfArrays(field, beforeValue, afterValue, spec, ctx);
      if (expanded !== null) {
        const expandedKeys = Object.keys(expanded);
        // Everything that moved was an ignored sub-key: the field did not
        // meaningfully change, so it earns no `campos` entry either.
        if (expandedKeys.length === 0) continue;
        campos.push(field, ...expandedKeys);
        Object.assign(changes, expanded);
        continue;
      }
      // `null` — shape mismatch or over the cap. Fall through to coarse.
    }

    campos.push(field);
    changes[field] = {
      old: coerceValue(beforeValue, maxValueBytes),
      new: coerceValue(afterValue, maxValueBytes),
    };
  }

  if (campos.length === 0) return null;
  campos.sort();

  return { kind, campos, changes };
}

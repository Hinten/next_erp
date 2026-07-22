import { valuesEqual } from '../equality';

/**
 * Generic top-level document diff — the pure core behind Firestore-trigger
 * modification-history recording (`apps/functions`'s
 * `buildModificationEntry`/`recordModification`). Deliberately shallow: it
 * reports which top-level fields changed and their old/new values wholesale,
 * mirroring how a Firestore `update()`/`set(..., { merge: true })` patch is
 * shaped — nested diffing is out of scope (parallel to `@delfrance/ui`'s
 * `pickDirty`, which shallow-copies a whole dirty nested value for the same
 * reason).
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
 * Diffs the top-level fields of two plain-object document snapshots.
 * `before`/`after` undefined signals a create/delete respectively; both
 * undefined, or no changed fields once `opts.ignore` and structural equality
 * are applied, return `null` — callers use that to skip writing a history
 * entry entirely.
 */
export function diffDocumentFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  opts?: { ignore?: ReadonlyArray<string>; maxValueBytes?: number },
): DocumentDiff | null {
  if (before === undefined && after === undefined) return null;

  const kind: DocumentDiff['kind'] =
    before === undefined ? 'create' : after === undefined ? 'delete' : 'update';
  const ignore = new Set(opts?.ignore ?? []);
  const maxValueBytes = opts?.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;

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

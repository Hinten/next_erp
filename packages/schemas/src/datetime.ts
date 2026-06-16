import { z } from 'zod';
import { coerceToMicros, coerceToMillis } from '@delfrance/core/datetime';

/**
 * Schema builders for numeric-epoch datetime fields — the project standard for
 * dates/times. See `@delfrance/core/datetime` for the wire-format rationale
 * (plain integer epoch, never a Firebase `Timestamp`) and the two precisions.
 *
 * Both builders:
 *   - validate to a plain `z.number().int()` — no `z.brand`, so `z.infer` and
 *     the react-hook-form generics stay free of casts (the unit lives in the
 *     field name + `@delfrance/core/datetime` helpers, not the type);
 *   - run a tolerant `z.preprocess` that normalizes any legacy shape (ms
 *     number, µs number, ISO string, `Date`) to the target unit. This matters
 *     because `parseSoftRead` returns the raw value on a schema mismatch
 *     (`packages/data/src/zodParse.ts`), so a document written before a backfill
 *     would otherwise reach the UI as a raw ms int / ISO string and render as
 *     1970. The preprocess makes flipping a field to µs safe with zero migrated
 *     data; the backfill then canonicalizes at rest;
 *   - carry `.describe()` JSON (`kind: 'datetime'` + `unit`) so the generic
 *     `TableView` / `ObjectView` render a date picker + localized cell instead
 *     of a bare integer (consumed by `packages/ui/src/schema/derive.ts`).
 *
 * Chain `.nullable().default(null)` for optional fields (preferred over
 * `.optional()` per the repo's Firestore-`undefined` rule); leave the builder
 * bare for a required field. An optional `label` becomes the field's UI label
 * (folded into the describe JSON, since `.describe()` is single-valued).
 */

function describeJson(unit: 'ms' | 'us', label?: string): string {
  return JSON.stringify(
    label !== undefined ? { label, kind: 'datetime', unit } : { kind: 'datetime', unit },
  );
}

/**
 * Tolerant preprocess: pass null/undefined through to the outer
 * nullable/default/required handling; coerce everything else to the target
 * unit. On an unparseable value `coerce` returns null, so we return the raw
 * input and let `z.number().int()` reject it (a clear error on write, a soft
 * log on read) rather than silently nulling data.
 */
function tolerant(coerce: (v: unknown) => number | null) {
  return (v: unknown): unknown => (v == null ? v : (coerce(v) ?? v));
}

/** Milliseconds since epoch. Tolerant read; renders as a date in the UI. */
export function millisSinceEpoch(label?: string) {
  return z
    .preprocess(tolerant(coerceToMillis), z.number().int())
    .describe(describeJson('ms', label));
}

/** Microseconds since epoch. Tolerant read; renders as a date in the UI. */
export function microsSinceEpoch(label?: string) {
  return z
    .preprocess(tolerant(coerceToMicros), z.number().int())
    .describe(describeJson('us', label));
}

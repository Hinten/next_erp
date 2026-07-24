import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

/**
 * Pure helpers for the staging datetime wire-shape sampler
 * (`sample-datetime-shapes.ts`). Kept side-effect-free so they can be unit
 * tested without a live Firestore (see `datetime-shapes.test.ts`).
 *
 * Context (#483 / #155): the validator-whitelist collections all declare their
 * datetime fields through the `millisSinceEpoch()` / `microsSinceEpoch()`
 * codecs (`packages/schemas/src/shared/datetime.ts`), which validate to a plain
 * `z.number().int()` and carry a `.describe()` JSON tag `{ kind: 'datetime',
 * unit }`. So the schema-declared datetime fields are discovered via that tag
 * (and, for completeness, any residual JSON-schema `format: 'date-time'`),
 * NOT by field name. The legacy Flutter app historically wrote ms-since-epoch
 * ints and two ISO-string exceptions (`Cheque.bomPara`, webchat
 * `abertura`/`fechamento`); this module classifies whatever actually sits on a
 * live doc so the wire shape can be confirmed before any validator flip.
 */

/** The unit a codec datetime field is expected to carry on the wire. */
export type DatetimeUnit = 'ms' | 'us';

/** How a schema declares a datetime field's on-the-wire shape. */
export type DeclaredFormat = 'epoch' | 'iso';

export interface DatetimeFieldSpec {
  /** Dotted path to the field within the document shape (arrays use `[]`). */
  path: string;
  /** The leaf key name (last path segment) — used to match runtime values. */
  name: string;
  /** Codec unit for `epoch` fields; `null` for `iso` (`format: 'date-time'`). */
  unit: DatetimeUnit | null;
  format: DeclaredFormat;
}

/** Runtime type observed for a value at a given path on a real document. */
export type ValueShape = 'Timestamp' | 'number' | 'iso-string' | 'string' | 'null' | 'other';

export interface Observation {
  /** Dotted runtime path to the value within the document. */
  path: string;
  /** Leaf key name (last path segment). */
  name: string;
  shape: ValueShape;
  /** A representative raw value (Timestamps are rendered as ISO for logging). */
  example: unknown;
}

/** Field names known to be ISO strings in the legacy wire shape (per #155). */
export const KNOWN_ISO_EXCEPTIONS: ReadonlySet<string> = new Set([
  'bomPara', // Cheque.bomPara — nested in pedido/pagamento data
  'abertura', // webchat (ISO) vs integracao_frete (ms) — shape is per-package
  'fechamento',
]);

// Anchored at both ends so a datetime-*prefixed* free-text value (a date range,
// a "2024-01-15 10:30 promo" note) is NOT misclassified as a datetime. Seconds,
// fractional seconds and the zone offset are optional.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** True for an ISO-8601-ish datetime string (date + time, parseable). */
export function isIsoDateTimeString(value: string): boolean {
  return ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Normalize array indices in a runtime path (`foo[2].bar`) to `foo[].bar`. */
export function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

/** Classify a single runtime value into a wire shape. */
export function classifyValue(value: unknown): ValueShape {
  if (value instanceof Timestamp) return 'Timestamp';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return isIsoDateTimeString(value) ? 'iso-string' : 'string';
  return 'other';
}

type JsonSchema = Record<string, unknown>;

function datetimeTag(node: JsonSchema): DatetimeUnit | null {
  const description = node.description;
  if (typeof description !== 'string') return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(description);
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  })();
  if (parsed !== null && typeof parsed === 'object' && (parsed as JsonSchema).kind === 'datetime') {
    const unit = (parsed as JsonSchema).unit;
    return unit === 'us' ? 'us' : 'ms';
  }
  return null;
}

function walkJsonSchema(
  node: JsonSchema | undefined,
  path: string,
  acc: DatetimeFieldSpec[],
): void {
  if (!node) return;

  // `.nullable()` (and other unions) surface as `anyOf` — recurse each branch.
  const anyOf = node.anyOf as JsonSchema[] | undefined;
  if (anyOf) {
    for (const branch of anyOf) walkJsonSchema(branch, path, acc);
    return;
  }

  const name = path.split('.').pop() ?? path;
  const unit = datetimeTag(node);
  if (unit !== null) {
    acc.push({ path, name, unit, format: 'epoch' });
    return;
  }
  if (node.format === 'date-time') {
    acc.push({ path, name, unit: null, format: 'iso' });
    return;
  }

  if (node.type === 'object' && node.properties) {
    const properties = node.properties as Record<string, JsonSchema>;
    for (const key of Object.keys(properties)) {
      walkJsonSchema(properties[key], path ? `${path}.${key}` : key, acc);
    }
    return;
  }
  if (node.type === 'array' && node.items) {
    walkJsonSchema(node.items as JsonSchema, `${path}[]`, acc);
  }
}

/**
 * Enumerate every schema-declared datetime field (at any depth) for a domain
 * schema, using the same `z.toJSONSchema(..., { io: 'output' })` bridge the
 * rules generator uses so the wire shape matches exactly.
 */
export function datetimeFieldsForSchema(schema: z.ZodTypeAny): DatetimeFieldSpec[] {
  // `reused: 'inline'` expands a subschema object reused by reference so the
  // walk sees its fields inline instead of behind a `$ref` it can't resolve.
  const json = z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'any',
    reused: 'inline',
  }) as JsonSchema;
  // A cyclic schema still forces a `$ref`; the walk can't resolve those, so fail
  // loudly rather than silently under-report the datetime fields.
  if (JSON.stringify(json).includes('"$ref"')) {
    throw new Error(
      'datetimeFieldsForSchema: JSON schema contains a $ref (cyclic reuse); ' +
        'the datetime-field walk does not resolve refs and would under-report.',
    );
  }
  const acc: DatetimeFieldSpec[] = [];
  walkJsonSchema(json, '', acc);
  return acc;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Timestamp)
  );
}

function exampleOf(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  return value;
}

/**
 * Recursively walk one sampled document and record an observation for:
 *   - any `Timestamp` or ISO-datetime string, wherever it sits (these are
 *     unambiguous datetime shapes worth surfacing even on undeclared fields —
 *     this is what catches nested `cheque.bomPara`);
 *   - any value whose leaf key is a declared datetime field or a known ISO
 *     exception (reports its shape whatever it is — number, null, etc.).
 *
 * Plain numbers on undeclared fields are intentionally ignored (a bare number
 * is not evidence of a datetime).
 */
export function collectObservations(
  doc: Record<string, unknown>,
  interestingNames: ReadonlySet<string>,
): Observation[] {
  const out: Observation[] = [];

  const visit = (key: string, value: unknown, path: string): void => {
    if (value instanceof Timestamp) {
      out.push({ path, name: key, shape: 'Timestamp', example: exampleOf(value) });
      return;
    }
    if (typeof value === 'string') {
      if (isIsoDateTimeString(value)) {
        out.push({ path, name: key, shape: 'iso-string', example: value });
      } else if (interestingNames.has(key)) {
        out.push({ path, name: key, shape: 'string', example: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(key, item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childKey, childValue, path ? `${path}.${childKey}` : childKey);
      }
      return;
    }
    if (interestingNames.has(key)) {
      out.push({ path, name: key, shape: classifyValue(value), example: exampleOf(value) });
    }
  };

  for (const [key, value] of Object.entries(doc)) visit(key, value, key);
  return out;
}

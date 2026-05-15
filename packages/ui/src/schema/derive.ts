import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';
import { parseZodDescription } from './describe';
import type { FieldDescriptor, FieldKind } from './types';

interface Unwrapped {
  inner: ZodTypeAny;
  optional: boolean;
  nullable: boolean;
}

interface ZodInternalDef {
  type?: string;
  innerType?: ZodTypeAny;
  checks?: Array<{ _zod?: { def?: { check?: string; format?: string } } }>;
  entries?: Record<string, string | number>;
}

function defOf(t: ZodTypeAny): ZodInternalDef {
  return (t as unknown as { def?: ZodInternalDef }).def ?? {};
}

/** Strip Optional/Nullable/Default wrappers, recording the modifiers. */
function unwrap(type: ZodTypeAny): Unwrapped {
  let cur = type;
  let optional = false;
  let nullable = false;
  // Multiple levels of wrappers are possible (e.g. `.nullable().optional()`).
  for (let i = 0; i < 8; i += 1) {
    const def = defOf(cur);
    if (def.type === 'optional' && def.innerType) {
      optional = true;
      cur = def.innerType;
      continue;
    }
    if (def.type === 'nullable' && def.innerType) {
      nullable = true;
      cur = def.innerType;
      continue;
    }
    if (def.type === 'default' && def.innerType) {
      cur = def.innerType;
      continue;
    }
    break;
  }
  return { inner: cur, optional, nullable };
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function detectStringKind(def: ZodInternalDef): FieldKind {
  // Zod 4 records format-style checks under `check === 'string_format'`
  // with the specific format on `def.format` (e.g. 'email', 'datetime').
  for (const check of def.checks ?? []) {
    const cdef = check?._zod?.def;
    if (!cdef) continue;
    if (cdef.check === 'string_format') {
      if (cdef.format === 'email') return 'email';
      if (cdef.format === 'url') return 'url';
      if (cdef.format === 'datetime' || cdef.format === 'date') return 'date';
    }
  }
  return 'string';
}

function detectKind(inner: ZodTypeAny, override?: string): FieldKind {
  if (override) {
    const valid: FieldKind[] = [
      'string', 'longText', 'email', 'tel', 'url',
      'number', 'integer', 'currency',
      'boolean', 'enum', 'date', 'reference',
      'array', 'object', 'unknown',
    ];
    if ((valid as string[]).includes(override)) return override as FieldKind;
  }
  const def = defOf(inner);
  switch (def.type) {
    case 'string':
      return detectStringKind(def);
    case 'number': {
      // `z.number().int()` lands in checks as { check: 'number_format', format: 'safeint' }.
      const isInt = (def.checks ?? []).some(
        (c) => c?._zod?.def?.check === 'number_format' && c?._zod?.def?.format === 'safeint',
      );
      return isInt ? 'integer' : 'number';
    }
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'enum':
      return 'enum';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function deriveEnumValues(
  inner: ZodTypeAny,
): Array<{ value: string; label: string }> | undefined {
  const def = defOf(inner);
  if (def.type !== 'enum' || !def.entries) return undefined;
  // Optional human-readable labels attached at the schema level via
  // `.meta({ labels: { ... } })`. Without it we fall back to the enum
  // key, which is fine for codes like UF but not for `'0' | '1' | '2'`.
  const labels = (
    inner as { meta?: () => { labels?: Record<string, string> } | undefined }
  ).meta?.()?.labels;
  return Object.entries(def.entries).map(([k, v]) => ({
    value: String(v),
    label: labels?.[String(v)] ?? k,
  }));
}

/**
 * Inspect a Zod object and produce one `FieldDescriptor` per top-level key.
 * Drives both the TableView column list and the ObjectView field renderer.
 *
 * Heads up: returns descriptors in declaration order (Object.keys on the
 * Zod shape preserves insertion order in V8).
 */
export function extractFieldsFromSchema<T extends ZodRawShape>(
  schema: ZodObject<T>,
): FieldDescriptor[] {
  const shape = schema.shape as ZodRawShape;
  const out: FieldDescriptor[] = [];
  for (const key of Object.keys(shape)) {
    const raw = shape[key] as ZodTypeAny;
    const { inner, optional, nullable } = unwrap(raw);
    // Description can live on either the wrapper or the inner type; check
    // the wrapper first since `.describe()` is usually chained last.
    const wrapDesc = parseZodDescription(raw);
    const desc = wrapDesc.label !== undefined ? wrapDesc : parseZodDescription(inner);
    const kind = detectKind(inner, desc.kind);
    out.push({
      key,
      kind,
      optional,
      nullable,
      label: desc.label ?? humanizeKey(key),
      hint: desc.hint,
      enumValues: deriveEnumValues(inner),
      referenceCollection: kind === 'reference' ? desc.collection : undefined,
      zodType: inner,
    });
  }
  return out;
}

/**
 * Build a defaults object for `react-hook-form`'s `defaultValues`. After the
 * schema sweep every nullable field has `.default(null)` baked in, so calling
 * `schema.parse({})` would also work — but consumers (TableView/ObjectView)
 * already have descriptors in hand and want to merge over caller-provided
 * defaults, so deriving from descriptors stays cheap and explicit.
 *
 *  - nullable fields → `null` (RHF treats this as "value present, equal to null")
 *  - boolean → `false`
 *  - text-ish strings → `''` (Mantine inputs reject `undefined` controlled value)
 *  - everything else → left out; required-without-default surfaces a real
 *    validation error at submit, which is the intended behavior.
 */
export function buildEmptyDefaults(
  descriptors: FieldDescriptor[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of descriptors) {
    if (d.nullable) {
      out[d.key] = null;
    } else if (
      d.kind === 'string' ||
      d.kind === 'longText' ||
      d.kind === 'email' ||
      d.kind === 'tel' ||
      d.kind === 'url'
    ) {
      out[d.key] = '';
    } else if (d.kind === 'boolean') {
      out[d.key] = false;
    }
  }
  return out;
}

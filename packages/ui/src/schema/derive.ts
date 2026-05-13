import {
  type ZodObject,
  type ZodRawShape,
  type ZodTypeAny,
  ZodArray,
  ZodBoolean,
  ZodDate,
  ZodDefault,
  ZodEnum,
  ZodNativeEnum,
  ZodNullable,
  ZodNumber,
  ZodObject as ZodObjectClass,
  ZodOptional,
  ZodString,
  ZodUnknown,
} from 'zod';
import { parseZodDescription } from './describe';
import type { FieldDescriptor, FieldKind } from './types';

interface Unwrapped {
  inner: ZodTypeAny;
  optional: boolean;
  nullable: boolean;
}

/** Strip Optional/Nullable/Default wrappers, recording the modifiers. */
function unwrap(type: ZodTypeAny): Unwrapped {
  let cur = type;
  let optional = false;
  let nullable = false;
  // Multiple levels of wrappers are possible (e.g. `.nullable().optional()`).
  for (let i = 0; i < 8; i += 1) {
    if (cur instanceof ZodOptional) {
      optional = true;
      cur = cur._def.innerType as ZodTypeAny;
      continue;
    }
    if (cur instanceof ZodNullable) {
      nullable = true;
      cur = cur._def.innerType as ZodTypeAny;
      continue;
    }
    if (cur instanceof ZodDefault) {
      cur = cur._def.innerType as ZodTypeAny;
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

function detectStringKind(type: ZodString): FieldKind {
  // `_def.checks` is an array of refinement descriptors. Inspect to find
  // the most specific kind we can render.
  const checks = type._def.checks ?? [];
  for (const check of checks) {
    if (check.kind === 'email') return 'email';
    if (check.kind === 'url') return 'url';
    if (check.kind === 'datetime') return 'date';
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
  if (inner instanceof ZodString) return detectStringKind(inner);
  if (inner instanceof ZodNumber) {
    return inner._def.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number';
  }
  if (inner instanceof ZodBoolean) return 'boolean';
  if (inner instanceof ZodDate) return 'date';
  if (inner instanceof ZodEnum) return 'enum';
  if (inner instanceof ZodNativeEnum) return 'enum';
  if (inner instanceof ZodArray) return 'array';
  if (inner instanceof ZodObjectClass) return 'object';
  if (inner instanceof ZodUnknown) return 'unknown';
  return 'unknown';
}

function deriveEnumValues(
  inner: ZodTypeAny,
): Array<{ value: string; label: string }> | undefined {
  if (inner instanceof ZodEnum) {
    const values = inner._def.values as readonly string[];
    return values.map((v) => ({ value: v, label: v }));
  }
  if (inner instanceof ZodNativeEnum) {
    const obj = inner._def.values as Record<string, string | number>;
    // Native enums duplicate forward/reverse mappings for numeric values; we
    // only want the string-keyed forward entries.
    return Object.entries(obj)
      .filter(([k]) => Number.isNaN(Number(k)))
      .map(([, v]) => ({ value: String(v), label: String(v) }));
  }
  return undefined;
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
    const desc =
      parseZodDescription(raw).label !== undefined
        ? parseZodDescription(raw)
        : parseZodDescription(inner);
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

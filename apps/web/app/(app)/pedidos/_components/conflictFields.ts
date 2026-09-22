import type { ZodTypeAny } from 'zod';
import { pedidoSchema } from '@delfrance/schemas';
import { remotelyChangedFields } from '@delfrance/data/pedido';
import { parseZodDescription } from '@delfrance/ui';

/** One field that changed remotely since the editor opened. */
export interface ConflictField {
  field: string;
  label: string;
  /** Objects/arrays we don't render inline (itens, frete, refs) — shown as "alterado". */
  complex: boolean;
  /** The value as the user loaded it. */
  loaded: unknown;
  /** The value currently in Firestore. */
  server: unknown;
  /** True when the pending save would overwrite this remotely-changed field. */
  overwritten: boolean;
}

/**
 * Doc fields whose values are objects/arrays too large to show inline; the modal
 * lists them as "alterado" instead of a loaded-vs-server value.
 */
const COMPLEX_FIELDS = new Set([
  'itens',
  'itensIds',
  'itensDevolvidos',
  'freteInicial',
  'entradasRelacionadas',
  'saidasRelacionadas',
  'chNFeReferenciadas',
]);

function labelFor(schema: ZodTypeAny, field: string): string {
  const shape = (schema as { shape?: Record<string, ZodTypeAny | undefined> }).shape ?? {};
  const zt = shape[field];
  // `.describe()` may be a plain label or a JSON-encoded hint (datetime fields) —
  // parseZodDescription returns the clean label either way.
  return (zt && parseZodDescription(zt).label) || field;
}

/** Build conflict rows for any schema-backed record and an explicit field set. */
export function recordConflictFields(
  schema: ZodTypeAny,
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  fields: ReadonlyArray<string>,
  patch: Record<string, unknown>,
): ConflictField[] {
  return fields.map((field) => ({
    field,
    label: labelFor(schema, field),
    complex:
      COMPLEX_FIELDS.has(field) ||
      isComplexValue(baseline[field]) ||
      isComplexValue(current[field]),
    loaded: baseline[field] ?? null,
    server: current[field] ?? null,
    overwritten: Object.prototype.hasOwnProperty.call(patch, field),
  }));
}

const isComplexValue = (v: unknown): boolean => v !== null && typeof v === 'object';

/**
 * The fields that changed in Firestore since the editor opened — `baseline` (the
 * doc as loaded) vs `current` (the conflicting remote doc from
 * `PedidoConflictError`), via the shared `remotelyChangedFields` (so the UI and
 * the use-case agree on what "changed" means). Each row flags whether the pending
 * save (`patch` = `buildPedidoPatch`) would overwrite it — a real data-loss risk —
 * vs a remote change the user simply isn't touching.
 */
export function conflictFields(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): ConflictField[] {
  return recordConflictFields(
    pedidoSchema,
    baseline,
    current,
    remotelyChangedFields(baseline, current),
    patch,
  );
}

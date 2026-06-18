import type { ZodTypeAny } from 'zod';
import { pedidoSchema } from '@delfrance/schemas';
import { parseZodDescription, valuesEqual } from '@delfrance/ui';

/** One field the user would overwrite, with the server vs the user's value. */
export interface ConflictField {
  field: string;
  label: string;
  /** Objects/arrays we don't render inline (itens, frete, refs) — shown as "alterado". */
  complex: boolean;
  server: unknown;
  mine: unknown;
}

/**
 * Doc fields whose values are objects/arrays too large to show inline; the modal
 * lists them as "alterado" instead of a server-vs-yours value.
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

function labelFor(field: string): string {
  const shape = pedidoSchema.shape as Record<string, ZodTypeAny | undefined>;
  const zt = shape[field];
  // `.describe()` may be a plain label or a JSON-encoded hint (datetime fields) —
  // parseZodDescription returns the clean label either way.
  return (zt && parseZodDescription(zt).label) || field;
}

const isComplexValue = (v: unknown): boolean => v !== null && typeof v === 'object';

/**
 * The fields the pending save (`patch` = `buildPedidoPatch`) would overwrite
 * where the server's CURRENT value (`current` = the conflicting remote doc from
 * `PedidoConflictError`) differs from the user's value. With partial save this is
 * precise: if the user's edits don't overlap what changed remotely, the list is
 * empty — i.e. the optimistic guard tripped but there is no real field conflict.
 *
 * `ultimaModificacao` is excluded (it's the guard field — it always differs, and
 * `buildPedidoPatch` doesn't even include it).
 */
export function conflictFields(
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): ConflictField[] {
  const out: ConflictField[] = [];
  for (const field of Object.keys(patch)) {
    if (field === 'ultimaModificacao') continue;
    const mine = patch[field];
    const server = current[field] ?? null;
    if (valuesEqual(mine, server)) continue;
    out.push({
      field,
      label: labelFor(field),
      complex: COMPLEX_FIELDS.has(field) || isComplexValue(mine) || isComplexValue(server),
      server,
      mine,
    });
  }
  return out;
}

/**
 * Turning "these fields changed underneath you" into rows a human can read.
 *
 * Generalized out of `apps/web`'s pedido editor (`_components/conflictFields.ts`,
 * #824) so every tier-3 conflict in the app describes itself the same way. The
 * pedido version stays as a thin wrapper that supplies the pedido labels and its
 * own complex-field list.
 */
import type { ZodTypeAny } from 'zod';

import { parseZodDescription } from '../schema/describe';

/** One field that changed remotely since the editor opened. */
export interface ConflictField {
  field: string;
  label: string;
  /** Objects/arrays we don't render inline (itens, refs, maps) — shown as "alterado". */
  complex: boolean;
  /** The value as the user loaded it. */
  loaded: unknown;
  /** The value currently in Firestore. */
  server: unknown;
  /** True when the pending save would overwrite this remotely-changed field. */
  overwritten: boolean;
}

const isComplexValue = (v: unknown): boolean => v !== null && typeof v === 'object';

/**
 * Field label from a Zod object shape. `.describe()` may hold a plain label or a
 * JSON-encoded hint (datetime fields); `parseZodDescription` returns the clean
 * label either way, and the raw key is the fallback.
 */
export function labelFromShape(
  shape: Record<string, ZodTypeAny | undefined>,
  field: string,
): string {
  const zt = shape[field];
  return (zt && parseZodDescription(zt).label) || field;
}

export interface BuildConflictFieldsOptions {
  /** Field key → human label. Defaults to the raw key. */
  labelFor?: (field: string) => string;
  /**
   * Keys always rendered as "alterado" regardless of their runtime type — for
   * values that ARE scalars but too long or too opaque to show inline.
   */
  alwaysComplex?: ReadonlySet<string>;
}

/**
 * Build the modal's rows.
 *
 * `changed` is the list of remotely-changed keys — supplied by the caller rather
 * than recomputed here, so the UI and the save path cannot disagree about what
 * "changed" means (the pedido path uses `remotelyChangedFields`, which knows
 * which stamps to ignore).
 *
 * `written` is what the pending save would actually write. A row not in it is a
 * remote change the operator simply is not touching — worth showing, not worth
 * alarming about.
 */
export function buildConflictFields(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  changed: readonly string[],
  written: ReadonlySet<string>,
  options: BuildConflictFieldsOptions = {},
): ConflictField[] {
  const { labelFor, alwaysComplex } = options;
  return changed.map((field) => ({
    field,
    label: labelFor?.(field) ?? field,
    complex:
      alwaysComplex?.has(field) === true ||
      isComplexValue(baseline[field]) ||
      isComplexValue(current[field]),
    loaded: baseline[field] ?? null,
    server: current[field] ?? null,
    overwritten: written.has(field),
  }));
}

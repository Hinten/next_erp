import type { FieldDescriptor } from '../schema/types';

/** Preferred creation-field wire names (first match on the schema wins). */
export const CREATED_AT_CANDIDATES = [
  'timestamp',
  'dataCadastro',
  'dataCriacao',
  'createdAt',
] as const;

/** Preferred last-modified wire names. */
export const MODIFIED_AT_CANDIDATES = ['ultimaModificacao'] as const;

export type StampFieldOverride = string | false | undefined;

export interface ResolvedStampFields {
  /** Creation field to stamp on create (nullish coalesce). `undefined` = none. */
  createdAtField: string | undefined;
  /** Last-modified field to stamp on every main-doc write. `undefined` = none. */
  modifiedAtField: string | undefined;
  /** Wire unit for both stamps, derived from the modified field then create. */
  stampUnit: 'iso' | 'ms' | 'us';
}

function firstPresent(keys: Set<string>, candidates: readonly string[]): string | undefined {
  return candidates.find((k) => keys.has(k));
}

/**
 * Resolve which creation / last-modified fields `saveRecord` should stamp for
 * a given schema, plus the epoch unit for the stamp value.
 *
 * - Prop override `string` forces that key (even if absent from descriptors —
 *   useful when the form values carry the key but descriptors filtered it).
 * - Prop override `false` disables that stamp entirely.
 * - `undefined` auto-detects from descriptor keys using the candidate lists.
 */
export function resolveStampFields(
  descriptors: readonly FieldDescriptor[],
  overrides: {
    createdAtField?: StampFieldOverride;
    modifiedAtField?: StampFieldOverride;
  } = {},
): ResolvedStampFields {
  const keys = new Set(descriptors.map((d) => d.key));

  const createdAtField =
    overrides.createdAtField === false
      ? undefined
      : typeof overrides.createdAtField === 'string'
        ? overrides.createdAtField
        : firstPresent(keys, CREATED_AT_CANDIDATES);

  const modifiedAtField =
    overrides.modifiedAtField === false
      ? undefined
      : typeof overrides.modifiedAtField === 'string'
        ? overrides.modifiedAtField
        : firstPresent(keys, MODIFIED_AT_CANDIDATES);

  const stampDesc =
    (modifiedAtField ? descriptors.find((d) => d.key === modifiedAtField) : undefined) ??
    (createdAtField ? descriptors.find((d) => d.key === createdAtField) : undefined);

  const stampUnit: 'iso' | 'ms' | 'us' =
    stampDesc?.kind === 'datetime' ? (stampDesc.dateUnit ?? 'ms') : 'iso';

  return { createdAtField, modifiedAtField, stampUnit };
}

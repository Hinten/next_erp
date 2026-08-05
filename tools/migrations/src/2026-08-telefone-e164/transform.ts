/**
 * Pure transform for the telefone → E.164 backfill. No Firestore here — see
 * `migrate.ts` for the IO and `tools/migrations/telefone-e164.README.md` for
 * the runbook.
 *
 * Target wire format: digits-only E.164 without the leading `+`
 * (`5511999998888`), the format `@delfrance/core/phone` documents and every
 * lookup in the repo expects. The live Flutter app writes raw 10/11-digit BR
 * numbers, so the collection is mixed today and `telefoneQueryShapes` exists to
 * search both.
 */

import { isValidTelefone, normalizeTelefone } from '@delfrance/core/phone';

/** Why a stored value was left alone. Every skip is logged with its reason. */
export const SKIP_REASON = {
  /** Null, absent, empty, or not a string. Nothing to normalize. */
  empty: 'empty',
  /** Contains `*` — a provider-redacted value. Normalizing would invent digits. */
  masked: 'masked',
  /** `normalizeTelefone` is a no-op: the value is already canonical. */
  alreadyNormalized: 'already-normalized',
  /**
   * Fails `isValidTelefone` after normalization. Writing it would store a value
   * `clienteSchema.telefone`'s refine rejects, so the record would become
   * unsavable from the web form — strictly worse than leaving it alone.
   */
  invalid: 'invalid',
} as const satisfies Record<string, string>;

export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

export type TelefonePlan =
  | { readonly action: 'change'; readonly from: string; readonly to: string }
  | { readonly action: 'skip'; readonly reason: SkipReason; readonly value: unknown };

/**
 * Decide what to do with one stored telefone value.
 *
 * **Idempotent by construction**: a value that is already canonical takes the
 * `already-normalized` branch, so re-running the migration is free. That
 * matters because the legacy Flutter app is a LIVE concurrent writer of the raw
 * shape — a single run does not converge the collection, repeated runs plus
 * the eventual cutover do.
 */
export function planTelefone(stored: unknown): TelefonePlan {
  if (typeof stored !== 'string') {
    return { action: 'skip', reason: SKIP_REASON.empty, value: stored };
  }
  const value = stored.trim();
  if (value === '') {
    return { action: 'skip', reason: SKIP_REASON.empty, value: stored };
  }
  if (value.includes('*')) {
    return { action: 'skip', reason: SKIP_REASON.masked, value: stored };
  }

  const normalized = normalizeTelefone(value);
  if (!isValidTelefone(normalized)) {
    return { action: 'skip', reason: SKIP_REASON.invalid, value: stored };
  }
  if (normalized === stored) {
    return { action: 'skip', reason: SKIP_REASON.alreadyNormalized, value: stored };
  }
  return { action: 'change', from: stored, to: normalized };
}

/**
 * Read a possibly-nested field (`sede.telefone`) out of a document. Returns
 * `undefined` for any missing or non-object segment rather than throwing —
 * these documents predate the schema and are read raw.
 */
export function readNested(data: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = data;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The dotted-path update for one changed field.
 *
 * A DOTTED key, never a nested object: `update()` REPLACES a nested map, so
 * `{ sede: { telefone } }` would wipe every sibling field of `sede`, while
 * `{ 'sede.telefone': … }` touches exactly the one leaf.
 */
export function buildUpdate(path: readonly string[], to: string): Record<string, unknown> {
  return { [path.join('.')]: to };
}

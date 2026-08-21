/**
 * Pure transform for the produto `ultimaModificacao` backfill. No Firestore
 * here — see `migrate.ts` for the IO and
 * `tools/migrations/produto-ultima-modificacao.README.md` for the runbook.
 *
 * ## Why this exists
 *
 * `/produtos` defaults to `orderBy ultimaModificacao desc` (#159), and
 * Firestore `orderBy` **silently skips documents that are MISSING the ordered
 * field**. A stored `null` is fine — the key exists, so the document is
 * indexed and sorts first in ASC / last in DESC. Only an ABSENT key hides a row.
 *
 * The key went absent because `produtoSchema.ultimaModificacao` was
 * `.nullable().optional()` with no `.default(null)`: Zod dropped it whenever a
 * writer did not supply one. #159 changed the declaration, which fixes every
 * FUTURE write; this script repairs the rows already on disk. Known producers:
 * `VariationManager`'s variation children, every e2e/fixture seeder, and every
 * Mercado Livre import before PR #861 (2026-08-06).
 */

/** Why a produto was left alone. Each non-`present` reason reaches the `out/` log. */
export const SKIP_REASON = {
  /** The key already exists (any value, `null` included). Nothing to do. */
  present: 'present',
} as const satisfies Record<string, string>;

export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

export type UltimaModificacaoPlan =
  | { readonly action: 'change'; readonly from: null; readonly to: number }
  | { readonly action: 'skip'; readonly reason: SkipReason; readonly value: unknown };

/**
 * Decide what to do with one produto document.
 *
 * `fallbackMs` is the migration's own clock, passed in rather than read here so
 * the transform stays pure and every document in a run shares one stamp.
 *
 * **Idempotent by construction**: the only write branch requires the key to be
 * ABSENT, and it writes a key — so a second run sees `present` and does
 * nothing. That matters because the legacy app keeps writing the source project
 * until the cutover switches it off: an early run is a rehearsal, and the
 * authoritative run is the one inside the window.
 *
 * ⚠️ `'ultimaModificacao' in data`, never a truthiness or `!= null` test. A
 * produto whose stamp is genuinely `null` is already visible to `orderBy` and
 * must be left alone — overwriting it would move a row the operator never
 * touched to the top of the list.
 *
 * The backfilled value prefers the produto's own `timestamp` (creation), so the
 * repaired rows keep their real relative order instead of collapsing into one
 * indistinguishable block at the migration instant. `timestamp` is millis on
 * produto (`millisSinceEpoch`), the same unit as `ultimaModificacao` — no
 * conversion, and no cross-unit cohort split. Anything non-finite (absent,
 * null, a legacy ISO string that never got normalized on disk) falls back.
 */
export function planUltimaModificacao(
  data: Record<string, unknown>,
  fallbackMs: number,
): UltimaModificacaoPlan {
  if ('ultimaModificacao' in data) {
    return { action: 'skip', reason: SKIP_REASON.present, value: data.ultimaModificacao };
  }
  const timestamp = data.timestamp;
  const to = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : fallbackMs;
  return { action: 'change', from: null, to };
}

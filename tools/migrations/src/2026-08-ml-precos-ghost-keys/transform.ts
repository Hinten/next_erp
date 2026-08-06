/**
 * Pure transform for the `produto.precos` ghost-key cleanup (#803).
 *
 * The legacy Flutter ML price handler keyed its `precos` writes by the tabela's
 * FULL path (`listaDePrecos/<id>`) while every reader — and every other writer —
 * uses the BARE doc id (`.old/packages/produtos/lib/src/models.dart:1479-1484`:
 * `getPrecoPath` normalizes with `.split('/').last`). The write therefore landed
 * on a key nothing reads, and it ran on every `items_prices` notification for
 * years, so production maps carry an accumulated set of unreadable entries.
 *
 * They are inert, not dangerous — this migration is hygiene: it stops the next
 * person from opening a produto and seeing two prices for one lista.
 *
 * ---- What counts as a ghost: a key containing `/`. That is a TOTAL
 * discriminator, not a heuristic — `/` is the one character Firestore forbids in
 * a document id, so a `precos` key containing one cannot be a lista id and can
 * only be a path. No allow-list of collection names needed, and a legacy key
 * written with some other prefix is caught just the same.
 *
 * ---- Keys containing a `.` are SKIPPED, never deleted. The migration addresses
 * entries with a dotted update path (`precos.<key>`), which the SDK splits on
 * `.` before escaping each segment — so a key with a dot in it would silently
 * target the wrong (nested) field. Document ids may legally contain dots, so
 * this is reachable; it is left for manual handling and logged rather than
 * guessed at.
 */

/** One produto's cleanup plan — `deletes` are `precos` map keys, not paths. */
export interface GhostKeyPlan {
  /** Ghost keys safe to remove, in stored order. */
  deletes: string[];
  /** Ghost-shaped keys this migration refuses to address (see module doc). */
  skips: Array<{ key: string; reason: string }>;
}

export const SKIP_DOTTED_KEY =
  'ghost key contains a "." — a dotted update path would target the wrong field; handle manually';

/**
 * Classify one produto's `precos` map. Tolerates every legacy shape: a missing,
 * null, array or scalar `precos` yields an empty plan rather than throwing (this
 * runs over years of Flutter-written documents).
 */
export function planGhostKeys(precos: unknown): GhostKeyPlan {
  const plan: GhostKeyPlan = { deletes: [], skips: [] };
  if (precos == null || typeof precos !== 'object' || Array.isArray(precos)) return plan;
  for (const key of Object.keys(precos as Record<string, unknown>)) {
    if (!key.includes('/')) continue; // a bare lista id — the real entry
    if (key.includes('.')) {
      plan.skips.push({ key, reason: SKIP_DOTTED_KEY });
      continue;
    }
    plan.deletes.push(key);
  }
  return plan;
}

/**
 * The dotted field path for one ghost key. Kept as a named function because the
 * escaping is load-bearing and easy to "simplify" wrongly: the SDK splits this
 * string on `.` and then backtick-quotes any segment that is not
 * `^[_a-zA-Z][_a-zA-Z0-9]*$` (see `@google-cloud/firestore`'s
 * `FieldPath.formattedName`), so the `/` is escaped for us — but only because
 * `planGhostKeys` already excluded keys carrying a `.`.
 */
export function ghostFieldPath(key: string): string {
  return `precos.${key}`;
}

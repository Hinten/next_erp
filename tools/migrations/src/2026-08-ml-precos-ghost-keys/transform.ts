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
 * ---- Addressing them requires a `FieldPath`, never a dotted string. See
 * {@link ghostFieldPath}.
 */
import { FieldPath } from 'firebase-admin/firestore';

/** One produto's cleanup plan — `deletes` are `precos` map keys, not paths. */
export interface GhostKeyPlan {
  /** Ghost keys to remove, in stored order. */
  deletes: string[];
}

/**
 * Classify one produto's `precos` map. Tolerates every legacy shape: a missing,
 * null, array or scalar `precos` yields an empty plan rather than throwing (this
 * runs over years of Flutter-written documents).
 */
export function planGhostKeys(precos: unknown): GhostKeyPlan {
  const plan: GhostKeyPlan = { deletes: [] };
  if (precos == null || typeof precos !== 'object' || Array.isArray(precos)) return plan;
  for (const key of Object.keys(precos as Record<string, unknown>)) {
    // A bare lista id never contains `/`; anything that does is a legacy path.
    if (key.includes('/')) plan.deletes.push(key);
  }
  return plan;
}

/**
 * The field path for one ghost key, as a `FieldPath` — **not** a dotted string,
 * and that is the whole point.
 *
 * The Admin SDK validates every string key of the `update(data)` object form
 * against `/^[^*~/[\]]+$/` and throws on a match ("Paths can't be empty and must
 * not contain \"*~/[]\""). Since EVERY key this migration targets contains `/`
 * by construction, the dotted-string form cannot express a single one of them —
 * it is rejected before the SDK ever splits it. A `FieldPath` carries its
 * segments pre-separated, bypassing that validation, and the serializer
 * backtick-quotes each one: this returns the path rendered as
 * ``precos.`listaDePrecos/L1` ``.
 *
 * The same property is why keys containing `.` need no special handling — the
 * segments are never split, so a dot inside one is just a character.
 */
export function ghostFieldPath(key: string): FieldPath {
  return new FieldPath('precos', key);
}

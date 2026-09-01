/**
 * Reconcile a legacy-model bulk `variations[]` stock patch against the listing
 * Mercado Livre actually holds — **#831**.
 *
 * ---- The rule this module exists for
 *
 * On a legacy (non-User-Products) listing, `PUT /items/{id}` with a `variations`
 * array is **not** a patch: ML **DELETES every variation whose id the array
 * omits**. Its own documentation says so three times over
 * (*Guia para produtos → Variações*, `pt_br/variacoes`):
 *
 *  - §Modificar preço — *"No caso de não enviar todos os IDs das variações,
 *    serão apagadas aquelas que não tenham sido enviadas no momento de fazer o
 *    PUT."*
 *  - §Remover variações — *"Outra forma de remover variações é enviar um PUT
 *    para a API de produtos com a propriedade variations, listando somente os
 *    Ids das variações que quer manter."* Omission **is** the documented removal
 *    mechanism.
 *  - §Modificar estoque — its example PUTs ONE entry against `MLA658778048`, an
 *    item the same page's §Consultar variações shows holding **two**; the
 *    response printed underneath contains only the one that was sent.
 *
 * ⚠️ That last section's PROSE reads as though a partial array were fine. It is
 * contradicted by its own example's response and by the two statements above,
 * and this module is correct under either reading — so do not reopen the
 * ambiguity, and do not "simplify" by trusting the prose.
 *
 * ---- Why the completion cannot live in the planner
 *
 * `buildSendTasks` drops a child on four conditions, two of which are ordinary
 * configuration rather than error states (`kit-virtual`, and
 * `status-nao-enviavel` firing on a member ML ITSELF paused), so a routine sweep
 * tick produces a partial array. Making the planner refuse those would still not
 * be enough: **a variation that exists on ML but has no local
 * `variacaoMercadoLivre` link produces no child row at all** — nothing is
 * skipped, the array looks complete by every local measure, and the PUT deletes
 * it. Only ML's live array can see that case, and the planner is pure by
 * contract (no network). Hence: the executor reads the listing and this module
 * folds the two together.
 *
 * ---- The fold, and where it stops
 *
 * Ids are matched **as strings** — the same fold `idsDasVariacoesVivas`
 * (`../anuncios/variacoesFantasma`) already applies — because ML has sent
 * variation ids as numbers and (rarely) strings over time (`itemVariationSchema`)
 * while our payload declares `z.number().int()`. `15092589430` and
 * `'15092589430'` are therefore the SAME variation; `'123'` and `'1230'` are
 * NOT, and neither are `'01'` and `'1'` — the fold is `String(x)`, never
 * `Number(x)`, so no leading zero or decimal spelling is collapsed.
 *
 * A carried-over entry echoes ML's id **verbatim, in ML's own type**, rather
 * than coercing it to a number: the value is an identifier, and re-typing one is
 * how a listing gets a variation it did not ask for.
 *
 * Output order is **ML's order**, not the payload's — the legacy model ranks
 * variations for display (`.old/…/api.dart:1164` says `//ordem importa`), so
 * echoing the live order is the only shape that cannot reorder the listing.
 *
 * ---- Refusals
 *
 * Every failure returns `ok: false`. The caller must NOT fall back to the
 * partial array: a body that cannot be proven complete is a body that deletes.
 */
import type { MlItem } from '@delfrance/integrations-mercado-livre';

/**
 * One reconciled `variations` entry, ready for the wire.
 *
 * `id` is `number | string` because a carried-over entry echoes ML's own value
 * unchanged; entries taken from our payload are always numeric.
 */
export interface VariacaoReconciliada {
  id: number | string;
  available_quantity: number;
}

/** Why a reconciliation refused to produce a complete array. */
export type ReconciliacaoRecusa =
  /**
   * The listing is not (or is no longer) legacy-model: `family_name` is set, or
   * it reports no `variations[]` at all. Under User Products each variation is
   * its own item and a `variations` body means nothing — the same discriminator
   * `variacoesFantasma`'s prune opens with, mirroring
   * `.old/…/utils/produtos.dart:454`.
   */
  | 'modelo-divergente'
  /**
   * ML reported a live variation with no usable `id`. It cannot be named in the
   * body, so no complete array exists — and sending the rest would delete it.
   */
  | 'variacao-viva-sem-id'
  /**
   * ML reported a live variation we are not updating whose current
   * `available_quantity` is missing or not a whole number ≥ 0. There is nothing
   * safe to carry over: inventing `0` PAUSES the variation (`out_of_stock`), and
   * omitting it deletes it.
   */
  | 'quantidade-viva-ausente';

export type ReconciliacaoResultado =
  | {
      ok: true;
      /** The COMPLETE array — one entry per live variation, in ML's order. */
      variations: VariacaoReconciliada[];
      /**
       * Payload ids ML no longer reports, stringified. These are #707 phantoms:
       * the merge drops them (they are not live, so they belong in no body), and
       * the caller logs them — dropping one silently is what would otherwise
       * keep a stale `variacaoMercadoLivre` link alive forever, since ML can no
       * longer answer `item.variations.invalid` about an id we stopped sending.
       */
      fantasmas: string[];
    }
  | { ok: false; reason: ReconciliacaoRecusa };

/** The stringified id of a live variation, or null when it names none. */
function idVivo(id: number | string | null | undefined): string | null {
  if (id == null) return null;
  const s = String(id);
  return s.length > 0 ? s : null;
}

/**
 * Fold a sweep-computed `variations` patch onto the listing's live array.
 *
 * @param patch The task's `variations` — our new quantities, possibly partial.
 * @param item  The listing as `GET /items/{id}` just reported it.
 */
export function reconciliarVariations(
  patch: readonly { id: number; available_quantity: number }[],
  item: MlItem,
): ReconciliacaoResultado {
  if (item.family_name != null) return { ok: false, reason: 'modelo-divergente' };
  const vivas = item.variations ?? [];
  if (vivas.length === 0) return { ok: false, reason: 'modelo-divergente' };

  const desejado = new Map<string, number>();
  for (const entry of patch) desejado.set(String(entry.id), entry.available_quantity);

  const variations: VariacaoReconciliada[] = [];
  const usados = new Set<string>();
  for (const viva of vivas) {
    const id = idVivo(viva.id);
    if (id == null) return { ok: false, reason: 'variacao-viva-sem-id' };
    usados.add(id);

    const nosso = desejado.get(id);
    if (nosso != null) {
      // ⚠️ `viva.id`, not `id`: echo ML's own value and type. Ours agrees by the
      // fold above, but the stored id is the one that has been round-tripping.
      variations.push({ id: viva.id as number | string, available_quantity: nosso });
      continue;
    }

    const atual = viva.available_quantity;
    if (typeof atual !== 'number' || !Number.isInteger(atual) || atual < 0) {
      return { ok: false, reason: 'quantidade-viva-ausente' };
    }
    variations.push({ id: viva.id as number | string, available_quantity: atual });
  }

  const fantasmas: string[] = [];
  for (const id of desejado.keys()) if (!usados.has(id)) fantasmas.push(id);

  return { ok: true, variations, fantasmas };
}

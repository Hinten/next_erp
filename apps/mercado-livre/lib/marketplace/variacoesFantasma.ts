/**
 * Phantom-variation self-heal for the OLD-model bulk stock send (#707).
 *
 * When a family's `PUT /items/{id}` carries a `variations[]` array naming a
 * variation id ML no longer has, ML refuses the whole call with
 * `error: 'validation_error'` and a `cause[]` entry coded
 * `item.variations.invalid`. Every subsequent rebuild of that payload re-earns
 * the identical rejection, because the stale id lives in a `variacaoMercadoLivre`
 * link doc nothing prunes.
 *
 * The legacy sender fixed this in `removerVariacoesInexistentesMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/utils/produtos.dart:444`),
 * called from the `item.variations.invalid` branch of `functions.dart:409`.
 *
 * ---- Two things it did that this module deliberately keeps:
 *
 *  - **It is legacy-model ONLY.** The Dart opens with
 *    `if (consulta['family_name'] != null) return;` — under User Products there
 *    is no `variations[]` array at all (each member is its own ML item), so the
 *    cause is unreachable there and the diff would be meaningless. The caller
 *    re-states that guard against the live item; {@link planejarPoda} restates
 *    it per member via the `itemId` rung, so a family caught mid-migration
 *    cannot have its UP members pruned by a legacy-shaped comparison.
 *  - **The comparison is by STRING.** Legacy built
 *    `variations.map((e) => e['id'].toString())` and tested `contains`. The
 *    stored id is an int on rows this app writes and can be a stringified one on
 *    Flutter-authored rows (`variacaoLinkHasListing` tolerates both), and ML
 *    itself has sent numeric and string ids over time (`itemVariationSchema`).
 *    Comparing as strings is the only form that matches all three.
 *
 * ---- One thing it did that this module deliberately does NOT: **delete.**
 *
 * Legacy rewrote the child produto's `marketplace` denorm array. In this port
 * that array is documented dead weight with no query consumers, deleted whole at
 * the Flutter decommission (#961/#992) — so the nearest equivalent would be
 * deleting the `variacaoMercadoLivre` link doc, which is a STRONGER action than
 * legacy ever took and destroys the member's `sku` + `attributes` (its ML
 * variation combination), which a republish would have to rebuild from nothing.
 *
 * The link schema carries `status`/`sub_status` since #1142, so the phantom is
 * MARKED instead: `status: 'closed'` is exactly what `podeEnviarEstoque` already
 * gates on, so the next `buildSendTasks` leaves the member out of the payload
 * through the same rung every other unsendable listing takes. It is also
 * cheaper — `variacaoLinkHasListing` ignores `status` on purpose, so a mark hits
 * `variacaoPodeMudarMembership`'s fast path (zero reads, zero writes) where a
 * delete would run one `integracoesComProduto` removal transaction per child.
 *
 * Pure and total: no Firestore, no ML, no clock. The caller
 * (`estoqueSend.registrarRejeicaoFinal`) owns the reads and the writes.
 */
import type { MlItem } from '@delfrance/integrations-mercado-livre';
import type { MlCausa } from '@delfrance/schemas';

/**
 * ML's validation code for "the `variations` you sent do not match this item".
 *
 * A plain const rather than a schema enum: `code` is free text on
 * `mlCausaSchema` (ML publishes no closed vocabulary for it), so there is no
 * companion Zod enum for `delfrance/prefer-schema-enum` to bind to.
 */
export const CAUSA_VARIACOES_INVALIDAS = 'item.variations.invalid';

/**
 * The ML sub-status a pruned member is marked with. ML's own vocabulary for a
 * listing that no longer exists — the same pair `syncItemStatus` would write if
 * ML ever reported the member directly.
 */
export const SUB_STATUS_VARIACAO_REMOVIDA = 'deleted';

/** Does this rejection say our `variations[]` disagreed with the listing? */
export function temCausaVariacoesInvalidas(causas: readonly MlCausa[]): boolean {
  return causas.some((c) => c.code === CAUSA_VARIACOES_INVALIDAS);
}

/**
 * The variation ids ML currently reports for a legacy-model item, as strings.
 *
 * An entry with no id contributes nothing: it cannot match a stored id, and
 * treating it as one would make every stored id look live.
 */
export function idsDasVariacoesVivas(item: MlItem): Set<string> {
  const ids = new Set<string>();
  for (const v of item.variations ?? []) {
    if (v.id == null) continue;
    const id = String(v.id);
    if (id.length > 0) ids.add(id);
  }
  return ids;
}

/** One `variacaoMercadoLivre` link doc, as the caller read it. */
export interface MembroFamilia {
  /** The `variacaoMercadoLivre` doc id. */
  docId: string;
  /** The variation CHILD produto that owns the link. */
  produtoId: string;
  /** The link's raw payload. */
  raw: Record<string, unknown>;
}

/** A member link whose ML variation is gone. */
export interface PodaAlvo extends MembroFamilia {
  /** The stale variation id, stringified — for the log line. */
  variacaoId: string;
}

/** The stored variation id as a string, or null when the row names none. */
function idDaVariacao(raw: Record<string, unknown>): string | null {
  if (typeof raw.id === 'number' && Number.isFinite(raw.id)) return String(raw.id);
  if (typeof raw.id === 'string' && raw.id.length > 0) return raw.id;
  return null;
}

/**
 * Which of this family's member links name a variation ML no longer has.
 *
 * Four rungs, and each one is a case that must NOT be pruned:
 *
 *  - **no id** — never published under the legacy model. Legacy's own
 *    `variationsIds.contains(externalId)` could not match a null either, and
 *    marking it `closed` would latch a member that has yet to be sent at all.
 *  - **carries an `itemId`** — a User-Products member, whose identity is the
 *    item id and not the legacy `variations[]` id. Unreachable behind the
 *    caller's `family_name` guard for a pure family, but a listing caught
 *    mid-migration can hold both shapes, and a legacy-shaped diff must never
 *    speak for a UP member (#1142's rule, one rung lower).
 *  - **id is live** — the ordinary case.
 *  - **already `closed`** — idempotence. A Cloud Tasks retry, or a second
 *    rejection before the next sweep, must write nothing rather than churn
 *    `ultimaModificacao` on every child of the family.
 */
export function planejarPoda(
  membros: readonly MembroFamilia[],
  idsVivos: ReadonlySet<string>,
): PodaAlvo[] {
  const alvos: PodaAlvo[] = [];
  for (const membro of membros) {
    if (typeof membro.raw.itemId === 'string' && membro.raw.itemId.length > 0) continue;
    const variacaoId = idDaVariacao(membro.raw);
    if (variacaoId == null) continue;
    if (idsVivos.has(variacaoId)) continue;
    if (membro.raw.status === 'closed') continue;
    alvos.push({ ...membro, variacaoId });
  }
  return alvos;
}

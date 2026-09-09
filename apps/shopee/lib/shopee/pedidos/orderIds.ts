/**
 * Deterministic ids and line keys for the Shopee order import (#1513, step 5) —
 * pure digests over EXACT preimage strings, so re-importing the same order
 * always lands on the same Firestore document. Mirrors
 * `apps/mercado-livre/lib/marketplace/pedidos/orderIds.ts`, which carries the
 * same reasoning for its own channel.
 *
 * ## ⚠️ The pedido preimage is `${contaId}-${orderSn}` and nothing else
 *
 * Three spellings are on record and only one of them is right:
 *
 *  - `sha256("<contaId>-<order_sn>")` — what the LEGACY Shopee importer used
 *    (`.old`, re-derived in the plan's §2d). **This one.**
 *  - `sha256("<contaId>|shopee|<order_sn>")` — the issue's proposal. Rejected.
 *  - `sha256("shopee<contaId>-<order_sn>")` — Mercado Livre's spelling
 *    (`makePedidoIdMercadoLivre`). Rejected.
 *
 * The reason is not taste. The legacy corpus survives the cutover WITH ITS IDS
 * (root `CLAUDE.md` rule 8): a migrated Shopee pedido already sits at the legacy
 * digest, so a different preimage forks EVERY one of them on its first
 * re-import — two pedidos for one sale, one of them invisible to the operator
 * who is looking at the other. `orderIds.test.ts` pins the digest of a fixture
 * pair character for character, so a "harmless" reformat of the template
 * literal fails there instead of in the migration window.
 *
 * ⚠️ There is no shared `sha256Hex` in `@delfrance/core` (checked). Mercado
 * Livre declares its own the same way, from `node:crypto`; a third copy would be
 * the one to promote, not the second.
 */
import { createHash } from 'node:crypto';
import type { ShopeeOrderItem } from '@delfrance/integrations-shopee';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic `pedidos/{id}` doc id for one Shopee order — the LEGACY
 * preimage `sha256(utf8("${contaId}-${orderSn}"))`, byte for byte.
 *
 * `contaId` is the `integracao` document id (the Shopee conta), NOT the Shopee
 * `shop_id`: two contas may point at one shop over time, and the ERP's owner of
 * a pedido is the conta.
 */
export function makePedidoIdShopee(contaId: string, orderSn: string): string {
  return sha256Hex(`${contaId}-${orderSn}`);
}

/**
 * Deterministic `ensureUniqueId` for one order line embedded in the pedido —
 * `sha256(utf8("${orderSn}-${mktplaceId}-${index}"))`, the legacy
 * `ItemDoPedido.generateUid(orderId, mktplaceId, index)` shape with `order_sn`
 * as the first argument.
 *
 * Race tier 0 (root `CLAUDE.md` rule 7): a push redelivery, the reprocess sweep
 * and the order backfill all re-drive the same payload onto the same string, so
 * the item merge and the per-line incidente doc id are idempotent by
 * construction rather than by a comparison someone has to keep correct.
 *
 * `index` is what disambiguates two lines that would otherwise share the same
 * `(orderSn, mktplaceId)` pair — Shopee splits one listing across lines when a
 * promotion applies to part of the quantity.
 */
export function makeItemEnsureUniqueId(orderSn: string, mktplaceId: string, index: number): string {
  return sha256Hex(`${orderSn}-${mktplaceId}-${index}`);
}

/**
 * The `mktplaceId` stored on an `ItemDoPedido`: the MODEL id when the line sold
 * a variation, else the ITEM id.
 *
 * ⚠️ `model_id: 0` is Shopee's "this item has no variation" — a REAL value, not
 * an absence — so it is compared explicitly and never through truthiness. The
 * legacy looked `0` up as the string `"0"` and matched whatever happened to
 * carry it.
 *
 * ⚠️ NOT `order_item_id`. Shopee documents that one as "presented for orders
 * which contain multiple quantities of the same item" — a per-LINE id (the
 * analogue of Mercado Livre's `element_id`), which can be absent or `0`, and
 * the SG sandbox order sends `order_item_id === item_id`, so it identifies
 * nothing the item id does not. This field names the two values the produto
 * resolution keys on (`variashopee.model_id` → `prodshopee.item_id`), which is
 * what lets an operator reading the incidente bind the line by hand. The line's
 * own identity is already carried by {@link makeItemEnsureUniqueId}'s `index`.
 */
export function mktplaceIdDe(item: Pick<ShopeeOrderItem, 'item_id' | 'model_id'>): string {
  const modelId = item.model_id;
  return String(modelId != null && modelId !== 0 ? modelId : item.item_id);
}

/**
 * The in-memory key for ONE order line's `(item_id, model_id)` pair. Two
 * different jobs share it deliberately, because both must draw the line in the
 * same place:
 *
 *  - matching a `get_escrow_detail` money row to a `get_order_detail` line;
 *  - memoising the produto resolution across the order's lines.
 *
 * ⚠️ **`0` and `null` are DISTINCT here**, unlike in the resolution cascade,
 * which skips its variation rung for both. A Shopee escrow row carrying
 * `model_id: null` is not the same row as one carrying `model_id: 0`, and
 * folding them would let a non-variation line take a missing-field row's money.
 *
 * ⚠️ The separator is what keeps `(12, 3)` and `(1, 23)` apart — an equality key
 * built by concatenation without one is a fold that reports two different lines
 * as the same. `orderIds.test.ts` pins that near-miss.
 */
export function chaveDaLinhaShopee(itemId: number, modelId: number | null | undefined): string {
  return `${itemId}|${modelId ?? 'nulo'}`;
}

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
 * ⚠️ **The PAGAMENTO preimage is a DIFFERENT string** —
 * `integracao/<contaId>-<order_sn>`, with the collection name in front — and
 * that is not an inconsistency to tidy up: it is what the legacy wrote, one
 * document down. See {@link makePagamentoIdShopee}, which spells out why the
 * two (and Mercado Livre's third spelling) each ended up where they are.
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
 * Deterministic `pedidos/{pedidoId}/pagamentos/{id}` doc id — the LEGACY
 * preimage `sha256(utf8("integracao/${contaId}-${orderSn}${sufixo ?? ''}"))`,
 * byte for byte (#1514, step 6, plan W1).
 *
 * ⚠️ **The preimage differs from {@link makePedidoIdShopee}'s AND from Mercado
 * Livre's, and all three differences are load-bearing:**
 *
 *  - the PEDIDO's is `"${contaId}-${orderSn}"`, with **no collection prefix**,
 *    because the legacy Flutter `Pedido.generateUid` took the bare pair;
 *  - Mercado Livre's is `"/documents/integracao/${contaId}-${paymentId}"` — a
 *    **LEADING SLASH** and the literal `documents/`, because that app never
 *    normalised the ref through `pathNoDocuments`;
 *  - the legacy Shopee importer built THIS one from `conta.docId.pathNoDocuments`,
 *    which STRIPS a leading `documents/`, so the preimage starts at the
 *    collection name: `integracao/<contaId>-<order_sn>`.
 *
 * A migrated Shopee pedido already carries its pagamentos at THIS digest (root
 * `CLAUDE.md` rule 8), so a different spelling forks every one of them on the
 * first re-import — a second payment for one sale, and Σ pagante double the
 * nota. On a marketplace `canalDevolveTroco` is false, so that is a hard SEFAZ
 * 865/866 for ever, not a warning. `orderIds.test.ts` pins the digest character
 * for character and asserts the three near-miss spellings UNEQUAL.
 *
 * ⚠️ The legacy also wrote a `-desconto` SIBLING at
 * `sha256("integracao/<contaId>-<order_sn>-desconto")` (the extreme-coupon
 * workaround). Step 6 NEVER writes it, NEVER reads it and NEVER deletes it —
 * it is not one of ours. A NUMERIC suffix from {@link sufixoPagamentoShopee}
 * can never collide with it: the two id spaces are disjoint by construction,
 * because `-desconto` is not `-<n>` for any `n`.
 */
export function makePagamentoIdShopee(contaId: string, orderSn: string, sufixo?: string): string {
  return sha256Hex(`integracao/${contaId}-${orderSn}${sufixo ?? ''}`);
}

/**
 * The suffix for the `indice`-th pagamento of one Shopee order: `0 → undefined`
 * (the PRIMARY, whose preimage and `id` field carry no suffix at all),
 * `n → "-n"`.
 *
 * ⚠️ **ONE producer for BOTH the doc id and the `id` FIELD**, so the two can
 * never disagree about what "the second leg" is spelled like. The transaction
 * decides which stored docs are OURS by recomputing this for every `indice` up
 * to the combined-payment maximum — never by reading the `id` field back, which
 * rides the operator's form through a `...base` spread and is therefore
 * reachable by a human edit.
 */
export function sufixoPagamentoShopee(indice: number): string | undefined {
  return indice === 0 ? undefined : `-${indice}`;
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

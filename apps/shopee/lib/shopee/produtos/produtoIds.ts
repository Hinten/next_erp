/**
 * Deterministic `produtos/{id}` doc ids for the Shopee listing import (#1517,
 * step 9) — pure digests over EXACT preimage strings, so re-importing the same
 * listing always lands on the same document instead of minting a second produto
 * for a catalogue the operator is already looking at.
 *
 * The sibling of `pedidos/orderIds.ts`, and it follows that file's discipline:
 * the helper owns the ALGORITHM, this file owns the PREIMAGES, and
 * `produtoIds.test.ts` pins both digests character for character with the
 * near-misses asserted UNEQUAL.
 *
 * ## ⚠️ There is NO legacy preimage to inherit — and that was checked
 *
 * The legacy Flutter produto id was `sha256(microsecondsSinceEpoch + 20 random
 * characters)` (`.old/packages/backend/database/database_all/lib/src/types.dart:784-792`,
 * VERIFIED): **non-deterministic**, so no migrated produto sits at a digest we
 * could collide with and there is no obligation to reproduce anything. That is
 * the opposite of the pedido/pagamento ids, where the legacy preimage IS the
 * contract (root `CLAUDE.md` rule 8). Step 9 is therefore free to choose — and
 * having chosen, the choice is pinned, because from the first import onwards it
 * is OUR corpus that carries these ids.
 *
 * ## ⚠️ The scope is the CONTA (`integracaoId`), not the Shopee `shop_id`
 *
 * Both spellings were designed out. The shop-scoped one (`shopee|<shopId>|…`,
 * Mercado Livre's `sellerUserId` shape) converges two integrações that point at
 * one shop onto ONE produto per listing; the conta-scoped one forks them. The
 * conta wins because **every other Shopee identity in this repo is already
 * conta-scoped** — the pedido digest is `<contaId>-<order_sn>`, both link docs
 * carry a `conta*OuterRef`, and an arquivo's `externalIds[].integracaoPath` is
 * an `integracao/<id>` — so a second integração for the same shop ALREADY forks
 * the links. A shop-scoped produto id would converge one thing while everything
 * around it stayed forked, which is worse than either arm on its own: the
 * produto would be shared while its `prodshopee` link, its photos' cache
 * entries and its pedidos were not.
 *
 * ⚠️ There is deliberately **no `ESCOPO_ID_PRODUTO_SHOPEE` flip constant**. A
 * constant whose flip forks every produto already imported is not a knob, it is
 * a footgun with a docblock. The near-miss test below pins the difference
 * between the two spellings so the decision is visible, never switchable.
 */
import { sha256Hex } from '@delfrance/data/admin';

/**
 * `produtos/{id}` for a Shopee LISTING (the parent produto):
 * `sha256(utf8("shopee|<integracaoId>|<item_id>"))`.
 *
 * ⚠️ The pipes are load-bearing. Without them `('int-1', 2500139861)` and
 * `('int-12', 500139861)` concatenate to the same preimage and two different
 * listings land on ONE produto — a "harmless" reformat of the template literal
 * fails in `produtoIds.test.ts` rather than in the catalogue.
 *
 * ⚠️ `String(itemId)` is decimal for the whole `wireInt()` range (up to
 * `Number.MAX_SAFE_INTEGER`) — never exponential — so the preimage never grows
 * an `e+`. Pinned by a test, because a float sneaking in here would rewrite the
 * id of the listing it came from.
 */
export function idProdutoPaiShopee(integracaoId: string, itemId: number): string {
  return sha256Hex(`shopee|${integracaoId}|${itemId}`);
}

/**
 * `produtos/{id}` for ONE model (variation) of a listing:
 * `sha256(utf8("<parentProdutoId>|<model_id>"))`.
 *
 * The parent's digest is the scope, so the child inherits the conta scoping
 * without repeating it, and a model id that Shopee reuses across two listings
 * can never collide.
 *
 * ⚠️ The separator is the same rule as the parent's: `('a', 12)` and
 * `('a1', 2)` must not meet.
 */
export function idProdutoFilhoShopee(paiId: string, modelId: number): string {
  return sha256Hex(`${paiId}|${modelId}`);
}

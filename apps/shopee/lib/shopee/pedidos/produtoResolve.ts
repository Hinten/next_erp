/**
 * Produto resolution for ONE Shopee order line (#1513, step 5, plan R3).
 *
 * The cascade, narrowest scope first:
 *
 *  1. `variashopee.model_id == modelId` — the VARIATION link, saved under the
 *     child produto, so the hit is `ref.parent.parent.id`: the document that
 *     owns the stock. **Skipped when `modelId` is `null` or `0`.**
 *  2. `prodshopee.item_id == itemId` — the LISTING link, saved under the parent
 *     (or simple) produto. It BINDS the line only when the line has no
 *     variation; for a variation line it supplies `paiId` and nothing else (see
 *     below). This is also the rung a KIT line resolves on.
 *  3. the SKU rungs, through `resolverProdutoPorSku` in
 *     `@delfrance/data/admin/produtos` — the promoted, channel-neutral stage
 *     Mercado Livre ends on too, so the three guards that decide which produto a
 *     sale moves stock on exist exactly once.
 *  4. `unresolved` — the caller keeps `produtoUid: null` (the `'NONE'` bucket),
 *     which is inert for stock, and records an incidente.
 *
 * ## ⚠️ `model_id: 0` and `null` skip rung 1
 *
 * `0` is Shopee's "this item has no variation" — a REAL value on the wire. The
 * legacy looked it up as the STRING `"0"` and matched whatever happened to carry
 * it. Querying it as a number is no better: `variashopee.model_id` is a REQUIRED
 * int, so a link doc written for a listing whose model id genuinely is `0` (a
 * shape the publish flow does not produce) would bind any line of any listing.
 * Skipping is the only reading that cannot bind the wrong produto.
 *
 * ## ⚠️ Rung 2 does not bind a VARIATION line
 *
 * `prodshopee` sits under the PARENT produto. Binding it for a line that sold a
 * variation whose `variashopee` link is missing would bind a produto that owns
 * no estoque rows for a família de muitos — `aplicarPlano` then creates one at
 * `0 + delta`, negative from nothing, on a live sale. Mercado Livre draws the
 * same line: its parent link answers only a line with no `variation_id`, and a
 * variation line whose child link missed falls through to the SKU rungs with the
 * parent as `paiId`. That is what rung 2 does here for a variation line.
 *
 * ## ⚠️ The conta filter is SERVER-side
 *
 * Both link docs carry their own conta ref, so both group queries filter on it
 * and the composite index is declared in `firestore.indexes.json`. Filtering in
 * memory instead — which is what Mercado Livre's variation rung has to do,
 * because its link has no conta field — would pull EVERY same-`model_id` link
 * doc in the database, and Firestore Enterprise bills data scanned (rule 1).
 *
 * The comparison is exact string equality against the canonical
 * `documents/integracao/<id>` form `outerRefSchema` declares. A link doc stored
 * in the bare `integracao/<id>` form would not match; the schema does not admit
 * that form, and the alternative is the unfiltered scan above.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { toOuterRef } from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  resolverProdutoPorSku,
  type SkuMatchKind,
  type SkuMissKind,
} from '@delfrance/data/admin/produtos';

import { chaveDaLinhaShopee } from './orderIds';

/**
 * The kit arm's two readers live with the line mapping, where the escrow ITEM is
 * already the subject. Re-exported here because the kit arm is part of THIS
 * cascade's contract (rung 2 answers a kit line, and `kit_items` is never
 * exploded) and a caller resolving a line reaches for them next.
 */
export { componentesDoKit, ehKitShopee } from './itens';

/**
 * Which rung answered. Diagnostic for a HIT, but a MISS kind is PERSISTED — it
 * picks the incidente's `subtipo` and wording in `incidentesProduto.ts`, so
 * these strings are not free to rename.
 *
 * The two link rungs are named after the SUBCOLLECTIONS they read, which is what
 * an operator has to go and look at.
 */
export type ShopeeLineMatchKind = 'variashopee' | 'prodshopee' | SkuMatchKind;

/** Why nothing bound. `ambiguous-sku` = the SKU named more than one produto. */
export type ShopeeLineMissKind = SkuMissKind;

/**
 * Discriminated on `produtoId`, so `via: 'variashopee'` can never coexist with a
 * null produto: narrowing on `produtoId != null` gives the caller both halves.
 */
export type ResolvedShopeeLineProduto =
  | { produtoId: string; via: ShopeeLineMatchKind }
  | { produtoId: null; via: ShopeeLineMissKind };

/**
 * The two COMPOSITE collectionGroup indexes the cascade's first two rungs need,
 * declared here so the query and the expectation cannot drift apart.
 *
 * ⚠️ On Firestore Enterprise an undeclared composite does NOT throw and offers
 * no one-click link — it silently full-scans the collection group and is billed
 * by data scanned (root CLAUDE.md rule 1), so deleting either entry from
 * `firestore.indexes.json` fails nothing and shows up only on the invoice.
 * `delfrance/default-query-needs-index` cannot see these: it covers
 * `meta.defaultQuery` / `meta.pickerRecencySort` / TableView queries, never an
 * ad-hoc group query. `produtoResolve.test.ts` is the backstop, and it reads
 * these constants — the SAME objects the `.where()` calls below are built from —
 * against the real file, so renaming a link field breaks both sides together.
 *
 * The ORDER of the fields is part of the index, not decoration: it is the order
 * the equality filters are declared in.
 *
 * DEPLOYING them is migration-window work (#1532); agents never run it.
 */
export const INDICES_COMPOSTOS_SHOPEE = [
  {
    collectionGroup: 'variashopee',
    campos: ['model_id', 'contaVariacaoShopeeOuterRef'],
  },
  {
    collectionGroup: 'prodshopee',
    campos: ['item_id', 'contaProdutoShopeeOuterRef'],
  },
] as const;

const [INDICE_VARIACAO, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

export interface ShopeeLineProdutoQuery {
  /** The `integracao` document id — the Shopee conta that owns the links. */
  readonly integracaoId: string;
  /** `item_list[].item_id` — the LISTING id. */
  readonly itemId: number;
  /** `item_list[].model_id`. `null` OR `0` ⇒ no variation; rung 1 is skipped. */
  readonly modelId: number | null;
  /** `model_sku || item_sku`, VERBATIM. Passed straight through to the SKU rungs. */
  readonly sku: string | null;
}

/**
 * Resolve the ERP produto for one Shopee order line.
 *
 * A miss is not a failure: the pedido is still created and every other
 * `ItemDoPedido` field is still filled from the Shopee payload, since nothing
 * else on the line is derived from the produto. The line lands in the `'NONE'`
 * bucket, moves no stock, and gets an incidente naming the anúncio and the
 * variação separately so an operator can bind it by hand.
 */
export async function resolverProdutoDaLinhaShopee(
  db: Firestore,
  query: ShopeeLineProdutoQuery,
): Promise<ResolvedShopeeLineProduto> {
  const { integracaoId, itemId, modelId, sku } = query;
  const contaRef = toOuterRef(integracaoCollection.docPath({}, integracaoId));

  // (1) The variation link — only when the line actually sold a variation.
  if (modelId != null && modelId !== 0) {
    const snap = await variacaoShopeeLinkCollection
      .groupQuery(db)
      .where(INDICE_VARIACAO.campos[0], '==', modelId)
      .where(INDICE_VARIACAO.campos[1], '==', contaRef)
      .limit(1)
      .get();
    const filhoId = snap.docs[0]?.ref.parent?.parent?.id;
    if (filhoId) return { produtoId: filhoId, via: 'variashopee' };
  }

  // (2) The listing link. Always read — a variation line needs it as `paiId`
  // for the scoped SKU rung even when it must not bind on it.
  const snapItem = await produtoShopeeLinkCollection
    .groupQuery(db)
    .where(INDICE_LISTAGEM.campos[0], '==', itemId)
    .where(INDICE_LISTAGEM.campos[1], '==', contaRef)
    .limit(1)
    .get();
  const paiId = snapItem.docs[0]?.ref.parent?.parent?.id ?? null;
  if (paiId != null && (modelId == null || modelId === 0)) {
    return { produtoId: paiId, via: 'prodshopee' };
  }

  // (3) SKU, narrowest scope first, and (4) the miss. ⚠️ The five rungs and
  // their three guards live in `@delfrance/data/admin/produtos` — do NOT
  // re-implement them here. Every one of those guards fails by binding the
  // WRONG produto rather than none, which nothing reports.
  return resolverProdutoPorSku(db, {
    sku,
    paiId,
    canal: 'shopee',
    // Diagnostic only: the two warnings are operator-facing, and the anúncio +
    // variação are what a human opens in Seller Center.
    contexto: { itemId, modelId },
  });
}

/**
 * A resolver memoised per `(item_id, model_id)` for ONE order.
 *
 * A Shopee order routinely repeats a listing across models, and the memo holds
 * the WHOLE verdict — not just the produto id — so every line of one listing
 * reports the same miss reason instead of "the first one was ambiguous, the
 * second one generic".
 *
 * ⚠️ Sequential by design: the importer maps lines in order. Two concurrent
 * calls for one key would both query — a cost, never a wrong answer.
 */
export function criarResolvedorDeLinhasShopee(
  db: Firestore,
  integracaoId: string,
): {
  resolver(linha: Omit<ShopeeLineProdutoQuery, 'integracaoId'>): Promise<ResolvedShopeeLineProduto>;
  /** Everything resolved so far, keyed by {@link chaveDaLinhaShopee}. */
  resultados(): ReadonlyMap<string, ResolvedShopeeLineProduto>;
} {
  const memo = new Map<string, ResolvedShopeeLineProduto>();
  return {
    async resolver(linha) {
      const chave = chaveDaLinhaShopee(linha.itemId, linha.modelId);
      const emCache = memo.get(chave);
      if (emCache !== undefined) return emCache;
      const resolvido = await resolverProdutoDaLinhaShopee(db, { ...linha, integracaoId });
      memo.set(chave, resolvido);
      return resolvido;
    },
    resultados: () => memo,
  };
}

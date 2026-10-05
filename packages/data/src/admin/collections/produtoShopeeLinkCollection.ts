import { produtoShopeeLinkSchema, variacaoShopeeLinkSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handles for the Shopee listing link docs, stored in the EXACT old
 * Flutter wire shape (`ProdutoShopee` / `VariacaoShopee`, #289) — which is how
 * the migrated corpus carries them. Client-side reads go through the loose
 * pass-through subcollection domains (`subcollections.ts`, leaf names
 * `prodshopee` / `variashopee`); these typed handles exist so server reads and
 * writes cannot drift from that wire format. Doc ids are Firestore auto-ids
 * (the Shopee ids live in the `item_id` / `model_id` FIELDS).
 *
 * Same file/export shape as `produtoMercadoLivreLinkCollection.ts`, and for the
 * same reason root `CLAUDE.md` rule 3 gives: `groupQuery(db)` is what lets the
 * Shopee order import (#1513, step 5) query the collection group without a raw
 * `db.collectionGroup()`, which every app's `no-restricted-syntax` bans.
 *
 * ⚠️ **The link ids are NUMBERS.** `item_id` is `z.number().int().nullable()`
 * and `model_id` is a REQUIRED `z.number().int()`, so a collection-group
 * `where('model_id', '==', …)` must be given a number: `String(modelId)` matches
 * nothing, silently, which is exactly what the legacy Flutter importer did when
 * it looked `model_id: 0` up as `"0"`.
 *
 * ⚠️ Both link docs carry their own conta ref (`contaProdutoShopeeOuterRef` /
 * `contaVariacaoShopeeOuterRef`), so ownership is filtered SERVER-side rather
 * than in memory — unlike the Mercado Livre variation link, which has no conta
 * field. That makes each group query a COMPOSITE, and on Firestore Enterprise a
 * composite that is not declared in `firestore.indexes.json` silently
 * full-scans and is billed by data scanned (rule 1). The two entries are
 * declared: `variashopee (model_id, contaVariacaoShopeeOuterRef)` and
 * `prodshopee (item_id, contaProdutoShopeeOuterRef)`; DEPLOYING them is
 * migration-window work (#1532) and agents never run it.
 */

/** `produtos/{produtoId}/prodshopee` — the listing link. `item_id` is the key. */
export const produtoShopeeLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/prodshopee',
  schema: produtoShopeeLinkSchema,
});

/**
 * `produtos/{childId}/variashopee` — the variation link, saved under the CHILD
 * produto (the one that owns the stock), so a hit's produto is
 * `snap.docs[0].ref.parent.parent.id`.
 */
export const variacaoShopeeLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/variashopee',
  schema: variacaoShopeeLinkSchema,
});

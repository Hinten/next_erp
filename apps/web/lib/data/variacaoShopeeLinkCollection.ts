import { variacaoShopeeLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{childId}/variashopee` subcollection — one doc
 * per (variation child × Shopee listing): that child's MODEL on the listing.
 *
 * Note the doc lives under the **child** produto, not the parent, and names its
 * LISTING through `produtoShopeeOuterRef` (the `prodshopee` doc id). Two
 * listings under one produto are legal, so a model is attributed to its listing
 * through that ref — `varLinksDoAnuncio` from `@delfrance/schemas`, the fold the
 * stock and price planners use — never to its produto.
 *
 * ⚠️ Read per CHILD, by its own path — `variashopee(produtoShopeeOuterRef)` has no
 * declared collection-group index, and on Firestore Enterprise an unindexed
 * group read does not fail — it full-scans and bills the data scanned (root
 * `CLAUDE.md` rule 1). The produto tab reads it one-shot, only for a listing
 * whose "Variações" the operator opened.
 *
 * Read-only here; written server-side by apps/shopee (publish, the import, the
 * model-list sync of the re-verify, the stock and price senders).
 *
 * Rules coverage comes from `PRODUTO_SUBCOLLECTION_NAMES`, so adding this
 * handle needs no ruleset regeneration.
 */
export const variacaoShopeeLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/variashopee',
  schema: variacaoShopeeLinkSchema,
});

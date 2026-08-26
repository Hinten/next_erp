import { variacaoMercadoLivreLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{childId}/variacaoMercadoLivre` subcollection —
 * one doc per (variation child × connected ML account), carrying that
 * variation's identity on the listing.
 *
 * Note the doc lives under the **child** produto, not the parent, and points
 * back at the parent's link doc via `produtoMercadoLivreOuterRef`.
 *
 * ⚠️ The listing editor reads a family's members with ONE collection-group query
 * filtered on `produtoMercadoLivreOuterRef` — the same shape the server's own
 * fold uses, and covered by the declared `variacaoMercadoLivre` COLLECTION_GROUP
 * index. What must never happen is a collection-group read WITHOUT that filter:
 * on Firestore Enterprise an unindexed one does not fail, it silently full-scans
 * and bills the data scanned (root `CLAUDE.md` critical rule 1). The alternative
 * — one subcollection read per variation child — needs no index at all but costs
 * one live listener per child, which is why the indexed single query wins here.
 *
 * Which id is populated tells you the model:
 *  - `id` (numeric) — a legacy variation inside the parent ML item;
 *  - `itemId` (MLB string) — User-Products, where the variation IS its own item.
 *
 * Written server-side by `publishProduto` / `publishUserProduct` and by
 * `importVariations`, plus the UP-migration prune in `importMigration`. ⚠️ NOT
 * by the `items` status webhook — `itemsStatusSync` imports this handle but only
 * ever READS through it; its write-back is to the PARENT link
 * (`produtoMercadoLivreLinkCollection`) and the denorm.
 *
 * Rules coverage comes from `PRODUTO_SUBCOLLECTION_NAMES`, so adding this
 * handle needs no ruleset regeneration.
 */
export const variacaoMercadoLivreLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/variacaoMercadoLivre',
  schema: variacaoMercadoLivreLinkSchema,
});

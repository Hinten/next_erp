import { variacaoMercadoLivreLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{childId}/variacaoMercadoLivre` subcollection —
 * one doc per (variation child × connected ML account), carrying that
 * variation's identity on the listing.
 *
 * Note the doc lives under the **child** produto, not the parent, and points
 * back at the parent's link doc via `produtoMercadoLivreOuterRef`. The listing
 * editor therefore reads one small subcollection per variation child rather
 * than a `collectionGroup` query: on Firestore Enterprise an unindexed
 * collection-group read does not fail, it silently full-scans and bills the
 * data scanned (root `CLAUDE.md` critical rule 1).
 *
 * Which id is populated tells you the model:
 *  - `id` (numeric) — a legacy variation inside the parent ML item;
 *  - `itemId` (MLB string) — User-Products, where the variation IS its own item.
 *
 * Written server-side by `publishProduto` and by the still-running Flutter app;
 * rules coverage comes from `PRODUTO_SUBCOLLECTION_NAMES`, so adding this
 * handle needs no ruleset regeneration.
 */
export const variacaoMercadoLivreLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/variacaoMercadoLivre',
  schema: variacaoMercadoLivreLinkSchema,
});

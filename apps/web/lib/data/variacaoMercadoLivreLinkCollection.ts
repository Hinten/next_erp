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
 * `importVariations`, plus the UP-migration prune in `importMigration`. ⚠️ Since
 * #1142 the `items` status webhook is a writer too, and it is the important one
 * for reading: `applyMemberStatusAndFold` records each member's raw
 * `status`/`sub_status`/`moderacoes` HERE, and the PARENT link carries only the
 * FOLD over them (`upFamilyStatus.ts`). So this subcollection — not the parent —
 * is where a User-Products family's per-variation state actually lives.
 * `reverificarAnuncio` writes the same fields for every member at once.
 *
 * Rules coverage comes from `PRODUTO_SUBCOLLECTION_NAMES`, so adding this
 * handle needs no ruleset regeneration.
 */
export const variacaoMercadoLivreLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/variacaoMercadoLivre',
  schema: variacaoMercadoLivreLinkSchema,
});

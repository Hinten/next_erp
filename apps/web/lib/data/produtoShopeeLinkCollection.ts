import { produtoShopeeLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{id}/prodshopee` link subcollection — one doc
 * per Shopee LISTING of the produto (a conta can hold more than one: a native
 * kit beside the ordinary listing it superseded), in the exact old Flutter wire
 * shape. The produto editor's Shopee tab READS these live (#1529, step 21);
 * every write comes from apps/shopee — the publish route, the import, the
 * stock and price senders, pause/re-list, the re-verify and the listing pushes.
 *
 * ⚠️ Read-only here: the tab never calls `merge()` on it. A client write would
 * race every one of those server writers with no precondition the browser SDK
 * can express (root `CLAUDE.md` rule 7, `apps/web/CLAUDE.md` rule 3).
 *
 * A soft-read hands back the RAW document when the schema does not parse it (a
 * migrated row, a half-written one), so every reader of `data` goes through the
 * total readers of `@delfrance/schemas` (`shopeeLinkLeitura.ts`,
 * `vinculosShopee.ts`), never a field it assumes is typed.
 *
 * Rules coverage comes from the loose marketplace-subcollection domain
 * (`PRODUTO_SUBCOLLECTION_NAMES`), same as `produtoMercadoLivreLinkCollection`.
 */
export const produtoShopeeLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/prodshopee',
  schema: produtoShopeeLinkSchema,
});

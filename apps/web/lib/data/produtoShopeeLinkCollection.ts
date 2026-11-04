import { produtoShopeeLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{id}/prodshopee` link subcollection — one doc
 * per Shopee LISTING of the produto (a conta can hold more than one: a native
 * kit beside the ordinary listing it superseded), in the exact old Flutter wire
 * shape — or a listing DRAFT (#1911: no `item_id` yet, `ehRascunhoShopee`). The
 * produto editor's Shopee tab READS these live (#1529, step 21); every write
 * comes from apps/shopee — the publish route, the import, the stock and price
 * senders, pause/re-list, the re-verify, the listing pushes and, since #1911,
 * the DRAFT route (create / edit / discard), which the tab calls through
 * `useShopeeClient`.
 *
 * ⚠️ Read-only here, drafts included: the tab never calls `merge()` on it — a
 * new draft's id is minted locally (`lib/shopee/rascunho.ts`,
 * `idDeNovoRascunhoShopee`) and the draft route creates the document. A
 * client write would race every one of those server writers with no
 * precondition the browser SDK can express (root `CLAUDE.md` rule 7,
 * `apps/web/CLAUDE.md` rule 3); the draft route's baseline compare is the
 * guard instead.
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

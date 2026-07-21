/**
 * User-Products family sibling resolution (ML→ERP) — issue #521's server-side
 * fan-out. One imported member id → the family's sibling MLB item ids, so
 * `import.ts` can import the whole family from a single request. Mirrors the
 * legacy manual-import UI's expansion
 * (`.old/lib/canaisDeVenda/mercadoLivre/providers/importacao.dart:119-188`,
 * `pesquisarProdutosPorId`), moved server-side and IMPORT-time instead of
 * search-time:
 *  - `GET /sites/{site}/user-products-families/{familyId}` → the family's
 *    member `user_products_ids` (legacy `get_user_product_variations`);
 *  - `GET /users/{sellerId}/items/search?user_product_id=<csv>` → their MLB
 *    item ids (legacy `get_user_product_mlb_id`).
 *
 * Best-effort: any `MercadoLivreError` in either call yields no siblings (the
 * caller falls back to a primary-only import) — same pattern as
 * `importCategoriaChain`. A Firestore/infra failure never originates here
 * (this module is pure ML API IO, no Firestore access) — anything that isn't
 * a `MercadoLivreError` rethrows.
 */
import { type MercadoLivreApi, MercadoLivreError } from '@delfrance/integrations-mercado-livre';

/**
 * Hard cap on how many siblings one fan-out imports per request — a runaway
 * or misclassified family (hundreds of "variations") never floods a single
 * import call. `capped` on the result reports the truncation instead of
 * silently dropping siblings.
 */
export const MAX_FAMILY_SIBLINGS = 60;

export interface FamilySiblingsResult {
  /** Sibling MLB item ids to import (the primary is excluded), capped at `MAX_FAMILY_SIBLINGS`. */
  ids: string[];
  /** True when more siblings were found than the cap allows. */
  capped: boolean;
}

/**
 * Resolve a User-Products family's sibling MLB item ids for `primaryItemId`
 * (the member already being imported by the caller). Deduped; the primary's
 * own id is filtered out of the result even if the family search echoes it
 * back.
 */
export async function resolveFamilySiblingIds(
  deps: { api: MercadoLivreApi },
  familyId: string,
  sellerUserId: number,
  primaryItemId: string,
): Promise<FamilySiblingsResult> {
  try {
    const family = await deps.api.getUserProductFamily(familyId);
    // `user_products_ids`/`results` are schema-defaulted `string[]` (never
    // null/undefined) — only an empty VALUE needs filtering, not the type.
    const userProductIds = family.user_products_ids.filter((id) => id.length > 0);
    if (userProductIds.length === 0) return { ids: [], capped: false };

    const search = await deps.api.searchItemsByUserProduct(sellerUserId, userProductIds);
    const siblingIds = [...new Set(search.results)].filter(
      (id) => id.length > 0 && id !== primaryItemId,
    );
    const capped = siblingIds.length > MAX_FAMILY_SIBLINGS;
    return { ids: capped ? siblingIds.slice(0, MAX_FAMILY_SIBLINGS) : siblingIds, capped };
  } catch (err) {
    if (err instanceof MercadoLivreError) return { ids: [], capped: false }; // best-effort: primary-only import
    throw err;
  }
}

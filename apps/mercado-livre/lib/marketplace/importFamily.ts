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
  /**
   * The ML-API failure that aborted sibling RESOLUTION (best-effort — the
   * caller proceeds primary-only); null on success. Distinguishes "the family
   * really has no siblings" from "we couldn't ask ML about the family".
   */
  resolutionError: string | null;
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
  const all = await resolveFamilyItemIds(deps, familyId, sellerUserId);
  if (all.resolutionError != null) {
    return { ids: [], capped: false, resolutionError: all.resolutionError };
  }
  const siblingIds = all.ids.filter((id) => id !== primaryItemId);
  const capped = siblingIds.length > MAX_FAMILY_SIBLINGS;
  return {
    ids: capped ? siblingIds.slice(0, MAX_FAMILY_SIBLINGS) : siblingIds,
    capped,
    resolutionError: null,
  };
}

/** The full, UNCAPPED membership of a family. */
export interface FamilyItemsResult {
  /** Every MLB item id ML reports for the family, deduped. */
  ids: string[];
  /**
   * The ML-API failure that aborted resolution; null on success. ⚠️ An error
   * and an empty family are NOT interchangeable for a caller that acts on
   * absence — see {@link resolveFamilyItemIds}.
   */
  resolutionError: string | null;
}

/**
 * The family's complete MLB item id set — the same two hops as
 * {@link resolveFamilySiblingIds}, without the primary filter and without the
 * cap.
 *
 * ⚠️ Uncapped **on purpose**, and the two callers want opposite things from it.
 * Import reads membership to ADD work, so truncating is a cost cap: 60 is
 * plenty and the rest can wait. The publish orphan sweep reads it to decide
 * what to CLOSE, and there a truncated (or failed) read is indistinguishable
 * from "these members no longer exist" — it would close live listings. So this
 * returns everything or reports the error, and the sweep refuses to act on
 * anything else.
 */
export async function resolveFamilyItemIds(
  deps: { api: MercadoLivreApi },
  familyId: string,
  sellerUserId: number,
): Promise<FamilyItemsResult> {
  try {
    const family = await deps.api.getUserProductFamily(familyId);
    // `user_products_ids`/`results` are schema-defaulted `string[]` (never
    // null/undefined) — only an empty VALUE needs filtering, not the type.
    const userProductIds = family.user_products_ids.filter((id) => id.length > 0);
    if (userProductIds.length === 0) return { ids: [], resolutionError: null };

    const search = await deps.api.searchItemsByUserProduct(sellerUserId, userProductIds);
    return {
      ids: [...new Set(search.results)].filter((id) => id.length > 0),
      resolutionError: null,
    };
  } catch (err) {
    // Best-effort: SURFACED (not silently identical to an empty family) so the
    // caller can tell "the family has no members" from "we couldn't ask".
    if (err instanceof MercadoLivreError) {
      return { ids: [], resolutionError: err.message };
    }
    throw err;
  }
}

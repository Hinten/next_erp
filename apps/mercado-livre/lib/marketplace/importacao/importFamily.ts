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
  try {
    const userProductIds = await familyUserProductIds(deps, familyId);
    if (userProductIds.length === 0) return { ids: [], capped: false, resolutionError: null };

    // ONE page, deliberately — import wants "enough", and `capped` is how it
    // says the rest can wait. ⚠️ `limit` is what makes that flag reachable at
    // all: without it ML applies its own default page size, so a family bigger
    // than that came back short and `capped` could never go true against a real
    // response. Asking for one MORE than the cap is what detects the overflow.
    const search = await deps.api.searchItemsByUserProduct(sellerUserId, userProductIds, {
      limit: MAX_FAMILY_SIBLINGS + 1,
      offset: 0,
    });
    const siblingIds = [...new Set(search.results)].filter(
      (id) => id.length > 0 && id !== primaryItemId,
    );
    const capped = siblingIds.length > MAX_FAMILY_SIBLINGS;
    return {
      ids: capped ? siblingIds.slice(0, MAX_FAMILY_SIBLINGS) : siblingIds,
      capped,
      resolutionError: null,
    };
  } catch (err) {
    // Best-effort: primary-only import — but SURFACED (not silently identical
    // to an empty family) so the caller can report it on the family block.
    if (err instanceof MercadoLivreError) {
      return { ids: [], capped: false, resolutionError: err.message };
    }
    throw err;
  }
}

/**
 * Hop one of the fan-out: the family's member `user_products_ids`. Shared by
 * both readers below, which differ only in how they resolve those to item ids.
 * Throws `MercadoLivreError` for each caller's own best-effort boundary.
 */
async function familyUserProductIds(
  deps: { api: MercadoLivreApi },
  familyId: string,
): Promise<string[]> {
  const family = await deps.api.getUserProductFamily(familyId);
  // `user_products_ids`/`results` are schema-defaulted `string[]` (never
  // null/undefined) — only an empty VALUE needs filtering, not the type.
  return family.user_products_ids.filter((id) => id.length > 0);
}

/** The full, UNCAPPED membership of a family. */
export interface FamilyItemsResult {
  /** Every MLB item id ML reports for the family, deduped. */
  ids: string[];
  /**
   * The family's own `user_products_ids` — the set {@link ids} was searched
   * under, surfaced so a caller can VERIFY what came back rather than trust it.
   *
   * Costs nothing: `familyUserProductIds` already fetches this on hop one, and
   * it used to be discarded. `sweepRemovedMembers` needs it because the search
   * is the input to a **close**, and every other guard there checks that our
   * view is complete — none checks that ML's answer was not broader than asked.
   *
   * Empty whenever {@link resolutionError} is set: on an error path there is
   * nothing to verify against, and an empty authority must never read as "this
   * item belongs to no family, close it".
   */
  userProductIds: string[];
  /**
   * The ML-API failure that aborted resolution; null on success. ⚠️ An error
   * and an empty family are NOT interchangeable for a caller that acts on
   * absence — see {@link resolveFamilyItemIds}.
   */
  resolutionError: string | null;
}

/** One page of `GET /users/{id}/items/search`. */
export const FAMILY_ITEMS_PAGE_SIZE = 50;

/**
 * Pages read before giving up. 300 items is far past any real family (ML caps a
 * user product at 30 sale conditions), so hitting it means something is wrong
 * with the query, not with the catalogue.
 */
export const MAX_FAMILY_ITEM_PAGES = 6;

/**
 * The family's complete MLB item id set — the same two hops as
 * {@link resolveFamilySiblingIds}, without the primary filter and without the
 * import cap.
 *
 * ⚠️ **Complete or an error, never a silent prefix**, because the two callers
 * want opposite things. Import reads membership to ADD work, so truncating is
 * merely a cost cap: 60 is plenty and the rest can wait. The publish orphan
 * sweep reads it to decide what to CLOSE, and there a truncated read is
 * indistinguishable from "these members no longer exist".
 *
 * That distinction is why this pages explicitly. `GET /users/{id}/items/search`
 * returns ML's first page by default — the endpoint takes `limit`/`offset` and
 * answers with `paging.total`, none of which this function used to send or read.
 * A family larger than one page therefore came back truncated with nothing able
 * to tell, and the sweep's own "a member we just wrote is missing" guard turned
 * that into a permanent, non-deterministic refusal: safe, but silently inert for
 * exactly the big families the sweep exists to tidy.
 *
 * Completeness is asserted two ways, so a missing `paging` cannot fake it: a
 * short page ends the walk, and `paging.total` (when ML sends it) must be
 * reached. Anything else — including the page cap — is a `resolutionError`, the
 * "we couldn't ask" fact the sweep already handles correctly.
 */
export async function resolveFamilyItemIds(
  deps: { api: MercadoLivreApi },
  familyId: string,
  sellerUserId: number,
): Promise<FamilyItemsResult> {
  try {
    const userProductIds = await familyUserProductIds(deps, familyId);
    if (userProductIds.length === 0) return { ids: [], userProductIds: [], resolutionError: null };

    const ids = new Set<string>();
    let total: number | null = null;
    for (let page = 0; page < MAX_FAMILY_ITEM_PAGES; page++) {
      const search = await deps.api.searchItemsByUserProduct(sellerUserId, userProductIds, {
        limit: FAMILY_ITEMS_PAGE_SIZE,
        offset: page * FAMILY_ITEMS_PAGE_SIZE,
      });
      const sizeBefore = ids.size;
      for (const id of search.results) if (id.length > 0) ids.add(id);
      if (typeof search.paging?.total === 'number') total = search.paging.total;

      // A short page is ML saying there is no more; `total` confirms it when
      // present. Either alone is enough to stop, but only their AGREEMENT (or
      // the absence of `total`) lets us call the result complete.
      if (search.results.length < FAMILY_ITEMS_PAGE_SIZE) {
        if (total != null && ids.size < total) {
          return {
            ids: [],
            userProductIds: [],
            resolutionError: `a busca devolveu ${ids.size} de ${total} anúncios da família`,
          };
        }
        return { ids: [...ids], userProductIds, resolutionError: null };
      }
      if (total != null && ids.size >= total)
        return { ids: [...ids], userProductIds, resolutionError: null };
      // A full page that added NOTHING means `offset` is not advancing the
      // window — no more ids are coming, and continuing to the cap would report
      // a truncation that is not one.
      if (ids.size === sizeBefore) return { ids: [...ids], userProductIds, resolutionError: null };
    }

    return {
      ids: [],
      userProductIds: [],
      resolutionError: `família com mais de ${MAX_FAMILY_ITEM_PAGES * FAMILY_ITEMS_PAGE_SIZE} anúncios`,
    };
  } catch (err) {
    // Best-effort: SURFACED (not silently identical to an empty family) so the
    // caller can tell "the family has no members" from "we couldn't ask".
    if (err instanceof MercadoLivreError) {
      return { ids: [], userProductIds: [], resolutionError: err.message };
    }
    throw err;
  }
}

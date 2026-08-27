/**
 * The public Mercado Livre URL of ONE listing, resolved on demand.
 *
 * The produto's ML tab offers a "ver no Mercado Livre" link, ported from the old
 * Flutter screen (`cadastroProdutoMLNew.dart:134-156`). For a LEGACY listing the
 * link doc's `id` is the MLB item and the URL is a pure string transform the
 * browser does itself — this module is never called. For a **User-Products**
 * listing the browser has nothing it can turn into a URL, so the answer comes
 * from ML.
 *
 * ⚠️ **Always resolve to an ITEM, never to a User Product.** ML's three levels
 * are família → user product (`MLBU…`) → item (`MLB…`), and only the last one
 * carries a sale condition: the *User Products* guide defines a UP as "o produto
 * físico que um vendedor possui" and an item as "a publicação que um comprador
 * visualiza… contém as condições de venda (preço, parcelas, etc.)". So
 * `mercadolivre.com.br/up/<MLBU>` names a product and NO offer — when that UP's
 * items are paused or closed the page renders **indisponível**, which is what
 * this module used to hand the operator for a listing that was live and selling.
 * Nothing here builds a `/up/` URL any more, and nothing should: ML annotates its
 * own `POST /items` example with *"O permalink vai redirecionar para o UPP do
 * item"*, so an item permalink reaches the very same User Products Page — with a
 * sale condition selected, and therefore with a buy button.
 *
 * ⚠️ Under User Products `link.id` is `familyId ?? itemId` — NOT reliably a
 * family id. Three writers put an `MLB…` item id there under
 * `isUserProductModel: true`: `publish.ts` and `importUserProduct.ts` both fall
 * back to the item when ML omits `family_id`, and the UPtin takeover
 * (`importMigration.ts`) merges the flag onto an existing link WITHOUT touching
 * its id — so every migrated listing carries the old item id. Hence
 * `isFamilyId` (`core/linkRefs.ts`): the two shapes address different endpoints,
 * and sending an item id to the families one is a 400 (`invalid value for id`),
 * not a 404. ⚠️ The INVERSE — a family id sent to `GET /items/{id}` — answers
 * 404, which callers read as "gone"; see that helper for why it is a refusal.
 *
 * ⚠️ The answer is deliberately NOT persisted on the link doc. ⚠️ The original
 * reason is VOID — it assumed a dual run in which the legacy `Model.save()`, an
 * UNMASKED `set()` over a closed field list
 * (`web_database/lib/src/types.dart:598,626`; `_$ProdutoMercadoLivreToJson` has
 * no catch-all bucket), would wipe any field this app added. There is no dual
 * run (root `CLAUDE.md` rule 8). The decision stands on its own: a persisted URL
 * is a cache that can go stale silently, and resolving costs one request.
 *
 * Cost: ZERO ML requests for a legacy listing, ONE for a User-Products listing
 * whose stored id is an item, THREE for a família (family → item search → item).
 * The família price is deliberate and was ONE before: naming a member costs a
 * search, and asking for a live member is the whole point — see
 * {@link familyItemUrl}.
 */
import {
  type MlItem,
  type MlUserProductFamily,
  type MlUserProductItemsSearch,
  MercadoLivreHttpError,
} from '@delfrance/integrations-mercado-livre';

import { isFamilyId } from '../core/linkRefs';

/** The minimal ML surface a URL resolution needs (injectable for tests). */
export interface AnuncioUrlApi {
  getUserProductFamily(familyId: string): Promise<MlUserProductFamily>;
  searchItemsByUserProduct(
    sellerId: number,
    userProductIds: readonly string[],
    page?: { limit?: number; offset?: number; status?: string },
  ): Promise<MlUserProductItemsSearch>;
  getItem(id: string): Promise<MlItem>;
}

/** The link-doc fields this resolution reads — a raw Admin-SDK payload. */
export interface AnuncioUrlLink {
  id?: unknown;
  isUserProductModel?: unknown;
}

/**
 * The conta carries no ML `user_id`, so a família's members cannot be searched.
 *
 * Its own class rather than a `null` return, because the two mean opposite
 * things to the operator: `null` is "this listing is gone from ML" and the route
 * says so, while this is a connection that never finished identifying itself —
 * reconnecting fixes it, and reporting it as a dead anúncio would send someone
 * hunting for the wrong problem.
 */
export class AnuncioUrlSemUserIdError extends Error {
  constructor() {
    super('Integração sem user_id do Mercado Livre — reconecte a conta.');
    this.name = 'AnuncioUrlSemUserIdError';
  }
}

/**
 * `produto.mercadolivre.com.br/MLB-<digits>` — the legacy product page.
 *
 * ⚠️ Kept byte-identical to `mlbProductUrl` in
 * `apps/web/lib/mercado-livre/listingLinks.ts`, the browser-side copy: the two
 * surfaces must agree on the URL a given listing resolves to. Duplicated rather
 * than shared because the integrations package root is server-only (it holds the
 * OAuth client secret) and `apps/web` cannot import it — the same reason
 * `refMatchesIntegracao` exists twice.
 */
export function mlbProductUrl(itemId: string): string | null {
  const digits = itemId.replace(/\D/g, '');
  return digits ? `https://produto.mercadolivre.com.br/MLB-${digits}` : null;
}

/**
 * A string ML may answer with as null, absent OR empty — all three unusable.
 *
 * The empty case is the one worth a helper: `?? ` alone rejects only null and
 * undefined, so an empty `permalink` would sail through as the answer and the
 * route would reply `200 {"url": ""}`, which a browser opens as the current page.
 */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Where this listing lives on Mercado Livre, or null when there is nothing to
 * link to — never published, or gone from ML.
 *
 * Anything other than a 404 propagates: a 5xx or a dead token is a failure to
 * ANSWER, and reporting it beats handing the operator a URL that 404s.
 */
export async function resolveAnuncioUrl(
  deps: { api: AnuncioUrlApi; sellerUserId: number | null },
  link: AnuncioUrlLink,
): Promise<string | null> {
  const id = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  if (id == null) return null;

  if (link.isUserProductModel !== true) return mlbProductUrl(id);

  return isFamilyId(id) ? familyItemUrl(deps.api, deps.sellerUserId, id) : itemUrl(deps.api, id);
}

/**
 * The buyable page for ONE item.
 *
 * `permalink` is ML's own canonical address for the item and — per the ⚠️ at the
 * top of this file — redirects to that item's UPP under User Products, so this
 * one helper serves both models. {@link mlbProductUrl} is the fallback for an
 * item ML reports without a permalink at all.
 */
async function itemUrl(api: AnuncioUrlApi, id: string): Promise<string | null> {
  try {
    const item = await api.getItem(id);
    return nonEmpty(item.permalink) ?? mlbProductUrl(id);
  } catch (err) {
    // The listing is gone — there is no page to open, and saying so beats a
    // link that lands on a 404.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * A LIVE member's page for a família whose stored id is the family key.
 *
 * The family endpoint answers `user_products_ids` — an unordered list of UPs with
 * no status on it — so the previous "first member" pick was arbitrary twice over:
 * neither necessarily the variação the operator is looking at, nor necessarily
 * one that still has a live item. Resolving through
 * `GET /users/{sellerId}/items/search?user_product_id=<csv>&status=active` fixes
 * both at once: it crosses from the UP level down to the sale-condition level,
 * which is the only level that can be bought, and it asks ML for a member that
 * is actually selling.
 *
 * ⚠️ The unfiltered retry is load-bearing in two different ways. A família whose
 * members are ALL paused has no buyable page, and showing that paused item is
 * honest — a sibling's UP page is not. And this repo cannot exercise ML combining
 * `user_product_id` with `status` (no sandbox, and no lane may hold real ML
 * credentials), so a filtered answer that does not work out must degrade rather
 * than be trusted as "no members".
 *
 * ⚠️ "Does not work out" covers ML REJECTING the combination as well as ML
 * IGNORING it — the filter is best-effort, and the two are indistinguishable from
 * here. Degrading only on an EMPTY result would leave a 400 propagating out of
 * this function, breaking "ver no Mercado Livre" on **every** família: the one
 * outcome this design exists to survive, on the one assumption nothing here can
 * verify. Only a 404 escapes the degrade, because it is data ("no such seller or
 * família") the caller acts on, and re-asking unfiltered would just cost a second
 * request to learn the same thing.
 *
 * `limit: 1` because this is a link, not a membership audit — contrast
 * `resolveFamilyItemIds`, which pages the COMPLETE membership because the publish
 * orphan sweep decides what to close from it.
 */
async function familyItemUrl(
  api: AnuncioUrlApi,
  sellerUserId: number | null,
  familyId: string,
): Promise<string | null> {
  if (sellerUserId == null) throw new AnuncioUrlSemUserIdError();

  let userProductIds: string[];
  try {
    const family = await api.getUserProductFamily(familyId);
    // `user_products_ids` is a schema-defaulted `string[]` — only an empty VALUE
    // needs filtering, not the type.
    userProductIds = family.user_products_ids.filter((u) => u.length > 0);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
  if (userProductIds.length === 0) return null;

  const primeiroItem = async (status?: string): Promise<string | null> => {
    const search = await api.searchItemsByUserProduct(sellerUserId, userProductIds, {
      limit: 1,
      offset: 0,
      ...(status != null ? { status } : {}),
    });
    return search.results.find((r) => r.length > 0) ?? null;
  };

  /**
   * The `status=active` attempt, reporting "found nothing" for any ML failure but
   * a 404 — the ⚠️ above is the whole reason this wrapper exists rather than one
   * `try` around both calls.
   */
  const primeiroItemAtivo = async (): Promise<string | null> => {
    try {
      return await primeiroItem('active');
    } catch (err) {
      if (err instanceof MercadoLivreHttpError && err.status !== 404) return null;
      throw err;
    }
  };

  let itemId: string | null;
  try {
    itemId = (await primeiroItemAtivo()) ?? (await primeiroItem());
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
  if (itemId == null) return null;

  return itemUrl(api, itemId);
}

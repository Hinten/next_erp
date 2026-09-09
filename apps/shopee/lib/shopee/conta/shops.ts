/**
 * The TOKEN-FREE connection oracle.
 *
 * `v2.public.get_shops_by_partner` is PUBLIC-signed — the base string carries no
 * access token — so it answers even when the stored token has long lapsed. That
 * is what lets the conta screen tell "the seller revoked the authorization" from
 * "the 4-hour access token expired", which are two completely different things
 * an operator has to do something different about.
 *
 * ⚠️ The legacy Flutter app could not tell them apart: it rendered "Conectado"
 * from the 4-hour access-token expiry and never read the 7–365-day authorization
 * expiry at all.
 *
 * ⚠️ `expire_time` / `auth_time` arrive in SECONDS and leave here in
 * MILLISECONDS. That conversion happens once, in this module, so nothing
 * downstream compares across units (root CLAUDE.md rule 7).
 */
import type { ShopeePartnerClient } from '@delfrance/integrations-shopee';

/** Shopee's own maximum for this endpoint. */
export const SHOPS_PAGE_SIZE = 100;

/**
 * How many pages to walk before giving up.
 *
 * ⚠️ A cap rather than "loop while `more`". A provider bug that returns
 * `more: true` forever would otherwise spin this route until the platform kills
 * it, at one Shopee call per iteration. 20 × 100 = 2 000 authorized shops, which
 * is orders of magnitude past a BR local seller's partner account.
 */
export const MAX_SHOPS_PAGES = 20;

export interface AuthorizedShop {
  readonly shopId: number;
  /** Milliseconds — when the seller granted the authorization. */
  readonly authTime: number;
  /** Milliseconds — when the AUTHORIZATION lapses, not the access token. */
  readonly expireTime: number;
  readonly region: string | null;
}

const SECONDS_TO_MS = 1000;

/**
 * One `authed_shop_list` row, in OUR units. The single place the seconds→ms
 * conversion happens, so the two walks below cannot disagree about it.
 */
function paraLojaAutorizada(shop: {
  shop_id: number;
  auth_time: number;
  expire_time: number;
  region: string | null;
}): AuthorizedShop {
  return {
    shopId: shop.shop_id,
    authTime: shop.auth_time * SECONDS_TO_MS,
    expireTime: shop.expire_time * SECONDS_TO_MS,
    region: shop.region,
  };
}

/** Every shop this partner is authorized on, plus how the walk ended. */
export interface LojasAutorizadas {
  readonly lojas: readonly AuthorizedShop[];
  /** Pages actually fetched — one Shopee call each. */
  readonly paginas: number;
  /**
   * The walk stopped at the page cap with `more` still true, so `lojas` is a
   * PREFIX of the partner's shops rather than all of them.
   *
   * ⚠️ Load-bearing for the caller: the authorization-expiry sweep would
   * otherwise report "no shop needs attention" about shops it never looked at.
   */
  readonly truncado: boolean;
}

/**
 * Enumerate every shop that authorized this partner.
 *
 * The other half of the oracle: {@link findAuthorizedShop} answers about ONE
 * shop and stops early, this walks the whole list because the weekly
 * authorization-expiry sweep has no shop id to look for — the list IS its input.
 *
 * ⚠️ **Deduplicated by `shop_id` across pages, first sighting wins.** Shopee
 * pages a live list, so a shop can legitimately appear twice when the underlying
 * order shifts between two calls; two sightings of one shop must not become two
 * avisos. The first sighting wins because a repeat can only differ in an
 * `expire_time` that moved mid-walk, and the aviso row is idempotent — the next
 * run collapses onto the same document and refreshes `params.dias`.
 */
export async function listarLojasAutorizadas(
  client: ShopeePartnerClient,
  options: { maxPages?: number } = {},
): Promise<LojasAutorizadas> {
  const maxPages = options.maxPages ?? MAX_SHOPS_PAGES;
  const porShopId = new Map<number, AuthorizedShop>();
  let paginas = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await client.getShopsByPartner({ pageSize: SHOPS_PAGE_SIZE, pageNo });
    paginas += 1;
    for (const shop of page.authed_shop_list) {
      if (!porShopId.has(shop.shop_id)) porShopId.set(shop.shop_id, paraLojaAutorizada(shop));
    }
    if (!page.more) {
      return { lojas: [...porShopId.values()], paginas, truncado: false };
    }
  }

  // Same reasoning as `findAuthorizedShop`: the cap is a guard against a
  // provider bug returning `more: true` forever, and hitting it is NOT proof
  // that the list ended. The caller carries `truncado` into its own log.
  console.warn(
    '[shopee/shops] limite de páginas atingido em get_shops_by_partner; enumeração incompleta',
    { paginas, pageSize: SHOPS_PAGE_SIZE, lojas: porShopId.size },
  );
  return { lojas: [...porShopId.values()], paginas, truncado: true };
}

/**
 * Find `shopId` among the shops that authorized this partner.
 *
 * `null` means the shop is not (or no longer) authorized — a revoked or expired
 * authorization. It is the negative half of the oracle and is a normal answer,
 * never an error.
 */
export async function findAuthorizedShop(
  client: ShopeePartnerClient,
  shopId: number,
): Promise<AuthorizedShop | null> {
  for (let pageNo = 1; pageNo <= MAX_SHOPS_PAGES; pageNo += 1) {
    const page = await client.getShopsByPartner({ pageSize: SHOPS_PAGE_SIZE, pageNo });
    const found = page.authed_shop_list.find((shop) => shop.shop_id === shopId);
    if (found) return paraLojaAutorizada(found);
    if (!page.more) return null;
  }

  // Reaching the cap is not proof of absence, and saying so matters: the caller
  // renders `null` as "not connected", which for a shop sitting on page 21 would
  // be a lie. A log line is the only place that distinction can survive.
  console.warn(
    '[shopee/shops] limite de páginas atingido em get_shops_by_partner; loja não localizada',
    { shopId, paginas: MAX_SHOPS_PAGES, pageSize: SHOPS_PAGE_SIZE },
  );
  return null;
}

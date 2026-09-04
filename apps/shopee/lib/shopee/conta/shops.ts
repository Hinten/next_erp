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
    if (found) {
      return {
        shopId: found.shop_id,
        authTime: found.auth_time * SECONDS_TO_MS,
        expireTime: found.expire_time * SECONDS_TO_MS,
        region: found.region,
      };
    }
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

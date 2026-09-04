import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopeePartnerClient, ShopeeShopsByPartner } from '@delfrance/integrations-shopee';

import { MAX_SHOPS_PAGES, SHOPS_PAGE_SIZE, findAuthorizedShop } from './shops';

/** One `authed_shop_list` row, with the SECONDS the wire actually carries. */
function shop(shopId: number) {
  return {
    shop_id: shopId,
    // 2023-11-14T22:13:20Z and thirty days later, in seconds.
    auth_time: 1_700_000_000,
    expire_time: 1_702_592_000,
    region: 'BR',
    sip_affi_shop_list: null,
  };
}

function page(shops: readonly number[], more: boolean): ShopeeShopsByPartner {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning: null,
    authed_shop_list: shops.map(shop),
    more,
  } as ShopeeShopsByPartner;
}

const getShopsByPartner = vi.fn();
const client = { getShopsByPartner } as unknown as ShopeePartnerClient;

let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  spyWarn.mockRestore();
});

describe('findAuthorizedShop', () => {
  it('finds the shop on the first page and converts SECONDS to MILLISECONDS', async () => {
    // ⚠️ The conversion happens here and nowhere else. A cross-unit comparison
    // downstream is a guard that never fires (rule 7).
    getShopsByPartner.mockResolvedValue(page([111], false));

    await expect(findAuthorizedShop(client, 111)).resolves.toEqual({
      shopId: 111,
      authTime: 1_700_000_000_000,
      expireTime: 1_702_592_000_000,
      region: 'BR',
    });
    expect(getShopsByPartner).toHaveBeenCalledWith({ pageSize: SHOPS_PAGE_SIZE, pageNo: 1 });
  });

  it('paginates while `more` is true and finds the shop on page 3', async () => {
    getShopsByPartner
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3, 4], true))
      .mockResolvedValueOnce(page([5, 111], true));

    await expect(findAuthorizedShop(client, 111)).resolves.toMatchObject({ shopId: 111 });
    expect(getShopsByPartner).toHaveBeenCalledTimes(3);
    expect(getShopsByPartner).toHaveBeenNthCalledWith(3, {
      pageSize: SHOPS_PAGE_SIZE,
      pageNo: 3,
    });
  });

  it('returns null — the revoked/expired verdict — when the shop is absent', async () => {
    getShopsByPartner.mockResolvedValue(page([1, 2], false));
    await expect(findAuthorizedShop(client, 111)).resolves.toBeNull();
    expect(getShopsByPartner).toHaveBeenCalledTimes(1);
  });

  it('stops at the page cap when `more` never turns false', async () => {
    // A provider bug returning `more: true` forever would otherwise spin this
    // route until the platform kills it, at one Shopee call per iteration.
    getShopsByPartner.mockResolvedValue(page([1], true));

    await expect(findAuthorizedShop(client, 111)).resolves.toBeNull();
    expect(getShopsByPartner).toHaveBeenCalledTimes(MAX_SHOPS_PAGES);
    // Hitting the cap is NOT proof of absence, and the caller renders `null` as
    // "not connected" — the log line is the only place that distinction lives.
    expect(spyWarn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the walk ended because `more` was false', async () => {
    getShopsByPartner.mockResolvedValue(page([1], false));
    await findAuthorizedShop(client, 111);
    expect(spyWarn).not.toHaveBeenCalled();
  });
});

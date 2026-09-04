import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ShopeeClientConfig,
  type ShopeePartnerConfig,
  createShopeeClient,
  createShopeePartnerClient,
} from '../src/api';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeRateLimitError,
  ShopeeSchemaError,
} from '../src/errors';
import { resolveShopeeHosts } from '../src/hosts';

/** ⚠️ Invented. Never a real Shopee partner key. */
const TEST_PARTNER_KEY = 'chave-de-teste-nao-e-credencial';
const TEST_PARTNER_ID = 1000001;
const TEST_SHOP_ID = 987654;
const NOW_MS = 1_767_000_000_000;

const hosts = resolveShopeeHosts({ sandbox: true });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function partnerConfig(
  fetchImpl: typeof globalThis.fetch,
  extra: Partial<ShopeePartnerConfig> = {},
): ShopeePartnerConfig {
  return {
    partnerId: TEST_PARTNER_ID,
    partnerKey: TEST_PARTNER_KEY,
    hosts,
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...extra,
  };
}

function shopConfig(
  fetchImpl: typeof globalThis.fetch,
  getAccessToken: () => Promise<string> = () => Promise.resolve('access-inventado'),
): ShopeeClientConfig {
  return { ...partnerConfig(fetchImpl), shopId: TEST_SHOP_ID, getAccessToken };
}

const SHOP_INFO_BODY = {
  request_id: 'req-shop',
  error: '',
  shop_name: 'Loja de teste',
  region: 'BR',
  status: 'NORMAL',
  is_cb: false,
  auth_time: 1_760_000_000,
  expire_time: 1_790_000_000,
};

const SHOPS_BY_PARTNER_BODY = {
  request_id: 'req-shops',
  error: '',
  more: true,
  authed_shop_list: [
    { region: 'BR', shop_id: TEST_SHOP_ID, auth_time: 1_760_000_000, expire_time: 1_790_000_000 },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('createShopeeClient — shop-signed', () => {
  it('GETs get_shop_info with every common parameter and no body', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHOP_INFO_BODY));
    const info = await createShopeeClient(shopConfig(fetchMock)).getShopInfo();

    expect(info.shop_name).toBe('Loja de teste');
    expect(info.status).toBe('NORMAL');
    // FLAT: the envelope fields sit beside the payload.
    expect(info.request_id).toBe('req-shop');

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    // ⚠️ GET, although the reference page is headed POST — every sample uses GET.
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/shop/get_shop_info');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'access_token',
      'partner_id',
      'shop_id',
      'sign',
      'timestamp',
    ]);
    expect(url.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
  });

  it('asks for the access token once per call, and the token changes the sign', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHOP_INFO_BODY));
    const getAccessToken = vi.fn(() => Promise.resolve('token-a'));
    const client = createShopeeClient(shopConfig(fetchMock, getAccessToken));
    await client.getShopInfo();
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    const other = createShopeeClient(shopConfig(fetchMock, () => Promise.resolve('token-b')));
    await other.getShopInfo();

    const signA = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('sign');
    const signB = new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('sign');
    expect(signA).not.toBe(signB);
  });

  it('unwraps get_profile and hands back only the inner object', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-profile',
        error: '',
        response: { shop_name: 'Loja', description: 'desc', invoice_issuer: 'Shopee' },
      }),
    );
    const profile = await createShopeeClient(shopConfig(fetchMock)).getProfile();
    expect(profile.shop_name).toBe('Loja');
    expect(profile.invoice_issuer).toBe('Shopee');
    // WRAPPED: the envelope must not survive into the caller's object.
    expect('error' in profile).toBe(false);
    expect('request_id' in profile).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/api/v2/shop/get_profile');
  });

  it('refuses an impossible shop id at construction', () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHOP_INFO_BODY));
    expect(() => createShopeeClient({ ...shopConfig(fetchMock), shopId: 0 })).toThrow(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('createShopeePartnerClient — public-signed', () => {
  it('sends no token and never asks for one', async () => {
    // ⚠️ The whole point of the second factory: this call answers even when the
    // stored access token has lapsed, which is how the conta screen tells
    // "authorization revoked" from "token expired".
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(SHOPS_BY_PARTNER_BODY),
    );
    const getAccessToken = vi.fn(() => Promise.resolve('nunca-usado'));
    const client = createShopeePartnerClient({
      ...partnerConfig(fetchMock),
      // A stray token on the config must still not be sent.
      ...({ getAccessToken } as Record<string, unknown>),
    });
    const page = await client.getShopsByPartner();

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(page.more).toBe(true);
    expect(page.authed_shop_list[0]?.shop_id).toBe(TEST_SHOP_ID);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v2/public/get_shops_by_partner');
    expect(url.searchParams.get('access_token')).toBeNull();
    expect(url.searchParams.get('shop_id')).toBeNull();
    expect(url.searchParams.get('page_size')).toBe('100');
    expect(url.searchParams.get('page_no')).toBe('1');
  });

  it('does not auto-page: it surfaces `more` and the caller asks for page 2', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(SHOPS_BY_PARTNER_BODY))
      .mockResolvedValueOnce(jsonResponse({ ...SHOPS_BY_PARTNER_BODY, more: false }));
    const client = createShopeePartnerClient(partnerConfig(fetchMock));

    const first = await client.getShopsByPartner({ pageSize: 100, pageNo: 1 });
    expect(first.more).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await client.getShopsByPartner({ pageSize: 100, pageNo: 2 });
    expect(second.more).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('page_no')).toBe('2');
  });

  it('enforces the page bounds on both edges', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(SHOPS_BY_PARTNER_BODY),
    );
    const client = createShopeePartnerClient(partnerConfig(fetchMock));

    await expect(client.getShopsByPartner({ pageSize: 100 })).resolves.toBeDefined();
    await expect(client.getShopsByPartner({ pageSize: 1 })).resolves.toBeDefined();
    // NEAR-MISS on each edge: one past the bound must reject, not clamp.
    await expect(client.getShopsByPartner({ pageSize: 101 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getShopsByPartner({ pageSize: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getShopsByPartner({ pageNo: 0 })).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getShopsByPartner({ pageNo: 1.5 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('the envelope decides success, not the HTTP status', () => {
  it('raises ShopeeApiError on HTTP 200 with a non-empty error', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'req-x', error: 'error_param', message: 'shop_id is required' }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect((err as ShopeeApiError).code).toBe('error_param');
    expect((err as ShopeeApiError).requestId).toBe('req-x');
    expect((err as ShopeeApiError).httpStatus).toBe(200);
  });

  it('treats `error: ""` as success and `error: " "` as FAILURE', async () => {
    // NEAR-MISS pair. Trimming here would read a padded value as a success and
    // the caller would parse an error body as a shop.
    const ok = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHOP_INFO_BODY));
    await expect(createShopeeClient(shopConfig(ok)).getShopInfo()).resolves.toBeDefined();

    const padded = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...SHOP_INFO_BODY, error: ' ' }),
    );
    await expect(createShopeeClient(shopConfig(padded)).getShopInfo()).rejects.toBeInstanceOf(
      ShopeeApiError,
    );
  });

  it('reports a warning on a SUCCESSFUL call without throwing', async () => {
    const onWarning = vi.fn();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...SHOP_INFO_BODY, warning: 'parcialmente aplicado' }),
    );
    const info = await createShopeeClient({
      ...shopConfig(fetchMock),
      onWarning,
    }).getShopInfo();

    expect(info.warning).toBe('parcialmente aplicado');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toMatchObject({
      path: '/api/v2/shop/get_shop_info',
      warning: 'parcialmente aplicado',
      requestId: 'req-shop',
    });
  });

  it('does not call onWarning when there is none', async () => {
    const onWarning = vi.fn();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHOP_INFO_BODY));
    await createShopeeClient({ ...shopConfig(fetchMock), onWarning }).getShopInfo();
    expect(onWarning).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('rate limiting', () => {
  it('separates the burst code from the daily code', async () => {
    // NEAR-MISS: same family, opposite advice. `burst` may be retried with
    // backoff; `daily` must not be retried until 00:00 UTC+8.
    const burst = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'r', error: 'error_rate_limit' }, 429),
    );
    const burstErr = await createShopeeClient(shopConfig(burst))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect(burstErr).toBeInstanceOf(ShopeeRateLimitError);
    expect((burstErr as ShopeeRateLimitError).kind).toBe('burst');

    const daily = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'r', error: 'error_limit' }),
    );
    const dailyErr = await createShopeeClient(shopConfig(daily))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect(dailyErr).toBeInstanceOf(ShopeeRateLimitError);
    expect((dailyErr as ShopeeRateLimitError).kind).toBe('daily');
  });

  it('reads a bare 429 with no envelope as a burst limit, with Retry-After', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '7' } }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeRateLimitError);
    expect((err as ShopeeRateLimitError).kind).toBe('burst');
    expect((err as ShopeeRateLimitError).retryAfterSeconds).toBe(7);
    // The 429 branch answers before the non-JSON body is ever logged.
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores a Retry-After that is not whole seconds', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'r', error: 'error_rate_limit' }, 429, {
        'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
      }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect((err as ShopeeRateLimitError).retryAfterSeconds).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('bodies that are not a Shopee envelope', () => {
  it('reads a 502 HTML page as an HTTP error and keeps the body out of the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('<html><body>Bad Gateway do proxy</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeHttpError);
    expect(err).not.toBeInstanceOf(ShopeeApiError);
    expect((err as Error).message).not.toContain('Bad Gateway do proxy');
    expect((err as ShopeeHttpError).httpStatus).toBe(502);
    // The body reaches the LOG (capped), never the message.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('says an empty 200 never reached a JSON route, not that a deploy is needed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 200 }));
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeSchemaError);
    expect((err as Error).message).toContain('não chegou a uma rota que responde JSON');
    expect((err as Error).message).not.toContain('deploy');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reads a 200 whose JSON has no `error` field as a schema failure', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ shop_name: 'Loja' }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getShopInfo()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeSchemaError);
    expect((err as ShopeeSchemaError).campos).toContain('error');
  });

  it('caps a very long non-JSON body in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => new Response('x'.repeat(5000), { status: 500 }),
    );
    await expect(createShopeeClient(shopConfig(fetchMock)).getShopInfo()).rejects.toBeInstanceOf(
      ShopeeHttpError,
    );
    const logged = String(spy.mock.calls[0]![1]);
    expect(logged.length).toBe(500);
  });
});

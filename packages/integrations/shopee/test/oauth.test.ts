import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '../src/errors';
import { resolveShopeeHosts } from '../src/hosts';
import {
  SHOPEE_MAX_ACCESS_TOKEN_MS,
  type ShopeeOAuthConfig,
  buildAuthorizeUrl,
  buildCancelAuthUrl,
  exchangeCode,
  expiresAtFrom,
  refreshAccessToken,
} from '../src/oauth';

/** ⚠️ Invented. Never a real Shopee partner key. */
const TEST_PARTNER_KEY = 'chave-de-teste-nao-e-credencial';
const TEST_PARTNER_ID = 1000001;
const TEST_SHOP_ID = 987654;
const TEST_MAIN_ACCOUNT_ID = 555111;
const NOW_MS = 1_767_000_000_000;

const hosts = resolveShopeeHosts({ sandbox: true });
const prodHosts = resolveShopeeHosts();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function configWith(fetchImpl: typeof globalThis.fetch): ShopeeOAuthConfig {
  return {
    partnerId: TEST_PARTNER_ID,
    partnerKey: TEST_PARTNER_KEY,
    hosts,
    fetch: fetchImpl,
    now: () => NOW_MS,
  };
}

const TOKEN_BODY = {
  request_id: 'req-token',
  error: '',
  message: '',
  access_token: 'access-inventado',
  refresh_token: 'refresh-inventado',
  expire_in: 13859,
  shop_id_list: [TEST_SHOP_ID],
};

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('buildAuthorizeUrl', () => {
  it('builds Format A with exactly the five documented parameters', () => {
    const url = new URL(
      buildAuthorizeUrl({
        partnerId: TEST_PARTNER_ID,
        redirectUri: 'https://erp.example/api/oauth/shopee/callback',
        state: 'estado-assinado',
        hosts: prodHosts,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://open.shopee.com.br/auth');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'auth_type',
      'partner_id',
      'redirect_uri',
      'response_type',
      'state',
    ]);
    expect(url.searchParams.get('partner_id')).toBe('1000001');
    expect(url.searchParams.get('auth_type')).toBe('seller');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://erp.example/api/oauth/shopee/callback',
    );
  });

  it('carries NO timestamp and NO sign', () => {
    // NEAR-MISS: the legacy app built the obsolete SIGNED consent link
    // (`/api/v2/shop/auth_partner?…&redirect=`). Format A is unsigned; adding a
    // signature here would look more secure and simply not work.
    const url = new URL(
      buildAuthorizeUrl({
        partnerId: TEST_PARTNER_ID,
        redirectUri: 'https://erp.example/cb',
        state: 's',
        hosts: prodHosts,
      }),
    );
    expect(url.searchParams.has('timestamp')).toBe(false);
    expect(url.searchParams.has('sign')).toBe(false);
    expect(url.pathname).not.toContain('auth_partner');
    expect(url.searchParams.has('redirect')).toBe(false);
  });

  it('round-trips a state carrying &, = and a space', () => {
    const state = 'a=1&b=2 c';
    const url = new URL(
      buildAuthorizeUrl({
        partnerId: TEST_PARTNER_ID,
        redirectUri: 'https://erp.example/cb',
        state,
        hosts: prodHosts,
      }),
    );
    expect(url.searchParams.get('state')).toBe(state);
    // …and it did not split the query into extra parameters.
    expect([...url.searchParams.keys()]).toHaveLength(5);
  });

  it('follows the sandbox host, and cancel_auth is a sibling path', () => {
    expect(
      buildAuthorizeUrl({
        partnerId: TEST_PARTNER_ID,
        redirectUri: 'https://erp.example/cb',
        state: 's',
        hosts,
      }),
    ).toContain('https://open.sandbox.test-stable.shopee.com.br/auth?');
    expect(
      new URL(
        buildCancelAuthUrl({
          partnerId: TEST_PARTNER_ID,
          redirectUri: 'https://erp.example/cb',
          state: 's',
          hosts: prodHosts,
        }),
      ).pathname,
    ).toBe('/cancel_auth');
  });
});

/* -------------------------------------------------------------------------- */

describe('expiresAtFrom', () => {
  it('reads a small value as a DURATION in seconds', () => {
    expect(expiresAtFrom(13859, NOW_MS)).toBe(NOW_MS + 13_859_000);
    expect(expiresAtFrom(14400, NOW_MS)).toBe(NOW_MS + SHOPEE_MAX_ACCESS_TOKEN_MS);
  });

  it('reads a large value as an ABSOLUTE epoch in seconds', () => {
    expect(expiresAtFrom(1_500_000_000, NOW_MS)).toBe(1_500_000_000_000);
  });

  it('splits duration from epoch at exactly 1e9', () => {
    // NEAR-MISS pair, one second apart, on opposite sides of the threshold. A
    // duration of 1e9 s is 31 years, so nothing plausible is misread.
    expect(expiresAtFrom(1_000_000_000, NOW_MS)).toBe(NOW_MS + SHOPEE_MAX_ACCESS_TOKEN_MS);
    expect(expiresAtFrom(1_000_000_001, NOW_MS)).toBe(1_000_000_001_000);
  });

  it('clamps DOWN to four hours and never up', () => {
    // Longer than documented → capped.
    expect(expiresAtFrom(999_999, NOW_MS)).toBe(NOW_MS + SHOPEE_MAX_ACCESS_TOKEN_MS);
    expect(expiresAtFrom(1_800_000_000, NOW_MS)).toBe(NOW_MS + SHOPEE_MAX_ACCESS_TOKEN_MS);
    // Shorter than documented → believed, not raised.
    expect(expiresAtFrom(60, NOW_MS)).toBe(NOW_MS + 60_000);
  });
});

/* -------------------------------------------------------------------------- */

describe('exchangeCode', () => {
  it('POSTs the token endpoint, public-signed, with partner_id in query AND body', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TOKEN_BODY));
    const pair = await exchangeCode(configWith(fetchMock), 'codigo-de-consentimento', {
      kind: 'shop',
      shopId: TEST_SHOP_ID,
    });

    expect(pair.accessToken).toBe('access-inventado');
    expect(pair.refreshToken).toBe('refresh-inventado');
    expect(pair.expiresAtMs).toBe(NOW_MS + 13_859_000);
    expect(pair.requestId).toBe('req-token');
    expect(pair.shopIdList).toEqual([TEST_SHOP_ID]);
    expect(pair.merchantIdList).toBeNull();

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe(`${hosts.apiHost}/api/v2/auth/token/get`);
    expect(init?.method).toBe('POST');
    // Public-signed: the three common params, and no token or shop_id in the query.
    expect([...url.searchParams.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(url.searchParams.get('access_token')).toBeNull();
    expect(url.searchParams.get('shop_id')).toBeNull();

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // ⚠️ `partner_id` travels TWICE — Shopee's shape, not a mistake.
    expect(url.searchParams.get('partner_id')).toBe('1000001');
    expect(body.partner_id).toBe(TEST_PARTNER_ID);
    expect(body.code).toBe('codigo-de-consentimento');
    expect(body.shop_id).toBe(TEST_SHOP_ID);
    expect('main_account_id' in body).toBe(false);
  });

  it('keeps the common params in the QUERY on a POST, and the body out of the sign', async () => {
    // ⚠️ Two properties in one assertion because they are the same fact: the
    // signature covers `partner_id + path + timestamp` and nothing else. A POST
    // still carries the common params in the query, and two POSTs whose bodies
    // differ have the SAME `sign`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TOKEN_BODY));
    const config = configWith(fetchMock);
    await exchangeCode(config, 'codigo-um', { kind: 'shop', shopId: TEST_SHOP_ID });
    await exchangeCode(config, 'codigo-dois', { kind: 'shop', shopId: TEST_SHOP_ID });

    const [first, second] = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(first!.searchParams.get('sign')).toBe(second!.searchParams.get('sign'));
    expect([...first!.searchParams.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain('codigo-um');
    expect(String(fetchMock.mock.calls[1]![1]?.body)).toContain('codigo-dois');
  });

  it('sends main_account_id instead of shop_id for a main-account subject', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TOKEN_BODY));
    await exchangeCode(configWith(fetchMock), 'c', {
      kind: 'main_account',
      mainAccountId: TEST_MAIN_ACCOUNT_ID,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.main_account_id).toBe(TEST_MAIN_ACCOUNT_ID);
    expect('shop_id' in body).toBe(false);
    // Exactly ONE id key — the union is XOR, and the body must say so too.
    expect(Object.keys(body).filter((k) => k.endsWith('_id') && k !== 'partner_id')).toHaveLength(
      1,
    );
  });

  it('refuses a subject id that is not a positive safe integer', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TOKEN_BODY));
    // ⚠️ The app builds these from callback query params, where
    // `parseInt('123abc')` truncates and `Number('')` is 0.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        exchangeCode(configWith(fetchMock), 'c', { kind: 'shop', shopId: bad }),
      ).rejects.toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps every reauth code to ShopeeReauthRequiredError, keeping the code', async () => {
    const codes = [
      'refresh_token_expired',
      'shop_access_expired',
      'shop_no_linked',
      'shop_banned',
      'error_shop_refresh_token',
      'error_auth',
    ];
    for (const code of codes) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ request_id: 'r', error: code, message: 'x' }),
      );
      const err = await exchangeCode(configWith(fetchMock), 'c', {
        kind: 'shop',
        shopId: TEST_SHOP_ID,
      }).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(ShopeeReauthRequiredError);
      expect(err).toBeInstanceOf(ShopeeApiError);
      expect((err as ShopeeApiError).code).toBe(code);
    }
  });

  it('does NOT map invalid_code to a reauth error', async () => {
    // NEAR-MISS: it is an auth-surface failure and still not a reauth. During a
    // callback there is no stored conta to re-authorize.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'r', error: 'invalid_code', message: 'Invalid code' }),
    );
    const err = await exchangeCode(configWith(fetchMock), 'c', {
      kind: 'shop',
      shopId: TEST_SHOP_ID,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect(err).not.toBeInstanceOf(ShopeeReauthRequiredError);
    expect((err as ShopeeApiError).kind).toBe('other');
  });

  it('turns a fetch throw into a network error that leaks no credential', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      return Promise.reject(new Error('connect ECONNREFUSED sign=abc access_token=secreto'));
    });
    const err = await exchangeCode(configWith(fetchMock), 'codigo-secreto', {
      kind: 'shop',
      shopId: TEST_SHOP_ID,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeNetworkError);
    expect((err as Error).message).not.toContain('access_token');
    expect((err as Error).message).not.toContain('codigo-secreto');
    expect((err as Error).message).toContain('/api/v2/auth/token/get');
  });

  it('reports a missing access_token as a schema error naming the FIELD only', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'r', error: '', refresh_token: 'rt', expire_in: 14400 }),
    );
    const err = await exchangeCode(configWith(fetchMock), 'c', {
      kind: 'shop',
      shopId: TEST_SHOP_ID,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeSchemaError);
    expect((err as ShopeeSchemaError).campos).toContain('access_token');
    // Paths, never values: no token-shaped string may reach the message.
    expect((err as Error).message).not.toContain('rt');
  });

  it('logs no body when a token response is not JSON', async () => {
    // ⚠️ The token response IS the credential (#1015). The log may carry the
    // status and the byte count and nothing else.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('<html>token=deveria-nunca-aparecer</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(
      exchangeCode(configWith(fetchMock), 'c', { kind: 'shop', shopId: TEST_SHOP_ID }),
    ).rejects.toBeInstanceOf(ShopeeSchemaError);

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0]!.map((a) => String(a)).join(' ');
    expect(logged).not.toContain('deveria-nunca-aparecer');
    expect(logged).toContain('corpo omitido');
  });
});

/* -------------------------------------------------------------------------- */

describe('refreshAccessToken', () => {
  const REFRESH_BODY = {
    request_id: 'req-refresh',
    error: '',
    access_token: 'access-novo',
    refresh_token: 'refresh-novo',
    expire_in: 14400,
    partner_id: TEST_PARTNER_ID,
    shop_id: TEST_SHOP_ID,
  };

  it('POSTs the refresh endpoint and returns the ROTATED pair', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(REFRESH_BODY));
    const pair = await refreshAccessToken(configWith(fetchMock), 'refresh-antigo', {
      kind: 'shop',
      shopId: TEST_SHOP_ID,
    });

    expect(pair.accessToken).toBe('access-novo');
    expect(pair.refreshToken).toBe('refresh-novo');
    expect(pair.refreshToken).not.toBe('refresh-antigo');
    expect(pair.shopIdList).toBeNull();

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(rawUrl)).pathname).toBe('/api/v2/auth/access_token/get');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.refresh_token).toBe('refresh-antigo');
    expect(body.partner_id).toBe(TEST_PARTNER_ID);
    expect(body.shop_id).toBe(TEST_SHOP_ID);
  });

  it('keys a merchant refresh on merchant_id, never on shop_id', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(REFRESH_BODY));
    await refreshAccessToken(configWith(fetchMock), 'rt', { kind: 'merchant', merchantId: 42 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.merchant_id).toBe(42);
    expect('shop_id' in body).toBe(false);
  });
});

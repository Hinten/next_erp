import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES,
  SHOPEE_BRAND_MAX_PAGE_SIZE,
  SHOPEE_BRAND_STATUS,
  SHOPEE_GET_ITEM_LIMIT_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_GET_VARIATION_TREE_PATH_ALT,
  SHOPEE_ORDER_LIST_MAX_PAGE_SIZE,
  SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS,
  SHOPEE_TAXONOMY_LANGUAGE,
  type ShopeeClient,
  type ShopeeClientConfig,
  type ShopeePartnerConfig,
  createShopeeClient,
  createShopeePartnerClient,
  normalizeApiPath,
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
    // GET, per the page's own `method: 2` and every sample on it. The note that
    // used to stand here — "although the page is headed POST" — came from our
    // doc reader's `is_get_method` bug, fixed 2026-09-09.
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

/* -------------------------------------------------------------------------- */
/*                        The taxonomy reads (step 10)                         */
/* -------------------------------------------------------------------------- */

const CATEGORY_BODY = {
  request_id: 'req-cat',
  error: '',
  response: {
    category_list: [
      {
        category_id: 100017,
        parent_category_id: 0,
        original_category_name: 'Moda Feminina',
        display_category_name: 'Moda Feminina',
        has_children: false,
      },
    ],
  },
};

const ATTRIBUTE_BODY = {
  request_id: 'req-attr',
  error: '',
  response: {
    list: [
      { category_id: 4321, warning: 'atributos parciais', attribute_tree: [] },
      { category_id: 9999, warning: null, attribute_tree: [] },
    ],
  },
};

const BRAND_BODY = {
  request_id: 'req-brand',
  error: '',
  response: {
    brand_list: [{ brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'No Brand' }],
    has_next_page: true,
    next_offset: 100,
    is_mandatory: false,
    input_type: 'DROP_DOWN',
  },
};

const ITEM_LIMIT_BODY = {
  request_id: 'req-item-limit',
  error: '',
  response: { price_limit: { min_limit: 5.5, max_limit: 10000000.0 } },
  gtin_limit: { gtin_validation_rule: 'Mandatory' },
};

const KIT_LIMIT_BODY = {
  request_id: 'req-kit-limit',
  error: '',
  response: {
    item_name_length_limit: { min_limit: 5, max_limit: 99 },
    dts_limit: { non_pre_order_days_to_ship: 2, support_pre_order: true },
    component_count_limit_of_single_model: { min_limit: 2, max_limit: 10 },
  },
};

const VARIATIONS_BODY = {
  request_id: 'req-var',
  error: '',
  // ⚠️ O sample de SUCESSO da página carrega isto. É ruído, não falha parcial —
  // filtrá-lo é papel da app; o transporte entrega todo `warning` ao `onWarning`.
  warning: 'success',
  data: {
    standardise_variation_list: [
      { variation_id: 123456789012345, variation_name: 'Cor', variation_group_list: [] },
    ],
  },
};

const RECOMMEND_BODY = {
  request_id: 'req-rec',
  error: '',
  response: { category_id: [100017, 100018] },
};

const CHAVES_COMUNS = ['access_token', 'partner_id', 'shop_id', 'sign', 'timestamp'] as const;

interface OpTaxonomia {
  readonly nome: string;
  readonly corpo: unknown;
  readonly path: string;
  readonly chaves: readonly string[];
  readonly chamar: (c: ShopeeClient) => Promise<unknown>;
}

const OPS_TAXONOMIA: readonly OpTaxonomia[] = [
  {
    nome: 'getCategory',
    corpo: CATEGORY_BODY,
    path: '/api/v2/product/get_category',
    chaves: [...CHAVES_COMUNS, 'language'],
    chamar: (c) => c.getCategory(),
  },
  {
    nome: 'getAttributeTree',
    corpo: ATTRIBUTE_BODY,
    path: '/api/v2/product/get_attribute_tree',
    chaves: [...CHAVES_COMUNS, 'category_id_list', 'language'],
    chamar: (c) => c.getAttributeTree({ categoryIds: [4321] }),
  },
  {
    nome: 'getBrandList',
    corpo: BRAND_BODY,
    path: '/api/v2/product/get_brand_list',
    chaves: [...CHAVES_COMUNS, 'category_id', 'language', 'offset', 'page_size', 'status'],
    chamar: (c) => c.getBrandList({ categoryId: 4321, offset: 0, pageSize: 100, status: 1 }),
  },
  {
    nome: 'getItemLimit',
    corpo: ITEM_LIMIT_BODY,
    path: '/api/v2/product/get_item_limit',
    chaves: [...CHAVES_COMUNS, 'category_id'],
    chamar: (c) => c.getItemLimit({ categoryId: 4321 }),
  },
  {
    nome: 'getKitItemLimit',
    corpo: KIT_LIMIT_BODY,
    path: '/api/v2/product/get_kit_item_limit',
    chaves: [...CHAVES_COMUNS, 'category_id'],
    chamar: (c) => c.getKitItemLimit({ categoryId: 4321 }),
  },
  {
    nome: 'getVariations',
    corpo: VARIATIONS_BODY,
    path: '/api/v2/product/get_variations',
    chaves: [...CHAVES_COMUNS, 'category_id'],
    chamar: (c) => c.getVariations({ categoryId: 4321 }),
  },
  {
    nome: 'categoryRecommend',
    corpo: RECOMMEND_BODY,
    path: '/api/v2/product/category_recommend',
    chaves: [...CHAVES_COMUNS, 'item_name'],
    chamar: (c) => c.categoryRecommend({ itemName: 'Vestido longo' }),
  },
];

describe('a query assinada de cada leitura de taxonomia', () => {
  it.each(OPS_TAXONOMIA)(
    '$nome usa GET, o seu próprio caminho e exatamente as chaves esperadas',
    async ({ corpo, path, chaves, chamar }) => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpo));
      await chamar(createShopeeClient(shopConfig(fetchMock)));

      const [rawUrl, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(rawUrl));
      expect(init?.method).toBe('GET');
      // ⚠️ Nenhum corpo: a assinatura não cobre o body, e estas operações levam
      // tudo na query.
      expect(init?.body).toBeUndefined();
      expect(url.pathname).toBe(path);
      expect([...url.searchParams.keys()].sort()).toEqual([...chaves].sort());
      expect(url.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
    },
  );

  it('manda `language=pt-br` nas TRÊS operações que aceitam idioma', async () => {
    for (const nome of ['getCategory', 'getAttributeTree', 'getBrandList']) {
      const op = OPS_TAXONOMIA.find((o) => o.nome === nome)!;
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(op.corpo));
      await op.chamar(createShopeeClient(shopConfig(fetchMock)));
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.searchParams.get('language'), nome).toBe(SHOPEE_TAXONOMY_LANGUAGE);
    }
    expect(SHOPEE_TAXONOMY_LANGUAGE).toBe('pt-br');
  });

  it('junta as categorias em UM `category_id_list`, mesmo quando é uma só', async () => {
    // A app manda uma por chamada porque `category_id_list=<id>` vale nas duas
    // grafias com que a página se contradiz; a junção por vírgula é a única forma
    // possível, já que `signedQuery` não emite chave repetida.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ATTRIBUTE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getAttributeTree({ categoryIds: [4321] });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('category_id_list')).toBe(
      '4321',
    );

    await client.getAttributeTree({ categoryIds: [1, 2, 3] });
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('category_id_list')).toBe(
      '1,2,3',
    );
  });

  it('omite `category_id` quando a leitura é do SHOP inteiro, e o envia quando há categoria', async () => {
    // NEAR-MISS: a ausência da categoria é uma leitura documentada (as bandas do
    // shop), não um parâmetro esquecido — mandar `category_id=undefined` seria
    // outra pergunta.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIMIT_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getItemLimit();
    const semCategoria = new URL(String(fetchMock.mock.calls[0]![0]));
    expect([...semCategoria.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());

    await client.getItemLimit({ categoryId: 4321 });
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('category_id')).toBe(
      '4321',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('o caminho contraditório de get_variations', () => {
  it('usa por padrão o caminho dos EXEMPLOS da página', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getVariations({ categoryId: 4321 });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(SHOPEE_GET_VARIATIONS_PATH);
    expect(SHOPEE_GET_VARIATIONS_PATH).not.toBe(SHOPEE_GET_VARIATION_TREE_PATH_ALT);
  });

  it('a sobrescrita muda o pathname E a assinatura', async () => {
    // ⚠️ O caminho está DENTRO da base string do HMAC: escolher o errado não dá
    // 404, dá `error_sign`. Por isso a troca tem de mudar as duas coisas.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    const token = () => Promise.resolve('token-fixo');

    await createShopeeClient(shopConfig(fetchMock, token)).getVariations({ categoryId: 4321 });
    await createShopeeClient({
      ...shopConfig(fetchMock, token),
      paths: { getVariations: SHOPEE_GET_VARIATION_TREE_PATH_ALT },
    }).getVariations({ categoryId: 4321 });

    const padrao = new URL(String(fetchMock.mock.calls[0]![0]));
    const alternativo = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(padrao.pathname).toBe(SHOPEE_GET_VARIATIONS_PATH);
    expect(alternativo.pathname).toBe(SHOPEE_GET_VARIATION_TREE_PATH_ALT);
    expect(alternativo.searchParams.get('sign')).not.toBe(padrao.searchParams.get('sign'));
  });

  it('aceita uma sobrescrita bem formada, com espaços em volta', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    await createShopeeClient({
      ...shopConfig(fetchMock),
      paths: { getVariations: `  ${SHOPEE_GET_VARIATION_TREE_PATH_ALT}  ` },
    }).getVariations({ categoryId: 4321 });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      SHOPEE_GET_VARIATION_TREE_PATH_ALT,
    );
  });

  it.each([
    { caso: 'com esquema e host', valor: 'https://openplatform.shopee.com.br/api/v2/x' },
    { caso: 'protocol-relative', valor: '//openplatform.shopee.com.br/api/v2/x' },
    { caso: 'sem a barra inicial', valor: 'api/v2/product/get_variations' },
    { caso: 'com query', valor: '/api/v2/product/get_variations?foo=1' },
    { caso: 'com fragmento', valor: '/api/v2/product/get_variations#x' },
    { caso: 'vazia', valor: '' },
  ])('recusa a sobrescrita $caso NA CONSTRUÇÃO, antes de qualquer fetch', ({ valor }) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    expect(() =>
      createShopeeClient({ ...shopConfig(fetchMock), paths: { getVariations: valor } }),
    ).toThrow(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizeApiPath devolve o caminho quando ele já é um caminho', () => {
    expect(normalizeApiPath('/api/v2/product/get_variations', 'SHOPEE_VARIATIONS_PATH')).toBe(
      '/api/v2/product/get_variations',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('os limites das leituras de taxonomia rejeitam ANTES da rede', () => {
  it('get_attribute_tree aceita 1 e 20 categorias e recusa 0 e 21', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ATTRIBUTE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

    await expect(client.getAttributeTree({ categoryIds: ids(1) })).resolves.toBeDefined();
    await expect(
      client.getAttributeTree({
        categoryIds: ids(SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES),
      }),
    ).resolves.toBeDefined();
    // NEAR-MISS nas duas bordas.
    await expect(client.getAttributeTree({ categoryIds: [] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getAttributeTree({ categoryIds: ids(SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES + 1) }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getAttributeTree({ categoryIds: [0] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getAttributeTree({ categoryIds: [1.5] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('get_brand_list valida as quatro bandas nas duas bordas', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BRAND_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const base = { categoryId: 4321, offset: 0, pageSize: 100, status: 1 } as const;

    await expect(client.getBrandList(base)).resolves.toBeDefined();
    await expect(client.getBrandList({ ...base, pageSize: 1 })).resolves.toBeDefined();
    await expect(
      client.getBrandList({ ...base, status: SHOPEE_BRAND_STATUS.pending }),
    ).resolves.toBeDefined();

    for (const ruim of [
      { ...base, pageSize: 0 },
      { ...base, pageSize: SHOPEE_BRAND_MAX_PAGE_SIZE + 1 },
      { ...base, offset: -1 },
      { ...base, offset: 1.5 },
      { ...base, status: 3 },
      { ...base, status: 0 },
      { ...base, categoryId: 0 },
    ]) {
      await expect(client.getBrandList(ruim)).rejects.toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('as demais operações recusam uma categoria impossível e um nome vazio', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIMIT_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getItemLimit({ categoryId: 0 })).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getKitItemLimit({ categoryId: -1 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getVariations({ categoryId: 0 })).rejects.toBeInstanceOf(ShopeeConfigError);
    // NEAR-MISS: só espaços não é um nome, e a Shopee responderia `error_param`.
    await expect(client.categoryRecommend({ itemName: '   ' })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.categoryRecommend({ itemName: '' })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('o que cada leitura devolve', () => {
  it('desembrulha `response` / `data` e o envelope não chega ao chamador', async () => {
    for (const op of OPS_TAXONOMIA) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(op.corpo));
      const resultado = (await op.chamar(createShopeeClient(shopConfig(fetchMock)))) as Record<
        string,
        unknown
      >;
      expect('error' in resultado, op.nome).toBe(false);
      expect('request_id' in resultado, op.nome).toBe(false);
    }
  });

  it('getCategory entrega a lista com `has_children` intacto', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CATEGORY_BODY));
    const lista = await createShopeeClient(shopConfig(fetchMock)).getCategory();
    expect(lista.category_list[0]?.has_children).toBe(false);
    expect(lista.category_list[0]?.parent_category_id).toBe(0);
  });

  it('getAttributeTree entrega TODAS as linhas, com o warning de cada uma', async () => {
    // A linha certa é a que tem o `category_id` pedido — escolher `list[0]` é o
    // defeito que este corpo de duas linhas existe para pegar.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ATTRIBUTE_BODY));
    const arvore = await createShopeeClient(shopConfig(fetchMock)).getAttributeTree({
      categoryIds: [9999],
    });
    expect(arvore.list.map((l) => l.category_id)).toEqual([4321, 9999]);
    expect(arvore.list[0]?.warning).toBe('atributos parciais');
    expect(arvore.list[1]?.warning).toBeNull();
  });

  it('getBrandList preserva `brand_id: 0` e devolve o cursor verbatim', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BRAND_BODY));
    const pagina = await createShopeeClient(shopConfig(fetchMock)).getBrandList({
      categoryId: 4321,
      offset: 0,
      pageSize: 100,
      status: SHOPEE_BRAND_STATUS.normal,
    });
    expect(pagina.brand_list[0]?.brand_id).toBe(0);
    expect(pagina.has_next_page).toBe(true);
    expect(pagina.next_offset).toBe(100);
  });

  it('getVariations devolve o payload que veio sob `data`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    const variacoes = await createShopeeClient(shopConfig(fetchMock)).getVariations({
      categoryId: 4321,
    });
    expect(variacoes.standardise_variation_list[0]?.variation_id).toBe(123456789012345);
  });
});

/* -------------------------------------------------------------------------- */

describe('get_item_limit e as duas posições de gtin_limit', () => {
  const CORPO = (dentro: unknown, fora: unknown) => ({
    request_id: 'req-gtin',
    error: '',
    response: dentro === undefined ? {} : { gtin_limit: dentro },
    ...(fora === undefined ? {} : { gtin_limit: fora }),
  });
  const REGRA = { gtin_validation_rule: 'Flexible' };

  it.each([
    {
      caso: 'só dentro',
      dentro: REGRA as unknown,
      fora: undefined,
      esperaDentro: true,
      esperaFora: false,
    },
    {
      caso: 'só irmão',
      dentro: undefined,
      fora: REGRA as unknown,
      esperaDentro: false,
      esperaFora: true,
    },
    {
      caso: 'nas duas',
      dentro: REGRA as unknown,
      fora: REGRA as unknown,
      esperaDentro: true,
      esperaFora: true,
    },
    {
      caso: 'em nenhuma',
      dentro: undefined,
      fora: undefined,
      esperaDentro: false,
      esperaFora: false,
    },
  ])(
    'entrega as duas posições quando o gtin vem $caso',
    async ({ dentro, fora, esperaDentro, esperaFora }) => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(CORPO(dentro, fora)),
      );
      const lido = await createShopeeClient(shopConfig(fetchMock)).getItemLimit();
      expect(lido.response.gtin_limit === null).toBe(!esperaDentro);
      expect(lido.gtin_limit === null).toBe(!esperaFora);
      // ⚠️ Nunca `{}` quando não vem nada: `null` é o que a leitora sabe ler.
      if (!esperaDentro && !esperaFora) {
        expect(lido.gtin_limit).toBeNull();
        expect(lido.response.gtin_limit).toBeNull();
      }
    },
  );
});

/* -------------------------------------------------------------------------- */

describe('kit e item são leituras diferentes', () => {
  it('getKitItemLimit usa o seu caminho e NUNCA toca o de item', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(KIT_LIMIT_BODY));
    const kit = await createShopeeClient(shopConfig(fetchMock)).getKitItemLimit({
      categoryId: 4321,
    });

    const caminhos = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(caminhos).toEqual([SHOPEE_GET_KIT_ITEM_LIMIT_PATH]);
    expect(caminhos).not.toContain(SHOPEE_GET_ITEM_LIMIT_PATH);
    // As bandas do kit são as SUAS: `support_pre_order` e o limite de componentes
    // não existem na página de item.
    expect(kit.dts_limit?.support_pre_order).toBe(true);
    expect(kit.component_count_limit_of_single_model?.max_limit).toBe(10);
    expect(kit.item_name_length_limit?.max_limit).toBe(99);
  });
});

/* -------------------------------------------------------------------------- */

describe('as marcas não paginam sozinhas', () => {
  it('faz duas chamadas e a segunda leva o `next_offset` devolvido', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(BRAND_BODY))
      .mockResolvedValueOnce(
        jsonResponse({
          ...BRAND_BODY,
          response: { ...BRAND_BODY.response, has_next_page: false, next_offset: null },
        }),
      );
    const client = createShopeeClient(shopConfig(fetchMock));

    const primeira = await client.getBrandList({
      categoryId: 4321,
      offset: 0,
      pageSize: 100,
      status: SHOPEE_BRAND_STATUS.normal,
    });
    expect(primeira.has_next_page).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const segunda = await client.getBrandList({
      categoryId: 4321,
      offset: primeira.next_offset ?? 0,
      pageSize: 100,
      status: SHOPEE_BRAND_STATUS.normal,
    });
    expect(segunda.has_next_page).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('offset')).toBe('100');
  });
});

/* -------------------------------------------------------------------------- */

describe('o `warning: "success"` das variações', () => {
  it('chega ao onWarning UMA vez, sem virar erro', async () => {
    // O transporte não filtra: quem decide que `"success"` é ruído é a app, por
    // igualdade exata. Aqui só se pina que ele CHEGA.
    const onWarning = vi.fn();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VARIATIONS_BODY));
    const variacoes = await createShopeeClient({
      ...shopConfig(fetchMock),
      onWarning,
    }).getVariations({ categoryId: 4321 });

    expect(variacoes.standardise_variation_list).toHaveLength(1);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toMatchObject({
      path: SHOPEE_GET_VARIATIONS_PATH,
      warning: 'success',
    });
  });

  it('não chama onWarning quando o corpo não traz warning nenhum', async () => {
    const onWarning = vi.fn();
    const semWarning = { ...VARIATIONS_BODY, warning: undefined };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(semWarning));
    await createShopeeClient({ ...shopConfig(fetchMock), onWarning }).getVariations({
      categoryId: 4321,
    });
    expect(onWarning).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('os erros de módulo do product', () => {
  it('lê `product.error_param` como ShopeeApiError com código e request id', async () => {
    // ⚠️ Os erros de módulo chegam PREFIXADOS. Nada em `errors.ts` os conhece, e
    // é assim de propósito: eles caem em `'other'` e a app loga o código cru.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-erro',
        error: 'product.error_param',
        message: 'category_id_list is required',
      }),
    );
    const err = await createShopeeClient(shopConfig(fetchMock))
      .getAttributeTree({ categoryIds: [4321] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeApiError);
    expect((err as ShopeeApiError).code).toBe('product.error_param');
    expect((err as ShopeeApiError).requestId).toBe('req-erro');
    expect((err as ShopeeApiError).httpStatus).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*                    A fila de mensagens perdidas (passo 4)                   */
/* -------------------------------------------------------------------------- */

/** As três chaves comuns de uma chamada PUBLIC — sem access_token, sem shop_id. */
const CHAVES_PUBLIC = ['partner_id', 'sign', 'timestamp'] as const;

const LOST_PUSH_BODY = {
  // ⚠️ Verbatim do exemplo da página, `"-"` incluído. Ver `emptyErrorAliases`.
  error: '-',
  message: '-',
  warning: '-',
  request_id: '1f34a2c99335ffe85744d98e07fe7d41',
  response: {
    push_message_list: [
      {
        shop_id: 727720655,
        code: 3,
        timestamp: 1660123127,
        data: '{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED","completed_scenario":"","update_time":1660123127},"shop_id":727720655,"code":3,"timestamp":1660123127}',
      },
    ],
    has_next_page: false,
    last_message_id: 176610,
  },
};

const CONFIRM_BODY = {
  error: '-',
  message: '-',
  warning: '-',
  request_id: '668ea92da2a19f7d2e72bf98bd530c41',
};

const APP_PUSH_CONFIG_BODY = {
  request_id: 'b937c04e554847789cbf3fe33a0ad5f1',
  error: '',
  message: '',
  response: {
    callback_url: 'https://open.shopee.com/',
    live_push_status: 'suspended',
    suspended_time: 1577416181,
    blocked_shop_id: [10010, 20020, 30030],
    push_config_on_list: [1, 2, 3],
    push_config_off_list: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  },
};

describe('as operações de push do cliente de parceiro', () => {
  it('GET sem nenhum parâmetro de requisição — só partner_id, sign, timestamp', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(LOST_PUSH_BODY));
    const op = await createShopeePartnerClient(partnerConfig(fetchMock)).getLostPushMessages();

    // ⚠️ NÃO desembrulhado — a única operação deste arquivo que devolve o
    // envelope. É o `error` DESTA página que a primeira tick de produção precisa
    // registrar verbatim para settlar a contradição do `"-"` (D1); a varredura
    // pode rodar com o confirm desligado, e aí o envelope do confirm não existe.
    expect(op.error).toBe('-');
    expect(op.request_id).toBe('1f34a2c99335ffe85744d98e07fe7d41');
    expect(op.response.last_message_id).toBe(176610);
    expect(op.response.push_message_list?.[0]?.code).toBe(3);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    // ⚠️ GET: `method: 2` na página, e os quatro exemplos dela concordam.
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/push/get_lost_push_message');
    // A seção "Request params" da página é VAZIA — nada além dos comuns viaja.
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_PUBLIC].sort());
    expect(url.searchParams.get('access_token')).toBeNull();
  });

  it('⚠️ aceita "error": "-" como sucesso — a contradição das duas páginas de lost push', async () => {
    // As duas páginas se contradizem: a tabela de parâmetros diz `""` e o
    // exemplo renderizado diz `"-"`. Sem o alias, a primeira chamada de
    // PRODUÇÃO derrubaria a varredura — e o sandbox não alcança estas APIs.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(LOST_PUSH_BODY));
    const client = createShopeePartnerClient(partnerConfig(fetchMock));
    await expect(client.getLostPushMessages()).resolves.toBeDefined();

    const confirmMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CONFIRM_BODY));
    await expect(
      createShopeePartnerClient(partnerConfig(confirmMock)).confirmConsumedLostPushMessages({
        lastMessageId: 176610,
      }),
    ).resolves.toBeDefined();
  });

  it('⚠️ " " (um espaço) continua sendo falha — o alias é igualdade exata, não trim', async () => {
    // NEAR-MISS do teste acima. Um `includes` sobre um valor aparado leria
    // qualquer coisa com um `-` no meio como sucesso.
    const espaco = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...LOST_PUSH_BODY, error: ' ' }),
    );
    await expect(
      createShopeePartnerClient(partnerConfig(espaco)).getLostPushMessages(),
    ).rejects.toBeInstanceOf(ShopeeApiError);

    const quaseAlias = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...LOST_PUSH_BODY, error: ' - ' }),
    );
    await expect(
      createShopeePartnerClient(partnerConfig(quaseAlias)).getLostPushMessages(),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('⚠️ "error": "-" NÃO é sucesso em get_app_push_config — o alias é por operação', async () => {
    // A tolerância é por OPERAÇÃO porque a contradição é por PÁGINA: o exemplo
    // desta aqui diz `""`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...APP_PUSH_CONFIG_BODY, error: '-' }),
    );
    const err = await createShopeePartnerClient(partnerConfig(fetchMock))
      .getAppPushConfig()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect((err as ShopeeApiError).code).toBe('-');
  });

  it('get_app_push_config vai por GET e desembrulha `response`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(APP_PUSH_CONFIG_BODY),
    );
    const config = await createShopeePartnerClient(partnerConfig(fetchMock)).getAppPushConfig();

    expect(config.live_push_status).toBe('suspended');
    expect(config.suspended_time).toBe(1577416181);
    expect(config.push_config_off_list).toContain(13);
    expect('error' in config).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe('/api/v2/push/get_app_push_config');
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_PUBLIC].sort());
  });

  it('POST no confirm com { last_message_id } no CORPO e os comuns na query', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CONFIRM_BODY));
    const envelope = await createShopeePartnerClient(
      partnerConfig(fetchMock),
    ).confirmConsumedLostPushMessages({ lastMessageId: 176610 });

    // A resposta é o envelope NU: é dela que sai o `request_id` de um chamado de
    // suporte sobre um watermark que não andou.
    expect(envelope.request_id).toBe('668ea92da2a19f7d2e72bf98bd530c41');
    expect('response' in envelope).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('POST');
    expect(url.pathname).toBe('/api/v2/push/confirm_consumed_lost_push_message');
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_PUBLIC].sort());
    // O parâmetro da operação viaja no corpo, os comuns na query assinada.
    expect(url.searchParams.get('last_message_id')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ last_message_id: 176610 });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('⚠️ o corpo não entra na assinatura — dois last_message_id diferentes têm o MESMO sign', async () => {
    // Propriedade, não coincidência: a base do HMAC é partner_id + caminho +
    // timestamp. Um "vamos assinar o corpo também" quebraria o ack em silêncio,
    // e este teste é o que diria.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CONFIRM_BODY));
    const client = createShopeePartnerClient(partnerConfig(fetchMock));
    await client.confirmConsumedLostPushMessages({ lastMessageId: 176610 });
    await client.confirmConsumedLostPushMessages({ lastMessageId: 999999 });

    const signA = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('sign');
    const signB = new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('sign');
    expect(signA).toBe(signB);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      last_message_id: 999999,
    });
  });

  it('recusa um lastMessageId <= 0 ou fracionário ANTES de gastar a chamada', async () => {
    // `0` é exatamente a cara de um cursor ausente ou inventado, e "nunca
    // sintetize o cursor" é a regra sobre a qual o ack inteiro se apoia.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CONFIRM_BODY));
    const client = createShopeePartnerClient(partnerConfig(fetchMock));

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        client.confirmConsumedLostPushMessages({ lastMessageId: bad }),
      ).rejects.toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      client.confirmConsumedLostPushMessages({ lastMessageId: 1 }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('⚠️ o cliente NÃO expõe set_app_push_config — a ausência é o que impede a chamada', async () => {
    // `set_app_push_config` levaria um único callback_url do APP inteiro, dispara
    // um push de teste ao vivo, e o enum de códigos dela para em 13 enquanto os
    // vivos chegam a 47 — um read-modify-write derrubaria tudo acima de 13.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(LOST_PUSH_BODY));
    const client = createShopeePartnerClient(partnerConfig(fetchMock));
    expect(Object.keys(client).sort()).toEqual([
      'confirmConsumedLostPushMessages',
      'getAppPushConfig',
      'getLostPushMessages',
      'getShopsByPartner',
    ]);
    expect('setAppPushConfig' in client).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                     A listagem de pedidos (passo 4/5)                       */
/* -------------------------------------------------------------------------- */

const ORDER_LIST_BODY = {
  request_id: 'req-orders',
  error: '',
  response: {
    more: true,
    next_cursor: '20',
    // ⚠️ Verbatim do exemplo: linhas NUAS, e dez delas para `page_size: 20` com
    // `more: true`. É por isso que a contagem de linhas não decide nada.
    order_list: [{ order_sn: '201218V2Y6E59M' }, { order_sn: '201218V2W2SG1E' }],
  },
};

const PARAMS_PEDIDOS = {
  timeRangeField: 'update_time',
  timeFromS: 1_760_000_000,
  timeToS: 1_760_086_400,
  pageSize: 50,
} as const;

describe('get_order_list', () => {
  it('vai por GET, com os parâmetros comuns na query e sem corpo', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getOrderList({
      ...PARAMS_PEDIDOS,
      responseOptionalFields: 'order_status',
      requestOrderStatusPending: true,
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/order/get_order_list');
    expect([...url.searchParams.keys()].sort()).toEqual(
      [
        ...CHAVES_COMUNS,
        'time_range_field',
        'time_from',
        'time_to',
        'page_size',
        'request_order_status_pending',
        'response_optional_fields',
      ].sort(),
    );
    expect(url.searchParams.get('time_range_field')).toBe('update_time');
    // ⚠️ SEGUNDOS, como vieram: o pacote não converte unidade nenhuma.
    expect(url.searchParams.get('time_from')).toBe('1760000000');
    expect(url.searchParams.get('time_to')).toBe('1760086400');
    expect(url.searchParams.get('page_size')).toBe('50');
  });

  it('request_order_status_pending vai como "true" e é OMITIDO quando não pedido; nenhum filtro order_status é enviado', async () => {
    // ⚠️ O filtro `order_status` da Shopee OMITE PENDING/RETRY_SHIP/
    // TO_CONFIRM_RECEIVE/TO_RETURN, então uma varredura que o usasse pularia
    // pedidos em silêncio. `response_optional_fields` é outra coisa: pede o
    // campo de volta, não filtra.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getOrderList({ ...PARAMS_PEDIDOS, requestOrderStatusPending: true });
    const comPending = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(comPending.searchParams.get('request_order_status_pending')).toBe('true');
    expect(comPending.searchParams.get('order_status')).toBeNull();

    await client.getOrderList({ ...PARAMS_PEDIDOS, requestOrderStatusPending: false });
    const semPending = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(semPending.searchParams.has('request_order_status_pending')).toBe(false);

    await client.getOrderList(PARAMS_PEDIDOS);
    const omitido = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(omitido.searchParams.has('request_order_status_pending')).toBe(false);
    expect(omitido.searchParams.has('response_optional_fields')).toBe(false);
    expect(omitido.searchParams.get('order_status')).toBeNull();
  });

  it('os limites são checados ANTES da rede: page_size nas duas bordas, time_from < time_to, e a janela de 15 dias no limite exato e um segundo além', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    // As duas bordas boas de `page_size`.
    await expect(client.getOrderList({ ...PARAMS_PEDIDOS, pageSize: 1 })).resolves.toBeDefined();
    await expect(
      client.getOrderList({ ...PARAMS_PEDIDOS, pageSize: SHOPEE_ORDER_LIST_MAX_PAGE_SIZE }),
    ).resolves.toBeDefined();
    // NEAR-MISS em cada uma: um passo além recusa, nunca corta.
    await expect(client.getOrderList({ ...PARAMS_PEDIDOS, pageSize: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getOrderList({ ...PARAMS_PEDIDOS, pageSize: SHOPEE_ORDER_LIST_MAX_PAGE_SIZE + 1 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getOrderList({ ...PARAMS_PEDIDOS, pageSize: 20.5 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );

    // `time_from` tem de ser ANTERIOR a `time_to` — igual já é recusado.
    await expect(
      client.getOrderList({ ...PARAMS_PEDIDOS, timeToS: PARAMS_PEDIDOS.timeFromS }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getOrderList({ ...PARAMS_PEDIDOS, timeToS: PARAMS_PEDIDOS.timeFromS - 1 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getOrderList({ ...PARAMS_PEDIDOS, timeFromS: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );

    // ⚠️ 15 dias EXATOS passam; um segundo além é `order.order_list_invalid_time`
    // na Shopee, e aqui é uma recusa antes de gastar a chamada.
    await expect(
      client.getOrderList({
        ...PARAMS_PEDIDOS,
        timeToS: PARAMS_PEDIDOS.timeFromS + SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS,
      }),
    ).resolves.toBeDefined();
    await expect(
      client.getOrderList({
        ...PARAMS_PEDIDOS,
        timeToS: PARAMS_PEDIDOS.timeFromS + SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS + 1,
      }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);

    expect(SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS).toBe(1_296_000);
    // Só as TRÊS combinações válidas chegaram à rede; toda recusa é anterior.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('um cursor vazio é RECUSADO — a primeira página omite o parâmetro', async () => {
    // ⚠️ `next_cursor: ''` é o sentinela de DRENADO da Shopee. Normalizá-lo aqui
    // transformaria "devolvi o sentinela como cursor" em "recomecei a janela da
    // página 1", que parece progresso e é um pulo de dados.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getOrderList({ ...PARAMS_PEDIDOS, cursor: '' })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await client.getOrderList(PARAMS_PEDIDOS);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('cursor')).toBe(false);
  });

  it('desembrulha `response` — o envelope não chega ao chamador — e tolera a linha nua', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...ORDER_LIST_BODY,
        response: {
          more: false,
          next_cursor: '',
          order_list: [
            { order_sn: '201218V2Y6E59M' },
            { order_sn: '2404098R48U37H', order_status: 'READY_TO_SHIP', booking_sn: '24040' },
          ],
        },
      }),
    );
    const page = await createShopeeClient(shopConfig(fetchMock)).getOrderList(PARAMS_PEDIDOS);

    expect('error' in page).toBe(false);
    expect('request_id' in page).toBe(false);
    expect(page.more).toBe(false);
    expect(page.next_cursor).toBe('');
    expect(page.order_list[0]?.order_status).toBeNull();
    expect(page.order_list[1]?.order_status).toBe('READY_TO_SHIP');
    expect(page.order_list[1]?.booking_sn).toBe('24040');
  });

  it('não pagina sozinho: devolve more/next_cursor e o chamador pede a próxima', async () => {
    // ⚠️ Duas linhas com `more: true` — a contagem de linhas NÃO termina o laço,
    // e o exemplo da própria página devolve 10 para `page_size: 20`.
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(ORDER_LIST_BODY))
      .mockResolvedValueOnce(
        jsonResponse({
          ...ORDER_LIST_BODY,
          response: { more: false, next_cursor: '', order_list: [] },
        }),
      );
    const client = createShopeeClient(shopConfig(fetchMock));

    const primeira = await client.getOrderList(PARAMS_PEDIDOS);
    expect(primeira.more).toBe(true);
    expect(primeira.next_cursor).toBe('20');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const segunda = await client.getOrderList({ ...PARAMS_PEDIDOS, cursor: primeira.next_cursor! });
    expect(segunda.more).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('cursor')).toBe('20');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

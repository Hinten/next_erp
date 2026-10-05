import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { roundReais } from '@delfrance/core/money';

import {
  SHOPEE_ADD_ITEM_PATH,
  SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES,
  SHOPEE_BRAND_MAX_PAGE_SIZE,
  SHOPEE_BRAND_STATUS,
  SHOPEE_DELETE_ITEM_PATH,
  SHOPEE_DELETE_MODEL_PATH,
  SHOPEE_ESCROW_DETAIL_TRANSPORT,
  SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE,
  SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE,
  SHOPEE_GET_ESCROW_LIST_PATH,
  SHOPEE_GET_CHANNEL_LIST_PATH,
  SHOPEE_GET_ITEM_BASE_INFO_PATH,
  SHOPEE_GET_ITEM_LIMIT_PATH,
  SHOPEE_GET_ITEM_PROMOTION_PATH,
  SHOPEE_GET_ITEM_LIST_PATH,
  SHOPEE_GET_ITEM_VIOLATION_INFO_PATH,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_MODEL_LIST_PATH,
  SHOPEE_GET_PACKAGE_DETAIL_PATH,
  SHOPEE_GET_SHOP_HOLIDAY_MODE_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_GET_VARIATION_TREE_PATH_ALT,
  SHOPEE_GET_WAREHOUSE_DETAIL_PATH,
  SHOPEE_INIT_TIER_VARIATION_PATH,
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  SHOPEE_ITEM_ID_LIST_ENCODING,
  SHOPEE_ITEM_STATUS_WIRE,
  SHOPEE_MAX_PAGE_SIZE,
  SHOPEE_ORDER_DETAIL_MAX_ORDER_SN,
  SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
  SHOPEE_ORDER_LIST_MAX_PAGE_SIZE,
  SHOPEE_ORDER_LIST_MAX_WINDOW_SECONDS,
  SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES,
  SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES,
  SHOPEE_TAXONOMY_LANGUAGE,
  SHOPEE_UNLIST_ITEM_PATH,
  SHOPEE_UPDATE_ITEM_PATH,
  SHOPEE_UPDATE_MODEL_PATH,
  SHOPEE_UPDATE_PRICE_PATH,
  SHOPEE_UPDATE_STOCK_PATH,
  SHOPEE_UPDATE_TIER_VARIATION_PATH,
  SHOPEE_UPLOAD_IMAGE_PATH,
  SHOPEE_UPLOAD_INVOICE_DOC_PATH,
  type ShopeeAddItemRequest,
  type ShopeeClient,
  type ShopeeClientConfig,
  type ShopeeItemStatusWire,
  type ShopeeModelRequest,
  type ShopeePartnerConfig,
  type ShopeeStandardiseTierRequest,
  type ShopeeUpdatePriceEntry,
  type ShopeeUpdateStockEntry,
  type UploadImageParams,
  type UploadInvoiceDocParams,
  createShopeeClient,
  createShopeePartnerClient,
  encodeShopeeIdList,
  normalizeApiPath,
} from '../src/api';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '../src/errors';
import { resolveShopeeHosts } from '../src/hosts';
/**
 * ⚠️ O pacote INTEIRO, pela sua porta pública — a única forma de provar que uma
 * adição do passo 11 realmente sai por `index.ts` (que re-exporta por wildcard).
 */
import * as pacote from '../src/index';
import {
  SHOPEE_CONDITION,
  SHOPEE_INVOICE_FILE_TYPE_XML,
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_ITEM_PROMOTION_MAX_IDS,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_ITEM_VIOLATION_MAX_IDS,
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_MODEL_SKU_MAX_LENGTH,
  SHOPEE_TIER_MAX_OPTIONS,
  SHOPEE_UNLIST_MAX_ITEMS,
  SHOPEE_UPDATE_PRICE_MAX_MODELS,
  SHOPEE_UPDATE_STOCK_MAX_MODELS,
  SHOPEE_UPLOAD_IMAGE_FIELD,
  SHOPEE_UPLOAD_IMAGE_MAX_BYTES,
  SHOPEE_UPLOAD_IMAGE_SCENE,
  SHOPEE_UPLOAD_IMAGE_SIGNING,
  SHOPEE_UPLOAD_INVOICE_DOC_CONTENT_TYPE,
  SHOPEE_UPLOAD_INVOICE_DOC_FIELD,
  SHOPEE_UPLOAD_INVOICE_DOC_FILENAME,
  SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES,
  SHOPEE_WAREHOUSE_TYPE,
  shopeeUpdatePriceSchema,
  shopeeUpdateStockSchema,
} from '../src/types';
import {
  SHOPEE_CREATE_SHIPPING_DOCUMENT_PATH,
  SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH,
  SHOPEE_FULFILLMENT_TYPE_FILTRO,
  SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER_PATH,
  SHOPEE_GET_SHIPPING_DOCUMENT_RESULT_PATH,
  SHOPEE_GET_SHIPPING_PARAMETER_PATH,
  SHOPEE_GET_TRACKING_NUMBER_PATH,
  SHOPEE_ORDER_TYPE_FILTRO,
  SHOPEE_PACKAGE_SORT,
  SHOPEE_PACKAGE_STATUS_FILTRO,
  SHOPEE_SEARCH_PACKAGE_LIST_MAX_PAGE_SIZE,
  SHOPEE_SEARCH_PACKAGE_LIST_PATH,
  SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS,
  SHOPEE_SHIPPING_DOCUMENT_STATUS,
  SHOPEE_SHIP_ORDER_DROPOFF_VAZIO,
  SHOPEE_SHIP_ORDER_PATH,
  type SearchPackageListParams,
  type ShipOrderParams,
  type ShopeeAlvoDePacote,
  assertSearchPackageListParams,
  falhaDaLinha,
} from '../src/logistica';
import {
  type GetReturnListParams,
  type OfferReturnParams,
  SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_GET_RETURN_LIST_PATH,
  SHOPEE_RETURNS_ERROR_ALIASES,
  SHOPEE_RETURN_ACCEPT_OFFER_PATH,
  SHOPEE_RETURN_CONFIRM_PATH,
  SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
  SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS,
  SHOPEE_RETURN_OFFER_PATH,
  SHOPEE_RETURN_SOLUTION,
  assertAlvoDeDevolucao,
  assertOfferReturnParams,
  assertReturnListParams,
} from '../src/devolucoes';

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
    // grafias com que a página se contradiz; a junção por vírgula é uma ESCOLHA,
    // não uma limitação: desde o passo 9 `signedQuery` sabe emitir chave
    // repetida, e a página se contradiz sobre a grafia do NOME, não sobre a
    // forma.
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
      // ⚠️ `upload_image` (passo 11) é a QUINTA e é Public-signed: a página é
      // `type=Public`, e este é o cliente que nunca pede um access token.
      'uploadImage',
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

/* -------------------------------------------------------------------------- */
/*                  O detalhe do pedido e o escrow (passo 5)                   */
/* -------------------------------------------------------------------------- */

/** ⚠️ `order_sn` inventado, no formato da própria Shopee. Nunca um pedido real. */
const ORDER_SN = '220810QSK8S7BX';
const ORDER_SN_2 = '220810QSK8S7BY';

const ORDER_DETAIL_BODY = {
  request_id: 'req-detail',
  error: '',
  response: {
    order_list: [
      {
        order_sn: ORDER_SN,
        region: 'BR',
        currency: 'BRL',
        cod: false,
        order_status: 'READY_TO_SHIP',
        create_time: 1_760_000_000,
        update_time: 1_760_000_100,
        item_list: [
          {
            item_id: 846056136,
            model_id: 12984093,
            model_quantity_purchased: 2,
            model_discounted_price: 15,
          },
        ],
      },
    ],
  },
};

const ESCROW_DETAIL_BODY = {
  request_id: 'req-escrow',
  error: '',
  response: {
    order_sn: ORDER_SN,
    buyer_user_name: 'comprador-inventado',
    return_order_sn_list: [],
    order_income: { escrow_amount: 29.99, items: [] },
  },
};

/**
 * A lista COMPLETA de `response_optional_fields` que a página da Shopee aceita —
 * transcrita da própria página (31 entradas, com `buyer_username` repetido).
 *
 * ⚠️ É o que torna o teste do literal não-vacuoso: um token com erro de digitação
 * é IGNORADO em silêncio pela Shopee, e o campo volta ausente — que é
 * indistinguível de "a Shopee não mandou".
 */
const CAMPOS_OPCIONAIS_ACEITOS = [
  'buyer_user_id',
  'buyer_username',
  'estimated_shipping_fee',
  'recipient_address',
  'actual_shipping_fee',
  'goods_to_declare',
  'note',
  'note_update_time',
  'item_list',
  'pay_time',
  'dropshipper',
  'dropshipper_phone',
  'split_up',
  'buyer_cancel_reason',
  'cancel_by',
  'cancel_reason',
  'actual_shipping_fee_confirmed',
  'buyer_cpf_id',
  'fulfillment_flag',
  'pickup_done_time',
  'package_list',
  'shipping_carrier',
  'payment_method',
  'total_amount',
  'invoice_data',
  'order_chargeable_weight_gram',
  'return_request_due_date',
  'edt',
  'payment_info',
  'international_label',
] as const;

describe('get_order_detail', () => {
  it('vai por GET, junta os order_sn por vírgula e não repete a chave', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getOrderDetail({
      orderSnList: [ORDER_SN, ORDER_SN_2],
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/order/get_order_detail');
    expect([...url.searchParams.keys()].sort()).toEqual(
      [...CHAVES_COMUNS, 'order_sn_list', 'response_optional_fields'].sort(),
    );
    // Uma chave só, os dois valores dentro dela.
    expect(url.searchParams.getAll('order_sn_list')).toEqual([`${ORDER_SN},${ORDER_SN_2}`]);
  });

  it('manda os 22 campos opcionais juntos por vírgula, SEM espaço — o literal, caractere a caractere', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getOrderDetail({ orderSnList: [ORDER_SN] });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('response_optional_fields')).toBe(
      SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS,
    );
    expect(SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS).toBe(
      'item_list,recipient_address,buyer_cpf_id,buyer_username,buyer_user_id,pay_time,' +
        'payment_method,payment_info,total_amount,package_list,invoice_data,actual_shipping_fee,' +
        'estimated_shipping_fee,shipping_carrier,order_chargeable_weight_gram,cancel_by,' +
        'cancel_reason,buyer_cancel_reason,edt,pickup_done_time,fulfillment_flag,' +
        'return_request_due_date,note,note_update_time',
    );

    const tokens = SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS.split(',');
    expect(tokens).toHaveLength(24);
    // ⚠️ Sem espaço em lugar nenhum: a própria página imprime `actual_shipping_fee `
    // com um espaço sobrando na lista dela, e um token com espaço não casa.
    expect(SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS).not.toMatch(/\s/);
    expect(new Set(tokens).size).toBe(tokens.length);
    // Todo token nosso EXISTE na lista que a Shopee aceita — um typo volta como
    // campo ausente, nunca como erro.
    for (const token of tokens) {
      expect(CAMPOS_OPCIONAIS_ACEITOS, `token desconhecido: ${token}`).toContain(token);
    }
  });

  it('⚠️ NEAR-MISS: `international_label` ficou DE FORA de propósito; `note` ENTRA', () => {
    // `international_label` é aceito pela Shopee (está em CAMPOS_OPCIONAIS_ACEITOS)
    // e ficou de fora por decisão: o sinal do passo 5 é o `region` do PEDIDO.
    // `note`/`note_update_time` ENTRAM porque alimentam `observacoesInternas`:
    // um campo não nomeado volta AUSENTE, e o importador não passa lista própria.
    const tokens = SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS.split(',');
    expect(tokens).toContain('note');
    expect(tokens).toContain('note_update_time');
    expect(tokens).not.toContain('international_label');
    expect(CAMPOS_OPCIONAIS_ACEITOS).toContain('note');
    expect(CAMPOS_OPCIONAIS_ACEITOS).toContain('international_label');
  });

  it('⚠️ NEAR-MISS: uma lista informada pelo chamador SUBSTITUI a padrão, não soma', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getOrderDetail({
      orderSnList: [ORDER_SN],
      responseOptionalFields: ['item_list', 'note'],
    });

    const enviado = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get(
      'response_optional_fields',
    );
    expect(enviado).toBe('item_list,note');
    expect(enviado).not.toContain('recipient_address');
  });

  it('request_order_status_pending vai como a STRING "true" e é OMITIDO quando false', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getOrderDetail({ orderSnList: [ORDER_SN], requestOrderStatusPending: true });
    expect(
      new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('request_order_status_pending'),
    ).toBe('true');

    await client.getOrderDetail({ orderSnList: [ORDER_SN], requestOrderStatusPending: false });
    expect(
      new URL(String(fetchMock.mock.calls[1]![0])).searchParams.has('request_order_status_pending'),
    ).toBe(false);

    await client.getOrderDetail({ orderSnList: [ORDER_SN] });
    expect(
      new URL(String(fetchMock.mock.calls[2]![0])).searchParams.has('request_order_status_pending'),
    ).toBe(false);
  });

  it('recusa 0 e 51 order_sn ANTES de gastar uma chamada, e aceita as duas bordas boas', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const lista = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `2208${String(i).padStart(10, '0')}`);

    await expect(client.getOrderDetail({ orderSnList: [] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getOrderDetail({ orderSnList: lista(SHOPEE_ORDER_DETAIL_MAX_ORDER_SN + 1) }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.getOrderDetail({ orderSnList: lista(1) })).resolves.toBeDefined();
    await expect(
      client.getOrderDetail({ orderSnList: lista(SHOPEE_ORDER_DETAIL_MAX_ORDER_SN) }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(SHOPEE_ORDER_DETAIL_MAX_ORDER_SN).toBe(50);
  });

  it('recusa um order_sn em branco — ele viraria uma identidade só lá na frente', async () => {
    // ⚠️ A recusa não é sobre a Shopee (que responderia `error_param`): é sobre o
    // id determinístico do pedido, que colapsaria TODOS os brancos num documento.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getOrderDetail({ orderSnList: [''] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getOrderDetail({ orderSnList: [ORDER_SN, '  '] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // NEAR-MISS: o espaço é recusado, mas o order_sn de verdade PASSA inteiro —
    // nada é aparado antes de ir para o fio.
    await client.getOrderDetail({ orderSnList: [ORDER_SN] });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('order_sn_list')).toBe(
      ORDER_SN,
    );
  });

  it('desembrulha `response` — o envelope não chega ao chamador', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getOrderDetail({
      orderSnList: [ORDER_SN],
    });

    expect('error' in payload).toBe(false);
    expect('request_id' in payload).toBe(false);
    expect(payload.order_list[0]?.order_sn).toBe(ORDER_SN);
    expect(payload.order_list[0]?.order_status).toBe('READY_TO_SHIP');
    // Os opcionais que a Shopee não mandou chegam NULOS, nunca ausentes.
    expect(payload.order_list[0]?.recipient_address).toBeNull();
    expect(payload.order_list[0]?.invoice_data).toBeNull();
  });

  it('menos linhas do que order_sn pedidos é uma resposta VÁLIDA — quem reconcilia é o chamador', async () => {
    // ⚠️ Um order_sn que não é desta loja simplesmente não volta. Casar por
    // POSIÇÃO daria o pedido errado; o pacote não casa nada, só entrega a página.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ORDER_DETAIL_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getOrderDetail({
      orderSnList: [ORDER_SN, ORDER_SN_2],
    });
    expect(payload.order_list).toHaveLength(1);
    expect(payload.order_list[0]?.order_sn).toBe(ORDER_SN);
  });

  it('um erro no envelope vira ShopeeApiError mesmo com HTTP 200', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'req', error: 'error_param', message: 'Invalid order_sn_list' }),
    );
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getOrderDetail({ orderSnList: [ORDER_SN] }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });
});

describe('get_escrow_detail', () => {
  it('o literal decide VERBO e POSIÇÃO juntos — hoje é get-query', async () => {
    // ⚠️ A página declara `method: 2` (GET) e traz UM exemplo de requisição que é
    // um corpo JSON. Um GET com corpo nem sai do `fetch`, então "query ou corpo"
    // é na verdade "GET+query ou POST+corpo": UM literal, as duas metades.
    expect(SHOPEE_ESCROW_DETAIL_TRANSPORT).toBe('get-query');

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getEscrowDetail({ orderSn: ORDER_SN });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/payment/get_escrow_detail');
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS, 'order_sn'].sort());
    expect(url.searchParams.get('order_sn')).toBe(ORDER_SN);
  });

  it('o order_sn fica FORA da assinatura nas DUAS metades do par — virar o literal não pode dar error_sign', async () => {
    // ⚠️ MEDIDO, não suposto: a base string de loja é
    // `partner_id + path + timestamp + access_token + shop_id` (`sign.ts`) — sem
    // o verbo e sem os parâmetros da operação, na query ou no corpo. Então dois
    // order_sn diferentes dão o MESMO `sign` hoje (get-query) e dariam o mesmo
    // em post-body: um palpite errado do par aparece como `error_param`
    // ("Missing order_sn", que esta página documenta), nunca como `error_sign`.
    // É a mesma propriedade que `confirmConsumedLostPushMessages` fixa para o
    // corpo dele, e um "vamos assinar os parâmetros também" quebraria as duas.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getEscrowDetail({ orderSn: ORDER_SN });
    await client.getEscrowDetail({ orderSn: ORDER_SN_2 });

    const primeira = new URL(String(fetchMock.mock.calls[0]![0]));
    const segunda = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(primeira.searchParams.get('order_sn')).not.toBe(segunda.searchParams.get('order_sn'));
    expect(primeira.searchParams.get('sign')).toBe(segunda.searchParams.get('sign'));

    // NEAR-MISS na direção oposta: o que MUDA a assinatura é o que está na base
    // string. Trocar o access_token muda o `sign` do mesmo order_sn.
    const outro = createShopeeClient(
      shopConfig(fetchMock, () => Promise.resolve('outro-access-inventado')),
    );
    await outro.getEscrowDetail({ orderSn: ORDER_SN });
    expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get('sign')).not.toBe(
      primeira.searchParams.get('sign'),
    );
  });

  it('recusa um order_sn em branco ANTES da rede', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getEscrowDetail({ orderSn: '' })).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getEscrowDetail({ orderSn: '   ' })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('desembrulha `response` e entrega o order_income', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_DETAIL_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getEscrowDetail({
      orderSn: ORDER_SN,
    });

    expect('error' in payload).toBe(false);
    expect(payload.order_sn).toBe(ORDER_SN);
    expect(payload.order_income?.escrow_amount).toBe(29.99);
    expect(payload.buyer_payment_info).toBeNull();
  });

  it('`order_not_found` é um ShopeeApiError de kind `other` — permanente, não transitório', async () => {
    // ⚠️ É o erro específico DESTA página: o pedido não é desta loja ou não
    // existe. Classificar como transitório faria a fila repetir para sempre.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req',
        error: 'order_not_found',
        message: 'Order SN provided is invalid or does not belong to you.',
      }),
    );

    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getEscrowDetail({ orderSn: ORDER_SN })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('order_not_found');
    expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
  });

  it('⚠️ NEAR-MISS: um `error` com espaço continua sendo FALHA, como em toda operação sem alias', async () => {
    // A própria página imprime `"error": " "` no exemplo de resposta dela. Sem
    // `emptyErrorAliases`, só a string vazia é sucesso — e esta operação não tem
    // alias nenhum.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ESCROW_DETAIL_BODY, error: ' ' }),
    );
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getEscrowDetail({ orderSn: ORDER_SN }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });
});

/* -------------------------------------------------------------------------- */
/*                     A liquidação do escrow (passo 6)                        */
/* -------------------------------------------------------------------------- */

/** ⚠️ SEGUNDOS, como a página manda. Nada aqui converte unidade. */
const LIBERADO_DE_S = 1_651_680_000;
const LIBERADO_ATE_S = 1_651_939_200;

const PARAMS_LIQUIDACAO = {
  releaseTimeFromS: LIBERADO_DE_S,
  releaseTimeToS: LIBERADO_ATE_S,
} as const;

const ESCROW_LIST_BODY = {
  request_id: 'req-escrow-list',
  error: '',
  response: {
    escrow_list: [
      { order_sn: ORDER_SN, payout_amount: 30.7, escrow_release_time: 1_651_849_648 },
      { order_sn: ORDER_SN_2, payout_amount: 12.5, escrow_release_time: 1_651_849_700 },
    ],
    more: false,
  },
};

describe('get_escrow_list', () => {
  it('1 — vai por GET, sem corpo, no caminho da página e com as quatro chaves próprias na query', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/payment/get_escrow_list');
    expect(url.pathname).toBe(SHOPEE_GET_ESCROW_LIST_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual(
      [...CHAVES_COMUNS, 'release_time_from', 'release_time_to', 'page_size', 'page_no'].sort(),
    );
  });

  it('2 — os dois limites vão em SEGUNDOS, verbatim', async () => {
    // ⚠️ O pacote não converte unidade nenhuma: `apps/shopee` é o único lugar
    // onde s↔ms acontece. Um milissegundo chegando aqui viraria uma janela no
    // ano 54 000, e a Shopee devolveria uma página vazia — não um erro.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('release_time_from')).toBe('1651680000');
    expect(url.searchParams.get('release_time_to')).toBe('1651939200');
  });

  it('3 — os dois limites são OBRIGATÓRIOS e positivos: zero recusa ANTES da rede', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, releaseTimeFromS: 0 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, releaseTimeToS: 0 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, releaseTimeFromS: 1_651_680_000.5 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4 — ⚠️ NEAR-MISS: `from === to` é ACEITO aqui e RECUSADO no get_order_list — a mesma forma, duas páginas', async () => {
    // ⚠️ A divergência é da PÁGINA, não uma preferência: `get_order_list`
    // documenta uma janela (e o cliente recusa `time_from >= time_to`), enquanto
    // esta página só recusa "start date cannot be later than the end date". Uma
    // janela de largura zero é legal aqui — é o que a varredura semanal pede
    // quando já drenou até agora. Copiar o operador do vizinho a recusaria, e a
    // varredura simplesmente pararia de progredir sem erro nenhum.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, releaseTimeToS: LIBERADO_DE_S }),
    ).resolves.toBeDefined();
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('release_time_to')).toBe(
      '1651680000',
    );

    // O vizinho, com a forma IDÊNTICA, recusa.
    await expect(
      client.getOrderList({ ...PARAMS_PEDIDOS, timeToS: PARAMS_PEDIDOS.timeFromS }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);

    // E um segundo INVERTIDO recusa aqui também: `>` não é `>=`.
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, releaseTimeToS: LIBERADO_DE_S - 1 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5 — as bordas de page_size e page_no são checadas ANTES da rede', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    // As duas bordas boas.
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageSize: 1 }),
    ).resolves.toBeDefined();
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageSize: SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE }),
    ).resolves.toBeDefined();
    // NEAR-MISS em cada uma: um passo além recusa, nunca corta.
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageSize: 0 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getEscrowList({
        ...PARAMS_LIQUIDACAO,
        pageSize: SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE + 1,
      }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageSize: 20.5 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);

    await expect(client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageNo: 1 })).resolves.toBeDefined();
    await expect(client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageNo: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageNo: 1.5 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);

    // Só as TRÊS combinações válidas chegaram à rede; toda recusa é anterior.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('6 — os defaults são APLICADOS aqui e SEMPRE ENVIADOS', async () => {
    // ⚠️ Enviados, não omitidos: retomar na página 7 quer dizer "linhas 601–700"
    // com página de 100 e "241–280" com página de 40. Deixar a Shopee escolher o
    // tamanho faria um ponto de retomada guardado significar coisas diferentes
    // de um tick para o outro, sem nada dizer.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('page_size')).toBe('40');
    expect(url.searchParams.get('page_no')).toBe('1');
    expect(SHOPEE_ESCROW_LIST_DEFAULT_PAGE_SIZE).toBe(40);
    expect(SHOPEE_ESCROW_LIST_MAX_PAGE_SIZE).toBe(100);
  });

  it('7 — desembrulha `response`: o envelope não chega ao chamador', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    const page = await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    expect('error' in page).toBe(false);
    expect('request_id' in page).toBe(false);
    expect(page.more).toBe(false);
    expect(page.escrow_list).toHaveLength(2);
    expect(page.escrow_list[0]?.order_sn).toBe(ORDER_SN);
    // ⚠️ RAW: a unidade de `payout_amount` está em aberto (a tabela da página diz
    // float `"5733.04"`, o exemplo renderizado da MESMA página diz `57334`).
    expect(page.escrow_list[0]?.payout_amount).toBe(30.7);
    expect(page.escrow_list[0]?.escrow_release_time).toBe(1_651_849_648);
  });

  it('8 — uma linha ilegível vira `null` NO LUGAR e a chamada RESOLVE — as boas passam intactas', async () => {
    // ⚠️ Esta página é a ÚNICA fonte da liquidação. Uma linha malformada não pode
    // bloquear a semana inteira de dinheiro de todos os outros pedidos.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...ESCROW_LIST_BODY,
        response: {
          more: false,
          escrow_list: [
            { order_sn: ORDER_SN, payout_amount: 30.7, escrow_release_time: 1_651_849_648 },
            // `order_sn` em branco: sem identidade, não é linha.
            { order_sn: '', payout_amount: 1, escrow_release_time: 1_651_849_649 },
            { order_sn: ORDER_SN_2, payout_amount: 12.5, escrow_release_time: 1_651_849_700 },
          ],
        },
      }),
    );
    const page = await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    expect(page.escrow_list).toHaveLength(3);
    expect(page.escrow_list[1]).toBeNull();
    expect(page.escrow_list[0]?.order_sn).toBe(ORDER_SN);
    expect(page.escrow_list[2]?.order_sn).toBe(ORDER_SN_2);
    expect(page.escrow_list[2]?.payout_amount).toBe(12.5);
  });

  it('9 — ⚠️ NEAR-MISS: a sentinela é `null`, NUNCA `{}` — um objeto vazio pareceria uma linha', async () => {
    // A tolerância por ELEMENTO existe para ser CONTADA. Um `{}` teria a forma de
    // uma linha com todo campo em `null`, e o leitor a trataria como dado.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...ESCROW_LIST_BODY,
        response: { more: false, escrow_list: [{ order_sn: 42 }] },
      }),
    );
    const page = await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    expect(page.escrow_list[0]).toBeNull();
    expect(page.escrow_list[0]).not.toEqual({});
    expect(page.escrow_list.filter((linha) => linha === null)).toHaveLength(1);
  });

  it('10 — `more` é ESTRITO: a string "true" derruba o parse, o booleano passa', async () => {
    // ⚠️ É o ÚNICO sinal de término do laço. Coagir `"false"` ou giraria para
    // sempre ou truncaria uma janela em silêncio. A contagem de linhas não decide
    // nada — a página irmã devolve 10 linhas para `page_size: 20` com `more: true`.
    const comString = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ESCROW_LIST_BODY, response: { escrow_list: [], more: 'true' } }),
    );
    await expect(
      createShopeeClient(shopConfig(comString)).getEscrowList(PARAMS_LIQUIDACAO),
    ).rejects.toBeInstanceOf(ShopeeSchemaError);

    const comBooleano = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ESCROW_LIST_BODY, response: { escrow_list: [], more: false } }),
    );
    expect(
      (await createShopeeClient(shopConfig(comBooleano)).getEscrowList(PARAMS_LIQUIDACAO)).more,
    ).toBe(false);
  });

  it('11 — uma semana calada é o estado ORDINÁRIO: sem `escrow_list`, zero linhas', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ESCROW_LIST_BODY, response: { more: false } }),
    );
    const page = await createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO);

    expect(page.escrow_list).toEqual([]);
    expect(page.more).toBe(false);
  });

  it('12 — ⚠️ NEAR-MISS: um `error` com espaço continua sendo FALHA — esta operação não tem alias', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ESCROW_LIST_BODY, error: ' ' }),
    );
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getEscrowList(PARAMS_LIQUIDACAO),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('13 — `order_not_found` e `income_not_found` são ShopeeApiError de kind `other` — permanentes', async () => {
    // ⚠️ Classificar como transitório faria a varredura repetir a mesma janela
    // para sempre por causa de um pedido que nunca vai existir.
    for (const code of ['order_not_found', 'income_not_found'] as const) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ request_id: 'req', error: code, message: 'nao encontrado' }),
      );
      const erro = await createShopeeClient(shopConfig(fetchMock))
        .getEscrowList(PARAMS_LIQUIDACAO)
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ShopeeApiError);
      expect((erro as ShopeeApiError).code).toBe(code);
      expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
    }
  });

  it('14 — a assinatura NÃO depende dos parâmetros da operação; o access_token muda', async () => {
    // ⚠️ MEDIDO: a base string de loja é `partner_id + path + timestamp +
    // access_token + shop_id` (`sign.ts`) — sem verbo e sem os parâmetros. Duas
    // páginas diferentes dão o MESMO `sign`, então um parâmetro errado aparece
    // como `error_param`, nunca como `error_sign`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ESCROW_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getEscrowList(PARAMS_LIQUIDACAO);
    await client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageNo: 3, pageSize: 100 });

    const primeira = new URL(String(fetchMock.mock.calls[0]![0]));
    const segunda = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(primeira.searchParams.get('page_no')).not.toBe(segunda.searchParams.get('page_no'));
    expect(primeira.searchParams.get('sign')).toBe(segunda.searchParams.get('sign'));

    // NEAR-MISS na direção oposta: o que ESTÁ na base string muda a assinatura.
    const outro = createShopeeClient(
      shopConfig(fetchMock, () => Promise.resolve('outro-access-inventado')),
    );
    await outro.getEscrowList(PARAMS_LIQUIDACAO);
    expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get('sign')).not.toBe(
      primeira.searchParams.get('sign'),
    );
  });

  it('15 — não pagina sozinho: `more: true` gasta UMA chamada e o chamador pede a próxima página', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...ESCROW_LIST_BODY,
        response: { ...ESCROW_LIST_BODY.response, more: true },
      }),
    );
    const client = createShopeeClient(shopConfig(fetchMock));

    const primeira = await client.getEscrowList(PARAMS_LIQUIDACAO);
    expect(primeira.more).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.getEscrowList({ ...PARAMS_LIQUIDACAO, pageNo: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('page_no')).toBe('2');
  });
});

/* -------------------------------------------------------------------------- */
/*                   O detalhe do pacote (passo 7)                             */
/* -------------------------------------------------------------------------- */

/** ⚠️ Inventado, como todo id deste arquivo. Nunca um package_number real. */
const PACKAGE_NUMBER = 'OFG242672552205937';
const PACKAGE_NUMBER_2 = 'OFG242672552205938';

const PACKAGE_ROW = {
  order_sn: ORDER_SN,
  package_number: PACKAGE_NUMBER,
  fulfillment_status: 'LOGISTICS_READY',
  update_time: 1_661_950_674,
  logistics_channel_id: 90021,
  shipping_carrier: 'Entrega Turbo - M1020',
  days_to_ship: 3,
  ship_by_date: 1_662_209_873,
  // ⚠️ A sentinela da própria página. Chega VERBATIM; quem normaliza é a app.
  tracking_number: '-',
  is_shipment_arranged: false,
};

const PACKAGE_DETAIL_BODY = {
  request_id: 'req-package',
  error: '',
  response: {
    package_list: [
      PACKAGE_ROW,
      { ...PACKAGE_ROW, package_number: PACKAGE_NUMBER_2, tracking_number: 'BR123456789BR' },
    ],
  },
};

/** N números de pacote distintos, para as duas bordas de `limit [1,50]`. */
function pacotes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${PACKAGE_NUMBER}-${String(i)}`);
}

describe('get_package_detail', () => {
  it('1 — vai por GET, sem corpo, no caminho da página e com as quatro chaves comuns mais a própria', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER],
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/order/get_package_detail');
    expect(url.pathname).toBe(SHOPEE_GET_PACKAGE_DETAIL_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual(
      [...CHAVES_COMUNS, 'package_number_list'].sort(),
    );
  });

  it('2 — junta os números num ÚNICO `package_number_list`, com vírgula e SEM espaço, e não repete a chave', async () => {
    // ⚠️ O exemplo de requisição da própria página vem com vírgula (`…%2C…`) —
    // e desde o passo 9 `signedQuery` SABE emitir chave repetida, então a
    // grafia juntada aqui é uma escolha, não uma limitação. Um espaço depois da vírgula
    // viraria parte do próximo `package_number` e a Shopee devolveria a linha a
    // menos — sem erro nenhum.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER, PACKAGE_NUMBER_2],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('package_number_list')).toHaveLength(1);
    expect(url.searchParams.get('package_number_list')).toBe(
      `${PACKAGE_NUMBER},${PACKAGE_NUMBER_2}`,
    );
    expect(url.searchParams.get('package_number_list')).not.toContain(' ');
    expect(url.search).toContain(`package_number_list=${PACKAGE_NUMBER}%2C${PACKAGE_NUMBER_2}`);
  });

  it('3 — UM pacote viaja na MESMA chave, sem sufixo e sem vírgula sobrando', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('package_number_list')).toBe(PACKAGE_NUMBER);
    expect(url.searchParams.get('package_number_list')).not.toContain(',');
  });

  it('4 — recusa 0 e 51 pacotes ANTES da rede; aceita 1 e 50', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getPackageDetail({ packageNumbers: [] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getPackageDetail({
        packageNumbers: pacotes(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES + 1),
      }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    // As duas bordas BOAS passam — sem isto o teste acima passaria com um
    // cliente que recusasse tudo.
    await expect(
      client.getPackageDetail({ packageNumbers: [PACKAGE_NUMBER] }),
    ).resolves.toBeDefined();
    await expect(
      client.getPackageDetail({ packageNumbers: pacotes(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES) }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES).toBe(50);
  });

  it('5 — recusa um elemento em BRANCO nomeando a POSIÇÃO, antes da rede', async () => {
    // ⚠️ O parâmetro de wire é UM escalar juntado, então o `error_param` da
    // Shopee só poderia dizer que `package_number_list` está errado — nunca
    // qual elemento. A posição é a única coisa que o operador pode usar.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getPackageDetail({ packageNumbers: [PACKAGE_NUMBER, '  ', PACKAGE_NUMBER_2] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('posição 1');
    expect((erro as Error).message).toContain('package_number');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('6 — ⚠️ NEAR-MISS: recusa o elemento `"-"` e ACEITA `"-A"` e `"A-"`', async () => {
    // A sentinela é o VALOR INTEIRO, nunca um pedaço dele. `-` é como esta
    // página escreve "ausente" em `tracking_number`, `item_sku` e
    // `virtual_contact_number`; quem devolvesse um desses como chave estaria
    // pedindo "nenhum pacote". Um traço DENTRO do número é só um número.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const erro = await client.getPackageDetail({ packageNumbers: ['-'] }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('posição 0');
    // Espaçado dos dois lados é a MESMA sentinela — a comparação é depois do trim.
    await expect(client.getPackageDetail({ packageNumbers: [' - '] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Os dois quase-iguais passam, e chegam à query VERBATIM.
    await expect(client.getPackageDetail({ packageNumbers: ['-A'] })).resolves.toBeDefined();
    await expect(client.getPackageDetail({ packageNumbers: ['A-'] })).resolves.toBeDefined();
    expect(
      new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('package_number_list'),
    ).toBe('-A');
    expect(
      new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('package_number_list'),
    ).toBe('A-');
  });

  it('6 — ⚠️ o elemento vai TRIMADO para a query: quem julga e quem envia leem a MESMA string', async () => {
    // ⚠️ As recusas julgam o elemento APARADO (`numero.trim() === ''`,
    // `=== '-'`), então enviar o cru seria recusar sobre uma string e pedir
    // outra: ` OFG…937 ` passa por todas elas e sairia como `%20OFG…937%20` —
    // uma chave que a Shopee não tem. E a resposta não é erro nenhum: vêm as
    // linhas dos pacotes que ela reconheceu, uma a menos, sem sinal em lugar
    // nenhum.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [` ${PACKAGE_NUMBER} `, `\t${PACKAGE_NUMBER_2}`],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('package_number_list')).toBe(
      `${PACKAGE_NUMBER},${PACKAGE_NUMBER_2}`,
    );
    // ⚠️ O valor CODIFICADO, porque é ele que viaja — e `URLSearchParams`
    // escreve espaço como `+`, nunca como `%20`, então é `+` que não pode
    // aparecer (a tabulação vira `%09`). Um teste que procurasse `%20` passaria
    // verde sobre a query errada.
    expect(url.search).toContain(`package_number_list=${PACKAGE_NUMBER}%2C${PACKAGE_NUMBER_2}`);
    expect(url.search).not.toContain('+');
    expect(url.search).not.toContain('%09');

    // ⚠️ QUASE-ERRO: o aparo é SÓ nas pontas. Um espaço NO MEIO do valor é parte
    // do valor e viaja verbatim — aparar por dentro seria inventar um pacote.
    await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [' OFG 111 '],
    });
    expect(
      new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('package_number_list'),
    ).toBe('OFG 111');
  });

  it('6 — QUASE-ERRO: um elemento SÓ de espaços continua recusado ANTES da rede', async () => {
    // A âncora do caso acima: o aparo no envio não pode ter virado uma forma de
    // um elemento em branco chegar à query como string vazia — e nem de a
    // SENTINELA espaçada chegar como `-`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(
      client.getPackageDetail({ packageNumbers: [PACKAGE_NUMBER, ' \t '] }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(client.getPackageDetail({ packageNumbers: [' - '] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7 — recusa um elemento com VÍRGULA antes da rede: ela é o separador', async () => {
    // Um elemento com vírgula viraria DOIS parâmetros em silêncio, e a resposta
    // traria uma linha que ninguém pediu no lugar da que se pediu.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getPackageDetail({ packageNumbers: [`${PACKAGE_NUMBER},${PACKAGE_NUMBER_2}`] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('vírgula');
    expect((erro as Error).message).toContain('posição 0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('8 — desembrulha `response`: o envelope não chega ao chamador', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER, PACKAGE_NUMBER_2],
    });

    expect('error' in detalhe).toBe(false);
    expect('request_id' in detalhe).toBe(false);
    expect(detalhe.package_list).toHaveLength(2);
    expect(detalhe.package_list[0]?.package_number).toBe(PACKAGE_NUMBER);
    expect(detalhe.package_list[0]?.fulfillment_status).toBe('LOGISTICS_READY');
    // ⚠️ VERBATIM: a sentinela `-` atravessa o pacote e é a app que a dobra.
    expect(detalhe.package_list[0]?.tracking_number).toBe('-');
    expect(detalhe.package_list[1]?.tracking_number).toBe('BR123456789BR');
  });

  it('9 — ⚠️ aceita `"error": "-"` como SUCESSO nesta operação', async () => {
    // A página contradiz a si mesma: a tabela de parâmetros diz "Empty if no
    // error happened" e o exemplo renderizado imprime `-` em `error`, `message`
    // E `warning`. A tolerância é por OPERAÇÃO porque a contradição é por PÁGINA.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...PACKAGE_DETAIL_BODY, error: '-', message: '-', warning: '-' }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER],
    });

    expect(detalhe.package_list).toHaveLength(2);
    expect(SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES).toEqual(['-']);
  });

  it('10 — ⚠️ NEAR-MISS: `"error": " "` (um espaço) continua sendo FALHA aqui', async () => {
    // Igualdade EXATA contra cada alias, nunca um trim: um valor com espaço lido
    // como sucesso faria um corpo de falha (que não traz `response`) chegar ao
    // desembrulho.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...PACKAGE_DETAIL_BODY, error: ' ' }),
    );
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
        packageNumbers: [PACKAGE_NUMBER],
      }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('11 — ⚠️ NEAR-MISS: o MESMO `"error": "-"` NÃO é sucesso no get_order_detail', async () => {
    // O alias é da OPERAÇÃO. O irmão mais próximo — a outra leitura de pedido,
    // no mesmo módulo `order` — não o tem, e um alias global apagaria a
    // diferença.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ORDER_DETAIL_BODY, error: '-' }),
    );
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getOrderDetail({ orderSnList: [ORDER_SN] }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('12 — a assinatura NÃO depende de `package_number_list`; o access_token muda', async () => {
    // ⚠️ MEDIDO: a base string de loja é `partner_id + path + timestamp +
    // access_token + shop_id` (`sign.ts`) — sem verbo e sem os parâmetros da
    // operação. Dois conjuntos de pacotes dão o MESMO `sign`, então um número
    // errado aparece como `error_param`, nunca como `error_sign`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PACKAGE_DETAIL_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getPackageDetail({ packageNumbers: [PACKAGE_NUMBER] });
    await client.getPackageDetail({ packageNumbers: [PACKAGE_NUMBER_2, PACKAGE_NUMBER] });

    const primeira = new URL(String(fetchMock.mock.calls[0]![0]));
    const segunda = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(primeira.searchParams.get('package_number_list')).not.toBe(
      segunda.searchParams.get('package_number_list'),
    );
    expect(primeira.searchParams.get('sign')).toBe(segunda.searchParams.get('sign'));

    // NEAR-MISS na direção oposta: o que ESTÁ na base string muda a assinatura.
    const outro = createShopeeClient(
      shopConfig(fetchMock, () => Promise.resolve('outro-access-inventado')),
    );
    await outro.getPackageDetail({ packageNumbers: [PACKAGE_NUMBER] });
    expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get('sign')).not.toBe(
      primeira.searchParams.get('sign'),
    );
  });

  it('13 — uma linha ILEGÍVEL vira `null` NO LUGAR e as boas passam intactas', async () => {
    // ⚠️ Esta chamada é em lote até 50. Um pacote malformado não pode custar os
    // outros 49 — e a sentinela existe para ser CONTADA pelo braço do passo 7.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...PACKAGE_DETAIL_BODY,
        response: {
          package_list: [
            PACKAGE_ROW,
            // `package_number` em branco: sem identidade, não é pacote.
            { ...PACKAGE_ROW, package_number: '' },
            { ...PACKAGE_ROW, package_number: PACKAGE_NUMBER_2 },
          ],
        },
      }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER, PACKAGE_NUMBER_2],
    });

    expect(detalhe.package_list).toHaveLength(3);
    expect(detalhe.package_list[1]).toBeNull();
    expect(detalhe.package_list[0]?.package_number).toBe(PACKAGE_NUMBER);
    expect(detalhe.package_list[2]?.package_number).toBe(PACKAGE_NUMBER_2);
    expect(detalhe.package_list.filter((linha) => linha === null)).toHaveLength(1);
  });

  it('14 — ⚠️ NEAR-MISS: a sentinela é `null`, NUNCA `{}` — um objeto vazio pareceria uma linha', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...PACKAGE_DETAIL_BODY,
        response: { package_list: [{ package_number: 42 }] },
      }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER],
    });

    expect(detalhe.package_list[0]).toBeNull();
    expect(detalhe.package_list[0]).not.toEqual({});
  });

  it('15 — MENOS linhas do que se pediu é resposta VÁLIDA: o chamador reconcilia por package_number', async () => {
    // ⚠️ Nunca por posição. Aqui a única linha devolvida é a SEGUNDA que se
    // pediu; ler `package_list[0]` como "a primeira que pedi" trocaria os dois
    // pacotes de pedido.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...PACKAGE_DETAIL_BODY,
        response: { package_list: [{ ...PACKAGE_ROW, package_number: PACKAGE_NUMBER_2 }] },
      }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER, PACKAGE_NUMBER_2],
    });

    expect(detalhe.package_list).toHaveLength(1);
    expect(detalhe.package_list[0]?.package_number).toBe(PACKAGE_NUMBER_2);
    expect(
      detalhe.package_list.find((linha) => linha?.package_number === PACKAGE_NUMBER),
    ).toBeUndefined();
  });

  it('16 — sem a chave `package_list`, zero linhas — nunca um corpo malformado', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...PACKAGE_DETAIL_BODY, response: {} }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: [PACKAGE_NUMBER],
    });

    expect(detalhe.package_list).toEqual([]);
  });

  it('17 — `error_param`, `error_not_found` e `error_data` são ShopeeApiError de kind `other` — permanentes', async () => {
    // ⚠️ Classificar como transitório faria a fila repetir para sempre a entrega
    // de um pacote que a Shopee já disse não conhecer.
    for (const code of ['error_param', 'error_not_found', 'error_data'] as const) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ request_id: 'req', error: code, message: 'parametro invalido' }),
      );
      const erro = await createShopeeClient(shopConfig(fetchMock))
        .getPackageDetail({ packageNumbers: [PACKAGE_NUMBER] })
        .catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ShopeeApiError);
      expect((erro as ShopeeApiError).code).toBe(code);
      expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
    }
  });

  it('18 — NÃO pagina sozinho: uma chamada, uma lista — esta página não tem cursor nem `more`', async () => {
    const cheia = Array.from({ length: SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES }, (_, i) => ({
      ...PACKAGE_ROW,
      package_number: `${PACKAGE_NUMBER}-${String(i)}`,
    }));
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...PACKAGE_DETAIL_BODY, response: { package_list: cheia } }),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getPackageDetail({
      packageNumbers: pacotes(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES),
    });

    // Uma página CHEIA não faz o cliente pedir outra.
    expect(detalhe.package_list).toHaveLength(SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect('more' in detalhe).toBe(false);
    expect('next_cursor' in detalhe).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                     As quatro leituras de item (passo 9)                    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Ids de FIXTURE. Os dois que vêm dos samples das próprias páginas públicas
 * da Shopee (`2500139861`, `2000458802`) são exemplos de documentação.
 */
const ITEM_ID = 2500139861;
const ITEM_ID_2 = 2500139862;
const MODEL_ID = 2000458802;

const ITEM_LIST_BODY = {
  request_id: 'req-item-list',
  error: '',
  response: {
    item: [{ item_id: ITEM_ID, item_status: 'NORMAL', update_time: 1_608_128_470 }],
    total_count: 19,
    has_next_page: false,
    next_offset: 10,
  },
};

const ITEM_BASE_BODY = {
  request_id: 'req-item-base',
  error: '',
  response: {
    item_list: [{ item_id: ITEM_ID, item_name: 'Vestido longo', item_sku: 'VL-001' }],
  },
};

const MODEL_LIST_BODY = {
  request_id: 'req-model',
  error: '',
  response: {
    tier_variation: [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
    model: [{ model_id: MODEL_ID, tier_index: [0], model_sku: 'VL-001-AZ' }],
  },
};

const KIT_BODY = {
  request_id: 'req-kit',
  error: '',
  response: {
    product_info: { item_id: ITEM_ID, item_name: 'Kit de teste', model_list: [] },
  },
};

/** N ids distintos, para as duas bordas de `limit [1,50]`. */
function ids(n: number): number[] {
  return Array.from({ length: n }, (_, i) => ITEM_ID + i);
}

/** O CÓDIGO-FONTE do cliente, para a asserção que só a fonte pode fazer. */
const FONTE_API = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const FONTE_API_TEST = readFileSync(new URL('./api.test.ts', import.meta.url), 'utf8');
/** E o dos SCHEMAS, para as duas constantes que precisam continuar SEPARADAS. */
const FONTE_TYPES = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

describe('get_item_list', () => {
  it('31 — vai por GET, shop-signed, sem corpo, no seu caminho e com os comuns na query', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const pagina = await createShopeeClient(shopConfig(fetchMock)).getItemList({
      offset: 0,
      pageSize: 100,
      statuses: ['NORMAL'],
    });

    // WRAPPED: o envelope não chega ao chamador.
    expect(pagina.has_next_page).toBe(false);
    expect(pagina.next_offset).toBe(10);
    expect('error' in pagina).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe('/api/v2/product/get_item_list');
    expect(url.pathname).toBe(SHOPEE_GET_ITEM_LIST_PATH);
    expect([...new Set(url.searchParams.keys())].sort()).toEqual(
      [...CHAVES_COMUNS, 'item_status', 'offset', 'page_size'].sort(),
    );
    expect(url.searchParams.get('page_size')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');
  });

  it('32 — manda `item_status` REPETIDO: uma chave por status, na ordem pedida', async () => {
    // ⚠️ A única frase explícita sobre repetição em todo o corpus está nesta
    // página: "please upload the url like this: item_status=NORMAL&item_status=BANNED".
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getItemList({
      offset: 0,
      pageSize: 100,
      statuses: ['NORMAL', 'UNLIST'],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('item_status')).toEqual(['NORMAL', 'UNLIST']);
    expect(url.search).toContain('item_status=NORMAL&item_status=UNLIST');
  });

  it('33 — ⛔ NEAR-MISS: NÃO junta os status por vírgula', async () => {
    // ⚠️ A grafia por vírgula não está documentada em lugar nenhum para este
    // parâmetro, e um `item_status=NORMAL,UNLIST` voltaria como
    // `error_param_item_status` — que se lê como falha da Shopee.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getItemList({
      offset: 0,
      pageSize: 100,
      statuses: ['NORMAL', 'UNLIST'],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('item_status')).not.toBe('NORMAL,UNLIST');
    expect(url.searchParams.getAll('item_status')).toHaveLength(2);
    expect(url.search).not.toContain('NORMAL%2CUNLIST');
  });

  it('34 — o sign de uma chamada com DOIS status é IGUAL ao de uma com um', async () => {
    // ⚠️ FOLD, par IGUAL: a base string é partner_id + path + timestamp + token
    // + shop_id e não lê parâmetro nenhum da operação. Quem "consertar" isso
    // quebra as quatro leituras de uma vez, com `error_sign` — que aponta para
    // credencial, nunca para cá.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    await client.getItemList({ offset: 0, pageSize: 100, statuses: ['NORMAL'] });
    await client.getItemList({ offset: 0, pageSize: 100, statuses: ['NORMAL', 'UNLIST'] });

    const signUm = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('sign');
    const signDois = new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('sign');
    expect(signDois).toBe(signUm);
    // ⛔ NEAR-MISS: e a QUERY, essa sim, é diferente.
    expect(String(fetchMock.mock.calls[1]![0])).not.toBe(String(fetchMock.mock.calls[0]![0]));
  });

  it('35 — recusa uma lista de status VAZIA antes da rede', async () => {
    // ⚠️ `signedQuery` não emite chave nenhuma para um array vazio, então sem
    // esta recusa um parâmetro OBRIGATÓRIO simplesmente não sairia e a Shopee
    // responderia `error_param_item_status`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getItemList({ offset: 0, pageSize: 100, statuses: [] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('item_status');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('35b — recusa um status REPETIDO antes da rede', async () => {
    // Não custa nada no wire, mas é sempre bug de quem chama — e quem repete um
    // status está quase sempre montando a lista duas vezes.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getItemList({ offset: 0, pageSize: 100, statuses: ['NORMAL', 'NORMAL'] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('posição 1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('36 — ⛔ NEAR-MISS: recusa `"normal"` minúsculo — o enum do request é sensível a CAIXA', async () => {
    // ⚠️ FOLD, quase-igual: o enum da Shopee é MAIÚSCULO. Dobrar a caixa aqui
    // faria este cliente aceitar uma grafia que só ele entende.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const erro = await client
      .getItemList({
        offset: 0,
        pageSize: 100,
        statuses: ['normal' as ShopeeItemStatusWire],
      })
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('posição 0');
    expect(fetchMock).not.toHaveBeenCalled();

    // ÂNCORA: os SEIS valores de wire passam.
    await expect(
      client.getItemList({
        offset: 0,
        pageSize: 100,
        statuses: Object.values(SHOPEE_ITEM_STATUS_WIRE),
      }),
    ).resolves.toBeDefined();
    expect(Object.values(SHOPEE_ITEM_STATUS_WIRE)).toHaveLength(6);
  });

  it('37 — recusa `page_size` 0 e 101, aceita 1 e 100', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const base = { offset: 0, statuses: ['NORMAL'] as const };

    await expect(client.getItemList({ ...base, pageSize: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(
      client.getItemList({ ...base, pageSize: SHOPEE_MAX_PAGE_SIZE + 1 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.getItemList({ ...base, pageSize: 1 })).resolves.toBeDefined();
    await expect(
      client.getItemList({ ...base, pageSize: SHOPEE_MAX_PAGE_SIZE }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(SHOPEE_MAX_PAGE_SIZE).toBe(100);
  });

  it('38 — aceita `offset: 0`: a primeira página é offset zero, não um id positivo', async () => {
    // ⚠️ O leitor de ids (`assertIdPositivo`) recusaria 0 — e recusaria a
    // PRIMEIRA página de toda varredura. São dois parâmetros diferentes.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(
      client.getItemList({ offset: 0, pageSize: 10, statuses: ['NORMAL'] }),
    ).resolves.toBeDefined();
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('offset')).toBe('0');

    // E um offset NEGATIVO ou fracionário continua sendo bug de quem chama.
    await expect(
      client.getItemList({ offset: -1, pageSize: 10, statuses: ['NORMAL'] }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getItemList({ offset: 1.5, pageSize: 10, statuses: ['NORMAL'] }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('39 — recusa `update_time_to <= update_time_from` antes da rede', async () => {
    // ⚠️ ESTRITO: `error_update_time_range` diz "should be LATER than", ao
    // contrário do `get_escrow_list`, cuja página aceita janela de largura zero.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const base = { offset: 0, pageSize: 10, statuses: ['NORMAL'] as const };

    await expect(
      client.getItemList({ ...base, updateTimeFromS: 1_700_000_000, updateTimeToS: 1_700_000_000 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getItemList({ ...base, updateTimeFromS: 1_700_000_001, updateTimeToS: 1_700_000_000 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    // ⚠️ Um valor em MILISSEGUNDOS PASSA: a unidade vive no NOME do campo e este
    // pacote não converte nenhuma (o precedente é `GetOrderListParams`). O
    // guarda só recusa não-inteiro, `<= 0` e a janela invertida — e é `0` que a
    // linha abaixo exercita, não um valor em ms.
    await expect(client.getItemList({ ...base, updateTimeFromS: 0 })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // ÂNCORA: a janela válida passa e viaja em SEGUNDOS, verbatim.
    await expect(
      client.getItemList({ ...base, updateTimeFromS: 1_700_000_000, updateTimeToS: 1_700_086_400 }),
    ).resolves.toBeDefined();
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('update_time_from')).toBe('1700000000');
    expect(url.searchParams.get('update_time_to')).toBe('1700086400');
  });

  it('40 — omite `update_time_*` quando a opção não os traz', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_LIST_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getItemList({
      offset: 0,
      pageSize: 10,
      statuses: ['NORMAL'],
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has('update_time_from')).toBe(false);
    expect(url.searchParams.has('update_time_to')).toBe(false);
  });
});

describe('get_item_base_info', () => {
  it('41 — junta os ids com VÍRGULA e manda `need_tax_info=true`', async () => {
    // ⚠️ Sem `need_tax_info` o bloco fiscal BR (NCM/CEST/CSOSN/origem) nunca
    // chega — foi exatamente o que o legado nunca pediu.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    const lido = await createShopeeClient(shopConfig(fetchMock)).getItemBaseInfo({
      itemIds: [ITEM_ID, ITEM_ID_2],
    });
    expect(lido.item_list[0]!.item_sku).toBe('VL-001');
    expect('error' in lido).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(url.pathname).toBe(SHOPEE_GET_ITEM_BASE_INFO_PATH);
    expect(url.searchParams.getAll('item_id_list')).toHaveLength(1);
    expect(url.searchParams.get('item_id_list')).toBe(`${String(ITEM_ID)},${String(ITEM_ID_2)}`);
    expect(url.searchParams.get('item_id_list')).not.toContain(' ');
    expect(url.searchParams.get('need_tax_info')).toBe('true');
  });

  it('42 — ⛔ NEAR-MISS: NÃO manda `need_complaint_policy`', async () => {
    // ⚠️ Esse bloco é só da Polônia. Para uma loja BR é peso de corpo e nada
    // mais — e um `false` explícito ainda seria um parâmetro a mais na query.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getItemBaseInfo({ itemIds: [ITEM_ID] });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.has('need_complaint_policy')).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(
      [...CHAVES_COMUNS, 'item_id_list', 'need_tax_info'].sort(),
    );
  });

  it('43 — `encodeShopeeIdList` escreve as TRÊS grafias e a constante escolhe UMA', async () => {
    // ⚠️ A página do `get_item_base_info` samplea três grafias para o MESMO
    // parâmetro; as duas irmãs sampleiam uma quarta. O default é o precedente já
    // no ar (`category_id_list`, passo 10) e um literal só troca tudo.
    expect(encodeShopeeIdList([1, 2], 'bare-comma')).toBe('1,2');
    expect(encodeShopeeIdList([1, 2], 'bracket-comma')).toBe('[1,2]');
    expect(encodeShopeeIdList([1, 2], 'bracket-space')).toBe('[1 2]');
    expect(SHOPEE_ITEM_ID_LIST_ENCODING).toBe('bare-comma');
    expect(encodeShopeeIdList([1, 2])).toBe(
      encodeShopeeIdList([1, 2], SHOPEE_ITEM_ID_LIST_ENCODING),
    );

    // E é essa grafia que sai no wire.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getItemBaseInfo({ itemIds: [ITEM_ID] });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('item_id_list')).toBe(
      encodeShopeeIdList([ITEM_ID]),
    );
  });

  it('44 — recusa 0 ids e 51 ids; aceita 1 e 50', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await expect(client.getItemBaseInfo({ itemIds: [] })).rejects.toBeInstanceOf(ShopeeConfigError);
    await expect(
      client.getItemBaseInfo({ itemIds: ids(SHOPEE_ITEM_BASE_INFO_MAX_IDS + 1) }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.getItemBaseInfo({ itemIds: [ITEM_ID] })).resolves.toBeDefined();
    await expect(
      client.getItemBaseInfo({ itemIds: ids(SHOPEE_ITEM_BASE_INFO_MAX_IDS) }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(SHOPEE_ITEM_BASE_INFO_MAX_IDS).toBe(50);
  });

  it('45 — recusa um `item_id` 0 ou fracionário antes da rede, nomeando a POSIÇÃO', async () => {
    // ⚠️ O parâmetro de wire é UM escalar juntado, então o `error_param` da
    // Shopee só poderia dizer que `item_id_list` está errado — nunca qual id.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const erro = await client.getItemBaseInfo({ itemIds: [ITEM_ID, 0] }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('posição 1');

    await expect(client.getItemBaseInfo({ itemIds: [1.5] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    await expect(client.getItemBaseInfo({ itemIds: [-ITEM_ID] })).rejects.toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('get_model_list e get_kit_item_info', () => {
  it('46 — get_model_list manda só `item_id` e desembrulha `response`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(MODEL_LIST_BODY));
    const lido = await createShopeeClient(shopConfig(fetchMock)).getModelList({ itemId: ITEM_ID });

    expect(lido.model[0]!.model_id).toBe(MODEL_ID);
    expect(lido.tier_variation![0]!.name).toBe('Cor');
    expect('error' in lido).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(url.pathname).toBe(SHOPEE_GET_MODEL_LIST_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS, 'item_id'].sort());
    expect(url.searchParams.get('item_id')).toBe(String(ITEM_ID));

    // E um id impossível não gasta chamada nenhuma.
    await expect(
      createShopeeClient(shopConfig(fetchMock)).getModelList({ itemId: 0 }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('47 — get_kit_item_info usa o SEU caminho e nunca o de item', async () => {
    // ⚠️ Um kit nunca é lido pelo endpoint de item: os nomes de campo são
    // outros (`attributes`, `brand_info`, `pre_order_info`, `tier_variation_list`).
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(KIT_BODY));
    const lido = await createShopeeClient(shopConfig(fetchMock)).getKitItemInfo({
      itemId: ITEM_ID,
    });

    expect(lido.product_info?.item_id).toBe(ITEM_ID);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe(SHOPEE_GET_KIT_ITEM_INFO_PATH);
    expect(url.pathname).toBe('/api/v2/product/get_kit_item_info');
    expect(url.pathname).not.toBe(SHOPEE_GET_ITEM_BASE_INFO_PATH);
    expect(url.pathname).not.toBe(SHOPEE_GET_KIT_ITEM_LIMIT_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS, 'item_id'].sort());
  });
});

describe('os erros das quatro leituras de item', () => {
  /** As quatro, cada uma com o corpo que a faria ter sucesso. */
  const LEITURAS: readonly {
    readonly nome: string;
    readonly corpo: unknown;
    readonly chamar: (c: ShopeeClient) => Promise<unknown>;
  }[] = [
    {
      nome: 'getItemList',
      corpo: ITEM_LIST_BODY,
      chamar: (c) => c.getItemList({ offset: 0, pageSize: 10, statuses: ['NORMAL'] }),
    },
    {
      nome: 'getItemBaseInfo',
      corpo: ITEM_BASE_BODY,
      chamar: (c) => c.getItemBaseInfo({ itemIds: [ITEM_ID] }),
    },
    {
      nome: 'getModelList',
      corpo: MODEL_LIST_BODY,
      chamar: (c) => c.getModelList({ itemId: ITEM_ID }),
    },
    {
      nome: 'getKitItemInfo',
      corpo: KIT_BODY,
      chamar: (c) => c.getKitItemInfo({ itemId: ITEM_ID }),
    },
  ];

  it.each(LEITURAS)(
    '48 — ⛔ NEAR-MISS: `"error": "-"` NÃO é sucesso em $nome — o alias é por operação',
    async ({ chamar }) => {
      // ⚠️ Nenhuma das quatro páginas samplea `"-"`, então nenhuma delas carrega
      // `emptyErrorAliases`. A tolerância é opt-in por CALL SITE porque a
      // contradição é por PÁGINA.
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ request_id: 'r', error: '-', message: '-', response: null }),
      );
      const erro = await chamar(createShopeeClient(shopConfig(fetchMock))).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ShopeeApiError);
      expect((erro as ShopeeApiError).code).toBe('-');
    },
  );

  it('49 — o `error_param` do offset chega como ShopeeApiError com a MENSAGEM verbatim', async () => {
    // ⚠️ O valor do teto NÃO aparece em página nenhuma. Esta mensagem é tudo o
    // que existe, e ela é TERMINAL para uma varredura: a mitigação é uma janela
    // `update_time` mais estreita, nunca um retry.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: 'error_param',
        message: 'get items offset over limit, please use the next field',
        response: null,
      }),
    );
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getItemList({ offset: 10_000, pageSize: 100, statuses: ['NORMAL'] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_param');
    expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
    expect((erro as Error).message).toContain(
      'get items offset over limit, please use the next field',
    );
  });

  it('50 — `error_item_not_found` em get_model_list vira ShopeeApiError de kind `other`', async () => {
    // Recusa PERMANENTE sobre UM item, não falha transitória: reenfileirar não
    // faz o item voltar a existir.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: 'error_item_not_found', message: 'Item_id is not found.' }),
    );
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getModelList({ itemId: ITEM_ID })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeRateLimitError);
    expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
  });

  it('51 — `error_rate_limit` vira ShopeeRateLimitError de kind `burst`, com Retry-After', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: 'error_rate_limit', message: 'rate limit' }, 200, {
        'retry-after': '30',
      }),
    );
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getItemBaseInfo({ itemIds: [ITEM_ID] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeRateLimitError);
    expect((erro as ShopeeRateLimitError).kind).toBe(SHOPEE_ERROR_KIND.burst);
    expect((erro as ShopeeRateLimitError).retryAfterSeconds).toBe(30);
  });

  it('52 — `error_limit` vira kind `daily` — a outra metade do limite', async () => {
    // ⚠️ As duas querem respostas OPOSTAS: uma pausa curta contra esperar a
    // virada da cota. Por isso são kinds diferentes e não um só.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: 'error_limit', message: 'daily limit' }),
    );
    const erro = await createShopeeClient(shopConfig(fetchMock))
      .getItemList({ offset: 0, pageSize: 10, statuses: ['NORMAL'] })
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeeRateLimitError);
    expect((erro as ShopeeRateLimitError).kind).toBe(SHOPEE_ERROR_KIND.daily);
  });

  it('54 — o docblock de getAttributeTree não afirma mais que uma chave repetida é inexprimível', async () => {
    // ⚠️ Asserção de FONTE. Antes do passo 9 o comentário dizia, verbatim,
    // "`signedQuery` cannot emit a repeated key anyway, so the joined scalar is
    // the only shape available" — e a partir deste passo isso é FALSO. Um repo
    // que publica uma afirmação falsa sobre a própria capacidade é a classe de
    // defeito que este código-base paga para evitar.
    expect(FONTE_API).not.toContain('cannot emit a repeated key');
    expect(FONTE_API).not.toContain('não sabe emitir chave repetida');

    // ⚠️ E ESTE arquivo também: a afirmação falsa sobreviveu aqui uma vez
    // justamente porque a varredura só lia `src/api.ts`. A agulha é MONTADA por
    // concatenação — um literal contíguo faria esta linha ser, ela mesma, uma
    // ocorrência — e o radical `emite chave repetida` cobre as duas grafias
    // negativas sem casar com o `SABE emitir chave repetida` que é verdadeiro.
    const agulha = ['não ', 'emite chave repetida'].join('');
    expect(FONTE_API).not.toContain(agulha);
    expect(FONTE_API_TEST).not.toContain(agulha);

    const inicio = FONTE_API.indexOf('getAttributeTree: async');
    const fim = FONTE_API.indexOf('getBrandList: async');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const docblock = FONTE_API.slice(inicio, fim);
    expect(docblock).toContain('category_id_list');
    expect(docblock).toContain('repeated key IS expressible');

    // ÂNCORA de comportamento: a chave repetida realmente sai, e o escalar
    // juntado do `get_attribute_tree` continua sendo UMA chave só.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ATTRIBUTE_BODY));
    await createShopeeClient(shopConfig(fetchMock)).getAttributeTree({ categoryIds: [4321, 4322] });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.getAll('category_id_list')).toEqual(['4321,4322']);
  });
});

/* -------------------------------------------------------------------------- */
/*                    As doze escritas de anúncio (passo 11)                   */
/* -------------------------------------------------------------------------- */

/** O envelope PURO das quatro operações sem `response` (`flatOp({})`). */
const ACK_BODY = { request_id: 'req-ack', error: '', message: '', warning: '' };

const ADD_ITEM_BODY = {
  request_id: 'req-add',
  error: '',
  message: '',
  warning: '',
  response: {
    item_id: ITEM_ID,
    item_status: 'UNLIST',
    item_name: 'Camiseta de teste',
    // ⚠️ OBJETO aqui; nas páginas de LEITURA o mesmo nome é um ARRAY.
    price_info: { current_price: 49.9, original_price: 49.9 },
  },
};

const TIER_WRITE_BODY = {
  request_id: 'req-tier',
  error: '',
  response: {
    item_id: ITEM_ID,
    model: [
      { model_id: MODEL_ID, tier_index: [0], model_sku: 'AZ-P' },
      { model_id: MODEL_ID + 1, tier_index: [1], model_sku: 'AZ-M' },
    ],
  },
};

const UNLIST_BODY = {
  request_id: 'req-unlist',
  error: '',
  response: {
    success_list: [{ item_id: ITEM_ID, unlist: true }],
    failure_list: [{ item_id: ITEM_ID_2, failed_reason: 'error_item_not_found' }],
  },
};

const VIOLATION_BODY = {
  request_id: 'req-violation',
  error: '',
  response: {
    item_list: [
      {
        item_id: ITEM_ID,
        item_name: 'Camiseta de teste',
        item_status: 'BANNED',
        // ⚠️ Uma STRING, não um booleano — a grafia que o sandbox respondeu.
        deboost: 'FALSE',
        item_status_details: [
          {
            violation_type: 'PROHIBITED',
            violation_reason: 'motivo',
            suggestion: 'sugestão',
            fix_deadline_time: 1_770_000_000,
            update_time: 1_769_000_000,
          },
        ],
      },
    ],
  },
};

/**
 * O MESMO corpo, SEM a chave `error` — a forma que o sandbox respondeu em
 * 2026-09-17 (register 73) e que as duas amostras da própria página imprimem.
 */
const VIOLATION_BODY_SEM_ERROR = {
  message: null,
  request_id: 'req-violation',
  response: VIOLATION_BODY.response,
};

const CHANNEL_LIST_BODY = {
  request_id: 'req-canais',
  error: '',
  response: {
    logistics_channel_list: [
      {
        logistics_channel_id: 90021,
        logistics_channel_name: 'Canal de teste',
        enabled: true,
        fee_type: 'SIZE_SELECTION',
        // ⚠️ STRING no `get_channel_list` e int32 no `add_item`.
        size_list: [{ size_id: '1', name: 'P', default_price: 10.5 }],
        compulsory_channel: false,
      },
    ],
  },
};

const UPLOAD_BODY = {
  request_id: 'req-upload',
  error: '',
  warning: '',
  response: {
    image_info: {
      image_id: 'img-1',
      image_url_list: [{ image_url_region: 'BR', image_url: 'https://exemplo.test/img-1.jpg' }],
    },
    image_info_list: [
      { id: 0, error: '', message: '', image_info: { image_id: 'img-1' } },
      { id: 1, error: 'error_param', message: 'imagem inválida', image_info: null },
    ],
  },
};

function corpoAddItem(extra: Partial<ShopeeAddItemRequest> = {}): ShopeeAddItemRequest {
  return {
    item_name: 'Camiseta de teste',
    description: 'Uma descrição de teste com tamanho suficiente.',
    original_price: 49.9,
    weight: 0.3,
    category_id: 100182,
    image: { image_id_list: ['img-1'] },
    logistic_info: [{ logistic_id: 90021, enabled: true }],
    ...extra,
  };
}

function modelo(
  tierIndex: readonly number[],
  extra: Partial<ShopeeModelRequest> = {},
): ShopeeModelRequest {
  return {
    tier_index: tierIndex,
    original_price: 49.9,
    seller_stock: [{ stock: 3 }],
    ...extra,
  };
}

function tierPersonalizado(
  opcoes: number,
  extra: Partial<ShopeeStandardiseTierRequest> = {},
): ShopeeStandardiseTierRequest {
  return {
    // ⚠️ 0 = tier PERSONALIZADO — para uma loja BR fora de Moda, TODO tier é este.
    variation_id: 0,
    variation_name: 'Cor',
    variation_option_list: Array.from({ length: opcoes }, (_, i) => ({
      variation_option_name: `Opção ${String(i)}`,
    })),
    ...extra,
  };
}

/** O erro que uma chamada rejeitada devolve, sem encadear `expect().rejects`. */
async function erroDe(p: Promise<unknown>): Promise<unknown> {
  return p.catch((e: unknown) => e);
}

describe('add_item / update_item', () => {
  it('55 — addItem POSTa o corpo inteiro no seu caminho, shop-signed, e nada além dos comuns na query', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const corpo = corpoAddItem({ item_status: SHOPEE_ITEM_STATUS_WRITABLE.unlist });
    await createShopeeClient(shopConfig(fetchMock)).addItem(corpo);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('POST');
    expect(url.pathname).toBe('/api/v2/product/add_item');
    expect(url.pathname).toBe(SHOPEE_ADD_ITEM_PATH);
    // ⚠️ O corpo é o corpo do WIRE, verbatim: nada de espelho camelCase.
    expect(JSON.parse(String(init?.body))).toEqual(corpo);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('56 — o ENVELOPE inteiro chega ao chamador: o `warning` de add_item sobrevive', async () => {
    // ⚠️ Toda ESCRITA devolve o envelope, toda LEITURA desembrulha. O `warning` é
    // o canal de falha PARCIAL — a Shopee aceita o item e diz o que ignorou —, e
    // desembrulhar aqui o jogaria fora com 200 na mão.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ADD_ITEM_BODY, warning: 'atributo ignorado' }),
    );
    const res = await createShopeeClient(shopConfig(fetchMock)).addItem(corpoAddItem());

    expect(res.warning).toBe('atributo ignorado');
    expect(res.request_id).toBe('req-add');
    expect(res.response.item_id).toBe(ITEM_ID);
  });

  it('57 — updateItem manda `logistic_info` quando informado', async () => {
    // ⚠️ O campo está AUSENTE da tabela de request da página e PRESENTE nos cinco
    // samples dela, em três dos seus próprios códigos de erro e no
    // `announcement 1395`. Quem "limpar" o tipo derruba a republicação inteira.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    await createShopeeClient(shopConfig(fetchMock)).updateItem({
      item_id: ITEM_ID,
      logistic_info: [{ logistic_id: 90021, enabled: true, is_free: false }],
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(rawUrl)).pathname).toBe(SHOPEE_UPDATE_ITEM_PATH);
    expect(JSON.parse(String(init?.body))).toEqual({
      item_id: ITEM_ID,
      logistic_info: [{ logistic_id: 90021, enabled: true, is_free: false }],
    });
  });

  it('58 — updateItem recusa um corpo que só carrega item_id, antes da rede', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateItem({ item_id: ITEM_ID }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('item_id');
    expect(fetchMock).not.toHaveBeenCalled();

    // ⚠️ QUASE-ERRO: uma chave PRESENTE com valor `undefined` é o MESMO corpo na
    // rede — `JSON.stringify` a descarta e o que sai é `{"item_id":N}`. O repo não
    // liga `exactOptionalPropertyTypes`, então `item_name: nome ?? undefined`
    // compila, e uma guarda que contasse CHAVES deixaria passar exatamente a
    // chamada gasta que ela existe para recusar.
    const soUndefined = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateItem({
        item_id: ITEM_ID,
        item_name: undefined,
      }),
    );

    expect(soUndefined).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: a MESMA chave com valor de verdade passa, e o corpo leva os dois campos.
    await createShopeeClient(shopConfig(fetchMock)).updateItem({
      item_id: ITEM_ID,
      item_name: 'Camiseta de teste',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      item_id: ITEM_ID,
      item_name: 'Camiseta de teste',
    });
  });

  it('59 — addItem ACEITA brand_id 0 ("No Brand") e value_id 0 com original_value_name', async () => {
    // ⚠️ `assertIdPositivo` aqui recusaria a marca padrão do catálogo inteiro:
    // `brand_id: 0` é DADO ("No Brand"), nunca ausência. Mesmo raciocínio para o
    // `value_id: 0`, que é a sentinela de valor PERSONALIZADO.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    await createShopeeClient(shopConfig(fetchMock)).addItem(
      corpoAddItem({
        brand: { brand_id: 0, original_brand_name: 'No Brand' },
        attribute_list: [
          {
            attribute_id: 100003,
            attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }],
          },
        ],
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('60 — ⛔ QUASE-IGUAL: addItem recusa value_id 0 SEM original_value_name', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).addItem(
        corpoAddItem({
          attribute_list: [{ attribute_id: 100003, attribute_value_list: [{ value_id: 0 }] }],
        }),
      ),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('original_value_name');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('61 — addItem recusa image_id_list vazia, com 10 ids e com um id em branco', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const demais = Array.from({ length: SHOPEE_ITEM_IMAGE_MAX + 1 }, (_, i) => `img-${String(i)}`);

    for (const lista of [[], demais, ['img-1', '   ']]) {
      const erro = await erroDe(client.addItem(corpoAddItem({ image: { image_id_list: lista } })));
      expect(erro).toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('62 — addItem recusa item_status e condition fora dos enums de ESCRITA', async () => {
    // ⚠️ `BANNED` é um estado que um item PODE TER e que nenhuma escrita pode
    // dizer — por isso o enum gravável tem dois membros, e não os seis da leitura.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const status = await erroDe(
      client.addItem(
        corpoAddItem({
          item_status: 'BANNED' as unknown as typeof SHOPEE_ITEM_STATUS_WRITABLE.normal,
        }),
      ),
    );
    const condicao = await erroDe(
      client.addItem(
        corpoAddItem({ condition: 'REFURBISHED' as unknown as typeof SHOPEE_CONDITION.new }),
      ),
    );

    expect(status).toBeInstanceOf(ShopeeConfigError);
    expect(condicao).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: os membros dos dois enums de escrita passam.
    await client.addItem(
      corpoAddItem({
        item_status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
        condition: SHOPEE_CONDITION.new,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('63 — addItem recusa peso 0, preço 0 e logistic_info vazio', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADD_ITEM_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    for (const corpo of [
      corpoAddItem({ weight: 0 }),
      corpoAddItem({ original_price: 0 }),
      corpoAddItem({ logistic_info: [] }),
    ]) {
      expect(await erroDe(client.addItem(corpo))).toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tiers e modelos', () => {
  it('64 — initTierVariation POSTa no seu caminho e dois corpos diferentes dão o MESMO sign', async () => {
    // ⚠️ PAR IGUAL: a base string é partner_id + path + timestamp + token +
    // shop_id e não lê o corpo. Quem "assinar o corpo também" quebra as oito
    // escritas de uma vez, com `error_sign` — que aponta para credencial.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const tiers = [tierPersonalizado(2)];
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0]), modelo([1])],
      standardise_tier_variation: tiers,
    });
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0], { model_sku: 'OUTRO' }), modelo([1])],
      standardise_tier_variation: tiers,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe(SHOPEE_INIT_TIER_VARIATION_PATH);
    const signA = url.searchParams.get('sign');
    const signB = new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('sign');
    expect(signB).toBe(signA);
    // ⛔ QUASE-IGUAL: o CORPO, esse sim, é diferente.
    expect(String(fetchMock.mock.calls[1]![1]?.body)).not.toBe(
      String(fetchMock.mock.calls[0]![1]?.body),
    );
  });

  it('65 — os QUATRO contêineres de modelo têm nomes DIFERENTES', async () => {
    // ⚠️ `init_tier_variation.model`, `add_model.model_list`,
    // `update_model.model`, `update_tier_variation.model_list`. Unificar o nome é
    // o refactor "óbvio" que a Shopee responde com `error_param` em duas das
    // quatro páginas — e só em duas.
    // As duas escritas de UPDATE respondem o envelope puro; as duas de criação
    // respondem os modelos recém-criados.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url) =>
      jsonResponse(String(url).includes('/update_') ? ACK_BODY : TIER_WRITE_BODY),
    );
    const client = createShopeeClient(shopConfig(fetchMock));
    const modelos = [modelo([0])];

    await client.initTierVariation({ item_id: ITEM_ID, model: modelos });
    await client.addModel({ item_id: ITEM_ID, model_list: modelos });
    await client.updateModel({
      item_id: ITEM_ID,
      model: [{ model_id: MODEL_ID, model_sku: 'AZ-P' }],
    });
    await client.updateTierVariation({
      item_id: ITEM_ID,
      model_list: [{ model_id: MODEL_ID, tier_index: [0] }],
    });

    const chaves = fetchMock.mock.calls.map(([, init]) =>
      Object.keys(JSON.parse(String(init?.body)) as Record<string, unknown>).filter((k) =>
        k.startsWith('model'),
      ),
    );
    expect(chaves).toEqual([['model'], ['model_list'], ['model'], ['model_list']]);
  });

  it('66 — initTierVariation ACEITA variation_id 0 e variation_option_id 0', async () => {
    // ⚠️ Para uma loja BR fora de Moda, TODO variation_id e TODO
    // variation_option_id é 0: um `assertIdPositivo` aqui recusaria o catálogo
    // inteiro antes de qualquer chamada.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    await createShopeeClient(shopConfig(fetchMock)).initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0])],
      standardise_tier_variation: [
        {
          variation_id: 0,
          variation_name: 'Cor',
          variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Azul' }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('67 — PAR/QUASE-IGUAL: variation_id 0 EXIGE variation_name e variation_id != 0 o PROÍBE', async () => {
    // ⚠️ `announcement 873`, verbatim: "If you input variation_name &
    // variation_id, and variation_id != 0, it will not allow you to input
    // variation_name. … If variation_id = 0, then you must pass the
    // variation_name." Dois lados, duas recusas — uma regra só.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const semNome = await erroDe(
      client.initTierVariation({
        item_id: ITEM_ID,
        model: [modelo([0])],
        standardise_tier_variation: [
          tierPersonalizado(1, { variation_name: undefined as unknown as string }),
        ],
      }),
    );
    const comNomeDemais = await erroDe(
      client.initTierVariation({
        item_id: ITEM_ID,
        model: [modelo([0])],
        standardise_tier_variation: [
          tierPersonalizado(1, { variation_id: 100, variation_name: 'Cor' }),
        ],
      }),
    );

    expect(semNome).toBeInstanceOf(ShopeeConfigError);
    expect((semNome as Error).message).toContain('obrigatório');
    expect(comNomeDemais).toBeInstanceOf(ShopeeConfigError);
    expect((comNomeDemais as Error).message).toContain('PROIBIDO');
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: com variation_id != 0 e SEM nome, passa.
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0])],
      standardise_tier_variation: [
        { variation_id: 100, variation_option_list: [{ variation_option_name: 'Azul' }] },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('68 — initTierVariation ACEITA 21 opções num tier (medido) e recusa 51 modelos, 3 tiers e 51 opções', async () => {
    // ⚠️ Os números são LITERAIS de propósito: um teste escrito como `LIMITE + 1`
    // acompanharia qualquer valor, inclusive um trocado por engano.
    //
    // ⚠️ O 21 é o número que o probe do sandbox MEDIU em 2026-09-17: um
    // `update_tier_variation` cru com 21 opções num tier foi ACEITO
    // (`error: ''`). Era justamente esse o corpo que a guarda antiga recusava
    // antes de sair da nossa máquina — das duas frases contraditórias das mesmas
    // páginas (`error_tier_opt_too_many` com 20 e `error_param` com 50), a que
    // vale no fio é a de 50.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    expect(SHOPEE_MODEL_MAX_PER_ITEM).toBe(50);
    expect(SHOPEE_TIER_MAX_OPTIONS).toBe(50);

    // O corpo MEDIDO: 21 opções passam a guarda e a chamada acontece.
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0])],
      standardise_tier_variation: [tierPersonalizado(21)],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const demaisModelos = await erroDe(
      client.initTierVariation({
        item_id: ITEM_ID,
        model: Array.from({ length: 51 }, (_, i) => modelo([i])),
      }),
    );
    const tiersDemais = await erroDe(
      client.initTierVariation({
        item_id: ITEM_ID,
        model: [modelo([0, 0, 0])],
        standardise_tier_variation: [
          tierPersonalizado(1),
          tierPersonalizado(1),
          tierPersonalizado(1),
        ],
      }),
    );
    const opcoesDemais = await erroDe(
      client.initTierVariation({
        item_id: ITEM_ID,
        model: [modelo([0])],
        standardise_tier_variation: [tierPersonalizado(51)],
      }),
    );

    expect(demaisModelos).toBeInstanceOf(ShopeeConfigError);
    expect(tiersDemais).toBeInstanceOf(ShopeeConfigError);
    expect(opcoesDemais).toBeInstanceOf(ShopeeConfigError);
    expect((opcoesDemais as Error).message).toContain('50');
    // ⛔ E a mensagem não pode mais falar em 20: o número saiu do código.
    expect((opcoesDemais as Error).message).not.toContain('20');
    // Nenhuma das três recusas saiu da máquina — só a chamada de 21 opções.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // PAR: exatamente 50 opções num tier e 50 modelos PASSAM — as duas bordas de
    // baixo. (Dois tiers de 50 dão 2500 combinações possíveis; 50 é o teto de
    // MODELOS, que é outro limite.)
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: Array.from({ length: 50 }, (_, i) => modelo([i % 20, Math.floor(i / 20)])),
      standardise_tier_variation: [tierPersonalizado(50), tierPersonalizado(50)],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('69 — initTierVariation recusa dois modelos na MESMA combinação de tier_index', async () => {
    // ⚠️ Dois modelos no mesmo combo é um sobrescrevendo o outro, e a mensagem
    // da própria Shopee não nomearia nenhum dos dois.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).initTierVariation({
        item_id: ITEM_ID,
        model: [modelo([0, 1]), modelo([0, 1])],
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('tier_index');
    expect(fetchMock).not.toHaveBeenCalled();

    // ⚠️ QUASE-ERRO: a chave do Set é um FOLD, e o par acima sozinho não mostra
    // onde ele PARA. `[1,11]` e `[11,1]` são combinações DIFERENTES e precisam
    // PASSAR: um separador que dobrasse (`join('')`) continuaria recusando o par
    // acima e passaria a recusar, antes da rede, uma grade legítima de dois tiers
    // com 12+ opções.
    const client = createShopeeClient(shopConfig(fetchMock));
    await client.initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([1, 11]), modelo([11, 1])],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // E em `add_model`, onde nenhum tier declarado limita o COMPRIMENTO do
    // índice: `[1,2]` e `[12]` só não colidem porque o separador não some.
    await client.addModel({
      item_id: ITEM_ID,
      model_list: [modelo([1, 2]), modelo([12])],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('70 — initTierVariation recusa tier_index de comprimento diferente do número de tiers', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).initTierVariation({
        item_id: ITEM_ID,
        // DOIS tiers declarados, UM índice no modelo.
        model: [modelo([0])],
        standardise_tier_variation: [tierPersonalizado(2), tierPersonalizado(2)],
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('71 — updateTierVariation EXIGE variation_option_id, que initTierVariation deixa opcional', async () => {
    // ⚠️ Duas páginas, duas tabelas: uma marca o id da opção REQUIRED e a outra
    // não. Uma guarda só, com um flag — nunca duas guardas parecidas.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const erro = await erroDe(
      client.updateTierVariation({
        item_id: ITEM_ID,
        standardise_tier_variation: [tierPersonalizado(1)],
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('variation_option_id');
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: o MESMO tier passa em init_tier_variation.
    const outroFetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    await createShopeeClient(shopConfig(outroFetch)).initTierVariation({
      item_id: ITEM_ID,
      model: [modelo([0])],
      standardise_tier_variation: [tierPersonalizado(1)],
    });
    expect(outroFetch).toHaveBeenCalledTimes(1);
  });

  it('72 — updateTierVariation recusa model_id duplicado', async () => {
    // ⚠️ `error_duplicate_modelid: The model_id is duplicate` — recusado aqui
    // para não gastar a chamada, e porque um model_list com id repetido é sempre
    // uma lista montada duas vezes.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateTierVariation({
        item_id: ITEM_ID,
        model_list: [
          { model_id: MODEL_ID, tier_index: [0] },
          { model_id: MODEL_ID, tier_index: [1] },
        ],
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('repetido');
    expect(fetchMock).not.toHaveBeenCalled();

    // ⚠️ E a COORDENADA repetida, que a Shopee não recusa por nome nenhum: esta
    // lista SUBSTITUI a do anúncio, então dois modelos na mesma combinação é um
    // tomando a posição do outro, em silêncio.
    const coordenadaRepetida = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateTierVariation({
        item_id: ITEM_ID,
        model_list: [
          { model_id: MODEL_ID, tier_index: [1] },
          { model_id: MODEL_ID + 1, tier_index: [1] },
        ],
      }),
    );

    expect(coordenadaRepetida).toBeInstanceOf(ShopeeConfigError);
    expect((coordenadaRepetida as Error).message).toContain('tier_index');
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: as MESMAS duas linhas em coordenadas diferentes passam.
    await createShopeeClient(shopConfig(fetchMock)).updateTierVariation({
      item_id: ITEM_ID,
      model_list: [
        { model_id: MODEL_ID, tier_index: [1] },
        { model_id: MODEL_ID + 1, tier_index: [2] },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('73 — updateTierVariation recusa uma chamada sem model_list e sem standardise_tier_variation', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateTierVariation({ item_id: ITEM_ID }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('74 — updateTierVariation devolve o envelope PURO, sem `response`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ACK_BODY, warning: 'um modelo ficou fora' }),
    );
    const ack = await createShopeeClient(shopConfig(fetchMock)).updateTierVariation({
      item_id: ITEM_ID,
      model_list: [{ model_id: MODEL_ID, tier_index: [0] }],
    });

    expect(ack.request_id).toBe('req-ack');
    expect(ack.warning).toBe('um modelo ficou fora');
    expect('response' in ack).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      SHOPEE_UPDATE_TIER_VARIATION_PATH,
    );
  });

  it('75 — updateModel aceita model_sku VAZIO e recusa 101 caracteres', async () => {
    // ⚠️ `guide 221 §5`: "we support the delete operation, you can upload the
    // null string" — a string vazia APAGA o SKU, e é legal.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    await client.updateModel({ item_id: ITEM_ID, model: [{ model_id: MODEL_ID, model_sku: '' }] });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(SHOPEE_UPDATE_MODEL_PATH);

    const erro = await erroDe(
      client.updateModel({
        item_id: ITEM_ID,
        model: [{ model_id: MODEL_ID, model_sku: 'x'.repeat(SHOPEE_MODEL_SKU_MAX_LENGTH + 1) }],
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('76 — o request de update_model NÃO declara o campo de status do modelo', () => {
    // ⚠️ Asserção de FONTE, porque acrescentar uma chave opcional não falha nada.
    // A página: "Only CNSC and KRSC sellers can set the model_status" — e uma
    // loja BR não é nenhuma das duas, então o campo é INCONSTRUÍVEL aqui, não
    // apenas documentado como proibido. A RAZÃO fica no docblock ACIMA da
    // interface (fora da fatia), justamente para que esta busca não case com ela.
    const inicio = FONTE_API.indexOf('export interface ShopeeUpdateModelRequest');
    const fim = FONTE_API.indexOf('export interface ShopeeDeleteModelRequest');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);

    const corpoDaInterface = FONTE_API.slice(inicio, fim);
    expect(corpoDaInterface).toContain('model_sku');
    expect(corpoDaInterface).not.toContain(['model', '_status'].join(''));
    // E a razão continua escrita logo acima, para quem for tentado a declará-lo.
    expect(FONTE_API.slice(Math.max(0, inicio - 1500), inicio)).toContain('CNSC');
  });

  it('77 — um modelo com dimension e SEM weight é recusado antes da rede', async () => {
    // ⚠️ Das duas páginas de modelo, verbatim: "If set the dimension of this
    // model, them must set the weight of this model".
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TIER_WRITE_BODY));
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).addModel({
        item_id: ITEM_ID,
        model_list: [
          modelo([0], { dimension: { package_height: 10, package_length: 10, package_width: 10 } }),
        ],
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('weight');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('delete_model / delete_item — sem chamador no passo 11', () => {
  it('78 — POSTam nos seus caminhos e recusam id 0 antes da rede', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.deleteModel({ item_id: ITEM_ID, model_id: MODEL_ID });
    await client.deleteItem({ item_id: ITEM_ID });
    expect(fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual([
      SHOPEE_DELETE_MODEL_PATH,
      SHOPEE_DELETE_ITEM_PATH,
    ]);

    expect(await erroDe(client.deleteModel({ item_id: ITEM_ID, model_id: 0 }))).toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(await erroDe(client.deleteItem({ item_id: 0 }))).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('unlist_item', () => {
  it('79 — POSTa item_list e devolve sucesso E falha por entrada, dentro do envelope', async () => {
    // ⚠️ Uma entrada pode cair no `failure_list` com a chamada respondendo 200 e
    // `error` vazio: quem só checasse o throw reportaria uma pausa que não houve.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UNLIST_BODY));
    const res = await createShopeeClient(shopConfig(fetchMock)).unlistItem({
      item_list: [
        { item_id: ITEM_ID, unlist: true },
        { item_id: ITEM_ID_2, unlist: true },
      ],
    });

    expect(res.response.success_list).toHaveLength(1);
    expect(res.response.failure_list[0]?.failed_reason).toBe('error_item_not_found');
    // ⚠️ `success_list[].unlist` ECOA a bandeira pedida; não é o novo item_status.
    expect(res.response.success_list[0]?.unlist).toBe(true);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(SHOPEE_UNLIST_ITEM_PATH);
  });

  it('80 — recusa 0 e 51 entradas e um item_id repetido', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UNLIST_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const demais = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS + 1 }, (_, i) => ({
      item_id: ITEM_ID + i,
      unlist: true,
    }));

    expect(await erroDe(client.unlistItem({ item_list: [] }))).toBeInstanceOf(ShopeeConfigError);
    expect(await erroDe(client.unlistItem({ item_list: demais }))).toBeInstanceOf(
      ShopeeConfigError,
    );
    // ⚠️ Duas entradas com o mesmo id são irreconciliáveis contra um
    // `success_list` chaveado só por item_id.
    const repetido = await erroDe(
      client.unlistItem({
        item_list: [
          { item_id: ITEM_ID, unlist: true },
          { item_id: ITEM_ID, unlist: false },
        ],
      }),
    );
    expect(repetido).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('as duas LEITURAS do passo 11', () => {
  it('81 — getItemViolationInfo vai por GET, com item_id_list codificado, e DESEMBRULHA', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VIOLATION_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getItemViolationInfo({
      itemIds: [ITEM_ID, ITEM_ID_2],
    });

    // LEITURA: o envelope NÃO chega ao chamador.
    expect('error' in payload).toBe(false);
    expect(payload.item_list[0]?.item_id).toBe(ITEM_ID);
    // ⚠️ A string "FALSE" chega como string — nada aqui a dobra.
    expect(payload.item_list[0]?.deboost).toBe('FALSE');

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe(SHOPEE_GET_ITEM_VIOLATION_INFO_PATH);
    expect(url.searchParams.get('item_id_list')).toBe(
      encodeShopeeIdList([ITEM_ID, ITEM_ID_2], SHOPEE_ITEM_ID_LIST_ENCODING),
    );
  });

  it('82 — getItemViolationInfo aceita ids REPETIDOS e recusa 51', async () => {
    // ⚠️ Duplicatas passam, espelhando `getItemBaseInfo`: quem chama já
    // reconcilia por item_id e a Shopee pode devolver menos linhas.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(VIOLATION_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    await client.getItemViolationInfo({ itemIds: [ITEM_ID, ITEM_ID] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const erro = await erroDe(
      client.getItemViolationInfo({ itemIds: ids(SHOPEE_ITEM_VIOLATION_MAX_IDS + 1) }),
    );
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect(await erroDe(client.getItemViolationInfo({ itemIds: [] }))).toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('91 — getItemViolationInfo lê o corpo MEDIDO, que não traz a chave `error`, e é o ÚNICO a tolerá-lo', async () => {
    // ⚠️ Em 2026-09-17 o sandbox respondeu esta operação com
    // `{message, request_id, response: {item_list: […]}}` e mais nada — sem
    // `error` — e a etapa 1 do transporte recusou o corpo inteiro
    // (`campos=["error"]`). A tolerância é do TRANSPORTE e é por operação; o
    // schema continua recusando esse mesmo corpo sozinho (types.test.ts, 15).
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(VIOLATION_BODY_SEM_ERROR),
    );
    const payload = await createShopeeClient(shopConfig(fetchMock)).getItemViolationInfo({
      itemIds: [ITEM_ID],
    });

    expect(payload.item_list[0]?.item_id).toBe(ITEM_ID);
    expect(payload.item_list[0]?.item_status).toBe('BANNED');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ⚠️ Asserção de FONTE, e ela é o contrato inteiro: a flag vale para as
    // operações onde o corpo SEM `error` foi MEDIDO — esta (sandbox 2026-09-17,
    // registro 73) e `getShopHolidayMode` (sandbox 2026-09-21, sonda do passo 12,
    // P2 — o teste 103b pina o corpo vivo). Um terceiro call site a copiando
    // passaria por todos os testes de comportamento deste arquivo — cada
    // operação é testada com corpos que TÊM `error` — e alargaria em silêncio os
    // únicos pontos do pacote onde um corpo injulgável pode virar sucesso.
    const ocorrencias = FONTE_API.split('erroAusenteEhSucesso').length - 1;
    expect(ocorrencias).toBe(2);
    const inicio = FONTE_API.indexOf('getItemViolationInfo: async');
    const fim = FONTE_API.indexOf('getChannelList: async');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    expect(FONTE_API.slice(inicio, fim)).toContain('erroAusenteEhSucesso: true');
    const inicioFerias = FONTE_API.indexOf('getShopHolidayMode: async');
    const fimFerias = FONTE_API.indexOf('getWarehouseDetail: async');
    expect(inicioFerias).toBeGreaterThan(-1);
    expect(fimFerias).toBeGreaterThan(inicioFerias);
    expect(FONTE_API.slice(inicioFerias, fimFerias)).toContain('erroAusenteEhSucesso: true');
  });

  it('83 — getChannelList vai por GET sem parâmetro nenhum além dos comuns, e o size_id continua STRING', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(CHANNEL_LIST_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getChannelList();

    expect('error' in payload).toBe(false);
    expect(payload.logistics_channel_list[0]?.logistics_channel_id).toBe(90021);
    // ⚠️ STRING aqui e int32 no add_item: um "0" que voltasse como 0 mandaria um
    // tamanho que o vendedor não escolheu. A conversão é de quem monta o item.
    expect(payload.logistics_channel_list[0]?.size_list?.[0]?.size_id).toBe('1');

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(url.pathname).toBe(SHOPEE_GET_CHANNEL_LIST_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
  });
});

describe('upload_image — o primeiro dos dois multipart do pacote (o do cliente de parceiro)', () => {
  const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  function paramsUpload(extra: Partial<UploadImageParams> = {}): UploadImageParams {
    return { bytes: BYTES, filename: 'foto.png', contentType: 'image/png', ...extra };
  }

  it('84 — POSTa multipart SEM cabeçalho Content-Type, com o campo "image" e o scene "normal"', async () => {
    // ⚠️ O `fetch` é que escreve o Content-Type COM o boundary; pôr o cabeçalho
    // à mão (como faz o sample PHP da própria página) produz um corpo que a
    // Shopee não parseia e um erro que se lê como request ruim.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    await createShopeePartnerClient(partnerConfig(fetchMock)).uploadImage(paramsUpload());

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(rawUrl)).pathname).toBe(SHOPEE_UPLOAD_IMAGE_PATH);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');

    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    const arquivo = form.get(SHOPEE_UPLOAD_IMAGE_FIELD);
    expect(arquivo).toBeInstanceOf(Blob);
    expect((arquivo as File).name).toBe('foto.png');
    expect((arquivo as Blob).type).toBe('image/png');
    expect((arquivo as Blob).size).toBe(BYTES.byteLength);
    expect(form.get('scene')).toBe('normal');
    // ⛔ QUASE-IGUAL: o nome do campo é `image`, nunca `file` (o sample JAVA).
    expect(form.get('file')).toBeNull();
  });

  it('85 — signing "public" não emite access_token nem shop_id; "shop" emite os dois', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));

    await partner.uploadImage(paramsUpload({ signing: 'public' }));
    await partner.uploadImage(
      paramsUpload({
        signing: 'shop',
        shopAuth: { accessToken: 'access-inventado', shopId: TEST_SHOP_ID },
      }),
    );

    const publico = new URL(String(fetchMock.mock.calls[0]![0]));
    const daLoja = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(publico.searchParams.get('access_token')).toBeNull();
    expect(publico.searchParams.get('shop_id')).toBeNull();
    expect(daLoja.searchParams.get('access_token')).toBe('access-inventado');
    expect(daLoja.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
    // ⚠️ As duas classes assinam base strings DIFERENTES — é por isso que o
    // literal decide a query E a assinatura de uma vez só.
    expect(daLoja.searchParams.get('sign')).not.toBe(publico.searchParams.get('sign'));
  });

  it('86 — sem `signing`, a chamada sai exatamente como o literal SHOPEE_UPLOAD_IMAGE_SIGNING manda', async () => {
    // ⚠️ PAR: este teste NÃO afirma qual é o literal — o probe do sandbox pode
    // virá-lo numa linha só, e um teste que fixasse o valor faria dessa virada
    // duas. O que ele fixa é que o DEFAULT e o literal não podem divergir.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));
    const shopAuth = { accessToken: 'access-inventado', shopId: TEST_SHOP_ID };

    await partner.uploadImage(paramsUpload({ shopAuth }));
    await partner.uploadImage(paramsUpload({ shopAuth, signing: SHOPEE_UPLOAD_IMAGE_SIGNING }));

    const semSigning = new URL(String(fetchMock.mock.calls[0]![0]));
    const comSigning = new URL(String(fetchMock.mock.calls[1]![0]));
    expect([...semSigning.searchParams.keys()].sort()).toEqual(
      [...comSigning.searchParams.keys()].sort(),
    );
    expect(semSigning.searchParams.get('sign')).toBe(comSigning.searchParams.get('sign'));
  });

  it('87 — signing "shop" SEM shopAuth rejeita com ShopeeConfigError ANTES de qualquer fetch', async () => {
    // ⚠️ Sem esta recusa a chamada sairia assinada como PUBLIC e voltaria
    // `error_param: There is no access_token in query.` — exatamente a mensagem
    // que o literal existe para ler, chegando pelo motivo errado.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    const erro = await erroDe(
      createShopeePartnerClient(partnerConfig(fetchMock)).uploadImage(
        paramsUpload({ signing: 'shop' }),
      ),
    );

    expect(erro).toBeInstanceOf(ShopeeConfigError);
    expect((erro as Error).message).toContain('shopAuth');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('88 — recusa 10 MB + 1 byte, um content-type image/gif, um filename em branco e 0 bytes', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_BODY));
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));

    const grande = await erroDe(
      partner.uploadImage(
        paramsUpload({ bytes: new Uint8Array(SHOPEE_UPLOAD_IMAGE_MAX_BYTES + 1) }),
      ),
    );
    const gif = await erroDe(partner.uploadImage(paramsUpload({ contentType: 'image/gif' })));
    const semNome = await erroDe(partner.uploadImage(paramsUpload({ filename: '  ' })));
    const vazio = await erroDe(partner.uploadImage(paramsUpload({ bytes: new Uint8Array(0) })));

    for (const erro of [grande, gif, semNome, vazio]) {
      expect(erro).toBeInstanceOf(ShopeeConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR: o MESMO content-type com caixa e espaços passa.
    await partner.uploadImage(paramsUpload({ contentType: '  IMAGE/JPEG ' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('89 — devolve o envelope inteiro, com as DUAS posições de imagem', async () => {
    // ⚠️ `image_info` é a forma de arquivo único e `image_info_list[]` a de
    // vários, com um `error` POR ÍNDICE: um 200 pode conter uma falha por foto.
    // Só quem chama consegue registrar QUAL das duas chegou.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...UPLOAD_BODY, warning: 'imagem redimensionada' }),
    );
    const res = await createShopeePartnerClient(partnerConfig(fetchMock)).uploadImage({
      bytes: BYTES,
      filename: 'foto.png',
      contentType: 'image/png',
      scene: SHOPEE_UPLOAD_IMAGE_SCENE.desc,
    });

    expect(res.warning).toBe('imagem redimensionada');
    expect(res.response.image_info?.image_id).toBe('img-1');
    expect(res.response.image_info_list?.[1]?.error).toBe('error_param');
    expect((fetchMock.mock.calls[0]![1]?.body as FormData).get('scene')).toBe('desc');
  });
});

/* -------------------------- the stock sync (step 12) ---------------------- */

/** Um sucesso limpo: `error` vazio e as DUAS listas presentes. */
const UPDATE_STOCK_BODY = {
  request_id: 'req-update-stock',
  error: '',
  message: '',
  response: {
    failure_list: [],
    success_list: [{ model_id: MODEL_ID, location_id: 'SGZ', stock: 7 }],
  },
};

/**
 * A COEXISTÊNCIA que motiva o passo inteiro: um `error` não vazio chegando
 * JUNTO com o detalhe por modelo. A própria página documenta
 * `error_busi_update_stock_failed: Update stock failed, please check
 * failure_list for detailed reason`, e `failure_list` mora sob `response`.
 */
const UPDATE_STOCK_PARCIAL_BODY = {
  request_id: 'req-update-stock-parcial',
  error: 'error_busi_update_stock_failed',
  message: 'Update stock failed, please check failure_list for detailed reason',
  response: {
    failure_list: [
      {
        model_id: MODEL_ID,
        failed_reason: 'error_auth: Total stock must be more than reserved stock.',
      },
    ],
    success_list: [{ model_id: MODEL_ID + 1, location_id: 'SGZ', stock: 3 }],
  },
};

/** Uma falha ORDINÁRIA: `error` não vazio e NENHUM `response`. */
const UPDATE_STOCK_FALHA_SECA_BODY = {
  request_id: 'req-update-stock-seca',
  error: 'error_item_not_found',
  message: 'Item not found.',
};

const ITEM_PROMOTION_BODY = {
  request_id: 'req-item-promotion',
  error: '',
  message: '',
  response: {
    success_list: [
      {
        item_id: ITEM_ID,
        promotion: [
          {
            promotion_type: 'Discount Promotions',
            promotion_id: 649305216139969,
            model_id: MODEL_ID,
            start_time: 1650609000,
            end_time: 1650616200,
            promotion_staging: 'ongoing',
            promotion_stock_info_v2: { summary_info: { total_reserved_stock: 4 } },
          },
        ],
      },
    ],
    failure_list: [],
  },
};

/** A amostra da PÁGINA de `get_shop_holiday_mode`, sob um envelope de sucesso. */
const HOLIDAY_MODE_BODY = {
  request_id: 'req-holiday',
  error: '',
  message: '',
  response: {
    holiday_mode_on: true,
    holiday_mode_mtime: 1763435974,
    holiday_mode_type: 1,
    holiday_mode_start_time: 1770883200,
    holiday_mode_end_time: 1773305999,
    holiday_mode_description: '"Spring Festival"',
    debug_msg: '""',
  },
};

/**
 * ⚠️ O corpo de SUCESSO VIVO, medido no sandbox em 2026-09-21 (sonda do passo 12,
 * P2 e a verificação da limpeza): as chaves de topo são SÓ `request_id` e
 * `response` — sem `error`, sem `message`, sem `debug_msg` dentro — e `type` é 0
 * enquanto `on` é false. A amostra da página (acima) tem `error: ''`; a loja real
 * não manda a chave. É a mesma classe do registro 73 (`get_item_violation_info`).
 */
const HOLIDAY_MODE_BODY_VIVO = {
  request_id: 'req-holiday-vivo',
  response: {
    holiday_mode_on: false,
    holiday_mode_mtime: 1763435974,
    holiday_mode_type: 0,
    holiday_mode_start_time: 0,
    holiday_mode_end_time: 0,
    holiday_mode_description: '',
  },
};

/** ⚠️ O `response` é um ARRAY de topo — o único do pacote. */
const WAREHOUSE_BODY = {
  request_id: 'req-warehouse',
  error: '',
  message: '',
  response: [
    {
      warehouse_id: 6,
      warehouse_name: 'warehouse1',
      warehouse_type: 1,
      location_id: 'IDZ',
      address_id: 118454205,
      region: 'ID',
      holiday_mode_state: 0,
    },
  ],
};

/** Um corpo de FALHA com o código pedido — a forma ordinária de uma recusa. */
function erroBody(code: string, message = 'sem detalhe'): Record<string, unknown> {
  return { request_id: 'req-erro', error: code, message };
}

/** Um `stock_list` de N modelos distintos, todos SEM `location_id`. */
function modelos(n: number, stock = 1): ShopeeUpdateStockEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    model_id: MODEL_ID + i,
    seller_stock: [{ stock }],
  }));
}

describe('update_stock — a ÚNICA escrita do passo 12', () => {
  it('92 — POSTa item_id + stock_list com model_id 0 PRESERVADO e devolve o envelope INTEIRO', async () => {
    // ⚠️ `model_id: 0` É o item sem modelos, e a amostra de requisição da
    // própria página o imprime. Um `if (model_id)` em qualquer ponto do caminho
    // o descartaria, e a escrita do item simples voltaria como o erro de
    // estrutura espelhado.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const res = await createShopeeClient(shopConfig(fetchMock)).updateStock({
      item_id: ITEM_ID,
      stock_list: [{ model_id: 0, seller_stock: [{ location_id: 'SGZ', stock: 0 }] }],
    });

    // ESCRITA: o envelope chega inteiro — `warning` é canal de falha parcial.
    expect(res.error).toBe('');
    expect(res.response.success_list[0]?.model_id).toBe(MODEL_ID);
    expect(res.response.failure_list).toEqual([]);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('POST');
    expect(url.pathname).toBe(SHOPEE_UPDATE_STOCK_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());

    const corpo = JSON.parse(String(init?.body)) as {
      item_id: number;
      stock_list: { model_id: number; seller_stock: { location_id?: string; stock: number }[] }[];
    };
    expect(corpo.item_id).toBe(ITEM_ID);
    expect(corpo.stock_list).toHaveLength(1);
    // As DUAS âncoras do zero: o id do modelo e o próprio estoque.
    expect(corpo.stock_list[0]!.model_id).toBe(0);
    expect(corpo.stock_list[0]!.seller_stock[0]!.stock).toBe(0);
    expect(corpo.stock_list[0]!.seller_stock[0]!.location_id).toBe('SGZ');
  });

  it('93 — PAR: stock 0 é ACEITO; NEAR-MISS: stock −1 e 1.5 são RECUSADOS antes de qualquer fetch', async () => {
    // ⚠️ O par inteiro do `announcement 1445`: zerar um anúncio é a coisa mais
    // comum que este passo faz, então o guarda é NÃO-negativo. Trocá-lo pelo
    // positivo tornaria "tirar de estoque" inexprimível — e um teste que só
    // mostrasse o −1 recusado não diria isso.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: [{ model_id: MODEL_ID, seller_stock: [{ stock: 0 }] }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const negativo = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [{ model_id: MODEL_ID, seller_stock: [{ stock: -1 }] }],
      }),
    );
    expect(negativo).toBeInstanceOf(ShopeeConfigError);
    const fracionario = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [{ model_id: MODEL_ID, seller_stock: [{ stock: 1.5 }] }],
      }),
    );
    expect(fracionario).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('94 — PAR: 50 modelos passam; NEAR-MISS: 51 recusam', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: modelos(SHOPEE_UPDATE_STOCK_MAX_MODELS),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const demais = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: modelos(SHOPEE_UPDATE_STOCK_MAX_MODELS + 1),
      }),
    );
    expect(demais).toBeInstanceOf(ShopeeConfigError);
    expect((demais as Error).message).toContain(String(SHOPEE_UPDATE_STOCK_MAX_MODELS));
    // A borda de baixo, que a mesma frase da página declara.
    expect(await erroDe(client.updateStock({ item_id: ITEM_ID, stock_list: [] }))).toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('95 — NEAR-MISS: dois model_id 7 são RECUSADOS nomeando a posição; PAR: 7 e 8 passam', async () => {
    // ⚠️ As DUAS listas de resultado são chaveadas só por `model_id`, então duas
    // entradas para um modelo voltam irreconciliáveis mesmo no caminho feliz —
    // o argumento de `assertUnlistItemParams`, verbatim.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const repetido = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [
          { model_id: 7, seller_stock: [{ stock: 1 }] },
          { model_id: 7, seller_stock: [{ stock: 2 }] },
        ],
      }),
    );
    expect(repetido).toBeInstanceOf(ShopeeConfigError);
    expect((repetido as Error).message).toContain('stock_list[1].model_id');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: [
        { model_id: 7, seller_stock: [{ stock: 1 }] },
        { model_id: 8, seller_stock: [{ stock: 2 }] },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('96 — NEAR-MISS: location_id em umas entradas e não em outras é RECUSADO; PAR: todas-com e todas-sem passam', async () => {
    // ⚠️ `faq 61`: uma escrita multi-armazém tem de subir TODOS os `location_id`
    // numa chamada só, e `error_param: Can not update item with different stock
    // structure` é PEGAJOSO por anúncio. A metade que dá para checar sem uma
    // leitura é esta: a chamada ser internamente consistente.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const mista = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [
          { model_id: MODEL_ID, seller_stock: [{ location_id: 'SGZ', stock: 1 }] },
          { model_id: MODEL_ID + 1, seller_stock: [{ stock: 2 }] },
        ],
      }),
    );
    expect(mista).toBeInstanceOf(ShopeeConfigError);
    // ⚠️ E um `location_id` EM BRANCO conta como ausente — senão a estrutura
    // sairia "consistente" com uma string que a Shopee não sabe ler.
    const embranco = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [
          { model_id: MODEL_ID, seller_stock: [{ location_id: 'SGZ', stock: 1 }] },
          { model_id: MODEL_ID + 1, seller_stock: [{ location_id: '  ', stock: 2 }] },
        ],
      }),
    );
    expect(embranco).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    // PAR 1: todas COM.
    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: [
        { model_id: MODEL_ID, seller_stock: [{ location_id: 'SGZ', stock: 1 }] },
        { model_id: MODEL_ID + 1, seller_stock: [{ location_id: 'BRFSP1', stock: 2 }] },
      ],
    });
    // PAR 2: todas SEM.
    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: [
        { model_id: MODEL_ID, seller_stock: [{ stock: 1 }] },
        { model_id: MODEL_ID + 1, seller_stock: [{ stock: 2 }] },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('97 — recusa um seller_stock VAZIO e um item_id 0, sempre antes do fetch', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const semEstoque = await erroDe(
      client.updateStock({
        item_id: ITEM_ID,
        stock_list: [{ model_id: MODEL_ID, seller_stock: [] }],
      }),
    );
    expect(semEstoque).toBeInstanceOf(ShopeeConfigError);
    expect((semEstoque as Error).message).toContain('seller_stock');

    // ⚠️ `item_id` é POSITIVO — 0 nunca é um anúncio. É o único ponto desta
    // validação onde o zero é recusado, e o contraste com `model_id` é o ponto.
    const semItem = await erroDe(
      client.updateStock({
        item_id: 0,
        stock_list: [{ model_id: 0, seller_stock: [{ stock: 1 }] }],
      }),
    );
    expect(semItem).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    // NEAR-MISS: o MESMO corpo com um item_id válido passa — só o item_id era o problema.
    await client.updateStock({
      item_id: ITEM_ID,
      stock_list: [{ model_id: 0, seller_stock: [{ stock: 1 }] }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('98 — a COEXISTÊNCIA: o erro chega como ShopeeApiPartialError com o failure_list dentro', async () => {
    // ⚠️ Pelo caminho REAL do transporte — a flag `payloadNoErro` está no call
    // site, não no teste. Sem ela a atribuição por modelo seria descartada no
    // throw, e um lote de cinquenta em que UM modelo estava dentro de uma
    // promoção falharia como um bloco só: o defeito do Flutter legado, verbatim.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(UPDATE_STOCK_PARCIAL_BODY),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateStock({
        item_id: ITEM_ID,
        stock_list: modelos(2),
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeApiPartialError);
    // Continua uma FALHA, e continua a MESMA falha da classe base.
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_busi_update_stock_failed');

    // O payload sobrevive ao throw, e é RE-PARSEADO, nunca convertido por asserção.
    const parsed = shopeeUpdateStockSchema.parse((erro as ShopeeApiPartialError).parsed);
    expect(parsed.response.failure_list).toHaveLength(1);
    expect(parsed.response.failure_list[0]!.model_id).toBe(MODEL_ID);
    expect(parsed.response.failure_list[0]!.failed_reason).toContain('reserved stock');
    // E o que DEU certo também: uma escrita parcial tem as duas metades.
    expect(parsed.response.success_list[0]!.model_id).toBe(MODEL_ID + 1);
  });

  it('99 — NEAR-MISS: uma falha SEM `response` cai na classe BASE, mesmo com a flag ligada', async () => {
    // ⚠️ O par do 98. A flag é CEGA A CÓDIGO: o que decide se o payload viaja é
    // o schema da operação ter parseado aquele corpo. Um `error_item_not_found`
    // seco — a forma ordinária de um throttle ou de uma autorização morta — sai
    // exatamente da classe de que sempre saiu.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(UPDATE_STOCK_FALHA_SECA_BODY),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateStock({
        item_id: ITEM_ID,
        stock_list: modelos(1),
      }),
    );

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeApiPartialError);
    expect((erro as ShopeeApiError).code).toBe('error_item_not_found');
  });

  it('100 — um `error` de traço continua FALHA: updateStock não ganhou nenhuma tolerância de VALOR', async () => {
    // ⚠️ A amostra da página imprime um traço no `error` — o mesmo placeholder
    // de autoria que `add_item` e `get_model_list` carregam, e a nenhum deles o
    // passo 11 deu tolerância. Lê-lo como sucesso faria uma escrita RECUSADA
    // pela Shopee chegar ao app como se tivesse valido.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...UPDATE_STOCK_BODY, error: '-' }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).updateStock({
        item_id: ITEM_ID,
        stock_list: modelos(1),
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('-');

    // ⚠️ Asserção de FONTE, e é ela que fecha o buraco: a tolerância de CHAVE
    // ausente existe DUAS vezes no arquivo inteiro (em `getItemViolationInfo` e
    // em `getShopHolidayMode`, onde foi MEDIDA nas duas — testes 82 e 103b), e o
    // bloco de `updateStock` não a menciona. Um terceiro call site passaria por
    // todo teste de comportamento acima — os corpos deles TÊM a chave `error` —
    // e alargaria em silêncio os únicos pontos do pacote onde um corpo
    // injulgável vira sucesso.
    const tolerancia = 'erroAusenteEhSucesso';
    expect(FONTE_API.split(tolerancia).length - 1).toBe(2);
    const inicio = FONTE_API.indexOf('updateStock: async');
    const fim = FONTE_API.indexOf('getItemPromotion: async');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const bloco = FONTE_API.slice(inicio, fim);
    expect(bloco).toContain('payloadNoErro: true');
    expect(bloco).not.toContain(tolerancia);
    // E a flag NOVA mora em exatamente DUAS operações: esta e `updatePrice`, onde
    // a sonda do passo 13 MEDIU o erro chegando junto com o `failure_list`
    // (T-P6/T-P17 fixam o outro call site). O passo 15 somou UM terceiro, o
    // leitor de lote `lerLoteLogistico` (o teste E-L1 o fixa).
    expect(FONTE_API.split('payloadNoErro: true').length - 1).toBe(3);
  });
});

describe('as TRÊS leituras do passo 12', () => {
  it('101 — getItemPromotion vai por GET, com item_id_list em vírgula nua, e DESEMBRULHA', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_PROMOTION_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getItemPromotion({
      itemIds: [ITEM_ID, ITEM_ID_2],
    });

    // LEITURA: o envelope NÃO chega ao chamador.
    expect('error' in payload).toBe(false);
    expect(payload.success_list[0]?.item_id).toBe(ITEM_ID);
    // ⚠️ `promotion_id` é STRING — `uint64` desde 2026-07-31.
    expect(payload.success_list[0]?.promotion[0]?.promotion_id).toBe('649305216139969');
    expect(payload.failure_list).toEqual([]);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe(SHOPEE_GET_ITEM_PROMOTION_PATH);
    expect(url.searchParams.get('item_id_list')).toBe(`${String(ITEM_ID)},${String(ITEM_ID_2)}`);
    expect(url.searchParams.get('item_id_list')).toBe(
      encodeShopeeIdList([ITEM_ID, ITEM_ID_2], SHOPEE_ITEM_ID_LIST_ENCODING),
    );
  });

  it('102 — NEAR-MISS entre operações: getItemPromotion RECUSA o id repetido que getItemBaseInfo ACEITA', async () => {
    // ⚠️ A mesma lista, duas páginas, duas respostas. `get_item_promotion`
    // documenta `error_param: Repeat item_id.`; `get_item_base_info` não, e quem
    // chama lá já reconcilia por `item_id`. Um guarda compartilhado entre as
    // duas estaria errado de um dos lados, e nenhum teste de uma página só diria
    // qual.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ITEM_BASE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.getItemBaseInfo({ itemIds: [ITEM_ID, ITEM_ID] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const repetido = await erroDe(client.getItemPromotion({ itemIds: [ITEM_ID, ITEM_ID] }));
    expect(repetido).toBeInstanceOf(ShopeeConfigError);
    expect((repetido as Error).message).toContain('item_id_list[1]');
    // As duas bordas, pelas mesmas duas pontas.
    expect(await erroDe(client.getItemPromotion({ itemIds: [] }))).toBeInstanceOf(
      ShopeeConfigError,
    );
    expect(
      await erroDe(client.getItemPromotion({ itemIds: ids(SHOPEE_ITEM_PROMOTION_MAX_IDS + 1) })),
    ).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('103 — getShopHolidayMode vai por GET sem parâmetro nenhum além dos comuns, e DESEMBRULHA', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(HOLIDAY_MODE_BODY));
    const payload = await createShopeeClient(shopConfig(fetchMock)).getShopHolidayMode();

    // ⚠️ ENVELOPADO, contra o que o seam do passo 12 desenhou: os sete campos
    // vêm sob `response`. Uma leitura plana devolveria `undefined` em todos.
    expect(payload.holiday_mode_on).toBe(true);
    expect(payload.holiday_mode_type).toBe(1);
    expect(payload.holiday_mode_description).toBe('"Spring Festival"');
    expect(payload.debug_msg).toBe('""');
    // LEITURA: o `error` do envelope não atravessa...
    expect('error' in payload).toBe(false);
    // ...e `warning` não é declarado NO PAYLOAD tampouco. A página não tem esse
    // campo, e um declarado aqui apareceria como `null` mesmo sem vir no corpo —
    // um campo que a Shopee nunca manda lido como "sem aviso".
    expect('warning' in payload).toBe(false);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(url.pathname).toBe(SHOPEE_GET_SHOP_HOLIDAY_MODE_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
  });

  it('103b — getShopHolidayMode aceita o corpo VIVO sem `error` (medido) e continua recusando um corpo sem `response`', async () => {
    // O PAR: o corpo que a loja real manda — sem a chave `error` — é sucesso.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(HOLIDAY_MODE_BODY_VIVO),
    );
    const payload = await createShopeeClient(shopConfig(fetchMock)).getShopHolidayMode();
    expect(payload.holiday_mode_on).toBe(false);
    expect(payload.holiday_mode_type).toBe(0);
    expect(payload.debug_msg).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // O QUASE-IGUAL: sem `error` E sem `response` continua injulgável — a
    // tolerância não vira "qualquer JSON é sucesso".
    const semNada = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'req-vazio' }),
    );
    await expect(
      createShopeeClient(shopConfig(semNada)).getShopHolidayMode(),
    ).rejects.toBeInstanceOf(ShopeeSchemaError);

    // E um `error` PRESENTE e não vazio continua sendo erro, com o código.
    const comErro = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-erro',
        error: 'error_shop_not_exists',
        message: 'x',
        response: {},
      }),
    );
    const erro = await createShopeeClient(shopConfig(comErro))
      .getShopHolidayMode()
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_shop_not_exists');
  });

  it('104 — getWarehouseDetail devolve a LISTA, com location_id STRING, e só manda warehouse_type quando pedido', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(WAREHOUSE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const semParam = await client.getWarehouseDetail();
    expect(semParam.kind).toBe('lista');
    if (semParam.kind !== 'lista') throw new Error('esperava a lista');
    // ⚠️ STRING opaca (`IDZ`, `SGZ`, `BRFSP1`) — é o valor que `update_stock`
    // ecoa de volta, e nada aqui o lê como número.
    expect(semParam.armazens[0]?.location_id).toBe('IDZ');
    expect(typeof semParam.armazens[0]?.location_id).toBe('string');
    expect(semParam.armazens[0]?.warehouse_id).toBe(6);

    // ⚠️ Sem parâmetro, NENHUMA chave `warehouse_type` sai: a página aplica o
    // default dela. Uma cópia do default aqui seria um segundo lugar para ele
    // estar errado.
    const url1 = new URL(String(fetchMock.mock.calls[0]![0]));
    expect([...url1.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    expect(url1.searchParams.has('warehouse_type')).toBe(false);
    expect(url1.pathname).toBe(SHOPEE_GET_WAREHOUSE_DETAIL_PATH);

    // PAR: quando pedido, sai.
    await client.getWarehouseDetail({ warehouseType: SHOPEE_WAREHOUSE_TYPE.retorno });
    const url2 = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(url2.searchParams.get('warehouse_type')).toBe('2');
  });

  it('105 — PAR: o código COM e SEM prefixo de módulo dobram igual, carregando o código VERBATIM', async () => {
    // ⚠️ A amostra da própria página mostra `warehouse.error_not_in_whitelist`
    // como a resposta de uma loja NORMAL: tratá-lo como falha faria o caso comum
    // ler como chamada quebrada. A Shopee imprime as duas grafias, então as duas
    // dobram — mas o que o chamador registra é o código que CHEGOU.
    const comPrefixo = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(erroBody('warehouse.error_not_in_whitelist')),
    );
    const semPrefixo = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(erroBody('error_not_in_whitelist')),
    );
    const semArmazem = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(erroBody('warehouse.error_can_not_find_warehouse')),
    );

    const a = await createShopeeClient(shopConfig(comPrefixo)).getWarehouseDetail();
    const b = await createShopeeClient(shopConfig(semPrefixo)).getWarehouseDetail();
    const c = await createShopeeClient(shopConfig(semArmazem)).getWarehouseDetail();

    for (const r of [a, b, c]) expect(r.kind).toBe('sem-multi-armazem');
    if (a.kind !== 'sem-multi-armazem' || b.kind !== 'sem-multi-armazem') {
      throw new Error('esperava a dobra');
    }
    expect(a.code).toBe('warehouse.error_not_in_whitelist');
    expect(b.code).toBe('error_not_in_whitelist');
  });

  it('106 — NEAR-MISS: qualquer OUTRO erro da mesma chamada é RELANÇADO', async () => {
    // ⚠️ A dobra são exatamente dois códigos. Alargá-la para "qualquer
    // ShopeeApiError" faria um 500, uma autorização morta ou um throttle serem
    // reportados como "esta loja não tem multi-armazém" — e a varredura seguiria
    // escrevendo estoque sem `location_id` numa loja que exige um.
    const servidor = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(erroBody('error_server')),
    );
    const erro = await erroDe(createShopeeClient(shopConfig(servidor)).getWarehouseDetail());
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_server');

    // NEAR-MISS mais próximo: um código do MESMO módulo cujo sufixo não está na
    // lista continua subindo, prefixo e tudo.
    const vizinho = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(erroBody('warehouse.error_param')),
    );
    expect(
      await erroDe(createShopeeClient(shopConfig(vizinho)).getWarehouseDetail()),
    ).toBeInstanceOf(ShopeeApiError);

    // E um erro que NEM é da Shopee (HTTP puro) também sobe, intocado.
    const http = vi.fn<typeof globalThis.fetch>(async () => new Response('nada', { status: 503 }));
    expect(await erroDe(createShopeeClient(shopConfig(http)).getWarehouseDetail())).toBeInstanceOf(
      ShopeeHttpError,
    );
  });

  it('107 — um array VAZIO sem erro dobra também, com o code vazio — distinguível na leitura', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'req-vazio', error: '', message: '', response: [] }),
    );
    const r = await createShopeeClient(shopConfig(fetchMock)).getWarehouseDetail();
    expect(r.kind).toBe('sem-multi-armazem');
    if (r.kind !== 'sem-multi-armazem') throw new Error('esperava a dobra');
    // ⚠️ "Nada a mapear" é a mesma INSTRUÇÃO que a recusa de whitelist, e o
    // `code` vazio é o que mantém as duas distinguíveis num log.
    expect(r.code).toBe('');
  });
});

describe('a superfície pública do passo 12', () => {
  it('108 — as QUATRO operações e os QUATRO caminhos saem pelo index do pacote', async () => {
    // ⚠️ `index.ts` re-exporta por WILDCARD, então nenhuma adição do passo 12
    // precisou de linha lá — mas um rename silencioso tiraria uma operação da
    // superfície pública sem quebrar nada dentro do pacote.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_STOCK_BODY));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock));

    const operacoes = [
      'updateStock',
      'getItemPromotion',
      'getShopHolidayMode',
      'getWarehouseDetail',
    ] as const;
    for (const nome of operacoes) expect(typeof client[nome]).toBe('function');

    const caminhos = [
      pacote.SHOPEE_UPDATE_STOCK_PATH,
      pacote.SHOPEE_GET_ITEM_PROMOTION_PATH,
      pacote.SHOPEE_GET_SHOP_HOLIDAY_MODE_PATH,
      pacote.SHOPEE_GET_WAREHOUSE_DETAIL_PATH,
    ];
    expect(new Set(caminhos).size).toBe(4);
    for (const caminho of caminhos) expect(caminho.startsWith('/api/v2/')).toBe(true);

    // ⚠️ Os DOIS cinquentas são constantes SEPARADAS de propósito: uma limita o
    // lote de `update_stock`, a outra é o teto de modelos POR ITEM na criação.
    // São iguais hoje, e uma sonda que mova uma não pode mover a outra.
    expect(pacote.SHOPEE_UPDATE_STOCK_MAX_MODELS).toBe(SHOPEE_UPDATE_STOCK_MAX_MODELS);
    expect(pacote.SHOPEE_MODEL_MAX_PER_ITEM).toBe(SHOPEE_MODEL_MAX_PER_ITEM);
    expect(FONTE_TYPES).toContain('export const SHOPEE_UPDATE_STOCK_MAX_MODELS');
    expect(FONTE_TYPES).toContain('export const SHOPEE_MODEL_MAX_PER_ITEM');
    // E a dobra do armazém é do PACOTE, para que nenhum app compare strings de erro.
    expect([...pacote.SHOPEE_WAREHOUSE_SEM_ACESSO]).toHaveLength(2);
  });
});

describe('a superfície pública do passo 11', () => {
  it('90 — as DOZE operações e os DOZE caminhos saem pelo index do pacote', async () => {
    // ⚠️ `index.ts` re-exporta por WILDCARD, então nenhuma adição do passo 11
    // precisou de linha lá — mas um rename silencioso tiraria uma operação da
    // superfície pública sem quebrar nada dentro do pacote.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ACK_BODY));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock));
    const partner = pacote.createShopeePartnerClient(partnerConfig(fetchMock));

    const operacoes = [
      'addItem',
      'updateItem',
      'initTierVariation',
      'updateTierVariation',
      'addModel',
      'updateModel',
      'deleteModel',
      'deleteItem',
      'unlistItem',
      'getItemViolationInfo',
      'getChannelList',
    ] as const;
    for (const nome of operacoes) expect(typeof client[nome]).toBe('function');
    expect(typeof partner.uploadImage).toBe('function');

    const caminhos = [
      pacote.SHOPEE_ADD_ITEM_PATH,
      pacote.SHOPEE_UPDATE_ITEM_PATH,
      pacote.SHOPEE_INIT_TIER_VARIATION_PATH,
      pacote.SHOPEE_UPDATE_TIER_VARIATION_PATH,
      pacote.SHOPEE_ADD_MODEL_PATH,
      pacote.SHOPEE_UPDATE_MODEL_PATH,
      pacote.SHOPEE_DELETE_MODEL_PATH,
      pacote.SHOPEE_DELETE_ITEM_PATH,
      pacote.SHOPEE_UNLIST_ITEM_PATH,
      pacote.SHOPEE_GET_ITEM_VIOLATION_INFO_PATH,
      pacote.SHOPEE_GET_CHANNEL_LIST_PATH,
      pacote.SHOPEE_UPLOAD_IMAGE_PATH,
    ];
    expect(new Set(caminhos).size).toBe(12);
    for (const caminho of caminhos) expect(caminho.startsWith('/api/v2/')).toBe(true);
    // Os limites do WIRE também são do pacote — `apps/shopee` não declara cópia.
    expect(pacote.SHOPEE_TIER_MAX_OPTIONS).toBe(SHOPEE_TIER_MAX_OPTIONS);
    expect(pacote.SHOPEE_UPLOAD_IMAGE_FIELD).toBe(SHOPEE_UPLOAD_IMAGE_FIELD);
  });
});

/* -------------------------- the price sync (step 13) ---------------------- */

/** Um sucesso LIMPO no item SEM modelos: o eco da página chaveia a linha como `model_id: 0`. */
const UPDATE_PRICE_BODY = {
  request_id: 'req-update-price',
  error: '',
  message: '',
  response: {
    failure_list: [],
    success_list: [{ model_id: 0, original_price: 11.11 }],
  },
};

/**
 * A falha PARCIAL documentada, na forma da amostra da página: `error: ""` com as
 * DUAS listas preenchidas. É um envelope de SUCESSO — e é assim que ela chega.
 */
const UPDATE_PRICE_PARCIAL_BODY = {
  request_id: 'req-update-price-parcial',
  error: '',
  message: '',
  warning: 'alguns modelos falharam',
  response: {
    failure_list: [{ model_id: MODEL_ID, failed_reason: 'fail' }],
    success_list: [{ model_id: MODEL_ID + 1, original_price: 10.1 }],
  },
};

/**
 * Um `error` não vazio JUNTO com as listas — o que ESTA página não documenta (não
 * há nela um código "check failure_list") e o que a sonda do passo 13 MEDIU no
 * sandbox SG (P4c-bogus): `product.error_update_price_fail`, com o prefixo de
 * módulo, e um `failure_list` preenchido cujo `model_id` é um NÚMERO. Os ids são
 * os de fixture; o texto do motivo é o da amostra da página.
 */
const UPDATE_PRICE_ERRO_COM_LISTAS_BODY = {
  request_id: 'req-update-price-erro',
  error: 'product.error_update_price_fail',
  message: 'Update price failed, please try later.',
  response: {
    failure_list: [{ model_id: MODEL_ID, failed_reason: 'fail' }],
    success_list: [],
  },
};

/** Um `price_list` de N modelos DISTINTOS, todos com um preço de duas casas. */
function precos(n: number, preco = 19.9): ShopeeUpdatePriceEntry[] {
  return Array.from({ length: n }, (_, i) => ({ model_id: MODEL_ID + i, original_price: preco }));
}

/** O corpo de sucesso com UMA linha no `success_list` cujo eco é o valor pedido. */
function corpoComEco(eco: unknown): Record<string, unknown> {
  return {
    request_id: 'req-update-price-eco',
    error: '',
    message: '',
    response: { failure_list: [], success_list: [{ model_id: MODEL_ID, original_price: eco }] },
  };
}

describe('update_price (passo 13)', () => {
  it('T-P1 — POSTa no caminho, query shop-signed, e o corpo VERBATIM — `model_id: 0` PRESERVADO', async () => {
    // ⚠️ `model_id: 0` É o item sem modelos: a tabela de parâmetros da página diz
    // "0 for no model item" e o próprio eco dela chaveia a linha como 0. Um
    // `if (model_id)` em qualquer ponto do caminho o descartaria, e a escrita do
    // item simples voltaria como o erro de estrutura espelhado.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 11.11 }],
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(init?.method).toBe('POST');
    expect(SHOPEE_UPDATE_PRICE_PATH).toBe('/api/v2/product/update_price');
    expect(url.pathname).toBe(SHOPEE_UPDATE_PRICE_PATH);
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    // VERBATIM: nada acrescentado, nada tirado — nem o zero, nem uma chave a mais.
    expect(JSON.parse(String(init?.body))).toStrictEqual({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 11.11 }],
    });

    // E o item COM modelos: dois ids reais, na ORDEM de quem chamou, preço sem
    // casa decimal incluído — o pacote não reformata número nenhum.
    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [
        { model_id: MODEL_ID + 1, original_price: 12.5 },
        { model_id: MODEL_ID, original_price: 10 },
      ],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toStrictEqual({
      item_id: ITEM_ID,
      price_list: [
        { model_id: MODEL_ID + 1, original_price: 12.5 },
        { model_id: MODEL_ID, original_price: 10 },
      ],
    });
  });

  it('T-P2 — devolve o envelope INTEIRO, e um `failure_list` sob `error: ""` é DEVOLVIDO, não lançado', async () => {
    // ⚠️ A ÚNICA forma parcial documentada nesta página é o envelope de sucesso
    // com as duas listas. Quem grava o resultado lê as DUAS — a ausência de um
    // throw não diz que modelo nenhum foi recusado.
    const onWarning = vi.fn();
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(UPDATE_PRICE_PARCIAL_BODY),
    );
    const res = await createShopeeClient({ ...shopConfig(fetchMock), onWarning }).updatePrice({
      item_id: ITEM_ID,
      price_list: precos(2),
    });

    // ESCRITA: o envelope chega inteiro — `warning` é canal de falha parcial.
    expect(res.error).toBe('');
    expect(res.request_id).toBe('req-update-price-parcial');
    expect(res.warning).toBe('alguns modelos falharam');
    expect(onWarning).toHaveBeenCalledTimes(1);

    // As DUAS metades, cada uma chaveada só por `model_id`.
    expect(res.response.failure_list).toStrictEqual([
      { model_id: MODEL_ID, failed_reason: 'fail' },
    ]);
    // Tipado: o eco é `number | null` em tempo de compilação.
    const eco: number | null = res.response.success_list[0]!.original_price;
    expect(eco).toBe(10.1);
    expect(res.response.success_list[0]!.model_id).toBe(MODEL_ID + 1);
  });

  it('T-P3 — PAR: as duas listas AUSENTES leem `[]`; NEAR-MISS: uma lista presente NÃO apaga a vizinha', async () => {
    // Pelo transporte REAL: o default é do schema da operação, não do teste.
    const vazio = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ request_id: 'req-vazio', error: '', message: '', response: {} }),
    );
    const semListas = await createShopeeClient(shopConfig(vazio)).updatePrice({
      item_id: ITEM_ID,
      price_list: precos(1),
    });
    expect(semListas.response.failure_list).toStrictEqual([]);
    expect(semListas.response.success_list).toStrictEqual([]);

    const soSucesso = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-so-sucesso',
        error: '',
        message: '',
        response: { success_list: [{ model_id: 0, original_price: 11.11 }] },
      }),
    );
    const umaLista = await createShopeeClient(shopConfig(soSucesso)).updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 11.11 }],
    });
    expect(umaLista.response.failure_list).toStrictEqual([]);
    expect(umaLista.response.success_list).toHaveLength(1);
    expect(umaLista.response.success_list[0]!.model_id).toBe(0);
  });

  it('T-P4 — PAR: o eco NÚMERO 12.5 e STRING "12.5" leem 12.5; NEAR-MISS: "12,5" RECUSA o corpo', async () => {
    // ⚠️ O eco é um FLOAT em unidades MAIORES — `wireNumber()`, nunca
    // `wireInt()`: um leitor inteiro derrubaria a página inteira no primeiro
    // centavo.
    for (const eco of [12.5, '12.5']) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpoComEco(eco)));
      const res = await createShopeeClient(shopConfig(fetchMock)).updatePrice({
        item_id: ITEM_ID,
        price_list: [{ model_id: MODEL_ID, original_price: 12.5 }],
      });
      expect(res.response.success_list[0]!.original_price).toBe(12.5);
    }

    // A vírgula decimal NÃO é um número no fio: o corpo inteiro é recusado,
    // em vez de um eco virar `12` ou `125` em silêncio.
    const virgula = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpoComEco('12,5')));
    const erro = await erroDe(
      createShopeeClient(shopConfig(virgula)).updatePrice({
        item_id: ITEM_ID,
        price_list: [{ model_id: MODEL_ID, original_price: 12.5 }],
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeSchemaError);
  });

  it('T-P5 — PAR: `failed_reason` AUSENTE e `null` leem `null`; NEAR-MISS: o texto livre chega VERBATIM', async () => {
    const leituras: (string | null)[] = [];
    for (const linha of [
      { model_id: MODEL_ID },
      { model_id: MODEL_ID, failed_reason: null },
      { model_id: MODEL_ID, failed_reason: 'model ID not exist in sku' },
    ]) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({
          request_id: 'req-motivo',
          error: '',
          message: '',
          response: { failure_list: [linha], success_list: [] },
        }),
      );
      const res = await createShopeeClient(shopConfig(fetchMock)).updatePrice({
        item_id: ITEM_ID,
        price_list: [{ model_id: MODEL_ID, original_price: 10 }],
      });
      leituras.push(res.response.failure_list[0]!.failed_reason);
    }
    // TEXTO LIVRE: nada aqui o normaliza — o app classifica e grava o que veio.
    expect(leituras).toStrictEqual([null, null, 'model ID not exist in sku']);
  });

  it('T-P6 — um `error` não vazio COM as listas (sonda P4c-bogus) é ShopeeApiPartialError e CARREGA as listas; NEAR-MISS: a falha SECA e a de `response` ilegível saem da classe BASE', async () => {
    // ⚠️ O par do teste 98, INVERTIDO pela sonda do passo 13 (B-2). A página do
    // PREÇO não documenta um código "check failure_list" — por isso a operação
    // saiu SEM a flag —, mas o sandbox respondeu `product.error_update_price_fail`
    // JUNTO com um `failure_list` preenchido. Sem a flag, a atribuição por modelo
    // morria no throw e o item inteiro falhava como um bloco só.
    const comListas = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(UPDATE_PRICE_ERRO_COM_LISTAS_BODY),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(comListas)).updatePrice({
        item_id: ITEM_ID,
        price_list: precos(1),
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeApiPartialError);
    // Continua uma FALHA da família de sempre — a flag não muda veredicto nenhum.
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeRateLimitError);
    // O código VERBATIM, com o prefixo; fora de `KIND_BY_CODE` ⇒ `other` (o app
    // o classifica — B-3).
    expect((erro as ShopeeApiError).code).toBe('product.error_update_price_fail');
    expect((erro as ShopeeApiError).kind).toBe(SHOPEE_ERROR_KIND.other);
    expect((erro as ShopeeApiError).requestId).toBe('req-update-price-erro');

    // A carga sobrevive ao throw, e é RE-PARSEADA, nunca convertida por asserção.
    const carga = shopeeUpdatePriceSchema.parse((erro as ShopeeApiPartialError).parsed);
    expect(carga.error).toBe('product.error_update_price_fail');
    expect(carga.response.failure_list).toStrictEqual([
      { model_id: MODEL_ID, failed_reason: 'fail' },
    ]);
    expect(carga.response.success_list).toStrictEqual([]);

    // NEAR-MISS 1: a falha SECA (sem `response`) sai da classe BASE, sem carga —
    // a flag é CEGA ao código, e é o schema da operação que decide se há carga.
    const seca = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        erroBody('product.error_update_price_fail', 'Update price failed, please try later.'),
      ),
    );
    const erroSeco = await erroDe(
      createShopeeClient(shopConfig(seca)).updatePrice({ item_id: ITEM_ID, price_list: precos(1) }),
    );
    expect(erroSeco).toBeInstanceOf(ShopeeApiError);
    expect(erroSeco).not.toBeInstanceOf(ShopeeApiPartialError);
    expect(erroSeco).not.toHaveProperty('parsed');
    expect((erroSeco as ShopeeApiError).code).toBe('product.error_update_price_fail');

    // NEAR-MISS 2: um `response` que o schema RECUSA (a linha de falha sem
    // `model_id`, que é EXIGIDO lá) também sai da classe BASE — nem um parcial
    // sem carga, nem um ShopeeSchemaError que enterraria o código da recusa.
    const ilegivel = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...UPDATE_PRICE_ERRO_COM_LISTAS_BODY,
        response: { failure_list: [{ failed_reason: 'fail' }], success_list: [] },
      }),
    );
    const erroIlegivel = await erroDe(
      createShopeeClient(shopConfig(ilegivel)).updatePrice({
        item_id: ITEM_ID,
        price_list: precos(1),
      }),
    );
    expect(erroIlegivel).toBeInstanceOf(ShopeeApiError);
    expect(erroIlegivel).not.toBeInstanceOf(ShopeeApiPartialError);
    expect(erroIlegivel).not.toBeInstanceOf(ShopeeSchemaError);
    expect((erroIlegivel as ShopeeApiError).code).toBe('product.error_update_price_fail');
  });

  it('T-P7 — PAR: `product.error_rate_limit` e `error_rate_limit` são throttle `burst`; NEAR-MISS: `product.error_limit` é `daily`', async () => {
    // ⚠️ A dobra do PREFIXO DE MÓDULO é do pacote (uma consulta, não uma
    // reescrita): o `code` continua VERBATIM, e `burst` × `daily` pedem
    // respostas opostas — um espera segundos, o outro espera a virada UTC+8.
    const casos = [
      ['product.error_rate_limit', SHOPEE_ERROR_KIND.burst],
      ['error_rate_limit', SHOPEE_ERROR_KIND.burst],
      ['product.error_limit', SHOPEE_ERROR_KIND.daily],
    ] as const;
    for (const [code, kind] of casos) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(erroBody(code)));
      const erro = await erroDe(
        createShopeeClient(shopConfig(fetchMock)).updatePrice({
          item_id: ITEM_ID,
          price_list: precos(1),
        }),
      );
      expect(erro).toBeInstanceOf(ShopeeRateLimitError);
      expect((erro as ShopeeRateLimitError).kind).toBe(kind);
      expect((erro as ShopeeRateLimitError).code).toBe(code);
    }
  });

  it('T-P8 — NEAR-MISS: um `price_list` VAZIO é RECUSADO antes do fetch; PAR: uma entrada passa', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const vazio = await erroDe(client.updatePrice({ item_id: ITEM_ID, price_list: [] }));
    expect(vazio).toBeInstanceOf(ShopeeConfigError);
    expect((vazio as Error).message).toContain('price_list');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({ item_id: ITEM_ID, price_list: precos(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P9 — PAR: 50 modelos passam; NEAR-MISS: 51 são RECUSADOS antes do fetch, pelo limite PRÓPRIO do preço', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const demais = await erroDe(
      client.updatePrice({
        item_id: ITEM_ID,
        price_list: precos(SHOPEE_UPDATE_PRICE_MAX_MODELS + 1),
      }),
    );
    expect(demais).toBeInstanceOf(ShopeeConfigError);
    expect((demais as Error).message).toContain(`de 1 a ${String(SHOPEE_UPDATE_PRICE_MAX_MODELS)}`);
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: precos(SHOPEE_UPDATE_PRICE_MAX_MODELS),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(SHOPEE_UPDATE_PRICE_MAX_MODELS).toBe(50);
  });

  it('T-P10 — NEAR-MISS: um `model_id` REPETIDO é RECUSADO nomeando a posição; PAR: 50 DISTINTOS passam', async () => {
    // ⚠️ `error_param: Repeat model_id.` está na lista da própria página, e as
    // DUAS listas de resultado são chaveadas só por `model_id` — duas entradas
    // para um modelo voltariam irreconciliáveis até no caminho feliz.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const repetido = await erroDe(
      client.updatePrice({
        item_id: ITEM_ID,
        price_list: [
          { model_id: MODEL_ID, original_price: 10 },
          { model_id: MODEL_ID, original_price: 11 },
        ],
      }),
    );
    expect(repetido).toBeInstanceOf(ShopeeConfigError);
    expect((repetido as Error).message).toContain('price_list[1].model_id');
    expect(fetchMock).not.toHaveBeenCalled();

    const distintos = precos(SHOPEE_UPDATE_PRICE_MAX_MODELS);
    expect(new Set(distintos.map((e) => e.model_id)).size).toBe(SHOPEE_UPDATE_PRICE_MAX_MODELS);
    await client.updatePrice({ item_id: ITEM_ID, price_list: distintos });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P11 — NEAR-MISS: `model_id` −1 é RECUSADO antes do fetch; PAR: `model_id` 0 sozinho passa (o guarda é NÃO-negativo)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const negativo = await erroDe(
      client.updatePrice({ item_id: ITEM_ID, price_list: [{ model_id: -1, original_price: 10 }] }),
    );
    expect(negativo).toBeInstanceOf(ShopeeConfigError);
    expect((negativo as Error).message).toContain('price_list[0].model_id');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 10 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P12 — NEAR-MISS: `model_id` 1.5 é RECUSADO antes do fetch; PAR: o inteiro vizinho passa', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const fracionario = await erroDe(
      client.updatePrice({ item_id: ITEM_ID, price_list: [{ model_id: 1.5, original_price: 10 }] }),
    );
    expect(fracionario).toBeInstanceOf(ShopeeConfigError);
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 2, original_price: 10 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P13 — NEAR-MISS: 10.005 (TRÊS casas) é RECUSADO antes do fetch; PAR: 10.1, "10.10" e 0.01 passam', async () => {
    // ⚠️ A página: BR e SG "can set the price with two decimal place". O que uma
    // terceira casa faz lá é INVERIFICADO (recusa, trunca ou arredonda?), então
    // ela nunca chega ao fio — e é RECUSADA, não arredondada: arredondar é de
    // quem chama (`roundReais`), para o pacote nunca escolher um preço.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    for (const preco of [10.005, 0.1 + 0.2, 19.999]) {
      const erro = await erroDe(
        client.updatePrice({
          item_id: ITEM_ID,
          price_list: [{ model_id: MODEL_ID, original_price: preco }],
        }),
      );
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      expect((erro as Error).message).toContain('no máximo duas casas decimais');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // `Number('10.10')` e `10.1` são o MESMO double — o zero final é hábito de
    // exibição, não um valor. E a soma que o app ARREDONDOU passa: o guarda
    // concorda bit a bit com a única regra de arredondamento do repo.
    const aceitos = [10.1, Number('10.10'), 0.01, roundReais(0.1 + 0.2)];
    for (const preco of aceitos) {
      await client.updatePrice({
        item_id: ITEM_ID,
        price_list: [{ model_id: MODEL_ID, original_price: preco }],
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(aceitos.length);
    const enviados = fetchMock.mock.calls.map(
      ([, init]) =>
        (JSON.parse(String(init?.body)) as { price_list: { original_price: number }[] })
          .price_list[0]!.original_price,
    );
    expect(enviados).toStrictEqual([10.1, 10.1, 0.01, 0.3]);
  });

  it('T-P14 — NEAR-MISS: preço 0, −1, NaN e Infinity são RECUSADOS antes do fetch; PAR: 0.01 passa', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    for (const preco of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const erro = await erroDe(
        client.updatePrice({
          item_id: ITEM_ID,
          price_list: [{ model_id: MODEL_ID, original_price: preco }],
        }),
      );
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      expect((erro as Error).message).toContain('price_list[0].original_price');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: MODEL_ID, original_price: 0.01 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P15 — NEAR-MISS: `model_id` 0 AO LADO de um id real é RECUSADO (nas duas ordens); PAR: o 0 SOZINHO passa', async () => {
    // ⚠️ `0` diz "este item não tem modelos". Um 0 ao lado de um id real é bug de
    // quem chama, e a Shopee o responderia com um de DOIS erros opostos — nenhum
    // dos quais nomeia o engano de verdade.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const misturas: readonly (readonly ShopeeUpdatePriceEntry[])[] = [
      [
        { model_id: 0, original_price: 10 },
        { model_id: MODEL_ID, original_price: 10 },
      ],
      [
        { model_id: MODEL_ID, original_price: 10 },
        { model_id: 0, original_price: 10 },
      ],
    ];
    for (const price_list of misturas) {
      const erro = await erroDe(client.updatePrice({ item_id: ITEM_ID, price_list }));
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      expect((erro as Error).message).toContain('model_id 0');
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 10 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P16 — os QUASE-IGUAIS ACEITOS numa passada só: 10.1, "10.10", 0.01, `{model_id: 0}` sozinho e 50 distintos', async () => {
    // O lado ACEITO de cada guarda acima, junto: um guarda que recusasse demais
    // (o positivo no `model_id`, um limite de 49, "duas casas" lido como
    // "exatamente duas") vermelha AQUI, e não só nos testes de recusa.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const aceitos: readonly (readonly ShopeeUpdatePriceEntry[])[] = [
      [{ model_id: MODEL_ID, original_price: 10.1 }],
      [{ model_id: MODEL_ID, original_price: Number('10.10') }],
      [{ model_id: MODEL_ID, original_price: 0.01 }],
      [{ model_id: 0, original_price: 11.11 }],
      precos(SHOPEE_UPDATE_PRICE_MAX_MODELS, 1234.56),
    ];
    for (const price_list of aceitos) {
      await expect(client.updatePrice({ item_id: ITEM_ID, price_list })).resolves.toBeDefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(aceitos.length);
  });

  it('T-P17 — FONTE: o bloco `updatePrice: async` carrega `payloadNoErro: true` e NENHUMA tolerância de VEREDICTO, e mora FORA do recorte do estoque', () => {
    // ⚠️ Asserção de FONTE, o par do teste 100. As tolerâncias do transporte são
    // por operação e cada uma tem os seus call sites MEDIDOS: a de CARGA
    // (`payloadNoErro`) a sonda do passo 13 mediu aqui — o erro chegou junto com
    // o `failure_list` (T-P6) —, e as duas de VEREDICTO (chave ausente, valor
    // apelidado) nada mediu nesta página. Um teste de comportamento cujo corpo
    // não traga listas junto de um erro passaria com ou sem a flag — e o 100
    // sozinho NÃO pegaria o método morando no recorte dele: esse recorte
    // (`updateStock: async` → `getItemPromotion: async`) continua contendo a
    // flag e não a tolerância de chave, com ou sem o preço lá dentro. Daí a
    // asserção de LUGAR abaixo.
    const marcador = 'updatePrice: async';
    expect(FONTE_API.split(marcador).length - 1).toBe(1);
    const inicio = FONTE_API.indexOf(marcador);
    const resto = FONTE_API.slice(inicio);
    // O fim do método: a primeira `},` na indentação das operações (4 espaços).
    const fimRelativo = resto.search(/\n {4}\},/);
    expect(fimRelativo).toBeGreaterThan(0);
    const bloco = resto.slice(0, fimRelativo);

    expect(bloco).toContain('SHOPEE_UPDATE_PRICE_PATH');
    expect(bloco).toContain('shopeeUpdatePriceSchema');
    // O guarda corre ANTES da chamada — é o que faz "antes do fetch" valer.
    const guarda = bloco.indexOf('assertUpdatePriceParams(body)');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(bloco.indexOf('shopeeCall('));
    // A flag de CARGA, exatamente UMA vez, e DENTRO da chamada ao transporte.
    expect(bloco.split('payloadNoErro: true').length - 1).toBe(1);
    expect(bloco.indexOf('payloadNoErro: true')).toBeGreaterThan(bloco.indexOf('shopeeCall('));
    // ⛔ QUASE-IGUAL: nenhuma das duas tolerâncias de VEREDICTO.
    for (const tolerancia of ['erroAusenteEhSucesso', 'emptyErrorAliases']) {
      expect(bloco).not.toContain(tolerancia);
    }
    // As contagens do ARQUIVO inteiro: a de chave ausente não se moveu com o
    // passo 13; a de carga foi de 1 para 2 — este call site — e de 2 para 3 com
    // o leitor de lote do passo 15 (o teste E-L1 o fixa).
    expect(FONTE_API.split('erroAusenteEhSucesso').length - 1).toBe(2);
    expect(FONTE_API.split('payloadNoErro: true').length - 1).toBe(3);

    // O LUGAR: depois da última leitura do passo 12, e NUNCA dentro do recorte
    // que o teste 100 lê.
    const inicioEstoque = FONTE_API.indexOf('updateStock: async');
    const fimEstoque = FONTE_API.indexOf('getItemPromotion: async');
    expect(inicioEstoque).toBeGreaterThan(-1);
    expect(fimEstoque).toBeGreaterThan(inicioEstoque);
    expect(FONTE_API.slice(inicioEstoque, fimEstoque)).not.toContain('updatePrice');
    expect(inicio).toBeGreaterThan(FONTE_API.indexOf('getWarehouseDetail: async'));
  });

  it('T-P18 — NEAR-MISS: `item_id` 0 é RECUSADO antes do fetch; PAR: o MESMO corpo com o item_id válido passa', async () => {
    // ⚠️ `item_id` é POSITIVO — 0 nunca é um anúncio. O contraste com `model_id`,
    // onde o 0 é legal, é o ponto.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const price_list = [{ model_id: 0, original_price: 11.11 }];

    const semItem = await erroDe(client.updatePrice({ item_id: 0, price_list }));
    expect(semItem).toBeInstanceOf(ShopeeConfigError);
    expect((semItem as Error).message).toContain('item_id');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.updatePrice({ item_id: ITEM_ID, price_list });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-P19 — a operação e o caminho saem pelo index do pacote, e o guarda lê o limite PRÓPRIO do preço', () => {
    // ⚠️ `index.ts` re-exporta por WILDCARD — um rename silencioso tiraria a
    // operação da superfície pública sem quebrar nada dentro do pacote.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPDATE_PRICE_BODY));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock));
    expect(typeof client.updatePrice).toBe('function');
    expect(pacote.SHOPEE_UPDATE_PRICE_PATH).toBe(SHOPEE_UPDATE_PRICE_PATH);
    expect(pacote.SHOPEE_UPDATE_PRICE_PATH).not.toBe(pacote.SHOPEE_UPDATE_STOCK_PATH);
    expect(pacote.SHOPEE_UPDATE_PRICE_MAX_MODELS).toBe(SHOPEE_UPDATE_PRICE_MAX_MODELS);
    // ⚠️ O guarda lê o limite do PREÇO, não o do estoque: iguais hoje, e uma
    // sonda que mova um não pode mover o outro.
    const guarda = FONTE_API.slice(FONTE_API.indexOf('function assertUpdatePriceParams'));
    const corpoDoGuarda = guarda.slice(0, guarda.search(/\n\}/));
    expect(corpoDoGuarda).toContain('SHOPEE_UPDATE_PRICE_MAX_MODELS');
    expect(corpoDoGuarda).not.toContain('SHOPEE_UPDATE_STOCK_MAX_MODELS');
    expect(corpoDoGuarda).toContain('roundReais(');
  });

  it('T-P20 — a ORDEM das classes com a flag: PAR — throttle e reauth SEM `response` continuam a SUBCLASSE; NEAR-MISS — o MESMO throttle COM as listas vira ShopeeApiPartialError de `kind` `burst`', async () => {
    // ⚠️ O transporte classifica o envelope PRIMEIRO (`shopeeErrorFromEnvelope`)
    // e só DEPOIS tenta a carga; quando a carga parseia, o parcial SUBSTITUI a
    // subclasse (o docblock de ShopeeApiPartialError e o T18 do `call.test.ts`).
    // Na forma ORDINÁRIA — throttle e autorização morta não trazem `response` —
    // o schema da operação reprova e a subclasse sai intacta, flag ou não.
    const casos = [
      ['error_rate_limit', ShopeeRateLimitError, SHOPEE_ERROR_KIND.burst],
      ['product.error_limit', ShopeeRateLimitError, SHOPEE_ERROR_KIND.daily],
      ['shop_access_expired', ShopeeReauthRequiredError, SHOPEE_ERROR_KIND.reauth],
    ] as const;
    for (const [code, classe, kind] of casos) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(erroBody(code)));
      const erro = await erroDe(
        createShopeeClient(shopConfig(fetchMock)).updatePrice({
          item_id: ITEM_ID,
          price_list: precos(1),
        }),
      );
      expect(erro, code).toBeInstanceOf(classe);
      expect(erro, code).not.toBeInstanceOf(ShopeeApiPartialError);
      expect((erro as ShopeeApiError).kind, code).toBe(kind);
      expect((erro as ShopeeApiError).code, code).toBe(code);
    }

    // ⛔ NEAR-MISS — a QUINA: o MESMO `error_rate_limit`, agora COM as listas.
    // Chega como ShopeeApiPartialError, NÃO como ShopeeRateLimitError, e o
    // veredicto de retentativa sobrevive só em `kind`. Quem monta a escada do
    // preço lê `kind` DENTRO do braço parcial; uma escada que lesse só a classe
    // trataria um throttle como uma recusa por modelo. Se o transporte um dia
    // passar a preferir a subclasse, ESTA linha vermelha — e o braço do
    // remetente muda junto.
    const throttleComListas = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...UPDATE_PRICE_ERRO_COM_LISTAS_BODY,
        error: 'error_rate_limit',
        message: 'sem detalhe',
      }),
    );
    const quina = await erroDe(
      createShopeeClient(shopConfig(throttleComListas)).updatePrice({
        item_id: ITEM_ID,
        price_list: precos(1),
      }),
    );
    expect(quina).toBeInstanceOf(ShopeeApiPartialError);
    expect(quina).not.toBeInstanceOf(ShopeeRateLimitError);
    expect((quina as ShopeeApiPartialError).kind).toBe(SHOPEE_ERROR_KIND.burst);
    expect((quina as ShopeeApiPartialError).code).toBe('error_rate_limit');
    expect(
      shopeeUpdatePriceSchema.parse((quina as ShopeeApiPartialError).parsed).response.failure_list,
    ).toHaveLength(1);
  });

  it('T-P21 — PAR: o eco VIVO de um item SEM modelo (só `original_price`, sonda P4c) é DEVOLVIDO com `model_id: null`; NEAR-MISS: um eco com `model_id` NÃO numérico continua ShopeeSchemaError', async () => {
    // ⚠️ B-1, pelo transporte REAL. A operação publicada exigia `model_id` no
    // `success_list` e lançou `ShopeeSchemaError
    // campos=["response.success_list[].model_id"]` numa escrita que tinha
    // ATERRISSADO (read-back == pedido) — o pior dos dois erros: o preço mudou
    // na Shopee e o app registraria falha.
    const vivo = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-preco-vivo',
        error: '',
        message: '',
        warning: '',
        response: { success_list: [{ original_price: 13.4 }] },
      }),
    );
    const res = await createShopeeClient(shopConfig(vivo)).updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: 0, original_price: 13.4 }],
    });
    expect(res.error).toBe('');
    expect(res.response.failure_list).toStrictEqual([]);
    expect(res.response.success_list).toStrictEqual([{ model_id: null, original_price: 13.4 }]);
    // Tipado: `number | null` — o casamento do item sem modelo é pela AUSÊNCIA.
    const id: number | null = res.response.success_list[0]!.model_id;
    expect(id).toBeNull();
    expect(id).not.toBe(0);

    // PAR: o eco de um item COM modelo continua chaveado pelo inteiro.
    const comModelo = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpoComEco(13.4)));
    const resModelo = await createShopeeClient(shopConfig(comModelo)).updatePrice({
      item_id: ITEM_ID,
      price_list: [{ model_id: MODEL_ID, original_price: 13.4 }],
    });
    expect(resModelo.response.success_list[0]!.model_id).toBe(MODEL_ID);

    // ⛔ NEAR-MISS: a tolerância é de AUSÊNCIA, não de lixo — um `model_id` que
    // veio e não é número recusa o corpo, em vez de virar "item sem modelo".
    const lixo = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-preco-lixo',
        error: '',
        message: '',
        response: { success_list: [{ model_id: 'abc', original_price: 13.4 }] },
      }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(lixo)).updatePrice({
        item_id: ITEM_ID,
        price_list: [{ model_id: MODEL_ID, original_price: 13.4 }],
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeSchemaError);
    expect((erro as ShopeeSchemaError).campos.join(' ')).toContain('model_id');
  });
});

/* ------------------------ the invoice upload (step 14) -------------------- */

/** O `order_sn` de fixture do passo 14 — nunca um pedido real. */
const ORDER_SN_NFE = '260910KJBHUJDM';

/**
 * Um marcador que só existe DENTRO do XML de teste: se ele aparecer numa
 * mensagem de erro, o pacote vazou o documento para uma exceção.
 */
const MARCADOR_DO_XML = 'MARCADOR-SO-DENTRO-DO-XML-7f3a';

/**
 * Um `nfeProc` SINTÉTICO: sem chave de acesso, sem CNPJ, sem comprador — o
 * pacote não lê nada disso, e um teste de pacote não tem por que carregar dado
 * fiscal. `xProd` recebe o texto acentuado que mede a diferença entre CARACTERES
 * e BYTES em UTF-8.
 */
function xmlDeTeste(xProd = 'Camiseta Algodão Orgânico'): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00"><NFe><infNFe versao="4.00">' +
    `<det nItem="1"><prod><xProd>${xProd}</xProd></prod></det>` +
    `<infAdic><infCpl>${MARCADOR_DO_XML}</infCpl></infAdic></infNFe></NFe></nfeProc>`
  );
}

const bytesUtf8 = (texto: string): number => new TextEncoder().encode(texto).byteLength;

/**
 * Um XML com EXATAMENTE `alvo` bytes em UTF-8, completado com `ç` (2 bytes cada)
 * — de modo que o número de CARACTERES fica bem abaixo do de bytes, e uma
 * checagem por `.length` aceitaria o que o fio recusa.
 */
function xmlComBytes(alvo: number): string {
  const falta = alvo - bytesUtf8(xmlDeTeste(''));
  const xml = xmlDeTeste(`${'ç'.repeat(Math.floor(falta / 2))}${falta % 2 === 1 ? 'a' : ''}`);
  expect(bytesUtf8(xml)).toBe(alvo);
  return xml;
}

/** O sucesso da PÁGINA: o envelope NU — sem `response`, sem eco, sem id. */
const UPLOAD_INVOICE_BODY = { request_id: 'req-nfe', error: '', message: '' };

function paramsNfe(extra: Partial<UploadInvoiceDocParams> = {}): UploadInvoiceDocParams {
  return { orderSn: ORDER_SN_NFE, xml: xmlDeTeste(), ...extra };
}

describe('upload_invoice_doc (passo 14)', () => {
  it('N1 — os literais do fio: caminho, campo `file`, file_type "4", octet-stream, `procNFe.xml` e o teto de 1 MiB', () => {
    // ⚠️ Fixados por VALOR: o nome do arquivo NUNCA deriva do documento (o
    // legado usava a chave de acesso nele), e o teto é MiB, o precedente do
    // `upload_image` ("Max 10.0 MB" = 10 * 1024 * 1024).
    expect(SHOPEE_UPLOAD_INVOICE_DOC_PATH).toBe('/api/v2/order/upload_invoice_doc');
    expect(SHOPEE_UPLOAD_INVOICE_DOC_FIELD).toBe('file');
    expect(SHOPEE_INVOICE_FILE_TYPE_XML).toBe('4');
    expect(SHOPEE_UPLOAD_INVOICE_DOC_CONTENT_TYPE).toBe('application/octet-stream');
    expect(SHOPEE_UPLOAD_INVOICE_DOC_FILENAME).toBe('procNFe.xml');
    expect(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES).toBe(1024 * 1024);
  });

  it('N2 — POSTa multipart SEM cabeçalho Content-Type, shop-signed, com EXATAMENTE `file`, `order_sn` e `file_type`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    await createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc(paramsNfe());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_UPLOAD_INVOICE_DOC_PATH);
    expect(init?.method).toBe('POST');
    // SHOP-signed: o token e a loja na query, e nada além dos comuns.
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    expect(url.searchParams.get('access_token')).toBe('access-inventado');
    expect(url.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
    // ⚠️ O `fetch` escreve o Content-Type COM o boundary; um cabeçalho nosso
    // produziria um corpo que a Shopee não parseia.
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');

    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect([...form.keys()].sort()).toEqual(['file', 'file_type', 'order_sn']);
    const arquivo = form.get(SHOPEE_UPLOAD_INVOICE_DOC_FIELD);
    expect(arquivo).toBeInstanceOf(Blob);
    expect((arquivo as File).name).toBe('procNFe.xml');
    expect((arquivo as Blob).type).toBe('application/octet-stream');
    expect(form.get('order_sn')).toBe(ORDER_SN_NFE);
    // ⚠️ Um campo de TEXTO '4', nunca o rótulo "xml".
    expect(form.get('file_type')).toBe('4');
  });

  it('N3 — PAR: os bytes que viajam são o UTF-8 do XML, byte a byte — e com `xProd` acentuado há MAIS bytes que caracteres', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const xml = xmlDeTeste('Calça Jeans Ação — Tamanho Único');
    await createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc(paramsNfe({ xml }));

    const arquivo = (fetchMock.mock.calls[0]![1]?.body as FormData).get('file') as Blob;
    const enviados = new Uint8Array(await arquivo.arrayBuffer());
    expect(enviados).toEqual(new TextEncoder().encode(xml));
    // ⛔ QUASE-IGUAL: a contagem de caracteres NÃO é a de bytes — o teto mede bytes.
    expect(enviados.byteLength).toBeGreaterThan(xml.length);
  });

  it('N4 — PAR no teto, em BYTES UTF-8: EXATAMENTE o máximo passa; ⛔ QUASE-IGUAL: máximo + 1 é recusado ANTES do fetch, sem ecoar o XML', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const noTeto = xmlComBytes(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    // ⚠️ É isto que mata uma checagem por `.length`: o XML tem ~metade dos
    // caracteres do teto e mesmo assim está EXATAMENTE nele em bytes.
    expect(noTeto.length).toBeLessThan(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    await client.uploadInvoiceDoc(paramsNfe({ xml: noTeto }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const enviado = (fetchMock.mock.calls[0]![1]?.body as FormData).get('file') as Blob;
    expect(enviado.size).toBe(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);

    const acima = xmlComBytes(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES + 1);
    expect(acima.length).toBeLessThan(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    const erro = await erroDe(client.uploadInvoiceDoc(paramsNfe({ xml: acima })));
    expect(erro).toBeInstanceOf(ShopeeConfigError);
    const mensagem = (erro as Error).message;
    // A mensagem nomeia o TAMANHO, e nada do documento.
    expect(mensagem).toContain(String(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES + 1));
    expect(mensagem).not.toContain(MARCADOR_DO_XML);
    expect(mensagem).not.toContain('ç');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('N5 — um XML em branco e um order_sn em branco são recusados ANTES do token e do fetch, e nenhuma mensagem carrega o documento', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
    const client = createShopeeClient(shopConfig(fetchMock, getAccessToken));

    // ⚠️ Espaços INCOMUNS de propósito (NBSP, em space): `trim()` os remove, e
    // um guarda que fizesse `JSON.stringify` do valor os carregaria para a
    // mensagem — é o `assertTextoNaoVazio`, que para `xml` imprimiria uma NF-e
    // inteira numa exceção.
    const branco = '   \t\n';
    const semXml = await erroDe(client.uploadInvoiceDoc(paramsNfe({ xml: branco })));
    expect(semXml).toBeInstanceOf(ShopeeConfigError);
    const mensagemSemXml = (semXml as Error).message;
    expect(mensagemSemXml).toContain('xml');
    expect(mensagemSemXml).toContain(String(branco.length));
    expect(mensagemSemXml).not.toContain(' ');
    expect(mensagemSemXml).not.toContain(' ');
    expect(mensagemSemXml).not.toContain(JSON.stringify(branco));

    // O XML CARREGA o marcador aqui, e a recusa é do order_sn: nada do
    // documento pode aparecer na mensagem.
    const semPedido = await erroDe(client.uploadInvoiceDoc(paramsNfe({ orderSn: '  ' })));
    expect(semPedido).toBeInstanceOf(ShopeeConfigError);
    expect((semPedido as Error).message).toContain('order_sn');
    expect((semPedido as Error).message).not.toContain(MARCADOR_DO_XML);

    const vazio = await erroDe(client.uploadInvoiceDoc(paramsNfe({ xml: '' })));
    expect(vazio).toBeInstanceOf(ShopeeConfigError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();

    // PAR: o order_sn vai VERBATIM — o guarda recusa branco e não apara nada,
    // a regra das leituras de pedido.
    await client.uploadInvoiceDoc(paramsNfe({ orderSn: ` ${ORDER_SN_NFE} ` }));
    expect((fetchMock.mock.calls[0]![1]?.body as FormData).get('order_sn')).toBe(
      ` ${ORDER_SN_NFE} `,
    );
  });

  it('N6 — o sucesso é o envelope NU da página, devolvido inteiro', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const res = await createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc(paramsNfe());

    expect(res.error).toBe('');
    expect(res.request_id).toBe('req-nfe');
    expect(res.message).toBe('');
    expect(res.warning).toBeNull();
  });

  it('N7 — uma recusa do envelope entrega `code` e `providerMessage` VERBATIM — o TAB no fim do código incluído, nada aparado', async () => {
    // ⚠️ O código da página TERMINA num TAB, e a frase é a que o classificador
    // do app vai ler. O `message` formatado já contém `upload`, `invoice` e
    // `error` no caminho e no código — por isso a frase viaja À PARTE.
    const frase = 'Wrong parameters, detail: Invalid NF-e.';
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-nfe-erro',
        error: 'order.upload_invoice_error\t',
        message: frase,
      }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc(paramsNfe()),
    );

    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).not.toBeInstanceOf(ShopeeApiPartialError);
    const apiErr = erro as ShopeeApiError;
    expect(apiErr.code).toBe('order.upload_invoice_error\t');
    expect(apiErr.kind).toBe(SHOPEE_ERROR_KIND.other);
    expect(apiErr.providerMessage).toBe(frase);
    expect(apiErr.requestId).toBe('req-nfe-erro');
    // ⛔ QUASE-IGUAL: o `message` formatado NÃO é a frase — ele carrega o caminho.
    expect(apiErr.message).not.toBe(frase);
    expect(apiErr.message).toContain(SHOPEE_UPLOAD_INVOICE_DOC_PATH);
    expect(apiErr.providerMessage).not.toContain(SHOPEE_UPLOAD_INVOICE_DOC_PATH);

    // PAR: espaços e pontuação da frase sobrevivem — nenhuma dobra no pacote.
    const comEspacos = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-nfe-erro-2',
        error: 'error_param',
        message: '  File error.\t',
      }),
    );
    const erro2 = await erroDe(
      createShopeeClient(shopConfig(comEspacos)).uploadInvoiceDoc(paramsNfe()),
    );
    expect((erro2 as ShopeeApiError).providerMessage).toBe('  File error.\t');
    expect((erro2 as ShopeeApiError).code).toBe('error_param');
  });

  it('N8 — ⛔ QUASE-IGUAL: um corpo SEM a chave `error` é RECUSADO, mesmo COM um objeto `response` (a classe do registro 73)', async () => {
    // ⚠️ Nenhuma tolerância mora aqui. Com a de chave ausente, o segundo corpo
    // viraria SUCESSO — o pior erro possível para um envio de documento fiscal.
    const corpos = [
      { request_id: 'req-nfe-sem-error', message: '' },
      { request_id: 'req-nfe-sem-error-2', message: '', response: {} },
    ];
    for (const corpo of corpos) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpo));
      const erro = await erroDe(
        createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc(paramsNfe()),
      );
      expect(erro).toBeInstanceOf(ShopeeSchemaError);
      expect((erro as ShopeeSchemaError).campos).toContain('error');
    }
  });

  it('N9 — FONTE: o bloco `uploadInvoiceDoc: async` não carrega tolerância nenhuma, e as contagens do arquivo não se moveram', () => {
    // ⚠️ Asserção de FONTE: um teste de comportamento cujo corpo TEM `error`
    // passaria com ou sem uma flag do transporte. As contagens são as mesmas que
    // os testes 82/100/T-P17 fixam — o passo 14 não acrescenta call site.
    const marcador = 'uploadInvoiceDoc: async';
    expect(FONTE_API.split(marcador).length - 1).toBe(1);
    const resto = FONTE_API.slice(FONTE_API.indexOf(marcador));
    const fimRelativo = resto.search(/\n {4}\},/);
    expect(fimRelativo).toBeGreaterThan(0);
    const bloco = resto.slice(0, fimRelativo);

    expect(bloco).toContain('SHOPEE_UPLOAD_INVOICE_DOC_PATH');
    expect(bloco).toContain('shopeeUploadInvoiceDocSchema');
    expect(bloco).toContain('multipart:');
    // O guarda corre ANTES do token e da chamada.
    const guarda = bloco.indexOf('assertUploadInvoiceDocParams(p)');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(bloco.indexOf('signedCall()'));
    expect(guarda).toBeLessThan(bloco.indexOf('shopeeCall('));
    for (const tolerancia of [
      'erroAusenteEhSucesso',
      'payloadNoErro',
      'emptyErrorAliases',
      'sensitive',
      'headers',
    ]) {
      expect(bloco).not.toContain(tolerancia);
    }
    expect(FONTE_API.split('erroAusenteEhSucesso').length - 1).toBe(2);
    // 3 desde o passo 15: o leitor de lote `lerLoteLogistico` (o teste E-L1).
    expect(FONTE_API.split('payloadNoErro: true').length - 1).toBe(3);
  });

  it('N10 — a operação mora SÓ no cliente da LOJA: o de parceiro não a ganha', () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));
    expect('uploadInvoiceDoc' in partner).toBe(false);
    expect(typeof createShopeeClient(shopConfig(fetchMock)).uploadInvoiceDoc).toBe('function');
  });

  it('N11 — a operação, o caminho, os literais, o schema e o `providerMessage` saem pelo index do pacote', async () => {
    // ⚠️ `index.ts` re-exporta por WILDCARD: um rename tiraria a operação da
    // superfície pública sem quebrar nada dentro do pacote.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(UPLOAD_INVOICE_BODY));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock));
    expect(typeof client.uploadInvoiceDoc).toBe('function');
    expect(pacote.SHOPEE_UPLOAD_INVOICE_DOC_PATH).toBe(SHOPEE_UPLOAD_INVOICE_DOC_PATH);
    expect(pacote.SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES).toBe(SHOPEE_UPLOAD_INVOICE_DOC_MAX_BYTES);
    expect(pacote.SHOPEE_UPLOAD_INVOICE_DOC_FIELD).toBe(SHOPEE_UPLOAD_INVOICE_DOC_FIELD);
    expect(pacote.SHOPEE_INVOICE_FILE_TYPE_XML).toBe(SHOPEE_INVOICE_FILE_TYPE_XML);
    expect(pacote.SHOPEE_UPLOAD_INVOICE_DOC_CONTENT_TYPE).toBe(
      SHOPEE_UPLOAD_INVOICE_DOC_CONTENT_TYPE,
    );
    expect(pacote.SHOPEE_UPLOAD_INVOICE_DOC_FILENAME).toBe(SHOPEE_UPLOAD_INVOICE_DOC_FILENAME);
    expect(pacote.shopeeUploadInvoiceDocSchema.parse(UPLOAD_INVOICE_BODY).error).toBe('');
    // E o carregador da frase do provedor, na classe exportada.
    const erro = new pacote.ShopeeApiError('x', {
      code: 'error_param',
      kind: pacote.SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: pacote.SHOPEE_UPLOAD_INVOICE_DOC_PATH,
      providerMessage: 'File error.',
    });
    expect(erro.providerMessage).toBe('File error.');
    await client.uploadInvoiceDoc(paramsNfe());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                 A etiqueta (passo 15) — as sete operações                   */
/* -------------------------------------------------------------------------- */

/** ⚠️ Ids de FIXTURE — nunca um pedido, pacote ou rastreio real. */
const PEDIDO_ETQ = '260910KJBHUJDM';
const PACOTE_1 = 'OFG000000000001';
const PACOTE_2 = 'OFG000000000002';
const RASTREIO_ETQ = 'BR000000000000T';

/** A amostra de resposta da própria página, com ids de fixture. */
const SHIPPING_PARAMETER_BODY = {
  error: '',
  message: '',
  request_id: 'req-param-envio',
  response: {
    info_needed: { dropoff: [], pickup: ['address_id', 'pickup_time_id'] },
    dropoff: null,
    pickup: {
      address_list: [
        {
          address_id: 123,
          region: 'SG',
          state: '',
          city: '',
          district: '',
          town: '',
          address: '',
          zipcode: '40009',
          address_flag: ['default_address', 'pickup_address', 'return_address'],
          time_slot_list: null,
        },
        {
          address_id: 234,
          region: 'SG',
          address_flag: ['pickup_address'],
          // ⚠️ Um id de horário NUMÉRICO no fio: volta como os seus dígitos.
          time_slot_list: [
            { date: 1_767_000_000, time_text: 'manhã', pickup_time_id: 77, flags: [] },
          ],
        },
      ],
    },
  },
};

const SHIP_ORDER_BODY = { error: '', message: '', request_id: 'req-ship' };

const TRACKING_BODY = {
  error: '',
  message: '',
  request_id: 'req-rastreio',
  response: { tracking_number: RASTREIO_ETQ, hint: 'sem dica', first_mile_tracking_number: '-' },
};

/** `get_shipping_document_parameter` — a amostra da página: um aviso em LISTA e uma linha falha SEM package_number. */
const PARAM_DOC_BODY = {
  error: '',
  message: '',
  request_id: 'req-param-doc',
  response: {
    result_list: [
      {
        order_sn: PEDIDO_ETQ,
        package_number: PACOTE_1,
        suggest_shipping_document_type: 'THERMAL_AIR_WAYBILL',
        selectable_shipping_document_type: ['THERMAL_AIR_WAYBILL'],
      },
      {
        order_sn: PEDIDO_ETQ,
        fail_error: 'logistics.order_not_exist',
        fail_message: 'The order_sn you provided is not exist. Please check',
      },
    ],
  },
  warning: [{ order_sn: PEDIDO_ETQ }],
};

/** `create_shipping_document` — a amostra de ERRO da página: todas falharam, com a linha junto. */
function loteTodoFalhou(
  error = 'common.batch_api_all_failed',
  resultList: readonly unknown[] = [
    {
      order_sn: PEDIDO_ETQ,
      fail_error: 'logistics.package_can_not_print',
      fail_message: 'The package can not print now.',
    },
  ],
): Record<string, unknown> {
  return {
    error,
    message: 'Failed, please check result_list for more details.',
    response: { result_list: resultList },
    request_id: 'req-todo-falhou',
  };
}

/** Um bloco de método de `createShopeeClient`, do marcador à primeira `},` na indentação das operações. */
function blocoDoMetodo(marcador: string): string {
  expect(FONTE_API.split(marcador).length - 1).toBe(1);
  const resto = FONTE_API.slice(FONTE_API.indexOf(marcador));
  const fim = resto.search(/\n {4}\},/);
  expect(fim).toBeGreaterThan(0);
  return resto.slice(0, fim);
}

function corpoEnviado(fetchMock: {
  readonly mock: { readonly calls: Parameters<typeof globalThis.fetch>[] };
}): string {
  return String(fetchMock.mock.calls[0]![1]?.body);
}

describe('a etiqueta (passo 15)', () => {
  it('E1 — os sete caminhos, verbo a verbo da página, e as sete operações saem pelo index do pacote', async () => {
    expect(SHOPEE_GET_SHIPPING_PARAMETER_PATH).toBe('/api/v2/logistics/get_shipping_parameter');
    expect(SHOPEE_SHIP_ORDER_PATH).toBe('/api/v2/logistics/ship_order');
    expect(SHOPEE_GET_TRACKING_NUMBER_PATH).toBe('/api/v2/logistics/get_tracking_number');
    expect(SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER_PATH).toBe(
      '/api/v2/logistics/get_shipping_document_parameter',
    );
    expect(SHOPEE_CREATE_SHIPPING_DOCUMENT_PATH).toBe('/api/v2/logistics/create_shipping_document');
    expect(SHOPEE_GET_SHIPPING_DOCUMENT_RESULT_PATH).toBe(
      '/api/v2/logistics/get_shipping_document_result',
    );
    expect(SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH).toBe(
      '/api/v2/logistics/download_shipping_document',
    );
    expect(SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS).toBe(50);
    // P3: o padrão é o `{}` documentado, nunca o corpo de nulos do legado.
    expect(SHOPEE_SHIP_ORDER_DROPOFF_VAZIO).toBe('objeto-vazio');

    // ⚠️ `index.ts` re-exporta por WILDCARD e `logistica.ts` é um módulo NOVO:
    // sem a sua linha lá, nada abaixo sairia pela porta pública.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHIP_ORDER_BODY));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock));
    const operacoes = [
      'getShippingParameter',
      'shipOrder',
      'getTrackingNumber',
      'getShippingDocumentParameter',
      'createShippingDocument',
      'getShippingDocumentResult',
      'downloadShippingDocument',
    ] as const;
    for (const nome of operacoes) expect(typeof client[nome]).toBe('function');
    expect(pacote.SHOPEE_SHIP_ORDER_PATH).toBe(SHOPEE_SHIP_ORDER_PATH);
    expect(pacote.SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH).toBe(
      SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH,
    );
    expect(pacote.falhaDaLinha).toBe(falhaDaLinha);
    expect(typeof pacote.assertShippingParameterParams).toBe('function');
    expect(pacote.SHOPEE_SHIPPING_DOCUMENT_STATUS).toBe(SHOPEE_SHIPPING_DOCUMENT_STATUS);
    // E só no cliente da LOJA: o de parceiro não ganha nenhuma.
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));
    for (const nome of operacoes) expect(nome in partner).toBe(false);
  });

  it('E2 — getShippingParameter: GET shop-signed, `package_number` APARADO quando dado e AUSENTE quando não (S16), e a amostra da página volta DESEMBRULHADA', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(SHIPPING_PARAMETER_BODY),
    );
    const client = createShopeeClient(shopConfig(fetchMock));

    const param = await client.getShippingParameter({ orderSn: PEDIDO_ETQ });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_GET_SHIPPING_PARAMETER_PATH);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    // ⛔ QUASE-IGUAL: nenhuma chave `package_number` — nem vazia.
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS, 'order_sn'].sort());
    expect(url.searchParams.get('order_sn')).toBe(PEDIDO_ETQ);

    // A leitura: `info_needed` com `[]` (oferecido, nada a preencher) ≠ ausente.
    expect(param.info_needed?.dropoff).toEqual([]);
    expect(param.info_needed?.non_integrated).toBeNull();
    expect(param.dropoff).toBeNull();
    const enderecos = param.pickup?.address_list ?? [];
    expect(enderecos.map((e) => e?.address_id)).toEqual([123, 234]);
    expect(enderecos[1]?.time_slot_list?.[0]?.pickup_time_id).toBe('77');
    expect('response' in param).toBe(false);

    // PAR: com o pacote, a chave vai — APARADA, o que o guarda julgou.
    await client.getShippingParameter({ orderSn: PEDIDO_ETQ, packageNumber: ` ${PACOTE_1} ` });
    const url2 = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(url2.searchParams.get('package_number')).toBe(PACOTE_1);
  });

  it('E3 — shipOrder: os três corpos BYTE A BYTE; o dropoff sem nada a preencher é `"dropoff":{}` (S15), e sem pacote a chave `package_number` não existe (S16)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHIP_ORDER_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    await client.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'dropoff', dropoff: {} });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_SHIP_ORDER_PATH);
    expect(init?.method).toBe('POST');
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    // ⛔ QUASE-IGUAIS: nunca `"dropoff":null`, nunca a chave ausente, nunca o
    // objeto de nulos do legado, e nunca `"package_number":""`.
    expect(corpoEnviado(fetchMock)).toBe(`{"order_sn":"${PEDIDO_ETQ}","dropoff":{}}`);

    const corpos: readonly [ShipOrderParams, string][] = [
      [
        {
          orderSn: PEDIDO_ETQ,
          packageNumber: ` ${PACOTE_2} `,
          modo: 'pickup',
          pickup: { addressId: 234, pickupTimeId: '77' },
        },
        `{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_2}","pickup":{"address_id":234,"pickup_time_id":"77"}}`,
      ],
      // Sem horário: a chave `pickup_time_id` some — "sellers can arrange
      // shipment without selecting any time slot".
      [
        { orderSn: PEDIDO_ETQ, modo: 'pickup', pickup: { addressId: 123 } },
        `{"order_sn":"${PEDIDO_ETQ}","pickup":{"address_id":123}}`,
      ],
      [
        { orderSn: PEDIDO_ETQ, modo: 'dropoff', dropoff: { branchId: 7 } },
        `{"order_sn":"${PEDIDO_ETQ}","dropoff":{"branch_id":7}}`,
      ],
      [
        { orderSn: PEDIDO_ETQ, modo: 'non_integrated', nonIntegrated: {} },
        `{"order_sn":"${PEDIDO_ETQ}","non_integrated":{}}`,
      ],
      [
        {
          orderSn: PEDIDO_ETQ,
          modo: 'non_integrated',
          nonIntegrated: { trackingNumber: RASTREIO_ETQ },
        },
        `{"order_sn":"${PEDIDO_ETQ}","non_integrated":{"tracking_number":"${RASTREIO_ETQ}"}}`,
      ],
    ];
    for (const [params, esperado] of corpos) {
      fetchMock.mockClear();
      const res = await client.shipOrder(params);
      expect(corpoEnviado(fetchMock)).toBe(esperado);
      // A escrita devolve o envelope NU inteiro.
      expect(res.request_id).toBe('req-ship');
      expect(res.error).toBe('');
    }

    // ⚠️ Um modo por corpo, IMPOSSÍVEL de construir em tempo de compilação.
    const invalido: ShipOrderParams = {
      orderSn: PEDIDO_ETQ,
      modo: 'pickup',
      pickup: { addressId: 1 },
      // @ts-expect-error — `dropoff` não cabe num corpo de modo `pickup`.
      dropoff: {},
    };
    expect(invalido.modo).toBe('pickup');
  });

  it('E4 — P3: com a constante virada para `nulos-explicitos`, o dropoff sai como o corpo do legado — cada campo não preenchido um `null` EXPLÍCITO', async () => {
    // ⚠️ A virada é da SONDA (P3), numa constante só: aqui ela é simulada
    // trocando o módulo, e o padrão acima continua sendo o `{}`.
    vi.resetModules();
    vi.doMock('../src/logistica', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      SHOPEE_SHIP_ORDER_DROPOFF_VAZIO: 'nulos-explicitos',
    }));
    try {
      const api = await import('../src/api');
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHIP_ORDER_BODY));
      const client = api.createShopeeClient(shopConfig(fetchMock));
      await client.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'dropoff', dropoff: { branchId: 7 } });
      expect(corpoEnviado(fetchMock)).toBe(
        `{"order_sn":"${PEDIDO_ETQ}","dropoff":{"branch_id":7,"sender_real_name":null,"tracking_number":null,"slug":null}}`,
      );
    } finally {
      vi.doUnmock('../src/logistica');
      vi.resetModules();
    }
  });

  it('E5 — shipOrder NUNCA é repetido pelo pacote: rede, HTTP e `error_timeout` custam UMA chamada cada (o desfecho é DESCONHECIDO)', async () => {
    const params: ShipOrderParams = {
      orderSn: PEDIDO_ETQ,
      modo: 'pickup',
      pickup: { addressId: 123 },
    };

    const rede = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const erroRede = await erroDe(createShopeeClient(shopConfig(rede)).shipOrder(params));
    expect(erroRede).toBeInstanceOf(ShopeeNetworkError);
    expect(rede).toHaveBeenCalledTimes(1);

    const http = vi.fn<typeof globalThis.fetch>(
      async () => new Response('<html>gateway</html>', { status: 502 }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const erroHttp = await erroDe(createShopeeClient(shopConfig(http)).shipOrder(params));
    expect(erroHttp).toBeInstanceOf(ShopeeHttpError);
    expect(http).toHaveBeenCalledTimes(1);

    const timeout = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        request_id: 'req-ship-timeout',
        error: 'logistics.error_timeout',
        message: 'Timeout to call external system.',
      }),
    );
    const erroTimeout = await erroDe(createShopeeClient(shopConfig(timeout)).shipOrder(params));
    expect(erroTimeout).toBeInstanceOf(ShopeeApiError);
    expect(erroTimeout).not.toBeInstanceOf(ShopeeApiPartialError);
    expect((erroTimeout as ShopeeApiError).code).toBe('logistics.error_timeout');
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it('E6 — getTrackingNumber: SEM `response_optional_fields` por padrão (S19); pedido, é UM escalar unido por vírgula; e o `-` volta VERBATIM', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(TRACKING_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));

    const rastreio = await client.getTrackingNumber({
      orderSn: PEDIDO_ETQ,
      packageNumber: PACOTE_1,
    });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_GET_TRACKING_NUMBER_PATH);
    expect(init?.method).toBe('GET');
    // ⛔ QUASE-IGUAL: nenhuma chave de campo opcional — nem vazia.
    expect([...url.searchParams.keys()].sort()).toEqual(
      [...CHAVES_COMUNS, 'order_sn', 'package_number'].sort(),
    );
    expect(url.searchParams.get('package_number')).toBe(PACOTE_1);
    expect(rastreio.tracking_number).toBe(RASTREIO_ETQ);
    expect(rastreio.first_mile_tracking_number).toBe('-');
    expect(rastreio.hint).toBe('sem dica');
    expect(rastreio.plp_number).toBeNull();

    // Sem pacote: a chave some.
    await client.getTrackingNumber({ orderSn: PEDIDO_ETQ });
    const url2 = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(url2.searchParams.has('package_number')).toBe(false);

    // PAR: pedidos, os campos vão num escalar só, a grafia da página.
    await client.getTrackingNumber({
      orderSn: PEDIDO_ETQ,
      responseOptionalFields: ['plp_number', 'first_mile_tracking_number'],
    });
    const url3 = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(url3.searchParams.getAll('response_optional_fields')).toEqual([
      'plp_number,first_mile_tracking_number',
    ]);
  });

  it('E7 — S17: cada operação recusa um parâmetro ruim ANTES do token e do fetch', async () => {
    const recusas: readonly (readonly [string, (c: ShopeeClient) => Promise<unknown>])[] = [
      ['parâmetro: order_sn em branco', (c) => c.getShippingParameter({ orderSn: '  ' })],
      [
        'parâmetro: package_number ""',
        (c) => c.getShippingParameter({ orderSn: PEDIDO_ETQ, packageNumber: '' }),
      ],
      [
        'parâmetro: package_number "-" (aparado)',
        (c) => c.getShippingParameter({ orderSn: PEDIDO_ETQ, packageNumber: ' - ' }),
      ],
      [
        'ship: address_id 0',
        (c) => c.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'pickup', pickup: { addressId: 0 } }),
      ],
      [
        'ship: address_id inseguro',
        (c) =>
          c.shipOrder({
            orderSn: PEDIDO_ETQ,
            modo: 'pickup',
            pickup: { addressId: Number.MAX_SAFE_INTEGER + 1 },
          }),
      ],
      [
        'ship: pickup_time_id vazio',
        (c) =>
          c.shipOrder({
            orderSn: PEDIDO_ETQ,
            modo: 'pickup',
            pickup: { addressId: 123, pickupTimeId: '' },
          }),
      ],
      [
        'ship: branch_id fracionário',
        (c) => c.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'dropoff', dropoff: { branchId: 1.5 } }),
      ],
      [
        'ship: sender_real_name em branco',
        (c) =>
          c.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'dropoff', dropoff: { senderRealName: ' ' } }),
      ],
      [
        'ship: tracking "-"',
        (c) =>
          c.shipOrder({
            orderSn: PEDIDO_ETQ,
            modo: 'non_integrated',
            nonIntegrated: { trackingNumber: '-' },
          }),
      ],
      [
        'ship: modo desconhecido',
        (c) => c.shipOrder({ orderSn: PEDIDO_ETQ, modo: 'correio' } as unknown as ShipOrderParams),
      ],
      [
        'rastreio: lista de campos vazia',
        (c) => c.getTrackingNumber({ orderSn: PEDIDO_ETQ, responseOptionalFields: [] }),
      ],
      [
        'rastreio: campo com vírgula',
        (c) => c.getTrackingNumber({ orderSn: PEDIDO_ETQ, responseOptionalFields: ['a,b'] }),
      ],
      ['doc-parâmetro: lista vazia', (c) => c.getShippingDocumentParameter({ pacotes: [] })],
      [
        'criar: tracking em branco',
        (c) =>
          c.createShippingDocument({
            documentos: [{ orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1, trackingNumber: ' ' }],
          }),
      ],
      [
        'resultado: tipo em branco',
        (c) =>
          c.getShippingDocumentResult({
            documentos: [{ orderSn: PEDIDO_ETQ, shippingDocumentType: '' }],
          }),
      ],
      [
        'baixar: tipo em branco',
        (c) =>
          c.downloadShippingDocument({
            shippingDocumentType: '  ',
            documentos: [{ orderSn: PEDIDO_ETQ }],
          }),
      ],
    ];
    for (const [nome, chamar] of recusas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHIP_ORDER_BODY));
      const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
      const erro = await erroDe(chamar(createShopeeClient(shopConfig(fetchMock, getAccessToken))));
      expect(erro, nome).toBeInstanceOf(ShopeeConfigError);
      expect(getAccessToken, nome).not.toHaveBeenCalled();
      expect(fetchMock, nome).not.toHaveBeenCalled();
    }
  });

  it('E8 — as listas: 1…50, e um par (order_sn, package_number) repetido é recusado — julgado no que VAI (o pacote aparado)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PARAM_DOC_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const pacotes = (n: number): ShopeeAlvoDePacote[] =>
      Array.from({ length: n }, (_, i) => ({
        orderSn: PEDIDO_ETQ,
        packageNumber: `OFG${String(i).padStart(12, '0')}`,
      }));

    // PAR no teto: 50 passam; ⛔ QUASE-IGUAL: 51 não.
    await client.getShippingDocumentParameter({
      pacotes: pacotes(SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const acima = await erroDe(
      client.getShippingDocumentParameter({
        pacotes: pacotes(SHOPEE_SHIPPING_DOCUMENT_MAX_ORDERS + 1),
      }),
    );
    expect(acima).toBeInstanceOf(ShopeeConfigError);
    expect((acima as Error).message).toContain('51');

    // PAR: o MESMO pedido com dois pacotes é legítimo, e o pedido sem pacote
    // é um terceiro par.
    await client.getShippingDocumentParameter({
      pacotes: [
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1 },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
        { orderSn: PEDIDO_ETQ },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ⛔ O par repetido — e repetido DEPOIS de aparar, que é o que o fio leva.
    const repetidos: readonly (readonly ShopeeAlvoDePacote[])[] = [
      [
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1 },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1 },
      ],
      [
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1 },
        { orderSn: PEDIDO_ETQ, packageNumber: ` ${PACOTE_1}\t` },
      ],
      [
        { orderSn: PEDIDO_ETQ },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
        { orderSn: PEDIDO_ETQ },
      ],
    ];
    for (const lista of repetidos) {
      const erro = await erroDe(client.downloadShippingDocument({ documentos: lista }));
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      expect((erro as Error).message).toContain('repete o par');
    }
    const erroCriar = await erroDe(
      client.createShippingDocument({
        documentos: [
          { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2, trackingNumber: RASTREIO_ETQ },
          { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
        ],
      }),
    );
    expect(erroCriar).toBeInstanceOf(ShopeeConfigError);
    // A POSIÇÃO de uma entrada ruim é nomeada.
    const erroPosicao = await erroDe(
      client.getShippingDocumentResult({
        documentos: [{ orderSn: PEDIDO_ETQ }, { orderSn: PEDIDO_ETQ, packageNumber: '-' }],
      }),
    );
    expect((erroPosicao as Error).message).toContain('posição 1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('E9 — S18: nenhuma recusa ecoa um VALOR — só o campo, a posição e o tamanho', async () => {
    const MARCADOR = 'MARCADOR-ETQ-S18';
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(SHIP_ORDER_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    // ⚠️ Espaços INCOMUNS de propósito (NBSP, em space): `trim()` os remove, e
    // um guarda que fizesse `JSON.stringify` do valor os carregaria para a
    // mensagem.
    const incomuns = ['\u00a0', '\u2003'];
    const chamadas: readonly Promise<unknown>[] = [
      client.getShippingParameter({ orderSn: '\u00a0\u2003' }),
      client.getShippingParameter({ orderSn: PEDIDO_ETQ, packageNumber: '\u00a0-\u2003' }),
      client.getTrackingNumber({ orderSn: PEDIDO_ETQ, responseOptionalFields: [`${MARCADOR},x`] }),
      client.getShippingParameter({ orderSn: { toString: () => MARCADOR } as unknown as string }),
      client.shipOrder({
        orderSn: MARCADOR,
        modo: 'dropoff',
        dropoff: { branchId: 0, senderRealName: MARCADOR, slug: MARCADOR },
      }),
      client.shipOrder({
        orderSn: MARCADOR,
        modo: 'dropoff',
        dropoff: { senderRealName: MARCADOR, trackingNumber: '\u00a0-\u00a0' },
      }),
      client.getShippingDocumentParameter({
        pacotes: [
          { orderSn: MARCADOR, packageNumber: `${MARCADOR}-P` },
          { orderSn: MARCADOR, packageNumber: `${MARCADOR}-P` },
        ],
      }),
      client.createShippingDocument({
        documentos: [{ orderSn: MARCADOR, trackingNumber: '\u2003' }],
      }),
    ];
    for (const chamada of chamadas) {
      const erro = await erroDe(chamada);
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      const mensagem = (erro as Error).message;
      expect(mensagem).not.toContain(MARCADOR);
      for (const c of incomuns) expect(mensagem).not.toContain(c);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('E10 — getShippingDocumentParameter: POST com a lista BYTE A BYTE, e a amostra da página (aviso em LISTA + linha falha sem pacote) vira o LOTE', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(PARAM_DOC_BODY));
    const avisos: string[] = [];
    const client = createShopeeClient({
      ...shopConfig(fetchMock),
      onWarning: (w) => avisos.push(w.warning),
    });

    const lote = await client.getShippingDocumentParameter({
      pacotes: [{ orderSn: PEDIDO_ETQ, packageNumber: ` ${PACOTE_1}` }, { orderSn: PEDIDO_ETQ }],
    });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(rawUrl)).pathname).toBe(SHOPEE_GET_SHIPPING_DOCUMENT_PARAMETER_PATH);
    expect(init?.method).toBe('POST');
    expect(corpoEnviado(fetchMock)).toBe(
      `{"order_list":[{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_1}"},{"order_sn":"${PEDIDO_ETQ}"}]}`,
    );

    expect(lote.todasFalharam).toBe(false);
    expect(lote.requestId).toBe('req-param-doc');
    expect(lote.linhasIlegiveis).toBe(0);
    expect(lote.linhas).toHaveLength(2);
    expect(lote.linhas[0]?.suggest_shipping_document_type).toBe('THERMAL_AIR_WAYBILL');
    expect(falhaDaLinha(lote.linhas[0]!)).toBeNull();
    expect(lote.linhas[1]?.package_number).toBeNull();
    expect(falhaDaLinha(lote.linhas[1]!)).toEqual({
      code: 'logistics.order_not_exist',
      mensagem: 'The order_sn you provided is not exist. Please check',
    });
    // ⚠️ O aviso é a FRASE de contagem — a mesma que o transporte deu ao
    // `onWarning` — e nunca as linhas (que carregam um `order_sn`).
    expect(lote.avisos).toBe('1 aviso(s) por pedido/pacote');
    expect(avisos).toEqual([lote.avisos]);
    expect(lote.avisos).not.toContain(PEDIDO_ETQ);
  });

  it('E11 — createShippingDocument: `tracking_number` e o tipo POR ENTRADA, ausentes quando não dados; e a amostra de ERRO da página (todas falharam) volta como VALOR', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(loteTodoFalhou()));
    const client = createShopeeClient(shopConfig(fetchMock));

    const lote = await client.createShippingDocument({
      documentos: [
        {
          orderSn: PEDIDO_ETQ,
          packageNumber: PACOTE_1,
          trackingNumber: RASTREIO_ETQ,
          shippingDocumentType: 'THERMAL_AIR_WAYBILL',
        },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
      ],
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      SHOPEE_CREATE_SHIPPING_DOCUMENT_PATH,
    );
    expect(corpoEnviado(fetchMock)).toBe(
      `{"order_list":[{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_1}","tracking_number":"${RASTREIO_ETQ}","shipping_document_type":"THERMAL_AIR_WAYBILL"},{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_2}"}]}`,
    );

    expect(lote.todasFalharam).toBe(true);
    expect(lote.requestId).toBe('req-todo-falhou');
    expect(lote.linhas).toHaveLength(1);
    expect(falhaDaLinha(lote.linhas[0]!)).toEqual({
      code: 'logistics.package_can_not_print',
      mensagem: 'The package can not print now.',
    });
    expect(lote.avisos).toBeNull();
  });

  it('E12 — getShippingDocumentResult: o tipo POR ENTRADA; as linhas são conciliadas por (order_sn, package_number), NUNCA por posição (S13); o `status` é texto LIVRE', async () => {
    const corpo = {
      error: '',
      message: '',
      request_id: 'req-resultado',
      // ⚠️ A Shopee responde na ORDEM DELA — invertida em relação ao pedido.
      response: {
        result_list: [
          { status: 'READY', order_sn: PEDIDO_ETQ, package_number: PACOTE_2 },
          { status: 'STATUS_NOVO', order_sn: PEDIDO_ETQ, package_number: PACOTE_1 },
          { order_sn: '', fail_error: 'logistics.x' },
        ],
      },
      warning: [{ order_sn: PEDIDO_ETQ, package_number: PACOTE_1 }, null],
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpo));
    const lote = await createShopeeClient(shopConfig(fetchMock)).getShippingDocumentResult({
      documentos: [
        {
          orderSn: PEDIDO_ETQ,
          packageNumber: PACOTE_1,
          shippingDocumentType: 'NORMAL_AIR_WAYBILL',
        },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
      ],
    });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      SHOPEE_GET_SHIPPING_DOCUMENT_RESULT_PATH,
    );
    expect(corpoEnviado(fetchMock)).toBe(
      `{"order_list":[{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_1}","shipping_document_type":"NORMAL_AIR_WAYBILL"},{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_2}"}]}`,
    );

    const doPacote = (numero: string) => lote.linhas.find((l) => l.package_number === numero);
    expect(doPacote(PACOTE_1)?.status).toBe('STATUS_NOVO');
    expect(doPacote(PACOTE_2)?.status).toBe(SHOPEE_SHIPPING_DOCUMENT_STATUS.pronto);
    // A ordem da Shopee é preservada — nada reordena nem re-rotula por índice.
    expect(lote.linhas.map((l) => l.package_number)).toEqual([PACOTE_2, PACOTE_1]);
    // A linha sem `order_sn` é a sentinela `null`, contada.
    expect(lote.linhasIlegiveis).toBe(1);
    // A contagem conta os DOIS elementos do aviso, o ilegível incluído.
    expect(lote.avisos).toBe('2 aviso(s) por pedido/pacote');
  });

  it('E13 — S11/S12: o leitor de lote dobra EXATAMENTE `batch_api_all_failed` COM linhas legíveis; todo o resto relança', async () => {
    const ler = async (corpo: unknown): Promise<unknown> => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpo));
      return createShopeeClient(shopConfig(fetchMock))
        .getShippingDocumentResult({ documentos: [{ orderSn: PEDIDO_ETQ }] })
        .catch((e: unknown) => e);
    };

    // PAR — a dobra de UM segmento de módulo, dos dois lados, e o espaço nas pontas.
    for (const codigo of [
      'common.batch_api_all_failed',
      'batch_api_all_failed',
      ' common.batch_api_all_failed',
      'logistics.batch_api_all_failed\t',
    ]) {
      const lote = (await ler(loteTodoFalhou(codigo))) as { todasFalharam: boolean };
      expect(lote, codigo).not.toBeInstanceOf(Error);
      expect(lote.todasFalharam, codigo).toBe(true);
    }

    // ⛔ QUASE-IGUAIS: outro código (S11), DOIS segmentos, um erro de parâmetro
    // que chegou com linhas, um limite de taxa com linhas.
    for (const codigo of [
      'common.batch_api_all_failed_x',
      'logistics.common.batch_api_all_failed',
      'logistics.error_param',
      'error_rate_limit',
    ]) {
      const erro = await ler(loteTodoFalhou(codigo));
      expect(erro, codigo).toBeInstanceOf(ShopeeApiPartialError);
      expect((erro as ShopeeApiPartialError).code, codigo).toBe(codigo);
    }

    // ⛔ S12: "todas falharam" SEM nenhuma linha legível é injulgável — relança.
    for (const linhas of [[], [{ fail_error: 'logistics.x' }], [null]]) {
      const erro = await ler(loteTodoFalhou('common.batch_api_all_failed', linhas));
      expect(erro).toBeInstanceOf(ShopeeApiPartialError);
    }
    // ⛔ E sem `response` nenhum: a classe comum, nada anexado.
    const semResposta = await ler({
      error: 'common.batch_api_all_failed',
      message: 'Failed.',
      request_id: 'req-sem-resposta',
    });
    expect(semResposta).toBeInstanceOf(ShopeeApiError);
    expect(semResposta).not.toBeInstanceOf(ShopeeApiPartialError);
  });

  it('E14 — S14: `falhaDaLinha` é EXATA — `" "` é falha, `""` e `null` são sucesso, e o código volta VERBATIM', () => {
    expect(falhaDaLinha({ fail_error: ' ', fail_message: null })).toEqual({
      code: ' ',
      mensagem: null,
    });
    expect(falhaDaLinha({ fail_error: '', fail_message: 'ignorada' })).toBeNull();
    expect(falhaDaLinha({ fail_error: null, fail_message: null })).toBeNull();
    expect(
      falhaDaLinha({ fail_error: ' logistics.package_already_shipped\t', fail_message: 'x' }),
    ).toEqual({ code: ' logistics.package_already_shipped\t', mensagem: 'x' });
  });

  it('E15 — downloadShippingDocument: POST com UM tipo para a lista, BYTES de volta byte a byte, e um envelope de erro continua um erro', async () => {
    const pdf = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3,
    ]);
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(pdf, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="etiqueta.pdf"',
          },
        }),
    );
    const client = createShopeeClient(shopConfig(fetchMock));
    const arquivo = await client.downloadShippingDocument({
      shippingDocumentType: 'NORMAL_AIR_WAYBILL',
      documentos: [
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_1 },
        { orderSn: PEDIDO_ETQ, packageNumber: PACOTE_2 },
      ],
    });
    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_DOWNLOAD_SHIPPING_DOCUMENT_PATH);
    expect(init?.method).toBe('POST');
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    expect(corpoEnviado(fetchMock)).toBe(
      `{"shipping_document_type":"NORMAL_AIR_WAYBILL","order_list":[{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_1}"},{"order_sn":"${PEDIDO_ETQ}","package_number":"${PACOTE_2}"}]}`,
    );
    expect(arquivo.bytes).toEqual(pdf);
    expect(arquivo.contentType).toBe('application/pdf');
    expect(arquivo.contentDisposition).toBe('attachment; filename="etiqueta.pdf"');
    expect(arquivo.httpStatus).toBe(200);

    // Sem tipo: a chave some — o padrão é da Shopee.
    const semTipo = vi.fn<typeof globalThis.fetch>(async () => new Response(pdf, { status: 200 }));
    await createShopeeClient(shopConfig(semTipo)).downloadShippingDocument({
      documentos: [{ orderSn: PEDIDO_ETQ }],
    });
    expect(corpoEnviado(semTipo)).toBe(`{"order_list":[{"order_sn":"${PEDIDO_ETQ}"}]}`);

    // Um envelope de erro num 200 é o erro da Shopee, nunca uma etiqueta.
    const erroFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        error: 'logistics.shipping_document_should_print_first',
        message: 'The package can not print now, please create shipping document first.',
        request_id: 'req-baixar-erro',
      }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(erroFetch)).downloadShippingDocument({
        documentos: [{ orderSn: PEDIDO_ETQ }],
      }),
    );
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('logistics.shipping_document_should_print_first');
  });

  it('E-L1 — FONTE: as duas flags de lote moram UMA vez, dentro de `lerLoteLogistico`; os três lotes passam por ele; e shipOrder não carrega tolerância nem laço', () => {
    // ⚠️ Asserção de FONTE: o `catch` do leitor DEPENDE do `payloadNoErro` —
    // sem ele as linhas são descartadas no ponto do throw —, e um lote que
    // chamasse `shopeeCall` direto passaria por todo teste cujo corpo não trouxesse
    // linhas junto de um erro.
    const inicio = FONTE_API.indexOf('async function lerLoteLogistico');
    const fim = FONTE_API.indexOf('export function createShopeePartnerClient');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const leitor = FONTE_API.slice(inicio, fim);
    expect(leitor.split('payloadNoErro: true').length - 1).toBe(1);
    expect(leitor.split('avisoEmLista: true').length - 1).toBe(1);
    expect(FONTE_API.split('avisoEmLista: true').length - 1).toBe(1);
    expect(FONTE_API.split('payloadNoErro: true').length - 1).toBe(3);

    const guardas: readonly (readonly [string, string])[] = [
      ['getShippingParameter: async', 'assertShippingParameterParams(p)'],
      ['shipOrder: async', 'assertShipOrderParams(p)'],
      ['getTrackingNumber: async', 'assertTrackingNumberParams(p)'],
      ['getShippingDocumentParameter: async', 'assertShippingDocumentParameterParams(p)'],
      ['createShippingDocument: async', 'assertCreateShippingDocumentParams(p)'],
      ['getShippingDocumentResult: async', 'assertShippingDocumentResultParams(p)'],
      ['downloadShippingDocument: async', 'assertDownloadShippingDocumentParams(p)'],
    ];
    for (const [marcador, guarda] of guardas) {
      const bloco = blocoDoMetodo(marcador);
      // O guarda corre ANTES do token — o S17 no nível da fonte.
      expect(bloco.indexOf(guarda), marcador).toBeGreaterThan(-1);
      expect(bloco.indexOf(guarda), marcador).toBeLessThan(bloco.indexOf('signedCall()'));
    }
    for (const lote of [
      'getShippingDocumentParameter: async',
      'createShippingDocument: async',
      'getShippingDocumentResult: async',
    ]) {
      const bloco = blocoDoMetodo(lote);
      expect(bloco, lote).toContain('lerLoteLogistico(');
      expect(bloco, lote).not.toContain('shopeeCall(');
    }
    expect(blocoDoMetodo('downloadShippingDocument: async')).toContain('shopeeCallArquivo(');

    const ship = blocoDoMetodo('shipOrder: async');
    expect(ship.split('shopeeCall(').length - 1).toBe(1);
    for (const proibido of [
      'payloadNoErro',
      'avisoEmLista',
      'erroAusenteEhSucesso',
      'emptyErrorAliases',
      'for (',
      'while',
      'catch',
    ]) {
      expect(ship, proibido).not.toContain(proibido);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            A busca de pacotes (passo 15b) — a oitava operação               */
/* -------------------------------------------------------------------------- */

/**
 * O pedido que a varredura do arranjo automático faz, por conta e por tique —
 * montado com as constantes do fio, nunca com números soltos.
 */
const BUSCA_DO_SWEEP: SearchPackageListParams = {
  pageSize: SHOPEE_SEARCH_PACKAGE_LIST_MAX_PAGE_SIZE,
  filtro: {
    packageStatus: SHOPEE_PACKAGE_STATUS_FILTRO.aProcessar,
    fulfillmentType: SHOPEE_FULFILLMENT_TYPE_FILTRO.vendedor,
    invoicePending: false,
    logisticsChannelIds: [90011, 90012, 90026],
  },
  ordenacao: { sortType: SHOPEE_PACKAGE_SORT.prazoDeEnvio, ascending: true },
};

/** O corpo da página 1, BYTE A BYTE — o literal do desenho (§2.10), nunca uma reconstrução. */
const CORPO_DA_PAGINA_1 =
  '{"filter":{"package_status":2,"fulfillment_type":2,"invoice_pending":false,"logistics_channel_ids":[90011,90012,90026]},"pagination":{"page_size":100},"sort":{"sort_type":1,"ascending":true}}';

/** Uma página com UMA linha e `more: true` — o cursor COMPOSTO da amostra da página, ids de fixture. */
const BUSCA_PACOTES_BODY = {
  error: '',
  message: '',
  request_id: 'req-busca-pacotes',
  response: {
    packages_list: [
      {
        order_sn: PEDIDO_ETQ,
        package_number: PACOTE_1,
        logistics_channel_id: 90011,
        product_location_id: 'BRZ',
        sorting_group: '',
        is_shipment_arranged: false,
      },
    ],
    pagination: { total_count: 2, next_cursor: '1767000000,987654', more: true },
    // ⚠️ O eco do SG (`ascending`, não o `is_asc` da página): ninguém o declara.
    sort: { sort_type: 1, ascending: true },
  },
};

/** A resposta VAZIA medida no SG (Apêndice B): `packages_list: []` E `pagination`, cursor `""`. */
const BUSCA_VAZIA_BODY = {
  error: '',
  message: '',
  request_id: 'req-busca-vazia',
  response: {
    packages_list: [],
    pagination: { total_count: 0, more: false, next_cursor: '' },
    sort: { sort_type: 1, ascending: true },
  },
};

/** A busca da varredura com campos do FILTRO trocados. ⚠️ Cast de propósito: é o chamador JS. */
function buscaComFiltro(troca: Record<string, unknown>): SearchPackageListParams {
  return {
    ...BUSCA_DO_SWEEP,
    filtro: { ...BUSCA_DO_SWEEP.filtro, ...troca },
  } as unknown as SearchPackageListParams;
}

/** A busca da varredura com campos de FORA do filtro trocados. ⚠️ Cast de propósito. */
function buscaCom(troca: Record<string, unknown>): SearchPackageListParams {
  return { ...BUSCA_DO_SWEEP, ...troca } as unknown as SearchPackageListParams;
}

describe('a busca de pacotes (passo 15b)', () => {
  it('B1 — o caminho e os enums do fio; POST shop-signed com só as chaves comuns na query; sai pelo index do pacote, SÓ no cliente da loja, e a página volta DESEMBRULHADA', async () => {
    expect(SHOPEE_SEARCH_PACKAGE_LIST_PATH).toBe('/api/v2/order/search_package_list');
    expect(SHOPEE_SEARCH_PACKAGE_LIST_MAX_PAGE_SIZE).toBe(100);
    // Os valores do FIO, verbatim da página — cada enum por inteiro.
    expect(SHOPEE_PACKAGE_STATUS_FILTRO).toEqual({
      todos: 0,
      pendente: 1,
      aProcessar: 2,
      processado: 3,
    });
    expect(SHOPEE_FULFILLMENT_TYPE_FILTRO).toEqual({ semFiltro: 0, shopee: 1, vendedor: 2 });
    expect(SHOPEE_ORDER_TYPE_FILTRO).toEqual({ todos: 0, regular: 1, instantaneo: 2 });
    expect(SHOPEE_PACKAGE_SORT).toEqual({ prazoDeEnvio: 1, criacao: 2, confirmacao: 3 });

    // ⚠️ UMA resposta `more: true`, depois rejeição — como no B7: respondida
    // para sempre, um pacote que paginasse sozinho travaria o worker AQUI.
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(BUSCA_PACOTES_BODY))
      .mockRejectedValue(new Error('uma SEGUNDA chamada: o pacote paginou sozinho'));
    const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
    const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock, getAccessToken));
    const pagina = await client.searchPackageList(BUSCA_DO_SWEEP);

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.pathname).toBe(SHOPEE_SEARCH_PACKAGE_LIST_PATH);
    expect(init?.method).toBe('POST');
    // Os filtros vão no CORPO: a query leva só as chaves comuns, a da loja incluída.
    expect([...url.searchParams.keys()].sort()).toEqual([...CHAVES_COMUNS].sort());
    expect(url.searchParams.get('shop_id')).toBe(String(TEST_SHOP_ID));
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    // DESEMBRULHADA: o envelope não chega ao chamador.
    expect('response' in pagina).toBe(false);
    expect('error' in pagina).toBe(false);
    expect(pagina.packages_list).toHaveLength(1);
    expect(pagina.packages_list[0]?.order_sn).toBe(PEDIDO_ETQ);
    expect(pagina.packages_list[0]?.package_number).toBe(PACOTE_1);
    expect(pagina.packages_list[0]?.is_shipment_arranged).toBe(false);
    expect(pagina.pagination?.more).toBe(true);

    // Pela porta PÚBLICA (`index.ts` re-exporta `logistica.ts` por wildcard)…
    expect(pacote.SHOPEE_SEARCH_PACKAGE_LIST_PATH).toBe(SHOPEE_SEARCH_PACKAGE_LIST_PATH);
    expect(pacote.SHOPEE_PACKAGE_STATUS_FILTRO).toBe(SHOPEE_PACKAGE_STATUS_FILTRO);
    expect(pacote.assertSearchPackageListParams).toBe(assertSearchPackageListParams);
    // …e só no cliente da LOJA: a página é `type=Shop`.
    const partner = createShopeePartnerClient(partnerConfig(fetchMock));
    expect('searchPackageList' in partner).toBe(false);
  });

  it('B2 — mutantes 71/72/73/93: o corpo da página 1 BYTE A BYTE — sem `cursor`, `invoice_pending:false` PRESENTE, ShipByDate ascendente; ⛔ QUASE-IGUAL: o corpo que confia no padrão da Shopee é OUTRO pedido', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const vazia = await client.searchPackageList(BUSCA_DO_SWEEP);

    const corpo = corpoEnviado(fetchMock);
    expect(corpo).toBe(CORPO_DA_PAGINA_1);
    const lido = JSON.parse(corpo) as {
      filter: Record<string, unknown>;
      pagination: Record<string, unknown>;
    };
    // A chave EXISTE e é `false` — nem ausente, nem `undefined`, nem `true`.
    expect(Object.prototype.hasOwnProperty.call(lido.filter, 'invoice_pending')).toBe(true);
    expect(lido.filter.invoice_pending).toBe(false);
    // ⛔ Página 1: nenhuma chave `cursor` — nem `""`, nem o literal de duas aspas das amostras.
    expect(Object.keys(lido.pagination)).toEqual(['page_size']);

    // ⛔ QUASE-IGUAL: sem `invoice_pending`, o filtro é o MESMO pelo padrão
    // documentado ("Default value = false") — e é outro pedido no fio, onde o
    // registro 222 não se lê. Ele difere do enviado SÓ por essa chave, e o
    // enviado nunca é ele.
    const filtroPeloPadrao: Record<string, unknown> = { ...lido.filter };
    delete filtroPeloPadrao.invoice_pending;
    const pedidoPeloPadrao = JSON.stringify({ ...lido, filter: filtroPeloPadrao });
    expect(pedidoPeloPadrao).toBe(CORPO_DA_PAGINA_1.replace('"invoice_pending":false,', ''));
    expect(corpo).not.toBe(pedidoPeloPadrao);

    // A resposta vazia do SG atravessa o cliente: lista vazia, paginação presente.
    expect(vazia.packages_list).toEqual([]);
    expect(vazia.pagination?.more).toBe(false);

    // PARES: o que o chamador manda é o que vai — o pacote não fixa nenhum dos três.
    const variantes: readonly (readonly [string, SearchPackageListParams, string])[] = [
      [
        'invoice_pending true',
        buscaComFiltro({ invoicePending: true }),
        CORPO_DA_PAGINA_1.replace('"invoice_pending":false', '"invoice_pending":true'),
      ],
      [
        'sort descendente por criação',
        buscaCom({ ordenacao: { sortType: SHOPEE_PACKAGE_SORT.criacao, ascending: false } }),
        CORPO_DA_PAGINA_1.replace(
          '"sort":{"sort_type":1,"ascending":true}',
          '"sort":{"sort_type":2,"ascending":false}',
        ),
      ],
      [
        // O mínimo: sem canais, sem `order_type`, sem `sort` — as chaves SOMEM,
        // e as três do padrão da Shopee continuam indo, `false` incluído.
        'mínimo',
        {
          pageSize: 50,
          filtro: {
            packageStatus: SHOPEE_PACKAGE_STATUS_FILTRO.todos,
            fulfillmentType: SHOPEE_FULFILLMENT_TYPE_FILTRO.semFiltro,
            invoicePending: false,
          },
        },
        '{"filter":{"package_status":0,"fulfillment_type":0,"invoice_pending":false},"pagination":{"page_size":50}}',
      ],
      [
        'order_type depois dos canais',
        {
          pageSize: 1,
          filtro: {
            packageStatus: SHOPEE_PACKAGE_STATUS_FILTRO.aProcessar,
            fulfillmentType: SHOPEE_FULFILLMENT_TYPE_FILTRO.vendedor,
            invoicePending: true,
            logisticsChannelIds: [90011],
            orderType: SHOPEE_ORDER_TYPE_FILTRO.instantaneo,
          },
        },
        '{"filter":{"package_status":2,"fulfillment_type":2,"invoice_pending":true,"logistics_channel_ids":[90011],"order_type":2},"pagination":{"page_size":1}}',
      ],
    ];
    for (const [nome, params, esperado] of variantes) {
      fetchMock.mockClear();
      await client.searchPackageList(params);
      expect(corpoEnviado(fetchMock), nome).toBe(esperado);
    }
  });

  it('B2b — a página 2 manda o `next_cursor` VERBATIM (composto e opaco, nada aparado), dentro de `pagination` e depois de `page_size`', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    for (const cursor of ['1767000000,987654', ' 1767000000,987654 ']) {
      fetchMock.mockClear();
      await client.searchPackageList({ ...BUSCA_DO_SWEEP, cursor });
      expect(corpoEnviado(fetchMock), JSON.stringify(cursor)).toBe(
        CORPO_DA_PAGINA_1.replace(
          '"pagination":{"page_size":100}',
          `"pagination":{"page_size":100,"cursor":${JSON.stringify(cursor)}}`,
        ),
      );
    }
  });

  it('B3 — mutante 89: cada recusa acontece ANTES do token e do fetch, espiões em zero — a lista de canais VAZIA incluída; ⛔ QUASE-IGUAIS: os limites ACEITOS custam uma chamada cada', async () => {
    const recusas: readonly (readonly [string, SearchPackageListParams])[] = [
      ['page_size 0', buscaCom({ pageSize: 0 })],
      ['page_size 101', buscaCom({ pageSize: 101 })],
      ['page_size 1.5', buscaCom({ pageSize: 1.5 })],
      ["page_size '100'", buscaCom({ pageSize: '100' })],
      ['page_size NaN', buscaCom({ pageSize: Number.NaN })],
      ["cursor ''", buscaCom({ cursor: '' })],
      ['cursor em branco', buscaCom({ cursor: ' \t' })],
      ['cursor numérico', buscaCom({ cursor: 1_767_000_000 })],
      ['filter ausente', buscaCom({ filtro: undefined })],
      ['filter null', buscaCom({ filtro: null })],
      ['package_status 4', buscaComFiltro({ packageStatus: 4 })],
      ["package_status '2'", buscaComFiltro({ packageStatus: '2' })],
      ['package_status ausente', buscaComFiltro({ packageStatus: undefined })],
      ['fulfillment_type 3', buscaComFiltro({ fulfillmentType: 3 })],
      ['fulfillment_type ausente', buscaComFiltro({ fulfillmentType: undefined })],
      ['invoice_pending ausente', buscaComFiltro({ invoicePending: undefined })],
      ["invoice_pending 'false'", buscaComFiltro({ invoicePending: 'false' })],
      ['invoice_pending 0', buscaComFiltro({ invoicePending: 0 })],
      ['invoice_pending null', buscaComFiltro({ invoicePending: null })],
      ['order_type 3', buscaComFiltro({ orderType: 3 })],
      ['canais: lista VAZIA', buscaComFiltro({ logisticsChannelIds: [] })],
      ['canais: repetido', buscaComFiltro({ logisticsChannelIds: [90011, 90012, 90011] })],
      ['canais: 0', buscaComFiltro({ logisticsChannelIds: [0] })],
      ['canais: -1', buscaComFiltro({ logisticsChannelIds: [-1] })],
      ['canais: 2^31', buscaComFiltro({ logisticsChannelIds: [2 ** 31] })],
      ["canais: '90011'", buscaComFiltro({ logisticsChannelIds: ['90011'] })],
      ['canais: 1.5', buscaComFiltro({ logisticsChannelIds: [1.5] })],
      ['canais: não é lista', buscaComFiltro({ logisticsChannelIds: 90011 })],
      ['sort_type 0', buscaCom({ ordenacao: { sortType: 0, ascending: true } })],
      ['sort_type 4', buscaCom({ ordenacao: { sortType: 4, ascending: true } })],
      ["ascending 'true'", buscaCom({ ordenacao: { sortType: 1, ascending: 'true' } })],
      ['sort null', buscaCom({ ordenacao: null })],
    ];
    for (const [nome, params] of recusas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
      const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
      const client = createShopeeClient(shopConfig(fetchMock, getAccessToken));
      const erro = await erroDe(client.searchPackageList(params));
      expect(erro, nome).toBeInstanceOf(ShopeeConfigError);
      expect(getAccessToken, nome).not.toHaveBeenCalled();
      expect(fetchMock, nome).not.toHaveBeenCalled();
      // E o guarda exportado diz o mesmo, sozinho.
      expect(() => assertSearchPackageListParams(params), nome).toThrow(ShopeeConfigError);
    }

    // As frases que dizem ao chamador o que fazer: OMITIR, nunca mandar vazio.
    const mensagemDe = async (params: SearchPackageListParams): Promise<string> => {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
      return (
        (await erroDe(createShopeeClient(shopConfig(fetchMock)).searchPackageList(params))) as Error
      ).message;
    };
    expect(await mensagemDe(buscaComFiltro({ logisticsChannelIds: [] }))).toContain('omita');
    expect(await mensagemDe(buscaCom({ cursor: '' }))).toContain(
      'omita o parâmetro na primeira página',
    );
    // O repetido nomeia as DUAS posições.
    expect(
      await mensagemDe(buscaComFiltro({ logisticsChannelIds: [90011, 90012, 90011] })),
    ).toContain('posições 0 e 2');

    // ⛔ QUASE-IGUAIS: os limites ACEITOS — cada um custa EXATAMENTE uma chamada.
    const aceitas: readonly (readonly [string, SearchPackageListParams])[] = [
      ['page_size 1', buscaCom({ pageSize: 1 })],
      ['page_size 100', buscaCom({ pageSize: 100 })],
      ['canais 1 e 2^31 - 1', buscaComFiltro({ logisticsChannelIds: [1, 2 ** 31 - 1] })],
      ['cursor composto', buscaCom({ cursor: '1767000000,987654' })],
      ['fulfillment_type 0 (sem filtro)', buscaComFiltro({ fulfillmentType: 0 })],
      ['order_type 0', buscaComFiltro({ orderType: SHOPEE_ORDER_TYPE_FILTRO.todos })],
      [
        'sort 3 descendente',
        buscaCom({ ordenacao: { sortType: SHOPEE_PACKAGE_SORT.confirmacao, ascending: false } }),
      ],
    ];
    for (const [nome, params] of aceitas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
      await createShopeeClient(shopConfig(fetchMock)).searchPackageList(params);
      expect(fetchMock, nome).toHaveBeenCalledTimes(1);
    }
  });

  it('B4 — nenhuma recusa ecoa um VALOR: nem o cursor (opaco — pode carregar um id), nem um canal, nem o que veio no lugar de um enum', async () => {
    const MARCADOR = 'MARCADOR-BUSCA-15B';
    const NUMERO = 987_654_321;
    // ⚠️ Espaços INCOMUNS de propósito (NBSP, em space): um guarda que fizesse
    // `JSON.stringify` do valor os carregaria para a mensagem.
    const incomuns = [' ', ' '];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(BUSCA_VAZIA_BODY));
    const client = createShopeeClient(shopConfig(fetchMock));
    const recusas: readonly SearchPackageListParams[] = [
      // Um cursor VÁLIDO ao lado de um campo ruim: a recusa não despeja os parâmetros.
      buscaCom({ pageSize: 0, cursor: `1767000000,${MARCADOR}` }),
      buscaCom({ cursor: '  ' }),
      buscaCom({ cursor: { toString: () => MARCADOR } }),
      buscaCom({ pageSize: MARCADOR }),
      buscaCom({ pageSize: NUMERO }),
      buscaCom({ filtro: MARCADOR }),
      buscaComFiltro({ packageStatus: MARCADOR }),
      buscaComFiltro({ fulfillmentType: NUMERO }),
      buscaComFiltro({ invoicePending: MARCADOR }),
      buscaComFiltro({ orderType: NUMERO }),
      buscaComFiltro({ logisticsChannelIds: [90011, NUMERO, NUMERO] }),
      buscaComFiltro({ logisticsChannelIds: [MARCADOR] }),
      buscaComFiltro({ logisticsChannelIds: [2 ** 31] }),
      buscaCom({ ordenacao: { sortType: NUMERO, ascending: true } }),
      buscaCom({ ordenacao: { sortType: 1, ascending: MARCADOR } }),
    ];
    for (const params of recusas) {
      const erro = await erroDe(client.searchPackageList(params));
      expect(erro).toBeInstanceOf(ShopeeConfigError);
      const mensagem = (erro as Error).message;
      expect(mensagem).not.toContain(MARCADOR);
      expect(mensagem).not.toContain(String(NUMERO));
      expect(mensagem).not.toContain(String(2 ** 31));
      for (const c of incomuns) expect(mensagem).not.toContain(c);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('B6 — um envelope de erro com SÓ `mesage` (a grafia da TABELA da página) continua um `ShopeeApiError` com o seu código: a classificação nunca lê o texto', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ error: 'error_param', mesage: 'Wrong parameters.', request_id: 'req-mesage' }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).searchPackageList(BUSCA_DO_SWEEP),
    );
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_param');
    // A frase da Shopee se perde (só no log): `message` ausente lê `null`.
    expect((erro as ShopeeApiError).providerMessage).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('B7 — mutante 98: UMA chamada por página, mesmo com `more: true` — o pacote nunca pagina sozinho, o cursor volta ao CHAMADOR; uma SEGUNDA chamada cai numa rejeição e a CONTAGEM a acusa', async () => {
    // ⚠️ A página `more: true` responde UMA vez; toda chamada seguinte REJEITA.
    // Com a mesma página respondida para sempre, um pacote que paginasse
    // sozinho nunca voltaria: o worker morria e o vermelho lia como queda do
    // pool, não como este teste. Assim o laço para na segunda chamada.
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(BUSCA_PACOTES_BODY))
      .mockRejectedValue(new Error('uma SEGUNDA chamada: o pacote paginou sozinho'));
    const chamada = createShopeeClient(shopConfig(fetchMock)).searchPackageList(BUSCA_DO_SWEEP);
    // Assentada sem lançar: a contagem é afirmada ANTES de o resultado ser lido,
    // então quem paginou falha AQUI, por asserção — rejeitando ou não.
    const assentada = await erroDe(chamada);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assentada).not.toBeInstanceOf(ShopeeNetworkError);
    const pagina = await chamada;
    expect(pagina.packages_list).toHaveLength(1);
    expect(pagina.pagination?.more).toBe(true);
    expect(pagina.pagination?.next_cursor).toBe('1767000000,987654');
  });

  it('B7b — mutante 98 na FONTE: guarda antes do token, um `shopeeCall`, nenhum laço, nenhuma tolerância — não chama nada, então corre mesmo se a chamada do B7 nunca voltar', () => {
    const bloco = blocoDoMetodo('searchPackageList: async');
    const guarda = bloco.indexOf('assertSearchPackageListParams(p)');
    expect(guarda).toBeGreaterThan(-1);
    // O guarda corre ANTES do token — o B3 no nível da fonte.
    expect(guarda).toBeLessThan(bloco.indexOf('signedCall()'));
    expect(bloco.split('shopeeCall(').length - 1).toBe(1);
    expect(bloco).toContain('SHOPEE_SEARCH_PACKAGE_LIST_PATH');
    expect(bloco).toContain('shopeeSearchPackageListSchema');
    expect(bloco).toContain('buscaDePacotesNoFio(p)');
    for (const proibido of [
      'payloadNoErro',
      'avisoEmLista',
      'erroAusenteEhSucesso',
      'emptyErrorAliases',
      'for (',
      'while',
      'catch',
      '.then(',
    ]) {
      expect(bloco, proibido).not.toContain(proibido);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*          As devoluções (passo 17) — três leituras e três ações              */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ O return_sn ALFANUMÉRICO congelado pela reconciliação do passo 17: as
 * amostras das páginas são alfanuméricas, e um id só de dígitos esconderia
 * exatamente o formato que um guarda de dígitos quebraria.
 */
const RETURN_SN_ALFA = '260910ABCDE0001';
const RETURN_SN_DIGITOS = '2609100000000001';
const PEDIDO_DEVOLUCAO = '260910KJBHUJDM';
const INICIO_JANELA_S = 1_760_000_000;

/**
 * ⚠️ Marcadores INVENTADOS no lugar de cada dado de comprador que as páginas de
 * devolução carregam — nenhum é um dado real. O teste D12 prova que nenhum
 * atravessa o cliente.
 */
const COMPRADOR_FICTICIO = {
  usuario: 'usuario-ficticio-do-comprador',
  email: 'comprador-ficticio@exemplo.invalid',
  retrato: 'https://exemplo.invalid/retrato-ficticio.jpg',
  endereco: 'RUA-FICTICIA-DO-COMPRADOR',
  nome: 'NOME-FICTICIO-DO-COMPRADOR',
  telefone: 'TELEFONE-FICTICIO-DO-COMPRADOR',
  imagem: 'https://exemplo.invalid/foto-ficticia.jpg',
  video: 'https://exemplo.invalid/video-ficticio.mp4',
  textoLivre: 'TEXTO-LIVRE-FICTICIO-DO-COMPRADOR',
  rastreioReverso: 'RASTREIO-REVERSO-FICTICIO',
  criadorDaOferta: 'CRIADOR-FICTICIO-DA-OFERTA',
  naoDeclarado: 'CAMPO-NAO-DECLARADO-FICTICIO',
} as const;

/** Os campos de comprador de uma devolução, como as páginas os imprimem — valores inventados. */
const CAMPOS_DE_COMPRADOR = {
  text_reason: COMPRADOR_FICTICIO.textoLivre,
  image: [COMPRADOR_FICTICIO.imagem],
  buyer_videos: [{ thumbnail_url: COMPRADOR_FICTICIO.imagem, video_url: COMPRADOR_FICTICIO.video }],
  tracking_number: COMPRADOR_FICTICIO.rastreioReverso,
  user: {
    username: COMPRADOR_FICTICIO.usuario,
    email: COMPRADOR_FICTICIO.email,
    portrait: COMPRADOR_FICTICIO.retrato,
  },
  return_pickup_address: {
    address: COMPRADOR_FICTICIO.endereco,
    name: COMPRADOR_FICTICIO.nome,
    phone: COMPRADOR_FICTICIO.telefone,
    region: 'BR',
  },
  // ⚠️ Um campo que NENHUMA página documenta: o corte é por omissão, não por lista.
  campo_que_a_shopee_inventou_amanha: COMPRADOR_FICTICIO.naoDeclarado,
};

/** O exemplo de sucesso de `get_return_detail` — `error: "-"`, como a PÁGINA imprime; ids de fixture. */
const DEVOLUCAO_DETALHE_BODY = {
  error: '-',
  message: '-',
  request_id: 'req-devolucao-detalhe',
  response: {
    return_sn: RETURN_SN_ALFA,
    order_sn: PEDIDO_DEVOLUCAO,
    status: 'REQUESTED',
    create_time: INICIO_JANELA_S,
    update_time: INICIO_JANELA_S + 86_400,
    due_date: INICIO_JANELA_S + 345_600,
    return_ship_due_date: 0,
    return_seller_due_date: INICIO_JANELA_S + 259_200,
    reason: 'NOT_RECEIPT',
    reassessed_request_reason: 'NONE',
    refund_amount: 59.9,
    amount_before_discount: 69.9,
    currency: 'BRL',
    return_solution: 0,
    return_refund_type: 'RRBOC',
    return_refund_request_type: 0,
    validation_type: 'seller_validation',
    is_seller_arrange: false,
    logistics_status: 'LOGISTICS_NOT_STARTED',
    reverse_logistics_status: 'LOGISTICS_NOT_STARTED',
    seller_proof: {
      seller_proof_status: 'PENDING',
      seller_evidence_deadline: INICIO_JANELA_S + 400_000,
    },
    seller_compensation: {
      seller_compensation_status: 'PENDING_REQUEST',
      seller_compensation_due_date: 0,
      compensation_amount: 0,
    },
    negotiation: {
      negotiation_status: 'PENDING_RESPOND',
      latest_solution: 'REFUND',
      latest_offer_amount: 30,
      latest_offer_creator: COMPRADOR_FICTICIO.criadorDaOferta,
      counter_limit: 2,
      offer_due_date: INICIO_JANELA_S + 300_000,
    },
    ...CAMPOS_DE_COMPRADOR,
  },
};

/**
 * Uma página de `get_return_list` — `error: "-"`, `more: true` — com uma linha
 * legível e uma SEM `update_time`, que a lista anula sem perder a página.
 */
const DEVOLUCAO_LISTA_BODY = {
  error: '-',
  message: '-',
  request_id: 'req-devolucao-lista',
  response: {
    more: true,
    return: [
      {
        return_sn: RETURN_SN_ALFA,
        order_sn: PEDIDO_DEVOLUCAO,
        status: 'REQUESTED',
        update_time: INICIO_JANELA_S + 86_400,
        due_date: INICIO_JANELA_S + 345_600,
        refund_amount: 59.9,
        negotiation_status: 'PENDING_RESPOND',
        seller_proof_status: 'PENDING',
        seller_compensation_status: 'PENDING_REQUEST',
        ...CAMPOS_DE_COMPRADOR,
      },
      { return_sn: RETURN_SN_DIGITOS, order_sn: PEDIDO_DEVOLUCAO, status: 'CLOSED' },
    ],
  },
};

/** O exemplo de sucesso de `get_available_solutions` — `error: " "` (um ESPAÇO), como a página imprime. */
const SOLUCOES_DEVOLUCAO_BODY = {
  error: ' ',
  message: '',
  request_id: 'req-devolucao-solucoes',
  response: {
    return_sn: RETURN_SN_ALFA,
    offer_return_refund: { eligibility: false, refund_amount_adjustable: false },
    offer_refund: {
      eligibility: true,
      refund_amount_adjustable: true,
      max_refund_amount: 59.9,
      min_refund_amount: 1,
    },
  },
};

/** O sucesso de `confirm` / `offer` / `accept_offer` — `error: " "` e o eco do `return_sn`. */
function corpoDeEscritaDeDevolucao(requestId: string): Record<string, unknown> {
  return {
    error: ' ',
    message: '',
    request_id: requestId,
    response: { return_sn: RETURN_SN_ALFA },
  };
}

/** A leitura da varredura: UMA página, janela por atualização de exatamente 15 dias. */
const LISTA_DE_DEVOLUCOES: GetReturnListParams = {
  pageNo: 0,
  pageSize: SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
  updateTimeFromS: INICIO_JANELA_S,
  updateTimeToS: INICIO_JANELA_S + SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS,
};

interface OperacaoDeDevolucao {
  readonly nome: string;
  readonly caminho: string;
  readonly verbo: 'GET' | 'POST';
  /** O `error` que a PRÓPRIA página imprime no seu exemplo de sucesso. */
  readonly erroDaPagina: (typeof SHOPEE_RETURNS_ERROR_ALIASES)[number];
  readonly corpo: Readonly<Record<string, unknown>>;
  readonly chamar: (client: ShopeeClient) => Promise<unknown>;
}

/** As seis operações, cada uma com o corpo de sucesso que a SUA página imprime. */
const OPERACOES_DE_DEVOLUCAO: readonly OperacaoDeDevolucao[] = [
  {
    nome: 'getReturnList',
    caminho: SHOPEE_GET_RETURN_LIST_PATH,
    verbo: 'GET',
    erroDaPagina: '-',
    corpo: DEVOLUCAO_LISTA_BODY,
    chamar: (c) => c.getReturnList(LISTA_DE_DEVOLUCOES),
  },
  {
    nome: 'getReturnDetail',
    caminho: SHOPEE_GET_RETURN_DETAIL_PATH,
    verbo: 'GET',
    erroDaPagina: '-',
    corpo: DEVOLUCAO_DETALHE_BODY,
    chamar: (c) => c.getReturnDetail({ returnSn: RETURN_SN_ALFA }),
  },
  {
    nome: 'getReturnAvailableSolutions',
    caminho: SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
    verbo: 'GET',
    erroDaPagina: ' ',
    corpo: SOLUCOES_DEVOLUCAO_BODY,
    chamar: (c) => c.getReturnAvailableSolutions({ returnSn: RETURN_SN_ALFA }),
  },
  {
    nome: 'confirmReturn',
    caminho: SHOPEE_RETURN_CONFIRM_PATH,
    verbo: 'POST',
    erroDaPagina: ' ',
    corpo: corpoDeEscritaDeDevolucao('req-devolucao-confirm'),
    chamar: (c) => c.confirmReturn({ returnSn: RETURN_SN_ALFA }),
  },
  {
    nome: 'offerReturn',
    caminho: SHOPEE_RETURN_OFFER_PATH,
    verbo: 'POST',
    erroDaPagina: ' ',
    corpo: corpoDeEscritaDeDevolucao('req-devolucao-offer'),
    chamar: (c) =>
      c.offerReturn({
        returnSn: RETURN_SN_ALFA,
        proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
        proposedAdjustedRefundAmount: 12.34,
      }),
  },
  {
    nome: 'acceptReturnOffer',
    caminho: SHOPEE_RETURN_ACCEPT_OFFER_PATH,
    verbo: 'POST',
    erroDaPagina: ' ',
    corpo: corpoDeEscritaDeDevolucao('req-devolucao-accept'),
    chamar: (c) => c.acceptReturnOffer({ returnSn: RETURN_SN_ALFA }),
  },
];

/** A operação `nome` com o seu corpo de sucesso trocado. */
function respondendo(
  op: OperacaoDeDevolucao,
  troca: Record<string, unknown>,
): {
  readonly fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  readonly client: ShopeeClient;
} {
  const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ ...op.corpo, ...troca }),
  );
  return { fetchMock, client: createShopeeClient(shopConfig(fetchMock)) };
}

describe('as devoluções (passo 17)', () => {
  it('D1 — os seis caminhos e o verbo de cada página; saem pelo index do pacote, SÓ no cliente da loja; a constante de apelidos é `[" ", "-"]`', async () => {
    expect(SHOPEE_GET_RETURN_LIST_PATH).toBe('/api/v2/returns/get_return_list');
    expect(SHOPEE_GET_RETURN_DETAIL_PATH).toBe('/api/v2/returns/get_return_detail');
    expect(SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH).toBe('/api/v2/returns/get_available_solutions');
    expect(SHOPEE_RETURN_CONFIRM_PATH).toBe('/api/v2/returns/confirm');
    expect(SHOPEE_RETURN_OFFER_PATH).toBe('/api/v2/returns/offer');
    expect(SHOPEE_RETURN_ACCEPT_OFFER_PATH).toBe('/api/v2/returns/accept_offer');
    // ⚠️ Um ESPAÇO e um hífen, e nada mais — nem `''` (que já é sucesso), nem um trim.
    expect(SHOPEE_RETURNS_ERROR_ALIASES).toEqual([' ', '-']);

    // Pela porta PÚBLICA: `index.ts` re-exporta `devolucoes.ts` por wildcard.
    expect(pacote.SHOPEE_GET_RETURN_DETAIL_PATH).toBe(SHOPEE_GET_RETURN_DETAIL_PATH);
    expect(pacote.SHOPEE_RETURNS_ERROR_ALIASES).toBe(SHOPEE_RETURNS_ERROR_ALIASES);
    expect(pacote.assertAlvoDeDevolucao).toBe(assertAlvoDeDevolucao);
    expect(pacote.assertReturnListParams).toBe(assertReturnListParams);
    expect(pacote.assertOfferReturnParams).toBe(assertOfferReturnParams);

    for (const op of OPERACOES_DE_DEVOLUCAO) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(op.corpo));
      const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
      const client: ShopeeClient = pacote.createShopeeClient(shopConfig(fetchMock, getAccessToken));
      await op.chamar(client);
      const [rawUrl, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(rawUrl));
      expect(url.pathname, op.nome).toBe(op.caminho);
      expect(init?.method, op.nome).toBe(op.verbo);
      expect(url.searchParams.get('shop_id'), op.nome).toBe(String(TEST_SHOP_ID));
      // Shop-signed: o token é pedido UMA vez por chamada.
      expect(getAccessToken, op.nome).toHaveBeenCalledTimes(1);
      expect(fetchMock, op.nome).toHaveBeenCalledTimes(1);
      // …e só no cliente da LOJA: as páginas são `type=Shop`.
      expect(op.nome in createShopeePartnerClient(partnerConfig(fetchMock)), op.nome).toBe(false);
    }
  });

  it('D2 — mutantes M15/M16: as duas leituras de UMA devolução mandam GET sem corpo e o `return_sn` VERBATIM na query — alfanumérico, só dígitos e até acolchoado, nada aparado', async () => {
    for (const op of ['getReturnDetail', 'getReturnAvailableSolutions'] as const) {
      for (const returnSn of [RETURN_SN_ALFA, RETURN_SN_DIGITOS, ` ${RETURN_SN_ALFA} `]) {
        const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
          jsonResponse(op === 'getReturnDetail' ? DEVOLUCAO_DETALHE_BODY : SOLUCOES_DEVOLUCAO_BODY),
        );
        await createShopeeClient(shopConfig(fetchMock))[op]({ returnSn });
        const [rawUrl, init] = fetchMock.mock.calls[0]!;
        const url = new URL(String(rawUrl));
        expect(init?.body, op).toBeUndefined();
        expect([...url.searchParams.keys()].sort(), op).toEqual(
          [...CHAVES_COMUNS, 'return_sn'].sort(),
        );
        // Os BYTES dados são os bytes enviados — o guarda julga, nunca reescreve.
        expect(url.searchParams.get('return_sn'), `${op} ${JSON.stringify(returnSn)}`).toBe(
          returnSn,
        );
      }
    }
  });

  it('D3 — mutante M24: a query de get_return_list é EXATA — `page_no: 0` presente, uma janela não pedida não emite chave, e as duas janelas vão inteiras', async () => {
    const casos: readonly (readonly [string, GetReturnListParams, Record<string, string>])[] = [
      [
        'sem janela',
        { pageNo: 0, pageSize: 100 },
        // ⚠️ `0` é falsy e VAI: o pacote nunca troca a página por um padrão.
        { page_no: '0', page_size: '100' },
      ],
      [
        'janela de atualização (a da varredura)',
        LISTA_DE_DEVOLUCOES,
        {
          page_no: '0',
          page_size: '100',
          update_time_from: String(INICIO_JANELA_S),
          update_time_to: String(INICIO_JANELA_S + SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS),
        },
      ],
      [
        'as duas janelas, update_from == create_from',
        {
          pageNo: 3,
          pageSize: 1,
          createTimeFromS: INICIO_JANELA_S,
          createTimeToS: INICIO_JANELA_S + 60,
          updateTimeFromS: INICIO_JANELA_S,
          updateTimeToS: INICIO_JANELA_S + 120,
        },
        {
          page_no: '3',
          page_size: '1',
          create_time_from: String(INICIO_JANELA_S),
          create_time_to: String(INICIO_JANELA_S + 60),
          update_time_from: String(INICIO_JANELA_S),
          update_time_to: String(INICIO_JANELA_S + 120),
        },
      ],
    ];
    for (const [nome, params, esperado] of casos) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(DEVOLUCAO_LISTA_BODY),
      );
      await createShopeeClient(shopConfig(fetchMock)).getReturnList(params);
      const [rawUrl, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(rawUrl));
      expect(init?.method, nome).toBe('GET');
      expect(init?.body, nome).toBeUndefined();
      const daOperacao = Object.fromEntries(
        [...url.searchParams.entries()].filter(
          ([chave]) => !(CHAVES_COMUNS as readonly string[]).includes(chave),
        ),
      );
      expect(daOperacao, nome).toEqual(esperado);
      // Nenhuma chave repetida: cada parâmetro é UM escalar.
      expect(url.searchParams.getAll('page_no'), nome).toHaveLength(1);
    }
  });

  it('D4 — mutante M31 (R-17): as SEIS devolvem o envelope INTEIRO — leituras incluídas — com o `error` da página legível como VALOR (registro 231)', async () => {
    for (const op of OPERACOES_DE_DEVOLUCAO) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(op.corpo));
      const resultado = (await op.chamar(createShopeeClient(shopConfig(fetchMock)))) as Record<
        string,
        unknown
      >;
      // ⛔ Desembrulhar (`res.response`) apagaria `error` e `request_id`.
      expect(resultado.error, op.nome).toBe(op.erroDaPagina);
      expect(resultado.request_id, op.nome).toBe(op.corpo.request_id);
      expect(typeof resultado.response, op.nome).toBe('object');
      expect(resultado.response, op.nome).not.toBeNull();
    }

    // E a carga é a da operação, lida por `.response`.
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(DEVOLUCAO_DETALHE_BODY),
    );
    const detalhe = await createShopeeClient(shopConfig(fetchMock)).getReturnDetail({
      returnSn: RETURN_SN_ALFA,
    });
    expect(detalhe.response.return_sn).toBe(RETURN_SN_ALFA);
    expect(detalhe.response.order_sn).toBe(PEDIDO_DEVOLUCAO);
    expect(detalhe.response.update_time).toBe(INICIO_JANELA_S + 86_400);
    expect(detalhe.response.negotiation?.negotiation_status).toBe('PENDING_RESPOND');
    expect(detalhe.response.seller_proof?.seller_evidence_deadline).toBe(INICIO_JANELA_S + 400_000);
    // VERBATIM: o `0` de um prazo ausente e o `'NONE'` atravessam o pacote — dobrá-los é da app.
    expect(detalhe.response.return_ship_due_date).toBe(0);
    expect(detalhe.response.reassessed_request_reason).toBe('NONE');
  });

  it('D5 — mutante M6: o apelido está em CADA uma das seis — o `error` da própria página, o do outro lado da família e o `""` padrão são sucesso em todas', async () => {
    for (const op of OPERACOES_DE_DEVOLUCAO) {
      for (const valor of ['', ' ', '-']) {
        const { fetchMock, client } = respondendo(op, { error: valor });
        await expect(
          op.chamar(client),
          `${op.nome} ${JSON.stringify(valor)}`,
        ).resolves.toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('D6 — mutante M8: ⛔ QUASE-IGUAIS — igualdade EXATA contra cada apelido: dois espaços, TAB, NBSP, `" -"`, `"- "` e um código real são FALHA em todas as seis, com o código verbatim', async () => {
    for (const op of OPERACOES_DE_DEVOLUCAO) {
      for (const valor of ['  ', '\t', ' ', ' -', '- ', '--', 'error_param']) {
        const { fetchMock, client } = respondendo(op, { error: valor });
        const erro = await erroDe(op.chamar(client));
        const rotulo = `${op.nome} ${JSON.stringify(valor)}`;
        expect(erro, rotulo).toBeInstanceOf(ShopeeApiError);
        expect((erro as ShopeeApiError).code, rotulo).toBe(valor);
        // Uma chamada, nenhuma repetição: a escrita NÃO é idempotente.
        expect(fetchMock, rotulo).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('D7 — mutante M9: a metade "`response` presente" — um corpo de SUCESSO aparente sem `response` é `ShopeeSchemaError` em todas as seis, nunca um sucesso', async () => {
    for (const op of OPERACOES_DE_DEVOLUCAO) {
      for (const valor of [' ', '-', '']) {
        const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
          jsonResponse({ error: valor, message: 'x', request_id: 'req-sem-response' }),
        );
        const erro = await erroDe(op.chamar(createShopeeClient(shopConfig(fetchMock))));
        expect(erro, `${op.nome} ${JSON.stringify(valor)}`).toBeInstanceOf(ShopeeSchemaError);
      }
    }
  });

  it('D8 — mutante M7: a tolerância NÃO ficou global — `" "` continua FALHA no get_order_detail e no search_package_list, e `"-"` no get_order_detail', async () => {
    const pedido = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ORDER_DETAIL_BODY, error: ' ' }),
    );
    await expect(
      createShopeeClient(shopConfig(pedido)).getOrderDetail({ orderSnList: [ORDER_SN] }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
    const pedidoHifen = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...ORDER_DETAIL_BODY, error: '-' }),
    );
    await expect(
      createShopeeClient(shopConfig(pedidoHifen)).getOrderDetail({ orderSnList: [ORDER_SN] }),
    ).rejects.toBeInstanceOf(ShopeeApiError);
    const busca = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...BUSCA_VAZIA_BODY, error: ' ' }),
    );
    await expect(
      createShopeeClient(shopConfig(busca)).searchPackageList(BUSCA_DO_SWEEP),
    ).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('D9 — mutantes M16/M22: as três AÇÕES postam o corpo BYTE A BYTE — só as chaves comuns na query, `return_sn` verbatim, e um valor AUSENTE não emite chave (nem `null`, nem `0`)', async () => {
    const casos: readonly (readonly [string, (c: ShopeeClient) => Promise<unknown>, string])[] = [
      [
        'confirm',
        (c) => c.confirmReturn({ returnSn: RETURN_SN_ALFA }),
        '{"return_sn":"260910ABCDE0001"}',
      ],
      [
        'confirm acolchoado',
        (c) => c.confirmReturn({ returnSn: ` ${RETURN_SN_ALFA}` }),
        '{"return_sn":" 260910ABCDE0001"}',
      ],
      [
        'accept_offer',
        (c) => c.acceptReturnOffer({ returnSn: RETURN_SN_DIGITOS }),
        '{"return_sn":"2609100000000001"}',
      ],
      [
        'offer sem valor',
        (c) =>
          c.offerReturn({
            returnSn: RETURN_SN_ALFA,
            proposedSolution: SHOPEE_RETURN_SOLUTION.devolucaoEReembolso,
          }),
        '{"return_sn":"260910ABCDE0001","proposed_solution":"RETURN_REFUND"}',
      ],
      [
        // ⚠️ Cast de propósito: é o chamador JS que escreve a chave com `undefined`.
        'offer com o valor explicitamente undefined',
        (c) =>
          c.offerReturn({
            returnSn: RETURN_SN_ALFA,
            proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
            proposedAdjustedRefundAmount: undefined,
          } as unknown as OfferReturnParams),
        '{"return_sn":"260910ABCDE0001","proposed_solution":"REFUND"}',
      ],
      [
        'offer com valor',
        (c) =>
          c.offerReturn({
            returnSn: RETURN_SN_ALFA,
            proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
            proposedAdjustedRefundAmount: 12.34,
          }),
        '{"return_sn":"260910ABCDE0001","proposed_solution":"REFUND","proposed_adjusted_refund_amount":12.34}',
      ],
      [
        // PAR do D10: um valor que a APP arredondou passa por construção, e vai como saiu de `roundReais`.
        'offer com valor arredondado pela app',
        (c) =>
          c.offerReturn({
            returnSn: RETURN_SN_ALFA,
            proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
            proposedAdjustedRefundAmount: roundReais(19.9 * 3),
          }),
        '{"return_sn":"260910ABCDE0001","proposed_solution":"REFUND","proposed_adjusted_refund_amount":59.7}',
      ],
      // ⚠️ G5 (#1525 review M, X-M16d/e): o acolchoado nas OUTRAS duas escritas.
      // Sem estas linhas, só o scan de fonte do D16 (`.trim(`) guardava `offer`
      // e `accept_offer`, e um `String.prototype.trim.call(…)` passava por ele.
      [
        'offer acolchoado',
        (c) =>
          c.offerReturn({
            returnSn: ` ${RETURN_SN_ALFA}`,
            proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
          }),
        '{"return_sn":" 260910ABCDE0001","proposed_solution":"REFUND"}',
      ],
      [
        'accept_offer acolchoado',
        (c) => c.acceptReturnOffer({ returnSn: `${RETURN_SN_DIGITOS} ` }),
        '{"return_sn":"2609100000000001 "}',
      ],
    ];
    for (const [nome, chamar, esperado] of casos) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(corpoDeEscritaDeDevolucao('req-escrita')),
      );
      await chamar(createShopeeClient(shopConfig(fetchMock)));
      const [rawUrl, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(rawUrl));
      expect(init?.method, nome).toBe('POST');
      expect((init?.headers as Record<string, string>)['Content-Type'], nome).toBe(
        'application/json',
      );
      // O corpo NÃO é assinado: a query leva só as chaves comuns.
      expect([...url.searchParams.keys()].sort(), nome).toEqual([...CHAVES_COMUNS].sort());
      expect(corpoEnviado(fetchMock), nome).toBe(esperado);
    }
  });

  it('D10 — mutantes M17/M21/M23/M24/M25/M26: cada recusa acontece ANTES do token e do fetch, espiões em zero; ⛔ QUASE-IGUAIS: os limites ACEITOS custam uma chamada cada', async () => {
    const alvo = (returnSn: unknown) => ({ returnSn }) as unknown as { returnSn: string };
    const oferta = (troca: Record<string, unknown>): OfferReturnParams =>
      ({
        returnSn: RETURN_SN_ALFA,
        proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
        ...troca,
      }) as unknown as OfferReturnParams;
    const lista = (troca: Record<string, unknown>): GetReturnListParams =>
      ({ pageNo: 0, pageSize: 100, ...troca }) as unknown as GetReturnListParams;
    const JANELA = SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS;

    const recusas: readonly (readonly [string, (c: ShopeeClient) => Promise<unknown>])[] = [
      ...(
        [
          'getReturnDetail',
          'getReturnAvailableSolutions',
          'confirmReturn',
          'acceptReturnOffer',
        ] as const
      ).flatMap((op) =>
        (
          [
            ['vazio', ''],
            ['espaços', '   '],
            ['TAB', '\t'],
            ['ausente', undefined],
            ['null', null],
            ['número', 2_609_100_000_000_001],
          ] as const
        ).map(
          ([nome, sn]) =>
            [`${op} return_sn ${nome}`, (c: ShopeeClient) => c[op](alvo(sn))] as const,
        ),
      ),
      ['offer return_sn vazio', (c) => c.offerReturn(oferta({ returnSn: ' ' }))],
      ["offer solução 'refund'", (c) => c.offerReturn(oferta({ proposedSolution: 'refund' }))],
      [
        "offer solução 'RETURN_AND_REFUND'",
        (c) => c.offerReturn(oferta({ proposedSolution: 'RETURN_AND_REFUND' })),
      ],
      ['offer solução 0', (c) => c.offerReturn(oferta({ proposedSolution: 0 }))],
      ['offer solução ausente', (c) => c.offerReturn(oferta({ proposedSolution: undefined }))],
      // ⚠️ M21: RECUSADO, nunca arredondado — o pacote não escolhe valor.
      [
        'offer valor 12.345',
        (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: 12.345 })),
      ],
      ['offer valor 0', (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: 0 }))],
      ['offer valor -1', (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: -1 }))],
      [
        'offer valor NaN',
        (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: Number.NaN })),
      ],
      [
        'offer valor Infinity',
        (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: Number.POSITIVE_INFINITY })),
      ],
      [
        "offer valor '12.34'",
        (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: '12.34' })),
      ],
      ['offer valor null', (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: null }))],
      ['list page_size 0', (c) => c.getReturnList(lista({ pageSize: 0 }))],
      // ⚠️ M26.
      ['list page_size 101', (c) => c.getReturnList(lista({ pageSize: 101 }))],
      ['list page_size 1.5', (c) => c.getReturnList(lista({ pageSize: 1.5 }))],
      ["list page_size '100'", (c) => c.getReturnList(lista({ pageSize: '100' }))],
      ['list page_no -1', (c) => c.getReturnList(lista({ pageNo: -1 }))],
      ['list page_no 1.5', (c) => c.getReturnList(lista({ pageNo: 1.5 }))],
      ["list page_no '0'", (c) => c.getReturnList(lista({ pageNo: '0' }))],
      ['list page_no ausente', (c) => c.getReturnList(lista({ pageNo: undefined }))],
      // ⚠️ M24: MEIA janela é recusada, nunca completada por um padrão.
      [
        'list só create_time_from',
        (c) => c.getReturnList(lista({ createTimeFromS: INICIO_JANELA_S })),
      ],
      ['list só update_time_to', (c) => c.getReturnList(lista({ updateTimeToS: INICIO_JANELA_S }))],
      // ⚠️ M23: um segundo além de 15 dias é ERRO, não truncamento.
      [
        'list janela de atualização 15 d + 1 s',
        (c) =>
          c.getReturnList(
            lista({
              updateTimeFromS: INICIO_JANELA_S,
              updateTimeToS: INICIO_JANELA_S + JANELA + 1,
            }),
          ),
      ],
      [
        'list janela de criação 15 d + 1 s',
        (c) =>
          c.getReturnList(
            lista({
              createTimeFromS: INICIO_JANELA_S,
              createTimeToS: INICIO_JANELA_S + JANELA + 1,
            }),
          ),
      ],
      [
        'list from == to',
        (c) =>
          c.getReturnList(
            lista({ updateTimeFromS: INICIO_JANELA_S, updateTimeToS: INICIO_JANELA_S }),
          ),
      ],
      [
        'list from > to',
        (c) =>
          c.getReturnList(
            lista({ updateTimeFromS: INICIO_JANELA_S + 1, updateTimeToS: INICIO_JANELA_S }),
          ),
      ],
      [
        'list segundos fracionários',
        (c) =>
          c.getReturnList(
            lista({ updateTimeFromS: INICIO_JANELA_S + 0.5, updateTimeToS: INICIO_JANELA_S + 60 }),
          ),
      ],
      [
        'list segundos 0',
        (c) => c.getReturnList(lista({ updateTimeFromS: 0, updateTimeToS: INICIO_JANELA_S })),
      ],
      // ⚠️ M25: com as DUAS janelas, update_time_from < create_time_from é a recusa da própria página.
      [
        'list update_from < create_from',
        (c) =>
          c.getReturnList(
            lista({
              createTimeFromS: INICIO_JANELA_S,
              createTimeToS: INICIO_JANELA_S + 60,
              updateTimeFromS: INICIO_JANELA_S - 1,
              updateTimeToS: INICIO_JANELA_S + 60,
            }),
          ),
      ],
    ];
    for (const [nome, chamar] of recusas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(corpoDeEscritaDeDevolucao('req-nunca')),
      );
      const getAccessToken = vi.fn(() => Promise.resolve('access-inventado'));
      const erro = await erroDe(chamar(createShopeeClient(shopConfig(fetchMock, getAccessToken))));
      expect(erro, nome).toBeInstanceOf(ShopeeConfigError);
      expect(getAccessToken, nome).not.toHaveBeenCalled();
      expect(fetchMock, nome).not.toHaveBeenCalled();
    }

    // ⛔ QUASE-IGUAIS: os limites ACEITOS — cada um custa EXATAMENTE uma chamada.
    const aceitas: readonly (readonly [string, (c: ShopeeClient) => Promise<unknown>, unknown])[] =
      [
        ['list page_size 1', (c) => c.getReturnList(lista({ pageSize: 1 })), DEVOLUCAO_LISTA_BODY],
        [
          'list page_size 100',
          (c) => c.getReturnList(lista({ pageSize: 100 })),
          DEVOLUCAO_LISTA_BODY,
        ],
        [
          'list janela de EXATAMENTE 15 dias',
          (c) =>
            c.getReturnList(
              lista({ createTimeFromS: INICIO_JANELA_S, createTimeToS: INICIO_JANELA_S + JANELA }),
            ),
          DEVOLUCAO_LISTA_BODY,
        ],
        [
          'list só a janela de atualização',
          (c) => c.getReturnList(LISTA_DE_DEVOLUCOES),
          DEVOLUCAO_LISTA_BODY,
        ],
        [
          'list update_from == create_from',
          (c) =>
            c.getReturnList(
              lista({
                createTimeFromS: INICIO_JANELA_S,
                createTimeToS: INICIO_JANELA_S + 60,
                updateTimeFromS: INICIO_JANELA_S,
                updateTimeToS: INICIO_JANELA_S + 60,
              }),
            ),
          DEVOLUCAO_LISTA_BODY,
        ],
        [
          'offer valor 0.01',
          (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: 0.01 })),
          corpoDeEscritaDeDevolucao('req-aceita'),
        ],
        [
          'offer valor inteiro',
          (c) => c.offerReturn(oferta({ proposedAdjustedRefundAmount: 30 })),
          corpoDeEscritaDeDevolucao('req-aceita'),
        ],
        [
          'detail só dígitos',
          (c) => c.getReturnDetail({ returnSn: RETURN_SN_DIGITOS }),
          DEVOLUCAO_DETALHE_BODY,
        ],
      ];
    for (const [nome, chamar, corpo] of aceitas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(corpo));
      await chamar(createShopeeClient(shopConfig(fetchMock)));
      expect(fetchMock, nome).toHaveBeenCalledTimes(1);
    }
  });

  it('D11 — mutante M18: nenhuma recusa ecoa um VALOR — nem o return_sn (identifica a devolução de um comprador), nem um valor de dinheiro, nem um segundo', async () => {
    const SEGUNDOS = 1_760_123_457;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(corpoDeEscritaDeDevolucao('req-nunca')),
    );
    const client = createShopeeClient(shopConfig(fetchMock));
    const recusas: readonly (readonly [string, Promise<unknown>])[] = [
      // Um return_sn VÁLIDO ao lado de um campo ruim: a recusa não despeja os parâmetros.
      [
        'solução ruim',
        client.offerReturn({
          returnSn: RETURN_SN_ALFA,
          proposedSolution: RETURN_SN_ALFA,
        } as unknown as OfferReturnParams),
      ],
      [
        'valor ruim',
        client.offerReturn({
          returnSn: RETURN_SN_ALFA,
          proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
          proposedAdjustedRefundAmount: 12.345,
        }),
      ],
      [
        'return_sn numérico',
        client.getReturnDetail({ returnSn: 2_609_100_000_000_001 } as unknown as {
          returnSn: string;
        }),
      ],
      [
        'return_sn objeto',
        client.confirmReturn({ returnSn: { toString: () => RETURN_SN_ALFA } } as unknown as {
          returnSn: string;
        }),
      ],
      [
        'meia janela',
        client.getReturnList({ pageNo: 0, pageSize: 100, updateTimeFromS: SEGUNDOS }),
      ],
      [
        'janela longa',
        client.getReturnList({
          pageNo: 0,
          pageSize: 100,
          updateTimeFromS: SEGUNDOS,
          updateTimeToS: SEGUNDOS + SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS + 1,
        }),
      ],
    ];
    for (const [nome, chamada] of recusas) {
      const erro = await erroDe(chamada);
      expect(erro, nome).toBeInstanceOf(ShopeeConfigError);
      const mensagem = (erro as Error).message;
      expect(mensagem, nome).not.toContain(RETURN_SN_ALFA);
      expect(mensagem, nome).not.toContain(RETURN_SN_DIGITOS);
      expect(mensagem, nome).not.toContain('12.345');
      expect(mensagem, nome).not.toContain(String(SEGUNDOS));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('D12 — mutantes M10/M11/M12: NENHUM dado de comprador atravessa o cliente — nem pelas chaves, nem pelos valores, no detalhe e na linha da lista; o campo que nenhuma página documenta some também', async () => {
    const detalheFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(DEVOLUCAO_DETALHE_BODY),
    );
    const listaFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(DEVOLUCAO_LISTA_BODY),
    );
    const detalhe = await createShopeeClient(shopConfig(detalheFetch)).getReturnDetail({
      returnSn: RETURN_SN_ALFA,
    });
    const lista = await createShopeeClient(shopConfig(listaFetch)).getReturnList(
      LISTA_DE_DEVOLUCOES,
    );

    // O VALOR: cada marcador inventado, em qualquer chave, em qualquer profundidade.
    for (const [nome, saida] of [
      ['detalhe', detalhe],
      ['lista', lista],
    ] as const) {
      const texto = JSON.stringify(saida);
      for (const marcador of Object.values(COMPRADOR_FICTICIO)) {
        expect(texto, `${nome}: ${marcador}`).not.toContain(marcador);
      }
    }
    // A CHAVE: nenhuma das que carregam o comprador sobrevive no detalhe.
    const chaves = new Set<string>();
    const andar = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const item of v) andar(item);
      } else if (typeof v === 'object' && v !== null) {
        for (const [chave, filho] of Object.entries(v)) {
          chaves.add(chave);
          andar(filho);
        }
      }
    };
    andar(detalhe.response);
    andar(lista.response);
    for (const proibida of [
      'user',
      'username',
      'email',
      'portrait',
      'return_pickup_address',
      'image',
      'buyer_videos',
      'text_reason',
      'tracking_number',
      'latest_offer_creator',
      'campo_que_a_shopee_inventou_amanha',
    ]) {
      expect(chaves.has(proibida), proibida).toBe(false);
    }
    // ⛔ QUASE-IGUAL: o corte não levou o que a app LÊ.
    expect(detalhe.response.refund_amount).toBe(59.9);
    expect(detalhe.response.negotiation?.latest_solution).toBe('REFUND');
    expect(lista.response.return[0]?.seller_compensation_status).toBe('PENDING_REQUEST');
  });

  it('D13 — mutantes M13/M30: `update_time` ausente FALHA o detalhe inteiro (`ShopeeSchemaError` que o nomeia), mas anula só a LINHA da lista — a página sobrevive', async () => {
    const semRelogio = { ...DEVOLUCAO_DETALHE_BODY.response } as Record<string, unknown>;
    delete semRelogio.update_time;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...DEVOLUCAO_DETALHE_BODY, response: semRelogio }),
    );
    const erro = await erroDe(
      createShopeeClient(shopConfig(fetchMock)).getReturnDetail({ returnSn: RETURN_SN_ALFA }),
    );
    expect(erro).toBeInstanceOf(ShopeeSchemaError);
    expect((erro as Error).message).toContain('update_time');

    const listaFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(DEVOLUCAO_LISTA_BODY),
    );
    const pagina = await createShopeeClient(shopConfig(listaFetch)).getReturnList(
      LISTA_DE_DEVOLUCOES,
    );
    expect(pagina.response.more).toBe(true);
    expect(pagina.response.return).toHaveLength(2);
    expect(pagina.response.return[0]?.return_sn).toBe(RETURN_SN_ALFA);
    expect(pagina.response.return[1]).toBeNull();
  });

  it('D14 — UMA chamada por página, mesmo com `more: true`: o pacote nunca pagina sozinho; uma SEGUNDA chamada cai numa rejeição e a CONTAGEM a acusa', async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(DEVOLUCAO_LISTA_BODY))
      .mockRejectedValue(new Error('uma SEGUNDA chamada: o pacote paginou sozinho'));
    const chamada = createShopeeClient(shopConfig(fetchMock)).getReturnList(LISTA_DE_DEVOLUCOES);
    const assentada = await erroDe(chamada);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assentada).not.toBeInstanceOf(ShopeeNetworkError);
    expect((await chamada).response.more).toBe(true);
  });

  it('D15 — a recusa da Shopee chega como `ShopeeApiError` com o código e a FRASE verbatim (o classificador da app lê `providerMessage`), sem repetição — nem a da escrita, nem a "não permite oferecer" das soluções, que nunca vira resposta vazia', async () => {
    const recusas: readonly (readonly [OperacaoDeDevolucao, string, string])[] = [
      [
        OPERACOES_DE_DEVOLUCAO[3]!,
        'error_return_status',
        'The return status cannot support this action',
      ],
      [
        OPERACOES_DE_DEVOLUCAO[2]!,
        'error_data',
        'Type of return does not allow seller to offer refund',
      ],
      [OPERACOES_DE_DEVOLUCAO[5]!, 'err_data', 'Cannot accept your own offer.'],
    ];
    for (const [op, codigo, frase] of recusas) {
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ error: codigo, message: frase, request_id: 'req-recusa' }),
      );
      const erro = await erroDe(op.chamar(createShopeeClient(shopConfig(fetchMock))));
      expect(erro, op.nome).toBeInstanceOf(ShopeeApiError);
      expect((erro as ShopeeApiError).code, op.nome).toBe(codigo);
      expect((erro as ShopeeApiError).providerMessage, op.nome).toBe(frase);
      expect((erro as ShopeeApiError).requestId, op.nome).toBe('req-recusa');
      expect(fetchMock, op.nome).toHaveBeenCalledTimes(1);
    }
  });

  it('D16 — FONTE: cada bloco tem o guarda ANTES do token, UM `shopeeCall`, o apelido UMA vez, nenhum `.response`, nenhum laço, nenhum trim e nenhuma outra tolerância; seis call sites do apelido, nove no arquivo; os métodos vêm DEPOIS do searchPackageList', () => {
    const blocos: readonly (readonly [string, string, 'GET' | 'POST'])[] = [
      ['getReturnList: async', 'assertReturnListParams(p)', 'GET'],
      ['getReturnDetail: async', 'assertAlvoDeDevolucao(p)', 'GET'],
      ['getReturnAvailableSolutions: async', 'assertAlvoDeDevolucao(p)', 'GET'],
      ['confirmReturn: async', 'assertAlvoDeDevolucao(p)', 'POST'],
      ['offerReturn: async', 'assertOfferReturnParams(p)', 'POST'],
      ['acceptReturnOffer: async', 'assertAlvoDeDevolucao(p)', 'POST'],
    ];
    const apelido = 'emptyErrorAliases: SHOPEE_RETURNS_ERROR_ALIASES';
    for (const [marcador, guarda, verbo] of blocos) {
      const bloco = blocoDoMetodo(marcador);
      expect(bloco.indexOf(guarda), marcador).toBeGreaterThan(-1);
      expect(bloco.indexOf(guarda), marcador).toBeLessThan(bloco.indexOf('signedCall()'));
      expect(bloco.split('shopeeCall(').length - 1, marcador).toBe(1);
      expect(bloco.split(apelido).length - 1, marcador).toBe(1);
      expect(bloco, marcador).toContain(`method: '${verbo}'`);
      // ⚠️ R-17: o envelope INTEIRO — nem `res.response`, nem um `.response` qualquer.
      expect(bloco, marcador).toContain('return shopeeCall(');
      for (const proibido of [
        '.response',
        '.trim(',
        'payloadNoErro',
        'avisoEmLista',
        'erroAusenteEhSucesso',
        'for (',
        'while',
        'catch',
        '.then(',
      ]) {
        expect(bloco, `${marcador} ${proibido}`).not.toContain(proibido);
      }
    }
    // O valor ausente da oferta: `seHouver`, nunca `?? null` ou `?? 0`.
    expect(blocoDoMetodo('offerReturn: async')).toContain(
      "seHouver('proposed_adjusted_refund_amount', p.proposedAdjustedRefundAmount)",
    );
    // As contagens do ARQUIVO: seis call sites do apelido das devoluções, e nove
    // `emptyErrorAliases:` ao todo (dois lost-push, o get_package_detail, as seis).
    expect(FONTE_API.split(apelido).length - 1).toBe(6);
    expect(FONTE_API.split('emptyErrorAliases:').length - 1).toBe(9);
    // O LUGAR: depois do último método do passo 15b — nenhum recorte antigo se alarga.
    expect(FONTE_API.indexOf('getReturnList: async')).toBeGreaterThan(
      FONTE_API.indexOf('searchPackageList: async'),
    );
  });
});

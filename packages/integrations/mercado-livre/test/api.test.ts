import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from '../src/errors';
import { type MercadoLivreApiConfig, createMercadoLivreApi } from '../src/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn>;

function cfg(
  fetchMock: FetchMock,
  over: Partial<MercadoLivreApiConfig> = {},
): MercadoLivreApiConfig {
  return {
    getAccessToken: async () => 'live-token',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryDelayMs: () => 0, // no real waits in tests
    ...over,
  };
}

const USER = { id: 123, nickname: 'SELLER', email: 'x@y.z', site_id: 'MLB' };
const ORDER = {
  id: 2000003508897196,
  status: 'paid',
  order_items: [
    {
      item: { id: 'MLB1', title: 'Camiseta', variation_id: 174390848694, seller_sku: 'SKU-1' },
      quantity: 1,
      unit_price: 50,
      currency_id: 'BRL',
    },
  ],
  total_amount: 50,
  currency_id: 'BRL',
};

describe('createMercadoLivreApi — happy paths', () => {
  it('getMe sends the Bearer token + User-Agent and parses the user', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(USER),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const me = await api.getMe();

    expect(me.id).toBe(123);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/users/me');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
    expect((init!.headers as Record<string, string>)['User-Agent']).toBe('test-UA');
  });

  it('getItem requests include_attributes=all', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 'MLB1', title: 'X', variations: [{ id: 1, available_quantity: 3 }] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const item = await api.getItem('MLB1');
    expect(item.id).toBe('MLB1');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('include_attributes=all');
  });

  it('searchOrders forwards the query params', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: [ORDER], paging: { total: 1 } }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = await api.searchOrders({ seller: 999, 'order.status': 'paid' });
    expect(page.results).toHaveLength(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('seller=999');
    expect(url).toContain('order.status=paid');
  });

  it('accepts a 206 Partial Content order (empty items) without throwing', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 1, status: 'paid', order_items: [] }, 206),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const order = await api.getOrder(1);
    expect(order.order_items).toEqual([]);
  });

  it('tolerates unknown extra fields (ML adds fields without notice)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...USER, brand_new_ml_field: 42 }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const me = (await api.getMe()) as Record<string, unknown>;
    expect(me.brand_new_ml_field).toBe(42);
  });
});

describe('createMercadoLivreApi — retries + errors', () => {
  it('does NOT retry a 429 — throws an HTTP error immediately', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'local_rate_limited' }, 429),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure then succeeds', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(USER));
    const api = createMercadoLivreApi(cfg(fetchMock));
    const me = await api.getMe();
    expect(me.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 5xx — throws an HTTP error immediately', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 404 and throws an HTTP error carrying the status', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'not_found', message: 'Order not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getOrder(1)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoLivreReauthRequiredError);
  });

  it('wraps an exhausted network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('down');
    });
    const api = createMercadoLivreApi(cfg(fetchMock, { maxRetries: 1 }));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoLivreNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('rejects a response that fails schema validation', async () => {
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) => jsonResponse({ nickname: 'no-id' }), // `id` is required
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoLivreValidationError);
  });
});

describe('createMercadoLivreApi — write endpoints', () => {
  const ITEM_RESPONSE = {
    id: 'MLB999',
    title: 'Camiseta',
    status: 'active',
    price: 79.9,
    permalink: 'https://produto.mercadolivre.com.br/MLB999',
    shipping: { free_shipping: false },
    variations: [{ id: 173000001, seller_custom_field: 'prod-var-1' }],
  };

  it('createItem POSTs the JSON payload to /items and parses the listing', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(ITEM_RESPONSE, 201),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const item = await api.createItem({ title: 'Camiseta', price: 79.9 });

    expect(item.id).toBe('MLB999');
    expect(item.shipping?.free_shipping).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/items');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({ title: 'Camiseta', price: 79.9 });
  });

  it('updateItem PUTs to /items/{id}', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...ITEM_RESPONSE, status: 'paused' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const item = await api.updateItem('MLB999', { status: 'paused' });
    expect(item.status).toBe('paused');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/items/MLB999');
    expect(init!.method).toBe('PUT');
  });

  it('setItemDescription POSTs plain_text on create and PUTs ?api_version=2 on replace', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ plain_text: 'Desc' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.setItemDescription('MLB999', 'Desc');
    let [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/items/MLB999/description');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ plain_text: 'Desc' });

    await api.setItemDescription('MLB999', 'Desc2', { replace: true });
    [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('https://api.mercadolibre.com/items/MLB999/description?api_version=2');
    expect(init!.method).toBe('PUT');
  });

  it('suggestCategories queries domain_discovery and parses the suggestions', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        { domain_id: 'MLB-T_SHIRTS', category_id: 'MLB31447', category_name: 'Camisetas' },
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const suggestions = await api.suggestCategories('camiseta basica', 1);
    expect(suggestions[0]!.category_id).toBe('MLB31447');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/sites/MLB/domain_discovery/search');
    expect(url).toContain('q=camiseta+basica');
    expect(url).toContain('limit=1');
  });

  it('uploadPicture sends multipart form data (no JSON content-type) and parses the id', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 'ML-IMG-1' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const upload = await api.uploadPicture({
      filename: 'foto.jpg',
      contentType: 'image/jpeg',
      data: new Uint8Array([1, 2, 3]),
    });

    expect(upload.id).toBe('ML-IMG-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/pictures/items/upload');
    expect(init!.method).toBe('POST');
    expect(init!.body).toBeInstanceOf(FormData);
    const file = (init!.body as FormData).get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('image/jpeg');
    // fetch must set the multipart boundary itself.
    expect((init!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
  });

  it('uploadPicture retries a network failure then succeeds (same policy as request)', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ id: 'ML-IMG-2' }));
    const api = createMercadoLivreApi(cfg(fetchMock));
    const upload = await api.uploadPicture({
      filename: 'foto.jpg',
      contentType: 'image/jpeg',
      data: new Uint8Array([1]),
    });
    expect(upload.id).toBe('ML-IMG-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uploadPicture maps a 400 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid image' }, 400),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(
      api.uploadPicture({ filename: 'x.png', contentType: 'image/png', data: new Uint8Array(1) }),
    ).rejects.toMatchObject({ constructor: MercadoLivreHttpError, status: 400 });
  });
});

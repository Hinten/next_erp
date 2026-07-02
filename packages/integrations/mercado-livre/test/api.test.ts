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
  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(USER),
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'local_rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'local_rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse(USER));
    const api = createMercadoLivreApi(cfg(fetchMock));
    const me = await api.getMe();
    expect(me.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it('gives up after maxRetries on a persistent 5xx and throws an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { maxRetries: 2 }));
    await expect(api.getMe()).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
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

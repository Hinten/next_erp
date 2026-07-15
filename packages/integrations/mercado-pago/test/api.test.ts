import { describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '../src/errors';
import { type MercadoPagoApiConfig, createMercadoPagoApi } from '../src/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn>;

function cfg(fetchMock: FetchMock, over: Partial<MercadoPagoApiConfig> = {}): MercadoPagoApiConfig {
  return {
    getAccessToken: async () => 'live-token',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryDelayMs: () => 0, // no real waits in tests
    ...over,
  };
}

const USER = { id: 123, nickname: 'SELLER', email: 'x@y.z' };
const PAYMENT = {
  id: 987654321,
  status: 'approved',
  status_detail: 'accredited',
  live_mode: true,
  external_reference: 'pedido-1',
  transaction_amount: 150.5,
  installments: 1,
  payment_type_id: 'credit_card',
  payment_method_id: 'visa',
  date_created: '2026-07-01T10:00:00.000-04:00',
  date_approved: '2026-07-01T10:00:05.000-04:00',
  date_last_updated: '2026-07-01T10:00:05.000-04:00',
  refunds: [],
  fee_details: [{ amount: 4.5, type: 'mercadopago_fee' }],
  charges_details: [
    {
      amounts: { original: 150.5, refunded: 0 },
      accounts: { from: 'collector', to: 'mercadopago' },
    },
  ],
  card: { last_four_digits: '1234', cardholder: { name: 'FULANO DA SILVA' } },
  authorization_code: '123456',
  collector_id: 555,
  payer: { id: 999, email: 'payer@x.z' },
};

describe('createMercadoPagoApi — happy paths', () => {
  it('getMe sends the Bearer token + User-Agent and parses the user', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(USER),
    );
    const api = createMercadoPagoApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const me = await api.getMe();

    expect(me.id).toBe(123);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/users/me');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
    expect((init!.headers as Record<string, string>)['User-Agent']).toBe('test-UA');
  });

  it('getPayment requests /v1/payments/{id} and parses the payment subset', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PAYMENT),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    const payment = await api.getPayment(987654321);

    expect(payment.id).toBe(987654321);
    expect(payment.status).toBe('approved');
    expect(payment.card?.last_four_digits).toBe('1234');
    expect(payment.charges_details?.[0]?.amounts?.original).toBe(150.5);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/v1/payments/987654321');
  });

  it('tolerates unknown extra fields (MP adds fields without notice)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...USER, brand_new_mp_field: 42 }),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    const me = (await api.getMe()) as Record<string, unknown>;
    expect(me.brand_new_mp_field).toBe(42);
  });
});

describe('createMercadoPagoApi — retries + errors', () => {
  it('does NOT retry a 429 — throws an HTTP error immediately', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'local_rate_limited' }, 429),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toMatchObject({
      constructor: MercadoPagoHttpError,
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure then succeeds', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(USER));
    const api = createMercadoPagoApi(cfg(fetchMock));
    const me = await api.getMe();
    expect(me.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 5xx — throws an HTTP error immediately', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toMatchObject({
      constructor: MercadoPagoHttpError,
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 404 and throws an HTTP error carrying the status', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'not_found', message: 'Payment not found' }, 404),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.getPayment(1)).rejects.toMatchObject({
      constructor: MercadoPagoHttpError,
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoPagoReauthRequiredError);
  });

  it('wraps an exhausted network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('down');
    });
    const api = createMercadoPagoApi(cfg(fetchMock, { maxRetries: 1 }));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoPagoNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('rejects a response that fails schema validation', async () => {
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) => jsonResponse({ nickname: 'no-id' }), // `id` is required
    );
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.getMe()).rejects.toBeInstanceOf(MercadoPagoValidationError);
  });
});

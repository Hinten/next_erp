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

/**
 * The #1087 regression, reached through Mercado Pago's own door.
 *
 * On 2026-08-21 `GET /collections/174034247387` — Mercado Livre's alias for THIS
 * resource — answered with `order_id` as the string `"2000018052464608"` while
 * `id` stayed a JSON number. `z.number()` rejected the WHOLE body, the pagamento
 * never imported, the pedido stuck at `emProcessamento`, and Cloud Tasks retried
 * identically until the notification parked. The same payment is what
 * `getPayment` fetches here (#1251), so the exposure was never analogous — it
 * was the same object.
 */
describe('a quoted number no longer discards the whole payment', () => {
  const QUOTED_PAYMENT = {
    ...PAYMENT,
    // Quoted exactly the way the live payload mixed them: a stringified id next
    // to dot-decimal money, C-formatted zeros, and a stringified count.
    id: '174034247387',
    transaction_amount: '1000.02',
    shipping_cost: '0.00',
    installments: '1',
    marketplace_fee: '835.02',
    fee_details: [{ amount: '4.50', type: 'mercadopago_fee' }],
    refunds: [{ amount: '10.5' }],
    charges_details: [
      {
        amounts: { original: '150.50', refunded: '0' },
        accounts: { from: 'collector', to: 'mercadopago' },
      },
    ],
  };

  it('every quoted numeric field comes back as a number', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(QUOTED_PAYMENT),
    );
    const payment = await createMercadoPagoApi(cfg(fetchMock)).getPayment(174034247387);

    // ⚠️ The required id first — it is the field that could throw away every
    // other value on the response.
    expect(payment.id).toBe(174034247387);
    expect(payment.transaction_amount).toBe(1000.02);
    expect(payment.shipping_cost).toBe(0);
    expect(payment.installments).toBe(1);
    expect(payment.marketplace_fee).toBe(835.02);
    expect(payment.fee_details?.[0]?.amount).toBe(4.5);
    expect(payment.refunds?.[0]?.amount).toBe(10.5);
    expect(payment.charges_details?.[0]?.amounts?.original).toBe(150.5);
    expect(payment.charges_details?.[0]?.amounts?.refunded).toBe(0);
  });

  it('getMe survives a quoted user id, which is also required', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...USER, id: '123' }),
    );
    const me = await createMercadoPagoApi(cfg(fetchMock)).getMe();
    expect(me.id).toBe(123);
    expect(me.nickname).toBe('SELLER');
  });

  it.each([
    ['an empty string', 'z.coerce.number() reads it as 0'],
    ['1,50', 'a locale parse would say 1.5 OR 150'],
    ['0x1F', 'bare Number() says 31'],
    ['1e3', 'bare Number() says 1000'],
  ])('⛔ still REJECTS transaction_amount %s — %s', async (amount) => {
    // Tolerance, not coercion. A payment silently recorded as R$ 0,00
    // reconciles against nothing and is strictly worse than this failure.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...PAYMENT, transaction_amount: amount === 'an empty string' ? '' : amount }),
    );
    await expect(createMercadoPagoApi(cfg(fetchMock)).getPayment(987654321)).rejects.toBeInstanceOf(
      MercadoPagoValidationError,
    );
  });
});

/**
 * The notification pipeline persists `err.message` ALONE into the failures doc
 * and the sweep marks with `err.message` too — so this string is the entire
 * durable record of a parked notification. In #1087 it said only "formato
 * inesperado" while a quoted number stopped a payment importing.
 */
describe('a validation failure names the field it choked on', () => {
  async function messageFrom(body: unknown): Promise<string> {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(body),
    );
    try {
      await createMercadoPagoApi(cfg(fetchMock)).getPayment(1);
    } catch (err) {
      if (err instanceof MercadoPagoValidationError) return err.message;
      throw err;
    }
    throw new Error('expected a MercadoPagoValidationError');
  }

  it('names a top-level field', async () => {
    expect(await messageFrom({ ...PAYMENT, transaction_amount: '1,50' })).toMatch(
      /transaction_amount/,
    );
  });

  it('names a NESTED path, joined with dots', async () => {
    const body = {
      ...PAYMENT,
      charges_details: [{ amounts: { original: 'abc', refunded: 0 }, accounts: {} }],
    };
    expect(await messageFrom(body)).toMatch(/charges_details\.0\.amounts\.original/);
  });

  it('reports `(raiz)` when the whole body is the wrong shape', async () => {
    expect(await messageFrom('not-an-object')).toMatch(/\(raiz\)/);
  });

  it('⚠️ carries field PATHS and never a value from the body (#1015)', async () => {
    // Paths are field names and carry no value, which is what makes putting them
    // in the message safe. `authorization_code` is a real value on the fixture.
    const message = await messageFrom({ ...PAYMENT, transaction_amount: '1,50' });
    expect(message).not.toContain('123456');
    expect(message).not.toContain('FULANO');
    expect(message).not.toContain('payer@x.z');
  });
});

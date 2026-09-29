import { describe, expect, it, vi } from 'vitest';
import { TIPO_PAGAMENTO_MP } from '@delfrance/schemas';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoRequestError,
  MercadoPagoValidationError,
} from '../src/errors';
import { type MercadoPagoApiConfig, createMercadoPagoApi, mpCauseCodes } from '../src/api';
import type { MpPreferenceExpireRequest, MpPreferenceRequest } from '../src/requests';

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

/* -------------------------------------------------------------------------- */
/*                      Payment links (#367): the request side                 */
/* -------------------------------------------------------------------------- */

const LINK_ID = 'aB3dE5gH7jK9mN1pQ3rS';
const PEDIDO_ID = 'Xk29fLq0PzA81mNbVc7T';
const DEADLINE = '2026-09-30T23:59:59.000-03:00';

const PREFERENCE_REQUEST: MpPreferenceRequest = {
  items: [
    {
      id: LINK_ID,
      title: 'Pedido #123 — Maria',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: 33.33,
    },
  ],
  external_reference: PEDIDO_ID,
  metadata: { link_id: LINK_ID },
  expires: true,
  expiration_date_to: DEADLINE,
  date_of_expiration: DEADLINE,
};

const EXPIRE_PATCH: MpPreferenceExpireRequest = {
  expires: true,
  expiration_date_to: '2026-09-29T14:30:00.000-03:00',
  date_of_expiration: '2026-09-29T14:30:00.000-03:00',
};

const PREFERENCE = {
  id: '123456789-aaaa-bbbb',
  init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-aaaa-bbbb',
};

/** The parsed JSON body a mocked `fetch` was actually handed. */
function sentBody(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== 'string') throw new Error('expected a string request body');
  return JSON.parse(raw);
}

function urlOf(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** Await a promise that must reject with a `MercadoPagoHttpError`, and return it. */
async function httpErrorFrom(promise: Promise<unknown>): Promise<MercadoPagoHttpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MercadoPagoHttpError) return err;
    throw err;
  }
  throw new Error('expected a MercadoPagoHttpError');
}

/** Await a promise that must reject with a `MercadoPagoRequestError`, and return it. */
async function requestErrorFrom(promise: Promise<unknown>): Promise<MercadoPagoRequestError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MercadoPagoRequestError) return err;
    throw err;
  }
  throw new Error('expected a MercadoPagoRequestError');
}

/** A valid request with `over` laid on top — typed loosely because the point is to BREAK it. */
function requestWith(over: Record<string, unknown>): MpPreferenceRequest {
  return { ...PREFERENCE_REQUEST, ...over } as unknown as MpPreferenceRequest;
}

/** A valid request whose only item has `over` laid on top. */
function itemWith(over: Record<string, unknown>): MpPreferenceRequest {
  return requestWith({ items: [{ ...PREFERENCE_REQUEST.items[0], ...over }] });
}

describe('createPreference', () => {
  it('POSTs the JSON body to /checkout/preferences and parses {id, init_point}', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE, 201),
    );
    const pref = await createMercadoPagoApi(cfg(fetchMock)).createPreference(PREFERENCE_REQUEST);

    expect(pref.id).toBe(PREFERENCE.id);
    expect(pref.init_point).toBe(PREFERENCE.init_point);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(sentBody(init)).toEqual(PREFERENCE_REQUEST);
  });

  it('never sends an idempotency key (an honoured one could return an EXPIRED preference)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE, 201),
    );
    await createMercadoPagoApi(cfg(fetchMock)).createPreference(PREFERENCE_REQUEST);
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('x-idempotency-key');
  });

  it('⚠️ a POST whose fetch throws is attempted EXACTLY once — a retry could mint a 2nd preference', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('ECONNRESET'));
    // The default maxRetries (3) is in force: the POST simply does not use it.
    const api = createMercadoPagoApi(cfg(fetchMock));
    await expect(api.createPreference(PREFERENCE_REQUEST)).rejects.toBeInstanceOf(
      MercadoPagoNetworkError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a POST that got an HTTP answer is not repeated either', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid_items', status: 400 }, 400),
    );
    const err = await httpErrorFrom(
      createMercadoPagoApi(cfg(fetchMock)).createPreference(PREFERENCE_REQUEST),
    );
    expect(err.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 401 on the POST asks for a re-auth', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid access token' }, 401),
    );
    await expect(
      createMercadoPagoApi(cfg(fetchMock)).createPreference(PREFERENCE_REQUEST),
    ).rejects.toBeInstanceOf(MercadoPagoReauthRequiredError);
  });

  it('a GET carries no body and no Content-Type', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(USER),
    );
    await createMercadoPagoApi(cfg(fetchMock)).getMe();
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Content-Type');
  });

  it('accepts the full body: payment_methods and every payer part', async () => {
    const full: MpPreferenceRequest = {
      ...PREFERENCE_REQUEST,
      payment_methods: {
        excluded_payment_types: [{ id: TIPO_PAGAMENTO_MP.boleto }],
        installments: 6,
      },
      payer: {
        name: 'Maria',
        surname: 'da Silva',
        email: 'maria@example.com',
        phone: { area_code: '11', number: '999998888' },
        identification: { type: 'CPF', number: '12345678901' },
      },
    };
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE, 201),
    );
    await createMercadoPagoApi(cfg(fetchMock)).createPreference(full);
    expect(sentBody(fetchMock.mock.calls[0]![1])).toEqual(full);
  });

  it.each([0.01, 33.33, 100, 1234.5])('accepts a unit_price of %s', async (unitPrice) => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE, 201),
    );
    await createMercadoPagoApi(cfg(fetchMock)).createPreference(
      itemWith({ unit_price: unitPrice }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives a 201 whose enrichment fields have the wrong type (the preference already exists)', async () => {
    // Mercado Pago has ALREADY created the preference when this parse runs, so a
    // validation failure would orphan a payable link whose id we no longer hold.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        {
          ...PREFERENCE,
          expires: 'yes',
          date_created: 5,
          expiration_date_to: {},
          metadata: 'not-an-object',
          brand_new_mp_field: 1,
        },
        201,
      ),
    );
    const pref = await createMercadoPagoApi(cfg(fetchMock)).createPreference(PREFERENCE_REQUEST);
    expect(pref.id).toBe(PREFERENCE.id);
    expect(pref.init_point).toBe(PREFERENCE.init_point);
    expect(pref.expires).toBeNull();
    expect(pref.metadata).toBeNull();
    expect((pref as Record<string, unknown>).brand_new_mp_field).toBe(1);
  });

  it('a preference answer missing init_point names the field and quotes no value', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 'pref-secret-123' }, 201),
    );
    const err = await createMercadoPagoApi(cfg(fetchMock))
      .createPreference(PREFERENCE_REQUEST)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MercadoPagoValidationError);
    const message = (err as MercadoPagoValidationError).message;
    expect(message).toMatch(/init_point/);
    expect(message).not.toContain('pref-secret-123');
  });
});

describe('a request body is validated against its STRICT schema BEFORE anything is sent', () => {
  // Each row is a body Mercado Pago would either reject with an opaque 4xx or,
  // worse, accept with an effect we never meant (a per-preference notification
  // URL that overrides the panel webhook, a quoted amount, a UTC date).
  const cases: Array<[string, MpPreferenceRequest, string]> = [
    [
      'an extra key notification_url',
      requestWith({ notification_url: 'https://example.test/hook' }),
      'notification_url',
    ],
    [
      'an extra key back_urls',
      requestWith({ back_urls: { success: 'https://x.test' } }),
      'back_urls',
    ],
    ['an extra key binary_mode', requestWith({ binary_mode: true }), 'binary_mode'],
    ['an extra key inside the item', itemWith({ category_id: 'art' }), 'items.0.category_id'],
    ['a 3-decimal unit_price (33.333)', itemWith({ unit_price: 33.333 }), 'items.0.unit_price'],
    ['a STRING unit_price', itemWith({ unit_price: '33.33' }), 'items.0.unit_price'],
    ['a zero unit_price', itemWith({ unit_price: 0 }), 'items.0.unit_price'],
    ['a negative unit_price', itemWith({ unit_price: -1 }), 'items.0.unit_price'],
    ['an infinite unit_price', itemWith({ unit_price: Infinity }), 'items.0.unit_price'],
    ['a quantity of 2', itemWith({ quantity: 2 }), 'items.0.quantity'],
    ['a currency other than BRL', itemWith({ currency_id: 'USD' }), 'items.0.currency_id'],
    [
      'two items',
      requestWith({ items: [PREFERENCE_REQUEST.items[0], PREFERENCE_REQUEST.items[0]] }),
      'items',
    ],
    [
      'an external_reference of 65 characters',
      requestWith({ external_reference: 'a'.repeat(65) }),
      'external_reference',
    ],
    [
      'an external_reference with "@"',
      requestWith({ external_reference: 'a@b' }),
      'external_reference',
    ],
    ['an empty external_reference', requestWith({ external_reference: '' }), 'external_reference'],
    [
      'a link_id that is not 20 alphanumerics',
      requestWith({ metadata: { link_id: 'short' } }),
      'metadata.link_id',
    ],
    [
      'an extra metadata key',
      requestWith({ metadata: { link_id: LINK_ID, pedido: PEDIDO_ID } }),
      'metadata.pedido',
    ],
    [
      'an expiration_date_to ending in Z',
      requestWith({ expiration_date_to: '2026-09-30T23:59:59.000Z' }),
      'expiration_date_to',
    ],
    [
      'a date_of_expiration without milliseconds',
      requestWith({ date_of_expiration: '2026-09-30T23:59:59-03:00' }),
      'date_of_expiration',
    ],
    ['expires: false', requestWith({ expires: false }), 'expires'],
    [
      'an excluded payment type account_money',
      requestWith({ payment_methods: { excluded_payment_types: [{ id: 'account_money' }] } }),
      'payment_methods.excluded_payment_types.0.id',
    ],
    [
      'ALL four excludable types excluded',
      requestWith({
        payment_methods: {
          excluded_payment_types: Object.values(TIPO_PAGAMENTO_MP).map((id) => ({ id })),
        },
      }),
      'payment_methods.excluded_payment_types',
    ],
    [
      'installments of 37',
      requestWith({ payment_methods: { installments: 37 } }),
      'payment_methods.installments',
    ],
    [
      'installments of 0',
      requestWith({ payment_methods: { installments: 0 } }),
      'payment_methods.installments',
    ],
    ['a malformed payer e-mail', requestWith({ payer: { email: 'not-an-email' } }), 'payer.email'],
    [
      'a payer phone with a one-digit area_code',
      requestWith({ payer: { phone: { area_code: '5', number: '999998888' } } }),
      'payer.phone.area_code',
    ],
    [
      'a payer identification of the wrong length',
      requestWith({ payer: { identification: { type: 'CPF', number: '1234567890' } } }),
      'payer.identification.number',
    ],
    [
      'a 14-character number under the CPF type',
      requestWith({ payer: { identification: { type: 'CPF', number: '12345678000195' } } }),
      'payer.identification',
    ],
    [
      'an 11-digit number under the CNPJ type',
      requestWith({ payer: { identification: { type: 'CNPJ', number: '12345678901' } } }),
      'payer.identification',
    ],
    [
      'a payer key the schema does not have (address)',
      requestWith({ payer: { address: { zip_code: '01310100' } } }),
      'payer.address',
    ],
  ];

  it.each(cases)(
    'rejects %s — nothing is fetched, no token is requested',
    async (_label, body, path) => {
      const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse(PREFERENCE, 201),
      );
      const getAccessToken = vi.fn(async () => 'live-token');
      const api = createMercadoPagoApi(cfg(fetchMock, { getAccessToken }));

      const err = await requestErrorFrom(api.createPreference(body));

      expect(err.campos).toContain(path);
      expect(err.message).toContain(path);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    },
  );

  it('⚠️ the message carries field PATHS and never a value (a body can hold e-mail and CPF)', async () => {
    const api = createMercadoPagoApi(cfg(vi.fn()));
    const err = await requestErrorFrom(
      api.createPreference(
        requestWith({
          payer: {
            email: 'secret.person-at-example.com', // no "@": invalid
            phone: { area_code: '11', number: '12345' }, // 5 digits is not a phone
          },
        }),
      ),
    );
    expect(err.campos).toEqual(expect.arrayContaining(['payer.email', 'payer.phone.number']));
    expect(err.message).toMatch(/payer\.email/);
    expect(err.message).not.toContain('secret.person');
    expect(err.message).not.toContain('12345');
    expect(err.campos.join(' ')).not.toContain('secret.person');
  });

  it('reports every invalid field at once, once each', async () => {
    const api = createMercadoPagoApi(cfg(vi.fn()));
    const err = await requestErrorFrom(
      api.createPreference(requestWith({ external_reference: 'a@b', expires: false })),
    );
    expect([...err.campos].sort()).toEqual(['expires', 'external_reference']);
  });
});

describe('updatePreference', () => {
  it('PUTs the expire patch to /checkout/preferences/{id}', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE),
    );
    await createMercadoPagoApi(cfg(fetchMock)).updatePreference(PREFERENCE.id, EXPIRE_PATCH);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.mercadopago.com/checkout/preferences/${PREFERENCE.id}`);
    expect(init!.method).toBe('PUT');
    expect(sentBody(init)).toEqual(EXPIRE_PATCH);
  });

  it('⚠️ the patch moves BOTH dates — a Pix issued earlier stays payable until date_of_expiration', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE),
    );
    await createMercadoPagoApi(cfg(fetchMock)).updatePreference(PREFERENCE.id, EXPIRE_PATCH);
    expect(Object.keys(sentBody(fetchMock.mock.calls[0]![1]) as object).sort()).toEqual([
      'date_of_expiration',
      'expiration_date_to',
      'expires',
    ]);
  });

  it('escapes the id, so it cannot address another path', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE),
    );
    await createMercadoPagoApi(cfg(fetchMock)).updatePreference('a/b?c', EXPIRE_PATCH);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.mercadopago.com/checkout/preferences/a%2Fb%3Fc',
    );
  });

  it('DOES retry a network throw — the patch is idempotent (the POST is the near-miss)', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(PREFERENCE));
    const pref = await createMercadoPagoApi(cfg(fetchMock)).updatePreference(
      PREFERENCE.id,
      EXPIRE_PATCH,
    );
    expect(pref.id).toBe(PREFERENCE.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 404 is an HTTP error carrying the status, not retried', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'preference not found' }, 404),
    );
    const err = await httpErrorFrom(
      createMercadoPagoApi(cfg(fetchMock)).updatePreference(PREFERENCE.id, EXPIRE_PATCH),
    );
    expect(err.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a patch WITHOUT date_of_expiration — the fallback when Mercado Pago 400s it', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE),
    );
    const semPrazoOffline: MpPreferenceExpireRequest = {
      expires: true,
      expiration_date_to: EXPIRE_PATCH.expiration_date_to,
    };
    await createMercadoPagoApi(cfg(fetchMock)).updatePreference(PREFERENCE.id, semPrazoOffline);
    expect(sentBody(fetchMock.mock.calls[0]![1])).toEqual(semPrazoOffline);
  });

  it.each([
    ['a patch without expiration_date_to', { expires: true, date_of_expiration: DEADLINE }],
    ['a patch with only expires', { expires: true }],
    ['a patch ending in Z', { ...EXPIRE_PATCH, date_of_expiration: '2026-09-29T17:30:00.000Z' }],
    ['expires: false', { ...EXPIRE_PATCH, expires: false }],
    ['an extra key', { ...EXPIRE_PATCH, expiration_date_from: DEADLINE }],
  ])('rejects %s before fetch', async (_label, patch) => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PREFERENCE),
    );
    await expect(
      createMercadoPagoApi(cfg(fetchMock)).updatePreference(
        PREFERENCE.id,
        patch as unknown as MpPreferenceExpireRequest,
      ),
    ).rejects.toBeInstanceOf(MercadoPagoRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchPayments', () => {
  const PAGE = {
    paging: { total: 3, limit: 30, offset: 0 },
    results: [
      { id: 111, external_reference: PEDIDO_ID },
      { id: 222, external_reference: PEDIDO_ID },
    ],
  };

  it('sends the exact search params, with the widest allowed window', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PAGE),
    );
    await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: PEDIDO_ID,
      offset: 60,
      limit: 30,
    });

    const [rawUrl, init] = fetchMock.mock.calls[0]!;
    const url = urlOf(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.mercadopago.com/v1/payments/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      external_reference: PEDIDO_ID,
      sort: 'date_created',
      criteria: 'desc',
      range: 'date_created',
      begin_date: 'NOW-360DAYS',
      end_date: 'NOW',
      limit: '30',
      offset: '60',
    });
    expect(init!.method).toBe('GET');
  });

  it('URL-encodes the external_reference', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PAGE),
    );
    await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: 'a&b=c',
      offset: 0,
      limit: 30,
    });
    expect(urlOf(fetchMock.mock.calls[0]![0]).searchParams.get('external_reference')).toBe('a&b=c');
  });

  it('reads a page', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PAGE),
    );
    const page = await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: PEDIDO_ID,
      offset: 0,
      limit: 30,
    });
    expect(page.paging?.total).toBe(3);
    expect(page.results?.map((r) => r.id)).toEqual([111, 222]);
  });

  it('tolerates quoted numbers in paging and in the ids (#1087)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        paging: { total: '3', limit: '30', offset: '0' },
        results: [{ id: '174034247387', external_reference: PEDIDO_ID }],
      }),
    );
    const page = await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: PEDIDO_ID,
      offset: 0,
      limit: 30,
    });
    expect(page.paging).toMatchObject({ total: 3, limit: 30, offset: 0 });
    expect(page.results?.[0]?.id).toBe(174034247387);
  });

  it('one odd element field costs that field, never the page', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        paging: 'garbage',
        results: [
          {
            id: 111,
            external_reference: 42,
            payer: { anything: ['goes'] },
            transaction_amount: '1,50',
          },
          { id: 222, external_reference: PEDIDO_ID },
        ],
      }),
    );
    const page = await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: PEDIDO_ID,
      offset: 0,
      limit: 30,
    });
    expect(page.paging).toBeNull();
    expect(page.results?.map((r) => r.id)).toEqual([111, 222]);
    expect(page.results?.[0]?.external_reference).toBeNull();
  });

  it('DOES retry a network throw (a read)', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockRejectedValueOnce(new TypeError('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(PAGE));
    await createMercadoPagoApi(cfg(fetchMock)).searchPayments({
      externalReference: PEDIDO_ID,
      offset: 0,
      limit: 30,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 400 with cause code 2001 is an HTTP error whose code mpCauseCodes reads', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        {
          message: 'Already posted the same request in the last minute',
          error: 'bad_request',
          status: 400,
          cause: [{ code: 2001, description: 'Already posted the same request' }],
        },
        400,
      ),
    );
    const err = await httpErrorFrom(
      createMercadoPagoApi(cfg(fetchMock)).searchPayments({
        externalReference: PEDIDO_ID,
        offset: 0,
        limit: 30,
      }),
    );
    expect(err.status).toBe(400);
    expect(mpCauseCodes(err)).toEqual(['2001']);
  });
});

describe('mpCauseCodes', () => {
  const httpError = (body: unknown) => new MercadoPagoHttpError('MP 400', 400, body);

  it('reads numeric and string codes, in order, as strings', () => {
    expect(
      mpCauseCodes(httpError({ cause: [{ code: 2001 }, { code: '9062', description: 'x' }] })),
    ).toEqual(['2001', '9062']);
  });

  it('skips an entry it cannot read instead of losing the ones it can', () => {
    const cause = ['junk', null, { nope: 1 }, { code: {} }, { code: 2001 }];
    expect(mpCauseCodes(httpError({ cause }))).toEqual(['2001']);
  });

  it.each([
    ['an empty cause array', { cause: [] }],
    ['no cause at all', { message: 'boom' }],
    ['a cause that is not an array', { cause: '2001' }],
    ['a null body', null],
    ['a raw-text body', 'upstream connect error'],
  ])('is [] for %s', (_label, body) => {
    expect(mpCauseCodes(httpError(body))).toEqual([]);
  });
});

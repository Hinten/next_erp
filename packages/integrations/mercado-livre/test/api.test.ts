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

const USER = {
  id: 123,
  nickname: 'SELLER',
  email: 'x@y.z',
  site_id: 'MLB',
  tags: ['normal', 'user_info_verified'],
};
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
    expect(me.tags).toEqual(['normal', 'user_info_verified']);
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

describe('createMercadoLivreApi — item prices (items_prices topic, Step 11)', () => {
  it('getPrices hits /items/{id}/prices with the Bearer token and parses standard + promotion entries', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 'MLB123',
        prices: [
          {
            id: '1',
            type: 'standard',
            amount: 79.9,
            regular_amount: null,
            currency_id: 'BRL',
            last_updated: '2026-07-01T00:00:00Z',
            conditions: {
              context_restrictions: ['channel_marketplace'],
              start_time: null,
              end_time: null,
            },
          },
          {
            id: '2',
            type: 'promotion',
            amount: 59.9,
            regular_amount: 79.9,
            currency_id: 'BRL',
            last_updated: '2026-07-15T00:00:00Z',
            conditions: {
              context_restrictions: ['channel_marketplace'],
              start_time: '2026-07-15T00:00:00Z',
              end_time: '2026-07-31T23:59:59Z',
            },
          },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const prices = await api.getPrices('MLB123');
    expect(prices.id).toBe('MLB123');
    // `prices` is null-tolerant on the wire; narrow once for the assertions.
    const entries = prices.prices ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe('standard');
    expect(entries[1]!.type).toBe('promotion');
    expect(entries[1]!.regular_amount).toBe(79.9);
    expect(entries[1]!.conditions?.context_restrictions).toEqual(['channel_marketplace']);
    expect(entries[1]!.conditions?.end_time).toBe('2026-07-31T23:59:59Z');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/items/MLB123/prices');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
  });

  it('getPrices tolerates unknown extra fields at every level and a null conditions', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 'MLB123',
        reference_prices: [{ type: 'was' }], // extra root field
        prices: [
          { id: '1', type: 'standard', amount: 10, conditions: null, brand_new_entry_field: true },
          {
            id: '2',
            type: 'promotion',
            amount: 8,
            conditions: { context_restrictions: ['channel_mshops'], eligible: true },
          },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const prices = (await api.getPrices('MLB123')) as Record<string, unknown>;
    expect(prices.reference_prices).toEqual([{ type: 'was' }]);
    const entries = prices.prices as Record<string, unknown>[];
    expect(entries[0]!.conditions).toBeNull();
    expect(entries[0]!.brand_new_entry_field).toBe(true);
    expect((entries[1]!.conditions as Record<string, unknown>).eligible).toBe(true);
  });

  it('getPrices maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'item not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getPrices('MLB404')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });
});

describe('createMercadoLivreApi — order payments + shipments (order import, Step 9)', () => {
  it('getPayment hits /collections/{id} and parses the payment', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 123456789,
        status: 'approved',
        status_detail: 'accredited',
        transaction_amount: 50,
        coupon_amount: 0,
        installments: 1,
        payment_type_id: 'credit_card',
        payment_method_id: 'visa',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const payment = await api.getPayment(123456789);
    expect(payment.id).toBe(123456789);
    expect(payment.status).toBe('approved');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/collections/123456789');
  });

  it('getPayment tolerates unknown extra fields and types charge/fee/refund details', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 1,
        status: 'approved',
        marketplace: 'NONE',
        external_reference: '2000003508419013',
        order_id: 2000003508419013,
        transaction_amount: 100,
        coupon_amount: 0,
        marketplace_fee: 5,
        fee_details: [{ amount: 5, fee_payer: 'collector', type: 'application_fee' }],
        charges_details: [
          { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 1.11, refunded: 0 } },
        ],
        refunds: [{ id: 1, amount: 10 }],
        card: { last_four_digits: '1234' },
        payer: { id: '999', a_field_the_mapper_never_reads: true },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const payment = (await api.getPayment(1)) as Record<string, unknown>;
    expect(payment.fee_details).toEqual([
      { amount: 5, fee_payer: 'collector', type: 'application_fee' },
    ]);
    expect(payment.charges_details).toEqual([
      { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 1.11, refunded: 0 } },
    ]);
    expect(payment.refunds).toEqual([{ id: 1, amount: 10 }]);
    expect((payment.card as Record<string, unknown>).last_four_digits).toBe('1234');
    // marketplace/external_reference/order_id are consumed by the payments-topic handler.
    expect(payment.marketplace).toBe('NONE');
    expect(payment.external_reference).toBe('2000003508419013');
    expect(payment.order_id).toBe(2000003508419013);
    // `payer` isn't consumed by any mapper — still rides through untyped.
    expect((payment.payer as Record<string, unknown>).a_field_the_mapper_never_reads).toBe(true);
  });

  it('getPayment maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'payment not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getPayment(999)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('getShipment hits /shipments/{id} and parses the dispatch/delivery windows', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 555,
        order_id: 2000003508897196,
        status: 'ready_to_ship',
        substatus: 'ready_to_print',
        tracking_number: 'BR123456789',
        last_updated: '2022-08-22T00:00:00.000-03:00',
        base_cost: 8.91,
        logistic_type: 'cross_docking',
        shipping_option: {
          list_cost: 8.91,
          estimated_handling_limit: { date: '2022-08-22T00:00:00.000-03:00' },
          estimated_delivery_limit: { date: '2022-08-24T00:00:00.000-03:00' },
          estimated_delivery_time: { date: '2022-08-24T00:00:00.000-03:00' },
        },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const shipment = await api.getShipment(555);
    expect(shipment.status).toBe('ready_to_ship');
    expect(shipment.substatus).toBe('ready_to_print');
    expect(shipment.shipping_option?.estimated_handling_limit?.date).toBe(
      '2022-08-22T00:00:00.000-03:00',
    );
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/shipments/555');
  });

  it('getShipment maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipment(555)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
  });

  it('getShipmentPayments hits /shipments/{id}/payments and parses the BARE ARRAY response', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        { status: 'approved', amount: 8.91 },
        { status: 'approved', amount: '2.5' }, // ML has sent amount as a numeric string too
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const payments = await api.getShipmentPayments(555);
    expect(payments).toEqual([
      { status: 'approved', amount: 8.91 },
      { status: 'approved', amount: '2.5' },
    ]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/shipments/555/payments');
  });

  it('getShipmentPayments maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentPayments(555)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
  });

  it('getShipmentSla hits /shipments/{id}/sla and parses expected_date', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ expected_date: '2022-08-22T00:00:00.000-03:00' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const sla = await api.getShipmentSla(555);
    expect(sla.expected_date).toBe('2022-08-22T00:00:00.000-03:00');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/shipments/555/sla');
  });

  it('getShipmentSla maps a 404 to an HTTP error (caller falls back to the seller schedule)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentSla(555)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('getSellerShippingSchedule hits /users/{sellerId}/shipping/schedule/{logisticType} and parses the weekday schedule', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        schedule: {
          monday: { work: true, detail: [{ cutoff: '14:00' }] },
          sunday: { work: false, detail: [] },
        },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const schedule = await api.getSellerShippingSchedule(999, 'cross_docking');
    expect(schedule.schedule?.monday?.work).toBe(true);
    expect(schedule.schedule?.monday?.detail?.[0]?.cutoff).toBe('14:00');
    expect(schedule.schedule?.sunday?.work).toBe(false);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/users/999/shipping/schedule/cross_docking');
  });

  it('getSellerShippingSchedule maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getSellerShippingSchedule(999, 'drop_off')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
  });

  it('getOrderBillingInfo hits /orders/{id}/billing_info WITH the x-version: 2 header and parses buyer fiscal data', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        site_id: 'MLB',
        buyer: {
          cust_id: 234343545,
          billing_info: {
            name: 'Apple Brasil',
            identification: { type: 'CNPJ', number: '326594309119203' },
            taxes: {
              inscriptions: { state_registration: '30703088534' },
              taxpayer_type: { description: 'Contribuinte' },
            },
            address: {
              street_name: 'Nicolau de Marcos',
              street_number: '05',
              city_name: 'Bom Jardim',
              neighborhood: 'Jardim Ornelas',
              state: { name: 'Rio de Janeiro' },
              zip_code: '28660000',
              country_id: 'BR',
            },
          },
        },
        seller: { cust_id: 34345454 },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const billing = await api.getOrderBillingInfo(2000003508897196);
    expect(billing.buyer?.billing_info?.identification?.type).toBe('CNPJ');
    expect(billing.buyer?.billing_info?.address?.zip_code).toBe('28660000');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/orders/2000003508897196/billing_info');
    expect((init!.headers as Record<string, string>)['x-version']).toBe('2');
  });

  it('getOrderBillingInfo maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getOrderBillingInfo(1)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });
});

describe('createMercadoLivreApi — shipment invoice_data (NF-e upload, Step 12, #739)', () => {
  const XML = '<?xml version="1.0"?><nfeProc/>';

  it('sendShipmentInvoiceData POSTs the RAW XML with application/xml, the Bearer header and siteId=MLB', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 1, shipment_id: 123, status: 'approved' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    await api.sendShipmentInvoiceData(123, XML);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/shipments/123/invoice_data');
    expect(String(url)).toContain('siteId=MLB');
    // The legacy Dart client sent the token as an `access_token` query param on
    // exactly this endpoint (deprecated by ML) — pin that it never comes back.
    expect(String(url)).not.toContain('access_token');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/xml');
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers['User-Agent']).toBe('test-UA');
    // The body is the raw XML string — NOT JSON-stringified (no leading '"').
    expect(init!.body).toBe(XML);
    expect((init!.body as string).startsWith('"')).toBe(false);
  });

  it('sendShipmentInvoiceData parses the saved invoice and passthrough extra fields survive', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 99,
        shipment_id: 123,
        status: 'approved',
        fiscal_key: '35260712345678000199550010000012341000012349',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const invoice = (await api.sendShipmentInvoiceData(123, XML)) as Record<string, unknown>;
    expect(invoice.id).toBe(99);
    expect(invoice.shipment_id).toBe(123);
    expect(invoice.status).toBe('approved');
    expect(invoice.fiscal_key).toBe('35260712345678000199550010000012341000012349');
  });

  it('sendShipmentInvoiceData maps a 400 to an HTTP error preserving the parsed JSON body', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        { message: 'shipment invoice already saved', error: 'shipment_invoice_already_saved' },
        400,
      ),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.sendShipmentInvoiceData(123, XML)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 400,
      body: { message: 'shipment invoice already saved', error: 'shipment_invoice_already_saved' },
    });
  });

  it('sendShipmentInvoiceData maps a 401 to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.sendShipmentInvoiceData(123, XML)).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });

  it('getShipmentInvoiceData GETs /shipments/{id}/invoice_data with siteId=MLB and parses the invoice', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 99, shipment_id: 123, status: 'approved' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const invoice = await api.getShipmentInvoiceData(123);
    expect(invoice.id).toBe(99);
    expect(invoice.shipment_id).toBe(123);
    expect(invoice.status).toBe('approved');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/shipments/123/invoice_data');
    expect(String(url)).toContain('siteId=MLB');
    expect(init!.method).toBe('GET');
  });
});

describe('createMercadoLivreApi — User-Products family fan-out (#521)', () => {
  it('getUserProductFamily hits /sites/MLB/user-products-families/{id} and parses user_products_ids', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ user_products_ids: ['UPtin1', 'UPtin2'] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const family = await api.getUserProductFamily('UPF123');
    expect(family.user_products_ids).toEqual(['UPtin1', 'UPtin2']);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/sites/MLB/user-products-families/UPF123');
  });

  it('getUserProductFamily defaults user_products_ids to [] when ML omits the field', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const family = await api.getUserProductFamily('UPF123');
    expect(family.user_products_ids).toEqual([]);
  });

  it('getUserProductFamily tolerates unknown extra fields', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ user_products_ids: [], name: 'Camiseta' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const family = (await api.getUserProductFamily('UPF123')) as Record<string, unknown>;
    expect(family.name).toBe('Camiseta');
  });

  it('getUserProductFamily maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'family not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getUserProductFamily('UPF404')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('searchItemsByUserProduct joins ids with a comma and hits /users/{sellerId}/items/search', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: ['MLB111', 'MLB222'] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const found = await api.searchItemsByUserProduct(999, ['UPtin1', 'UPtin2']);
    expect(found.results).toEqual(['MLB111', 'MLB222']);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/users/999/items/search');
    expect(url).toContain('user_product_id=UPtin1%2CUPtin2');
  });

  it('searchItemsByUserProduct defaults results to [] when ML omits the field', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const found = await api.searchItemsByUserProduct(999, ['UPtin1']);
    expect(found.results).toEqual([]);
  });

  it('searchItemsByUserProduct maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.searchItemsByUserProduct(999, ['UPtin1'])).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
  });
});

describe('createMercadoLivreApi — mass import seller scan (#621)', () => {
  it('scanSellerItems hits /users/{sellerId}/items/search with search_type=scan and no scroll_id on the first page', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: ['MLB111', 'MLB222'], scroll_id: 'SCROLL1' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = await api.scanSellerItems(999);
    expect(page.results).toEqual(['MLB111', 'MLB222']);
    expect(page.scroll_id).toBe('SCROLL1');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/users/999/items/search');
    expect(url).toContain('search_type=scan');
    expect(url).not.toContain('scroll_id');
  });

  it('scanSellerItems forwards a non-empty scroll_id on subsequent pages', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: [], scroll_id: '' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.scanSellerItems(999, 'SCROLL1');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('scroll_id=SCROLL1');
  });

  it('scanSellerItems omits scroll_id when passed null (start-of-scan sentinel)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: [] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.scanSellerItems(999, null);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('scroll_id');
  });

  it('scanSellerItems defaults results to [] when ML omits the field', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = await api.scanSellerItems(999);
    expect(page.results).toEqual([]);
    expect(page.scroll_id).toBeUndefined();
  });

  it('scanSellerItems tolerates unknown extra fields', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: [], paging: { total: 0 }, another_new_field: 'x' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = (await api.scanSellerItems(999)) as Record<string, unknown>;
    expect(page.another_new_field).toBe('x');
  });

  it('scanSellerItems maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.scanSellerItems(999)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
  });
});

describe('createMercadoLivreApi — User-Products migration (#441)', () => {
  it('getMigrationLiveListing hits /items/{id}/migration_live_listing and parses new_items', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        new_items: [
          { new_item_id: 'MLB111', variation_id: 174390848694 },
          { new_item_id: 'MLB222', variation_id: '174390848695' },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const listing = await api.getMigrationLiveListing('MLB1');
    expect(listing.new_items).toEqual([
      { new_item_id: 'MLB111', variation_id: 174390848694 },
      { new_item_id: 'MLB222', variation_id: '174390848695' },
    ]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.mercadolibre.com/items/MLB1/migration_live_listing');
  });

  it('getMigrationLiveListing defaults new_items to [] when ML omits the field', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const listing = await api.getMigrationLiveListing('MLB1');
    expect(listing.new_items).toEqual([]);
  });

  it('getMigrationLiveListing tolerates unknown extra fields on the listing and its entries', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        new_items: [{ new_item_id: 'MLB111', variation_id: 1, extra_ml_field: true }],
        another_new_field: 'x',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const listing = (await api.getMigrationLiveListing('MLB1')) as Record<string, unknown>;
    expect(listing.another_new_field).toBe('x');
    expect((listing.new_items as Record<string, unknown>[])[0]!.extra_ml_field).toBe(true);
  });

  it('getMigrationLiveListing maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMigrationLiveListing('MLB404')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('getMigrationLiveListing maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getMigrationLiveListing('MLB1')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
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

  it('carries a numeric Retry-After header as retryAfterSec (null when absent or HTTP-date)', async () => {
    const with429 = (headers: Record<string, string>) =>
      vi.fn(
        async (_u: string | URL | Request, _i?: RequestInit) =>
          new Response(JSON.stringify({ error: 'local_rate_limited' }), {
            status: 429,
            headers: { 'content-type': 'application/json', ...headers },
          }),
      );
    await expect(
      createMercadoLivreApi(cfg(with429({ 'retry-after': '17' }))).getMe(),
    ).rejects.toMatchObject({ constructor: MercadoLivreHttpError, status: 429, retryAfterSec: 17 });
    await expect(createMercadoLivreApi(cfg(with429({}))).getMe()).rejects.toMatchObject({
      status: 429,
      retryAfterSec: null,
    });
    await expect(
      createMercadoLivreApi(
        cfg(with429({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })),
      ).getMe(),
    ).rejects.toMatchObject({ status: 429, retryAfterSec: null });
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

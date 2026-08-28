import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreLabelUnavailableError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
  isVersionConflict,
  sanitizeRequestPath,
} from '../src/errors';
import { type MercadoLivreApiConfig, createMercadoLivreApi } from '../src/api';
import { ML_MULTIGET_MAX_IDS, orderSchema } from '../src/types';
import {
  __resetAvisoFormatoLegado,
  ehFormatoLegado,
  shipmentBaseCost,
  shipmentLeadTime,
  shipmentLogisticType,
} from '../src/shipmentFields';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

  it('getItemsByIds joins ids and attributes, and parses the VERBOSE envelope', async () => {
    // Multiget does not answer with items — it answers `[{code, body}, …]`, one
    // entry per requested id, each with its own status. A caller that reads
    // `body` without `code` sees a 403/404 as an item with no fields.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        { code: 200, body: { id: 'MLB1', user_product_id: 'MLBU1' } },
        { code: 404, body: null },
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const out = await api.getItemsByIds(['MLB1', 'MLB2'], ['id', 'user_product_id']);

    expect(out).toHaveLength(2);
    expect(out[0]!.code).toBe(200);
    expect(out[0]!.body?.user_product_id).toBe('MLBU1');
    expect(out[1]!.code).toBe(404);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/items?');
    expect(url).toContain('ids=MLB1%2CMLB2');
    expect(url).toContain('attributes=id%2Cuser_product_id');
  });

  it('getItemsByIds tolerates a QUOTED code — ML quoting a number must not kill the body', async () => {
    // #1087's shape, applied here: `parseOk` validates the whole body, so one
    // strict field costs the entire multiget. This one is the worst place for
    // it — every entry would fail `code !== 200`, `verificarMembros` would
    // confirm nothing, and the orphan sweep would silently stop closing.
    // ⚠️ Only reachable through the real client: the sweep's own tests mock
    // `getItemsByIds` and never run this schema.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ code: '200', body: { id: 'MLB1', user_product_id: 'MLBU1' } }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const out = await api.getItemsByIds(['MLB1'], ['id', 'user_product_id']);

    expect(out[0]!.code).toBe(200);
    expect(out[0]!.body?.user_product_id).toBe('MLBU1');
  });

  it('getItemsByIds omits attributes entirely when none are named', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ code: 200, body: { id: 'MLB1' } }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getItemsByIds(['MLB1']);

    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('attributes=');
  });

  it('getItemsByIds REFUSES more than the cap, before touching the network', async () => {
    // ML does not error on an over-long multiget — it truncates — so a caller
    // deciding what to CLOSE from the difference would act on a set it only
    // partly verified. The "no fetch" half is the point: the refusal has to
    // happen at the seam, not after ML has already answered for a prefix.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const demais = Array.from({ length: ML_MULTIGET_MAX_IDS + 1 }, (_, i) => `MLB${String(i)}`);

    await expect(api.getItemsByIds(demais)).rejects.toBeInstanceOf(MercadoLivreError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getItemsByIds allows EXACTLY the cap — the boundary is inclusive', async () => {
    // Pins the off-by-one: a cap that silently became `>=` would leave the last
    // id of every full chunk unverified, which is the same silent prefix in a
    // different disguise.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const noLimite = Array.from({ length: ML_MULTIGET_MAX_IDS }, (_, i) => `MLB${String(i)}`);

    await api.getItemsByIds(noLimite);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getItemsByIds maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getItemsByIds(['MLB1'])).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 500,
    });
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

  it('getOrderResponse reports a 200 as complete and a 206 as not', async () => {
    // The orderML mirror uses this to decide replace-vs-merge (#793).
    const ok = createMercadoLivreApi(
      cfg(vi.fn(async () => jsonResponse({ id: 1, status: 'paid', order_items: [] }, 200))),
    );
    await expect(ok.getOrderResponse(1)).resolves.toMatchObject({ complete: true });

    const partial = createMercadoLivreApi(
      cfg(vi.fn(async () => jsonResponse({ id: 1, status: 'paid', order_items: [] }, 206))),
    );
    await expect(partial.getOrderResponse(1)).resolves.toMatchObject({ complete: false });
  });

  it('getOrderResponse keeps absent-vs-null distinct on the parsed order', async () => {
    // `pack_id` absent must NOT become null — that difference is the whole
    // discriminator the mirror merge runs on.
    const api = createMercadoLivreApi(
      cfg(vi.fn(async () => jsonResponse({ id: 1, status: 'paid', order_items: [] }, 206))),
    );
    const { order } = await api.getOrderResponse(1);
    expect('pack_id' in order).toBe(false);

    const withNull = createMercadoLivreApi(
      cfg(
        vi.fn(async () =>
          jsonResponse({ id: 1, status: 'paid', order_items: [], pack_id: null }, 200),
        ),
      ),
    );
    const res = await withNull.getOrderResponse(1);
    expect('pack_id' in res.order).toBe(true);
    expect(res.order.pack_id).toBeNull();
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

  it('getPayment parses a numeric field Mercado Livre sent as a STRING (#1087 live run)', async () => {
    // The 2026-08-21 regression, taken from the live payload of payment
    // 174034247387 (order 2000018052464608, seller 3616169770): ML quoted
    // `order_id` while `id` stayed a JSON number. Both were `z.number().int()`,
    // so Zod rejected the WHOLE body, the pagamento never imported, the pedido
    // stuck at `emProcessamento`, and Cloud Tasks retried the identical request
    // until the notification parked.
    //
    // ⚠️ The blast radius is out of all proportion to the field. `order_id` is
    // only a FALLBACK for the order key — `parsePaymentOrderKey` prefers
    // `external_reference`, which arrived present and valid. The import had
    // everything it needed and still died, because `parseOk` validates the whole
    // body before any caller reads a field.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 174034247387,
        order_id: '2000018052464608', // ← quoted by ML; the field that broke the run
        external_reference: '2000018052464608',
        authorization_code: '301299',
        api_version: '2',
        transaction_amount: 1000.02,
        total_paid_amount: 1000.02,
        shipping_cost: 0,
        coupon_amount: 0,
        marketplace_fee: 0,
        installments: 1,
        status: 'approved',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const payment = await api.getPayment(174034247387);
    expect(payment.order_id).toBe(2000018052464608);
    expect(typeof payment.order_id).toBe('number');
    // Everything else on the body still parses exactly as it did before.
    expect(payment.id).toBe(174034247387);
    expect(payment.transaction_amount).toBe(1000.02);
    expect(payment.external_reference).toBe('2000018052464608');
  });

  it('a schema failure names the offending field in the MESSAGE, not only in issues', async () => {
    // ⚠️ The message is the only part that survives into the durable record. The
    // notification pipeline persists `err.message` ALONE (`persistFailure`) and
    // the sweep marks with `err.message` too, so a bare "formato inesperado" is
    // exactly what made the #1087 parked notification undiagnosable. `issues`
    // never reaches that document.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 1, transaction_amount: 'R$ 100,00' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getPayment(1)).rejects.toThrow(/Campos inválidos: transaction_amount/);
  });

  it('the message dedups paths and never carries the response body (#1015)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 1,
        fee_details: [{ amount: 'x' }, { amount: 'y' }],
        payer: { email: 'buyer@example.com' },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getPayment(1)).rejects.toMatchObject({
      // Both bad entries share a path shape, but each carries its own index, so
      // the dedup keeps them distinct without repeating a path.
      message: expect.stringContaining('Campos inválidos:'),
    });
    const err = await api.getPayment(1).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain('buyer@example.com');
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

  it('getShipment sends x-format-new and parses the NEW-format body', async () => {
    // The `x-format-new` shape, trimmed to the branches we consume (ML docs,
    // *Gerenciamento de Envios*). Deliberately carries NO `order_id`,
    // `base_cost`, `logistic_type` or `shipping_option`: those are exactly what
    // the migration removed, so a fixture that still had them would keep
    // asserting the old world (#957).
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 555,
        status: 'ready_to_ship',
        substatus: 'ready_to_print',
        tracking_number: 'BR123456789',
        last_updated: '2022-08-22T00:00:00.000-03:00',
        logistic: { mode: 'me2', type: 'cross_docking', direction: 'forward' },
        lead_time: {
          cost: 8.91,
          list_cost: 12.5,
          estimated_delivery_limit: { date: '2022-08-24T00:00:00.000-03:00' },
          estimated_delivery_time: { date: '2022-08-24T00:00:00.000-03:00' },
        },
        destination: {
          receiver_name: 'Fulana de Tal',
          shipping_address: {
            street_name: 'Rua das Flores',
            street_number: '123',
            zip_code: '01310100',
            comment: 'Apto 42',
            neighborhood: { name: 'Centro' },
            city: { name: 'São Paulo' },
            state: { name: 'São Paulo' },
          },
        },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const shipment = await api.getShipment(555);
    expect(shipment.status).toBe('ready_to_ship');
    expect(shipment.substatus).toBe('ready_to_print');
    expect(shipment.logistic?.type).toBe('cross_docking');
    expect(shipment.lead_time?.list_cost).toBe(12.5);
    // `cost` rides the passthrough but is deliberately UNtyped: it is not the
    // legacy `base_cost` and must never be read as one (#957).
    expect((shipment.lead_time as Record<string, unknown>).cost).toBe(8.91);
    expect(shipment.lead_time?.estimated_delivery_time?.date).toBe('2022-08-24T00:00:00.000-03:00');
    expect(shipment.destination?.shipping_address?.zip_code).toBe('01310100');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.mercadolibre.com/shipments/555');
    expect((init!.headers as Record<string, string>)['x-format-new']).toBe('true');
  });

  it('getShipment still parses a LEGACY body, so the accessors can bridge it', async () => {
    // ML rolled these deprecations out per-resource over more than a year, and
    // the new shape here comes from documentation rather than a live call — so
    // the schema must not reject an account still being served the old body.
    // The legacy fields survive on `.passthrough()`; `shipmentFields.ts` reads
    // them. Delete this test with the fallbacks (#957).
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 555,
        order_id: 2000003508897196,
        status: 'ready_to_ship',
        base_cost: 8.91,
        logistic_type: 'cross_docking',
        shipping_option: { list_cost: 12.5 },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const shipment = await api.getShipment(555);
    expect(shipment.status).toBe('ready_to_ship');
    expect(shipment.lead_time).toBeUndefined();
    expect(shipmentLogisticType(shipment)).toBe('cross_docking');
    expect(shipmentBaseCost(shipment)).toBe(8.91);
    expect(shipmentLeadTime(shipment)?.list_cost).toBe(12.5);
    expect(ehFormatoLegado(shipment)).toBe(true);
  });

  it('WARNS once when ML is still serving the legacy body, and not at all when it is not', async () => {
    // The deletion trigger has to be an OBSERVATION. Without this warn, "no
    // legacy warnings in the logs" would be equally consistent with "ML migrated
    // us" and with "nothing was ever looking" — and acting on the second reading
    // would delete a fallback that is still load-bearing (#957).
    __resetAvisoFormatoLegado();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const legado = createMercadoLivreApi(
        cfg(vi.fn(async () => jsonResponse({ id: 555, logistic_type: 'drop_off' }))),
      );
      await legado.getShipment(555);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('formato LEGADO');

      // One-shot: a second legacy shipment must not re-warn — this is a one-bit
      // fact about the account, not a per-shipment event.
      await legado.getShipment(556);
      expect(warn).toHaveBeenCalledTimes(1);

      // …and a migrated body never warns at all.
      __resetAvisoFormatoLegado();
      warn.mockClear();
      const novo = createMercadoLivreApi(
        cfg(vi.fn(async () => jsonResponse({ id: 557, logistic: { type: 'drop_off' } }))),
      );
      await novo.getShipment(557);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      __resetAvisoFormatoLegado();
    }
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

  it('getShipmentCosts hits /shipments/{id}/costs with x-format-new and parses the documented body', async () => {
    // Verbatim from ML's docs (*Gerenciamento de Envios* → Costs). Everything
    // outside `gross_amount` / `receiver` / `senders[].{user_id,cost}` — the
    // deprecated `save`, the whole `discounts` breakdown — must ride the
    // passthrough untouched rather than being typed (#957).
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        gross_amount: 24.55,
        receiver: {
          user_id: 74425755,
          cost: 0,
          compensation: 0,
          save: 0,
          discounts: [{ rate: 1, type: 'loyal', promoted_amount: 4.07 }],
        },
        senders: [
          {
            user_id: 81387353,
            cost: 8.19,
            compensation: 0,
            save: 0,
            discounts: [{ rate: 0.6, type: 'mandatory', promoted_amount: 12.29 }],
          },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const costs = await api.getShipmentCosts(47868202073);
    expect(costs.gross_amount).toBe(24.55);
    expect(costs.receiver?.cost).toBe(0);
    expect(costs.senders?.[0]?.user_id).toBe(81387353);
    expect(costs.senders?.[0]?.cost).toBe(8.19);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.mercadolibre.com/shipments/47868202073/costs');
    // ML's own curl for this resource carries it — NOT legacy's `X-Costos-New`.
    expect((init!.headers as Record<string, string>)['x-format-new']).toBe('true');
    expect(init!.headers as Record<string, string>).not.toHaveProperty('X-Costos-New');
  });

  it('getShipmentCosts maps a 404 to an HTTP error rather than an empty costs object', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentCosts(555)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('getShipmentCosts parses a REAL captured body, whose extra fields the docs never mention', async () => {
    // Captured live 2026-08-27 from shipment 47868202073 on the staging ML test
    // seller (3616169770). Kept verbatim, like the two `.old/` shipment payloads in
    // `orderShipmentMapping.test.ts`: ML's documented example is a strict SUBSET of
    // what the wire sends, so only a real body can prove the undocumented keys ride
    // `.passthrough()` instead of being rejected (#957).
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        receiver: {
          compensations: [],
          fees: [],
          cost: 12.99,
          discounts: [{ rate: 0.5, type: 'gap', promoted_amount: 12.8 }],
          user_id: 3644236740,
          cost_details: [{ sender_id: 3616169770, amount: 12.99 }],
          save: 11.81,
          compensation: 0,
        },
        gross_amount: 38.86,
        senders: [
          {
            compensations: [],
            charges: { charge_flex: 0 },
            fees: [],
            cost: 9.15,
            discounts: [{ rate: 0.3, type: 'mandatory', promoted_amount: 3.92 }],
            user_id: 3616169770,
            save: 3.92,
            compensation: 0,
          },
        ],
        base_exchange: null,
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const costs = await api.getShipmentCosts(47868202073);

    // What the resolver reads.
    expect(costs.senders?.[0]?.user_id).toBe(3616169770);
    expect(costs.senders?.[0]?.cost).toBe(9.15);

    // ⚠️ `save` is documented as removed from this resource in Jan/2025 and it is
    // BOTH present and non-zero ~20 months later. It stays untyped by choice, not
    // by absence — see `mlShipmentCostPartySchema`. Asserting it here is what stops
    // someone "fixing" that comment after seeing the field in a payload.
    const sender = costs.senders?.[0] as Record<string, unknown>;
    expect(sender.save).toBe(3.92);
    expect(sender.charges).toEqual({ charge_flex: 0 });
    expect(sender.fees).toEqual([]);
    expect(costs.receiver).toHaveProperty('cost_details');
    expect(costs).toHaveProperty('base_exchange', null);

    // The reconciliation identity, to the centavo: gross = Σ(cost + Σ promoted).
    // Pinned because the ORIGINAL guess here was `gross - receiver.cost`, which
    // gives 25.87 rather than 9.15 — a "mismatch" a human would have reported.
    expect(12.99 + 12.8 + 9.15 + 3.92).toBeCloseTo(costs.gross_amount!, 2);
    expect(costs.gross_amount! - costs.receiver!.cost!).not.toBeCloseTo(9.15, 2);
  });

  it('getShipmentOrders hits /shipments/{id}/orders with X-New-Domain and parses the BARE ARRAY', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        {
          order_id: '2000014428837134',
          pack_id: '2000015428123455',
          item_id: 'MLB2041819084',
          variation_id: null,
          user_product_id: 'MLBU147563159',
          seller_id: 12345,
          requested_quantity: 1,
        },
        {
          order_id: 2000014428837136,
          pack_id: null,
          item_id: 'MLB2041819099',
          variation_id: 9876543210,
          user_product_id: null,
          seller_id: 12345,
          // ML has sent numerics as strings across this API — the union covers it.
          requested_quantity: '2',
        },
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const rows = await api.getShipmentOrders(555);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ item_id: 'MLB2041819084', requested_quantity: 1 });
    expect(rows[1]).toMatchObject({ variation_id: 9876543210, requested_quantity: '2' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.mercadolibre.com/shipments/555/orders');
    expect((init!.headers as Record<string, string>)['X-New-Domain']).toBe('true');
  });

  it('getShipmentOrders keeps unknown fields via passthrough', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ item_id: 'MLB1', requested_quantity: 1, campo_novo_do_ml: 'x' }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentOrders(555)).resolves.toEqual([
      { item_id: 'MLB1', requested_quantity: 1, campo_novo_do_ml: 'x' },
    ]);
  });

  it('getShipmentOrders parses a 204 No Content as an empty array', async () => {
    // Documented response ("Shipment não possui pedidos"). `parseOk` leaves the
    // body null on an empty response, which a bare `z.array()` would reject —
    // the schema's `.nullish().transform()` is what keeps a 204 from parking an
    // import on a MercadoLivreValidationError.
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) => new Response(null, { status: 204 }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentOrders(555)).resolves.toEqual([]);
  });

  it('getShipmentOrders REJECTS a results-envelope response', async () => {
    // Locks the bare-array contract: if ML ever wraps this resource, the call
    // must fail loudly rather than silently reconcile against zero rows.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: [{ item_id: 'MLB1', requested_quantity: 1 }] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentOrders(555)).rejects.toBeInstanceOf(MercadoLivreValidationError);
  });

  it('getShipmentOrders maps a 500 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'boom' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentOrders(555)).rejects.toMatchObject({
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

describe('createMercadoLivreApi — User-Products stock by location (multiorigem, #706)', () => {
  const STOCK = {
    id: 'MLBU206642488',
    user_id: 1234,
    locations: [
      { type: 'seller_warehouse', network_node_id: 'MXP123451', store_id: '9876543', quantity: 15 },
      { type: 'meli_facility', quantity: 4 },
    ],
  };

  it('getUserProductStock returns the parsed body AND the x-version header', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(STOCK, 200, { 'x-version': '7' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const { stock, version } = await api.getUserProductStock('MLBU206642488');

    // The version is half the answer — a PUT without it is a 400.
    expect(version).toBe('7');
    expect(stock.locations).toHaveLength(2);
    expect(stock.locations?.[0]?.store_id).toBe('9876543');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/user-products/MLBU206642488/stock');
  });

  it('getUserProductStock reports version null when ML omits the header (never treated as "no version needed")', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(STOCK),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const { version } = await api.getUserProductStock('MLBU206642488');
    expect(version).toBeNull();
  });

  it('getUserProductStock keeps an unknown location type as a plain string instead of failing the read', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...STOCK, locations: [{ type: 'some_future_typology', quantity: 1 }] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const { stock } = await api.getUserProductStock('MLBU206642488');
    expect(stock.locations?.[0]?.type).toBe('some_future_typology');
  });

  it('putUserProductSellerWarehouseStock PUTs to /stock/type/seller_warehouse with x-version and the locations body', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(STOCK),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.putUserProductSellerWarehouseStock('MLBU206642488', '7', [
      { store_id: '9876543', network_node_id: 'MXP123451', quantity: 12 },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.mercadolibre.com/user-products/MLBU206642488/stock/type/seller_warehouse',
    );
    expect(init!.method).toBe('PUT');
    expect((init!.headers as Record<string, string>)['x-version']).toBe('7');
    expect(JSON.parse(init!.body as string)).toEqual({
      locations: [{ store_id: '9876543', network_node_id: 'MXP123451', quantity: 12 }],
    });
  });

  it('the WRITE hands back the fresh x-version it earned, so a second write needs no GET', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(STOCK, 200, { 'x-version': '8' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const res = await api.putUserProductSellerWarehouseStock('MLBU206642488', '7', [
      { store_id: '9876543', network_node_id: 'MXP123451', quantity: 12 },
    ]);
    expect(res.version).toBe('8');
    expect(res.stock?.id).toBe('MLBU206642488');
  });

  it('⚠️ a bare-ack write (204 / empty 200) is a SUCCESS, never a validation error', async () => {
    // `parseOk` feeds the schema `null` for an empty body. Parsing this as a
    // bare object would report a write that LANDED as a failure, and the caller
    // would latch the listing with a lastError while ML holds the right number.
    for (const res of [
      new Response(null, { status: 204 }),
      new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]) {
      const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => res.clone());
      const api = createMercadoLivreApi(cfg(fetchMock));
      const out = await api.putUserProductSellerWarehouseStock('MLBU206642488', '7', [
        { store_id: '9876543', network_node_id: 'MXP123451', quantity: 12 },
      ]);
      expect(out.stock).toBeNull();
    }
  });

  it('a stale x-version surfaces as a 409 that isVersionConflict recognises', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'version mismatch' }, 409),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const err = await api
      .putUserProductSellerWarehouseStock('MLBU206642488', '1', [
        { store_id: '9876543', network_node_id: 'MXP123451', quantity: 12 },
      ])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreHttpError);
    expect(isVersionConflict(err)).toBe(true);
    // A conflict must never be mistaken for a rate limit or a reauth.
    expect(isVersionConflict(new MercadoLivreHttpError('rate', 429, null))).toBe(false);
    expect(isVersionConflict(new Error('boom'))).toBe(false);
  });

  it('a missing x-version header on the WRITE is a 400 from ML, mapped like any other HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'Missing X-Version header' }, 400),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(
      api.putUserProductSellerWarehouseStock('MLBU206642488', '', []),
    ).rejects.toMatchObject({ constructor: MercadoLivreHttpError, status: 400 });
  });

  it('⚠️ a malformed order-line `stock` never fails the ORDER IMPORT — it has no readers yet', async () => {
    // Every other field on `orderItemSchema` is load-bearing and rightly fails
    // the parse on a shape we cannot use. This one is documentation until #1177,
    // so `.catch(null)` keeps a surprise from taking down the whole import.
    const parsed = orderSchema.parse({
      id: 1,
      order_items: [
        // ML sends an OBJECT where the array is modelled.
        { item: { id: 'MLB1' }, quantity: 1, stock: { store_id: '1' } },
      ],
    });
    expect(parsed.order_items?.[0]?.stock).toBeNull();
    // …and the line itself survives intact.
    expect(parsed.order_items?.[0]?.item?.id).toBe('MLB1');
  });

  it('models `fulfilled` in all four shapes ML sends, ABSENT included', () => {
    // On a sem-envio order this is the seller's delivery confirmation and the
    // only signal there is — the `delivered` tag is no longer added
    // automatically. It rode `.passthrough()` untyped until #1087, which is
    // exactly why nothing could read it.
    expect(orderSchema.parse({ id: 1, fulfilled: true }).fulfilled).toBe(true);
    // ⚠️ `false` is NOT "not delivered yet" — it is "the sale was not
    // concretized" (ML demands a `reason`, refunds, and reverts `status` to
    // `confirmed`). Modelled distinctly from `null` so a reader cannot conflate
    // "the seller said no" with "the seller has not answered".
    expect(orderSchema.parse({ id: 1, fulfilled: false }).fulfilled).toBe(false);
    expect(orderSchema.parse({ id: 1, fulfilled: null }).fulfilled).toBeNull();
    // ABSENT stays absent rather than defaulting: the sole reader tests
    // `=== true`, so an invented `false` would be a lie about a field that
    // decides a stock movement.
    expect(orderSchema.parse({ id: 1 }).fulfilled).toBeUndefined();
  });

  it('an uninitialised UP answers stock-locations not found, NOT an empty locations array', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'stock-locations not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getUserProductStock('MLBU1')).rejects.toMatchObject({
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

describe('createMercadoLivreApi — shipment labels (etiqueta)', () => {
  const LABEL_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x7f]);

  function labelResponse(bytes: Uint8Array, contentType = 'application/zip'): Response {
    // Uint8Array → ArrayBuffer slice so the Response owns plain bytes.
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }

  it('getShipmentLabels GETs /shipment_labels with shipment_ids + response_type=pdf, the Bearer header, and returns the bytes', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      labelResponse(LABEL_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const result = await api.getShipmentLabels('555', 'pdf');

    expect(Array.from(result.bytes)).toEqual(Array.from(LABEL_BYTES));
    expect(result.contentType).toBe('application/zip');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/shipment_labels');
    expect(String(url)).toContain('shipment_ids=555');
    expect(String(url)).toContain('response_type=pdf');
    // The legacy Dart client sent the token as an `access_token` query param on
    // exactly this endpoint (deprecated by ML) — pin that it never comes back.
    expect(String(url)).not.toContain('access_token');
    expect(init!.method).toBe('GET');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers['User-Agent']).toBe('test-UA');
  });

  it('getShipmentLabels requests response_type=zpl2 for the zpl2 format', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      labelResponse(LABEL_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const result = await api.getShipmentLabels('555', 'zpl2');
    expect(Array.from(result.bytes)).toEqual(Array.from(LABEL_BYTES));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('shipment_ids=555');
    expect(url).toContain('response_type=zpl2');
    expect(url).not.toContain('access_token');
  });

  it('getShipmentLabels maps a 400 failed_shipments body to MercadoLivreLabelUnavailableError with the FULL ML message', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        {
          failed_shipments: [
            { shipment_id: 555, message: 'shipment 555 has substatus invoice_pending' },
          ],
        },
        400,
      ),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    // The caller substring-matches `invoice_pending` on mlMessage (legacy parity).
    await expect(api.getShipmentLabels('555', 'pdf')).rejects.toMatchObject({
      constructor: MercadoLivreLabelUnavailableError,
      mlMessage: 'shipment 555 has substatus invoice_pending',
    });
  });

  it('getShipmentLabels falls through to an HTTP error on a 400 that is NOT the failed_shipments shape', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid shipment id', error: 'bad_request' }, 400),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentLabels('555', 'pdf')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 400,
      body: { message: 'invalid shipment id', error: 'bad_request' },
    });
  });

  it('getShipmentLabels maps a 401 to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentLabels('555', 'pdf')).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });

  it('getShipmentLabels treats an EMPTY 2xx body as an unavailable label (legacy guard)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      labelResponse(new Uint8Array(0)),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getShipmentLabels('555', 'zpl2')).rejects.toMatchObject({
      constructor: MercadoLivreLabelUnavailableError,
      mlMessage: '',
    });
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

  it('searchItemsByUserProduct sends status ONLY when a caller asks for it', async () => {
    // The filter narrows a família to its live members (`resolveAnuncioUrl`), but
    // the existing callers' request shape must stay byte-identical — a `status`
    // that leaked into the publish orphan sweep's search would hide members it
    // decides what to CLOSE from.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ results: ['MLB111'] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.searchItemsByUserProduct(999, ['UPtin1'], { limit: 1, offset: 0, status: 'active' });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('status=active');

    await api.searchItemsByUserProduct(999, ['UPtin1'], { limit: 50, offset: 0 });
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain('status=');
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

/**
 * **#1347 — the failed request has to identify itself.**
 *
 * Mercado Livre answers every unmatched route with the same generic body
 * (`{"error":"resource not found"}` + the developers-site blurb), so
 * `upstream=404 body=…` is byte-identical whichever endpoint produced it. Three
 * such 404s on `/importar` reached Cloud Logging over three days and none of
 * them could be attributed to a call site.
 *
 * ⚠️ The endpoint is threaded from the CALL SITE, never read off `res.url`.
 * `jsonResponse` above builds a bare `new Response(…)`, whose `url` is the empty
 * string — so a `res.url` implementation would record null in every test here
 * while working in production, which is the worst of both worlds.
 */
describe('MercadoLivreHttpError — the failed request identifies itself (#1347)', () => {
  const fail404 = () =>
    vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'resource not found' }, 404),
    );

  it('carries the method and the pathname of the call that failed', async () => {
    const api = createMercadoLivreApi(cfg(fail404()));
    await expect(api.getItem('MLB5146021467')).rejects.toMatchObject({
      endpoint: { method: 'GET', path: '/items/MLB5146021467' },
    });
  });

  it('keeps an allowlisted query key, where the pathname alone names no resource', async () => {
    const api = createMercadoLivreApi(cfg(fail404()));
    // `/users/{id}/shipping_options/free` says nothing about WHICH listing.
    await expect(
      api.getFreeShippingOptions(3616169770, { itemId: 'MLB5146021467' }),
    ).rejects.toMatchObject({
      endpoint: {
        method: 'GET',
        path: '/users/3616169770/shipping_options/free?item_id=MLB5146021467',
      },
    });
  });

  it('⚠️ CONTROL — drops every query key that is not allowlisted', async () => {
    const api = createMercadoLivreApi(cfg(fail404()));
    // `getItem` always sends `?include_attributes=all`; it is not on the list.
    await expect(api.getItem('MLB1')).rejects.toMatchObject({
      endpoint: { path: '/items/MLB1' },
    });
  });

  it('carries the endpoint on a binary download too, not just the JSON path', async () => {
    const api = createMercadoLivreApi(cfg(fail404()));
    await expect(api.getShipmentLabels('555', 'pdf')).rejects.toMatchObject({
      endpoint: { method: 'GET', path: '/shipment_labels?shipment_ids=555' },
    });
  });

  it('⚠️ CONTROL — is null when constructed without a request, so every test double still builds', () => {
    expect(new MercadoLivreHttpError('boom', 500, {}).endpoint).toBeNull();
    expect(new MercadoLivreHttpError('boom', 500, {}, 17).retryAfterSec).toBe(17);
  });
});

describe('sanitizeRequestPath (#1347)', () => {
  const BASE = 'https://api.mercadolibre.com';

  it('⚠️ CONTROL — never lets a credential through, whatever it is called', () => {
    // No call in this package puts a token in the query — the Bearer header
    // carries it — and this is what keeps that true if one ever does.
    const path = sanitizeRequestPath(
      `${BASE}/items/MLB1?access_token=APP_USR-secret&code=authcode&item_id=MLB1`,
    );
    expect(path).toBe('/items/MLB1?item_id=MLB1');
    expect(path).not.toContain('secret');
    expect(path).not.toContain('authcode');
  });

  it('returns null for an unparseable URL rather than falling back to the raw string', () => {
    expect(sanitizeRequestPath('not a url')).toBeNull();
    expect(sanitizeRequestPath('')).toBeNull();
  });

  it('keeps every allowlisted key that is present, in list order', () => {
    expect(sanitizeRequestPath(`${BASE}/items?ids=MLB1,MLB2&item_id=MLB9&attributes=id`)).toBe(
      '/items?item_id=MLB9&ids=MLB1,MLB2',
    );
  });

  it('truncates a path past the cap, so a 20-id multiget cannot flood the log', () => {
    const path = sanitizeRequestPath(`${BASE}/items?ids=${'MLB1234567890,'.repeat(40)}`);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(201); // 200 + the ellipsis
    expect(path!.endsWith('…')).toBe(true);
  });

  it('drops an allowlisted key that is present but empty', () => {
    expect(sanitizeRequestPath(`${BASE}/items/MLB1?item_id=`)).toBe('/items/MLB1');
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

describe('createMercadoLivreApi — listing metadata (#799)', () => {
  it('listSiteCategories reads the tree roots', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ id: 'MLB1430', name: 'Roupas' }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.listSiteCategories()).resolves.toEqual([{ id: 'MLB1430', name: 'Roupas' }]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.mercadolibre.com/sites/MLB/categories',
    );
  });

  it('getCategory surfaces children_categories so callers can test for a leaf', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 'MLB1430',
        name: 'Roupas',
        children_categories: [{ id: 'MLB31447', name: 'Camisetas' }],
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const cat = await api.getCategory('MLB1430');
    expect(cat.children_categories).toEqual([{ id: 'MLB31447', name: 'Camisetas' }]);
  });

  it('getCategoryListingTypes hits the per-CATEGORY endpoint', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ id: 'gold_special', name: 'Clássico', site_id: 'MLB' }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getCategoryListingTypes('MLB31447')).resolves.toEqual([
      { id: 'gold_special', name: 'Clássico', site_id: 'MLB' },
    ]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.mercadolibre.com/categories/MLB31447/listing_types',
    );
  });

  it('getListingPrices sends price + listing type + category', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ listing_type_id: 'gold_special', sale_fee_amount: 12.34, currency_id: 'BRL' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const prices = await api.getListingPrices({
      price: 79.9,
      listingTypeId: 'gold_special',
      categoryId: 'MLB31447',
    });
    expect(prices.sale_fee_amount).toBe(12.34);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/sites/MLB/listing_prices');
    expect(url.searchParams.get('price')).toBe('79.9');
    expect(url.searchParams.get('listing_type_id')).toBe('gold_special');
    expect(url.searchParams.get('category_id')).toBe('MLB31447');
  });

  it('getCategoryAttributes keeps the fields the editor and the AI flow need', async () => {
    // Everything below `tags` plus hierarchy/tooltip/value_max_length used to be
    // dropped on parse, so the filter had nothing to test.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        {
          id: 'BRAND',
          name: 'Marca',
          value_type: 'string',
          hierarchy: 'FAMILY',
          relevance: 1,
          tooltip: 'A marca',
          hint: 'Ex.: Acme',
          value_max_length: 60,
          default_unit: 'cm',
          allowed_units: [{ id: 'cm', name: 'centímetro' }],
          attribute_group_id: 'MAIN',
          attribute_group_name: 'Principais',
          tags: { required: true },
        },
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const [attr] = await api.getCategoryAttributes('MLB31447');
    expect(attr).toMatchObject({
      hierarchy: 'FAMILY',
      relevance: 1,
      tooltip: 'A marca',
      hint: 'Ex.: Acme',
      value_max_length: 60,
      default_unit: 'cm',
      allowed_units: [{ id: 'cm', name: 'centímetro' }],
      attribute_group_id: 'MAIN',
      attribute_group_name: 'Principais',
      tags: { required: true },
    });
  });

  it('accepts tags as an ARRAY, which some categories send', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([{ id: 'BRAND', value_type: 'string', tags: ['required', 'hidden'] }]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const [attr] = await api.getCategoryAttributes('MLB31447');
    expect(attr!.tags).toEqual(['required', 'hidden']);
  });
});

/* -------------------------------------------------------------------------- */
/*                        criarUsuarioTeste — #1085                           */
/* -------------------------------------------------------------------------- */

describe('criarUsuarioTeste', () => {
  const MINTED = {
    id: 120506781,
    nickname: 'TEST0548',
    password: 'qatest328',
    site_status: 'active',
  };

  it('POSTs /users/test_user with the site_id in the body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MINTED));
    const api = createMercadoLivreApi(cfg(fetchMock));

    const user = await api.criarUsuarioTeste('MLB');

    expect(user).toMatchObject(MINTED);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/users/test_user');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ site_id: 'MLB' });
  });

  it('rejects a blank password instead of persisting an unusable credential', async () => {
    // ML never reissues one, so a blank password that parses "successfully"
    // would be stored and would have burned one of ten permanent slots.
    const fetchMock = vi.fn(async () => jsonResponse({ ...MINTED, password: '' }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.criarUsuarioTeste('MLB')).rejects.toBeInstanceOf(MercadoLivreValidationError);
  });

  it('reports FIELD NAMES only on a shape mismatch', async () => {
    // Note what this does and does not claim. Zod 4 was measured: its serialized
    // issues carry no input value for a wrong type, a missing key, a too_small
    // or a non-object root, and `.passthrough()` stops `unrecognized_keys`
    // firing — so passing `issues` here would not leak today. This asserts the
    // narrower, stable contract instead: the error names the drifted field and
    // nothing else, so a future change to Zod's issue payload cannot widen it.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ...MINTED, id: 'not-a-number', password: 'sup3r-s3cr3t' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const err = await api.criarUsuarioTeste('MLB').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreValidationError);
    expect((err as MercadoLivreValidationError).issues).toEqual(['id']);
    expect((err as Error).message).toContain('id');
  });

  it('never puts the body into the error raised by a NON-JSON response', async () => {
    // ⚠️ THE leak vector, and the reason this endpoint bypasses `parseOk`: that
    // helper passes the raw body straight into the error. An ML error page — or
    // a 200 whose body drifts — would carry a password ML never reissues into
    // whatever logs the throw (#1015).
    const secret = 'qatest-leaked-999';
    const fetchMock = vi.fn(async () => new Response(`<html>${secret}</html>`, { status: 200 }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    const err = await api.criarUsuarioTeste('MLB').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreValidationError);
    const dump = JSON.stringify({
      message: (err as Error).message,
      issues: (err as MercadoLivreValidationError).issues,
    });
    expect(dump).not.toContain(secret);
  });

  it('maps a failed mint through the shared HTTP error path', async () => {
    // A FAILED mint carries no password, so the normal error mapping applies —
    // and losing ML's reason (e.g. the 10-user cap) would be the worse trade.
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'max test users reached' }, 400));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.criarUsuarioTeste('MLB')).rejects.toBeInstanceOf(MercadoLivreHttpError);
  });
});

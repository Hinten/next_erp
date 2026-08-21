import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError, MercadoLivreReauthRequiredError } from '../src/errors';
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

/** The verbatim legacy claim payload (models.dart:3762-3825) — the canonical fixture. */
const LEGACY_CLAIM = {
  id: 5142940410,
  type: 'returns',
  stage: 'claim',
  status: 'closed',
  parent_id: null,
  client_id: 3728194611110859,
  resource_id: 2000004048276990,
  resource: 'order',
  reason_id: 'PDD9545',
  fulfilled: true,
  players: [
    { role: 'complainant', type: 'buyer', user_id: 301110805, available_actions: [] },
    {
      role: 'respondent',
      type: 'seller',
      user_id: 397242111,
      available_actions: [
        { action: 'recontact', due_date: '2022-10-06T22:33:59.000-04:00', mandatory: false },
      ],
    },
  ],
  resolution: {
    reason: 'item_returned',
    benefited: ['complainant'],
    date_created: '2022-08-24T16:10:18.000-04:00',
    closed_by: 'mediator',
  },
  labels: [
    {
      name: 'reason_flow',
      value: 'unification_delivered',
      comments: '[reasonId: PDD9545]',
      admin_id: 'internal',
      date_created: '2022-08-23T20:09:16.000-04:00',
    },
    {
      name: 'reputation',
      value: 'avoid',
      comments: 'general',
      admin_id: 'reputation',
      date_created: '2022-08-23T20:09:19.000-04:00',
    },
    {
      name: 'return_label',
      value: 'free',
      comments: "Didn't charge seller for return label cost",
      admin_id: 'coverages-charges',
      date_created: '2022-08-24T16:10:18.000-04:00',
    },
  ],
  site_id: 'MLB',
  date_created: '2022-08-23T20:09:16.000-04:00',
  last_updated: '2022-08-24T16:10:26.000-04:00',
};

describe('createMercadoLivreApi — claims (claims import, Step 14)', () => {
  it('getClaim hits /post-purchase/v1/claims/{id} with the Bearer token and parses the legacy sample', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(LEGACY_CLAIM),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const claim = await api.getClaim(5142940410);

    expect(claim.id).toBe(5142940410);
    expect(claim.type).toBe('returns');
    expect(claim.stage).toBe('claim');
    expect(claim.status).toBe('closed');
    expect(claim.resource).toBe('order');
    expect(claim.resource_id).toBe(2000004048276990);
    expect(claim.reason_id).toBe('PDD9545');
    expect(claim.players).toHaveLength(2);
    expect(claim.players[0]!.role).toBe('complainant');
    expect(claim.players[0]!.user_id).toBe(301110805);
    expect(claim.resolution?.reason).toBe('item_returned');
    expect(claim.resolution?.closed_by).toBe('mediator');
    // `decision` is absent on the sample — tolerated as null.
    expect(claim.resolution?.decision).toBeNull();
    expect(claim.last_updated).toBe('2022-08-24T16:10:26.000-04:00');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/post-purchase/v1/claims/5142940410');
    expect(init!.method).toBe('GET');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
    expect((init!.headers as Record<string, string>)['User-Agent']).toBe('test-UA');
  });

  it('getClaim tolerates unknown vocabulary (type change, stage stale) and unknown keys at every level', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        ...LEGACY_CLAIM,
        // The legacy Dart enums THREW on these — the port must not.
        type: 'change',
        stage: 'stale',
        status: 'brand_new_status',
        claim_version: 2,
        related_entities: ['mediations'],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const claim = await api.getClaim(1);
    expect(claim.type).toBe('change');
    expect(claim.stage).toBe('stale');
    expect(claim.status).toBe('brand_new_status');
    const raw = claim as Record<string, unknown>;
    expect(raw.claim_version).toBe(2);
    expect(raw.related_entities).toEqual(['mediations']);
    expect(raw.fulfilled).toBe(true);
    // players[].available_actions ride through the player passthrough untyped.
    expect((claim.players[1] as Record<string, unknown>).available_actions).toEqual([
      { action: 'recontact', due_date: '2022-10-06T22:33:59.000-04:00', mandatory: false },
    ]);
  });

  it('getClaim tolerates a null resolution and a missing last_updated (both → null)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 1,
        type: 'mediations',
        stage: 'dispute',
        status: 'opened',
        resource_id: 2000004048276990,
        resource: 'order',
        reason_id: 'PDD9545',
        players: [],
        resolution: null,
        date_created: '2022-08-23T20:09:16.000-04:00',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const claim = await api.getClaim(1);
    expect(claim.resolution).toBeNull();
    expect(claim.last_updated).toBeNull();
  });

  it('getClaim maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'claim not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.getClaim(404404)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('getClaimMessages hits /post-purchase/v1/claims/{id}/messages and parses the BARE ARRAY response', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse([
        {
          sender_role: 'complainant',
          receiver_role: 'respondent',
          stage: 'claim',
          message: 'Produto veio errado',
          date_created: '2022-08-23T20:10:00.000-04:00',
          attachments: [
            {
              filename: 'fa8d559e_301110805.jpg',
              original_filename: 'foto.jpg',
              size: 1234,
              type: 'image/jpeg',
              date_created: '2022-08-23T20:10:00.000-04:00',
            },
          ],
        },
        {
          sender_role: 'mediator',
          receiver_role: 'respondent',
          stage: 'dispute',
          date_created: '2022-08-24T10:00:00.000-04:00',
          attachments: null,
          a_new_ml_field: true,
        },
      ]),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const messages = await api.getClaimMessages(5142940410);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.message).toBe('Produto veio errado');
    expect(messages[0]!.attachments[0]!.filename).toBe('fa8d559e_301110805.jpg');
    // A missing `message` defaults to '' and a null `attachments` normalizes to [].
    expect(messages[1]!.message).toBe('');
    expect(messages[1]!.attachments).toEqual([]);
    expect((messages[1] as Record<string, unknown>).a_new_ml_field).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/post-purchase/v1/claims/5142940410/messages');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
  });

  it('getClaimReason hits /post-purchase/v1/claims/reasons/{id} with the Bearer HEADER and parses detail/name', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        id: 'PDD9545',
        detail: 'O produto chegou danificado',
        name: 'Produto danificado',
        date_created: '2022-08-23T20:09:16.000-04:00',
        last_updated: '2022-08-23T20:09:16.000-04:00',
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const reason = await api.getClaimReason('PDD9545');
    expect(reason.detail).toBe('O produto chegou danificado');
    expect(reason.name).toBe('Produto danificado');
    const [url, init] = fetchMock.mock.calls[0]!;
    // The legacy client needed a token-in-header special case for exactly this
    // endpoint (api.dart:1501) — request() always sends the Bearer header.
    expect(url).toBe('https://api.mercadolibre.com/post-purchase/v1/claims/reasons/PDD9545');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
    expect(String(url)).not.toContain('access_token');
  });

  it('getClaimReason tolerates missing detail AND name (both → null)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 'PDD9545' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const reason = await api.getClaimReason('PDD9545');
    expect(reason.detail).toBeNull();
    expect(reason.name).toBeNull();
  });

  it('searchClaims sends ONLY the provided query params', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ paging: { total: 1, offset: 0, limit: 30 }, data: [LEGACY_CLAIM] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = await api.searchClaims({ status: 'opened', limit: 30, offset: 0 });

    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.id).toBe(5142940410);
    expect(page.paging.total).toBe(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/post-purchase/v1/claims/search');
    expect(url.searchParams.get('status')).toBe('opened');
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('stage')).toBe(false);
  });

  it('searchClaims forwards stage when provided', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ paging: { total: 0, offset: 0, limit: 30 }, data: [] }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.searchClaims({ stage: 'dispute', status: 'opened' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('stage')).toBe('dispute');
    expect(url.searchParams.get('status')).toBe('opened');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('searchClaims accepts a degenerate response with paging AND data missing (defaults)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    const page = await api.searchClaims({ status: 'opened' });
    expect(page.data).toEqual([]);
    expect(page.paging.total).toBeUndefined();
  });
});

describe('createMercadoLivreApi — claim attachment download (Step 14)', () => {
  const FILE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  function bytesResponse(bytes: Uint8Array, contentType = 'image/jpeg'): Response {
    // Uint8Array → ArrayBuffer slice so the Response owns plain bytes.
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  }

  it('downloadClaimAttachment GETs the download URL with the Bearer header and returns bytes + contentType', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      bytesResponse(FILE_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const result = await api.downloadClaimAttachment(5142940410, 'fa8d559e_301110805.jpg');

    expect(Array.from(result.bytes)).toEqual(Array.from(FILE_BYTES));
    expect(result.contentType).toBe('image/jpeg');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.mercadolibre.com/post-purchase/v1/claims/5142940410/attachments/fa8d559e_301110805.jpg/download',
    );
    // The token rides the Bearer header — NEVER the legacy access_token query param.
    expect(String(url)).not.toContain('access_token');
    expect(init!.method).toBe('GET');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers['User-Agent']).toBe('test-UA');
  });

  // ── post-sale message attachments (#1162) ─────────────────────────────────
  //
  // ⚠️ These exist because the shape below is NOT symmetric with the claims
  // endpoint above, and nothing else in the repo compares it against a real
  // request — every importer test mocks `downloadPostSaleAttachment` away. With
  // the URL unpinned, renaming `site_id` to `siteId` (the spelling the
  // neighbouring `getShipmentInvoiceData`/`listSiteCategories` call sites use,
  // so a plausible slip) left the whole package suite green, while in production
  // ML answers the documented `400 Invalid site_id` → classified deterministic →
  // EVERY post-sale attachment silently skipped, forever, with only a warn.
  // `buildUrl` takes an arbitrary key/value record, so typecheck cannot see it
  // either.

  it('downloadPostSaleAttachment sends tag=post_sale AND the REQUIRED site_id', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      bytesResponse(FILE_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));
    const result = await api.downloadPostSaleAttachment(
      '415460047_a96d8dea-38cd-4402-938e-80a1c134fc5d.jpg',
    );

    expect(Array.from(result.bytes)).toEqual(Array.from(FILE_BYTES));
    expect(result.contentType).toBe('image/jpeg');

    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      'https://api.mercadolibre.com/messages/attachments/415460047_a96d8dea-38cd-4402-938e-80a1c134fc5d.jpg',
    );
    // Asserted by NAME, not by substring: `siteId` would still "contain MLB".
    expect(parsed.searchParams.get('site_id')).toBe('MLB');
    expect(parsed.searchParams.get('tag')).toBe('post_sale');
    // ...and the camelCase spelling must NOT be what we send.
    expect(parsed.searchParams.has('siteId')).toBe(false);

    expect(String(url)).not.toContain('access_token');
    expect(init!.method).toBe('GET');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers['User-Agent']).toBe('test-UA');
  });

  it('downloadPostSaleAttachment percent-encodes the attachment id', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      bytesResponse(FILE_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.downloadPostSaleAttachment('foto do defeito #2.jpg');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/messages/attachments/foto%20do%20defeito%20%232.jpg');
  });

  it('downloadPostSaleAttachment maps a 500 to an HTTP error — ML has NO 404 here', async () => {
    // The documented error table for this route lists only 400 and 500, so a
    // permanently missing file arrives as a 500. It must surface as a
    // `MercadoLivreHttpError` (deterministic → skip), never as a network error,
    // or the Cloud Tasks retry loops forever on a file ML will not serve.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'File can not be saved, try it later' }, 500),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.downloadPostSaleAttachment('x.jpg')).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('downloadPostSaleAttachment throws a 2xx-carrying error on an empty body', async () => {
    // The shared `downloadAnexo` guard: a 2xx with no bytes is thrown carrying
    // the 2xx status, so the caller can tell "empty body" from a real refusal
    // instead of being handed a zero-byte file to upload.
    const fetchMock = vi.fn(
      async (_u: string | URL | Request, _i?: RequestInit) =>
        new Response(new ArrayBuffer(0), { status: 200 }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.downloadPostSaleAttachment('x.jpg')).rejects.toMatchObject({
      status: 200,
    });
  });

  it('downloadClaimAttachment percent-encodes the filename', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      bytesResponse(FILE_BYTES),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await api.downloadClaimAttachment(1, 'foto do defeito #2.jpg');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/attachments/foto%20do%20defeito%20%232.jpg/download');
  });

  it('downloadClaimAttachment maps a 401 to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.downloadClaimAttachment(1, 'x.jpg')).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });

  it('downloadClaimAttachment maps a 404 to an HTTP error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'attachment not found' }, 404),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.downloadClaimAttachment(1, 'gone.jpg')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 404,
    });
  });

  it('downloadClaimAttachment treats an EMPTY 2xx body as an error carrying the 2xx status', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      bytesResponse(new Uint8Array(0)),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));
    await expect(api.downloadClaimAttachment(1, 'vazio.jpg')).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 200,
    });
  });
});

describe('createMercadoLivreApi — claim RESOLUTION (#768, previously untested)', () => {
  /**
   * ⚠️ These five endpoints shipped with no API-level coverage at all. They are
   * the ones that move money, so a silent URL or body-key drift here is the most
   * expensive kind this client can have.
   */
  const RESOLUCOES = [
    {
      player_role: 'complainant',
      user_id: 1,
      expected_resolution: 'return_product',
      status: 'rejected',
    },
    { player_role: 'respondent', user_id: 2, expected_resolution: 'refund', status: 'accepted' },
  ];

  function apiWith(body: unknown, status = 200) {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(body, status),
    );
    return { api: createMercadoLivreApi(cfg(fetchMock)), fetchMock };
  }

  it('refundClaim POSTs to expected-resolutions/refund and parses the array', async () => {
    const { api, fetchMock } = apiWith(RESOLUCOES);
    const out = await api.refundClaim(5204934310);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      '/post-purchase/v1/claims/5204934310/expected-resolutions/refund',
    );
    expect(init!.method).toBe('POST');
    expect(out).toHaveLength(2);
    expect(out[1]!.expected_resolution).toBe('refund');
  });

  it('allowClaimReturn POSTs to expected-resolutions/allow-return', async () => {
    const { api, fetchMock } = apiWith(RESOLUCOES);
    await api.allowClaimReturn(5204934310);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      '/post-purchase/v1/claims/5204934310/expected-resolutions/allow-return',
    );
    expect(init!.method).toBe('POST');
  });

  it('openClaimDispute POSTs to actions/open-dispute and parses the refreshed CLAIM', async () => {
    // ⚠️ The one resolution verb whose response is a claim, not a resolution
    // array — it is how the caller learns the new stage.
    const { api, fetchMock } = apiWith({ ...LEGACY_CLAIM, stage: 'dispute', status: 'opened' });
    const out = await api.openClaimDispute(5204934310);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/post-purchase/v1/claims/5204934310/actions/open-dispute');
    expect(init!.method).toBe('POST');
    expect(out.stage).toBe('dispute');
  });

  it('getClaimExpectedResolutions GETs the read-side list', async () => {
    const { api, fetchMock } = apiWith(RESOLUCOES);
    const out = await api.getClaimExpectedResolutions(5204934310);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/post-purchase/v1/claims/5204934310/expected-resolutions');
    expect(init!.method).toBe('GET');
    expect(out[0]!.status).toBe('rejected');
  });

  it('partialRefundClaim sends the percentage under the key `percentage`', async () => {
    // ⚠️⚠️ THE assertion in this file. ML DEFAULTS A MISSING PERCENTAGE TO 50%.
    // So a typo in this body key is not an error the caller ever sees — it is a
    // silent half refund on every partial, forever. Asserting the key BY NAME is
    // the only thing that catches it; a `toBeDefined()` or an untyped
    // deep-equality on a `.passthrough()` response would not.
    const { api, fetchMock } = apiWith(RESOLUCOES);
    await api.partialRefundClaim(5204934310, 40);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      '/post-purchase/v1/claims/5204934310/expected-resolutions/partial-refund',
    );
    expect(init!.method).toBe('POST');

    const enviado = JSON.parse(String(init!.body)) as Record<string, unknown>;
    expect(Object.keys(enviado)).toEqual(['percentage']);
    expect(enviado.percentage).toBe(40);
  });

  it('getClaimPartialRefundOffers parses offers AND the typed recommendations/restrictions', async () => {
    // ⚠️ `recommendations`/`restrictions` rode `.passthrough()` untyped until the
    // resolution UI needed them. Reading them through the TYPED accessors is the
    // point: a whole-object `toEqual` would pass on passthrough alone and prove
    // nothing about the schema.
    const { api, fetchMock } = apiWith({
      currency_id: 'BRL',
      available_offers: [
        { amount: 268.2, percentage: 90 },
        { amount: 149, percentage: 50 },
      ],
      recommendations: [
        { percentage: 40, reason: 'PARTIAL_REFUND_BETTER_THAN_RETURN', type: 'maximum' },
      ],
      restrictions: [{ percentage: 30, reason: 'PAREX_REJECTED', type: 'minimum' }],
    });
    const out = await api.getClaimPartialRefundOffers(5204934310);

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/post-purchase/v1/claims/5204934310/partial-refund/available-offers',
    );
    expect(out.currency_id).toBe('BRL');
    expect(out.available_offers.map((o) => o.percentage)).toEqual([90, 50]);
    expect(out.recommendations[0]!.type).toBe('maximum');
    expect(out.recommendations[0]!.percentage).toBe(40);
    expect(out.restrictions[0]!.type).toBe('minimum');
    expect(out.restrictions[0]!.reason).toBe('PAREX_REJECTED');
  });

  it('getClaimPartialRefundOffers defaults recommendations/restrictions to [] when absent', async () => {
    // ML's older shape omits both. They must not arrive `undefined` — the picker
    // maps over them, and an unguarded map is a crash on the money screen.
    const { api } = apiWith({
      currency_id: 'BRL',
      available_offers: [{ amount: 10, percentage: 10 }],
    });
    const out = await api.getClaimPartialRefundOffers(5204934310);

    expect(out.recommendations).toEqual([]);
    expect(out.restrictions).toEqual([]);
  });

  it('getClaimPartialRefundOffers maps ML 422 (claim not eligible) to an HTTP error', async () => {
    // Documented for this route: 422 = not eligible (CBT, no return label). It
    // must stay distinguishable from a transport failure so the UI can say why.
    const { api } = apiWith({ message: 'not eligible' }, 422);
    await expect(api.getClaimPartialRefundOffers(5204934310)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });
});

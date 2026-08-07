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

import { describe, it, expect, vi } from 'vitest';
import { createMercadoLivreChannel, MercadoLivreNotConfiguredError } from '../src/index';
import type { ChannelContext } from '@delfrance/core/plugins';

const channel = createMercadoLivreChannel({
  clientId: 'CID',
  clientSecretEnvVar: 'ML_SECRET',
  redirectUri: 'https://app.test/oauth/mercado-livre/callback',
});

const ctx: ChannelContext = { integracaoId: 'i1', accessToken: 'live-token', account: {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchMock = ReturnType<typeof vi.fn>;

function channelWithFetch(fetchMock: FetchMock) {
  return createMercadoLivreChannel({
    clientId: 'CID',
    clientSecretEnvVar: 'ML_SECRET',
    redirectUri: 'https://app.test/oauth/mercado-livre/callback',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  });
}

describe('createMercadoLivreChannel scaffold (extended #288 contract)', () => {
  it('exposes the channel id', () => {
    expect(channel.id).toBe('mercado-livre');
  });

  // Not "not built yet": these four need Firestore, so the live implementation
  // is the apps/mercado-livre backend and the contract members stay stubs (#815).
  it('the four Firestore-bound contract members reject with NotConfigured', async () => {
    await expect(channel.syncProducts(ctx)).rejects.toBeInstanceOf(MercadoLivreNotConfiguredError);
    await expect(channel.pullOrders(ctx)).rejects.toBeInstanceOf(MercadoLivreNotConfiguredError);
    await expect(channel.pushTracking(ctx, 'order-1', 'BR123')).rejects.toBeInstanceOf(
      MercadoLivreNotConfiguredError,
    );
    await expect(channel.oauthFlow.callback('code', 'state')).rejects.toBeInstanceOf(
      MercadoLivreNotConfiguredError,
    );
  });

  it('optional capabilities are absent on the scaffold (callers feature-detect)', () => {
    expect(channel.pushPrice).toBeUndefined();
    expect(channel.pushStock).toBeUndefined();
    expect(channel.importOrders).toBeUndefined();
    expect(channel.getOrderCharges).toBeUndefined();
    expect(channel.getOrderFiscalIdentity).toBeUndefined();
    expect(channel.fetchLabel).toBeUndefined();
  });

  it('exposes the incident READ **and** WRITE surface (#768 completed the contract)', () => {
    // ⚠️ This test used to assert `respondIncident` was UNDEFINED — Step 14 was
    // import-only. It is the whole point of #768 that it now exists, so the
    // assertion inverts rather than being deleted: callers feature-detect on
    // exactly this, and losing the member again must fail here.
    expect(typeof channel.importIncidents).toBe('function');
    expect(typeof channel.getIncident).toBe('function');
    expect(typeof channel.respondIncident).toBe('function');
  });

  it('oauthFlow.start builds a consent URL carrying state, client_id and redirect_uri', () => {
    const url = new URL(channel.oauthFlow.start('xyz-state'));
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/oauth/mercado-livre/callback',
    );
  });
});

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

const CLAIM_MESSAGES = [
  {
    sender_role: 'complainant',
    receiver_role: 'respondent',
    stage: 'claim',
    message: 'Produto veio errado',
    date_created: '2022-08-23T20:10:00.000-04:00',
    attachments: [{ filename: 'fa8d559e_301110805.jpg', original_filename: 'foto.jpg' }],
  },
  {
    sender_role: 'respondent',
    receiver_role: 'complainant',
    stage: 'claim',
    message: 'Vamos resolver',
    date_created: '2022-08-23T21:00:00.000-04:00',
    attachments: [],
  },
  {
    sender_role: 'mediator',
    receiver_role: 'respondent',
    stage: 'dispute',
    message: 'Mediação iniciada',
    date_created: '2022-08-24T10:00:00.000-04:00',
    attachments: [],
  },
];

const CLAIM_REASON = {
  id: 'PDD9545',
  detail: 'O produto chegou danificado',
  name: 'Produto danificado',
  date_created: '2022-08-23T20:09:16.000-04:00',
  last_updated: '2022-08-23T20:09:16.000-04:00',
};

/** Serves getClaim / getClaimMessages / getClaimReason off one claim fixture. */
function claimFetchMock(over: { reason?: () => Response } = {}): FetchMock {
  return vi.fn(async (u: string | URL | Request, _i?: RequestInit) => {
    const url = String(u);
    if (url.includes('/claims/reasons/')) return over.reason?.() ?? jsonResponse(CLAIM_REASON);
    if (url.includes('/messages')) return jsonResponse(CLAIM_MESSAGES);
    return jsonResponse(LEGACY_CLAIM);
  });
}

describe('createMercadoLivreChannel — getIncident (claims import, Step 14)', () => {
  it('hydrates the legacy sample into an ImportedIncident (kind, order key, reason, messages, channelSpecific)', async () => {
    const fetchMock = claimFetchMock();
    const withApi = channelWithFetch(fetchMock);
    const incident = await withApi.getIncident!(ctx, '5142940410');

    expect(incident.externalId).toBe('5142940410');
    expect(incident.kind).toBe('return'); // type 'returns'
    expect(incident.orderExternalId).toBe('2000004048276990');
    expect(incident.status).toBe('closed');
    expect(incident.reason).toBe('O produto chegou danificado'); // detail beats name
    expect(incident.openedMs).toBe(Date.parse('2022-08-23T20:09:16.000-04:00'));
    expect(incident.lastUpdatedMs).toBe(Date.parse('2022-08-24T16:10:26.000-04:00'));

    // Messages: complainant→buyer, respondent→seller, mediator→marketplace.
    expect(incident.messages).toHaveLength(3);
    expect(incident.messages![0]).toEqual({
      author: 'buyer',
      text: 'Produto veio errado',
      attachments: ['fa8d559e_301110805.jpg'],
      timestampMs: Date.parse('2022-08-23T20:10:00.000-04:00'),
    });
    expect(incident.messages![1]!.author).toBe('seller');
    expect(incident.messages![1]!.attachments).toBeUndefined(); // empty list omitted
    expect(incident.messages![2]!.author).toBe('marketplace');

    // channelSpecific carries the raw discriminators + the FULL resolution
    // (passthrough — `benefited` is untyped but must survive).
    expect(incident.channelSpecific).toMatchObject({
      stage: 'claim',
      resource: 'order',
      resource_id: 2000004048276990,
      reason_id: 'PDD9545',
    });
    expect(incident.channelSpecific!.resolution).toMatchObject({
      reason: 'item_returned',
      closed_by: 'mediator',
      benefited: ['complainant'],
    });
    const players = incident.channelSpecific!.players as Array<Record<string, unknown>>;
    expect(players).toHaveLength(2);
    expect(players[0]!.role).toBe('complainant');

    // Three calls: claim, messages, reason — all against the pinned paths.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      'https://api.mercadolibre.com/post-purchase/v1/claims/5142940410',
      'https://api.mercadolibre.com/post-purchase/v1/claims/5142940410/messages',
      'https://api.mercadolibre.com/post-purchase/v1/claims/reasons/PDD9545',
    ]);
  });

  it('degrades to no reason on an HTTP failure of the reason endpoint (best-effort + warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchMock = claimFetchMock({
        reason: () => jsonResponse({ message: 'not found' }, 404),
      });
      const withApi = channelWithFetch(fetchMock);
      const incident = await withApi.getIncident!(ctx, '5142940410');
      expect(incident.reason).toBeUndefined();
      expect(incident.messages).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

function searchClaim(id: number, lastUpdated: string) {
  return {
    ...LEGACY_CLAIM,
    id,
    type: 'mediations',
    status: 'opened',
    last_updated: lastUpdated,
  };
}

describe('createMercadoLivreChannel — importIncidents (claims import, Step 14)', () => {
  it('pages the opened-claims search: nextCursor advances by page length until paging.total is consumed', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          paging: { total: 3, offset: 0, limit: 30 },
          data: [
            searchClaim(1, '2026-07-02T00:00:00.000-04:00'),
            searchClaim(2, '2026-07-03T00:00:00.000-04:00'),
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          paging: { total: 3, offset: 2, limit: 30 },
          data: [searchClaim(3, '2026-07-04T00:00:00.000-04:00')],
        }),
      );
    const withApi = channelWithFetch(fetchMock);

    const page1 = await withApi.importIncidents!(ctx);
    expect(page1.items.map((i) => i.externalId)).toEqual(['1', '2']);
    expect(page1.items[0]!.kind).toBe('mediation');
    // Search items are bare — no messages/reason (hydrate via getIncident).
    expect(page1.items[0]!.messages).toBeUndefined();
    expect(page1.items[0]!.reason).toBeUndefined();
    expect(page1.nextCursor).toEqual({ token: '2' });
    const url1 = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url1.pathname).toBe('/post-purchase/v1/claims/search');
    expect(url1.searchParams.get('status')).toBe('opened');
    expect(url1.searchParams.get('limit')).toBe('30');
    expect(url1.searchParams.get('offset')).toBe('0');

    const page2 = await withApi.importIncidents!(ctx, page1.nextCursor);
    expect(page2.items.map((i) => i.externalId)).toEqual(['3']);
    expect(page2.nextCursor).toBeUndefined(); // 2 + 1 == total 3
    const url2 = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(url2.searchParams.get('offset')).toBe('2');
  });

  it('filters on cursor.sinceMs CLIENT-SIDE while the page math still advances by the raw page length', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        paging: { total: 2, offset: 0, limit: 30 },
        data: [
          searchClaim(1, '2026-07-01T00:00:00.000-04:00'), // stale
          searchClaim(2, '2026-07-10T00:00:00.000-04:00'), // fresh
        ],
      }),
    );
    const withApi = channelWithFetch(fetchMock);
    const sinceMs = Date.parse('2026-07-05T00:00:00.000-04:00');

    const page = await withApi.importIncidents!(ctx, { sinceMs });
    expect(page.items.map((i) => i.externalId)).toEqual(['2']);
    expect(page.nextCursor).toBeUndefined(); // 0 + 2 == total 2, filter aside
  });
});

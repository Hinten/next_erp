import { describe, expect, it, vi } from 'vitest';
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
    retryDelayMs: () => 0,
    ...over,
  };
}

/** The pack response ML's "Gestão de mensagens" reference documents. */
const PACK = {
  paging: { limit: 10, offset: 0, total: 3 },
  conversation_status: {
    path: '/packs/2000000089077943/seller/415458330',
    status: 'active',
    substatus: null,
    status_date: '2026-02-05T20:01:46.000Z',
    status_update_allowed: false,
    claim_id: null,
    shipping_id: null,
  },
  messages: [
    {
      id: 'fd1d2e37ad004ede9e0bf25d1215002d',
      site_id: 'MLB',
      from: { user_id: 3037675074 },
      to: { user_id: 2332423234 },
      status: 'available',
      text: 'Mensagem de teste',
      message_date: {
        received: '2026-02-05T20:01:46.000Z',
        available: '2026-02-05T20:01:46.000Z',
        notified: '2026-02-05T20:01:46.000Z',
        created: '2026-02-05T20:01:46.000Z',
        read: null,
      },
      message_moderation: { status: 'clean', reason: null },
      message_attachments: null,
      message_resources: [
        { id: '000011122344', name: 'packs' },
        { id: '475684066', name: 'sellers' },
      ],
      conversation_first_message: false,
    },
  ],
  seller_max_message_length: 350,
  buyer_max_message_length: 3500,
};

describe('getPackMessages', () => {
  it('reads the pack thread WITHOUT marking it read', async () => {
    // ⚠️ The plain GET marks the thread read as a side effect. An importer must
    // not clear the seller's unread state — ML surfaces unread counts they rely on.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PACK),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getPackMessages('2000000089077943', '415458330');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.mercadolibre.com/messages/packs/2000000089077943/sellers/415458330' +
        '?tag=post_sale&mark_as_read=false',
    );
  });

  it('surfaces conversation_status and the LIVE seller cap', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PACK),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.getPackMessages('1', '2');
    expect(r.conversation_status).toMatchObject({ status: 'active', substatus: null });
    // Not a constant: ML returns it per thread, which is why nothing hardcodes 350.
    expect(r.seller_max_message_length).toBe(350);
  });

  it('parses a BLOCKED conversation with its substatus', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        ...PACK,
        conversation_status: {
          path: '/packs/22175467/sellers/32086568493',
          status: 'blocked',
          substatus: 'blocked_by_buyer',
          // ⚠️ ML spells this `claim_ids` here and `claim_id` on the other
          // reference page. Both ride passthrough; nothing reads them.
          claim_ids: null,
        },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.getPackMessages('1', '2');
    expect(r.conversation_status).toMatchObject({
      status: 'blocked',
      substatus: 'blocked_by_buyer',
    });
  });

  it('tolerates a substatus ML has not documented yet', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        ...PACK,
        conversation_status: { status: 'blocked', substatus: 'blocked_by_algo_novo' },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getPackMessages('1', '2')).resolves.toMatchObject({
      conversation_status: { substatus: 'blocked_by_algo_novo' },
    });
  });

  it('accepts a user_id as a number OR a string — ML prints both', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        ...PACK,
        messages: [
          { ...PACK.messages[0], from: { user_id: '415458330' }, to: { user_id: 2332423234 } },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.getPackMessages('1', '2');
    expect(r.messages[0]!.from?.user_id).toBe('415458330');
  });

  it('normalizes a null message_attachments to an empty array', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(PACK),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.getPackMessages('1', '2');
    expect(r.messages[0]!.message_attachments).toEqual([]);
  });
});

describe('getMessage', () => {
  it('reads one message by id, also without marking it read', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ paging: null, conversation_status: null, messages: PACK.messages }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.getMessage('fd1d2e37ad004ede9e0bf25d1215002d');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.mercadolibre.com/messages/fd1d2e37ad004ede9e0bf25d1215002d' +
        '?tag=post_sale&mark_as_read=false',
    );
    // The by-id form answers with NO conversation_status — which is exactly why
    // the importer needs the pack call to decide actionability.
    expect(r.conversation_status).toBeNull();
    expect(r.messages[0]!.message_resources).toEqual([
      { id: '000011122344', name: 'packs' },
      { id: '475684066', name: 'sellers' },
    ]);
  });
});

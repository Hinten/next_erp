import { describe, expect, it, vi } from 'vitest';
import { type MercadoLivreApiConfig, createMercadoLivreApi } from '../src/api';
import { ML_POST_SALE_AGENT_USER_ID, postSaleAgentUserId } from '../src/types';

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

describe('sendPackMessage', () => {
  function sendMock() {
    return vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonResponse({}, 200));
  }
  function bodyOf(fetchMock: FetchMock): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('posts to the pack/seller URL with tag=post_sale', async () => {
    const fetchMock = sendMock();
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.sendPackMessage('2000000089077943', '415458330', {
      text: 'Enviado hoje!',
      toUserId: ML_POST_SALE_AGENT_USER_ID.MLB,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.mercadolibre.com/messages/packs/2000000089077943/sellers/415458330?tag=post_sale',
    );
    expect((init as RequestInit).method).toBe('POST');
  });

  it('addresses the AGENT and sends BOTH ids as strings, per ML’s documented body', async () => {
    // ⚠️ The single easiest thing to get silently wrong. Since 02/02/2026 the
    // agent IS the delivery path on MLB, so a message addressed to the buyer's
    // real id does not reach them — and ML answers 200 either way. Nothing but
    // this assertion stands between that and a seller whose replies vanish.
    const fetchMock = sendMock();
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.sendPackMessage('pack-1', '415458330', {
      text: 'Enviado hoje!',
      toUserId: postSaleAgentUserId('MLB'),
    });

    expect(bodyOf(fetchMock)).toEqual({
      from: { user_id: '415458330' },
      to: { user_id: '3037675074' },
      text: 'Enviado hoje!',
    });
  });

  it('omits the attachments key entirely when there are none', async () => {
    // An empty array is not the same as an absent key here: ML validates the
    // attachment ids it is given, so sending [] invites a 400 for nothing.
    const fetchMock = sendMock();
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.sendPackMessage('p', 's', { text: 'oi', toUserId: 1, attachments: [] });

    expect(bodyOf(fetchMock)).not.toHaveProperty('attachments');
  });

  it('includes attachments when the caller supplies them', async () => {
    const fetchMock = sendMock();
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.sendPackMessage('p', 's', { text: 'oi', toUserId: 1, attachments: ['a1', 'a2'] });

    expect(bodyOf(fetchMock).attachments).toEqual(['a1', 'a2']);
  });

  it('surfaces a refusal as MercadoLivreHttpError rather than resolving', async () => {
    // A blocked thread, an open mediation and an undelivered ME Full order all
    // answer 403. The route turns that into an operator-facing message, which
    // it can only do if the rejection actually reaches it.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'conversation blocked' }, 403),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.sendPackMessage('p', 's', { text: 'oi', toUserId: 1 })).rejects.toMatchObject({
      name: 'MercadoLivreHttpError',
      status: 403,
    });
  });
});

describe('postSaleAgentUserId', () => {
  it('maps every site ML published an agent for', () => {
    expect(postSaleAgentUserId('MLA')).toBe(3037674934);
    expect(postSaleAgentUserId('MLC')).toBe(3020819166);
    expect(postSaleAgentUserId('MCO')).toBe(3037204123);
    expect(postSaleAgentUserId('MLM')).toBe(3037204279);
    expect(postSaleAgentUserId('MLU')).toBe(3037204685);
  });

  it('defaults an unknown, empty or missing site to MLB', () => {
    // This ERP sells in Brazil; a missing site_id field is a field ML did not send,
    // not evidence of a different marketplace.
    for (const site of [null, undefined, '', '   ', 'MLZ']) {
      expect(postSaleAgentUserId(site), String(site)).toBe(ML_POST_SALE_AGENT_USER_ID.MLB);
    }
  });

  it('is case- and whitespace-insensitive, because the field comes off the wire', () => {
    expect(postSaleAgentUserId(' mla ')).toBe(3037674934);
  });
});

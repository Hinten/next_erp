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

/**
 * The pack response ML's "Gestão de mensagens" reference documents, on a thread
 * ML has **MIGRATED** to the 02/02/2026 agent architecture: `path` carries the
 * `/conversations/` segment and the inbound message comes `from` the agent.
 *
 * ⚠️ Those two travel together. This fixture used to pair an agent `from` with a
 * plain path, a shape ML does not produce — see `LEGACY_PACK` for the other flow.
 */
const PACK = {
  paging: { limit: 10, offset: 0, total: 3 },
  conversation_status: {
    path: '/packs/2000000089077943/sellers/415458330/conversations/post_sale',
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

/**
 * The same thread on the flow ML has **NOT** migrated: a real buyer `from`, and a
 * `path` with no `/conversations/` segment.
 *
 * ⚠️ Note the PLURAL `sellers` — ML uses both spellings off the agent flow (its
 * reference shows the singular; the live 400 on pack 2000018143664980 quoted the
 * plural), so only the `/conversations/` segment discriminates the two.
 */
const LEGACY_PACK = {
  ...PACK,
  conversation_status: { ...PACK.conversation_status, path: '/packs/22175467/sellers/32086568493' },
  messages: [{ ...PACK.messages[0], from: { user_id: 1234567890 } }],
};

describe('getPackMessages', () => {
  it('parses BOTH conversation flows — the discriminator is /conversations/', async () => {
    for (const [nome, fixture, esperado] of [
      ['agente', PACK, '/packs/2000000089077943/sellers/415458330/conversations/post_sale'],
      ['legado', LEGACY_PACK, '/packs/22175467/sellers/32086568493'],
    ] as const) {
      const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse(fixture),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));
      const r = await api.getPackMessages('1', '2');
      expect(r.conversation_status?.path, nome).toBe(esperado);
      expect(r.messages[0]?.from?.user_id, nome).toBe(fixture.messages[0]!.from.user_id);
    }
  });

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

  it('puts the caller’s paging on the query string', async () => {
    // ⚠️ Untested until now, and two callers depend on it reaching ML: the
    // importer walks `paging.total`, and the SEND path derives the reply's
    // recipient from this response — at ML's default page of 10 the newest
    // counterparty can be off the page entirely. A silently-dropped `limit`
    // leaves every stubbed test above still green.
    const casos: Array<[{ limit?: number; offset?: number } | undefined, string]> = [
      [undefined, ''],
      [{ limit: 100 }, '&limit=100'],
      [{ limit: 100, offset: 50 }, '&limit=100&offset=50'],
      // ML 400s a non-positive limit, so neither is sent — see the guards in api.ts.
      [{ limit: 0 }, ''],
      [{ offset: 0 }, ''],
    ];
    for (const [paginacao, sufixo] of casos) {
      const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
        jsonResponse(PACK),
      );
      const api = createMercadoLivreApi(cfg(fetchMock));

      await api.getPackMessages('1', '2', paginacao);

      expect(fetchMock.mock.calls[0]![0], JSON.stringify(paginacao)).toBe(
        'https://api.mercadolibre.com/messages/packs/1/sellers/2' +
          `?tag=post_sale&mark_as_read=false${sufixo}`,
      );
    }
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

  // ⚠️ This is the TRANSPORT, and it is agnostic about who the recipient is.
  // WHICH id belongs here is decided per-thread by `postSaleRecipientUserId` —
  // ML's agent rollout is progressive, so the agent is right on a migrated thread
  // and the real buyer id on one it has not migrated. This file used to assert
  // "addresses the AGENT" as a universal, which is what shipped the bug.
  it.each([
    ['the site agent, on a migrated thread', postSaleAgentUserId('MLB'), '3037675074'],
    ['the real buyer, on a thread ML has not migrated', 1234567890, '1234567890'],
  ])('sends %s through unchanged, BOTH ids as strings per ML’s body', async (_, id, esperado) => {
    const fetchMock = sendMock();
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.sendPackMessage('pack-1', '415458330', { text: 'Enviado hoje!', toUserId: id });

    expect(bodyOf(fetchMock)).toEqual({
      from: { user_id: '415458330' },
      to: { user_id: esperado },
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

// ⚠️ The table and this lookup are unchanged, but their ROLE narrowed: they are
// no longer the recipient of every reply, only the last rung of
// `postSaleRecipientUserId` — reached when `conversation_status.path` names a
// `/conversations/` segment and the thread itself named no counterparty.
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

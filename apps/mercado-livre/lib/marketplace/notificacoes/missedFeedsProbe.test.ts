import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';
const h = vi.hoisted(() => ({ candidates: vi.fn(), loadCtx: vi.fn() }));
vi.mock('./missedFeedsAccess', () => ({ listMissedFeedsCandidates: h.candidates }));
vi.mock('../core/mercadoLivre', async (importActual) => ({
  ...(await importActual<typeof import('../core/mercadoLivre')>()),
  loadMercadoLivreContext: h.loadCtx,
}));
import { probeMissedFeeds, probeMissedFeedsAccounts } from './missedFeedsProbe';

describe('missed-feeds provider probe', () => {
  it('compares all three query shapes and emits only sanitized summaries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [{ topic: 'orders_v2', request: { url: 'SECRET_CALLBACK' } }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'site_id required', secret: 'SECRET_ERROR' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] })));
    const token = vi.fn(async () => 'SECRET_TOKEN');
    const rows = await probeMissedFeeds('42', token, 'MLB', fetchMock);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.searchParams.get('topic'))).toEqual([null, 'items', 'items']);
    expect(urls.map((url) => url.searchParams.get('site_id'))).toEqual([null, null, 'MLB']);
    expect(rows.map((row) => row.status)).toEqual([200, 400, 200]);
    expect(rows[0]).toMatchObject({ count: 1, topics: { orders_v2: 1 } });
    expect(rows[2]).toMatchObject({ shape: 'messages-array', count: 0 });
    expect(token).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    for (const [, init] of fetchMock.mock.calls)
      expect(init?.headers).toEqual({ Authorization: 'Bearer SECRET_TOKEN' });
  });
  it('counts prototype-shaped topic names as numeric own properties', async () => {
    const rows = await probeMissedFeeds(
      '42',
      async () => 'token',
      'MLB',
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ messages: [{ topic: 'constructor' }, { topic: 'constructor' }] }),
          ),
      ),
    );
    expect(rows[0]?.topics.constructor).toBe(2);
    expect(Object.hasOwn(rows[0]!.topics, 'constructor')).toBe(true);
  });
  it.each([
    ['<html>private content</html>', 'invalid-json'],
    ['null', 'non-object'],
    ['{}', 'missing-messages'],
    ['{"messages":{}}', 'invalid-messages'],
  ])('does not turn %s into a healthy empty feed', async (body, shape) => {
    const rows = await probeMissedFeeds(
      '42',
      async () => 'token',
      'MLB',
      vi.fn<typeof fetch>(async () => new Response(body)),
    );
    expect(rows.every((row) => row.shape === shape && row.count === null)).toBe(true);
  });
});

describe('probe account discovery', () => {
  const db = {} as Firestore;
  function connected() {
    return {
      resolveChannelContext: async () => ({ getAccessToken: async () => 'SECRET_TOKEN' }),
    };
  }
  it('records every HTTP rejection before selecting a later empty successful account', async () => {
    h.candidates.mockResolvedValue(['A-disconnected', 'B-seller', 'C-owner', 'D-unused']);
    h.loadCtx.mockReset();
    h.loadCtx.mockImplementation(async (_db: Firestore, id: string) => {
      if (id === 'A-disconnected')
        throw new MercadoLivreReauthRequiredError('no_token', 'disconnected');
      return connected();
    });
    const fetchMock = vi.fn<typeof fetch>();
    for (const status of [401, 403, 401, 200, 400, 200])
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(status === 200 ? { messages: [] } : { secret: 'SECRET' }), {
          status,
        }),
      );
    const result = await probeMissedFeedsAccounts(db, '42', 'MLB', () => {}, fetchMock);
    expect(result).toMatchObject({ examined: 3, rejected: 2, selectedIntegracaoId: 'C-owner' });
    expect(result.attempts.map((attempt) => attempt.rows.map((row) => row.status))).toEqual([
      [401, 403, 401],
      [200, 400, 200],
    ]);
    expect(h.loadCtx.mock.calls.map(([, id]) => id)).toEqual([
      'A-disconnected',
      'B-seller',
      'C-owner',
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('returns all three contract rows when every site-qualified items request fails', async () => {
    h.candidates.mockResolvedValue(['A']);
    h.loadCtx.mockResolvedValue(connected());
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ message: 'rejected' }), { status: 400 }),
    );
    const result = await probeMissedFeedsAccounts(db, '42', 'MLB', () => {}, fetchMock);
    expect(result.selectedIntegracaoId).toBeNull();
    expect(result.attempts[0]?.rows.map((row) => row.query)).toEqual([
      'unfiltered',
      'items-without-site',
      'items-with-site',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

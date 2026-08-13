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

/**
 * The verbatim shape from Mercado Livre's "Receive notifications" reference —
 * the canonical fixture. Note `sent`/`received` are ISO-8601 STRINGS here (the
 * webhook wire sends epoch millis) and `user_id` is a STRING; both are the wire
 * traps this schema exists to tolerate.
 */
const MISSED_FEED = {
  _id: '5da8a1b24be30a49eb66c52a',
  resource: '/payments/1234567890',
  user_id: '465432224',
  topic: 'payments',
  application_id: 3486171129139063,
  attempts: 8,
  sent: '2026-08-10T17:15:30.279Z',
  received: '2026-08-10T17:15:30.259Z',
  request: {
    url: 'https://ml.example.com/api/webhooks/mercado-livre',
    headers: { accept: 'application/json', 'content-length': 207 },
    data: '{"resource":"/payments/1234567890","topic":"payments"}',
  },
  response: {
    req_time: 260,
    http_code: 500,
    body: '[object Object]',
    headers: { date: 'Mon, 10 Aug 2026 17:15:30 GMT' },
  },
};

function firstUrl(fetchMock: FetchMock): URL {
  return new URL(String(fetchMock.mock.calls[0]![0]));
}

describe('createMercadoLivreApi — missed feeds (#812)', () => {
  it('GETs /missed_feeds with app_id/limit/offset and the Bearer + User-Agent headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [MISSED_FEED] }));
    const api = createMercadoLivreApi(cfg(fetchMock, { userAgent: 'test-UA' }));

    const page = await api.getMissedFeeds({ appId: '3486171129139063', limit: 50, offset: 100 });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!._id).toBe('5da8a1b24be30a49eb66c52a');

    const url = firstUrl(fetchMock);
    expect(url.pathname).toBe('/missed_feeds');
    expect(url.searchParams.get('app_id')).toBe('3486171129139063');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('100');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('GET');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers['User-Agent']).toBe('test-UA');
  });

  it('sends NO access_token query param — the token rides the header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getMissedFeeds({ appId: '42' });

    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('access_token');
  });

  it('omits topic/limit/offset from the URL when they are undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getMissedFeeds({ appId: '42' });

    // Pins `buildUrl`'s `if (v !== undefined)` behaviour, so a future `?? 0`
    // default in the wrapper cannot silently pin ML's defaults to ours.
    const url = firstUrl(fetchMock);
    expect(url.searchParams.has('topic')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('sends topic when the caller supplies it (the diagnostic filter)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getMissedFeeds({ appId: '42', topic: 'orders_v2' });

    expect(firstUrl(fetchMock).searchParams.get('topic')).toBe('orders_v2');
  });

  it('defaults messages to [] when ML omits the array entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getMissedFeeds({ appId: '42' })).resolves.toEqual({ messages: [] });
  });

  it('passthrough: unknown keys survive at BOTH the page and the entry level', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        next_offset: 50,
        messages: [{ ...MISSED_FEED, a_new_ml_field: 'surprise' }],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const page = await api.getMissedFeeds({ appId: '42' });

    // Load-bearing: the sweep hands the entry's remainder to
    // `parseNotificationBody`, and that remainder is what makes a dead-letter
    // row legible (#810). A `.strict()` here would silently strip it.
    expect((page as Record<string, unknown>).next_offset).toBe(50);
    expect((page.messages[0] as Record<string, unknown>).a_new_ml_field).toBe('surprise');
  });

  it('ONE malformed entry does not reject the whole page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        messages: [
          MISSED_FEED,
          // No `_id`, null topic, an object where a seller id belongs.
          { resource: '/orders/1', topic: null, user_id: {} },
          { ...MISSED_FEED, _id: 'third' },
        ],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    // This feed IS the recovery path. A strict field would block every OTHER
    // notification's recovery because of one odd neighbour — permanently, since
    // the entries expire in 2 days regardless.
    const page = await api.getMissedFeeds({ appId: '42' });
    expect(page.messages).toHaveLength(3);
    expect(page.messages[2]!._id).toBe('third');

    // The unusable field is NULLED, not dropped and not fatal — that is what
    // routes it through the sweep's "unusable entry" counter rather than a
    // silent loss. `resource` on the same entry survives untouched.
    expect(page.messages[1]!.user_id).toBeNull();
    expect(page.messages[1]!.topic).toBeNull();
    expect(page.messages[1]!.resource).toBe('/orders/1');
  });

  it('leaves sent/received as ML sent them — no coercion at the API layer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [MISSED_FEED] }));
    const api = createMercadoLivreApi(cfg(fetchMock));

    const page = await api.getMissedFeeds({ appId: '42' });

    // Coercion belongs to `normalizeMlWire`'s `asMillis`, once. Doing it here
    // too is exactly the two-divergent-coercers shape that caused #810.
    expect(typeof page.messages[0]!.sent).toBe('string');
    expect(typeof page.messages[0]!.received).toBe('string');
  });

  it('accepts a STRING and a numeric user_id identically, nulling neither', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        messages: [MISSED_FEED, { ...MISSED_FEED, _id: 'numeric', user_id: 465432224 }],
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const page = await api.getMissedFeeds({ appId: '42' });

    expect(page.messages[0]!.user_id).toBe('465432224');
    expect(page.messages[1]!.user_id).toBe(465432224);
  });

  it('maps a 404 to MercadoLivreHttpError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }, 404));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getMissedFeeds({ appId: '42' })).rejects.toBeInstanceOf(MercadoLivreHttpError);
  });

  it('maps a 500 to MercadoLivreHttpError carrying the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'boom' }, 500));
    const api = createMercadoLivreApi(cfg(fetchMock));

    // The one the sweep's per-conta containment boundary must classify.
    await expect(api.getMissedFeeds({ appId: '42' })).rejects.toMatchObject({ status: 500 });
  });

  it('maps a 401 to MercadoLivreReauthRequiredError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'invalid token' }, 401));
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getMissedFeeds({ appId: '42' })).rejects.toBeInstanceOf(
      MercadoLivreReauthRequiredError,
    );
  });
});

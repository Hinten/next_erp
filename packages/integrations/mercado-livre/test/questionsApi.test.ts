import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '../src/errors';
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

/**
 * An UNANSWERED question exactly as ML's `api_version=4` reference documents it
 * (developers.mercadolivre.com.br, "Perguntas e respostas" → "Perguntas por ID").
 */
const UNANSWERED = {
  id: 11751825075,
  seller_id: 179571326,
  buyer_id: 56801932,
  item_id: 'MLB739200576',
  deleted_from_listing: false,
  suspected_spam: false,
  status: 'UNANSWERED',
  hold: false,
  text: 'Tem em azul?',
  app_id: 8304540643508652,
  date_created: '2021-02-08T17:51:21.746608612Z',
  last_updated: '2021-02-08T17:51:29.184950392Z',
  answer: null,
};

describe('getQuestion', () => {
  it('calls the by-id endpoint WITH api_version=4 and a Bearer token', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(UNANSWERED),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const q = await api.getQuestion(11751825075);

    const [url, init] = fetchMock.mock.calls[0]!;
    // `api_version=4` is load-bearing, not decoration: the legacy shape omits
    // `buyer_id`, and the importer keys the contact on it.
    expect(url).toBe('https://api.mercadolibre.com/questions/11751825075?api_version=4');
    expect(init!.method).toBe('GET');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
    expect(q.id).toBe(11751825075);
    expect(q.buyer_id).toBe(56801932);
    expect(q.status).toBe('UNANSWERED');
  });

  it('tolerates a status ML has not documented yet', async () => {
    // The whole reason `status` is a plain string. The legacy Dart enum modelled
    // only four members and THREW on anything else, so one new ML vocabulary
    // value would have poisoned every question import.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...UNANSWERED, status: 'SOME_NEW_STATUS' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getQuestion(1)).resolves.toMatchObject({ status: 'SOME_NEW_STATUS' });
  });

  it('accepts a BANNED question, whose text ML strips to empty', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 42, status: 'BANNED', text: '', answer: null }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const q = await api.getQuestion(42);
    expect(q.text).toBe('');
    expect(q.status).toBe('BANNED');
  });

  it('parses an ANSWERED question, keeping the answer datetimes as ISO strings', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({
        ...UNANSWERED,
        status: 'ANSWERED',
        answer: {
          text: 'Temos sim!',
          status: 'ACTIVE',
          date_created: '2021-02-16T14:52:13.580-04:00',
        },
      }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const q = await api.getQuestion(1);
    expect(q.answer).toMatchObject({ text: 'Temos sim!', status: 'ACTIVE' });
    // ISO in, ISO out — the conversion happens once, at the mapping boundary.
    expect(q.answer?.date_created).toBe('2021-02-16T14:52:13.580-04:00');
  });

  it('survives a question with only an id — every other field defaults', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 7 }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const q = await api.getQuestion(7);
    expect(q).toMatchObject({ id: 7, status: null, text: '', answer: null, buyer_id: null });
  });

  it('keeps unknown ML fields via passthrough, so a dead-letter row stays useful', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...UNANSWERED, campo_novo_do_ml: 'xyz' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getQuestion(1)).resolves.toMatchObject({ campo_novo_do_ml: 'xyz' });
  });

  it('maps a 401 to the reauth error, not a generic HTTP failure', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ message: 'invalid token' }, 401),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.getQuestion(1)).rejects.toBeInstanceOf(MercadoLivreReauthRequiredError);
  });
});

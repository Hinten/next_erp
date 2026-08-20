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

describe('answerQuestion / deleteQuestion / blockUserFromQuestions', () => {
  function bodyOf(fetchMock: FetchMock): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('answers with the flat { question_id, text } body ML documents', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ id: 998, status: 'ACTIVE', text: 'Temos sim!' }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    const r = await api.answerQuestion(11751825075, 'Temos sim!');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/answers');
    expect((init as RequestInit).method).toBe('POST');
    expect(bodyOf(fetchMock)).toEqual({ question_id: 11751825075, text: 'Temos sim!' });
    expect(r.status).toBe('ACTIVE');
  });

  it('tolerates an answer response ML shapes differently', async () => {
    // The body is passthrough and every field defaults to null: nothing in the
    // reply path reads it, so an ML field rename must not turn a SUCCESSFUL
    // public answer into a thrown validation error.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ campo_novo: 1 }),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await expect(api.answerQuestion(1, 'x')).resolves.toMatchObject({ id: null, status: null });
  });

  it('deletes a question with DELETE /questions/{id}', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}, 200),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.deleteQuestion(11751825075);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/questions/11751825075');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('blocks a buyer on the SELLER’s blacklist, with the BUYER in the body', async () => {
    // ⚠️ The two ids are not interchangeable and both are plain integers, so a
    // swap is a well-formed request that blocks the wrong person — the seller
    // from their own listings.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({}, 201),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.blockUserFromQuestions(415458330, 56801932);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/users/415458330/questions_blacklist');
    expect((init as RequestInit).method).toBe('POST');
    expect(bodyOf(fetchMock)).toEqual({ user_id: 56801932 });
  });

  it('surfaces a refusal on each of the three, instead of resolving quietly', async () => {
    const fail = () =>
      createMercadoLivreApi(
        cfg(
          vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
            jsonResponse({ message: 'nope' }, 400),
          ),
        ),
      );

    await expect(fail().answerQuestion(1, 'x')).rejects.toMatchObject({ status: 400 });
    await expect(fail().deleteQuestion(1)).rejects.toMatchObject({ status: 400 });
    await expect(fail().blockUserFromQuestions(1, 2)).rejects.toMatchObject({ status: 400 });
  });
});

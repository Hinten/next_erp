import { describe, expect, it, vi } from 'vitest';
import { MercadoLivreHttpError, MercadoLivreValidationError } from '../src/errors';
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
 * `GET /moderations/last_moderation/{element_id}-ITM` (#1087).
 *
 * Every fixture is a response Mercado Livre PUBLISHES — *Gerenciar moderações*,
 * *Moderações com pausa*, *Moderações de imagens*. Those three pages disagree
 * with each other on the wire shape, which is why this schema is tolerant, and
 * why that tolerance is pinned here rather than left to the mapper.
 */

/** *Gerenciar moderações*, verbatim. Note `evidences`, plural. */
const DOCS = [
  {
    name: 'POOR_QUALITY_THUMBNAIL',
    id: '7123400815',
    date_created: '2021-04-14T10:47:05.270-0400',
    evidences: [
      { text_matched: '604505-MLA82848669458_022025', section_name: 'pictures' },
      { text_matched: 'MLA29272', section_name: 'category' },
    ],
    wordings: [
      { type: 'REMEDY', value: 'Corrija sua publicação para vender no Mercado Livre.' },
      {
        type: 'REASON',
        value: 'Seu anúncio foi pausado porque, aparentemente, descumpre nossas Políticas.',
      },
    ],
  },
];

describe('getLastModeration', () => {
  it('calls the documented URL with the reference id it was given', async () => {
    // Params are declared so `mock.calls` is a typed tuple rather than `[]` —
    // the idiom the rest of this test directory already uses.
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(DOCS),
    );
    const api = createMercadoLivreApi(cfg(fetchMock));

    await api.getLastModeration('MLB5095421681-ITM');

    // ⚠️ The exact string. The reference is `{element_id}-{element_type}`, and a
    // bare item id here is a silent miss rather than an error, so the URL is the
    // only place that mistake can be caught.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadolibre.com/moderations/last_moderation/MLB5095421681-ITM');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
  });

  it("parses ML's documented response, wordings and evidences intact", async () => {
    const api = createMercadoLivreApi(cfg(vi.fn(async () => jsonResponse(DOCS))));

    const [m] = await api.getLastModeration('MLB1-ITM');

    expect(m?.name).toBe('POOR_QUALITY_THUMBNAIL');
    expect(m?.evidences?.[0]?.section_name).toBe('pictures');
    expect(m?.wordings).toHaveLength(2);
    // Kept as a raw string — ML sends two different formats for this field.
    expect(m?.date_created).toBe('2021-04-14T10:47:05.270-0400');
  });

  /**
   * ⚠️ *Moderações com pausa* and *Moderações de imagens* spell the key
   * **`evidence`**, singular, and use a space-separated `date_created` with no
   * zone. A schema written from *Gerenciar moderações* alone would throw
   * `MercadoLivreValidationError` on both pages' shapes and lose the whole
   * explanation — the exact outcome this endpoint was added to prevent.
   */
  it("accepts ML's singular `evidence` spelling and its zone-less date", async () => {
    const paused = [
      {
        name: 'PAUSED_PREVENTION_PRICE',
        id: '7123400818',
        date_created: '2022-10-25 15:57:46.0',
        wordings: [{ type: 'REASON', value: 'Alteração incomum no preço.' }],
        evidence: [{ text_matched: 'O preço alertado é 77393.720000', section_name: 'item' }],
      },
    ];
    const api = createMercadoLivreApi(cfg(vi.fn(async () => jsonResponse(paused))));

    const [m] = await api.getLastModeration('MLB1-ITM');

    expect(m?.evidence?.[0]?.section_name).toBe('item');
    expect(m?.evidences).toBeNull();
    expect(m?.date_created).toBe('2022-10-25 15:57:46.0');
  });

  it('accepts an entry with no wordings and no evidence at all', async () => {
    const api = createMercadoLivreApi(cfg(vi.fn(async () => jsonResponse([{ name: 'X' }]))));
    await expect(api.getLastModeration('MLB1-ITM')).resolves.toHaveLength(1);
  });

  it('parses an empty list — a valid "nothing active" answer alongside the 404', async () => {
    const api = createMercadoLivreApi(cfg(vi.fn(async () => jsonResponse([]))));
    await expect(api.getLastModeration('MLB1-ITM')).resolves.toEqual([]);
  });

  /**
   * The client does NOT interpret this — it throws like any other non-2xx, and
   * the CALLER decides that 404 means "not moderated". Keeping the meaning at
   * the call site is what lets `/items` keep reading 404 as "listing deleted"
   * while this one reads it as "no moderation".
   */
  it('throws MercadoLivreHttpError with status 404, leaving the meaning to the caller', async () => {
    const api = createMercadoLivreApi(
      cfg(vi.fn(async () => jsonResponse({ message: 'not found' }, 404))),
    );

    await expect(api.getLastModeration('MLB1-ITM')).rejects.toBeInstanceOf(MercadoLivreHttpError);
    await expect(api.getLastModeration('MLB1-ITM')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a body that is not a list', async () => {
    // ML documents an array on every page; an object here means something changed
    // and is worth failing loudly rather than silently mapping to zero reasons.
    const api = createMercadoLivreApi(cfg(vi.fn(async () => jsonResponse({ name: 'X' }))));
    await expect(api.getLastModeration('MLB1-ITM')).rejects.toBeInstanceOf(
      MercadoLivreValidationError,
    );
  });
});

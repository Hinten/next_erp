import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  caminhoValido,
  type ChamadaAmazon,
  criarClienteSpApi,
  MARKETPLACE_ID_BR,
  type OpcoesClienteSpApi,
  URL_BASE_SP_API,
} from '../src/client';
import { AmazonConfigError, AmazonNotFoundError, AmazonSchemaError } from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import {
  buscaListingsAmazonSchema,
  buscarListingsAmazon,
  CAMINHO_ATRIBUTO_DISPONIBILIDADE,
  CAMINHO_LISTINGS,
  CANAL_MFN,
  DADOS_LISTING_AMAZON,
  type DadoListingAmazon,
  enviarDisponibilidadeAmazon,
  envioListingAmazonSchema,
  lerListingAmazon,
  listingAmazonSchema,
  MAX_SKUS_POR_BUSCA,
  OPERACAO_BUSCAR_LISTINGS,
  OPERACAO_ENVIAR_LISTING,
  OPERACAO_LER_LISTING,
  segmentoSkuAmazon,
  skuBuscavelAmazon,
  skuTemCaminhoAmazon,
  TIPO_PRODUTO_OFERTA,
} from '../src/listings';
import {
  buscaListings200,
  envioListing200Aceito,
  envioListing200Invalido,
  listing200,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  falha,
  json,
  mockFetch,
  requisicao,
  texto,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

/** The package's fake seller id shape: no real id, no Amazon prefix. */
const SELLER = 'SELLER-TESTE';
const SKU = 'SKU-TESTE-1';
const TODOS: readonly [DadoListingAmazon, ...DadoListingAmazon[]] = [
  DADOS_LISTING_AMAZON.resumos,
  DADOS_LISTING_AMAZON.disponibilidade,
  DADOS_LISTING_AMAZON.relacoes,
  DADOS_LISTING_AMAZON.issues,
];

function opcoes(fetch: typeof globalThis.fetch, eventos: ChamadaAmazon[] = []) {
  const obterCredencial = vi.fn(() => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }));
  const o: OpcoesClienteSpApi = {
    obterCredencial,
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
  };
  return { o, obterCredencial };
}

function leitor(fetch: typeof globalThis.fetch) {
  const { o, obterCredencial } = opcoes(fetch);
  return { c: criarClienteSpApi(o), obterCredencial };
}

function escritor(fetch: typeof globalThis.fetch) {
  const eventos: ChamadaAmazon[] = [];
  const { o, obterCredencial } = opcoes(fetch, eventos);
  return { c: criarClienteEscritaSpApi(o), obterCredencial, eventos };
}

/** The ONE stock body, as a literal (keys in any order; no other key anywhere). */
const corpoEstoque = (quantity: number) => ({
  productType: 'PRODUCT',
  patches: [
    {
      op: 'merge',
      path: '/attributes/fulfillment_availability',
      value: [{ fulfillment_channel_code: 'DEFAULT', quantity }],
    },
  ],
});

function corpoEnviado(f: { mock: { calls: Parameters<typeof globalThis.fetch>[] } }): unknown {
  const body = requisicao(f).init.body;
  if (typeof body !== 'string') throw new Error('corpo não é texto');
  return JSON.parse(body) as unknown;
}

/* -------------------------------------------------------------------------- */
/*                               The stock patch                              */
/* -------------------------------------------------------------------------- */

describe('enviarDisponibilidadeAmazon: the body', () => {
  it('★ is EXACTLY the merge body, sent as a PATCH on the write client', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const { c, eventos } = escritor(f);
    const r = await enviarDisponibilidadeAmazon(c, { sellerId: SELLER, sku: SKU, quantidade: 7 });
    expect(corpoEnviado(f)).toStrictEqual(corpoEstoque(7));
    const { init, url } = requisicao(f);
    expect(init.method).toBe('PATCH');
    expect(url.pathname).toBe(`${CAMINHO_LISTINGS}/${SELLER}/${SKU}`);
    expect([...url.searchParams.entries()]).toEqual([
      ['marketplaceIds', MARKETPLACE_ID_BR],
      ['issueLocale', 'pt_BR'],
    ]);
    expect(eventos.map((e) => [e.operacao, e.metodo])).toEqual([
      [OPERACAO_ENVIAR_LISTING, 'PATCH'],
    ]);
    expect(r.dados).toMatchObject({ sku: 'GM-ZDPI-9B4E', status: 'ACCEPTED' });
  });

  it('★ the body is built from the constants, never the caller’s object', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const entrada = {
      sellerId: SELLER,
      sku: SKU,
      quantidade: 3,
      // Extra keys a caller could hand in: none may ride along.
      op: 'replace',
      fulfillment_channel_code: 'AMAZON_NA',
      lead_time_to_ship_max_days: 2,
      marketplace_id: MARKETPLACE_ID_BR,
      mode: 'VALIDATION_PREVIEW',
    };
    await enviarDisponibilidadeAmazon(escritor(f).c, entrada);
    expect(corpoEnviado(f)).toStrictEqual(corpoEstoque(3));
    expect(requisicao(f).url.searchParams.has('mode')).toBe(false);
    expect(requisicao(f).url.searchParams.has('includedData')).toBe(false);
  });

  it.each<[string, unknown]>([
    [
      'op replace (it drops what the body omits, a lead time included)',
      {
        ...corpoEstoque(7),
        patches: [{ ...corpoEstoque(7).patches[0], op: 'replace' }],
      },
    ],
    [
      'an AFN channel code',
      {
        ...corpoEstoque(7),
        patches: [
          {
            ...corpoEstoque(7).patches[0],
            value: [{ fulfillment_channel_code: 'AMAZON_NA', quantity: 7 }],
          },
        ],
      },
    ],
    [
      'an added lead time',
      {
        ...corpoEstoque(7),
        patches: [
          {
            ...corpoEstoque(7).patches[0],
            value: [
              { fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2 },
            ],
          },
        ],
      },
    ],
    [
      'a marketplace_id in value',
      {
        ...corpoEstoque(7),
        patches: [
          {
            ...corpoEstoque(7).patches[0],
            value: [
              {
                fulfillment_channel_code: 'DEFAULT',
                quantity: 7,
                marketplace_id: MARKETPLACE_ID_BR,
              },
            ],
          },
        ],
      },
    ],
  ])('★ NEAR-MISS: %s is refused by the pin', async (_caso, quase) => {
    const f = mockFetch(() => json(envioListing200Aceito));
    await enviarDisponibilidadeAmazon(escritor(f).c, { sellerId: SELLER, sku: SKU, quantidade: 7 });
    expect(corpoEnviado(f)).not.toStrictEqual(quase);
    expect(corpoEnviado(f)).toStrictEqual(corpoEstoque(7));
  });

  it('the constants are the merge body’s', () => {
    expect(CANAL_MFN).toBe('DEFAULT');
    expect(TIPO_PRODUTO_OFERTA).toBe('PRODUCT');
    expect(CAMINHO_ATRIBUTO_DISPONIBILIDADE).toBe('/attributes/fulfillment_availability');
  });
});

describe('enviarDisponibilidadeAmazon: the quantity', () => {
  it.each([-1, 1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY, -0.5])(
    '★ %s is refused before fetch, the credential unread (quantidade)',
    async (quantidade) => {
      const f = mockFetch(() => json(envioListing200Aceito));
      const { c, obterCredencial, eventos } = escritor(f);
      const err = await falha(
        enviarDisponibilidadeAmazon(c, { sellerId: SELLER, sku: SKU, quantidade }),
      );
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect(err).toMatchObject({ motivo: 'quantidade', operacao: OPERACAO_ENVIAR_LISTING });
      expect(f).not.toHaveBeenCalled();
      expect(obterCredencial).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
    },
  );

  it('★ NEAR-MISS: 0 is sent (an out-of-stock listing), and so is the largest safe integer', async () => {
    for (const quantidade of [0, Number.MAX_SAFE_INTEGER]) {
      const f = mockFetch(() => json(envioListing200Aceito));
      await enviarDisponibilidadeAmazon(escritor(f).c, { sellerId: SELLER, sku: SKU, quantidade });
      expect(corpoEnviado(f)).toStrictEqual(corpoEstoque(quantidade));
    }
  });
});

describe('enviarDisponibilidadeAmazon: the answer', () => {
  it('★ the sandbox INVALID submission parses with its issue code', async () => {
    const f = mockFetch(() => json(envioListing200Invalido));
    const r = await enviarDisponibilidadeAmazon(escritor(f).c, {
      sellerId: SELLER,
      sku: SKU,
      quantidade: 1,
    });
    expect(r.dados.status).toBe('INVALID');
    expect(r.dados.issues?.map((i) => i.code)).toEqual(['90000900']);
    expect(r.dados.issues?.[0]?.severity).toBe('ERROR');
  });

  it('an unknown submission status parses (an open string), a missing sku does not', () => {
    expect(envioListingAmazonSchema.parse({ sku: 'x', status: 'NOVO_STATUS' }).status).toBe(
      'NOVO_STATUS',
    );
    expect(envioListingAmazonSchema.safeParse({ status: 'ACCEPTED' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The SKU segment                              */
/* -------------------------------------------------------------------------- */

describe('segmentoSkuAmazon', () => {
  it.each<[string, string | null]>([
    ['A-1', 'A-1'],
    ['a b', 'a%20b'],
    ['%', '%25'],
    ['a?b#c', 'a%3Fb%23c'],
    ['açaí', 'a%C3%A7a%C3%AD'],
    // NEAR-MISS: one dot inside a SKU is a plain character.
    ['a.b', 'a.b'],
    ['.a', '.a'],
    // Refused: no path can carry these unchanged.
    ['a/b', null],
    ['a\\b', null],
    ['a..b', null],
    ['..', null],
    ['.', null],
    ['', null],
    ['\uD800', null],
  ])('★ %j → %j', (sku, esperado) => {
    expect(segmentoSkuAmazon(sku)).toBe(esperado);
    expect(skuTemCaminhoAmazon(sku)).toBe(esperado !== null);
  });

  it('every accepted segment passes the client’s own path check in the listings path', () => {
    for (const sku of ['A-1', 'a b', '%', 'a.b', 'açaí', "x'(y)*~!"]) {
      const segmento = segmentoSkuAmazon(sku);
      expect(segmento, sku).not.toBeNull();
      expect(caminhoValido(`${CAMINHO_LISTINGS}/${SELLER}/${segmento ?? ''}`), sku).toBe(true);
      expect(decodeURIComponent(segmento ?? ''), sku).toBe(sku);
    }
  });

  it.each(['a/b', 'a..b', '.', ''])(
    '★ a SKU with no path is refused as sku before fetch, by the read and the write: %j',
    async (sku) => {
      const f = mockFetch(() => json(listing200));
      const l = leitor(f);
      const e = escritor(f);
      for (const p of [
        lerListingAmazon(l.c, { sellerId: SELLER, sku, incluir: TODOS }),
        enviarDisponibilidadeAmazon(e.c, { sellerId: SELLER, sku, quantidade: 1 }),
      ]) {
        const err = await falha(p);
        expect(err).toBeInstanceOf(AmazonConfigError);
        expect(err).toMatchObject({ motivo: 'sku', refCredencial: null });
      }
      expect(f).not.toHaveBeenCalled();
      expect(l.obterCredencial).not.toHaveBeenCalled();
      expect(e.obterCredencial).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'a/b', '..', '.'])(
    'a seller id that is not one segment is refused as caminho, nothing sent: %j',
    async (sellerId) => {
      const f = mockFetch(() => json(listing200));
      const err = await falha(
        lerListingAmazon(leitor(f).c, { sellerId, sku: SKU, incluir: TODOS }),
      );
      expect(err).toMatchObject({ motivo: 'caminho' });
      const busca = await falha(
        buscarListingsAmazon(leitor(f).c, { sellerId, skus: [SKU], incluir: TODOS }),
      );
      expect(busca).toMatchObject({ motivo: 'caminho' });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('the message of a refused SKU never echoes it', async () => {
    const sku = 'SENTINELA-SKU/xyz';
    const err = await falha(
      lerListingAmazon(leitor(mockFetch(() => json({}))).c, {
        sellerId: SELLER,
        sku,
        incluir: TODOS,
      }),
    );
    expect((err as Error).message).not.toContain('SENTINELA-SKU');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The reads                                  */
/* -------------------------------------------------------------------------- */

describe('lerListingAmazon', () => {
  it('★ the sandbox 200 parses, with its DEFAULT availability of 100', async () => {
    const f = mockFetch(() => json(listing200));
    const r = await lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: 'a b', incluir: TODOS });
    expect(r.dados.fulfillmentAvailability).toEqual([
      { fulfillmentChannelCode: 'DEFAULT', quantity: 100 },
    ]);
    expect(r.dados.summaries?.[0]).toMatchObject({ asin: 'B0ZZTESTE1', status: ['BUYABLE'] });
    expect(r.dados.issues?.map((i) => i.code)).toEqual(['90220', '18027']);
    const { init, url } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.href.startsWith(`${URL_BASE_SP_API}${CAMINHO_LISTINGS}/${SELLER}/a%20b?`)).toBe(
      true,
    );
    expect([...url.searchParams.entries()]).toEqual([
      ['marketplaceIds', MARKETPLACE_ID_BR],
      ['includedData', 'summaries,fulfillmentAvailability,relationships,issues'],
      ['issueLocale', 'pt_BR'],
    ]);
  });

  it('includedData comes from the constants, in their order; a cast value never reaches the query', async () => {
    const f = mockFetch(() => json(listing200));
    const incluir = [
      DADOS_LISTING_AMAZON.issues,
      'attributes',
      DADOS_LISTING_AMAZON.resumos,
      DADOS_LISTING_AMAZON.issues,
    ] as unknown as readonly [DadoListingAmazon, ...DadoListingAmazon[]];
    await lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir });
    expect(requisicao(f).url.searchParams.get('includedData')).toBe('summaries,issues');
  });

  it('an includedData list with no known value is a wiring bug: a TypeError, nothing sent', async () => {
    const f = mockFetch(() => json(listing200));
    const incluir = ['attributes'] as unknown as readonly [DadoListingAmazon];
    const err = await falha(lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir }));
    expect(err).toBeInstanceOf(TypeError);
    expect(f).not.toHaveBeenCalled();
  });

  it('a 404 is the client’s AmazonNotFoundError (the caller reads "not listed")', async () => {
    const f = mockFetch(() => texto('', 404));
    const err = await falha(
      lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir: TODOS }),
    );
    expect(err).toBeInstanceOf(AmazonNotFoundError);
    expect(err).toMatchObject({ status: 404, operacao: OPERACAO_LER_LISTING });
  });

  it('★ an availability entry without quantity parses (optional in the model)', () => {
    const r = listingAmazonSchema.parse({
      sku: 'x',
      fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT' }],
    });
    expect(r.fulfillmentAvailability?.[0]?.quantity).toBeUndefined();
  });

  it('★ an unknown status and an unknown channel code parse (open strings)', () => {
    const r = listingAmazonSchema.parse({
      sku: 'x',
      summaries: [{ marketplaceId: MARKETPLACE_ID_BR, status: ['STATUS_NOVO'] }],
      fulfillmentAvailability: [{ fulfillmentChannelCode: 'CANAL_NOVO', quantity: 1 }],
      relationships: [
        {
          marketplaceId: MARKETPLACE_ID_BR,
          relationships: [{ type: 'TIPO_NOVO', childSkus: ['c'] }],
        },
      ],
    });
    expect(r.summaries?.[0]?.status).toEqual(['STATUS_NOVO']);
    expect(r.fulfillmentAvailability?.[0]?.fulfillmentChannelCode).toBe('CANAL_NOVO');
    expect(r.relationships?.[0]?.relationships?.[0]?.type).toBe('TIPO_NOVO');
  });

  it('a quoted quantity reads as a number; a fractional or non-numeric one fails', () => {
    const com = (quantity: unknown) =>
      listingAmazonSchema.safeParse({
        sku: 'x',
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity }],
      });
    const lido = com('12');
    expect(lido.success && lido.data.fulfillmentAvailability?.[0]?.quantity).toBe(12);
    expect(com('1.5').success).toBe(false);
    expect(com('doze').success).toBe(false);
    expect(com(1.5).success).toBe(false);
  });

  it('a listing without sku is a schema error, never a silent default', async () => {
    const err = await falha(
      lerListingAmazon(leitor(mockFetch(() => json({ summaries: [] }))).c, {
        sellerId: SELLER,
        sku: SKU,
        incluir: TODOS,
      }),
    );
    expect(err).toBeInstanceOf(AmazonSchemaError);
  });
});

describe('skuBuscavelAmazon', () => {
  it.each<[string, boolean]>([
    ['SKU-TESTE-1', true],
    ['a/b', true],
    ['x'.repeat(40), true],
    // 40 code points of an astral character are 80 UTF-16 units: still 40.
    ['😀'.repeat(40), true],
    ['é'.repeat(40), true],
    ['x'.repeat(41), false],
    ['😀'.repeat(41), false],
    ['a,b', false],
    ['a b', false],
    ['', false],
  ])('★ %j → %s', (sku, esperado) => {
    expect(skuBuscavelAmazon(sku)).toBe(esperado);
  });
});

describe('buscarListingsAmazon', () => {
  const skus = (n: number) => Array.from({ length: n }, (_, i) => `SKU-TESTE-${String(i)}`);

  it('★ sends identifiers joined by a comma, identifiersType=SKU and pageSize=20', async () => {
    const f = mockFetch(() => json(buscaListings200));
    await buscarListingsAmazon(leitor(f).c, {
      sellerId: SELLER,
      skus: ['A-1', 'B-2'],
      incluir: [DADOS_LISTING_AMAZON.disponibilidade, DADOS_LISTING_AMAZON.resumos],
    });
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.pathname).toBe(`${CAMINHO_LISTINGS}/${SELLER}`);
    expect([...url.searchParams.entries()]).toEqual([
      ['marketplaceIds', MARKETPLACE_ID_BR],
      ['identifiers', 'A-1,B-2'],
      ['identifiersType', 'SKU'],
      ['includedData', 'summaries,fulfillmentAvailability'],
      ['pageSize', '20'],
      ['issueLocale', 'pt_BR'],
    ]);
    expect(MAX_SKUS_POR_BUSCA).toBe(20);
  });

  it.each<[string, readonly string[]]>([
    ['21 SKUs', skus(21)],
    ['an empty list', []],
    ['a duplicate', ['A-1', 'B-2', 'A-1']],
    ['a comma SKU', ['A-1', 'B,2']],
    ['a space SKU', ['A-1', 'B 2']],
    ['a 41-code-point SKU', ['x'.repeat(41)]],
    ['an empty SKU', ['']],
  ])('★ refuses %s (sku), nothing read or sent', async (_caso, lista) => {
    const f = mockFetch(() => json(buscaListings200));
    const { c, obterCredencial } = leitor(f);
    const err = await falha(
      buscarListingsAmazon(c, { sellerId: SELLER, skus: lista, incluir: TODOS }),
    );
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({ motivo: 'sku', operacao: OPERACAO_BUSCAR_LISTINGS });
    expect(f).not.toHaveBeenCalled();
    expect(obterCredencial).not.toHaveBeenCalled();
  });

  it('★ NEAR-MISS: exactly 20 distinct SKUs are sent', async () => {
    const f = mockFetch(() => json(buscaListings200));
    await buscarListingsAmazon(leitor(f).c, { sellerId: SELLER, skus: skus(20), incluir: TODOS });
    expect(requisicao(f).url.searchParams.get('identifiers')).toBe(skus(20).join(','));
  });

  it('★ truncada is true for the sandbox page: numberOfResults 3, one item and a nextToken', async () => {
    const r = await buscarListingsAmazon(leitor(mockFetch(() => json(buscaListings200))).c, {
      sellerId: SELLER,
      skus: ['GM-ZDPI-9B4E', 'HW-ZDPI-9B4E', 'TC-ZDPI-9B4E'],
      incluir: TODOS,
    });
    expect(r.truncada).toBe(true);
    expect(r.dados.items?.[0]?.fulfillmentAvailability?.[0]?.quantity).toBe(100);
  });

  it.each<[string, unknown, boolean]>([
    // NEAR-MISS: a complete page.
    [
      '20 asked, 20 items, no token',
      { numberOfResults: 20, items: skus(20).map((sku) => ({ sku })) },
      false,
    ],
    ['an empty complete page', { numberOfResults: 0, items: [] }, false],
    [
      'a count that differs from the items',
      { numberOfResults: 21, items: skus(20).map((sku) => ({ sku })) },
      true,
    ],
    [
      'a nextToken alone',
      { numberOfResults: 1, items: [{ sku: 'A-1' }], pagination: { nextToken: 't' } },
      true,
    ],
    [
      'an empty nextToken',
      { numberOfResults: 1, items: [{ sku: 'A-1' }], pagination: { nextToken: '' } },
      true,
    ],
    ['no count at all', { items: [{ sku: 'A-1' }] }, true],
    [
      'a null nextToken (absent)',
      { numberOfResults: 1, items: [{ sku: 'A-1' }], pagination: { nextToken: null } },
      false,
    ],
    [
      'a previousToken only (the last page)',
      { numberOfResults: 1, items: [{ sku: 'A-1' }], pagination: { previousToken: 'p' } },
      false,
    ],
  ])('★ truncada of a page with %s', async (_caso, corpo, esperado) => {
    const r = await buscarListingsAmazon(leitor(mockFetch(() => json(corpo))).c, {
      sellerId: SELLER,
      skus: ['A-1'],
      incluir: TODOS,
    });
    expect(r.truncada).toBe(esperado);
  });

  it('returns the applied rate limit of the answer', async () => {
    const f = mockFetch(() => json(buscaListings200, 200, { 'x-amzn-ratelimit-limit': '5.0' }));
    const r = await buscarListingsAmazon(leitor(f).c, {
      sellerId: SELLER,
      skus: ['A-1'],
      incluir: TODOS,
    });
    expect(r.limiteTaxa).toBe(5);
  });

  it('the search schema is tolerant: items and the count may be absent', () => {
    expect(buscaListingsAmazonSchema.safeParse({}).success).toBe(true);
    expect(buscaListingsAmazonSchema.safeParse({ numberOfResults: '3', items: [] }).success).toBe(
      true,
    );
  });
});

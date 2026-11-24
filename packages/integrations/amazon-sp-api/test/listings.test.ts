import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  caminhoValido,
  type ChamadaAmazon,
  criarClienteSpApi,
  MARKETPLACE_ID_BR,
  type OpcoesClienteSpApi,
  URL_BASE_SP_API,
} from '../src/client';
import {
  AmazonConfigError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
} from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import {
  buscaListingsAmazonSchema,
  buscarListingsAmazon,
  CAMINHO_ATRIBUTO_DISPONIBILIDADE,
  CAMINHO_ATRIBUTO_OFERTA,
  CAMINHO_LISTINGS,
  CANAL_MFN,
  DADOS_LISTING_AMAZON,
  type DadoListingAmazon,
  enviarDisponibilidadeAmazon,
  enviarOfertaAmazon,
  envioListingAmazonSchema,
  type FaixaOfertaAmazon,
  lerListingAmazon,
  listingAmazonSchema,
  MAX_SKUS_POR_BUSCA,
  MODO_ENVIO_LISTING_AMAZON,
  type ModoEnvioListingAmazon,
  MOEDA_OFERTA_BR,
  type OfertaListingAmazon,
  ofertaDoListingAmazon,
  OPERACAO_BUSCAR_LISTINGS,
  OPERACAO_ENVIAR_LISTING,
  OPERACAO_LER_LISTING,
  patchDisponibilidadeAmazon,
  patchOfertaAmazon,
  PUBLICO_OFERTA_TODOS,
  segmentoSkuAmazon,
  skuBuscavelAmazon,
  skuTemCaminhoAmazon,
  TIPO_OFERTA_LISTING_AMAZON,
  TIPO_PRODUTO_LISTING_REGEX,
  TIPO_PRODUTO_OFERTA,
  VERSAO_API_LISTINGS,
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
      'offers',
      DADOS_LISTING_AMAZON.resumos,
      DADOS_LISTING_AMAZON.issues,
    ] as unknown as readonly [DadoListingAmazon, ...DadoListingAmazon[]];
    await lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir });
    expect(requisicao(f).url.searchParams.get('includedData')).toBe('summaries,issues');
  });

  it('an includedData list with no known value is a wiring bug: a TypeError, nothing sent', async () => {
    const f = mockFetch(() => json(listing200));
    const incluir = ['offers'] as unknown as readonly [DadoListingAmazon];
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

/* -------------------------------------------------------------------------- */
/*                         The attributes dataset (read)                      */
/* -------------------------------------------------------------------------- */

describe('the attributes dataset', () => {
  it('★ attributes is asked by its constant, joined in the constants’ order', async () => {
    expect(DADOS_LISTING_AMAZON.atributos).toBe('attributes');
    const f = mockFetch(() => json(listing200));
    await lerListingAmazon(leitor(f).c, {
      sellerId: SELLER,
      sku: SKU,
      incluir: [
        DADOS_LISTING_AMAZON.issues,
        DADOS_LISTING_AMAZON.atributos,
        DADOS_LISTING_AMAZON.resumos,
      ],
    });
    expect(requisicao(f).url.searchParams.get('includedData')).toBe('summaries,attributes,issues');
  });

  it('★ NEAR-MISS: a read that does not ask for attributes never sends it', async () => {
    const f = mockFetch(() => json(listing200));
    await lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir: TODOS });
    expect(requisicao(f).url.searchParams.get('includedData')).toBe(
      'summaries,fulfillmentAvailability,relationships,issues',
    );
  });

  it('★ a listing with no attributes and one with unknown attributes both parse, kept as sent', () => {
    expect(listingAmazonSchema.parse({ sku: 'x' }).attributes).toBeUndefined();
    const desconhecidos = {
      item_name: [{ value: 'x', language_tag: 'pt_BR', marketplace_id: MARKETPLACE_ID_BR }],
      purchasable_offer: 'não é uma lista',
      outro: { a: [1, 2] },
    };
    expect(listingAmazonSchema.parse({ sku: 'x', attributes: desconhecidos }).attributes).toEqual(
      desconhecidos,
    );
    expect(listingAmazonSchema.safeParse({ sku: 'x', attributes: null }).success).toBe(true);
    const busca = buscaListingsAmazonSchema.parse({
      numberOfResults: 1,
      items: [{ sku: 'x', attributes: desconhecidos }],
    });
    expect(busca.items?.[0]?.attributes).toEqual(desconhecidos);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The patch builders                            */
/* -------------------------------------------------------------------------- */

/** Refused by a builder: the thrown config error, or a failure when nothing was thrown. */
function recusa(f: () => unknown): AmazonConfigError {
  try {
    f();
  } catch (e) {
    if (e instanceof AmazonConfigError) return e;
    throw e;
  }
  throw new Error('esperava uma recusa');
}

const FAIXA: FaixaOfertaAmazon = { base: 129.9, minimo: 119.9, maximo: 129.9 };

/** The offer patch as a literal, key for key (one element, three selectors, three prices). */
const patchOfertaLiteral = (base: number, minimo: number, maximo: number) => ({
  op: 'merge',
  path: '/attributes/purchasable_offer',
  value: [
    {
      marketplace_id: 'A2Q3Y263D00KWC',
      currency: 'BRL',
      audience: 'ALL',
      our_price: [{ schedule: [{ value_with_tax: base }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: minimo }] }],
      maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: maximo }] }],
    },
  ],
});

describe('patchDisponibilidadeAmazon', () => {
  it('★ is EXACTLY the stock merge, and the PATCH helper sends exactly it', async () => {
    expect(patchDisponibilidadeAmazon(7)).toStrictEqual(corpoEstoque(7).patches[0]);
    const f = mockFetch(() => json(envioListing200Aceito));
    await enviarDisponibilidadeAmazon(escritor(f).c, { sellerId: SELLER, sku: SKU, quantidade: 7 });
    expect(corpoEnviado(f)).toStrictEqual({
      productType: 'PRODUCT',
      patches: [patchDisponibilidadeAmazon(7)],
    });
    // NEAR-MISS: another quantity is another patch.
    expect(corpoEnviado(f)).not.toStrictEqual({
      productType: 'PRODUCT',
      patches: [patchDisponibilidadeAmazon(8)],
    });
  });

  it('★ its bytes: the key order a feed document serialises is fixed', () => {
    expect(JSON.stringify(patchDisponibilidadeAmazon(3))).toBe(
      '{"op":"merge","path":"/attributes/fulfillment_availability","value":[{"fulfillment_channel_code":"DEFAULT","quantity":3}]}',
    );
  });

  it('★ the stock PATCH body’s bytes did not move with the builder', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    await enviarDisponibilidadeAmazon(escritor(f).c, { sellerId: SELLER, sku: SKU, quantidade: 7 });
    expect(requisicao(f).init.body).toBe(
      '{"productType":"PRODUCT","patches":[{"op":"merge","path":"/attributes/fulfillment_availability","value":[{"fulfillment_channel_code":"DEFAULT","quantity":7}]}]}',
    );
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY])(
    '★ refuses %s (quantidade), labelled as the builder',
    (quantidade) => {
      expect(recusa(() => patchDisponibilidadeAmazon(quantidade))).toMatchObject({
        motivo: 'quantidade',
        operacao: 'patchDisponibilidadeAmazon',
        refCredencial: null,
      });
    },
  );

  it('NEAR-MISS: 0 and the largest safe integer are built', () => {
    expect(patchDisponibilidadeAmazon(0).value).toStrictEqual([
      { fulfillment_channel_code: 'DEFAULT', quantity: 0 },
    ]);
    expect(patchDisponibilidadeAmazon(Number.MAX_SAFE_INTEGER).value).toStrictEqual([
      { fulfillment_channel_code: 'DEFAULT', quantity: Number.MAX_SAFE_INTEGER },
    ]);
  });
});

describe('patchOfertaAmazon: the body', () => {
  it('★ equals, key for key, ONE merge of the BR/BRL/ALL element with the three prices', () => {
    expect(patchOfertaAmazon(FAIXA)).toStrictEqual(patchOfertaLiteral(129.9, 119.9, 129.9));
  });

  it('★ its bytes: the key order a feed document serialises is fixed', () => {
    expect(JSON.stringify(patchOfertaAmazon({ base: 10, minimo: 9.5, maximo: 12.25 }))).toBe(
      '{"op":"merge","path":"/attributes/purchasable_offer","value":[{"marketplace_id":"A2Q3Y263D00KWC","currency":"BRL","audience":"ALL","our_price":[{"schedule":[{"value_with_tax":10}]}],"minimum_seller_allowed_price":[{"schedule":[{"value_with_tax":9.5}]}],"maximum_seller_allowed_price":[{"schedule":[{"value_with_tax":12.25}]}]}]}',
    );
  });

  const elemento = patchOfertaLiteral(129.9, 119.9, 129.9).value[0];
  const comElemento = (e: Record<string, unknown>) => ({
    ...patchOfertaLiteral(129.9, 119.9, 129.9),
    value: [e],
  });
  const sem = (chave: string) => {
    const e: Record<string, unknown> = { ...elemento };
    delete e[chave];
    return comElemento(e);
  };
  it.each<[string, unknown]>([
    [
      'op replace (it drops every element and sub-attribute the body omits)',
      { ...patchOfertaLiteral(129.9, 119.9, 129.9), op: 'replace' },
    ],
    ['marketplace_id dropped', sem('marketplace_id')],
    ['currency dropped', sem('currency')],
    ['audience dropped', sem('audience')],
    ['a currency other than BRL', comElemento({ ...elemento, currency: 'USD' })],
    ['another store', comElemento({ ...elemento, marketplace_id: 'ATVPDKIKX0DER' })],
    ['a business audience', comElemento({ ...elemento, audience: 'B2B' })],
    ['the floor omitted', sem('minimum_seller_allowed_price')],
    ['the ceiling omitted', sem('maximum_seller_allowed_price')],
    [
      'an extra discounted_price',
      comElemento({ ...elemento, discounted_price: [{ schedule: [{ value_with_tax: 99 }] }] }),
    ],
    ['the floor and the price swapped', patchOfertaLiteral(119.9, 129.9, 129.9)],
    [
      'another path',
      { ...patchOfertaLiteral(129.9, 119.9, 129.9), path: '/attributes/list_price' },
    ],
  ])('★ NEAR-MISS: %s is refused by the pin', (_caso, quase) => {
    expect(patchOfertaAmazon(FAIXA)).not.toStrictEqual(quase);
  });

  it('the constants are the offer body’s', () => {
    expect(CAMINHO_ATRIBUTO_OFERTA).toBe('/attributes/purchasable_offer');
    expect(MOEDA_OFERTA_BR).toBe('BRL');
    expect(PUBLICO_OFERTA_TODOS).toBe('ALL');
    expect(MARKETPLACE_ID_BR).toBe('A2Q3Y263D00KWC');
    expect(MODO_ENVIO_LISTING_AMAZON).toStrictEqual({ validacao: 'VALIDATION_PREVIEW' });
    expect(VERSAO_API_LISTINGS).toBe('2021-08-01');
    expect(CAMINHO_LISTINGS).toContain(`/${VERSAO_API_LISTINGS}/`);
  });
});

describe('patchOfertaAmazon: the refusals', () => {
  it.each<[string, FaixaOfertaAmazon]>([
    ['minimo > base', { base: 10, minimo: 10.01, maximo: 12 }],
    ['base > maximo', { base: 12.01, minimo: 10, maximo: 12 }],
    ['a 3-decimal base', { base: 10.005, minimo: 10, maximo: 11 }],
    ['a 3-decimal floor', { base: 11, minimo: 10.005, maximo: 12 }],
    ['a 3-decimal ceiling', { base: 11, minimo: 10, maximo: 12.005 }],
    ['a zero floor', { base: 10, minimo: 0, maximo: 12 }],
    ['all three zero', { base: 0, minimo: 0, maximo: 0 }],
    ['a negative floor', { base: 10, minimo: -1, maximo: 12 }],
    ['a NaN base', { base: Number.NaN, minimo: 1, maximo: 12 }],
    ['an infinite ceiling', { base: 10, minimo: 1, maximo: Number.POSITIVE_INFINITY }],
    ['a negative infinite floor', { base: 10, minimo: Number.NEGATIVE_INFINITY, maximo: 12 }],
    ['a quoted base (a cast)', { base: '10' as unknown as number, minimo: 1, maximo: 12 }],
  ])('★ %s is AmazonConfigError(oferta), labelled as the builder', (_caso, faixa) => {
    expect(recusa(() => patchOfertaAmazon(faixa))).toMatchObject({
      motivo: 'oferta',
      operacao: 'patchOfertaAmazon',
      refCredencial: null,
    });
  });

  it.each<[string, FaixaOfertaAmazon]>([
    ['0.01 everywhere', { base: 0.01, minimo: 0.01, maximo: 0.01 }],
    ['one decimal', { base: 10.1, minimo: 10.1, maximo: 10.2 }],
    ['base === minimo === maximo', { base: 129.9, minimo: 129.9, maximo: 129.9 }],
    ['a two-decimal floor below a whole price', { base: 11, minimo: 10.01, maximo: 12 }],
    ['the floor one centavo below', { base: 10.01, minimo: 10, maximo: 10.01 }],
  ])('★ NEAR-MISS: %s is built, each price sent as given', (_caso, faixa) => {
    expect(patchOfertaAmazon(faixa)).toStrictEqual(
      patchOfertaLiteral(faixa.base, faixa.minimo, faixa.maximo),
    );
  });
});

describe('TIPO_PRODUTO_LISTING_REGEX', () => {
  it.each<[string, boolean]>([
    ['PRODUCT', true],
    ['LUGGAGE', true],
    ['A', true],
    ['HOME_BED_AND_BATH', true],
    ['A1_2', true],
    [`A${'B'.repeat(63)}`, true],
    [`A${'B'.repeat(64)}`, false],
    ['luggage', false],
    ['Luggage', false],
    ['1ABC', false],
    ['_ABC', false],
    [' LUGGAGE', false],
    ['LUGGAGE ', false],
    ['LUGGAGE\n', false],
    ['SHOE-X', false],
    ['ÇALÇADO', false],
    ['', false],
  ])('★ %j → %s', (tipo, valido) => {
    expect(TIPO_PRODUTO_LISTING_REGEX.test(tipo)).toBe(valido);
  });

  it('pins the grammar: no flags', () => {
    expect(TIPO_PRODUTO_LISTING_REGEX.source).toBe('^[A-Z][A-Z0-9_]{0,63}$');
    expect(TIPO_PRODUTO_LISTING_REGEX.flags).toBe('');
    expect(TIPO_PRODUTO_LISTING_REGEX.test(TIPO_PRODUTO_OFERTA)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The offer PATCH                              */
/* -------------------------------------------------------------------------- */

describe('enviarOfertaAmazon', () => {
  const entrada = {
    sellerId: SELLER,
    sku: SKU,
    faixa: FAIXA,
    tipoProduto: 'LUGGAGE',
  } as const;

  it('★ sends ONE PATCH with the offer merge under the given product type, and no mode', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const { c, eventos } = escritor(f);
    const r = await enviarOfertaAmazon(c, entrada);
    expect(f).toHaveBeenCalledTimes(1);
    expect(corpoEnviado(f)).toStrictEqual({
      productType: 'LUGGAGE',
      patches: [patchOfertaLiteral(129.9, 119.9, 129.9)],
    });
    // The bytes: the product type first, then the builder's own patch.
    expect(requisicao(f).init.body).toBe(
      `{"productType":"LUGGAGE","patches":[${JSON.stringify(patchOfertaAmazon(FAIXA))}]}`,
    );
    const { init, url } = requisicao(f);
    expect(init.method).toBe('PATCH');
    expect(url.pathname).toBe(`/listings/2021-08-01/items/${SELLER}/${SKU}`);
    // NEAR-MISS: no `mode` without `modo` (a real write), and no includedData.
    expect([...url.searchParams.entries()]).toEqual([
      ['marketplaceIds', MARKETPLACE_ID_BR],
      ['issueLocale', 'pt_BR'],
    ]);
    expect(eventos.map((e) => [e.operacao, e.metodo])).toEqual([
      [OPERACAO_ENVIAR_LISTING, 'PATCH'],
    ]);
    expect(r.dados).toMatchObject({ status: 'ACCEPTED' });
  });

  it('★ mode=VALIDATION_PREVIEW only with modo', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    await enviarOfertaAmazon(escritor(f).c, {
      ...entrada,
      modo: MODO_ENVIO_LISTING_AMAZON.validacao,
    });
    expect([...requisicao(f).url.searchParams.entries()]).toEqual([
      ['marketplaceIds', MARKETPLACE_ID_BR],
      ['issueLocale', 'pt_BR'],
      ['mode', 'VALIDATION_PREVIEW'],
    ]);
    expect(corpoEnviado(f)).toStrictEqual({
      productType: 'LUGGAGE',
      patches: [patchOfertaLiteral(129.9, 119.9, 129.9)],
    });
  });

  it('★ the body and the query are built from the constants, never the caller’s object', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const comExtras = {
      ...entrada,
      // Extra keys a caller could hand in: none may ride along.
      op: 'replace',
      mode: 'VALIDATION_PREVIEW',
      marketplace_id: 'ATVPDKIKX0DER',
      currency: 'USD',
      discounted_price: 1,
      includedData: 'identifiers',
      faixa: { ...FAIXA, discounted_price: 99, audience: 'B2B' },
    };
    await enviarOfertaAmazon(escritor(f).c, comExtras);
    expect(corpoEnviado(f)).toStrictEqual({
      productType: 'LUGGAGE',
      patches: [patchOfertaLiteral(129.9, 119.9, 129.9)],
    });
    expect(requisicao(f).url.searchParams.has('mode')).toBe(false);
    expect(requisicao(f).url.searchParams.has('includedData')).toBe(false);
  });

  it.each(['luggage', 'Luggage', '', ' LUGGAGE', 'LUGGAGE-X', `A${'B'.repeat(64)}`])(
    '★ a product type outside the grammar is refused (tipo-produto), nothing read or sent: %j',
    async (tipoProduto) => {
      const f = mockFetch(() => json(envioListing200Aceito));
      const { c, obterCredencial, eventos } = escritor(f);
      const err = await falha(enviarOfertaAmazon(c, { ...entrada, tipoProduto }));
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect(err).toMatchObject({ motivo: 'tipo-produto', operacao: OPERACAO_ENVIAR_LISTING });
      expect(f).not.toHaveBeenCalled();
      expect(obterCredencial).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
    },
  );

  it('★ a product type that is not a string is refused (tipo-produto), even one a regex would coerce to a valid name', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    for (const tipoProduto of [['LUGGAGE'], null, 1] as unknown as string[]) {
      const err = await falha(enviarOfertaAmazon(escritor(f).c, { ...entrada, tipoProduto }));
      expect(err, String(tipoProduto)).toMatchObject({ motivo: 'tipo-produto' });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('★ an invalid range is refused (oferta) before the product type and the path, nothing sent', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const { c, obterCredencial } = escritor(f);
    const err = await falha(
      enviarOfertaAmazon(c, {
        sellerId: '',
        sku: 'a/b',
        tipoProduto: 'luggage',
        faixa: { base: 10, minimo: 11, maximo: 12 },
      }),
    );
    expect(err).toMatchObject({ motivo: 'oferta', operacao: OPERACAO_ENVIAR_LISTING });
    expect(f).not.toHaveBeenCalled();
    expect(obterCredencial).not.toHaveBeenCalled();
  });

  it('a mode outside the closed set is a wiring bug: a TypeError, nothing sent', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    const modo = 'OUTRO' as unknown as ModoEnvioListingAmazon;
    const err = await falha(enviarOfertaAmazon(escritor(f).c, { ...entrada, modo }));
    expect(err).toBeInstanceOf(TypeError);
    expect(f).not.toHaveBeenCalled();
  });

  it('a SKU or seller id with no path is refused before fetch', async () => {
    const f = mockFetch(() => json(envioListing200Aceito));
    expect(
      await falha(enviarOfertaAmazon(escritor(f).c, { ...entrada, sku: 'a/b' })),
    ).toMatchObject({ motivo: 'sku' });
    expect(
      await falha(enviarOfertaAmazon(escritor(f).c, { ...entrada, sellerId: '..' })),
    ).toMatchObject({ motivo: 'caminho' });
    expect(f).not.toHaveBeenCalled();
  });

  it('★ answers as the stock helper does: the INVALID submission parses, a 429 and a 400 are the client’s errors', async () => {
    const r = await enviarOfertaAmazon(
      escritor(mockFetch(() => json(envioListing200Invalido))).c,
      entrada,
    );
    expect(r.dados.status).toBe('INVALID');
    expect(r.dados.issues?.map((i) => i.code)).toEqual(['90000900']);
    expect(r.dados.issues?.[0]?.categories).toEqual(['INVALID_ATTRIBUTE', 'LISTING']);

    const lento = await falha(
      enviarOfertaAmazon(escritor(mockFetch(() => texto('', 429))).c, entrada),
    );
    expect(lento).toBeInstanceOf(AmazonThrottleError);
    const ruim = await falha(
      enviarOfertaAmazon(escritor(mockFetch(() => texto('', 400))).c, entrada),
    );
    expect(ruim).toBeInstanceOf(AmazonHttpError);
    expect(ruim).toMatchObject({ status: 400, operacao: OPERACAO_ENVIAR_LISTING });
    const semSku = await falha(
      enviarOfertaAmazon(escritor(mockFetch(() => json({ status: 'ACCEPTED' }))).c, entrada),
    );
    expect(semSku).toBeInstanceOf(AmazonSchemaError);
  });
});

describe('the caller’s AbortSignal reaches the client', () => {
  it.each<[string, (f: typeof globalThis.fetch, sinal: AbortSignal) => Promise<unknown>]>([
    [
      'lerListingAmazon',
      (f, sinal) =>
        lerListingAmazon(leitor(f).c, { sellerId: SELLER, sku: SKU, incluir: TODOS }, sinal),
    ],
    [
      'buscarListingsAmazon',
      (f, sinal) =>
        buscarListingsAmazon(leitor(f).c, { sellerId: SELLER, skus: [SKU], incluir: TODOS }, sinal),
    ],
    [
      'enviarDisponibilidadeAmazon',
      (f, sinal) =>
        enviarDisponibilidadeAmazon(
          escritor(f).c,
          { sellerId: SELLER, sku: SKU, quantidade: 3 },
          sinal,
        ),
    ],
    [
      'enviarOfertaAmazon',
      (f, sinal) =>
        enviarOfertaAmazon(
          escritor(f).c,
          { sellerId: SELLER, sku: SKU, faixa: FAIXA, tipoProduto: 'LUGGAGE' },
          sinal,
        ),
    ],
  ])(
    '★ %s: a signal already aborted sends nothing, and its reason comes back',
    async (_nome, chamar) => {
      const controller = new AbortController();
      controller.abort(new RangeError('motivo do chamador'));
      const f = mockFetch(() => json(envioListing200Aceito));
      await expect(chamar(f, controller.signal)).rejects.toBe(controller.signal.reason);
      expect(f).not.toHaveBeenCalled();
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                               The offer read                               */
/* -------------------------------------------------------------------------- */

/**
 * The reader's inputs are INLINE literals: Amazon publishes no read example of a
 * `purchasable_offer`, so they are the documented WRITE shape (Amazon's
 * purchasable-offer guide, with the BR selectors) plus the variants a read may
 * take. No wire fixture.
 */
describe('ofertaDoListingAmazon', () => {
  const AGORA = Date.parse('2026-06-01T00:00:00Z');
  const preco = (valor: unknown) => [{ schedule: [{ value_with_tax: valor }] }];
  const nossa = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    marketplace_id: 'A2Q3Y263D00KWC',
    currency: 'BRL',
    audience: 'ALL',
    our_price: preco(129.9),
    minimum_seller_allowed_price: preco(119.9),
    maximum_seller_allowed_price: preco(139.9),
    ...extra,
  });
  const ler = (...elementos: unknown[]) =>
    ofertaDoListingAmazon({ purchasable_offer: elementos }, AGORA);
  const NADA = { temPrecoComDesconto: false, temOfertaB2B: false, fechada: false };
  const lida = (base: number, minimo: number | null, maximo: number | null, extra = {}) => ({
    tipo: TIPO_OFERTA_LISTING_AMAZON.lida,
    base,
    minimo,
    maximo,
    ...NADA,
    ...extra,
  });
  const so = (tipo: OfertaListingAmazon['tipo'], extra = {}) => ({ tipo, ...NADA, ...extra });

  it('★ the documented write shape reads back as its own range', () => {
    expect(ler(nossa())).toStrictEqual(lida(129.9, 119.9, 139.9));
    const escrito = patchOfertaAmazon(FAIXA).value;
    expect(ofertaDoListingAmazon({ purchasable_offer: escrito }, AGORA)).toStrictEqual(
      lida(129.9, 119.9, 129.9),
    );
  });

  it('★ ours is chosen by its selectors when a business element comes first (NEAR-MISS: index 0 is never read)', () => {
    const b2b = { ...nossa({ audience: 'B2B' }), our_price: preco(99) };
    const r = ler(b2b, nossa());
    expect(r).toStrictEqual(lida(129.9, 119.9, 139.9, { temOfertaB2B: true }));
    expect(r).not.toMatchObject({ base: 99 });
    const outraLoja = {
      ...nossa({ marketplace_id: 'ATVPDKIKX0DER', currency: 'USD' }),
      our_price: preco(50),
    };
    expect(ler(outraLoja, nossa())).toStrictEqual(lida(129.9, 119.9, 139.9));
  });

  it.each<[unknown, number]>([
    ['129.90', 129.9],
    [130, 130],
    ['130', 130],
    [0.01, 0.01],
  ])('★ a value_with_tax of %j reads %s (the shared wire-number reader)', (valor, lido) => {
    expect(ler(nossa({ our_price: preco(valor) }))).toMatchObject({
      tipo: TIPO_OFERTA_LISTING_AMAZON.lida,
      base: lido,
    });
  });

  it.each<[string, unknown]>([
    ['"abc"', 'abc'],
    ['a decimal comma', '129,90'],
    ['an exponent string', '1e3'],
    ['zero', 0],
    ['a negative', -1],
    ['null', null],
    ['an object', { amount: 1 }],
  ])('★ our_price of %s is ilegivel', (_caso, valor) => {
    expect(ler(nossa({ our_price: preco(valor) }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel),
    );
  });

  it.each<[string, unknown]>([
    ['two schedules', [{ schedule: [{ value_with_tax: 1 }, { value_with_tax: 2 }] }]],
    ['two entries', [...preco(1), ...preco(2)]],
    ['an empty list', []],
    ['no schedule', [{}]],
    ['an empty schedule', [{ schedule: [] }]],
    ['a bare number', 129.9],
    ['an object, not a list', { schedule: [{ value_with_tax: 1 }] }],
    ['a schedule entry that is not an object', [{ schedule: [129.9] }]],
    // Only `value_with_tax` is the price: another amount key is never read as one.
    ['a schedule entry with value but no value_with_tax', [{ schedule: [{ value: 129.9 }] }]],
  ])('★ an our_price with %s is ilegivel', (_caso, ourPrice) => {
    expect(ler(nossa({ our_price: ourPrice }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel),
    );
  });

  it('an element without our_price is ilegivel', () => {
    const { our_price: _omitido, ...semPreco } = nossa();
    expect(ler(semPreco)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ilegivel));
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['an array', [{ purchasable_offer: [nossa()] }]],
    ['a string', 'attributes'],
    ['a number', 1],
  ])('★ attributes %s is ilegivel (the dataset was asked for)', (_caso, attributes) => {
    expect(ofertaDoListingAmazon(attributes, AGORA)).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel),
    );
  });

  it('★ NEAR-MISS: {} (no purchasable_offer) is ausente, and so is an empty list', () => {
    expect(ofertaDoListingAmazon({}, AGORA)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ausente));
    expect(ofertaDoListingAmazon({ item_name: [] }, AGORA)).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ausente),
    );
    expect(ler()).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ausente));
  });

  it('an inherited purchasable_offer is not read: only an own key counts', () => {
    const herdado = Object.create({ purchasable_offer: [nossa()] }) as object;
    expect(ofertaDoListingAmazon(herdado, AGORA)).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ausente),
    );
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an object', { 0: nossa() }],
    ['a string', 'x'],
  ])('★ a purchasable_offer that is %s (not a list) is ilegivel', (_caso, valor) => {
    expect(ofertaDoListingAmazon({ purchasable_offer: valor }, AGORA)).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel),
    );
  });

  it('★ one element with no marketplace_id and no currency is ilegivel (it may be ours)', () => {
    const { marketplace_id: _m, currency: _c, audience: _a, ...semSeletores } = nossa();
    expect(ler(semSeletores)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ilegivel));
  });

  it('★ NEAR-MISS: one element of another store and currency is ausente', () => {
    expect(ler(nossa({ marketplace_id: 'ATVPDKIKX0DER', currency: 'USD' }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ausente),
    );
  });

  it.each<[string, unknown]>([
    ['our store without currency', { marketplace_id: 'A2Q3Y263D00KWC', our_price: preco(1) }],
    ['our currency without store', { currency: 'BRL', audience: 'ALL', our_price: preco(1) }],
    ['a numeric marketplace_id', nossa({ marketplace_id: 1 })],
    ['a numeric audience', nossa({ audience: 7 })],
    // Only an absent or null audience defaults to ALL: a falsy non-string is unreadable.
    ['a false audience', nossa({ audience: false })],
    ['a zero audience', nossa({ audience: 0 })],
    ['a null element', null],
    ['a number element', 3],
    ['a list element', [nossa()]],
  ])('★ an element with %s cannot be ruled out: ilegivel when alone', (_caso, elemento) => {
    expect(ler(elemento)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ilegivel));
  });

  it.each<[string, unknown]>([
    ['another store without currency', { marketplace_id: 'ATVPDKIKX0DER', our_price: preco(1) }],
    ['another currency without store', { currency: 'USD', our_price: preco(1) }],
  ])(
    'NEAR-MISS: an element whose one explicit selector names another is ausente: %s',
    (_caso, e) => {
      expect(ler(e)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ausente));
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['a lower-case currency', { currency: 'brl' }],
    ['a padded currency', { currency: 'BRL ' }],
    ['an empty currency', { currency: '' }],
    ['a lower-case audience', { audience: 'all' }],
    ['an empty audience', { audience: '' }],
    ['a lower-case store', { marketplace_id: 'a2q3y263d00kwc' }],
    ['a padded store', { marketplace_id: ' A2Q3Y263D00KWC' }],
    ['an empty store', { marketplace_id: '' }],
  ])(
    '★ a selector outside the guide’s code form rules nothing out (%s): ilegivel alone, ambigua beside ours, never a business offer',
    (_caso, extra) => {
      const talvez = nossa({ ...extra, our_price: preco(5) });
      expect(ler(talvez)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ilegivel));
      expect(ler(nossa(), talvez)).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ambigua));
      expect(ler(talvez, nossa())).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ambigua));
    },
  );

  it.each<[string, Record<string, unknown>, boolean]>([
    ['another currency', { currency: 'USD' }, false],
    ['another store', { marketplace_id: 'ATVPDKIKX0DER' }, false],
    ['a business audience', { audience: 'B2B' }, true],
    ['an audience code with an underscore', { audience: 'B2B_X' }, true],
  ])(
    '★ NEAR-MISS: a selector in the code form naming another rules the element out (%s)',
    (_caso, extra, b2b) => {
      const outro = nossa({ ...extra, our_price: preco(5) });
      expect(ler(outro)).toStrictEqual(
        so(TIPO_OFERTA_LISTING_AMAZON.ausente, { temOfertaB2B: b2b }),
      );
      expect(ler(nossa(), outro)).toStrictEqual(lida(129.9, 119.9, 139.9, { temOfertaB2B: b2b }));
    },
  );

  it('★ two elements matching ours are ambigua, whatever their prices', () => {
    expect(ler(nossa(), nossa())).toStrictEqual(so(TIPO_OFERTA_LISTING_AMAZON.ambigua));
    expect(ler(nossa(), nossa({ our_price: preco(1) }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ambigua),
    );
  });

  it('★ ours beside an element that may also be ours is ambigua (NEAR-MISS: beside another store’s, it is read)', () => {
    expect(ler(nossa(), { our_price: preco(1) })).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ambigua),
    );
    expect(ler(nossa(), nossa({ marketplace_id: 'ATVPDKIKX0DER' }))).toStrictEqual(
      lida(129.9, 119.9, 139.9),
    );
  });

  it('two elements that may be ours, and none that names ours, are ilegivel', () => {
    expect(ler({ our_price: preco(1) }, { our_price: preco(2) })).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel),
    );
  });

  it('★ an absent or null audience reads ALL (the guide’s default)', () => {
    const { audience: _a, ...semPublico } = nossa();
    expect(ler(semPublico)).toStrictEqual(lida(129.9, 119.9, 139.9));
    expect(ler(nossa({ audience: null }))).toStrictEqual(lida(129.9, 119.9, 139.9));
  });

  it('★ a business element alone is ausente, and counted', () => {
    expect(ler(nossa({ audience: 'B2B' }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ausente, { temOfertaB2B: true }),
    );
  });

  it.each<[string, Record<string, unknown>, number | null, number | null]>([
    ['the floor absent', { minimum_seller_allowed_price: undefined }, null, 139.9],
    ['the ceiling absent', { maximum_seller_allowed_price: undefined }, 119.9, null],
    ['the floor "abc"', { minimum_seller_allowed_price: preco('abc') }, null, 139.9],
    ['the floor null', { minimum_seller_allowed_price: null }, null, 139.9],
    [
      'the ceiling with two schedules',
      {
        maximum_seller_allowed_price: [
          { schedule: [{ value_with_tax: 1 }, { value_with_tax: 2 }] },
        ],
      },
      119.9,
      null,
    ],
    ['the floor zero', { minimum_seller_allowed_price: preco(0) }, null, 139.9],
  ])(
    '★ %s reads null, never a guess, and the offer is still read',
    (_caso, extra, minimo, maximo) => {
      const elemento = nossa(extra);
      for (const [k, v] of Object.entries(extra)) if (v === undefined) delete elemento[k];
      expect(ler(elemento)).toStrictEqual(lida(129.9, minimo, maximo));
    },
  );

  it.each<[string, unknown, boolean]>([
    ['a past date', { value: '2020-01-01' }, true],
    ['a past instant', { value: '2026-05-31T23:59:59Z' }, true],
    ['now itself', { value: '2026-06-01T00:00:00Z' }, true],
    ['a future date (NEAR-MISS)', { value: '2099-01-01' }, false],
    ['an unparseable date (NEAR-MISS)', { value: 'ontem' }, false],
    ['a bare string, not { value }', '2020-01-01', false],
    ['a list of { value }', [{ value: '2020-01-01' }], false],
    ['a numeric value', { value: 1 }, false],
  ])('★ end_at as %s: fechada %s, and the offer is still read', (_caso, endAt, fechada) => {
    expect(ler(nossa({ end_at: endAt }))).toStrictEqual(lida(129.9, 119.9, 139.9, { fechada }));
  });

  it('★ a discounted_price on ours is counted (NEAR-MISS: null or absent is not)', () => {
    expect(ler(nossa({ discounted_price: preco(99) }))).toStrictEqual(
      lida(129.9, 119.9, 139.9, { temPrecoComDesconto: true }),
    );
    expect(ler(nossa({ discounted_price: null }))).toStrictEqual(lida(129.9, 119.9, 139.9));
    // Another element's discount is not ours.
    expect(
      ler(nossa(), nossa({ marketplace_id: 'ATVPDKIKX0DER', discounted_price: preco(1) })),
    ).toStrictEqual(lida(129.9, 119.9, 139.9));
  });

  it('★ the discount and the closed counters are read off OURS, never off element 0', () => {
    const vencida = { discounted_price: preco(1), end_at: { value: '2020-01-01' } };
    // A business element first carries them: not ours, so not counted.
    expect(ler(nossa({ audience: 'B2B', ...vencida }), nossa())).toStrictEqual(
      lida(129.9, 119.9, 139.9, { temOfertaB2B: true }),
    );
    // Ours second carries them: counted.
    expect(ler(nossa({ audience: 'B2B' }), nossa(vencida))).toStrictEqual(
      lida(129.9, 119.9, 139.9, { temOfertaB2B: true, temPrecoComDesconto: true, fechada: true }),
    );
  });

  it('★ the business counter holds whatever the answer: ambigua and ilegivel count it too', () => {
    expect(ler(nossa(), nossa(), nossa({ audience: 'B2B' }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ambigua, { temOfertaB2B: true }),
    );
    expect(ler({ our_price: preco(1) }, nossa({ audience: 'B2B' }))).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel, { temOfertaB2B: true }),
    );
  });

  it('the counters survive an unreadable our_price on ours', () => {
    expect(
      ler(
        nossa({
          our_price: preco('x'),
          discounted_price: preco(1),
          end_at: { value: '2020-01-01' },
        }),
        nossa({ audience: 'B2B' }),
      ),
    ).toStrictEqual(
      so(TIPO_OFERTA_LISTING_AMAZON.ilegivel, {
        temPrecoComDesconto: true,
        temOfertaB2B: true,
        fechada: true,
      }),
    );
  });

  it('a parsed listing’s attributes reach the reader untouched', () => {
    const item = listingAmazonSchema.parse({
      sku: 'x',
      attributes: { purchasable_offer: [nossa()] },
    });
    expect(ofertaDoListingAmazon(item.attributes, AGORA)).toStrictEqual(lida(129.9, 119.9, 139.9));
  });

  it('is total: no input throws, and every answer is one of the four', () => {
    const tipos = new Set<string>(Object.values(TIPO_OFERTA_LISTING_AMAZON));
    const entradas: unknown[] = [
      undefined,
      null,
      0,
      'x',
      [],
      {},
      { purchasable_offer: [null, 1, 'x', [], {}, { schedule: null }] },
      { purchasable_offer: [nossa({ our_price: null, end_at: { value: null } })] },
      { purchasable_offer: [nossa({ end_at: { value: '9'.repeat(400) } })] },
      {
        purchasable_offer: [
          nossa({ our_price: [{ schedule: [{ value_with_tax: '9'.repeat(400) }] }] }),
        ],
      },
    ];
    for (const e of entradas) expect(tipos.has(ofertaDoListingAmazon(e, AGORA).tipo)).toBe(true);
  });
});

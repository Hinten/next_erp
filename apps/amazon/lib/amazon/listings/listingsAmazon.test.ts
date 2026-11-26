/**
 * The Listings Items calls (step 12, PR 12-e1; the offer patch since step 13):
 * the two reads through the REAL context over the fake db and a scripted `fetch`
 * (the forced-refresh-once rule, the "not listed" reading of the read's own
 * 404, the price read's datasets), and the two patches through a RECORDING
 * write client (exactly one PATCH, no refresh rule of their own).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one serves model shapes.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  DADOS_LISTING_AMAZON,
  type EntradaOfertaListing,
  LOCALIDADE_ISSUES_LISTINGS,
  MARKETPLACE_ID_BR,
  MODO_ENVIO_LISTING_AMAZON,
  type ModoEnvioListingAmazon,
  OPERACAO_BUSCAR_LISTINGS,
  OPERACAO_ENVIAR_LISTING,
  OPERACAO_LER_LISTING,
  type SpApiEscritaClient,
  TIPO_OFERTA_LISTING_AMAZON,
  ofertaDoListingAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { REDIGIDO } from '../core/redacao';
import { MOTIVO_ESTOQUE_AMAZON } from '../estoque/motivosEstoque';
import { AGORA_MS, SPID_A, linhasDeChamada } from '../testing/fixtures';
import { harnessImportador } from '../testing/importadorAmazon';
import {
  type ContextoDosListingsAmazon,
  INCLUIR_LEITURA_PRECO,
  NAO_LISTADO_AMAZON,
  buscarListingsNaAmazon,
  enviarDisponibilidadeNaAmazon,
  enviarOfertaComTaxaNaAmazon,
  enviarOfertaNaAmazon,
  lerListingComTaxaNaAmazon,
  lerListingNaAmazon,
} from './listingsAmazon';

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

const SKU = 'SKU-TESTE-1';
const INCLUIR = [
  DADOS_LISTING_AMAZON.resumos,
  DADOS_LISTING_AMAZON.disponibilidade,
  DADOS_LISTING_AMAZON.relacoes,
] as const;

/** A listing as the model shapes it (synthetic values). */
const LISTING = {
  sku: SKU,
  summaries: [
    { marketplaceId: MARKETPLACE_ID_BR, asin: 'B0ZZTESTE1', productType: 'PRODUCT', status: [] },
  ],
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }],
};

const erro = (code: string) => ({ errors: [{ code, message: 'x' }] });

async function contexto(...respostas: { status: number; corpo: unknown }[]) {
  const h = harnessImportador(respostas);
  return { h, contexto: await h.contexto() };
}

describe('lerListingNaAmazon — one listing', () => {
  it('★ ONE GET of the SKU’s path, the datasets as asked, the listing parsed', async () => {
    const { h, contexto: c } = await contexto({ status: 200, corpo: LISTING });
    const lido = await lerListingNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR });
    expect(lido).toMatchObject({ sku: SKU, fulfillmentAvailability: [{ quantity: 3 }] });
    expect(h.gets).toHaveLength(1);
    expect(h.gets[0]?.pathname).toBe(`${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`);
    expect(h.gets[0]?.searchParams.get('includedData')).toBe(
      'summaries,fulfillmentAvailability,relationships',
    );
    expect(h.gets[0]?.searchParams.get('marketplaceIds')).toBe(MARKETPLACE_ID_BR);
    expect(h.lwa).toBe(0);
  });

  it('★ the read’s own 404 ⇒ "nao-listado", the listing gate’s input token', async () => {
    const { h, contexto: c } = await contexto({ status: 404, corpo: erro('NOT_FOUND') });
    await expect(
      lerListingNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
    ).resolves.toBe(NAO_LISTADO_AMAZON);
    expect(h.gets).toHaveLength(1);
    expect(NAO_LISTADO_AMAZON).toBe(MOTIVO_ESTOQUE_AMAZON.naoListado);
  });

  it.each<[string, number, (e: unknown) => boolean]>([
    ['a 400', 400, (e) => e instanceof AmazonHttpError && e.status === 400],
    ['a 429', 429, (e) => e instanceof AmazonThrottleError],
    ['a 503', 503, (e) => e instanceof AmazonHttpError && e.status === 503 && e.transitorio],
  ])(
    'NEAR-MISS: %s is no reading — thrown untouched, with its own class',
    async (_c, status, eh) => {
      const { contexto: c } = await contexto({ status, corpo: erro('X') });
      await expect(
        lerListingNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
      ).rejects.toSatisfy(eh);
    },
  );

  it('★ NEAR-MISS: a 404 that is NOT the SP-API’s answer to getListingsItem (an LWA exchange’s, another operation’s) is thrown, never "nao-listado"', async () => {
    const base = {
      metodo: 'GET',
      caminho: '/x',
      correlationId: 'corr-teste',
      requestIdAmazon: null,
      refCredencial: 'ref-teste',
      status: 404,
    } as const;
    for (const falha of [
      new AmazonNotFoundError({ ...base, destino: 'lwa', operacao: OPERACAO_LER_LISTING }),
      new AmazonNotFoundError({ ...base, destino: 'sp-api', operacao: OPERACAO_BUSCAR_LISTINGS }),
      new AmazonHttpError({
        ...base,
        destino: 'sp-api',
        operacao: OPERACAO_LER_LISTING,
        status: 410,
      }),
    ]) {
      const c: ContextoDosListingsAmazon = {
        cliente: { get: () => Promise.reject(falha) },
        obterAcesso: () => Promise.reject(new Error('teste: nenhuma renovação')),
      };
      await expect(
        lerListingNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
      ).rejects.toBe(falha);
    }
  });

  it('★ a 401 ⇒ EXACTLY one forced refresh and one more read', async () => {
    const { h, contexto: c } = await contexto(
      { status: 401, corpo: erro('Unauthorized') },
      { status: 200, corpo: LISTING },
    );
    await expect(
      lerListingNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
    ).resolves.toMatchObject({ sku: SKU });
    expect(h.gets).toHaveLength(2);
    expect(h.lwa).toBe(1);
  });

  it('a SKU no path can carry is refused by the package before anything is sent', async () => {
    const { h, contexto: c } = await contexto({ status: 200, corpo: LISTING });
    await expect(
      lerListingNaAmazon(c, { sellerId: SPID_A, sku: 'a/b', incluir: INCLUIR }),
    ).rejects.toMatchObject({ name: 'AmazonConfigError' });
    expect(h.gets).toEqual([]);
  });
});

describe('buscarListingsNaAmazon — up to 20 SKUs', () => {
  it('★ ONE GET of the SKUs as identifiers; the items and the package’s truncation reading', async () => {
    const { h, contexto: c } = await contexto({
      status: 200,
      corpo: { numberOfResults: 2, items: [LISTING, { ...LISTING, sku: 'SKU-TESTE-2' }] },
    });
    const busca = await buscarListingsNaAmazon(c, {
      sellerId: SPID_A,
      skus: [SKU, 'SKU-TESTE-2'],
      incluir: INCLUIR,
    });
    expect(busca.itens.map((i) => i.sku)).toEqual([SKU, 'SKU-TESTE-2']);
    expect(busca.truncada).toBe(false);
    expect(h.gets).toHaveLength(1);
    expect(h.gets[0]?.pathname).toBe(`${CAMINHO_LISTINGS}/${SPID_A}`);
    expect(h.gets[0]?.searchParams.get('identifiers')).toBe(`${SKU},SKU-TESTE-2`);
  });

  it('NEAR-MISS: a page holding fewer items than it counts is truncada; no items at all reads as none', async () => {
    const { contexto: c } = await contexto({ status: 200, corpo: { numberOfResults: 3 } });
    await expect(
      buscarListingsNaAmazon(c, { sellerId: SPID_A, skus: [SKU], incluir: INCLUIR }),
    ).resolves.toEqual({ itens: [], truncada: true, limiteTaxa: null });
  });

  it('★ the rate Amazon applied to the answer (x-amzn-RateLimit-Limit) is carried; none ⇒ null', async () => {
    const c: ContextoDosListingsAmazon = {
      cliente: {
        get: () =>
          Promise.resolve({
            dados: { numberOfResults: 1, items: [LISTING] },
            status: 200,
            requestIdAmazon: null,
            limiteTaxa: 4.5,
          } as never),
      },
      obterAcesso: () => Promise.reject(new Error('teste: nenhuma renovação')),
    };
    await expect(
      buscarListingsNaAmazon(c, { sellerId: SPID_A, skus: [SKU], incluir: INCLUIR }),
    ).resolves.toMatchObject({ truncada: false, limiteTaxa: 4.5 });
  });

  it('a 404 of the SEARCH is thrown, never read as "nao-listado"', async () => {
    const { contexto: c } = await contexto({ status: 404, corpo: erro('NOT_FOUND') });
    await expect(
      buscarListingsNaAmazon(c, { sellerId: SPID_A, skus: [SKU], incluir: INCLUIR }),
    ).rejects.toBeInstanceOf(AmazonNotFoundError);
  });

  it('a 401 ⇒ one forced refresh and one more search', async () => {
    const { h, contexto: c } = await contexto(
      { status: 403, corpo: erro('Unauthorized') },
      { status: 200, corpo: { numberOfResults: 1, items: [LISTING] } },
    );
    await expect(
      buscarListingsNaAmazon(c, { sellerId: SPID_A, skus: [SKU], incluir: INCLUIR }),
    ).resolves.toMatchObject({ truncada: false });
    expect(h.gets).toHaveLength(2);
    expect(h.lwa).toBe(1);
  });
});

describe('enviarDisponibilidadeNaAmazon — the engine’s `escrever`', () => {
  function escritor(resposta: () => Promise<unknown>) {
    const patch = vi.fn((..._args: unknown[]) => resposta());
    return { cliente: { patch } as unknown as SpApiEscritaClient, patch };
  }

  it('★ ONE PATCH of the stock merge: the SKU’s path, the quantity, Amazon’s answer returned', async () => {
    const dados = { sku: SKU, status: 'ACCEPTED', submissionId: 'sub-teste-1', issues: [] };
    const { cliente, patch } = escritor(() =>
      Promise.resolve({ status: 200, dados, correlationId: 'c' }),
    );
    await expect(
      enviarDisponibilidadeNaAmazon(cliente, { sellerId: SPID_A, sku: SKU, quantidade: 7 }),
    ).resolves.toEqual(dados);
    expect(patch).toHaveBeenCalledTimes(1);
    const pedido = patch.mock.calls[0]?.[0] as { caminho: string; corpo: string };
    expect(pedido.caminho).toBe(`${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`);
    expect(JSON.parse(pedido.corpo)).toEqual({
      productType: 'PRODUCT',
      patches: [
        {
          op: 'merge',
          path: '/attributes/fulfillment_availability',
          value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }],
        },
      ],
    });
  });

  it('★ a failed PATCH is thrown UNTOUCHED and never repeated here (it may have landed)', async () => {
    const corte = new Error('teste: conexão cortada');
    const { cliente, patch } = escritor(() => Promise.reject(corte));
    await expect(
      enviarDisponibilidadeNaAmazon(cliente, { sellerId: SPID_A, sku: SKU, quantidade: 7 }),
    ).rejects.toBe(corte);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('a quantity the package refuses sends nothing', async () => {
    const { cliente, patch } = escritor(() => Promise.reject(new Error('inesperado')));
    await expect(
      enviarDisponibilidadeNaAmazon(cliente, { sellerId: SPID_A, sku: SKU, quantidade: -1 }),
    ).rejects.toMatchObject({ name: 'AmazonConfigError' });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('INCLUIR_LEITURA_PRECO — the datasets of a price read (step 13)', () => {
  /** Our offer element as Amazon's purchasable-offer guide writes it (synthetic prices). */
  const OFERTA = {
    marketplace_id: MARKETPLACE_ID_BR,
    currency: 'BRL',
    audience: 'ALL',
    our_price: [{ schedule: [{ value_with_tax: 129.9 }] }],
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 119.9 }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 129.9 }] }],
  };
  const LISTING_COM_OFERTA = {
    sku: SKU,
    summaries: LISTING.summaries,
    attributes: { purchasable_offer: [OFERTA] },
    issues: [],
  };

  it('★ is EXACTLY the summaries, the attributes, the issues and the relationships, by the package’s constants', () => {
    expect(INCLUIR_LEITURA_PRECO).toEqual([
      DADOS_LISTING_AMAZON.resumos,
      DADOS_LISTING_AMAZON.atributos,
      DADOS_LISTING_AMAZON.issues,
      DADOS_LISTING_AMAZON.relacoes,
    ]);
    expect(INCLUIR_LEITURA_PRECO).toEqual(['summaries', 'attributes', 'issues', 'relationships']);
    // NEAR-MISS: a price read asks for no stock and no `offers` (no floor or ceiling there).
    expect(INCLUIR_LEITURA_PRECO).not.toContain(DADOS_LISTING_AMAZON.disponibilidade);
    expect(INCLUIR_LEITURA_PRECO).not.toContain('offers');
  });

  it('★ ONE GET asks Amazon for exactly those datasets, and the listing’s attributes reach the offer reader as Amazon sent them', async () => {
    const { h, contexto: c } = await contexto({ status: 200, corpo: LISTING_COM_OFERTA });
    const lido = await lerListingNaAmazon(c, {
      sellerId: SPID_A,
      sku: SKU,
      incluir: INCLUIR_LEITURA_PRECO,
    });
    expect(h.gets).toHaveLength(1);
    // The package joins them in its own constants' order.
    expect(h.gets[0]?.searchParams.get('includedData')).toBe(
      'summaries,attributes,relationships,issues',
    );
    if (lido === NAO_LISTADO_AMAZON) throw new Error('teste: listado');
    expect(lido.attributes).toEqual(LISTING_COM_OFERTA.attributes);
    expect(ofertaDoListingAmazon(lido.attributes, AGORA_MS)).toMatchObject({
      tipo: TIPO_OFERTA_LISTING_AMAZON.lida,
      base: 129.9,
      minimo: 119.9,
      maximo: 129.9,
    });
    // The call line's excerpt keeps the offer's shape and none of its values
    // (the deny row for `attributes.*` itself is pinned by `redacao.test.ts`).
    const chamadas = linhasDeChamada(h.log.linhas);
    expect(chamadas).toHaveLength(1);
    const trecho = String(chamadas[0]?.trechoCorpo);
    expect(trecho).toContain(`"our_price":[{"schedule":[{"value_with_tax":"${REDIGIDO}"}]}]`);
    expect(trecho).toContain(`"currency":"${REDIGIDO}"`);
    expect(trecho).not.toMatch(/129\.9|119\.9|"BRL"|"ALL"/);
  });

  it('a search asks for the same datasets', async () => {
    const { h, contexto: c } = await contexto({
      status: 200,
      corpo: { numberOfResults: 1, items: [LISTING_COM_OFERTA] },
    });
    const busca = await buscarListingsNaAmazon(c, {
      sellerId: SPID_A,
      skus: [SKU],
      incluir: INCLUIR_LEITURA_PRECO,
    });
    expect(busca.itens[0]?.attributes).toEqual(LISTING_COM_OFERTA.attributes);
    expect(h.gets[0]?.searchParams.get('includedData')).toBe(
      'summaries,attributes,relationships,issues',
    );
  });
});

describe('enviarOfertaNaAmazon — the engine’s `escrever` (step 13)', () => {
  function escritor(resposta: () => Promise<unknown>) {
    const patch = vi.fn((..._args: unknown[]) => resposta());
    return { cliente: { patch } as unknown as SpApiEscritaClient, patch };
  }
  const aceito = () =>
    Promise.resolve({
      status: 200,
      dados: { sku: SKU, status: 'ACCEPTED', submissionId: 'sub-oferta-1', issues: [] },
      correlationId: 'c',
    });
  const FAIXA = { base: 129.9, minimo: 119.9, maximo: 129.9 } as const;
  const entrada = (extra: Partial<EntradaOfertaListing> = {}): EntradaOfertaListing => ({
    sellerId: SPID_A,
    sku: SKU,
    faixa: FAIXA,
    tipoProduto: 'LUGGAGE',
    ...extra,
  });
  /** The offer body, frozen as bytes: the BR/BRL/ALL element and the three prices, one merge. */
  const CORPO_LUGGAGE =
    '{"productType":"LUGGAGE","patches":[{"op":"merge","path":"/attributes/purchasable_offer",' +
    `"value":[{"marketplace_id":"${MARKETPLACE_ID_BR}","currency":"BRL","audience":"ALL",` +
    '"our_price":[{"schedule":[{"value_with_tax":129.9}]}],' +
    '"minimum_seller_allowed_price":[{"schedule":[{"value_with_tax":119.9}]}],' +
    '"maximum_seller_allowed_price":[{"schedule":[{"value_with_tax":129.9}]}]}]}]}';

  type PedidoGravado = { caminho: string; corpo: string; query: Record<string, unknown> };

  it('★ ONE PATCH of the offer merge: the SKU’s path, the caller’s product type, the body EXACTLY as bytes, no mode; Amazon’s answer returned', async () => {
    const { cliente, patch } = escritor(aceito);
    await expect(enviarOfertaNaAmazon(cliente, entrada())).resolves.toEqual({
      sku: SKU,
      status: 'ACCEPTED',
      submissionId: 'sub-oferta-1',
      issues: [],
    });
    expect(patch).toHaveBeenCalledTimes(1);
    const pedido = patch.mock.calls[0]?.[0] as PedidoGravado;
    expect(pedido.caminho).toBe(`${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`);
    expect(pedido.corpo).toBe(CORPO_LUGGAGE);
    // NEAR-MISS: without `modo`, no `mode` key at all — a real write.
    expect(pedido.query).toEqual({
      marketplaceIds: MARKETPLACE_ID_BR,
      issueLocale: LOCALIDADE_ISSUES_LISTINGS,
    });
    expect(Object.keys(pedido.query)).not.toContain('mode');
  });

  it('★ `modo: VALIDATION_PREVIEW` is carried to the query, the body unchanged', async () => {
    const { cliente, patch } = escritor(aceito);
    await enviarOfertaNaAmazon(cliente, entrada({ modo: MODO_ENVIO_LISTING_AMAZON.validacao }));
    const pedido = patch.mock.calls[0]?.[0] as PedidoGravado;
    expect(pedido.query).toEqual({
      marketplaceIds: MARKETPLACE_ID_BR,
      issueLocale: LOCALIDADE_ISSUES_LISTINGS,
      mode: 'VALIDATION_PREVIEW',
    });
    expect(pedido.corpo).toBe(CORPO_LUGGAGE);
  });

  it('★ the caller’s product type is the body’s, whatever it is (PRODUCT included); NEAR-MISS: a lower-case one is refused and nothing is sent', async () => {
    const { cliente, patch } = escritor(aceito);
    await enviarOfertaNaAmazon(cliente, entrada({ tipoProduto: 'PRODUCT' }));
    const corpo = (patch.mock.calls[0]?.[0] as PedidoGravado).corpo;
    expect(corpo).toBe(CORPO_LUGGAGE.replace('"LUGGAGE"', '"PRODUCT"'));

    const recusa = escritor(aceito);
    await expect(
      enviarOfertaNaAmazon(recusa.cliente, entrada({ tipoProduto: 'luggage' })),
    ).rejects.toMatchObject({ name: 'AmazonConfigError', motivo: 'tipo-produto' });
    expect(recusa.patch).not.toHaveBeenCalled();
  });

  it('a price range or a mode the package refuses sends nothing', async () => {
    const { cliente, patch } = escritor(aceito);
    await expect(
      enviarOfertaNaAmazon(cliente, entrada({ faixa: { base: 10, minimo: 11, maximo: 12 } })),
    ).rejects.toMatchObject({ name: 'AmazonConfigError', motivo: 'oferta' });
    await expect(
      enviarOfertaNaAmazon(cliente, entrada({ modo: 'PERSIST' as ModoEnvioListingAmazon })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('★ a refused credential (an SP-API 401) is thrown UNTOUCHED after ONE PATCH: no refresh rule of its own, never repeated here', async () => {
    const recusa = new AmazonAuthError({
      metodo: 'PATCH',
      caminho: '/x',
      correlationId: 'corr-teste',
      requestIdAmazon: null,
      refCredencial: 'ref-teste',
      status: 401,
      destino: 'sp-api',
      operacao: OPERACAO_ENVIAR_LISTING,
      codigoLwa: null,
    });
    const { cliente, patch } = escritor(() => Promise.reject(recusa));
    await expect(enviarOfertaNaAmazon(cliente, entrada())).rejects.toBe(recusa);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

describe('the rate an answer carried (step 13, PR 13-d): the price task’s two forms', () => {
  const FAIXA = { base: 50, minimo: 45, maximo: 50 } as const;

  /** A read context whose client answers `limiteTaxa`, or Amazon's 404. */
  function contextoComTaxa(resposta: () => Promise<unknown>): ContextoDosListingsAmazon {
    return {
      cliente: { get: () => resposta() as never },
      obterAcesso: () => Promise.reject(new Error('teste: nenhuma renovação')),
    };
  }

  it('★ the GET: the listing AND x-amzn-RateLimit-Limit; NEAR-MISS: no header ⇒ null, never 0', async () => {
    for (const [limiteTaxa, esperado] of [
      [5, 5],
      [null, null],
    ] as const) {
      const c = contextoComTaxa(() =>
        Promise.resolve({ dados: LISTING, status: 200, requestIdAmazon: null, limiteTaxa }),
      );
      const r = await lerListingComTaxaNaAmazon(c, {
        sellerId: SPID_A,
        sku: SKU,
        incluir: INCLUIR,
      });
      expect(r).toMatchObject({ leitura: { sku: SKU }, limiteTaxa: esperado });
    }
  });

  it('★ the GET’s own 404 ⇒ "nao-listado" and no rate; the shorter form answers the listing alone', async () => {
    const { contexto: c } = await contexto({ status: 404, corpo: erro('NOT_FOUND') });
    await expect(
      lerListingComTaxaNaAmazon(c, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
    ).resolves.toEqual({ leitura: NAO_LISTADO_AMAZON, limiteTaxa: null });
    const lido = contextoComTaxa(() =>
      Promise.resolve({ dados: LISTING, status: 200, requestIdAmazon: null, limiteTaxa: 5 }),
    );
    await expect(
      lerListingNaAmazon(lido, { sellerId: SPID_A, sku: SKU, incluir: INCLUIR }),
    ).resolves.toMatchObject({ sku: SKU });
  });

  it('★ the PATCH: Amazon’s answer AND its rate, ONE PATCH; NEAR-MISS: no header ⇒ null', async () => {
    for (const [limiteTaxa, esperado] of [
      [2, 2],
      [undefined, null],
    ] as const) {
      const patch = vi.fn(() =>
        Promise.resolve({
          status: 200,
          dados: { sku: SKU, status: 'ACCEPTED', submissionId: 'sub-taxa', issues: [] },
          correlationId: 'c',
          limiteTaxa: limiteTaxa ?? null,
        }),
      );
      const cliente = { patch } as unknown as SpApiEscritaClient;
      const r = await enviarOfertaComTaxaNaAmazon(cliente, {
        sellerId: SPID_A,
        sku: SKU,
        faixa: FAIXA,
        tipoProduto: 'PRODUCT',
      });
      expect(r).toEqual({
        resposta: { sku: SKU, status: 'ACCEPTED', submissionId: 'sub-taxa', issues: [] },
        limiteTaxa: esperado,
      });
      expect(patch).toHaveBeenCalledTimes(1);
    }
  });
});

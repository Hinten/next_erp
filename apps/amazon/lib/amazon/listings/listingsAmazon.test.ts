/**
 * The Listings Items calls (step 12, PR 12-e1): the two reads through the REAL
 * context over the fake db and a scripted `fetch` (the forced-refresh-once
 * rule, the "not listed" reading of the read's own 404), and the patch through
 * a RECORDING write client (exactly one PATCH, no refresh rule of its own).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one serves model shapes.
 */
import {
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  DADOS_LISTING_AMAZON,
  MARKETPLACE_ID_BR,
  OPERACAO_BUSCAR_LISTINGS,
  OPERACAO_LER_LISTING,
  type SpApiEscritaClient,
} from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { MOTIVO_ESTOQUE_AMAZON } from '../estoque/motivosEstoque';
import { AGORA_MS, SPID_A } from '../testing/fixtures';
import { harnessImportador } from '../testing/importadorAmazon';
import {
  type ContextoDosListingsAmazon,
  NAO_LISTADO_AMAZON,
  buscarListingsNaAmazon,
  enviarDisponibilidadeNaAmazon,
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
    ).resolves.toEqual({ itens: [], truncada: true });
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

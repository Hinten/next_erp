/**
 * The Easy Ship scheduling's one Amazon write (step 15, PR 15-b): the mint, then
 * the bulk, each exactly once, over RECORDING write clients that parse
 * Amazon's model shapes through the package's own schemas. No network (D11):
 * no fetch exists here at all.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  type PedidoPostSpApi,
  type RespostaSpApi,
  type SpApiEscritaClient,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import {
  agendarNaAmazon,
  ehFalhaHttpDoBulkEasyShip,
  ehRespostaForaDoEsquemaDoBulkEasyShip,
} from './easyShipAmazon';

const ORDER = '171-9876543-2109876';
const RDT = 'Atz.TESTE-rdt-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';

interface Post {
  readonly cliente: string;
  readonly operacao: string;
  readonly caminho: string;
  readonly corpo: unknown;
}

/** A write client that records each `post` and answers `corpo`, parsed by the caller's schema. */
function clienteGravador(nome: string, corpo: unknown, posts: Post[]): SpApiEscritaClient {
  return {
    post<S extends z.ZodType>(p: PedidoPostSpApi<S>): Promise<RespostaSpApi<z.infer<S>>> {
      posts.push({
        cliente: nome,
        operacao: p.operacao,
        caminho: p.caminho,
        corpo: JSON.parse(p.corpo) as unknown,
      });
      return Promise.resolve({
        dados: p.schema.parse(corpo) as z.infer<S>,
        status: 200,
        correlationId: 'corr-teste',
        requestIdAmazon: null,
        limiteTaxa: null,
        refCredencial: 'ref-teste',
      });
    },
    patch: () => Promise.reject(new Error('patch não esperado')),
  };
}

const BULK = {
  scheduledPackages: [
    {
      scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-TESTE-1' },
      packageStatus: 'ReadyForPickup',
    },
  ],
  printableDocumentsUrl: 'https://example-bucket.s3.amazonaws.com/x.zip?X-Amz-Signature=0000',
};

function montar() {
  const posts: Post[] = [];
  const lwa = clienteGravador('lwa', { restrictedDataToken: RDT, expiresIn: 3600 }, posts);
  const restrito = clienteGravador('restrito', BULK, posts);
  const fabrica = vi.fn((token: string) => {
    posts.push({ cliente: 'fabrica', operacao: '', caminho: '', corpo: token });
    return Promise.resolve(restrito);
  });
  return { posts, lwa, fabrica };
}

describe('agendarNaAmazon — the mint, then the bulk, each ONCE', () => {
  it('★ mints through the LWA client BEFORE the bulk, builds the restricted client with THAT token, and sends the bulk once through it', async () => {
    const m = montar();
    await agendarNaAmazon(m.lwa, m.fabrica, ORDER);
    expect(m.posts.map((p) => [p.cliente, p.caminho])).toEqual([
      ['lwa', CAMINHO_MINT],
      ['fabrica', ''],
      ['restrito', CAMINHO_BULK],
    ]);
    expect(m.fabrica).toHaveBeenCalledTimes(1);
    expect(m.fabrica).toHaveBeenCalledWith(RDT);
    expect(m.posts[0]?.operacao).toBe('createRestrictedDataToken');
    expect(m.posts[2]?.operacao).toBe('createScheduledPackageBulk');
    // The bulk is for THIS order, alone.
    expect(m.posts[2]?.corpo).toMatchObject({
      orderScheduleDetailsList: [{ amazonOrderId: ORDER }],
      labelFormat: 'ZPL',
    });
  });

  it('★ returns Amazon’s parsed answer and NO token: the result’s serialization has no `Atz.` prefix', async () => {
    const m = montar();
    const r = await agendarNaAmazon(m.lwa, m.fabrica, ORDER);
    expect(r).toMatchObject({ scheduledPackages: [{ packageStatus: 'ReadyForPickup' }] });
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('Atz.');
    expect(texto).not.toContain(RDT);
  });

  it('a mint that fails sends no bulk and builds no restricted client', async () => {
    const m = montar();
    const falha = new Error('mint');
    const lwa: SpApiEscritaClient = {
      post: () => Promise.reject(falha),
      patch: () => Promise.reject(new Error('patch não esperado')),
    };
    await expect(agendarNaAmazon(lwa, m.fabrica, ORDER)).rejects.toBe(falha);
    expect(m.fabrica).not.toHaveBeenCalled();
    expect(m.posts).toEqual([]);
  });

  it('every call mints anew: two calls, two mints, two restricted clients (the token is never kept)', async () => {
    const m = montar();
    await agendarNaAmazon(m.lwa, m.fabrica, ORDER);
    await agendarNaAmazon(m.lwa, m.fabrica, ORDER);
    expect(m.posts.filter((p) => p.caminho === CAMINHO_MINT)).toHaveLength(2);
    expect(m.fabrica).toHaveBeenCalledTimes(2);
  });
});

describe('ehFalhaHttpDoBulkEasyShip — only the BULK’s own HTTP answer speaks for the order', () => {
  const bulk = {
    destino: 'sp-api',
    operacao: 'createScheduledPackageBulk',
    metodo: 'POST',
    caminho: CAMINHO_BULK,
    correlationId: 'corr-teste',
    requestIdAmazon: null,
    refCredencial: 'ref-teste',
  } as const;
  const mint = { ...bulk, operacao: 'createRestrictedDataToken', caminho: CAMINHO_MINT } as const;

  it('★ the bulk’s HTTP errors, every subclass ⇒ true', () => {
    for (const erro of [
      new AmazonHttpError({ ...bulk, status: 400 }),
      new AmazonNotFoundError({ ...bulk, status: 404 }),
      new AmazonThrottleError({ ...bulk, status: 429, limiteTaxa: null }),
      new AmazonAuthError({ ...bulk, status: 403, codigoLwa: null }),
      new AmazonHttpError({ ...bulk, status: 503 }),
    ]) {
      expect(ehFalhaHttpDoBulkEasyShip(erro), erro.name).toBe(true);
    }
  });

  it('★ NEAR-MISS: the mint’s, an LWA exchange’s (even under the bulk’s label), and a non-HTTP failure of the bulk ⇒ false', () => {
    for (const erro of [
      new AmazonHttpError({ ...mint, status: 400 }),
      new AmazonNotFoundError({ ...mint, status: 404 }),
      new AmazonHttpError({ ...bulk, destino: 'lwa', operacao: 'trocarRefreshToken', status: 400 }),
      new AmazonHttpError({ ...bulk, destino: 'lwa', status: 400 }),
      new AmazonNetworkError(bulk, new TypeError('fetch failed')),
      new AmazonSchemaError({ ...bulk, status: 200, motivo: 'formato', campos: [] }),
      new TypeError('x'),
      null,
    ]) {
      expect(ehFalhaHttpDoBulkEasyShip(erro), String(erro)).toBe(false);
    }
  });

  it('(15-c) the bulk’s 2xx off its schema is told apart from the mint’s — Amazon answered the bulk, so it may have scheduled', () => {
    expect(
      ehRespostaForaDoEsquemaDoBulkEasyShip(
        new AmazonSchemaError({ ...bulk, status: 200, motivo: 'formato', campos: [] }),
      ),
    ).toBe(true);
    // NEAR-MISS: the mint's schema failure, an LWA one under the bulk's label,
    // and the bulk's HTTP or network failures are not it.
    for (const erro of [
      new AmazonSchemaError({ ...mint, status: 200, motivo: 'formato', campos: [] }),
      new AmazonSchemaError({
        ...bulk,
        destino: 'lwa',
        status: 200,
        motivo: 'formato',
        campos: [],
      }),
      new AmazonHttpError({ ...bulk, status: 400 }),
      new AmazonNetworkError(bulk, new TypeError('fetch failed')),
      null,
    ]) {
      expect(ehRespostaForaDoEsquemaDoBulkEasyShip(erro), String(erro)).toBe(false);
    }
  });
});

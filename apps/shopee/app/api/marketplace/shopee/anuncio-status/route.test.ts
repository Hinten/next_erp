import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_UNLIST_MAX_ITEMS,
  ShopeeRateLimitError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';
import { ACAO_STATUS_ANUNCIO, ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import {
  CODIGO_ACAO_INVALIDA,
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import type { AnuncioStatusResponse } from '@/lib/shopee/anuncios/pausarAnuncio';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

type ModuloPausar = typeof import('@/lib/shopee/anuncios/pausarAnuncio');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  definir: vi.fn(),
  unlistItem: vi.fn(),
  updateItem: vi.fn(),
  getItemBaseInfo: vi.fn(),
  real: { fn: null as ModuloPausar['definirStatusAnunciosShopee'] | null },
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  tryGetAdminBucket: () => null,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

// O default é o orquestrador REAL, sobre o FakeDb e um cliente falso: é o que
// prova que a cota DIÁRIA vira 200 e que uma recusa por anúncio é DADO. Os casos
// de montagem-por-nome substituem o resultado por um valor com campos extra.
vi.mock('@/lib/shopee/anuncios/pausarAnuncio', async (importActual) => {
  const actual = await importActual<ModuloPausar>();
  h.real.fn = actual.definirStatusAnunciosShopee;
  return { ...actual, definirStatusAnunciosShopee: h.definir };
});

const { POST } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT_A = 'int-1';
const REF_CONTA = `documents/integracao/${INT_A}`;
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const ITEM_ID = 2500139861;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/anuncio-status', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integracaoId: INT_A,
    produtoIds: [PRODUTO],
    acao: ACAO_STATUS_ANUNCIO.pausar,
    ...over,
  };
}

function ctxDouble() {
  return {
    integracaoId: INT_A,
    conta: { tipo: 9, shop_id: 987_654 },
    config: { partnerId: 1_000_001, partnerKey: 'k', hosts: {}, variationsPath: null },
    createShopClient: () => ({
      unlistItem: h.unlistItem,
      updateItem: h.updateItem,
      getItemBaseInfo: h.getItemBaseInfo,
    }),
  };
}

function semearProdutoELink(
  db: FakeDb,
  produtoId = PRODUTO,
  link: Record<string, unknown> = {},
): void {
  db.seed(`produtos/${produtoId}`, { nome: `Camiseta ${produtoId}`, paiId: null });
  db.seed(`produtos/${produtoId}/prodshopee/${LINK}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta',
    item_id: ITEM_ID,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...link,
  });
}

/** Uma resposta com campos EXTRA em TODOS os níveis — nenhum pode vazar. */
function respostaDouble(): AnuncioStatusResponse {
  return {
    canal: 'shopee',
    integracaoId: INT_A,
    acao: ACAO_STATUS_ANUNCIO.pausar,
    solicitados: 1,
    familias: 1,
    resumo: { aplicados: 1, pulados: 0, falhas: 0, naoTentados: 0, inventadoNoResumo: 9 },
    listings: [
      {
        produtoId: PRODUTO,
        produtoNome: 'Camiseta',
        anuncioId: String(ITEM_ID),
        linkDocId: LINK,
        outcome: 'enviado',
        motivo: null,
        mensagem: 'ok',
        statusFinal: 'UNLIST',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
        membros: null,
        inventadoNaLinha: 'NÃO PODE VAZAR',
      },
    ],
    produtosSemAnuncio: [
      {
        produtoId: 'prod-2',
        produtoNome: 'Outra',
        motivo: 'sem-anuncio',
        mensagem: 'sem anúncio',
        inventadoNaLinhaSemAnuncio: 'NÃO PODE VAZAR',
      },
    ],
    pausadoAte: null,
    inventadoNoEnvelope: 'NÃO PODE VAZAR',
  } as unknown as AnuncioStatusResponse;
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.definir.mockImplementation(
    (...args: Parameters<ModuloPausar['definirStatusAnunciosShopee']>) => {
      if (h.real.fn === null) throw new Error('fixture: o módulo real não foi capturado');
      return h.real.fn(...args);
    },
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('(1) autenticação', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
    expect(h.definir).not.toHaveBeenCalled();
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(403);
    expect(h.definir).not.toHaveBeenCalled();
  });
});

describe('(2) os cinco 400 — todos ANTES de chamar o orquestrador', () => {
  it.each([
    ['JSON malformado', '{"integracaoId":', undefined],
    [
      'integracaoId ausente',
      { produtoIds: [PRODUTO], acao: ACAO_STATUS_ANUNCIO.pausar },
      undefined,
    ],
    ['integracaoId com separador', corpoValido({ integracaoId: 'a/b' }), undefined],
    ['acao fora das duas', corpoValido({ acao: 'apagar' }), CODIGO_ACAO_INVALIDA],
    ['seleção vazia', corpoValido({ produtoIds: [] }), CODIGO_SELECAO_INVALIDA],
    [
      'seleção com id inutilizável',
      corpoValido({ produtoIds: [PRODUTO, ''] }),
      CODIGO_SELECAO_INVALIDA,
    ],
  ])('%s', async (_nome, corpo, codigo) => {
    const res = await POST(req(corpo, AUTORIZADO));

    expect(res.status).toBe(400);
    if (codigo !== undefined) {
      await expect(res.json()).resolves.toMatchObject({ code: codigo });
    }
    expect(h.definir).not.toHaveBeenCalled();
    expect(db.caminhos).toHaveLength(0);
  });
});

describe('(3)(4) o limite da seleção', () => {
  it('⛔ 51 produtos DISTINTOS respondem SHOPEE_SELECAO_EXCEDE_LIMITE — e nada é truncado', async () => {
    // ⚠️ O orquestrador levanta `ShopeeConfigError` para o mesmo caso e o
    // `respond.ts` mapeia essa classe para 500: se a rota não recusar antes, o
    // operador leva um 500 por ter selecionado demais.
    const ids = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS + 1 }, (_, i) => `p-${String(i)}`);

    const res = await POST(req(corpoValido({ produtoIds: ids }), AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_SELECAO_EXCEDE_LIMITE,
      limite: SHOPEE_UNLIST_MAX_ITEMS,
      solicitados: SHOPEE_UNLIST_MAX_ITEMS + 1,
    });
    expect(h.definir).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: 51 ids com 50 DISTINTOS é ACEITO — o limite é sobre o deduplicado', async () => {
    const ids = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS }, (_, i) => `p-${String(i)}`);
    h.definir.mockResolvedValue(respostaDouble());

    const res = await POST(req(corpoValido({ produtoIds: [...ids, ids[0]] }), AUTORIZADO));

    expect(res.status).toBe(200);
    expect(
      (h.definir.mock.calls[0]?.[1] as { produtoIds: readonly string[] }).produtoIds,
    ).toHaveLength(SHOPEE_UNLIST_MAX_ITEMS);
  });
});

describe('(5) linkDocId', () => {
  it('com dois produtos responde 400 SHOPEE_SELECAO_INVALIDA', async () => {
    const res = await POST(
      req(corpoValido({ produtoIds: ['p-1', 'p-2'], linkDocId: LINK }), AUTORIZADO),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_SELECAO_INVALIDA });
    expect(h.definir).not.toHaveBeenCalled();
  });

  it('com um produto chega ao orquestrador', async () => {
    h.definir.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido({ linkDocId: LINK }), AUTORIZADO))).status).toBe(200);
    expect(h.definir.mock.calls[0]?.[1]).toMatchObject({ linkDocId: LINK });
  });
});

describe('(6) uma recusa por anúncio é DADO', () => {
  it('⛔ TODOS os anúncios recusados ainda respondem 200', async () => {
    // Um vínculo sem `item_id` é recusado pela pré-checagem, sem nenhuma chamada
    // à Shopee. Colapsar isso num 4xx esconderia cinquenta motivos diferentes
    // atrás de um status que o operador não sabe tratar.
    semearProdutoELink(db, PRODUTO, { item_id: null });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as AnuncioStatusResponse;
    expect(corpo.resumo).toMatchObject({ aplicados: 0, pulados: 1 });
    expect(corpo.listings[0]?.outcome).toBe('pulado');
    expect(h.unlistItem).not.toHaveBeenCalled();
  });

  it('um produto sem vínculo nenhum também é 200, na lista de produtosSemAnuncio', async () => {
    db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta', paiId: null });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as AnuncioStatusResponse;
    expect(corpo.listings).toHaveLength(0);
    expect(corpo.produtosSemAnuncio[0]?.produtoId).toBe(PRODUTO);
  });
});

describe('(7) a cota DIÁRIA da Shopee', () => {
  it('⛔ responde 200 com `pausadoAte` — nunca um 5xx', async () => {
    semearProdutoELink(db);
    h.unlistItem.mockRejectedValue(
      new ShopeeRateLimitError('cota diária esgotada', {
        code: 'error_limit',
        kind: SHOPEE_ERROR_KIND.daily,
        httpStatus: 200,
        path: '/api/v2/product/unlist_item',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as AnuncioStatusResponse;
    expect(corpo.pausadoAte).toEqual(expect.any(String));
    // "Tente de novo em instantes" e "tente de novo amanhã" são instruções
    // diferentes: a releitura é PULADA quando a cota acabou.
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('um limite de RAJADA, ao contrário, propaga e o respond o mapeia', async () => {
    semearProdutoELink(db);
    h.unlistItem.mockRejectedValue(
      new ShopeeRateLimitError('rajada', {
        code: 'error_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/api/v2/product/unlist_item',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).not.toBe(200);
    expect([502, 503]).toContain(res.status);
  });

  it('um ShopeeSchemaError vira 502 pela escada do respond', async () => {
    h.definir.mockRejectedValue(
      new ShopeeSchemaError('corpo inesperado', {
        httpStatus: 200,
        path: '/api/v2/product/unlist_item',
      }),
    );

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(502);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.definir.mockRejectedValue(new TypeError('bug nosso'));

    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('(8) o corpo é montado por NOME', () => {
  it('⛔ nenhum campo novo vaza — nem no envelope, nem no resumo, nem nas LINHAS', async () => {
    h.definir.mockResolvedValue(respostaDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const corpo = (await res.json()) as Record<string, unknown> & {
      resumo: Record<string, unknown>;
      listings: Record<string, unknown>[];
      produtosSemAnuncio: Record<string, unknown>[];
    };

    expect(Object.keys(corpo).sort()).toEqual([
      'acao',
      'canal',
      'familias',
      'integracaoId',
      'listings',
      'pausadoAte',
      'produtosSemAnuncio',
      'resumo',
      'solicitados',
    ]);
    expect(Object.keys(corpo.resumo).sort()).toEqual([
      'aplicados',
      'falhas',
      'naoTentados',
      'pulados',
    ]);
    // ⚠️ O nível de LINHA é o que um envelope montado por nome ainda deixaria
    // passar: estas linhas carregam o status cru da releitura.
    expect(Object.keys(corpo.listings[0] ?? {}).sort()).toEqual([
      'anuncioId',
      'estadoAnuncio',
      'linkDocId',
      'membros',
      'mensagem',
      'motivo',
      'outcome',
      'produtoId',
      'produtoNome',
      'statusFinal',
    ]);
    expect(Object.keys(corpo.produtosSemAnuncio[0] ?? {}).sort()).toEqual([
      'mensagem',
      'motivo',
      'produtoId',
      'produtoNome',
    ]);
  });

  it('o relógio é lido UMA vez e é o que o orquestrador recebe', async () => {
    h.definir.mockResolvedValue(respostaDouble());
    const spy = vi.spyOn(Date, 'now');

    await POST(req(corpoValido(), AUTORIZADO));

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = h.definir.mock.calls[0]?.[2] as {
      nowMs: number;
      increment: (by: number) => unknown;
    };
    expect(deps.nowMs).toBe(spy.mock.results[0]?.value);
    expect(typeof deps.increment).toBe('function');
  });
});

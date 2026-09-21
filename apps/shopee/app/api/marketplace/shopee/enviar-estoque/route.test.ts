import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import {
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import { SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS } from '@/lib/shopee/estoque/constantesEstoque';
import {
  CHAVES_DA_LISTAGEM,
  CHAVES_DO_ENVELOPE,
  CHAVES_DO_RESUMO,
  CHAVES_SEM_ENVIO,
  type EnvioEstoqueResponse,
} from '@/lib/shopee/estoque/enviarEstoqueManual';
import { CODIGO_GUARDA_ENVIO, MOTIVO_ESTOQUE_SHOPEE } from '@/lib/shopee/estoque/errosEstoque';
import type { LinhaDeFamiliaShopee } from '@/lib/shopee/estoque/planoEstoque';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

type ModuloManual = typeof import('@/lib/shopee/estoque/enviarEstoqueManual');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  enviar: vi.fn(),
  criarCliente: vi.fn(),
  real: { fn: null as ModuloManual['enviarEstoqueManualShopee'] | null },
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

// O default é o orquestrador REAL, sobre o FakeDb e um remetente falso: é o que
// prova que todas as linhas falhando ainda respondem 200 e que a contabilidade
// fecha. Os casos de montagem-por-nome trocam o resultado por um valor com
// campos extra em todos os níveis.
vi.mock('@/lib/shopee/estoque/enviarEstoqueManual', async (importActual) => {
  const actual = await importActual<ModuloManual>();
  h.real.fn = actual.enviarEstoqueManualShopee;
  return { ...actual, enviarEstoqueManualShopee: h.enviar };
});

const { POST } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT = 'int-1';
const REF_CONTA = `documents/integracao/${INT}`;
const DEPOSITO = 'documents/deposito/dep-1';
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const ITEM_ID = 2500139861;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/enviar-estoque', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: INT, produtoIds: [PRODUTO], ...over };
}

function ctxDouble(over: Record<string, unknown> = {}) {
  return {
    integracaoId: INT,
    conta: { tipo: 9, shop_id: 987_654, nome: 'Loja teste', depositoOuterRef: DEPOSITO, ...over },
    config: { partnerId: 1_000_001, partnerKey: 'k', hosts: {}, variationsPath: null },
    createShopClient: () => {
      h.criarCliente();
      return {} as unknown as ShopeeClient;
    },
  };
}

function semearProdutoELink(db: FakeDb, produtoId = PRODUTO): void {
  db.seed(`produtos/${produtoId}`, { nome: `Camiseta ${produtoId}`, paiId: null });
  db.seed(`produtos/${produtoId}/prodshopee/${LINK}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_ID,
    item_status: 'NORMAL',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  });
}

/** Uma resposta com campos EXTRA em TODOS os níveis — nenhum pode vazar. */
function respostaDouble(): EnvioEstoqueResponse {
  return {
    canal: 'shopee',
    integracaoId: INT,
    contaNome: 'Loja teste',
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0, inventadoNoResumo: 9 },
    listings: [
      {
        produtoId: PRODUTO,
        produtoNome: 'Camiseta',
        variacaoProdutoId: null,
        anuncioId: String(ITEM_ID),
        linkDocId: LINK,
        outcome: 'enviado',
        motivo: null,
        mensagem: 'ok',
        quantidade: 7,
        variacoes: [],
        modelosRecusados: 0,
        clampados: 0,
        rearme: null,
        inventadoNaLinha: 'NÃO PODE VAZAR',
      },
    ],
    produtosSemEnvio: [
      {
        produtoId: 'prod-2',
        produtoNome: 'Outra',
        motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
        mensagem: 'não encontrado',
        inventadoSemEnvio: 'NÃO PODE VAZAR',
      },
    ],
    pausadoAte: null,
    inventadoNoEnvelope: 'NÃO PODE VAZAR',
  } as unknown as EnvioEstoqueResponse;
}

function familia(anchorId: string): LinhaDeFamiliaShopee {
  return {
    anchorId,
    anchor: {
      produtoId: anchorId,
      ehKit: false,
      ehKitVirtual: false,
      publicado: true,
      componentesKit: null,
      timestampMs: 1_760_000_000_000,
      estoque: { quantidade: 7, quantidadeReservada: 0 },
      componentEstoques: [],
    },
    integracoesComProduto: [INT],
    links: [
      {
        contaProdutoShopeeOuterRef: REF_CONTA,
        linkDocId: LINK,
        item_id: ITEM_ID,
        item_status: 'NORMAL',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      },
    ],
    children: [],
  };
}

/**
 * O orquestrador REAL, com as DUAS costuras injetadas — a descoberta (que roda
 * a API de Pipelines, inexecutável fora do Firestore real) e o remetente, que
 * devolve sempre o mesmo resultado.
 */
function comRemetente(resultado: unknown) {
  return (...args: Parameters<ModuloManual['enviarEstoqueManualShopee']>) => {
    if (h.real.fn === null) throw new Error('fixture: o módulo real não foi capturado');
    const [firestore, corpo, deps] = args;
    return h.real.fn(firestore, corpo, {
      ...deps,
      buscarFamilias: (_db, a) =>
        Promise.resolve(a.produtoIds.filter((id) => id === PRODUTO).map((id) => familia(id))),
      enviarTarefa: () => Promise.resolve(resultado as never),
    });
  };
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.enviar.mockImplementation((...args: Parameters<ModuloManual['enviarEstoqueManualShopee']>) => {
    if (h.real.fn === null) throw new Error('fixture: o módulo real não foi capturado');
    return h.real.fn(...args);
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------- R-01 ---------------------------------- */

describe('(1) autenticação — R-01', () => {
  it('responde 401 sem o cabeçalho, e não lê nem chama nada', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(db.caminhos).toEqual([]);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(403);
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

/* ------------------------------ R-02 … R-08 -------------------------------- */

describe('(2) o corpo — R-02 a R-08', () => {
  it.each([
    ['R-02 JSON malformado', '{"integracaoId":', undefined],
    ['R-03 corpo null', null, undefined],
    ['R-03 corpo array', [], undefined],
    ['R-03 corpo escalar', 42, undefined],
    ['R-04 integracaoId ausente', { produtoIds: [PRODUTO] }, undefined],
    ['R-04 integracaoId vazio', corpoValido({ integracaoId: '' }), undefined],
    ['R-04 integracaoId com separador', corpoValido({ integracaoId: 'a/b' }), undefined],
    ['R-04 integracaoId relativo', corpoValido({ integracaoId: '..' }), undefined],
    ['R-04 integracaoId não-string verdadeiro', corpoValido({ integracaoId: 7 }), undefined],
    ['R-05 produtoIds ausente', { integracaoId: INT }, CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds vazio', corpoValido({ produtoIds: [] }), CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds com vazio', corpoValido({ produtoIds: [''] }), CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds com número', corpoValido({ produtoIds: [1] }), CODIGO_SELECAO_INVALIDA],
    ['reenviarComErro não booleano', corpoValido({ reenviarComErro: 'sim' }), undefined],
  ])('%s ⇒ 400, e nada roda', async (_nome, corpo, codigo) => {
    const res = await POST(req(corpo, AUTORIZADO));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(typeof body.error).toBe('string');
    if (codigo !== undefined) expect(body.code).toBe(codigo);
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('R-02 — um erro que NÃO é de sintaxe sobe (rule 6)', async () => {
    const quebrado = new Request('http://localhost:3009/x', {
      method: 'POST',
      headers: AUTORIZADO,
      body: '{}',
    });
    vi.spyOn(quebrado, 'json').mockRejectedValue(new TypeError('stream já consumido'));
    await expect(POST(quebrado)).rejects.toBeInstanceOf(TypeError);
  });

  it('R-06 — 51 ids com 50 DISTINTOS são ACEITOS', async () => {
    semearProdutoELink(db);
    const distintos = Array.from({ length: 50 }, (_v, i) => `prod-${String(i)}`);
    for (const id of distintos) db.seed(`produtos/${id}`, { nome: id, paiId: null });
    h.enviar.mockResolvedValue(respostaDouble());

    const res = await POST(
      req(corpoValido({ produtoIds: [...distintos, distintos[0]] }), AUTORIZADO),
    );

    expect(res.status).toBe(200);
    expect(h.enviar).toHaveBeenCalledTimes(1);
    const args = h.enviar.mock.calls[0] as unknown as Parameters<
      ModuloManual['enviarEstoqueManualShopee']
    >;
    expect(args[1].produtoIds).toHaveLength(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS);
  });

  it('R-07 — 51 DISTINTOS ⇒ 400 com limite e solicitados, e o corpo NÃO traz listings', async () => {
    const ids = Array.from({ length: 51 }, (_v, i) => `prod-${String(i)}`);
    const res = await POST(req(corpoValido({ produtoIds: ids }), AUTORIZADO));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(CODIGO_SELECAO_EXCEDE_LIMITE);
    expect(body.limite).toBe(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS);
    expect(body.solicitados).toBe(51);
    expect(body.listings).toBeUndefined();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-08 — uma chave desconhecida no corpo é IGNORADA', async () => {
    semearProdutoELink(db);
    h.enviar.mockResolvedValue(respostaDouble());
    const res = await POST(req(corpoValido({ inventado: 'x' }), AUTORIZADO));
    expect(res.status).toBe(200);
  });
});

/* ------------------------------ R-09 … R-11 -------------------------------- */

describe('(3) as guardas de conta — R-09 a R-11', () => {
  it('R-09 — conta PAUSADA ⇒ 409 com pausadoAte ISO e ZERO chamadas Shopee', async () => {
    const futuro = Date.now() + 600_000;
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: futuro });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; pausadoAte: string };
    expect(body.code).toBe(CODIGO_GUARDA_ENVIO.contaPausada);
    expect(body.pausadoAte).toBe(new Date(futuro).toISOString());
    expect(h.criarCliente).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-10 — QUASE-MISS: uma pausa VENCIDA responde 200', async () => {
    semearProdutoELink(db);
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: Date.now() - 1 });
    h.enviar.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(200);
  });

  it('R-11 — conta sem depósito ⇒ 400 SHOPEE_CONTA_SEM_DEPOSITO', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ depositoOuterRef: '' }));

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      CODIGO_GUARDA_ENVIO.contaSemDeposito,
    );
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

/* ------------------------------ R-12 … R-15 -------------------------------- */

describe('(4) o envelope — R-12 a R-15', () => {
  it('R-12 — TODAS as linhas falhando ainda responde 200', async () => {
    semearProdutoELink(db);
    h.enviar.mockImplementation(
      comRemetente({
        outcome: 'erro-registrado',
        motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel,
        codigo: 'product.error_item_uneditable',
        modelos: [],
        quantidadeEnviada: 0,
        chamadasShopee: 1,
        pausadoAte: null,
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvioEstoqueResponse;
    expect(body.listings.length).toBeGreaterThan(0);
    expect(body.resumo.falhas).toBe(body.listings.length);
  });

  it('R-13 — os conjuntos de chaves são montados POR NOME nos QUATRO níveis', async () => {
    h.enviar.mockResolvedValue(respostaDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([...CHAVES_DO_ENVELOPE].sort());
    expect(Object.keys(body.resumo as object).sort()).toEqual([...CHAVES_DO_RESUMO].sort());
    const listings = body.listings as Record<string, unknown>[];
    expect(Object.keys(listings[0] ?? {}).sort()).toEqual([...CHAVES_DA_LISTAGEM].sort());
    const semEnvio = body.produtosSemEnvio as Record<string, unknown>[];
    expect(Object.keys(semEnvio[0] ?? {}).sort()).toEqual([...CHAVES_SEM_ENVIO].sort());
    expect(JSON.stringify(body)).not.toContain('NÃO PODE VAZAR');
  });

  it('R-14 — UMA leitura de relógio por requisição, e a pausa decide com ela', async () => {
    const agora = 1_760_000_000_000;
    const espiao = vi.spyOn(Date, 'now').mockReturnValue(agora);
    // A pausa termina EXATAMENTE no instante lido: estritamente maior, logo NÃO
    // está pausada — a borda que o mesmo instante decide.
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: agora });
    h.enviar.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(200);
    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('R-14 — a fonte declara a leitura ansiosa UMA vez', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte.match(/const nowMs = Date\.now\(\);/g)).toHaveLength(1);
  });

  it('R-15 — a contabilidade: todo id pedido sai em exatamente uma lista', async () => {
    semearProdutoELink(db);
    db.seed('produtos/prod-2', { nome: 'Outra', paiId: null });
    h.enviar.mockImplementation(
      comRemetente({
        outcome: 'enviado',
        motivo: null,
        codigo: null,
        modelos: [],
        quantidadeEnviada: 7,
        chamadasShopee: 1,
        pausadoAte: null,
      }),
    );

    const res = await POST(req(corpoValido({ produtoIds: [PRODUTO, 'prod-2'] }), AUTORIZADO));
    const body = (await res.json()) as EnvioEstoqueResponse;

    const cobertos = [
      ...body.listings.map((l) => l.produtoId),
      ...body.produtosSemEnvio.map((p) => p.produtoId),
    ].sort();
    expect(cobertos).toEqual([PRODUTO, 'prod-2']);
  });
});

/* ------------------------------ R-16 … R-20 -------------------------------- */

describe('(5) os erros — R-16 a R-20', () => {
  it('R-16 — reauth ⇒ 409, nunca 502 (a cadeia mais-derivada-primeiro)', async () => {
    h.loadCtx.mockRejectedValue(
      new ShopeeReauthRequiredError('reconecte a conta', {
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: '/api/v2/product/update_stock',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SHOPEE_REAUTH_REQUIRED');
  });

  it('R-17 — uma RAJADA que escapa do envio vira 502', async () => {
    h.enviar.mockRejectedValue(
      new ShopeeRateLimitError('limite de rajada', {
        code: 'error_rate_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/api/v2/product/update_stock',
        retryAfterSeconds: 30,
      }),
    );

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(502);
  });

  it('R-17 — a COTA DIÁRIA responde 200 com pausadoAte', async () => {
    semearProdutoELink(db);
    h.enviar.mockImplementation(
      comRemetente({
        outcome: 'descartado',
        motivo: MOTIVO_ESTOQUE_SHOPEE.cotaDiaria,
        codigo: 'error_quota',
        modelos: [],
        quantidadeEnviada: 0,
        chamadasShopee: 1,
        pausadoAte: Date.now() + 3_000,
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const body = (await res.json()) as EnvioEstoqueResponse;

    expect(res.status).toBe(200);
    expect(body.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.cotaDiaria);
  });

  it('R-18 — a classe de guarda mapeia {status, code, ...extra} e nada mais', async () => {
    const futuro = Date.now() + 60_000;
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: futuro });

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'pausadoAte']);
  });

  it('R-19 — um TypeError sem relação SOBE', async () => {
    h.enviar.mockRejectedValue(new TypeError('bug de programação'));
    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });

  it('R-20 — a rota declara force-dynamic e o runtime nodejs (texto cru)', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte).toContain("export const dynamic = 'force-dynamic';");
    expect(fonte).toContain("export const runtime = 'nodejs';");
  });

  it('R-97 — a rota não nomeia o teto de lote da rota de status (os três 50)', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte).not.toContain(['SHOPEE', 'UNLIST', 'MAX', 'ITEMS'].join('_'));
    expect(fonte).toContain('SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS');
  });
});

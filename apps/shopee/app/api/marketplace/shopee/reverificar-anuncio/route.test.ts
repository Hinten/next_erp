import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  ShopeeRateLimitError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { MSG_PRODUTO_ID_INVALIDO } from '@/lib/shopee/anuncios/corpoPublicacao';
import {
  ACAO_REVERIFICACAO,
  type ResultadoReverificacao,
} from '@/lib/shopee/anuncios/reverificarAnuncio';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

type ModuloReverificar = typeof import('@/lib/shopee/anuncios/reverificarAnuncio');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  reverificar: vi.fn(),
  getItemBaseInfo: vi.fn(),
  real: { fn: null as ModuloReverificar['reverificarAnuncioShopee'] | null },
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

// O default é o reverificador REAL sobre o FakeDb: os dois 404 e o 409 saem do
// resolvedor de vínculo de verdade, e o 409 não gasta chamada nenhuma.
vi.mock('@/lib/shopee/anuncios/reverificarAnuncio', async (importActual) => {
  const actual = await importActual<ModuloReverificar>();
  h.real.fn = actual.reverificarAnuncioShopee;
  return { ...actual, reverificarAnuncioShopee: h.reverificar };
});

const { POST, CODIGO_ANUNCIO_NAO_PUBLICADO, CODIGO_ANUNCIO_SEM_VINCULO } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT_A = 'int-1';
const REF_CONTA = `documents/integracao/${INT_A}`;
const REF_OUTRA_CONTA = 'documents/integracao/int-2';
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const ITEM_ID = 2500139861;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/reverificar-anuncio', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: INT_A, produtoId: PRODUTO, ...over };
}

function ctxDouble() {
  return {
    integracaoId: INT_A,
    conta: { tipo: 9, shop_id: 987_654 },
    config: { partnerId: 1_000_001, partnerKey: 'k', hosts: {}, variationsPath: null },
    createShopClient: () => ({ getItemBaseInfo: h.getItemBaseInfo }),
  };
}

function semearLink(over: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PRODUTO}/prodshopee/${LINK}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta',
    item_id: ITEM_ID,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...over,
  });
}

/** Um resultado com campos EXTRA — o corpo 200 carrega só as nove chaves. */
function resultadoDouble(over: Partial<ResultadoReverificacao> = {}): ResultadoReverificacao {
  return {
    acao: ACAO_REVERIFICACAO.atualizado,
    produtoId: PRODUTO,
    linkDocId: LINK,
    itemId: ITEM_ID,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    violacoes: [],
    violacoesLidas: true,
    modelos: { total: 2, atualizados: 1, ausentes: 0, inventadoNaContagem: 9 },
    avisoResolvido: true,
    chamadasShopee: 3,
    inventadoPelaOndaSeguinte: 'NÃO PODE VAZAR',
    ...over,
  } as unknown as ResultadoReverificacao;
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.reverificar.mockImplementation(
    (...args: Parameters<ModuloReverificar['reverificarAnuncioShopee']>) => {
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

describe('(1) autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
    expect(h.reverificar).not.toHaveBeenCalled();
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 para um body JSON malformado', async () => {
    const res = await POST(req('{"integracaoId":', AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body JSON inválido.' });
    expect(h.reverificar).not.toHaveBeenCalled();
  });

  it('⛔ responde 400 para um produtoId com separador, sem tocar o Firestore', async () => {
    const res = await POST(req(corpoValido({ produtoId: 'a/b/c' }), AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: MSG_PRODUTO_ID_INVALIDO });
    expect(db.caminhos).toHaveLength(0);
  });

  it('responde 400 para um linkDocId não-string', async () => {
    expect((await POST(req(corpoValido({ linkDocId: 7 }), AUTORIZADO))).status).toBe(400);
  });
});

describe('(2)(3) o 404 de vínculo', () => {
  it('um produto SEM vínculo nesta conta responde 404 SHOPEE_ANUNCIO_SEM_VINCULO', async () => {
    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_ANUNCIO_SEM_VINCULO });
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('⛔ um linkDocId de OUTRA conta responde 404 — o filtro de conta roda primeiro', async () => {
    semearLink({ contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });

    const res = await POST(req(corpoValido({ linkDocId: LINK }), AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_ANUNCIO_SEM_VINCULO });
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
  });
});

describe('(4) o 409 do que nunca foi publicado', () => {
  it('⛔ um vínculo sem item_id responde 409, com ZERO chamadas à Shopee', async () => {
    // 409 e não 404: o vínculo existe, então o pedido endereçou algo real — ele
    // só não tem anúncio ainda, e não há o que reverificar até o `publicar`.
    semearLink({ item_id: null });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_ANUNCIO_NAO_PUBLICADO,
      linkDocId: LINK,
    });
    expect(h.getItemBaseInfo).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('um vínculo com item_id 0 cai no MESMO 409 — 0 é o sentinela de "sem anúncio"', async () => {
    semearLink({ item_id: 0 });

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(409);
  });
});

describe('(5) o 200', () => {
  it('⛔ carrega exatamente as NOVE chaves, e um campo novo no resultado não vaza', async () => {
    h.reverificar.mockResolvedValue(resultadoDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as Record<string, unknown> & {
      modelos: Record<string, unknown>;
    };
    expect(Object.keys(corpo).sort()).toEqual([
      'acao',
      'avisoResolvido',
      'chamadasShopee',
      'deboost',
      'estadoAnuncio',
      'itemStatus',
      'modelos',
      'violacoes',
      'violacoesLidas',
    ]);
    // ⚠️ Nem a contagem de modelos é espalhada.
    expect(Object.keys(corpo.modelos).sort()).toEqual(['atualizados', 'ausentes', 'total']);
  });

  it('um anúncio sem modelos carrega `modelos: null`, não um objeto de zeros', async () => {
    // `null` e `{total: 0}` são fatos diferentes: o primeiro é "esta listagem
    // não tem modelos", o segundo seria "tem modelos e nenhum foi lido".
    h.reverificar.mockResolvedValue(resultadoDouble({ modelos: null }));

    const corpo = (await (await POST(req(corpoValido(), AUTORIZADO))).json()) as {
      modelos: unknown;
    };
    expect(corpo.modelos).toBeNull();
  });

  it('o veredicto `removido` é um 200, não um erro', async () => {
    // Uma listagem que a Shopee já não tem é exatamente o que permite marcar o
    // vínculo e fechar o aviso — transformá-la em 4xx apagaria as duas coisas.
    h.reverificar.mockResolvedValue(
      resultadoDouble({
        acao: ACAO_REVERIFICACAO.removido,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        itemStatus: null,
        modelos: null,
        chamadasShopee: 1,
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      acao: ACAO_REVERIFICACAO.removido,
      itemStatus: null,
    });
  });

  it('as violações vão como LISTA — é o que o operador precisa LER', async () => {
    const violacao = {
      kind: 'status',
      violation_type: 'PROHIBITED',
      violation_reason: 'item proibido',
      suggestion: 'remova o item',
      suggested_category: null,
      fix_deadline_time: null,
      update_time: null,
      days_to_fix: null,
    };
    h.reverificar.mockResolvedValue(
      resultadoDouble({ violacoes: [violacao] as unknown as ResultadoReverificacao['violacoes'] }),
    );

    const corpo = (await (await POST(req(corpoValido(), AUTORIZADO))).json()) as {
      violacoes: { violation_type: string }[];
    };
    expect(corpo.violacoes).toHaveLength(1);
    expect(corpo.violacoes[0]?.violation_type).toBe('PROHIBITED');
  });

  it('o relógio é lido UMA vez e é o que o reverificador recebe', async () => {
    h.reverificar.mockResolvedValue(resultadoDouble());
    const spy = vi.spyOn(Date, 'now');

    await POST(req(corpoValido({ linkDocId: LINK }), AUTORIZADO));

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = h.reverificar.mock.calls[0]?.[2] as {
      nowMs: number;
      increment: (by: number) => unknown;
    };
    expect(deps.nowMs).toBe(spy.mock.results[0]?.value);
    expect(typeof deps.increment).toBe('function');
    expect(h.reverificar.mock.calls[0]?.[1]).toEqual({
      integracaoId: INT_A,
      produtoId: PRODUTO,
      linkDocId: LINK,
    });
  });
});

describe('(6) os erros que sobem para o respond', () => {
  it('um ShopeeSchemaError vira 502 SHOPEE_BAD_RESPONSE', async () => {
    h.reverificar.mockRejectedValue(
      new ShopeeSchemaError('campo mudou', {
        httpStatus: 200,
        path: '/api/v2/product/get_item_base_info',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_BAD_RESPONSE' });
  });

  it('um limite de rajada NÃO vira 200', async () => {
    h.reverificar.mockRejectedValue(
      new ShopeeRateLimitError('rajada', {
        code: 'error_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/api/v2/product/get_item_base_info',
      }),
    );

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).not.toBe(200);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.reverificar.mockRejectedValue(new TypeError('bug nosso'));

    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

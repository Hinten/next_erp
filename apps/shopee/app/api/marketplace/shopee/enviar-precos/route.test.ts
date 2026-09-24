import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_PROD_API_HOST,
  SHOPEE_SHOP_STATUS,
  ShopeeReauthRequiredError,
  resolveShopeeHosts,
  type ShopeeClient,
  type ShopeeShopInfo,
} from '@delfrance/integrations-shopee';

import {
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { ShopeeContaSemShopIdError } from '@/lib/shopee/core/tokenStore';
import { MOTIVOS_DE_PAUSA } from '@/lib/shopee/estoque/constantesEstoque';
import { __resetCachesDeContaEstoqueForTests } from '@/lib/shopee/estoque/contaEstoque';
import { SHOPEE_ENVIO_PRECO_MAX_PRODUTOS } from '@/lib/shopee/precos/constantesPreco';
import type { LinhaModeloPreco, ResultadoEnvioPreco } from '@/lib/shopee/precos/enviarPreco';
import {
  CHAVES_DA_LISTAGEM_PRECO,
  CHAVES_DO_ENVELOPE_PRECO,
  CHAVES_DO_RESUMO_PRECO,
  CHAVES_SEM_ENVIO_PRECO,
  type EnvioPrecoResponse,
} from '@/lib/shopee/precos/enviarPrecoManual';
import {
  CODIGO_GUARDA_PRECO,
  MENSAGEM_POR_MOTIVO_PRECO,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoGuardError,
} from '@/lib/shopee/precos/errosPreco';
import type { FamiliaDePreco, ItemDePreco } from '@/lib/shopee/precos/planoPreco';
import { type DocData, FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

/**
 * `POST /api/marketplace/shopee/enviar-precos` (#1521, step 13; reconcile
 * §2.10, C-j, C-s, D-6). Numbered R-01…R-20 after step 12's `enviar-estoque`
 * route suite, plus the price-only rungs: the tabela 400, the QUOTA-only 409
 * and the conta verdict's 422 — each asserted BY CALL ORDER against a client
 * that records every operation, never by a mock that merely was not called.
 */

type ModuloManual = typeof import('@/lib/shopee/precos/enviarPrecoManual');
type ModuloRegiao = typeof import('@/lib/shopee/precos/regiaoPreco');

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  enviar: vi.fn(),
  avaliar: vi.fn(),
  criarCliente: vi.fn(),
  real: {
    enviar: null as ModuloManual['enviarPrecoManualShopee'] | null,
    avaliar: null as ModuloRegiao['avaliarContaParaPreco'] | null,
  },
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

// The run and the verdict default to the REAL modules; a case swaps one only
// where it needs a shape the fixtures cannot produce.
vi.mock('@/lib/shopee/precos/enviarPrecoManual', async (importActual) => {
  const actual = await importActual<ModuloManual>();
  h.real.enviar = actual.enviarPrecoManualShopee;
  return { ...actual, enviarPrecoManualShopee: h.enviar };
});

vi.mock('@/lib/shopee/precos/regiaoPreco', async (importActual) => {
  const actual = await importActual<ModuloRegiao>();
  h.real.avaliar = actual.avaliarContaParaPreco;
  return { ...actual, avaliarContaParaPreco: h.avaliar };
});

const { POST } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT = 'int-1';
const TABELA_REF = 'documents/listaDePrecos/lp-1';
const TABELA_ID = 'lp-1';
const ANCORA = 'prod-1';
const FILHO = 'prod-1-p';
const LINK = 'link-1';
const ITEM_ID = 2500139861;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

const CONFIG_PRODUCAO = { sandbox: false, hosts: resolveShopeeHosts({ sandbox: false }) };
const CONFIG_SANDBOX = { sandbox: true, hosts: resolveShopeeHosts({ sandbox: true }) };
/** The flag ON beside an explicit PRODUCTION API host — must never unlock the override. */
const CONFIG_FLAG_COM_HOST_DE_PRODUCAO = {
  sandbox: true,
  hosts: resolveShopeeHosts({ sandbox: true, apiHost: SHOPEE_PROD_API_HOST }),
};

/** The same double as the discovery suite: `getAll(...refs, { fieldMask })` with a real mask. */
class FakeDbComLote extends FakeDb {
  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined || opcoes === null) return dados;
            const saida: DocData = {};
            for (const c of opcoes.fieldMask) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/enviar-precos', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpoValido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: INT, produtoIds: [ANCORA], ...over };
}

function lojaInfo(over: Record<string, unknown> = {}): ShopeeShopInfo {
  return {
    shop_name: 'Loja de Teste',
    region: 'BR',
    status: SHOPEE_SHOP_STATUS.normal,
    is_cb: false,
    auth_time: 1_700_000_000,
    expire_time: 1_800_000_000,
    merchant_id: null,
    is_sip: null,
    shop_fulfillment_flag: null,
    is_upgraded_cbsc: null,
    is_mart_shop: null,
    is_outlet_shop: null,
    mart_outlet_structure_type: null,
    ...over,
  } as unknown as ShopeeShopInfo;
}

/** Every Shopee operation the route's client performs, in CALL order. */
let ops: string[] = [];
let loja: ShopeeShopInfo = lojaInfo();

const clienteFake = {
  getShopInfo: () => {
    ops.push('getShopInfo');
    return Promise.resolve(loja);
  },
  getItemBaseInfo: () => {
    ops.push('getItemBaseInfo');
    return Promise.resolve({ item_list: [] });
  },
  getModelList: () => {
    ops.push('getModelList');
    return Promise.reject(new Error('fixture: nenhum caso lê modelos'));
  },
  updatePrice: () => {
    ops.push('updatePrice');
    return Promise.reject(new Error('fixture: nenhum caso escreve preço pelo cliente'));
  },
} as unknown as ShopeeClient;

function ctxDouble(conta: Record<string, unknown> = {}, config: unknown = CONFIG_PRODUCAO) {
  return {
    integracaoId: INT,
    conta: {
      tipo: 9,
      shop_id: 987_654,
      nome: 'Loja teste',
      tabelaNormalOuterRef: TABELA_REF,
      ...conta,
    },
    config,
    createShopClient: () => {
      h.criarCliente();
      return clienteFake;
    },
  };
}

function semearFamilia(db: FakeDb): void {
  db.seed(`produtos/${ANCORA}`, { nome: 'Camiseta', paiId: null });
  db.seed(`produtos/${FILHO}`, { nome: 'Camiseta P', paiId: ANCORA });
}

function familia(): FamiliaDePreco {
  return {
    anchorId: ANCORA,
    precos: { [TABELA_ID]: { valor: 15 } },
    links: [
      { contaProdutoShopeeOuterRef: `integracao/${INT}`, item_id: ITEM_ID, linkDocId: LINK },
      {
        contaProdutoShopeeOuterRef: `integracao/${INT}`,
        item_id: ITEM_ID + 1,
        linkDocId: `${LINK}-b`,
      },
      {
        contaProdutoShopeeOuterRef: `integracao/${INT}`,
        item_id: ITEM_ID + 2,
        linkDocId: `${LINK}-c`,
      },
    ],
    children: [],
  };
}

function linhas(
  item: ItemDePreco,
  resultado: LinhaModeloPreco['resultado'],
  motivo: LinhaModeloPreco['motivo'],
) {
  return item.alvos.map((a) => ({
    modelId: a.modelId,
    produtoId: a.produtoId,
    varLinkDocId: a.varLinkDocId,
    precoAlvo: a.precoAlvo,
    precoAnterior: 10,
    resultado,
    motivo,
    codigo: resultado === 'falha' ? 'product.error_item_uneditable' : null,
  }));
}

/**
 * The REAL run, with its two seams injected — the family read (real
 * subcollection queries the shared double cannot project) and the sender,
 * whose answer per `item_id` the case scripts.
 */
function comRemetente(roteiro: (item: ItemDePreco) => ResultadoEnvioPreco) {
  return (...args: Parameters<ModuloManual['enviarPrecoManualShopee']>) => {
    if (h.real.enviar === null) throw new Error('fixture: o módulo real não foi capturado');
    const [firestore, corpo, deps] = args;
    return h.real.enviar(firestore, corpo, {
      ...deps,
      lerFamilias: (_db, a) =>
        Promise.resolve(
          new Map(a.anchorIds.filter((id) => id === ANCORA).map((id) => [id, familia()])),
        ),
      enviar: (item) => Promise.resolve(roteiro(item)),
    });
  };
}

const sempreEnviado = (item: ItemDePreco): ResultadoEnvioPreco => ({
  tipo: 'enviado',
  modelos: linhas(item, 'enviado', null),
  chamadasShopee: 1,
});

/** A response with EXTRA keys at every level — none may leak. */
function respostaDouble(): EnvioPrecoResponse {
  return {
    canal: 'shopee',
    integracaoId: INT,
    contaNome: 'Loja teste',
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0, inventadoNoResumo: 9 },
    listings: [
      {
        produtoId: ANCORA,
        produtoNome: 'Camiseta',
        variacaoProdutoId: FILHO,
        anuncioId: String(ITEM_ID),
        linkDocId: LINK,
        outcome: 'enviado',
        motivo: null,
        mensagem: 'ok',
        preco: 15,
        precoAnterior: 10,
        variacoes: null,
        codigo: null,
        inventadoNaLinha: 'NÃO PODE VAZAR',
        inventadoNumeroNaLinha: 42,
      },
    ],
    produtosSemEnvio: [
      {
        produtoId: 'prod-2',
        produtoNome: 'Outra',
        motivo: MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado,
        mensagem: 'não encontrado',
        inventadoSemEnvio: 'NÃO PODE VAZAR',
      },
    ],
    pausadoAte: null,
    inventadoNoEnvelope: 'NÃO PODE VAZAR',
  } as unknown as EnvioPrecoResponse;
}

let db: FakeDbComLote;

beforeEach(() => {
  vi.clearAllMocks();
  __resetCachesDeContaEstoqueForTests();
  ops = [];
  loja = lojaInfo();
  db = new FakeDbComLote();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.enviar.mockImplementation(comRemetente(sempreEnviado));
  h.avaliar.mockImplementation((...args: Parameters<ModuloRegiao['avaliarContaParaPreco']>) => {
    if (h.real.avaliar === null) throw new Error('fixture: o veredito real não foi capturado');
    return h.real.avaliar(...args);
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetCachesDeContaEstoqueForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ArgsDoEnvio = Parameters<ModuloManual['enviarPrecoManualShopee']>;
const argsDoEnvio = (): ArgsDoEnvio[] => h.enviar.mock.calls as unknown as ArgsDoEnvio[];

/* ---------------------------------- R-01 ---------------------------------- */

describe('(1) autenticação — R-01', () => {
  it('responde 401 sem o cabeçalho, e não lê nem chama nada', async () => {
    expect((await POST(req(corpoValido()))).status).toBe(401);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
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
    ['R-04 integracaoId ausente', { produtoIds: [ANCORA] }, undefined],
    ['R-04 integracaoId vazio', corpoValido({ integracaoId: '' }), undefined],
    ['R-04 integracaoId com separador', corpoValido({ integracaoId: 'a/b' }), undefined],
    ['R-04 integracaoId relativo', corpoValido({ integracaoId: '..' }), undefined],
    ['R-04 integracaoId não-string verdadeiro', corpoValido({ integracaoId: 7 }), undefined],
    ['R-05 produtoIds ausente', { integracaoId: INT }, CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds vazio', corpoValido({ produtoIds: [] }), CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds com vazio', corpoValido({ produtoIds: [''] }), CODIGO_SELECAO_INVALIDA],
    ['R-05 produtoIds com número', corpoValido({ produtoIds: [1] }), CODIGO_SELECAO_INVALIDA],
    [
      'R-05 produtoIds com separador',
      corpoValido({ produtoIds: ['a/b'] }),
      CODIGO_SELECAO_INVALIDA,
    ],
    ['R-05 produtoIds não-array', corpoValido({ produtoIds: ANCORA }), CODIGO_SELECAO_INVALIDA],
    ['R-08 baixarPreco número', corpoValido({ baixarPreco: 1 }), undefined],
    ['R-08 baixarPreco null', corpoValido({ baixarPreco: null }), undefined],
  ])('%s ⇒ 400, e nada roda', async (_nome, corpo, codigo) => {
    const res = await POST(req(corpo, AUTORIZADO));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(typeof body.error).toBe('string');
    if (codigo !== undefined) expect(body.code).toBe(codigo);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
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

  it('⚠️ (M65/M1) R-06 — 51 ids com 50 DISTINTOS são ACEITOS: o teto conta DEPOIS da deduplicação', async () => {
    h.enviar.mockResolvedValue(respostaDouble());
    const distintos = Array.from({ length: 50 }, (_v, i) => `prod-${String(i)}`);

    const res = await POST(
      req(corpoValido({ produtoIds: [...distintos, distintos[0]] }), AUTORIZADO),
    );

    expect(res.status).toBe(200);
    expect(argsDoEnvio()[0]?.[1].produtoIds).toEqual(distintos);
  });

  it('⚠️ (M66/M2) R-07 — QUASE-IGUAL: 51 DISTINTOS ⇒ 400 com limite e solicitados, NUNCA truncado', async () => {
    const ids = Array.from({ length: 51 }, (_v, i) => `prod-${String(i)}`);

    const res = await POST(req(corpoValido({ produtoIds: ids }), AUTORIZADO));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: CODIGO_SELECAO_EXCEDE_LIMITE,
      limite: SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
      solicitados: 51,
    });
    expect(body.listings).toBeUndefined();
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-06 — um id duplicado conta UMA vez, e a ordem do pedido é mantida', async () => {
    h.enviar.mockResolvedValue(respostaDouble());

    await POST(req(corpoValido({ produtoIds: ['b', 'a', 'b'] }), AUTORIZADO));

    expect(argsDoEnvio()[0]?.[1].produtoIds).toEqual(['b', 'a']);
  });

  it('⚠️ (M4) R-08 — PAR: `baixarPreco: "true"` (TEXTO) ⇒ 400 com a frase; QUASE-IGUAL: `true` (booleano) é aceito', async () => {
    const texto = await POST(req(corpoValido({ baixarPreco: 'true' }), AUTORIZADO));
    expect(texto.status).toBe(400);
    expect(((await texto.json()) as { error: string }).error).toBe(
      'baixarPreco deve ser booleano.',
    );
    expect(h.loadCtx).not.toHaveBeenCalled();

    h.enviar.mockResolvedValue(respostaDouble());
    expect((await POST(req(corpoValido({ baixarPreco: true }), AUTORIZADO))).status).toBe(200);
  });

  it('⚠️ (M67/M3) R-08 — `baixarPreco` AUSENTE chega ao envio como FALSE; `true` e `false` chegam como vieram', async () => {
    h.enviar.mockResolvedValue(respostaDouble());

    await POST(req(corpoValido(), AUTORIZADO));
    await POST(req(corpoValido({ baixarPreco: true }), AUTORIZADO));
    await POST(req(corpoValido({ baixarPreco: false }), AUTORIZADO));

    expect(argsDoEnvio().map((a) => a[1].baixarPreco)).toEqual([false, true, false]);
  });

  it('R-08 — uma chave desconhecida no corpo é IGNORADA', async () => {
    h.enviar.mockResolvedValue(respostaDouble());
    expect((await POST(req(corpoValido({ inventado: 'x' }), AUTORIZADO))).status).toBe(200);
  });
});

/* ------------------------------ R-09 … R-11 -------------------------------- */

describe('(3) as guardas de conta — R-09 a R-11, antes de QUALQUER chamada', () => {
  it('R-09 — tabela normal EM BRANCO ⇒ 400 SHOPEE_CONTA_SEM_TABELA_NORMAL, zero cliente, zero chamada', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ tabelaNormalOuterRef: '  ' }));

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: MENSAGEM_POR_MOTIVO_PRECO['sem-tabela-normal'],
      code: CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    });
    expect(h.criarCliente).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-09 — a ORDEM: tabela em branco E conta pausada ⇒ o 400 da tabela (a tabela vem primeiro)', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ tabelaNormalOuterRef: null }));
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: Date.now() + 600_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.burst,
    });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    );
  });

  it('R-09 — o veredito que diz `sem-tabela-normal` (uma ref que não nomeia documento) também é o 400', async () => {
    h.avaliar.mockResolvedValue({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.semTabelaNormal,
      regiao: null,
      erro: null,
    });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    );
  });

  it.each([MOTIVOS_DE_PAUSA.burst, MOTIVOS_DE_PAUSA.cotaDiaria])(
    '⚠️ (M68/M5) R-10 — pausa de cota `%s` ⇒ 409 + pausadoAte ISO, SEM construir cliente e SEM nenhuma chamada',
    async (motivo) => {
      const futuro = Date.now() + 600_000;
      db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: futuro, pausaMotivo: motivo });

      const res = await POST(req(corpoValido(), AUTORIZADO));

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['code', 'error', 'pausadoAte']);
      expect(body.code).toBe(CODIGO_GUARDA_PRECO.contaPausada);
      expect(body.pausadoAte).toBe(new Date(futuro).toISOString());
      expect(h.criarCliente).not.toHaveBeenCalled();
      expect(ops).toEqual([]);
      expect(h.avaliar).not.toHaveBeenCalled();
      expect(h.enviar).not.toHaveBeenCalled();
    },
  );

  it('⚠️ (M69/M6) R-10 — QUASE-IGUAL: uma pausa de FÉRIAS do estoque, igualmente ativa, NÃO para o preço (200)', async () => {
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: Date.now() + 600_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.lojaEmFerias,
    });
    h.enviar.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(200);
  });

  it('R-10 — QUASE-IGUAL: uma pausa de cota VENCIDA responde 200', async () => {
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: Date.now() - 1,
      pausaMotivo: MOTIVOS_DE_PAUSA.burst,
    });
    h.enviar.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(200);
  });

  it('⚠️ (M70/M7) R-11 — loja SG em produção ⇒ 422 SHOPEE_PRECO_CONTA_RECUSADA; a ÚNICA chamada é o get_shop_info', async () => {
    loja = lojaInfo({ region: 'SG' });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: MENSAGEM_POR_MOTIVO_PRECO['regiao-nao-suportada'],
      code: CODIGO_GUARDA_PRECO.contaRecusada,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      mensagem: MENSAGEM_POR_MOTIVO_PRECO['regiao-nao-suportada'],
      regiao: 'SG',
    });
    // BY CALL ORDER: the verdict's one cached read, and nothing an item would spend.
    expect(ops).toEqual(['getShopInfo']);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-11 — QUASE-IGUAL: a MESMA loja SG no host da sandbox com a bandeira ⇒ 200, contexto em SGD', async () => {
    loja = lojaInfo({ region: 'SG' });
    h.loadCtx.mockResolvedValue(ctxDouble({}, CONFIG_SANDBOX));
    h.enviar.mockResolvedValue(respostaDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    expect(argsDoEnvio()[0]?.[2].contexto).toMatchObject({
      regiao: 'SG',
      moeda: 'SGD',
      multiplo: 5,
    });
  });

  it('R-11 — QUASE-IGUAL: a bandeira LIGADA com o host de PRODUÇÃO continua recusando a loja SG (422)', async () => {
    loja = lojaInfo({ region: 'SG' });
    h.loadCtx.mockResolvedValue(ctxDouble({}, CONFIG_FLAG_COM_HOST_DE_PRODUCAO));

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('R-11 — uma loja cross-border (mesmo BR) ⇒ 422 `loja-cross-border` com a região', async () => {
    loja = lojaInfo({ is_cb: true });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ motivo: 'loja-cross-border', regiao: 'BR' });
  });

  it('R-11 — conta sem shop_id ⇒ 422 `sem-shop-id` SEM a chave `regiao`, e nenhum cliente construído', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ shop_id: null }));

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'mensagem', 'motivo']);
    expect(body.motivo).toBe('sem-shop-id');
    expect(h.criarCliente).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
  });

  it('R-11 — uma classe de CONTA ao construir o cliente ⇒ 422 `conta-nao-configurada`; a classe vai ao LOG, nunca ao corpo', async () => {
    h.loadCtx.mockResolvedValue({
      ...ctxDouble(),
      createShopClient: () => {
        throw new ShopeeContaSemShopIdError('consentimento por conta principal');
      },
    });

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(422);
    const texto = await res.text();
    expect(JSON.parse(texto)).toMatchObject({ motivo: 'conta-nao-configurada' });
    expect(texto).not.toContain('ShopeeContaSemShopIdError');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('conta-nao-configurada'),
      expect.objectContaining({ erro: expect.stringContaining('ShopeeContaSemShopIdError') }),
    );
  });

  it('R-11 — a conta que não existe (ou não é Shopee) é o 404 do contexto', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('Integração não encontrada.'));

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(404);
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

/* ------------------------------ R-12 … R-16 -------------------------------- */

describe('(4) o envelope — R-12 a R-16', () => {
  it('⚠️ (M9) R-12 — TODAS as linhas falhando ainda responde 200, e `resumo.falhas` conta cada uma', async () => {
    semearFamilia(db);
    h.enviar.mockImplementation(
      comRemetente((item) => ({
        tipo: 'falha',
        motivo: MOTIVO_PRECO_SHOPEE.anuncioNaoEditavel,
        codigo: 'product.error_item_uneditable',
        mensagem: null,
        carimbado: true,
        modelos: linhas(item, 'falha', MOTIVO_PRECO_SHOPEE.anuncioNaoEditavel),
        chamadasShopee: 1,
      })),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvioPrecoResponse;
    expect(body.listings).toHaveLength(3);
    expect(body.resumo).toEqual({ enviados: 0, pulados: 0, falhas: 3, naoTentados: 0 });
  });

  it('(M19) R-13 — as chaves são montadas POR NOME nos QUATRO níveis, e nada inventado vaza', async () => {
    h.enviar.mockResolvedValue(respostaDouble());

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([...CHAVES_DO_ENVELOPE_PRECO].sort());
    expect(Object.keys(body.resumo as object).sort()).toEqual([...CHAVES_DO_RESUMO_PRECO].sort());
    const listings = body.listings as Record<string, unknown>[];
    expect(Object.keys(listings[0] ?? {}).sort()).toEqual([...CHAVES_DA_LISTAGEM_PRECO].sort());
    const semEnvio = body.produtosSemEnvio as Record<string, unknown>[];
    expect(Object.keys(semEnvio[0] ?? {}).sort()).toEqual([...CHAVES_SEM_ENVIO_PRECO].sort());
    expect(JSON.stringify(body)).not.toContain('NÃO PODE VAZAR');
    expect(JSON.stringify(body)).not.toContain('42');
  });

  it('R-14 — UMA leitura de relógio por requisição, e a pausa decide com ela', async () => {
    const agora = 1_760_000_000_000;
    const espiao = vi.spyOn(Date, 'now').mockReturnValue(agora);
    // The pause ends EXACTLY at the instant read: strictly greater, so NOT paused.
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: agora, pausaMotivo: MOTIVOS_DE_PAUSA.burst });
    h.enviar.mockResolvedValue(respostaDouble());

    expect((await POST(req(corpoValido(), AUTORIZADO))).status).toBe(200);
    expect(espiao).toHaveBeenCalledTimes(1);
    expect(argsDoEnvio()[0]?.[2].nowMs).toBe(agora);
  });

  it('R-14 — a fonte declara a leitura ansiosa UMA vez (a outra é o relógio DECORRIDO, injetado como função)', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte.match(/const nowMs = Date\.now\(\);/g)).toHaveLength(1);
    expect(fonte.match(/Date\.now\(\)/g)).toHaveLength(2);
    expect(fonte).toContain('agora: () => Date.now()');
  });

  it('(M10) R-15 — a contabilidade: um FILHO pedido sai nas linhas da âncora, um id inexistente em produtosSemEnvio', async () => {
    semearFamilia(db);

    const res = await POST(req(corpoValido({ produtoIds: [FILHO, 'prod-fantasma'] }), AUTORIZADO));
    const body = (await res.json()) as EnvioPrecoResponse;

    expect(res.status).toBe(200);
    expect(new Set(body.listings.map((l) => l.produtoId))).toEqual(new Set([ANCORA]));
    expect(body.produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual([
      ['prod-fantasma', 'produto-nao-encontrado'],
    ]);
    expect(body.solicitados).toBe(2);
  });

  it('R-16 — o envio recebe o contexto APROVADO pelo veredito, o nome da conta e os dois relógios', async () => {
    h.enviar.mockResolvedValue(respostaDouble());

    await POST(req(corpoValido(), AUTORIZADO));

    const deps = argsDoEnvio()[0]?.[2];
    expect(deps?.contexto).toMatchObject({
      integracaoId: INT,
      regiao: 'BR',
      moeda: 'BRL',
      multiplo: 4,
      tabelaNormalId: TABELA_ID,
    });
    expect(deps?.contaNome).toBe('Loja teste');
    expect(typeof deps?.agora).toBe('function');
    expect(typeof deps?.esperar).toBe('function');
  });
});

/* ------------------------------ R-17 … R-20 -------------------------------- */

describe('(5) aborts e erros — R-17 a R-20', () => {
  it('⚠️ (M71/M16) R-17 — um `fatal` no MEIO ⇒ 200: o item que já pousou fica `enviado`, o resto `nao-tentado reauth`', async () => {
    semearFamilia(db);
    h.enviar.mockImplementation(
      comRemetente((item) =>
        item.itemId === ITEM_ID + 1
          ? {
              tipo: 'fatal',
              motivo: 'reauth',
              erro: 'ShopeeReauthRequiredError: x',
              chamadasShopee: 1,
            }
          : sempreEnviado(item),
      ),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvioPrecoResponse;
    expect(body.listings.map((l) => [l.outcome, l.motivo])).toEqual([
      ['enviado', null],
      ['nao-tentado', 'reauth'],
      ['nao-tentado', 'reauth'],
    ]);
  });

  it('R-17 — uma pausa de cota no PRIMEIRO item ⇒ 200 com `pausadoAte` e TODOS `nao-tentado conta-pausada`', async () => {
    // Width 1, so no second item is already in flight when the first pauses.
    vi.stubEnv('SHOPEE_PRICE_MANUAL_CONCURRENCY', '1');
    semearFamilia(db);
    const virada = Date.now() + 3_000_000;
    h.enviar.mockImplementation(
      comRemetente((item) =>
        item.itemId === ITEM_ID
          ? {
              tipo: 'pausa',
              pausa: MOTIVOS_DE_PAUSA.cotaDiaria,
              ate: virada,
              retryAfterSeconds: null,
              codigo: 'error_limit',
              chamadasShopee: 1,
            }
          : sempreEnviado(item),
      ),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));
    const body = (await res.json()) as EnvioPrecoResponse;

    expect(res.status).toBe(200);
    expect(body.pausadoAte).toBe(new Date(virada).toISOString());
    expect(body.resumo.naoTentados).toBe(3);
  });

  it('⚠️ (D-6) R-18 — a classe de GUARDA lançada pelo envio responde no SEU status com {error, code, ...extra}, nunca 500', async () => {
    const pausadoAte = new Date(Date.now() + 60_000).toISOString();
    h.enviar.mockRejectedValue(
      new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaPausada, 'pausada', { pausadoAte }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'pausada',
      code: CODIGO_GUARDA_PRECO.contaPausada,
      pausadoAte,
    });
  });

  it('R-19 — um erro da Shopee do contexto segue `shopeeErrorResponse` (reauth ⇒ 409)', async () => {
    h.loadCtx.mockRejectedValue(
      new ShopeeReauthRequiredError('reconecte a conta', {
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: '/api/v2/shop/get_shop_info',
      }),
    );

    const res = await POST(req(corpoValido(), AUTORIZADO));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SHOPEE_REAUTH_REQUIRED');
  });

  it('R-19 — um TypeError sem relação SOBE (rule 6)', async () => {
    h.enviar.mockRejectedValue(new TypeError('bug de programação'));
    await expect(POST(req(corpoValido(), AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });

  it('R-20 — a rota declara force-dynamic e o runtime nodejs (texto cru)', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte).toContain("export const dynamic = 'force-dynamic';");
    expect(fonte).toContain("export const runtime = 'nodejs';");
  });

  it('R-20 — a rota lê o teto do PREÇO e nunca o do estoque (dois 50 que só coincidem)', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    expect(fonte).toContain('SHOPEE_ENVIO_PRECO_MAX_PRODUTOS');
    expect(fonte).not.toContain(['SHOPEE', 'ENVIO', 'ESTOQUE', 'MAX', 'PRODUTOS'].join('_'));
  });

  it('R-20 — a ordem das guardas no TEXTO: tabela → pausa → veredito → envio', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const posicoes = [
      'CODIGO_GUARDA_PRECO.contaSemTabelaNormal,',
      'pausaDeCotaParaPreco(',
      'avaliarContaParaPreco(',
      'enviarPrecoManualShopee(',
    ].map((trecho) => fonte.indexOf(trecho, fonte.indexOf('export async function POST')));
    expect(posicoes.every((p) => p > 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_GET_ITEM_BASE_INFO_PATH,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  SHOPEE_GET_MODEL_LIST_PATH,
  ShopeeConfigError,
  ShopeeNetworkError,
  createShopeeClient,
  resolveShopeeHosts,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  componentesShopeeDoKit,
  type ResolucaoComponenteKit,
} from '@delfrance/schemas';

import {
  MOTIVO_PROBLEMA_PUBLICACAO,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
} from '../anuncios/errosPublicacao';
import { idDoRef } from '../core/vinculosShopee';
import { podeEnviarEstoqueShopee } from '../estoque/podeEnviarEstoque';
import {
  FIXTURE_ADD_KIT_ITEM_SG,
  FIXTURE_ADD_KIT_ITEM_SG_CORPO_VAZIO,
  FIXTURE_ADD_KIT_ITEM_SG_DOIS_PRINCIPAIS,
  FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS,
  FIXTURE_ITEM_BASE_INFO_SG_KIT,
  FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO,
  FIXTURE_MODEL_LIST_SG_KIT,
  lerFixture,
} from '../fixtures/wireCorpus';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  completarKit,
  criarKit,
  garantirKitNovo,
  ligarModelosDoKit,
  linhasLidasDoModeloKit,
} from './aplicarKit';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';
import { planejarKit, type ModeloDoPlanoKit, type PlanoKit } from './planoKit';
import type { ContextoKit, FilhoDoKit, KitDeps } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*  Fixture ids by ROLE only (s19-ctx / reconcile §0): kit 2500139870 with     */
/*  model 2000458820 (+ the family's second model 2000458823), component A    */
/*  2500139871 / model 2000458821, plain component B 2500139872 whose HIDDEN   */
/*  model id is 2000458829; a second kit 2500139873. Never a real id.          */
/* -------------------------------------------------------------------------- */

const K = 'kit-k';
const KIT = 2500139870;
const KIT_2 = 2500139873;
const M0 = 2000458820;
const M1 = 2000458823;
const A = 2500139871;
const MA = 2000458821;
const B = 2500139872;
const MB_OCULTO = 2000458829;
const AGORA = 1_791_331_200_000;
const CONTA_REF = 'documents/integracao/int-1';
const LINK = idDoVinculoDeKit('int-1', KIT);

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------- the ERP side ---------------------------- */

function filho(
  produtoId: string,
  variante: string | null,
  sku: string,
  componentesKit: FilhoDoKit['componentesKit'],
  ordem: number,
): FilhoDoKit {
  return { produtoId, sku, ordem, componentesKit, preco: 49.9, variante };
}

/** The real probe kit's recipe (A model White,02 ×2 as main, plain B ×1). */
const FILHO_A = filho(
  'filho-a',
  'Azul',
  'KIT-1-AZ',
  {
    'comp-a': { quantidade: 2 },
    'comp-b': { quantidade: 1 },
  },
  0,
);
const FILHO_B = filho('filho-b', 'Verde', 'KIT-1-VD', { 'comp-a': { quantidade: 3 } }, 1);

const RESOLUCAO: ReadonlyMap<string, ResolucaoComponenteKit> = new Map([
  ['comp-a', { ok: true, endereco: { itemId: A, modelId: MA } }],
  ['comp-b', { ok: true, endereco: { itemId: B, modelId: null } }],
]);
const TEM_MODELOS: ReadonlyMap<number, boolean> = new Map([
  [A, true],
  [B, false],
]);

/** A context that passes phase A (name, description, weight, dimensions, SKU). */
function contexto(over: Partial<ContextoKit> = {}): ContextoKit {
  return {
    arma: { arma: 'kit-criar' },
    integracaoId: 'int-1',
    produto: {
      id: K,
      sku: 'KIT-1',
      raw: {
        nome: 'Kit de teste',
        ehKit: true,
        ehKitVirtual: true,
        pesoBrutoKg: 1.5,
        alturaCm: 10,
        larguraCm: 10,
        profundidadeCm: 10,
      },
    },
    filhos: [FILHO_A, FILHO_B],
    familiaDeUm: false,
    grupo: { id: 'g1', nome: 'Cor' },
    gruposDistintos: 1,
    descricao: 'Descrição do kit de teste',
    resolucao: RESOLUCAO,
    temModelos: TEM_MODELOS,
    categoriaPorProduto: new Map(),
    principal: { itemId: A, modelId: MA },
    principalPedido: null,
    limites: null,
    canais: [],
    vinculos: [],
    alvo: null,
    vivo: null,
    linhasDoAnuncio: [],
    linhasDaConta: [],
    busca: { completo: true, achados: [], paginas: 1, chamadas: 1 },
    nossosVivos: new Map(),
    ...over,
  };
}

/** The plan a passing create carries — the projection through the schemas module, one model per child. */
function planoDeCriacao(ctx: ContextoKit, over: Partial<PlanoKit> = {}): PlanoKit {
  const modelos: ModeloDoPlanoKit[] = ctx.filhos.map((f, tierIndex) => {
    const p = componentesShopeeDoKit(f.componentesKit, ctx.resolucao);
    return {
      filhoId: f.produtoId,
      tierIndex,
      linhas: p.linhas.map((l, i) =>
        tierIndex === 0 && i === 0 ? { ...l, main_component: true as const } : l,
      ),
      projecaoCompleta: p.falhas.length === 0 && p.linhas.length > 0,
    };
  });
  const corpo: ShopeeAddKitItemRequest = {
    sync_setting: { auto_sync_dts: true },
    item_setting: {
      item_name: 'Kit de teste',
      images: { image_id_list: ['br-11134207-7r98o-lzri4neb5vcv18'] },
      description_type: 'normal',
      description: 'Descrição do kit de teste',
      logistic_info: [{ logistic_id: 90003, enabled: true }],
      weight: 1.5,
      item_sku: 'KIT-1',
      tier_variation_list: [
        {
          name: ctx.familiaDeUm ? 'Kit' : 'Cor',
          option_list: ctx.filhos.map((f) => ({ option: f.variante ?? 'Padrão' })),
        },
      ],
      model_list: modelos.map((m) => ({
        tier_index: [m.tierIndex] as [number],
        original_price: 49.9,
        component_list: m.linhas,
      })),
    },
  };
  return {
    problemas: [],
    avisos: [],
    kitNovo: { acao: 'criar' },
    corpo,
    modelos,
    principal: { itemId: A, modelId: MA },
    sku: 'KIT-1',
    ...over,
  };
}

/** K and its children as the aviso decision re-reads them. */
function semear(db: FakeDb, ctx: ContextoKit): void {
  db.seed(`produtos/${K}`, { nome: 'Kit de teste', ehKit: true, sku: 'KIT-1', paiId: null });
  for (const f of ctx.filhos) {
    db.seed(`produtos/${f.produtoId}`, { paiId: K, sku: f.sku, componentesKit: f.componentesKit });
  }
}

/* ------------------------------ the Shopee side --------------------------- */

type Bruto = Record<string, unknown>;

function objeto(v: unknown): Bruto {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('objeto esperado');
  return v as Bruto;
}

/** A kit model row as `get_kit_item_info` serves it. */
function modeloLido(
  modelId: number,
  tier: number,
  sku: string,
  componentes: readonly {
    item: number;
    modelo: number;
    quantidade: number;
    principal?: boolean;
  }[],
): Bruto {
  return {
    model_id: modelId,
    model_sku: sku,
    original_price: 49.9,
    tier_index: [tier],
    component_list: componentes.map((c) => ({
      component_item_id: c.item,
      component_model_id: c.modelo,
      quantity: c.quantidade,
      main_component: c.principal === true,
      component_item_name: '',
      component_item_or_model_image: 'br-11134207-7r98o-lzri4neb5vcv18',
      component_model_name: '',
      component_item_or_model_sku: '',
    })),
  };
}

/**
 * SYNTHETIC (labelled): the REAL `get_kit_item_info.sg-pos-criacao` body with
 * its `model_list` and tier replaced — every other byte kept.
 */
function corpoDoKit(
  modelos: readonly Bruto[],
  tier: { nome: string; opcoes: readonly string[] },
): Bruto {
  const real = objeto(lerFixture(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO));
  const resposta = objeto(real.response);
  const produto = objeto(resposta.product_info);
  return {
    ...real,
    response: {
      ...resposta,
      product_info: {
        ...produto,
        model_list: modelos,
        tier_variation_list: [
          { name: tier.nome, option_list: tier.opcoes.map((option) => ({ option })) },
        ],
      },
    },
  };
}

/** The family kit as Shopee answers it: model_list in REVERSE tier order (M82). */
function kitDaFamilia(quantidadeDoFilhoB = 3): Bruto {
  return corpoDoKit(
    [
      modeloLido(M1, 1, 'KIT-1-VD', [{ item: A, modelo: MA, quantidade: quantidadeDoFilhoB }]),
      modeloLido(M0, 0, 'KIT-1-AZ', [
        { item: A, modelo: MA, quantidade: 2, principal: true },
        { item: B, modelo: MB_OCULTO, quantidade: 1 },
      ]),
    ],
    { nome: 'Cor', opcoes: ['Azul', 'Verde'] },
  );
}

/** SYNTHETIC (labelled): `get_model_list` of the family kit — ids + status only. */
function listaDaFamilia(status: Record<number, string> = {}): Bruto {
  return {
    error: '',
    message: '',
    warning: '',
    response: {
      tier_variation: [{ name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] }],
      model: [M0, M1].map((id, i) => ({
        model_id: id,
        tier_index: [i],
        model_status: status[id] ?? 'MODEL_NORMAL',
      })),
    },
  };
}

/** SYNTHETIC (labelled): the components' `get_item_base_info` — A has variations, B does not. */
function baseDosComponentes(ids: readonly number[]): Bruto {
  const linhas: Record<number, Bruto> = {
    [A]: { item_id: A, has_model: true, item_status: 'NORMAL', tag: { kit: false } },
    [B]: { item_id: B, has_model: false, item_status: 'NORMAL', tag: { kit: false } },
  };
  return {
    error: '',
    message: '',
    warning: '',
    response: { item_list: ids.map((id) => linhas[id]).filter((l) => l !== undefined) },
  };
}

type Resposta = { readonly status?: number; readonly corpo: unknown } | Error;

/**
 * The package's REAL client (signer, guards, schemas, error builder), with only
 * `fetch` doubled by path. A route answering an `Error` makes `fetch` REJECT —
 * a dropped connection, which the package raises as `ShopeeNetworkError`.
 */
function transporte(rotas: Record<string, (ids: readonly number[]) => Resposta>): {
  readonly client: ShopeeClient;
  readonly chamadas: {
    readonly caminho: string;
    readonly ids: readonly number[];
    readonly corpo: unknown;
  }[];
  readonly quantas: (caminho: string) => number;
} {
  const chamadas: { caminho: string; ids: readonly number[]; corpo: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url = new URL(
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url,
    );
    const lista = url.searchParams.get('item_id_list') ?? url.searchParams.get('item_id') ?? '';
    const ids = (lista.match(/\d+/g) ?? []).map(Number);
    const corpo: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    chamadas.push({ caminho: url.pathname, ids, corpo });
    const rota = rotas[url.pathname];
    if (rota === undefined) {
      return Promise.reject(new TypeError(`rota não servida no teste: ${url.pathname}`));
    }
    const r = rota(ids);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(
      new Response(JSON.stringify(r.corpo), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
    fetch,
  });
  return {
    client,
    chamadas,
    quantas: (caminho) => chamadas.filter((c) => c.caminho === caminho).length,
  };
}

/** The family create, end to end: add OK → the reversed read-back. */
function shopeeDaFamilia(
  over: Partial<Record<string, (ids: readonly number[]) => Resposta>> = {},
  kit: () => Bruto = () => kitDaFamilia(),
  lista: () => Bruto = () => listaDaFamilia(),
) {
  return transporte({
    [SHOPEE_ADD_KIT_ITEM_PATH]: () => ({ corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG) }),
    [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) =>
      ids.includes(KIT)
        ? { corpo: lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT) }
        : { corpo: baseDosComponentes(ids) },
    [SHOPEE_GET_KIT_ITEM_INFO_PATH]: () => ({ corpo: kit() }),
    [SHOPEE_GET_MODEL_LIST_PATH]: () => ({ corpo: lista() }),
    ...over,
  });
}

function depsDe(db: FakeDb, client: ShopeeClient): KitDeps {
  return {
    db: asDb(db),
    client,
    partnerClient: () => {
      throw new Error('o applier de kit não sobe foto');
    },
    integracaoId: 'int-1',
    tabelaNormalOuterRef: null,
    depositoOuterRef: null,
    operacaoOuterRef: null,
    nowMs: AGORA,
    esperar: () => Promise.resolve(),
    taxonomia: {} as KitDeps['taxonomia'],
    categorias: {} as KitDeps['categorias'],
    increment,
  };
}

/** The rows the fake db holds under a child, as `prepararKit` would hand them back. */
function linhasDaConta(db: FakeDb, filhos: readonly string[]): ContextoKit['linhasDaConta'] {
  return filhos.flatMap((produtoId) =>
    db.idsEm(`produtos/${produtoId}/variashopee`).map((docId) => {
      const raw = db.store[`produtos/${produtoId}/variashopee/${docId}`]?.data ?? {};
      return { produtoId, docId, linkDocId: idDoRef(raw.produtoShopeeOuterRef), raw };
    }),
  );
}

const linhaDe = (db: FakeDb, filhoId: string, modelId: number) =>
  db.store[`produtos/${filhoId}/variashopee/${idDaVariacaoDeKit(LINK, modelId)}`]?.data;

/* -------------------------------------------------------------------------- */
/*                                  criar                                     */
/* -------------------------------------------------------------------------- */

describe('criarKit — add_kit_item → the ONE link write → the read-back completion', () => {
  it('(M82, M83, M171) binds by the SENT tier_index, rows under each CHILD, model_status from get_model_list', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    semear(db, ctx);
    const shopee = shopeeDaFamilia(
      {},
      () => kitDaFamilia(),
      () => listaDaFamilia({ [M0]: 'MODEL_UNAVAILABLE' }),
    );
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

    expect(r).toMatchObject({
      arma: 'kit-criar',
      desfecho: 'criado',
      produtoId: K,
      itemId: KIT,
      linkDocId: LINK,
      estadoAnuncio: 'ativo',
      itemStatus: 'NORMAL',
      kitNativo: true,
      modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
      antecessor: null,
      recusa: null,
      comando: null,
    });
    expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(1);
    // M171: L9's three-read read-back — exactly ONE explicit get_model_list.
    expect(shopee.quantas(SHOPEE_GET_MODEL_LIST_PATH)).toBe(1);
    // scan 1 + add 1 + base 1 + kit 1 + components batch 1 + model list 1.
    expect(r.chamadasShopee).toBe(6);

    // M82: Shopee served the models REVERSED; each child's row carries the model
    // of the tier index the create SENT for it, never the response position.
    expect(linhaDe(db, 'filho-a', M0)).toMatchObject({ model_id: M0, tier_index: [0] });
    expect(linhaDe(db, 'filho-b', M1)).toMatchObject({ model_id: M1, tier_index: [1] });
    expect(linhaDe(db, 'filho-a', M1)).toBeUndefined();
    expect(linhaDe(db, 'filho-b', M0)).toBeUndefined();
    // M83: under the children, never under K.
    expect(db.idsEm(`produtos/${K}/variashopee`)).toEqual([]);
    // M171: the status comes from get_model_list (the kit page has none).
    expect(linhaDe(db, 'filho-a', M0)?.model_status).toBe('MODEL_UNAVAILABLE');
    expect(linhaDe(db, 'filho-b', M1)?.model_status).toBe('MODEL_NORMAL');
    expect(linhaDe(db, 'filho-a', M0)?.produtoShopeeOuterRef).toBe(
      `documents/produtos/${K}/prodshopee/${LINK}`,
    );

    const link = db.store[`produtos/${K}/prodshopee/${LINK}`]?.data;
    expect(link).toMatchObject({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_id: KIT,
      kitNativo: true,
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
      ultimaPublicacao: { em: AGORA, etapa: 'add_kit_item', itemId: KIT },
    });
  });

  it('(M91) EQUAL pair stamped — the hidden B id folds equal to "no model" — and a QUANTITY near-miss is NOT stamped', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    semear(db, ctx);
    // Shopee answered 200 but holds 4 where the create sent 3 (P2-c: a 200 proves nothing).
    const shopee = shopeeDaFamilia({}, () => kitDaFamilia(4));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

    expect(linhaDe(db, 'filho-a', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(FILHO_A.componentesKit),
    );
    expect(linhaDe(db, 'filho-b', M1)?.receitaKitConferida).toBeNull();
    expect(r.avisos.filter((a) => a.codigo === 'receita-divergente')).toEqual([
      {
        codigo: 'receita-divergente',
        produtoId: 'filho-b',
        mensagem:
          'a composição da variação filho-b mudou no ERP; a Shopee não permite alterá-la — o kit ' +
          `continua com a receita antiga; use --link ${LINK} --recriar para criar um kit novo`,
      },
    ]);
    // The null stamp makes the SAME decision the trigger runs OPEN the aviso, naming filho-b.
    expect(r.avisosResolvidos).toBe(0);
    const aviso = db.store[`avisos/${chaveAvisoReceitaKitShopee('int-1', K)}`]?.data;
    expect(aviso).toMatchObject({ resolvidoEm: null });
    expect(objeto(aviso?.params).variacoes).toBe('filho-b');
  });

  it('an all-EQUAL create closes the aviso a deleted old kit left open (motivo kit-recriado)', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    semear(db, ctx);
    // An OLD native kit still selling the old recipe opened the aviso…
    const velho = idDoVinculoDeKit('int-1', KIT_2);
    db.seed(`produtos/${K}/prodshopee/${velho}`, vinculoNativo(velho, KIT_2).raw);
    db.seed(`produtos/filho-a/variashopee/velha`, {
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${velho}`,
      model_id: 2000458822,
      receitaKitConferida: 'uma receita antiga',
    });
    const opcoes = { agoraUs: AGORA * 1000, increment };
    await expect(
      reavaliarAvisoDeReceitaKit(
        asDb(db),
        { integracaoId: 'int-1', kitProdutoId: K },
        'kit-recriado',
        opcoes,
      ),
    ).resolves.toBe('aberto');
    // …and was deleted in Seller Centre and reverified.
    db.seed(`produtos/${K}/prodshopee/${velho}`, {
      ...vinculoNativo(velho, KIT_2).raw,
      estadoAnuncio: 'removido',
    });
    const shopee = shopeeDaFamilia();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

    expect(r.avisosResolvidos).toBe(1);
    expect(db.store[`avisos/${chaveAvisoReceitaKitShopee('int-1', K)}`]?.data).toMatchObject({
      resolucaoMotivo: 'kit-recriado',
    });
    expect(
      db.store[`avisos/${chaveAvisoReceitaKitShopee('int-1', K)}`]?.data.resolvidoEm,
    ).not.toBeNull();
  });

  it('(M98, completion half) a crash after the link write is completed by the next completion, rows written ONCE', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    semear(db, ctx);
    const caiu = shopeeDaFamilia({
      [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) =>
        ids.includes(KIT) ? new TypeError('conexão caiu') : { corpo: baseDosComponentes(ids) },
    });
    await expect(
      criarKit(depsDe(db, caiu.client), ctx, planoDeCriacao(ctx)),
    ).rejects.toBeInstanceOf(ShopeeNetworkError);
    // M76: the link exists with the LITERAL kitNativo, and no row was written yet.
    expect(db.idsEm('produtos/filho-a/variashopee')).toEqual([]);

    const shopee = shopeeDaFamilia();
    const deps = depsDe(db, shopee.client);
    const resume = contexto({ arma: { arma: 'kit-atualizar', linkDocId: LINK } });
    const c = await completarKit(
      deps,
      resume,
      planoDeCriacao(resume, { kitNovo: null, corpo: null }),
      {
        linkDocId: LINK,
        itemId: KIT,
        ligacao: 'opcao',
      },
    );
    expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(0);
    expect(c.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(linhaDe(db, 'filho-a', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(FILHO_A.componentesKit),
    );
    expect(db.store[`produtos/${K}/prodshopee/${LINK}`]?.data).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
    });

    // Idempotent: the same completion over the rows it wrote creates nothing new.
    const antes = db.writes.length;
    const de_novo = contexto({
      arma: { arma: 'kit-atualizar', linkDocId: LINK },
      linhasDaConta: linhasDaConta(db, ['filho-a', 'filho-b']),
    });
    await completarKit(deps, de_novo, planoDeCriacao(de_novo, { kitNovo: null, corpo: null }), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });
    const novas = db.writes.slice(antes).map((w) => w.path);
    expect(novas.filter((p) => p.includes('/variashopee/')).sort()).toEqual(
      [
        `produtos/filho-a/variashopee/${idDaVariacaoDeKit(LINK, M0)}`,
        `produtos/filho-b/variashopee/${idDaVariacaoDeKit(LINK, M1)}`,
      ].sort(),
    );
    expect(db.idsEm('produtos/filho-a/variashopee')).toHaveLength(1);
    expect(db.idsEm('produtos/filho-b/variashopee')).toHaveLength(1);
  });

  it('(M76) crash after the link write: the stored link is kitNativo true ⇒ step 12 answers kit-derivado', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    semear(db, ctx);
    const shopee = shopeeDaFamilia({
      [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) =>
        ids.includes(KIT) ? new TypeError('conexão caiu') : { corpo: baseDosComponentes(ids) },
    });
    await expect(criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx))).rejects.toThrow();
    const link = db.store[`produtos/${K}/prodshopee/${LINK}`]?.data ?? {};
    expect(link.kitNativo).toBe(true);
    expect(podeEnviarEstoqueShopee(link, { ehKitVirtual: true }, { nowMs: AGORA })).toEqual({
      enviar: false,
      motivo: 'kit-derivado',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         the failed create (L9 table)                       */
/* -------------------------------------------------------------------------- */

describe('a failed add_kit_item — nao-criado vs incerto (recusaKit.ts decides)', () => {
  it('(M77, M78, M92) incerto ⇒ ONE call, write log EMPTY, recusa carries the motivo, Shopee’s sentence warned verbatim', async () => {
    const db = new FakeDb();
    const ctx = contexto();
    const shopee = shopeeDaFamilia({
      [SHOPEE_ADD_KIT_ITEM_PATH]: () => ({
        corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS),
      }),
    });
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

    expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(1);
    expect(shopee.quantas(SHOPEE_GET_ITEM_BASE_INFO_PATH)).toBe(0);
    expect(db.writes).toEqual([]);
    const frase = String(objeto(lerFixture(FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS)).message);
    expect(r).toMatchObject({
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      kitNativo: null,
      recusa: {
        codigo: 'product.error_busi',
        fraseShopee: frase,
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.instabilidadeShopee,
      },
      comando: 'publicar:anuncio --integracao int-1 --produto kit-k',
    });
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(aviso.mock.calls[0])).toContain(JSON.stringify(frase).slice(1, -1));
  });

  it('incerto also for a dropped connection and for a 2xx without item_id — never a retry', async () => {
    for (const resposta of [
      (): Resposta => new TypeError('socket hang up'),
      (): Resposta => ({ corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG_CORPO_VAZIO) }),
    ]) {
      const db = new FakeDb();
      const shopee = shopeeDaFamilia({ [SHOPEE_ADD_KIT_ITEM_PATH]: resposta });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const r = await criarKit(depsDe(db, shopee.client), contexto(), planoDeCriacao(contexto()));
      expect(r.desfecho).toBe('incerto');
      expect(r.recusa?.motivo).toBeNull();
      expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(1);
      expect(db.writes).toEqual([]);
    }
  });

  it('the incerto command names the --principal that was sent (re-run = the SAME command)', async () => {
    const db = new FakeDb();
    const shopee = shopeeDaFamilia({
      [SHOPEE_ADD_KIT_ITEM_PATH]: () => ({
        corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS),
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ctx = contexto({ principalPedido: { itemId: A, modelId: MA } });
    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));
    expect(r.comando).toBe(
      'publicar:anuncio --integracao int-1 --produto kit-k --principal comp-a',
    );
  });

  it('(M78) nao-criado — a KNOWN permanent refusal — writes NOTHING and is a 422 at etapa add_kit_item', async () => {
    const db = new FakeDb();
    const shopee = shopeeDaFamilia({
      [SHOPEE_ADD_KIT_ITEM_PATH]: () => ({
        corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG_DOIS_PRINCIPAIS),
      }),
    });
    const erro = await criarKit(
      depsDe(db, shopee.client),
      contexto(),
      planoDeCriacao(contexto()),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    const rejeitado = erro as ShopeePublishRejectedError;
    expect(rejeitado.etapa).toBe('add_kit_item');
    expect(rejeitado.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PROBLEMA_PUBLICACAO.kitPrincipalDuplicado,
    ]);
    expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it('nao-criado by our own package guard keeps its class (ShopeeConfigError) and sends nothing', async () => {
    const db = new FakeDb();
    const shopee = shopeeDaFamilia();
    const ctx = contexto();
    const plano = planoDeCriacao(ctx);
    const semFoto: ShopeeAddKitItemRequest = {
      ...plano.corpo!,
      item_setting: { ...plano.corpo!.item_setting, images: { image_id_list: [] } },
    };
    await expect(
      criarKit(depsDe(db, shopee.client), ctx, { ...plano, corpo: semFoto }),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(shopee.chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*            the ensure step: OURS from the links, recusar, completar        */
/* -------------------------------------------------------------------------- */

/** A live native-kit link of K for the conta. */
function vinculoNativo(
  id: string,
  itemId: number,
  extra: Bruto = {},
): ContextoKit['vinculos'][number] {
  return {
    id,
    raw: {
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_id: itemId,
      kitNativo: true,
      estadoAnuncio: 'ativo',
      item_name: 'Kit de teste',
      ...extra,
    },
  };
}

describe('garantirKitNovo — L9 "ensure the new kit exists"', () => {
  it('(M165) OURS from the LINK: the scan did not list the linked kit ⇒ completar, ZERO add_kit_item', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const ctx = contexto({
      vinculos: [vinculoNativo(LINK, KIT)],
      busca: { completo: true, achados: [], paginas: 1, chamadas: 1 },
      nossosVivos: new Map([[KIT, 'NORMAL']]),
    });
    const plano = planejarKit(ctx, null);
    expect(plano.kitNovo).toEqual({ acao: 'completar', linkDocId: LINK, itemId: KIT });
    const shopee = shopeeDaFamilia();

    const g = await garantirKitNovo(depsDe(db, shopee.client), ctx, plano);

    expect(g.desfecho).toBe('retomado');
    expect(g.linkDocId).toBe(LINK);
    expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(0);
    expect(g.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
  });

  it('(M165) a linked kit that reads GONE is dropped ⇒ criar, and THAT link ends removido before the add', async () => {
    for (const status of [null, 'SELLER_DELETE']) {
      const db = new FakeDb();
      const velho = idDoVinculoDeKit('int-1', KIT_2);
      db.seed(`produtos/${K}/prodshopee/${velho}`, vinculoNativo(velho, KIT_2).raw);
      semear(db, contexto());
      const ctx = contexto({
        vinculos: [vinculoNativo(velho, KIT_2)],
        nossosVivos: new Map([[KIT_2, status]]),
      });
      const real = planejarKit(ctx, null);
      expect(real.kitNovo).toEqual({ acao: 'criar' });
      const shopee = shopeeDaFamilia();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const g = await garantirKitNovo(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

      expect(g.desfecho).toBe('criado');
      expect(shopee.quantas(SHOPEE_ADD_KIT_ITEM_PATH)).toBe(1);
      expect(db.store[`produtos/${K}/prodshopee/${velho}`]?.data.estadoAnuncio).toBe('removido');
      // The removido landed BEFORE add_kit_item's link write.
      const ordem = db.writes.map((w) => w.path);
      expect(ordem.indexOf(`produtos/${K}/prodshopee/${velho}`)).toBeLessThan(
        ordem.indexOf(`produtos/${K}/prodshopee/${LINK}`),
      );
    }
  });

  it('(M81) a FOREIGN same-SKU kit refuses "importe-o" with ZERO add_kit_item and nothing written', async () => {
    const db = new FakeDb();
    const ctx = contexto({
      busca: {
        completo: true,
        achados: [{ itemId: KIT_2, vinculo: null }],
        paginas: 1,
        chamadas: 2,
      },
    });
    const plano = planejarKit(ctx, null);
    const shopee = shopeeDaFamilia();
    const erro = await garantirKitNovo(depsDe(db, shopee.client), ctx, plano).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ShopeePublishBlockedError);
    const motivos = (erro as ShopeePublishBlockedError).problemas.map((p) => p.motivo);
    expect(motivos).toContain('kit-ja-existe-na-shopee');
    // Each miss once, even though the plan already aggregates the scan's.
    expect(new Set(motivos).size).toBe(motivos.length);
    expect(shopee.chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('(M170) a completar never evaluates principal-*: a 2-item resume with no --principal proceeds', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const ctx = contexto({
      principal: null,
      principalPedido: null,
      vinculos: [vinculoNativo(LINK, KIT)],
      nossosVivos: new Map([[KIT, 'NORMAL']]),
    });
    const plano = planejarKit(ctx, null);
    expect(plano.problemas).toEqual([]);
    const shopee = shopeeDaFamilia();
    const g = await garantirKitNovo(depsDe(db, shopee.client), ctx, plano);
    expect(g.desfecho).toBe('retomado');
  });

  it('(M170 near-miss = M96) the same kit on criar without --principal refuses principal-obrigatorio, nothing sent', async () => {
    const db = new FakeDb();
    const ctx = contexto({ principal: null, principalPedido: null });
    const plano = planejarKit(ctx, null);
    const shopee = shopeeDaFamilia();
    const erro = await garantirKitNovo(depsDe(db, shopee.client), ctx, plano).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ShopeePublishBlockedError);
    expect((erro as ShopeePublishBlockedError).problemas.map((p) => p.motivo)).toContain(
      'principal-obrigatorio',
    );
    expect(shopee.chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('(M181) a completar neither refuses nor warns on a CONTENT row; a RECIPE row is receita-nao-publicavel, unstamped', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    // filho-b now names a component with no listing; no channel; no price.
    const filhoB = { ...FILHO_B, preco: null, componentesKit: { 'comp-c': { quantidade: 3 } } };
    const ctx = contexto({
      filhos: [FILHO_A, filhoB],
      canais: [],
      vinculos: [vinculoNativo(LINK, KIT)],
      nossosVivos: new Map([[KIT, 'NORMAL']]),
    });
    const plano = planejarKit(ctx, null);
    expect(plano.problemas).toEqual([]);
    const shopee = shopeeDaFamilia();

    const g = await garantirKitNovo(depsDe(db, shopee.client), ctx, plano);

    const codigos = g.avisos.map((a) => a.codigo);
    expect(codigos).toContain('receita-nao-publicavel');
    expect(codigos).not.toContain('receita-divergente');
    expect(g.avisos.find((a) => a.codigo === 'receita-nao-publicavel')?.produtoId).toBe('filho-b');
    expect(linhaDe(db, 'filho-b', M1)?.receitaKitConferida).toBeNull();
    expect(linhaDe(db, 'filho-a', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(FILHO_A.componentesKit),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                       binding on a resume ('opcao')                        */
/* -------------------------------------------------------------------------- */

describe('ligarModelosDoKit — rows first, then option, then SKU', () => {
  const modelos = [
    {
      model_id: M0,
      model_sku: 'KIT-1-AZ',
      original_price: 1,
      tier_index: [0],
      component_list: [],
    },
    {
      model_id: M1,
      model_sku: 'KIT-1-VD',
      original_price: 1,
      tier_index: [1],
      component_list: [],
    },
  ];

  it('(V2R1-03) an existing row on THIS link wins over the variante — the row decides the owner', () => {
    const r = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'Verde'],
      filhos: [FILHO_A, FILHO_B],
      familiaDeUm: false,
      linhasDoLink: [{ produtoId: 'filho-b', raw: { model_id: M0 } }],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(r.ligacoes.map((l) => [l.modelo.model_id, l.filhoId])).toEqual([
      [M0, 'filho-b'],
      [M1, null],
    ]);
    expect(r.filhosSemModelo).toEqual(['filho-a']);
  });

  it('option text binds; SKU binds only what the option did not; near-miss: a case-different option binds NOTHING', () => {
    // No SKU matches here, so filho-a can ONLY bind through its option text.
    const r = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'verde'],
      filhos: [
        { ...FILHO_A, sku: 'SEM-SKU-IGUAL' },
        { ...FILHO_B, sku: 'OUTRO' },
      ],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(r.ligacoes.map((l) => l.filhoId)).toEqual(['filho-a', null]);
    const porSku = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'verde'],
      filhos: [FILHO_A, FILHO_B],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(porSku.ligacoes.map((l) => l.filhoId)).toEqual(['filho-a', 'filho-b']);
  });

  it('a família de um’s single model binds to the member whatever its option says', () => {
    const membro = filho('membro', null, 'KIT-1-UN', FILHO_A.componentesKit, 0);
    const r = ligarModelosDoKit({
      modelos: [modelos[0]!],
      opcoes: ['Kit um'],
      filhos: [membro],
      familiaDeUm: true,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(r.ligacoes[0]?.filhoId).toBe('membro');
  });

  it('(R6-M10 AK2) a família de um whose live kit carries TWO free models binds NEITHER by the shortcut — both modelo-sem-filho, the member unbound', () => {
    // E.g. a model appended in Seller Centre: the shortcut is "the ONE model", and
    // with two there is no telling which one the member was sent as. No option or
    // SKU matches, so only the shortcut could bind.
    const membro = filho('membro', null, 'KIT-1-UN', FILHO_A.componentesKit, 0);
    const r = ligarModelosDoKit({
      modelos,
      opcoes: ['Kit um', 'Kit dois'],
      filhos: [membro],
      familiaDeUm: true,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(r.ligacoes.map((l) => [l.modelo.model_id, l.filhoId])).toEqual([
      [M0, null],
      [M1, null],
    ]);
    expect(r.filhosSemModelo).toEqual(['membro']);
  });

  it('(R6-M13 AK1) a row on this link owned by a produto that is NOT a child binds nothing — the model falls through to the option pass', () => {
    // DEFENSIVE: rows are read under ctx.filhos today; the binder does not trust it.
    const r = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'Verde'],
      filhos: [FILHO_A, FILHO_B],
      familiaDeUm: false,
      linhasDoLink: [{ produtoId: 'ex-filho', raw: { model_id: M0 } }],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(r.ligacoes.map((l) => [l.modelo.model_id, l.filhoId])).toEqual([
      [M0, 'filho-a'],
      [M1, 'filho-b'],
    ]);
    expect(r.filhosSemModelo).toEqual([]);
  });

  it('(R2-F1) the option pass compares through the SENT fold: a padded variante binds the trimmed live option (EQUAL); a case-different one does not (near-miss)', () => {
    // The create and the append send `opcaoDoTierKit(variante)` — trimmed — so the
    // live option of a child whose grupo name is 'Azul ' reads 'Azul'. No SKU
    // matches, so ONLY the option pass can bind.
    const semSku = (f: FilhoDoKit, variante: string): FilhoDoKit => ({
      ...f,
      variante,
      sku: `SEM-${f.produtoId}`,
    });
    const igual = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'Verde'],
      filhos: [semSku(FILHO_A, 'Azul '), semSku(FILHO_B, ' Verde')],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(igual.ligacoes.map((l) => [l.modelo.model_id, l.filhoId])).toEqual([
      [M0, 'filho-a'],
      [M1, 'filho-b'],
    ]);
    expect(igual.filhosSemModelo).toEqual([]);
    // …and a padded LIVE option binds a clean variante (both sides fold).
    const vivoComEspaco = ligarModelosDoKit({
      modelos,
      opcoes: [' Azul', 'Verde'],
      filhos: [semSku(FILHO_A, 'Azul'), semSku(FILHO_B, 'Verde')],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(vivoComEspaco.ligacoes[0]?.filhoId).toBe('filho-a');

    // Near-miss: the fold trims, it never folds case — 'azul ' ≢ 'Azul'.
    const distinto = ligarModelosDoKit({
      modelos,
      opcoes: ['Azul', 'Verde'],
      filhos: [semSku(FILHO_A, 'azul '), semSku(FILHO_B, 'Verde')],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(distinto.ligacoes.map((l) => l.filhoId)).toEqual([null, 'filho-b']);
    expect(distinto.filhosSemModelo).toEqual(['filho-a']);
  });

  it("(R3-01) a lone NON-família child binds the 'Padrão' sentinel model the create sent for it; near-miss: a lone child never takes a model whose option names another variante", () => {
    // planejarTier sends 'Kit'/'Padrão' for a lone child with no usable axis
    // (here: no grupo), whatever the child's variante — and no SKU matches.
    const sozinho = { ...FILHO_A, variante: null, sku: 'SEM-SKU-IGUAL' };
    const sentinela = ligarModelosDoKit({
      modelos: [modelos[0]!],
      opcoes: ['Padrão'],
      filhos: [sozinho],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(sentinela.ligacoes[0]?.filhoId).toBe('filho-a');
    expect(sentinela.filhosSemModelo).toEqual([]);

    // A lone child WITH a variante the create sent as itself ('Verde') does not
    // take a live 'Azul' model through the lone-child rule: it is no sentinel.
    const outro = ligarModelosDoKit({
      modelos: [modelos[0]!],
      opcoes: ['Azul'],
      filhos: [{ ...FILHO_A, variante: 'Verde', sku: 'SEM-SKU-IGUAL' }],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'opcao',
      tierPorFilho: new Map(),
    });
    expect(outro.ligacoes[0]?.filhoId).toBeNull();
    expect(outro.filhosSemModelo).toEqual(['filho-a']);
  });

  it("'tier-enviado' binds by the SENT tier index, never by option text or position", () => {
    const r = ligarModelosDoKit({
      modelos: [modelos[1]!, modelos[0]!],
      opcoes: ['Verde', 'Azul'],
      filhos: [FILHO_A, FILHO_B],
      familiaDeUm: false,
      linhasDoLink: [],
      ligacao: 'tier-enviado',
      tierPorFilho: new Map([
        ['filho-a', 0],
        ['filho-b', 1],
      ]),
    });
    expect(r.ligacoes.map((l) => [l.modelo.model_id, l.filhoId])).toEqual([
      [M1, 'filho-b'],
      [M0, 'filho-a'],
    ]);
  });
});

describe('completarKit on a resume — modelo-sem-filho and variacao-nao-anexada', () => {
  it('a live model no child matches gets NO row; an ERP child no model carries is reported, never appended', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const filhoC = filho('filho-c', 'Roxo', 'KIT-1-RX', { 'comp-a': { quantidade: 2 } }, 2);
    const ctx = contexto({ filhos: [FILHO_A, filhoC] });
    const shopee = shopeeDaFamilia();
    const c = await completarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });
    expect(c.modelos).toEqual({ vinculados: 1, anexados: 0, semFilho: 1 });
    expect(c.avisos).toContainEqual({
      codigo: 'modelo-sem-filho',
      produtoId: null,
      mensagem:
        `o modelo ${String(M1)} do kit ${String(KIT)} na Shopee não corresponde a nenhuma ` +
        'variação do ERP — nenhum vínculo foi gravado para ele',
    });
    expect(c.avisos).toContainEqual({
      codigo: 'variacao-nao-anexada',
      produtoId: 'filho-c',
      mensagem:
        'a variação filho-c não foi anexada ao kit: o kit já existia na Shopee sem ela — publique ' +
        'de novo para anexá-la',
    });
    expect(db.idsEm('produtos/filho-c/variashopee')).toEqual([]);
  });

  it('the REAL probe kit (one model, B’s hidden id) folds EQUAL for a família de um and stamps the member', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const membro = filho('membro', null, 'KIT-1-UN', FILHO_A.componentesKit, 0);
    const ctx = contexto({ filhos: [membro], familiaDeUm: true, grupo: null });
    const shopee = transporte({
      [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) =>
        ids.includes(KIT)
          ? { corpo: lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT) }
          : { corpo: baseDosComponentes(ids) },
      [SHOPEE_GET_KIT_ITEM_INFO_PATH]: () => ({
        corpo: lerFixture(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO),
      }),
      [SHOPEE_GET_MODEL_LIST_PATH]: () => ({ corpo: lerFixture(FIXTURE_MODEL_LIST_SG_KIT) }),
    });
    const c = await completarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });
    expect(c.modelos.vinculados).toBe(1);
    expect(c.avisos).toEqual([]);
    expect(linhaDe(db, 'membro', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(membro.componentesKit),
    );
    // Near-miss of the hidden-id fold: with B's has_model UNKNOWN the ids compare
    // literally, and 2000458829 is not "no model" — no stamp.
    const db2 = new FakeDb();
    db2.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const desconhecido = transporte({
      [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) =>
        ids.includes(KIT)
          ? { corpo: lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT) }
          : { corpo: baseDosComponentes(ids.filter((id) => id !== B)) },
      [SHOPEE_GET_KIT_ITEM_INFO_PATH]: () => ({
        corpo: lerFixture(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO),
      }),
      [SHOPEE_GET_MODEL_LIST_PATH]: () => ({ corpo: lerFixture(FIXTURE_MODEL_LIST_SG_KIT) }),
    });
    const semB = contexto({
      filhos: [membro],
      familiaDeUm: true,
      grupo: null,
      temModelos: new Map([[A, true]]),
    });
    await completarKit(depsDe(db2, desconhecido.client), semB, planoDeCriacao(semB), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });
    expect(linhaDe(db2, 'membro', M0)?.receitaKitConferida).toBeNull();

    // ONE authority for both sides: the context's has_model (the map the
    // projection was resolved with) answers for B even when the read-back's
    // component batch did not — so the hidden id still folds to "no model".
    const db3 = new FakeDb();
    db3.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    const doContexto = contexto({ filhos: [membro], familiaDeUm: true, grupo: null });
    await completarKit(depsDe(db3, desconhecido.client), doContexto, planoDeCriacao(doContexto), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });
    expect(linhaDe(db3, 'membro', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(membro.componentesKit),
    );
  });

  it("(R6-M10 AK3) the CONTEXT's has_model wins over the read-back's: ctx B=false vs read-back B=true folds EQUAL and stamps; near-misses: a component the ctx never saw takes the read-back's value", async () => {
    const membro = filho('membro', null, 'KIT-1-UN', FILHO_A.componentesKit, 0);
    /** The read-back's component batch, with B's `has_model` as given. */
    const lojaComB = (bTemModelos: boolean) =>
      transporte({
        [SHOPEE_GET_ITEM_BASE_INFO_PATH]: (ids) => {
          if (ids.includes(KIT)) return { corpo: lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT) };
          const corpo = baseDosComponentes(ids);
          const resposta = objeto(corpo.response);
          const linhas = (resposta.item_list as Bruto[]).map((l) =>
            l.item_id === B ? { ...l, has_model: bTemModelos } : l,
          );
          return { corpo: { ...corpo, response: { ...resposta, item_list: linhas } } };
        },
        [SHOPEE_GET_KIT_ITEM_INFO_PATH]: () => ({
          corpo: lerFixture(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO),
        }),
        [SHOPEE_GET_MODEL_LIST_PATH]: () => ({ corpo: lerFixture(FIXTURE_MODEL_LIST_SG_KIT) }),
      });
    const carimbo = async (ctx: ContextoKit, bTemModelos: boolean): Promise<unknown> => {
      const db = new FakeDb();
      db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
      await completarKit(depsDe(db, lojaComB(bTemModelos).client), ctx, planoDeCriacao(ctx), {
        linkDocId: LINK,
        itemId: KIT,
        ligacao: 'opcao',
      });
      return linhaDe(db, 'membro', M0)?.receitaKitConferida;
    };
    const esperado = chaveReceitaKitErp(membro.componentesKit);

    // B gained variations between the context read and the read-back: the
    // projection was RESOLVED with B=false, so the fold must read B=false too.
    const doContexto = contexto({ filhos: [membro], familiaDeUm: true, grupo: null });
    expect(await carimbo(doContexto, true)).toBe(esperado);

    // Near-miss: B absent from the ctx ⇒ the read-back answers for it.
    const semB = contexto({
      filhos: [membro],
      familiaDeUm: true,
      grupo: null,
      temModelos: new Map([[A, true]]),
    });
    expect(await carimbo(semB, true)).toBeNull();
    expect(await carimbo(semB, false)).toBe(esperado);
  });
});

describe('completarKit — the binding and the stamp read what was SENT and what is STORED', () => {
  it('(R2-F1) a resume re-binds a child whose grupo name is padded: its row is written and stamped, nothing is orphaned', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}/prodshopee/${LINK}`, vinculoNativo(LINK, KIT).raw);
    // The create SENT 'Azul' (trimmed); FilhoDoKit.variante keeps the padding.
    // Neither SKU matches a live model_sku, so only the option pass can bind.
    const filhos = [
      { ...FILHO_A, variante: 'Azul ', sku: 'SEM-SKU-A' },
      { ...FILHO_B, variante: 'Verde', sku: 'SEM-SKU-B' },
    ];
    const ctx = contexto({ arma: { arma: 'kit-atualizar', linkDocId: LINK }, filhos });
    const shopee = shopeeDaFamilia();

    const c = await completarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx), {
      linkDocId: LINK,
      itemId: KIT,
      ligacao: 'opcao',
    });

    expect(c.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(c.avisos.map((a) => a.codigo)).toEqual([]);
    expect(linhaDe(db, 'filho-a', M0)).toMatchObject({ model_id: M0, tier_index: [0] });
    expect(linhaDe(db, 'filho-a', M0)?.receitaKitConferida).toBe(
      chaveReceitaKitErp(FILHO_A.componentesKit),
    );
  });

  it('(R1-RT7-02 / R3-03) a stored entry WITHOUT quantidade: the stamp is the STORED fingerprint, so the aviso decision resolves after a verified create', async () => {
    const db = new FakeDb();
    // filho-a's comp-b is stored with no quantidade: the parse reads 1 (and the
    // create sends 1), the readers' fold reads null.
    const armazenado: NonNullable<FilhoDoKit['componentesKitArmazenado']> = {
      'comp-a': { quantidade: 2 },
      'comp-b': { limitarEstoque: true },
    };
    const filhoA: FilhoDoKit = { ...FILHO_A, componentesKitArmazenado: armazenado };
    const ctx = contexto({ filhos: [filhoA, FILHO_B] });
    db.seed(`produtos/${K}`, { nome: 'Kit de teste', ehKit: true, sku: 'KIT-1', paiId: null });
    db.seed('produtos/filho-a', { paiId: K, sku: FILHO_A.sku, componentesKit: armazenado });
    db.seed('produtos/filho-b', {
      paiId: K,
      sku: FILHO_B.sku,
      componentesKit: FILHO_B.componentesKit,
    });
    const shopee = shopeeDaFamilia();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const r = await criarKit(depsDe(db, shopee.client), ctx, planoDeCriacao(ctx));

    // The fold scope the near-miss pins: the two inputs DO fingerprint apart…
    expect(chaveReceitaKitErp(armazenado)).not.toBe(chaveReceitaKitErp(FILHO_A.componentesKit));
    // …and the writer took the STORED one, the readers' input.
    expect(linhaDe(db, 'filho-a', M0)?.receitaKitConferida).toBe(chaveReceitaKitErp(armazenado));
    expect(r.avisos.map((a) => a.codigo)).not.toContain('receita-divergente');
    // The SAME decision the trigger runs reads stamp === current for every row.
    expect(r.avisosResolvidos).toBe(1);
    const aviso = db.store[`avisos/${chaveAvisoReceitaKitShopee('int-1', K)}`]?.data;
    expect(aviso === undefined || aviso.resolvidoEm !== null).toBe(true);
  });
});

describe('the incerto command — the SAME flags again (OP-8 / OP-9)', () => {
  const incerto = () =>
    shopeeDaFamilia({
      [SHOPEE_ADD_KIT_ITEM_PATH]: () => ({
        corpo: lerFixture(FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS),
      }),
    });

  it('a paused create (--status UNLIST) re-renders --status UNLIST; NORMAL prints nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const pausado = contexto({ statusPedido: 'UNLIST' });
    const r = await criarKit(
      depsDe(new FakeDb(), incerto().client),
      pausado,
      planoDeCriacao(pausado),
    );
    expect(r.comando).toBe('publicar:anuncio --integracao int-1 --produto kit-k --status UNLIST');

    const normal = contexto({ statusPedido: 'NORMAL' });
    const n = await criarKit(
      depsDe(new FakeDb(), incerto().client),
      normal,
      planoDeCriacao(normal),
    );
    expect(n.comando).toBe('publicar:anuncio --integracao int-1 --produto kit-k');
  });

  it('the --principal printed is the id the operator TYPED, not the lexically-first alias of its address', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // 'comp-a-alias' resolves to the SAME address as 'comp-a', which sorts first.
    const ctx = contexto({
      resolucao: new Map([
        ...RESOLUCAO,
        ['comp-a-alias', { ok: true, endereco: { itemId: A, modelId: MA } }],
      ]),
      principalPedido: { itemId: A, modelId: MA },
      principalSolicitado: 'comp-a-alias',
    });
    const r = await criarKit(depsDe(new FakeDb(), incerto().client), ctx, planoDeCriacao(ctx));
    expect(r.comando).toBe(
      'publicar:anuncio --integracao int-1 --produto kit-k --principal comp-a-alias',
    );
  });
});

describe('linhasLidasDoModeloKit — the live-row adapter', () => {
  it('keeps item, model (the hidden one included), quantity and the main flag; a null quantity reads 0', () => {
    expect(
      linhasLidasDoModeloKit({
        model_id: M0,
        model_sku: null,
        original_price: null,
        tier_index: [0],
        component_list: [
          {
            component_item_id: B,
            component_item_name: null,
            component_model_id: MB_OCULTO,
            component_model_name: null,
            quantity: null,
            main_component: null,
            component_item_or_model_image: null,
            component_item_or_model_sku: null,
          },
        ],
      }),
    ).toEqual([
      { component_item_id: B, component_model_id: MB_OCULTO, quantity: 0, main_component: false },
    ]);
  });
});

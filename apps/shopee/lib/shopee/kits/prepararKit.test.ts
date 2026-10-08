import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeKitItemLimitPayloadSchema,
  shopeeLogisticsChannelSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, toOuterRef, varianteFakePath } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
} from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import type { PrepararPublicacaoDeps } from '../anuncios/publicarAnuncio';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb } from '../testing/fakeDb';
import { CAP_FOTOS_KIT } from './constantesKit';
import { idDoVinculoDeKit } from './idsKit';
import { tetoDeFotosDoKit } from './planoKit';
import { prepararKit, type ArmaDeKit, type EntradaDeKit } from './prepararKit';

/* -------------------------------------------------------------------------- */
/*  Fixtures — role ids only (s19-ctx). Never a real partner, shop or item.     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const REF_OUTRA_CONTA = toOuterRef(integracaoCollection.docPath({}, 'int-2'));
const AGORA = 1_757_000_000_000;

/** The kit roles (D1): the kit, component A (2 tiers) and the plain component B. */
const KIT_ITEM = 2500139870;
const KIT_MODELO = 2000458820;
const COMP_A_ITEM = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B_ITEM = 2500139872;
const COMP_B_OCULTO = 2000458829;
/** A second kit (the double-create twin role). */
const KIT_2_ITEM = 2500139873;
/** Shopee's doc-sample category. */
const CATEGORIA = 107290;
const CANAL = 90_003;

const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const GRUPO = 'grupo-cor';
const SKU = 'KIT-1';

const CAMINHO_LINK_COMP_A = 'documents/produtos/comp-a/prodshopee/link-comp-a';

/* --------------------------------- the db --------------------------------- */

/** Component A: a 2-tier listing; the ERP component is its VARIATION child. */
function semearComponenteA(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Camiseta', sku: 'CAM', paiId: null });
  db.seed('produtos/comp-a/prodshopee/link-comp-a', {
    item_id: COMP_A_ITEM,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
  });
  db.seed('produtos/comp-a-filho', { nome: 'Camiseta P', sku: 'CAM-P', paiId: 'comp-a' });
  db.seed('produtos/comp-a-filho/variashopee/var-comp-a', {
    model_id: COMP_A_MODELO,
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: CAMINHO_LINK_COMP_A,
  });
}

/** Component B: a plain listing on a família-de-um WRAPPER; the ERP key is the MEMBER (#1450). */
function semearComponenteB(db: FakeDb): void {
  db.seed('produtos/comp-b', {
    nome: 'Boné',
    sku: 'BONE',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
  });
  db.seed('produtos/comp-b/prodshopee/link-comp-b', {
    item_id: COMP_B_ITEM,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Boné', sku: 'BONE-UN', paiId: 'comp-b' });
}

/** K, a 2-child family kit (one axis, `Cor`): Azul = A + B, Verde = 2 × A. */
function semearKit(db: FakeDb, over: Json = {}): void {
  db.seed(`produtos/${K}`, {
    nome: 'Kit camiseta e boné',
    sku: SKU,
    paiId: null,
    ehKit: true,
    ehKitVirtual: true,
    pesoBrutoKg: 0.8,
    alturaCm: 10,
    larguraCm: 20,
    profundidadeCm: 30,
    precos: { 'tab-normal': { valor: 99.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }, { arquivoOuterRef: 'arquivos/arq-2' }],
    ...over,
  });
  db.seed(`produtos/${K}/extraData/singleton`, {
    descricao: 'Kit com uma camiseta de algodão e um boné, para presente.',
  });
  db.seed(`grupoDeVariacoes/${GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    variacoes: [
      { id: 'var-azul', nome: 'Azul' },
      { id: 'var-verde', nome: 'Verde' },
    ],
  });
  // ⚠️ Seeded VERDE first with the higher `ordem`: the context orders by `ordem`,
  // never by the document order the query happens to answer in.
  db.seed(`produtos/${K_VERDE}`, {
    nome: 'Kit verde',
    sku: `${SKU}-VD`,
    paiId: K,
    ordem: 2,
    ehKit: true,
    variacoesUid: [varianteFakePath(GRUPO, 'var-verde')],
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
  db.seed(`produtos/${K_AZUL}`, {
    nome: 'Kit azul',
    sku: `${SKU}-AZ`,
    paiId: K,
    ordem: 1,
    ehKit: true,
    variacoesUid: [varianteFakePath(GRUPO, 'var-azul')],
    componentesKit: {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b-membro': { quantidade: 1, limitarEstoque: true },
    },
  });
}

function semearTudo(db: FakeDb, kit: Json = {}): void {
  semearComponenteA(db);
  semearComponenteB(db);
  semearKit(db, kit);
}

/* ------------------------------- the shop double ---------------------------- */

const BASES: Record<number, Json> = {
  [COMP_A_ITEM]: {
    item_id: COMP_A_ITEM,
    item_status: 'NORMAL',
    has_model: true,
    tag: { kit: false },
  },
  [COMP_B_ITEM]: {
    item_id: COMP_B_ITEM,
    item_status: 'NORMAL',
    has_model: false,
    tag: { kit: false },
  },
};

const CANAL_DA_LOJA = shopeeLogisticsChannelSchema.parse({
  logistics_channel_id: CANAL,
  enabled: true,
  fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
});

/** The gateway's "this host does not serve the path" — `ShopeeOperacaoNaoServidaError`. */
function naoServido(): Error {
  return shopeeErrorFromEnvelope(
    { error: 'error_not_found', message: null, request_id: null, warning: null },
    { path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH, httpStatus: 404, surface: SHOPEE_SURFACE.business },
  );
}

interface OpcoesDaLoja {
  readonly bases?: Record<number, Json>;
  readonly kits?: Record<number, Json>;
  /** `get_item_list` rows (one page). Default: A and B, neither a kit. */
  readonly lista?: readonly Json[];
  /** `'indisponivel'` (the default — the sandbox host), a served band, or a failure. */
  readonly limites?: 'indisponivel' | Json | Error;
  readonly falhaDaBase?: (itemIds: readonly number[]) => Error | null;
}

interface LojaFake {
  readonly client: ShopeeClient;
  /** Every Shopee operation, in CALL order — plus `upload:<cap>` from the resolver. */
  readonly ops: string[];
  readonly basePedidas: (readonly number[])[];
}

/**
 * A shop answering only what a kit's preparation may call. ⚠️ A Proxy: ANY other
 * property is recorded and throws, so "zero Shopee calls" is a fact about the
 * log, never about a spy someone forgot to add.
 */
function lojaFake(op: OpcoesDaLoja = {}): LojaFake {
  const ops: string[] = [];
  const basePedidas: (readonly number[])[] = [];
  const bases = { ...BASES, ...(op.bases ?? {}) };
  const lista = op.lista ?? [
    { item_id: COMP_A_ITEM, item_status: 'NORMAL', tag: { kit: false } },
    { item_id: COMP_B_ITEM, item_status: 'NORMAL', tag: { kit: false } },
  ];
  const conhecidas: Record<string, (...args: never[]) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      basePedidas.push([...p.itemIds]);
      const falha = op.falhaDaBase?.(p.itemIds) ?? null;
      if (falha !== null) return Promise.reject(falha);
      return Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: p.itemIds.flatMap((id) => (bases[id] === undefined ? [] : [bases[id]])),
        }),
      );
    },
    getItemList: () => {
      ops.push('get_item_list');
      return Promise.resolve(
        shopeeItemListPayloadSchema.parse({
          item: lista,
          total_count: lista.length,
          has_next_page: false,
          next_offset: null,
          next: '',
        }),
      );
    },
    getKitItemLimit: () => {
      ops.push('get_kit_item_limit');
      const limites = op.limites ?? 'indisponivel';
      if (limites === 'indisponivel') return Promise.reject(naoServido());
      if (limites instanceof Error) return Promise.reject(limites);
      return Promise.resolve(shopeeKitItemLimitPayloadSchema.parse(limites));
    },
    getChannelList: () => {
      ops.push('get_channel_list');
      return Promise.resolve({ logistics_channel_list: [CANAL_DA_LOJA] });
    },
    getKitItemInfo: (p: { itemId: number }) => {
      ops.push('get_kit_item_info');
      return Promise.resolve(
        shopeeKitItemInfoPayloadSchema.parse({ product_info: op.kits?.[p.itemId] ?? null }),
      );
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push(`?${prop}`);
        throw new Error(`fixture: a preparação do kit chamou ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return { client, ops, basePedidas };
}

/** The photo double: records each pass (its cap) into the shop's op log. */
function resolvedorFake(
  loja: LojaFake,
  imageIds: readonly string[] = ['img-1', 'img-2'],
): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos, opcoes) => {
      loja.ops.push(`upload:${String(opcoes?.cap ?? 'padrao')}`);
      return Promise.resolve({
        imageIds,
        reutilizadas: 0,
        enviadas: imageIds.length,
        falhas: [],
        consideradas: fotos.length,
        descartadasPeloLimite: 0,
      });
    },
    resumo: () => ({
      consideradas: 2,
      reutilizadas: 0,
      enviadas: imageIds.length,
      falhas: 0,
      descartadasPeloLimite: 0,
    }),
  };
}

function deps(db: FakeDb, loja: LojaFake): PrepararPublicacaoDeps {
  return {
    db: asDb(db),
    client: loja.client,
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    depositoOuterRef: 'documents/depositos/dep-1',
    operacaoOuterRef: null,
    nowMs: AGORA,
    taxonomia: {
      integracaoId: INTEGRACAO,
      client: loja.client,
      variationsPath: SHOPEE_GET_VARIATIONS_PATH,
    },
    categorias: {
      carregar: () => {
        throw new Error('fixture: a preparação do kit não lê a árvore de categorias');
      },
    },
  };
}

function entrada(over: Partial<EntradaDeKit> = {}): EntradaDeKit {
  return {
    produtoId: K,
    statusPedido: 'NORMAL',
    principal: 'comp-a-filho',
    ...over,
  };
}

const CRIAR: ArmaDeKit = { arma: 'kit-criar' };

async function preparar(
  db: FakeDb,
  loja: LojaFake,
  ent: Partial<EntradaDeKit> = {},
  arma: ArmaDeKit = CRIAR,
) {
  return await prepararKit(deps(db, loja), entrada(ent), arma, resolvedorFake(loja));
}

async function recusaDe(p: Promise<unknown>): Promise<ShopeePublishBlockedError> {
  const erro = await p.then(
    () => {
      throw new Error('a preparação deveria ter recusado');
    },
    (e: unknown) => e,
  );
  expect(erro).toBeInstanceOf(ShopeePublishBlockedError);
  return erro as ShopeePublishBlockedError;
}

/** A live native-kit link of K (an `ehKitNativoAtivo` row) at its derived id. */
function semearVinculoNativo(db: FakeDb, itemId: number, extra: Json = {}): string {
  const id = idDoVinculoDeKit(INTEGRACAO, itemId);
  db.seed(`produtos/${K}/prodshopee/${id}`, {
    item_id: itemId,
    contaProdutoShopeeOuterRef: REF_CONTA,
    kitNativo: true,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    item_name: 'Kit camiseta e boné',
    description: 'Kit com uma camiseta de algodão e um boné, para presente.',
    ...extra,
  });
  return id;
}

beforeEach(() => {
  limparTaxonomiaShopee();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  limparTaxonomiaShopee();
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  (1) the order: Firestore → phase A → Shopee reads → the scan → photos      */
/* ========================================================================== */

describe('prepararKit — a ordem das leituras (criação)', () => {
  it('Firestore primeiro; depois componentes → limites → canais → busca; as FOTOS por último — e nada é escrito', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(loja.ops).toEqual([
      'get_item_base_info', // the components' has_model (ONE batch)
      'get_kit_item_limit', // the principal's category — not served here
      'get_channel_list',
      'get_item_list', // the L6 scan (no kit candidate ⇒ no second base read)
      `upload:${String(CAP_FOTOS_KIT)}`,
    ]);
    expect(loja.basePedidas).toEqual([[COMP_A_ITEM, COMP_B_ITEM]]);
    expect(db.writes).toEqual([]);
    expect(ctx.fotos?.item.imageIds).toEqual(['img-1', 'img-2']);
    expect(ctx.fotos?.imagensDeOpcao).toBeNull();
    expect(ctx.fotos?.tabelaDeMedidas).toBeNull();
  });

  it('projeta a FAMÍLIA: filhos na ordem da camada, a variante pelo NOME, um eixo, o principal resolvido', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.filhos.map((f) => [f.produtoId, f.variante, f.ordem, f.preco, f.sku])).toEqual([
      [K_AZUL, 'Azul', 1, 99.9, `${SKU}-AZ`],
      [K_VERDE, 'Verde', 2, 99.9, `${SKU}-VD`],
    ]);
    // The child's OWN recipe, through the schema (its defaults included).
    expect(Object.keys(ctx.filhos[1]?.componentesKit ?? {})).toEqual(['comp-a-filho']);
    expect(ctx.filhos[1]?.componentesKit?.['comp-a-filho']).toMatchObject({ quantidade: 2 });
    expect(ctx.familiaDeUm).toBe(false);
    expect(ctx.grupo).toEqual({ id: GRUPO, nome: 'Cor' });
    expect(ctx.gruposDistintos).toBe(1);
    expect(ctx.resolucao.get('comp-a-filho')).toEqual({
      ok: true,
      endereco: { itemId: COMP_A_ITEM, modelId: COMP_A_MODELO },
    });
    // The plain B: no model (has_model false), whatever a stale row would say.
    expect(ctx.resolucao.get('comp-b-membro')).toEqual({
      ok: true,
      endereco: { itemId: COMP_B_ITEM, modelId: null },
    });
    expect(ctx.temModelos.get(COMP_A_ITEM)).toBe(true);
    expect(ctx.temModelos.get(COMP_B_ITEM)).toBe(false);
    expect(ctx.principal).toEqual({ itemId: COMP_A_ITEM, modelId: COMP_A_MODELO });
    expect(ctx.principalPedido).toEqual(ctx.principal);
    expect(ctx.limites).toEqual({ estado: 'indisponivel' });
    expect(ctx.canais).toHaveLength(1);
    expect(ctx.alvo).toBeNull();
    expect(ctx.vivo).toBeNull();
    expect(ctx.busca).toMatchObject({ completo: true, achados: [] });
    expect(ctx.nossosVivos.size).toBe(0);
  });

  it('(R-8) a posição na camada é a da VARIANTE no grupo (a ordem de `montarTiers`), não o `ordem` do filho', async () => {
    const db = new FakeDb();
    semearTudo(db);
    // The children's `ordem` now DISAGREES with the grupo (Verde first).
    db.seed(`produtos/${K_AZUL}`, { ...db.store[`produtos/${K_AZUL}`]!.data, ordem: 9 });
    db.seed(`produtos/${K_VERDE}`, { ...db.store[`produtos/${K_VERDE}`]!.data, ordem: 1 });
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.filhos.map((f) => f.variante)).toEqual(['Azul', 'Verde']);
  });

  it('⚠️ NEAR-MISS (R-8): o grupo com as variantes na ordem INVERSA inverte a camada — o grupo decide, nunca a semeadura', async () => {
    const db = new FakeDb();
    semearTudo(db);
    db.seed(`grupoDeVariacoes/${GRUPO}`, {
      nome: 'Cor',
      ordem: 1,
      variacoes: [
        { id: 'var-verde', nome: 'Verde' },
        { id: 'var-azul', nome: 'Azul' },
      ],
    });
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.filhos.map((f) => f.variante)).toEqual(['Verde', 'Azul']);
  });

  it('sem variante no grupo (nenhum eixo), o `ordem` do filho desempata — ausente por último', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    db.seed(`produtos/${K_AZUL}`, {
      ...db.store[`produtos/${K_AZUL}`]!.data,
      variacoesUid: [],
      ordem: null,
    });
    db.seed(`produtos/${K_VERDE}`, { ...db.store[`produtos/${K_VERDE}`]!.data, variacoesUid: [] });
    const loja = lojaFake({ bases: { [KIT_ITEM]: baseDoKit() }, kits: { [KIT_ITEM]: kitVivo() } });

    // kit-atualizar: a create would refuse the missing axis in phase A.
    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(ctx.grupo).toBeNull();
    expect(ctx.filhos.map((f) => f.produtoId)).toEqual([K_VERDE, K_AZUL]);
  });

  it('uma família de UM: filhos = [membro], sem eixo, sem variante', async () => {
    const db = new FakeDb();
    semearComponenteA(db);
    db.seed(`produtos/${K}`, {
      nome: 'Kit camiseta dupla',
      sku: SKU,
      paiId: null,
      ehKit: true,
      ehKitVirtual: true,
      filhoUnicoId: 'kit-k-un',
      pesoBrutoKg: 0.4,
      alturaCm: 10,
      larguraCm: 20,
      profundidadeCm: 30,
      precos: { 'tab-normal': { valor: 59.9 } },
      componentesKit: { 'comp-a-filho': { quantidade: 2 } },
    });
    db.seed(`produtos/${K}/extraData/singleton`, { descricao: 'Duas camisetas de algodão, kit.' });
    db.seed('produtos/kit-k-un', {
      nome: 'Kit camiseta dupla',
      sku: `${SKU}-UN`,
      paiId: K,
      ehKit: true,
      componentesKit: { 'comp-a-filho': { quantidade: 2 } },
    });
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.familiaDeUm).toBe(true);
    expect(ctx.filhos.map((f) => [f.produtoId, f.variante, f.preco])).toEqual([
      ['kit-k-un', null, 59.9],
    ]);
    expect(ctx.grupo).toBeNull();
    expect(ctx.gruposDistintos).toBe(0);
  });
});

/* ========================================================================== */
/*  (2) phase A — every miss, before ANY Shopee call                           */
/* ========================================================================== */

describe('prepararKit — a fase A (Firestore apenas)', () => {
  it('(M84) lista TODAS as faltas numa só recusa e para ANTES da primeira chamada à Shopee', async () => {
    const db = new FakeDb();
    semearTudo(db, { sku: null, pesoBrutoKg: null, pesoLiquidoKg: null });
    db.seed(`produtos/${K}/extraData/singleton`, { descricao: '' });
    const loja = lojaFake();

    const erro = await recusaDe(preparar(db, loja));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.kitSemSku,
      MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
      MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
    ]);
    expect(erro.produtoId).toBe(K);
    expect(loja.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it("(M90) o SKU 'KIT-1 ' ⇒ kit-sku-com-espacos; sem SKU ⇒ kit-sem-sku — zero chamadas à Shopee nos dois", async () => {
    for (const [sku, motivo] of [
      [`${SKU} `, MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuComEspacos],
      [null, MOTIVO_PUBLICACAO_BLOQUEADA.kitSemSku],
    ] as const) {
      const db = new FakeDb();
      semearTudo(db, { sku });
      const loja = lojaFake();

      const erro = await recusaDe(preparar(db, loja));

      expect(erro.problemas.map((p) => p.motivo)).toEqual([motivo]);
      expect(loja.ops).toEqual([]);
    }
  });

  it('(M97) outro produto RAIZ com o SKU de K ⇒ kit-sku-repetido nomeando-o, zero chamadas; a consulta é o degrau 2 do passo 9', async () => {
    const db = new FakeDb();
    semearTudo(db);
    db.seed('produtos/outro-pai', { nome: 'Outro', sku: SKU, paiId: null });
    const loja = lojaFake();

    const erro = await recusaDe(preparar(db, loja));

    expect(erro.problemas).toHaveLength(1);
    expect(erro.problemas[0]).toMatchObject({
      campo: 'sku',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuRepetido,
    });
    expect(erro.problemas[0]?.mensagem).toContain('outro-pai');
    expect(loja.ops).toEqual([]);
    // The very query step 9's parent rung runs (R-14): sku ==, paiId == null, limit(2).
    expect(db.consultasCompletas.filter((c) => c.fonte === 'produtos' && c.limite === 2)).toEqual([
      {
        fonte: 'produtos',
        clausulas: [
          ['sku', '==', SKU],
          ['paiId', '==', null],
        ],
        ordens: [],
        limite: 2,
        apos: null,
      },
    ]);
  });

  it('⚠️ NEAR-MISS (M97): um FILHO com o mesmo SKU (paiId preenchido) não conta — a criação segue', async () => {
    const db = new FakeDb();
    semearTudo(db);
    db.seed('produtos/outro-filho', { nome: 'Outro', sku: SKU, paiId: 'algum-pai' });
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.busca).not.toBeNull();
    expect(loja.ops).toContain('get_item_list');
  });

  it('kit-atualizar CARREGA a falta da fase A (sem-peso) sem recusar — e não resolve foto (M184)', async () => {
    const db = new FakeDb();
    semearTudo(db, { pesoBrutoKg: null, pesoLiquidoKg: null });
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({ kits: { [KIT_ITEM]: kitVivo() }, bases: { [KIT_ITEM]: baseDoKit() } });

    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(ctx.fotos).toBeNull();
    expect(loja.ops.some((o) => o.startsWith('upload'))).toBe(false);
  });

  it('⚠️ NEAR-MISS (M184): o MESMO kit-atualizar sem falta da fase A resolve as fotos', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({ kits: { [KIT_ITEM]: kitVivo() }, bases: { [KIT_ITEM]: baseDoKit() } });

    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(ctx.fotos?.item.imageIds).toEqual(['img-1', 'img-2']);
  });
});

/* ========================================================================== */
/*  (3) the kit limits — best-effort                                           */
/* ========================================================================== */

/** A served kit band (the doc sample's shape). */
function limitesServidos(over: Json = {}): Json {
  return {
    price_limit: { min_limit: 1, max_limit: 10_000 },
    item_name_length_limit: { min_limit: 5, max_limit: 120 },
    item_image_count_limit: { min_limit: 1, max_limit: 9 },
    component_count_limit_of_single_model: { min_limit: 2, max_limit: 10 },
    ...over,
  };
}

describe('prepararKit — os limites de kit (melhor esforço)', () => {
  it('(M85) o host que NÃO serve get_kit_item_limit ⇒ `indisponivel` no contexto, e a criação SEGUE até as fotos', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({ limites: 'indisponivel' });

    const ctx = await preparar(db, loja);

    expect(ctx.limites).toEqual({ estado: 'indisponivel' });
    expect(ctx.fotos).not.toBeNull();
  });

  it('servido ⇒ a faixa vai para o contexto, lida na categoria do PRINCIPAL', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({ limites: limitesServidos() });

    const ctx = await preparar(db, loja);

    expect(ctx.limites?.estado).toBe('servido');
    expect(ctx.categoriaPorProduto.get('comp-a-filho')).toBe(CATEGORIA);
  });

  it('⛔ uma FALHA de verdade não vira `indisponivel` nem `null` — propaga', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({ limites: new ShopeeNetworkError('fetch falhou') });

    await expect(preparar(db, loja)).rejects.toBeInstanceOf(ShopeeNetworkError);
  });

  it('sem principal num kit de 2 itens: nenhuma categoria ⇒ `limites: null` e NENHUMA chamada a get_kit_item_limit', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake();

    const ctx = await preparar(db, loja, { principal: null });

    expect(ctx.limites).toBeNull();
    expect(loja.ops).not.toContain('get_kit_item_limit');
  });

  it('a capa sobe com cap = min(9, o máximo SERVIDO); não servido ⇒ 9', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({
      limites: limitesServidos({ item_image_count_limit: { min_limit: 1, max_limit: 5 } }),
    });

    await preparar(db, loja);

    expect(loja.ops.at(-1)).toBe('upload:5');
  });

  it('(OP-10) o cap do upload é o teto do PLANO (`tetoDeFotosDoKit`): um máximo servido 0 sobe 9, nunca 0', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const banda = { item_image_count_limit: { min_limit: 0, max_limit: 0 } };
    const loja = lojaFake({ limites: limitesServidos(banda) });

    await preparar(db, loja);

    expect(loja.ops.at(-1)).toBe(`upload:${String(CAP_FOTOS_KIT)}`);
    expect(loja.ops.at(-1)).toBe(
      `upload:${String(tetoDeFotosDoKit(shopeeKitItemLimitPayloadSchema.parse(banda)))}`,
    );
  });
});

/* ========================================================================== */
/*  (4) the L6 scan — create arms only                                         */
/* ========================================================================== */

/** A kit's base row (`tag.kit` true, K's SKU). */
function baseDoKit(over: Json = {}): Json {
  return {
    item_id: KIT_ITEM,
    item_status: 'NORMAL',
    has_model: true,
    tag: { kit: true },
    item_sku: SKU,
    create_time: 1791244800,
    ...over,
  };
}

/** A live kit page: Azul = A + B (A the main), Verde = 2 × A. */
function kitVivo(over: Json = {}): Json {
  return {
    item_id: KIT_ITEM,
    item_sku: SKU,
    model_list: [
      {
        model_id: KIT_MODELO,
        tier_index: [0],
        component_list: [
          {
            component_item_id: COMP_A_ITEM,
            component_model_id: COMP_A_MODELO,
            quantity: 1,
            main_component: true,
          },
          { component_item_id: COMP_B_ITEM, component_model_id: COMP_B_OCULTO, quantity: 1 },
        ],
      },
    ],
    tier_variation_list: [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
    ...over,
  };
}

describe('prepararKit — a busca L6 (só nos braços de criação)', () => {
  it('um kit com o SKU de K na loja ⇒ a busca o acha e as fotos NÃO sobem (o plano vai recusar)', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({
      lista: [{ item_id: KIT_2_ITEM, item_status: 'NORMAL', tag: { kit: true } }],
      bases: { [KIT_2_ITEM]: baseDoKit({ item_id: KIT_2_ITEM }) },
    });

    const ctx = await preparar(db, loja);

    expect(ctx.busca?.achados.map((a) => a.itemId)).toEqual([KIT_2_ITEM]);
    expect(ctx.fotos).toBeNull();
    expect(loja.ops.some((o) => o.startsWith('upload'))).toBe(false);
  });

  it('(M167) kit-atualizar NÃO busca: zero get_item_list, `busca` nula, `nossosVivos` vazio — mesmo com um gêmeo na lista', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({
      // The unlinked twin of a double create, LISTED: a scan would see it.
      lista: [{ item_id: KIT_2_ITEM, item_status: 'NORMAL', tag: { kit: true } }],
      bases: { [KIT_ITEM]: baseDoKit(), [KIT_2_ITEM]: baseDoKit({ item_id: KIT_2_ITEM }) },
      kits: { [KIT_ITEM]: kitVivo() },
    });

    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(loja.ops).not.toContain('get_item_list');
    expect(ctx.busca).toBeNull();
    expect(ctx.nossosVivos.size).toBe(0);
  });

  it('⚠️ NEAR-MISS (M167): a MESMA loja como kit-criar ⇒ get_item_list chamado e o gêmeo achado', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake({
      lista: [{ item_id: KIT_2_ITEM, item_status: 'NORMAL', tag: { kit: true } }],
      bases: { [KIT_2_ITEM]: baseDoKit({ item_id: KIT_2_ITEM }) },
    });

    const ctx = await preparar(db, loja);

    expect(loja.ops.filter((o) => o === 'get_item_list')).toHaveLength(1);
    expect(ctx.busca?.achados.map((a) => a.itemId)).toEqual([KIT_2_ITEM]);
  });

  it('(S2C-02) um kit NOSSO que a lista não mostrou é lido em UM lote: ausente ⇒ null; presente ⇒ o status', async () => {
    for (const [base, esperado] of [
      [undefined, null],
      [baseDoKit({ item_status: 'UNLIST' }), 'UNLIST'],
    ] as const) {
      const db = new FakeDb();
      semearTudo(db);
      semearVinculoNativo(db, KIT_ITEM);
      const loja = lojaFake(base === undefined ? {} : { bases: { [KIT_ITEM]: base } });

      const ctx = await preparar(db, loja);

      expect([...ctx.nossosVivos]).toEqual([[KIT_ITEM, esperado]]);
      expect(loja.basePedidas.at(-1)).toEqual([KIT_ITEM]);
      // OURS = 1 (the link is authoritative) ⇒ a resume, nothing sent ⇒ no
      // photo; a deleted one ⇒ a create ⇒ the photos go up.
      expect(ctx.fotos === null).toBe(esperado !== null);
    }
  });
});

/* ========================================================================== */
/*  (5) the target, its live read and its rows                                 */
/* ========================================================================== */

describe('prepararKit — o alvo (kit-atualizar)', () => {
  it('lê o kit VIVO e o principal VOLTA da Shopee (L1); o --principal pedido fica para comparar', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({ bases: { [KIT_ITEM]: baseDoKit() }, kits: { [KIT_ITEM]: kitVivo() } });

    const ctx = await preparar(
      db,
      loja,
      { principal: 'comp-b-membro' },
      { arma: 'kit-atualizar', linkDocId: link },
    );

    expect(ctx.alvo?.linkDocId).toBe(link);
    expect(ctx.vivo).toMatchObject({ status: 'NORMAL', criadoEm: 1791244800 });
    expect(ctx.vivo?.kit?.item_id).toBe(KIT_ITEM);
    expect(ctx.principal).toEqual({ itemId: COMP_A_ITEM, modelId: COMP_A_MODELO });
    expect(ctx.principalPedido).toEqual({ itemId: COMP_B_ITEM, modelId: null });
  });

  it('(S2C-07) um alvo PURGADO (sem linha) é um kit apagado — `{ status: null, kit: null }`, nunca um throw', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake();

    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(ctx.vivo).toEqual({ status: null, kit: null, criadoEm: null });
    expect(ctx.principal).toBeNull();
  });

  it('⛔ NEAR-MISS (S2C-07): qualquer OUTRA falha da leitura viva propaga (regra 6)', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({
      falhaDaBase: (ids) => (ids.includes(KIT_ITEM) ? new ShopeeNetworkError('caiu') : null),
    });

    await expect(
      preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link }),
    ).rejects.toBeInstanceOf(ShopeeNetworkError);
  });

  it('as linhas da CONTA: outra conta fica de fora; as DUAS grafias do link dobram; `linhasDoAnuncio` = só as do alvo', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const outroLink = 'link-antigo';
    db.seed(`produtos/${K_AZUL}/variashopee/canonica`, {
      model_id: KIT_MODELO,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${link}`,
    });
    db.seed(`produtos/${K_VERDE}/variashopee/legada`, {
      model_id: 2000458823,
      // The bare legacy encoding of BOTH refs.
      contaVariacaoShopeeOuterRef: `integracao/${INTEGRACAO}`,
      produtoShopeeOuterRef: `produtos/${K}/prodshopee/${link}`,
    });
    db.seed(`produtos/${K_VERDE}/variashopee/de-outro-anuncio`, {
      model_id: 2000458824,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${outroLink}`,
    });
    db.seed(`produtos/${K_VERDE}/variashopee/de-outra-conta`, {
      model_id: 2000458825,
      contaVariacaoShopeeOuterRef: REF_OUTRA_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${link}`,
    });
    const loja = lojaFake({ bases: { [KIT_ITEM]: baseDoKit() }, kits: { [KIT_ITEM]: kitVivo() } });

    const ctx = await preparar(db, loja, {}, { arma: 'kit-atualizar', linkDocId: link });

    expect(ctx.linhasDaConta.map((l) => [l.produtoId, l.docId, l.linkDocId])).toEqual([
      [K_AZUL, 'canonica', link],
      [K_VERDE, 'legada', link],
      [K_VERDE, 'de-outro-anuncio', outroLink],
    ]);
    expect(ctx.linhasDoAnuncio.map((l) => l.docId)).toEqual(['canonica', 'legada']);
  });

  it('os vínculos de K são os da CONTA: um de outra conta não entra em `vinculos`', async () => {
    const db = new FakeDb();
    semearTudo(db);
    semearVinculoNativo(db, KIT_ITEM, { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });
    const loja = lojaFake();

    const ctx = await preparar(db, loja);

    expect(ctx.vinculos).toEqual([]);
  });
});

/* ========================================================================== */
/*  (6) the principal                                                          */
/* ========================================================================== */

describe('prepararKit — o --principal', () => {
  it('um --principal publicado que NÃO é componente sai resolvido (o plano o recusa principal-invalido nomeando-o)', async () => {
    const db = new FakeDb();
    semearTudo(db);
    db.seed('produtos/avulso', { nome: 'Avulso', sku: 'AV', paiId: null });
    db.seed('produtos/avulso/prodshopee/link-avulso', {
      item_id: 2500139861,
      contaProdutoShopeeOuterRef: REF_CONTA,
      category_id: CATEGORIA,
    });
    const loja = lojaFake({
      bases: {
        2500139861: {
          item_id: 2500139861,
          item_status: 'NORMAL',
          has_model: false,
          tag: { kit: false },
        },
      },
    });

    const ctx = await preparar(db, loja, { principal: 'avulso' });

    expect(ctx.principal).toEqual({ itemId: 2500139861, modelId: null });
    // Resolved in the SAME batch as the components — never a second read.
    expect(loja.basePedidas[0]).toEqual([COMP_A_ITEM, COMP_B_ITEM, 2500139861]);
  });

  it('(OP-8) a NAMED --principal that does not resolve refuses principal-invalido right after the component batch — no limits, no channels, no scan, no upload', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const loja = lojaFake();

    const erro = await recusaDe(preparar(db, loja, { principal: 'fantasma' }));

    expect(erro.problemas).toEqual([
      {
        campo: 'principal',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
        mensagem: 'o componente principal fantasma não faz parte da composição do kit',
      },
    ]);
    expect(loja.ops).toEqual(['get_item_base_info']);
    expect(db.writes).toEqual([]);

    // ⛔ NEAR-MISS: no --principal at all is NOT this refusal — the read goes on
    // (a two-item kit is the PLAN's principal-obrigatorio, never "invalid").
    const semNome = lojaFake();
    const ctx = await preparar(db, semNome, { principal: null });
    expect(ctx.principalSolicitado).toBeNull();
    expect(semNome.ops).toContain('get_item_list');
  });

  it('⛔ NEAR-MISS (OP-8): kit-atualizar never refuses an unresolved --principal — a republish READS its main back (L1); the name only rides along', async () => {
    const db = new FakeDb();
    semearTudo(db);
    const link = semearVinculoNativo(db, KIT_ITEM);
    const loja = lojaFake({ bases: { [KIT_ITEM]: baseDoKit() }, kits: { [KIT_ITEM]: kitVivo() } });

    const ctx = await preparar(
      db,
      loja,
      { principal: 'fantasma' },
      { arma: 'kit-atualizar', linkDocId: link },
    );

    expect(ctx.principalSolicitado).toBe('fantasma');
    expect(ctx.principalPedido).toBeNull();
    expect(ctx.principal).toEqual({ itemId: COMP_A_ITEM, modelId: COMP_A_MODELO });
  });

  it('(OP-8 / OP-9 / R1-RT7-02) the context carries the RAW --principal, the --status, and each child’s STORED recipe beside the parsed one', async () => {
    const db = new FakeDb();
    semearTudo(db);
    // Azul's comp-b is stored WITHOUT quantidade: the parse reads 1, the store does not.
    const armazenado = {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b-membro': { limitarEstoque: true },
    };
    const azul = db.store[`produtos/${K_AZUL}`]?.data ?? {};
    db.seed(`produtos/${K_AZUL}`, { ...azul, componentesKit: armazenado });
    const loja = lojaFake();

    const ctx = await preparar(db, loja, { statusPedido: 'UNLIST' });

    expect(ctx.principalSolicitado).toBe('comp-a-filho');
    expect(ctx.statusPedido).toBe('UNLIST');
    const filhoAzul = ctx.filhos.find((f) => f.produtoId === K_AZUL);
    expect(filhoAzul?.componentesKitArmazenado).toEqual(armazenado);
    expect(filhoAzul?.componentesKit?.['comp-b-membro']).toMatchObject({ quantidade: 1 });
  });
});

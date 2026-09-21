import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  ShopeeApiError,
  shopeeLogisticsChannelSchema,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemWriteResponse,
  type ShopeeModelList,
  type ShopeeTierWriteResponse,
  type ShopeeUnlistItemResponse,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  SHOPEE_MODEL_STATUS,
  varianteFakePath,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { construirIndice } from '../taxonomia/categorias';
import { __setShopeeTaxonomiaClockForTests, type ShopeeTaxonomiaCtx } from '../taxonomia/cache';
import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
} from './errosPublicacao';
import type { ResolvedorDeImagensShopee, ResultadoFotosPublicacao } from './fotosPublicacao';
import { ORDEM_RELISTAGEM, planejarPublicacao, type PlanoPublicacao } from './planoPublicacao';
import {
  aplicarPublicacao,
  prepararPublicacao,
  publicarAnuncioShopee,
  resolverFotosDaPublicacao,
  type EntradaDePublicacao,
  type PublicarAnuncioDeps,
} from './publicarAnuncio';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or buyer.  */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_OUTRA_CONTA = 'documents/integracao/int-2';

const PAI = 'prod-pai';
const FILHO = 'prod-filho-a';
const LINK_PAI = 'link-1';
const CAMINHO_LINK = `produtos/${PAI}/prodshopee/${LINK_PAI}`;

const GRUPO = 'grupo-cor';
const VARIANTE = 'var-azul';
const CAMINHO_VARIANTE = varianteFakePath(GRUPO, VARIANTE);

const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const CATEGORIA = 100_017;
const CANAL = 90_003;
const TABELA_NORMAL = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const OPERACAO = 'documents/operacao/op-1';
const MARCA_ID = 1234;

const AGORA = 1_757_000_000_000;

/** The BR all-or-nothing sentence, verbatim — the ONE code the C13 retry narrows. */
const FRASE_BR = 'all BR tax field should be empty or be filled at same time';

/* --------------------------------- the db --------------------------------- */

function semearCatalogo(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PAI}`, {
    nome: 'Camiseta básica branca',
    sku: 'CAM-BR',
    gtin: '07891234567895',
    paiId: null,
    pesoBrutoKg: 0.32,
    alturaCm: 2.1,
    larguraCm: 21.4,
    profundidadeCm: 29.2,
    precos: { [TABELA_NORMAL]: { valor: 49.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    ...over,
  });
  db.seed(`produtos/${PAI}/extraData/singleton`, {
    descricao: 'Camiseta de algodão penteado, gola redonda, unissex.',
  });
  db.seed(`produtos/${PAI}/estoques/est-pai`, {
    depositoOuterRef: DEPOSITO,
    quantidade: 10,
    quantidadeReservada: 0,
  });
}

function semearFilho(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(`produtos/${FILHO}`, {
    nome: 'Camiseta básica branca P',
    sku: 'CAM-BR-P',
    paiId: PAI,
    ordem: 1,
    variacoesUid: [CAMINHO_VARIANTE],
    precos: { [TABELA_NORMAL]: { valor: 49.9 } },
    fotos: [],
    ...over,
  });
  db.seed(`produtos/${FILHO}/estoques/est-filho`, {
    depositoOuterRef: DEPOSITO,
    quantidade: 7,
    quantidadeReservada: 0,
  });
  semearGrupo(db);
}

/**
 * The grupo, WITH its `(integração, categoria)` binding entry.
 *
 * ⚠️ Without that entry every option is `variacao-sem-vinculo` and no tier can
 * be authored at all — it is the ERP↔Shopee option map, not decoration.
 * `variation_id: 0` is Shopee's CUSTOM tier (outside Fashion every tier is
 * custom and only the NAMES identify options).
 */
function semearGrupo(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(`grupoDeVariacoes/${GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    permiteFotos: false,
    variacoes: [{ id: VARIANTE, nome: 'Azul' }],
    linksVariacoesShopee: [
      {
        name: 'Cor',
        category_id: CATEGORIA,
        variation_id: 0,
        variation_group_list: 0,
        integracaoShopeeId: INTEGRACAO,
        variationOptions: [
          { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: [VARIANTE] },
        ],
      },
    ],
    ...over,
  });
}

function semearLink(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(CAMINHO_LINK, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta básica branca',
    item_id: ITEM_ID,
    category_id: CATEGORIA,
    brand_id: 0,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...extra,
  });
}

function patchesDoLink(db: FakeDb): Record<string, unknown>[] {
  return db.writes
    .filter((w) => w.path.startsWith(`produtos/${PAI}/prodshopee/`))
    .map((w) => w.patch);
}

/* ------------------------------ the wire doubles --------------------------- */

function ecoDeItem(
  over: Record<string, unknown> = {},
  warning: string | null = null,
): ShopeeItemWriteResponse {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning,
    response: { item_id: ITEM_ID, item_status: SHOPEE_ITEM_STATUS_WRITABLE.unlist, ...over },
  } as unknown as ShopeeItemWriteResponse;
}

function modelList(modelos: readonly Record<string, unknown>[] = [modelo()]): ShopeeModelList {
  return {
    tier_variation: null,
    standardise_tier_variation: null,
    model: modelos,
  } as unknown as ShopeeModelList;
}

function modelo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    model_sku: 'CAM-BR-P',
    ...over,
  };
}

function ecoDeTier(): ShopeeTierWriteResponse {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning: null,
    response: { model: [{ model_id: MODEL_A, tier_index: [0] }] },
  } as unknown as ShopeeTierWriteResponse;
}

function ackDeUnlist(
  sucesso: boolean,
  failedReason: string | null = null,
): ShopeeUnlistItemResponse {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning: null,
    response: {
      success_list: sucesso ? [{ item_id: ITEM_ID, unlist: false }] : [],
      failure_list: sucesso ? [] : [{ item_id: ITEM_ID, failed_reason: failedReason }],
    },
  } as unknown as ShopeeUnlistItemResponse;
}

function linhaDeLeitura(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: ITEM_ID,
    item_name: 'Camiseta básica branca',
    item_status: SHOPEE_ITEM_STATUS.normal,
    condition: 'NEW',
    deboost: false,
    has_model: true,
    scheduled_publish_time: null,
    category_id: CATEGORIA,
    brand: { brand_id: 0, original_brand_name: 'No Brand' },
    logistic_info: [{ logistic_id: CANAL, enabled: true }],
    ...over,
  };
}

function baseInfo(linhas: readonly (Record<string, unknown> | null)[]): ShopeeItemBaseInfo {
  return { item_list: linhas } as unknown as ShopeeItemBaseInfo;
}

const BANDAS_DA_LOJA = {
  response: {
    price_limit: { min_limit: 1, max_limit: 1000, min: null, max: null },
    stock_limit: { min_limit: 2, max_limit: 1_000_000, min: null, max: null },
    item_name_length_limit: { min_limit: 10, max_limit: 120, min: null, max: null },
    item_image_count_limit: { min_limit: 1, max_limit: 9, min: null, max: null },
    item_description_length_limit: { min_limit: 20, max_limit: 3000, min: null, max: null },
    dts_limit: {
      days_to_ship_limit: { min_limit: 1, max_limit: 30, min: null, max: null },
      non_pre_order_days_to_ship: 3,
    },
  },
  gtin_limit: { gtin_validation_rule: 'Optional' },
};

const CANAL_DA_LOJA = shopeeLogisticsChannelSchema.parse({
  logistics_channel_id: CANAL,
  enabled: true,
  fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
});

interface OpcoesCliente {
  readonly addItem?: (body: Record<string, unknown>) => ShopeeItemWriteResponse;
  readonly updateItem?: (body: Record<string, unknown>) => ShopeeItemWriteResponse;
  readonly initTierVariation?: (body: Record<string, unknown>) => ShopeeTierWriteResponse;
  readonly updateTierVariation?: (body: Record<string, unknown>) => unknown;
  readonly addModel?: (body: Record<string, unknown>) => ShopeeTierWriteResponse;
  readonly updateModel?: (body: Record<string, unknown>) => unknown;
  readonly getModelList?: (p: { itemId: number }) => ShopeeModelList;
  readonly unlistItem?: (body: Record<string, unknown>) => ShopeeUnlistItemResponse;
  readonly getItemBaseInfo?: (p: { itemIds: readonly number[] }) => ShopeeItemBaseInfo;
  readonly getBrandList?: (p: { offset: number }) => unknown;
}

interface ClienteFake {
  readonly client: ShopeeClient;
  /** Every wire operation AND the wait, in call order. */
  readonly ops: string[];
  readonly corpos: Record<string, unknown>[];
}

/**
 * A `ShopeeClient` answering only what a publish may call. An operation the case
 * did not arrange THROWS, so "never calls X" needs no spy.
 */
function clienteFake(op: OpcoesCliente = {}): ClienteFake {
  const ops: string[] = [];
  const corpos: Record<string, unknown>[] = [];
  const naoArranjado = (nome: string): never => {
    throw new Error(`fixture: ${nome} inesperado`);
  };
  const client = {
    getItemLimit: () => {
      ops.push('get_item_limit');
      return Promise.resolve(BANDAS_DA_LOJA);
    },
    getAttributeTree: () => {
      ops.push('get_attribute_tree');
      return Promise.resolve({ list: [] });
    },
    getChannelList: () => {
      ops.push('get_channel_list');
      return Promise.resolve({ logistics_channel_list: [CANAL_DA_LOJA] });
    },
    getBrandList: (p: { offset: number }) => {
      ops.push('get_brand_list');
      if (op.getBrandList === undefined) return naoArranjado('getBrandList');
      return Promise.resolve(op.getBrandList(p));
    },
    addItem: (body: Record<string, unknown>) => {
      ops.push('add_item');
      corpos.push(body);
      if (op.addItem === undefined) return naoArranjado('addItem');
      return Promise.resolve(op.addItem(body));
    },
    updateItem: (body: Record<string, unknown>) => {
      ops.push('update_item');
      corpos.push(body);
      if (op.updateItem === undefined) return naoArranjado('updateItem');
      return Promise.resolve(op.updateItem(body));
    },
    initTierVariation: (body: Record<string, unknown>) => {
      ops.push('init_tier_variation');
      corpos.push(body);
      return Promise.resolve((op.initTierVariation ?? (() => ecoDeTier()))(body));
    },
    updateTierVariation: (body: Record<string, unknown>) => {
      ops.push('update_tier_variation');
      corpos.push(body);
      return Promise.resolve(
        (
          op.updateTierVariation ??
          (() => ({ request_id: 'r', error: '', message: null, warning: null, response: {} }))
        )(body),
      );
    },
    addModel: (body: Record<string, unknown>) => {
      ops.push('add_model');
      corpos.push(body);
      return Promise.resolve((op.addModel ?? (() => ecoDeTier()))(body));
    },
    updateModel: (body: Record<string, unknown>) => {
      ops.push('update_model');
      corpos.push(body);
      return Promise.resolve(
        (
          op.updateModel ??
          (() => ({ request_id: 'r', error: '', message: null, warning: null, response: {} }))
        )(body),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      return Promise.resolve((op.getModelList ?? (() => modelList()))(p));
    },
    unlistItem: (body: Record<string, unknown>) => {
      ops.push('unlist_item');
      corpos.push(body);
      return Promise.resolve((op.unlistItem ?? (() => ackDeUnlist(true)))(body));
    },
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      return Promise.resolve((op.getItemBaseInfo ?? (() => baseInfo([linhaDeLeitura()])))(p));
    },
  } as unknown as ShopeeClient;
  return { client, ops, corpos };
}

/* ----------------------------- the photo double --------------------------- */

interface ResolvedorFake {
  readonly resolvedor: ResolvedorDeImagensShopee;
  readonly passes: { readonly cap: number | null; readonly fotos: number }[];
}

function resolvedorFake(imageIds: readonly string[] = ['img-1', 'img-2']): ResolvedorFake {
  const passes: { cap: number | null; fotos: number }[] = [];
  let opcoes = 0;
  const resolvedor: ResolvedorDeImagensShopee = {
    resolver: (fotos, op) => {
      const cap = op?.cap ?? null;
      passes.push({ cap, fotos: fotos.length });
      const ids = cap === 1 ? [`img-opcao-${String((opcoes += 1))}`] : imageIds;
      const resultado: ResultadoFotosPublicacao = {
        imageIds: ids,
        reutilizadas: 0,
        enviadas: ids.length,
        falhas: [],
        consideradas: fotos.length,
        descartadasPeloLimite: 0,
      };
      return Promise.resolve(resultado);
    },
    resumo: () => ({
      consideradas: 1,
      reutilizadas: 0,
      enviadas: imageIds.length,
      falhas: 0,
      descartadasPeloLimite: 0,
    }),
  };
  return { resolvedor, passes };
}

/** A resolver that must never be called — the write-free proof of `preparar`. */
function resolvedorQueRecusa(): ResolvedorDeImagensShopee {
  return {
    resolver: () => {
      throw new Error('fixture: preparar NÃO deve resolver foto nenhuma');
    },
    resumo: () => {
      throw new Error('fixture: preparar NÃO deve resumir foto nenhuma');
    },
  };
}

/* ---------------------------------- deps ---------------------------------- */

function taxonomia(client: ShopeeClient): ShopeeTaxonomiaCtx {
  return { integracaoId: INTEGRACAO, client, variationsPath: SHOPEE_GET_VARIATIONS_PATH };
}

const INDICE = construirIndice([
  { category_id: CATEGORIA, parent_category_id: 0, has_children: false } as never,
]);

function deps(
  db: FakeDb,
  fake: ClienteFake,
  over: Partial<PublicarAnuncioDeps> = {},
): PublicarAnuncioDeps {
  return {
    db: asDb(db),
    client: fake.client,
    partnerClient: () => {
      throw new Error('fixture: o partner client só é usado pelo resolvedor de imagens');
    },
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: `documents/listaDePrecos/${TABELA_NORMAL}`,
    depositoOuterRef: DEPOSITO,
    operacaoOuterRef: null,
    nowMs: AGORA,
    esperar: (ms: number) => {
      fake.ops.push(`esperar:${String(ms)}`);
      return Promise.resolve();
    },
    taxonomia: taxonomia(fake.client),
    categorias: { carregar: () => Promise.resolve(INDICE) },
    ...over,
  };
}

function entrada(over: Partial<EntradaDePublicacao> = {}): EntradaDePublicacao {
  return {
    produtoId: PAI,
    // C36: the operator's choice, used ONLY when the stored link has none.
    categoryId: CATEGORIA,
    statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    ...over,
  };
}

/** preparar → fotos → planejar, the sequence `publicarAnuncioShopee` runs. */
async function planejar(
  db: FakeDb,
  fake: ClienteFake,
  over: Partial<PublicarAnuncioDeps> = {},
  ent: Partial<EntradaDePublicacao> = {},
  fotos = resolvedorFake(),
): Promise<{
  plano: PlanoPublicacao;
  contexto: NonNullable<Awaited<ReturnType<typeof prepararPublicacao>>>;
}> {
  const d = deps(db, fake, over);
  const contexto = await prepararPublicacao(d, entrada(ent), fotos.resolvedor);
  if (contexto === null) throw new Error('fixture: o contexto não deveria ser nulo');
  const resolvidas = await resolverFotosDaPublicacao(contexto);
  return { plano: planejarPublicacao(contexto, resolvidas), contexto };
}

function erroApi(
  code: string,
  message = `Shopee respondeu ${code} (HTTP 200)`,
  path = '/api/v2/product/add_item',
): ShopeeApiError {
  return new ShopeeApiError(message, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path,
  });
}

/* ------------------------------- console spies ---------------------------- */

const infos: unknown[][] = [];
const avisos: unknown[][] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  infos.length = 0;
  avisos.length = 0;
});

function logInteiro(): string {
  return [...infos, ...avisos]
    .map((args) => args.map((a) => JSON.stringify(a)).join(' '))
    .join('|');
}

/* ========================================================================== */
/*  (1) preparar — reads only                                                 */
/* ========================================================================== */

describe('prepararPublicacao — a leitura', () => {
  it('não escreve NADA, não lê get_model_list e não resolve foto nenhuma', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    semearLink(db);
    const fake = clienteFake();

    const contexto = await prepararPublicacao(
      deps(db, fake),
      entrada(),
      // ⚠️ Um resolvedor que LANÇA: se `preparar` chamasse uma foto, o teste
      // morreria aqui em vez de passar em silêncio.
      resolvedorQueRecusa(),
    );

    expect(contexto).not.toBeNull();
    expect(db.writes).toEqual([]);
    // ⚠️ A árvore viva é lida FRESCA dentro de `aplicarModelos`. Uma leitura
    // aqui seria a lista velha que `update_tier_variation` depois APAGA.
    expect(fake.ops).not.toContain('get_model_list');
    expect(fake.ops).toEqual(['get_item_limit', 'get_attribute_tree', 'get_channel_list']);
  });

  it('projeta o produto, os filhos, os grupos e o estoque disponível', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake();

    const contexto = await prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa());

    expect(contexto?.produto.nome).toBe('Camiseta básica branca');
    expect(contexto?.ownDisponivel).toBe(10);
    expect(contexto?.filhos).toEqual([
      expect.objectContaining({ produtoId: FILHO, estoque: 7, preco: 49.9, ordem: 1 }),
    ]);
    expect(contexto?.grupos).toEqual([
      expect.objectContaining({ grupoId: GRUPO, permiteFotos: false }),
    ]);
    // ⚠️ A `ordem` da variante é o ÍNDICE dentro de `grupo.variacoes` — a regra
    // de wire do legado, não um campo armazenado.
    expect(contexto?.grupos[0]?.variacoes).toEqual([
      { varianteId: VARIANTE, nome: 'Azul', ordem: 0 },
    ]);
    // O id da tabela é o SEGMENTO FINAL do outerRef; um ref inteiro não resolve preço nenhum.
    expect(contexto?.tabelaNormalId).toBe(TABELA_NORMAL);
  });

  it('um produto ausente e um linkDocId de outra conta respondem null (404)', async () => {
    const db = new FakeDb();
    const fake = clienteFake();
    expect(await prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa())).toBeNull();

    semearCatalogo(db);
    db.seed(CAMINHO_LINK, { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA, item_id: ITEM_ID });
    expect(
      await prepararPublicacao(
        deps(db, fake),
        entrada({ linkDocId: LINK_PAI }),
        resolvedorQueRecusa(),
      ),
    ).toBeNull();
  });

  it('sem linkDocId, um vínculo de outra conta é um PRIMEIRO publish — não um 404', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    db.seed(CAMINHO_LINK, { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA, item_id: ITEM_ID });
    const fake = clienteFake();

    const contexto = await prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa());
    expect(contexto?.link).toBeNull();
    expect(contexto?.ehAtualizacao).toBe(false);
  });
});

describe('prepararPublicacao — as duas recusas de produto', () => {
  it('um produto FILHO é recusado antes de qualquer leitura de foto ou de canal', async () => {
    const db = new FakeDb();
    semearCatalogo(db, { paiId: 'prod-outro-pai' });
    const fake = clienteFake();

    await expect(
      prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa()),
    ).rejects.toMatchObject({
      name: 'ShopeePublishBlockedError',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
    });
    expect(fake.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('⚠️ PAR: um produto ehKit com vínculo ORDINÁRIO publica, com o estoque dos componentes', async () => {
    // O apagão do catálogo legado que o passo 11 tinha: o ERP tem MILHARES de
    // produtos `ehKit` que o app legado publicava como anúncios comuns, e
    // recusá-los por esse flag os tornava permanentemente impublicáveis.
    const db = new FakeDb();
    semearCatalogo(db, { ehKit: true, componentesKit: { 'comp-1': { quantidade: 2 } } });
    semearLink(db, { kitNativo: false });
    db.seed('produtos/comp-1/estoques/e1', {
      depositoOuterRef: DEPOSITO,
      quantidade: 9,
      quantidadeReservada: 0,
    });

    const contexto = await prepararPublicacao(
      deps(db, clienteFake()),
      entrada(),
      resolvedorQueRecusa(),
    );
    expect(contexto?.disponivelByProdutoId).toEqual({ 'comp-1': 9 });
  });

  it('um vínculo legado, sem o campo kitNativo, publica igual — é o corpo importado antes do passo 12', async () => {
    const db = new FakeDb();
    semearCatalogo(db, { ehKit: true, componentesKit: { 'comp-1': { quantidade: 2 } } });
    semearLink(db);
    db.seed('produtos/comp-1/estoques/e1', {
      depositoOuterRef: DEPOSITO,
      quantidade: 9,
      quantidadeReservada: 0,
    });

    const contexto = await prepararPublicacao(
      deps(db, clienteFake()),
      entrada(),
      resolvedorQueRecusa(),
    );
    expect(contexto?.disponivelByProdutoId).toEqual({ 'comp-1': 9 });
  });

  it('o vínculo com kitNativo true é recusado com produto-e-kit, e o campo é kitNativo', async () => {
    const db = new FakeDb();
    semearCatalogo(db, { ehKit: true, componentesKit: { 'comp-1': { quantidade: 1 } } });
    semearLink(db, { kitNativo: true });
    const fake = clienteFake();

    await expect(
      prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa()),
    ).rejects.toMatchObject({
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
      problemas: [{ campo: 'kitNativo' }],
    });
    expect(fake.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('⚠️ NEAR-MISS: na PRIMEIRA publicação, um ehKitVirtual é recusado, e o campo é ehKitVirtual', async () => {
    // Sem vínculo não há o que a Shopee tenha reportado, e `ehKitVirtual` é a
    // afirmação do próprio ERP de que o MARKETPLACE resolve a composição — o
    // que na Shopee é `add_kit_item`, o passo 19.
    const db = new FakeDb();
    semearCatalogo(db, {
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { 'comp-1': { quantidade: 1 } },
    });
    const fake = clienteFake();

    await expect(
      prepararPublicacao(deps(db, fake), entrada(), resolvedorQueRecusa()),
    ).rejects.toMatchObject({
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
      problemas: [{ campo: 'ehKitVirtual' }],
    });
    expect(fake.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('e com vínculo ordinário o MESMO ehKitVirtual publica — o vínculo é a autoridade', async () => {
    const db = new FakeDb();
    semearCatalogo(db, {
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { 'comp-1': { quantidade: 2 } },
    });
    semearLink(db, { kitNativo: false });
    db.seed('produtos/comp-1/estoques/e1', {
      depositoOuterRef: DEPOSITO,
      quantidade: 9,
      quantidadeReservada: 0,
    });

    const contexto = await prepararPublicacao(
      deps(db, clienteFake()),
      entrada(),
      resolvedorQueRecusa(),
    );
    expect(contexto?.disponivelByProdutoId).toEqual({ 'comp-1': 9 });
  });
});

/* ========================================================================== */
/*  (2) the ORDER                                                             */
/* ========================================================================== */

describe('aplicarPublicacao — a ORDEM dos onze passos', () => {
  it('um create COM filhos: fotos → add_item → vínculo → esperar → tiers → links → relistagem → leitura', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake({ addItem: () => ecoDeItem() });
    const fotos = resolvedorFake();

    const { plano } = await planejar(db, fake, {}, {}, fotos);
    expect(plano.problemas).toEqual([]);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    // ⚠️ `esperar(5000)` está ENTRE add_item e init_tier_variation, não depois:
    // a Shopee ainda não terminou de indexar o item recém-criado.
    expect(fake.ops).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'add_item',
      `esperar:${String(5000)}`,
      'init_tier_variation',
      'get_model_list',
      'unlist_item',
      'get_item_base_info',
      'get_model_list',
    ]);

    // ⚠️ A ORDEM das escritas: o vínculo do PAI é a PRIMEIRA, no instante em que
    // a Shopee confirma — é isso que torna uma publicação meio-falha retomável.
    expect(db.writes.map((w) => w.path)).toEqual([
      `produtos/${PAI}/prodshopee/auto-1`,
      `produtos/${FILHO}/variashopee/auto-2`,
      `produtos/${PAI}/prodshopee/auto-1`,
    ]);
    expect(db.writes[0]?.patch).toMatchObject({
      item_id: ITEM_ID,
      ultimaPublicacao: { em: AGORA, etapa: 'add_item', itemId: ITEM_ID },
    });
    expect(db.writes[2]?.patch).toMatchObject({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });

    expect(r.itemId).toBe(ITEM_ID);
    expect(r.linkDocId).toBe('auto-1');
    expect(r.relistagem).toBe('unlist');
    expect(r.modelos.acao).toBe('init');
    expect(r.modelos.criados).toBe(1);
    // A passagem de ITEM vem sem cap; a de opção viria com cap 1 (aqui o grupo
    // não permite fotos, então há exatamente UMA passagem).
    expect(fotos.passes).toEqual([{ cap: null, fotos: 1 }]);
  });

  it('um create SEM filhos não espera, não abre o leg de modelos e não re-lista', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({ addItem: () => ecoDeItem() });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(fake.ops).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'add_item',
      'get_item_base_info',
      'get_model_list',
    ]);
    expect(r.relistagem).toBeNull();
    expect(r.modelos.acao).toBe('nenhuma');
    // `add_item` de um item sem filhos leva o status PEDIDO direto.
    expect(plano.statusInicial).toBe(SHOPEE_ITEM_STATUS_WRITABLE.normal);
  });

  it('um update lê o get_model_list FRESCO, não espera e não re-lista', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    semearLink(db);
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/${CAMINHO_LINK}`,
      model_id: MODEL_A,
      tier_index: [0],
      model_status: SHOPEE_MODEL_STATUS.normal,
    });
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      // O sku vivo DIVERGE do nosso, então o leg tem trabalho: é o que faz a
      // reconciliação responder `update` em vez de `nenhuma`.
      getModelList: () => modelList([modelo({ model_sku: 'CAM-BR-P-ANTIGO' })]),
    });

    const { plano } = await planejar(db, fake);
    expect(plano.ehAtualizacao).toBe(true);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(fake.ops).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'update_item',
      // ⚠️ A árvore viva, lida AQUI e não no preparar: `update_tier_variation`
      // é um replace de lista INTEIRA, e uma lista velha apaga mapeamento.
      'get_model_list',
      'update_tier_variation',
      'update_model',
      'get_model_list',
      'get_item_base_info',
      'get_model_list',
    ]);
    expect(fake.ops).not.toContain('unlist_item');
    expect(fake.ops.some((o) => o.startsWith('esperar'))).toBe(false);
    expect(r.modelos.acao).toBe('update');

    // ⚠️ `chamadasShopee` conta o APLICAR chamada a chamada, e a leitura de volta
    // de um anúncio COM modelos são DUAS (`get_item_base_info` + `get_model_list`).
    // Um `1` fixo ali fazia o número desta publicação não poder ser comparado com o
    // do `reverificarAnuncio.ts`, que conta honesto.
    const chamadasDoAplicar = fake.ops.slice(fake.ops.indexOf('update_item'));
    expect(r.chamadasShopee).toBe(chamadasDoAplicar.length);
    expect(r.chamadasShopee).toBe(7);
  });

  it('⚠️ um bloqueio vindo da ÁRVORE FRESCA carimba a falha COM os problemas', async () => {
    // A árvore viva volta com a opção do índice 0 ilegível (nome vazio, id 0), que
    // é uma posição que não pode ser reescrita — `montarTiers` recusa DEPOIS que o
    // `update_item` já entrou. `ShopeePublishBlockedError` não é um
    // `ShopeeApiError`, e o classificador respondia `[]` para ele: o carimbo
    // dizia "1 problema" e guardava lista vazia, perdendo o ÚNICO texto que
    // nomeia QUAL posição de QUAL tier falhou.
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    semearLink(db);
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/${CAMINHO_LINK}`,
      model_id: MODEL_A,
      tier_index: [0],
      model_status: SHOPEE_MODEL_STATUS.normal,
    });
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      getModelList: () =>
        ({
          tier_variation: [{ name: 'Cor', option_list: [{ option: '' }, { option: 'Azul' }] }],
          standardise_tier_variation: null,
          model: [modelo()],
        }) as unknown as ShopeeModelList,
    });

    const { plano } = await planejar(db, fake);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toMatchObject({
      name: 'ShopeePublishBlockedError',
    });

    const carimbo = patchesDoLink(db).at(-1)?.falhaPublicacao as Record<string, unknown>;
    expect(carimbo).toMatchObject({ em: AGORA, erro: 'ShopeePublishBlockedError' });
    expect(carimbo.problemas).toHaveLength(1);
    expect((carimbo.problemas as { campo: string }[])[0]?.campo).not.toBe('');
  });

  it('um update sem nada a mudar no leg de modelos NÃO manda nada', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    semearLink(db);
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/${CAMINHO_LINK}`,
      model_id: MODEL_A,
      tier_index: [0],
      model_status: SHOPEE_MODEL_STATUS.normal,
    });
    const fake = clienteFake({ updateItem: () => ecoDeItem() });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.modelos.acao).toBe('nenhuma');
    expect(fake.ops).not.toContain('update_tier_variation');
    expect(fake.ops).not.toContain('add_model');
    // O leg fechou sem uma segunda leitura: nada foi enviado, então a leitura
    // que ele já tem é a corrente.
    expect(fake.ops.filter((o) => o === 'get_model_list')).toHaveLength(2);
  });
});

/* ========================================================================== */
/*  (3) sem-fotos                                                             */
/* ========================================================================== */

describe('aplicarPublicacao — sem fotos utilizáveis', () => {
  it('recusa com sem-fotos ANTES de add_item, e zero fotos não é um erro do resolvedor', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake();

    const { plano } = await planejar(db, fake, {}, {}, resolvedorFake([]));
    expect(plano.problemas.map((p) => p.motivo)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semFotos);

    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
      ShopeePublishBlockedError,
    );
    expect(fake.ops).not.toContain('add_item');
    expect(db.writes).toEqual([]);
  });
});

/* ========================================================================== */
/*  (4) the C13 one-shot fiscal retry                                         */
/* ========================================================================== */

describe('aplicarPublicacao — a retentativa fiscal C13', () => {
  const OPERACAO_DEPS = { operacaoOuterRef: OPERACAO };
  /** Two NCMs that must never be confused: the family's, and a child's. */
  const NCM_DO_PAI = '61091000';
  const NCM_DO_FILHO = '62034200';
  /** `idRefSchema` refuses the `documents/` prefix on a STORED ref. */
  const REF_OPERACAO_CURTA = 'operacao/op-1';

  function semearImposto(db: FakeDb): void {
    // A operação existe mas o bundle não resolve imposto nenhum: o corpo sai
    // SEM `tax_info`, o que é exatamente o caso em que a retentativa NÃO deve
    // acontecer — os casos abaixo injetam a chave pelo plano.
    db.seed('operacao/op-1', { nome: 'Operação padrão' });
  }

  function planoComTaxInfo(plano: PlanoPublicacao): PlanoPublicacao {
    return {
      ...plano,
      item: {
        ...plano.item,
        criar: { ...plano.item.criar, tax_info: { ncm: '61091000', cest: '2804200' } },
      },
    };
  }

  it('⚠️ o bloco fiscal é resolvido para o produto PAI, nunca para um filho', async () => {
    // `tax_info` é item-level: não existe bloco fiscal por modelo em lugar nenhum
    // do fio. Passar `filhos[0]?.produtoId ?? entrada.produtoId` resolveria a
    // cascata do FILHO — e como o fixture padrão não tem operação nenhuma, nada
    // do que existe hoje notaria. Os dois documentos abaixo DISCORDAM de
    // propósito.
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    semearImposto(db);
    db.seed(`produtos/${PAI}/imposto/imp-pai`, {
      impostoOpercaoOuterRef: REF_OPERACAO_CURTA,
      origem: '0',
      NCM: NCM_DO_PAI,
    });
    db.seed(`produtos/${FILHO}/imposto/imp-filho`, {
      impostoOpercaoOuterRef: REF_OPERACAO_CURTA,
      origem: '0',
      NCM: NCM_DO_FILHO,
    });
    const fake = clienteFake();

    const { plano, contexto } = await planejar(db, fake, OPERACAO_DEPS);

    expect(contexto.imposto.imposto?.NCM).toBe(NCM_DO_PAI);
    expect(db.caminhos).toContain(`produtos/${PAI}/imposto`);
    expect(db.caminhos).not.toContain(`produtos/${FILHO}/imposto`);
    expect(JSON.stringify(plano.item.criar.tax_info ?? {})).not.toContain(NCM_DO_FILHO);
  });

  it('reenvia UMA vez, sem a chave tax_info, e carimba recusado-incompleto', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearImposto(db);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        if (chamadas === 1) throw erroApi('product.error_param', `Shopee: ${FRASE_BR}`);
        return ecoDeItem();
      },
    });

    const { plano } = await planejar(db, fake, OPERACAO_DEPS);
    const r = await aplicarPublicacao(deps(db, fake, OPERACAO_DEPS), planoComTaxInfo(plano));

    expect(chamadas).toBe(2);
    expect(fake.corpos[0]).toHaveProperty('tax_info');
    // ⚠️ A chave INTEIRA vai fora — nunca um bloco remendado. O bloco BR é
    // tudo-ou-nada, então um parcial é uma segunda recusa.
    expect('tax_info' in (fake.corpos[1] ?? {})).toBe(false);
    expect(r.taxInfoOmitido).toBe('recusado-incompleto');
    expect(patchesDoLink(db)[0]).toMatchObject({ taxInfoOmitido: 'recusado-incompleto' });
    expect(logInteiro()).toContain('tax_info recusado');
  });

  it('o reenvio acontece UMA vez — nunca duas', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearImposto(db);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        // A MESMA recusa nas duas: o limite é a AUSÊNCIA da chave, não um contador.
        throw erroApi('product.error_param', `Shopee: ${FRASE_BR}`);
      },
    });

    const { plano } = await planejar(db, fake, OPERACAO_DEPS);
    await expect(
      aplicarPublicacao(deps(db, fake, OPERACAO_DEPS), planoComTaxInfo(plano)),
    ).rejects.toBeInstanceOf(ShopeePublishRejectedError);
    expect(chamadas).toBe(2);
  });

  it('⛔ NEAR-MISS: um error_param que NÃO é a frase do bloco BR não reenvia', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearImposto(db);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        throw erroApi('product.error_param', 'Shopee: item_name is too long');
      },
    });

    const { plano } = await planejar(db, fake, OPERACAO_DEPS);
    await expect(
      aplicarPublicacao(deps(db, fake, OPERACAO_DEPS), planoComTaxInfo(plano)),
    ).rejects.toBeInstanceOf(ShopeePublishRejectedError);
    expect(chamadas).toBe(1);
  });

  it('⛔ NEAR-MISS: a frase do bloco BR em um corpo SEM tax_info não reenvia', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        throw erroApi('error_param', `Shopee: ${FRASE_BR}`);
      },
    });

    const { plano } = await planejar(db, fake);
    // O plano NÃO carrega `tax_info` (nenhuma operação configurada).
    expect('tax_info' in plano.item.criar).toBe(false);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
      ShopeePublishRejectedError,
    );
    expect(chamadas).toBe(1);
  });
});

/* ========================================================================== */
/*  (5) O5 — the read-back is the only state source                            */
/* ========================================================================== */

describe('aplicarPublicacao — o item_status vem da LEITURA DE VOLTA', () => {
  it('o eco diz UNLIST e a releitura diz NORMAL: o vínculo grava NORMAL', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({
      // O caso EXATO que a sonda mediu: o eco da escrita traz um status velho.
      addItem: () => ecoDeItem({ item_status: SHOPEE_ITEM_STATUS_WRITABLE.unlist }),
      getItemBaseInfo: () =>
        baseInfo([linhaDeLeitura({ item_status: SHOPEE_ITEM_STATUS.normal, has_model: false })]),
    });

    const { plano } = await planejar(
      db,
      fake,
      {},
      { statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.unlist },
    );
    const r = await aplicarPublicacao(deps(db, fake), plano);

    const patches = patchesDoLink(db);
    expect(patches[1]).toMatchObject({
      item_status: SHOPEE_ITEM_STATUS.normal,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      deboost: false,
      original_brand_name: 'No Brand',
      falhaPublicacao: null,
    });
    expect(r.itemStatus).toBe(SHOPEE_ITEM_STATUS.normal);
    // Nem o status PEDIDO (UNLIST) nem o eco (UNLIST) decidiram nada.
    expect(plano.statusPedido).toBe(SHOPEE_ITEM_STATUS_WRITABLE.unlist);
  });

  it('a leitura de volta que não acha o item NÃO transforma o publish em 422', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      getItemBaseInfo: () => {
        throw erroApi(
          'error_item_not_found',
          'Shopee respondeu error_item_not_found',
          '/api/v2/product/get_item_base_info',
        );
      },
    });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.leituraDeVolta).toBe(false);
    expect(r.estadoAnuncio).toBeNull();
    // O write-back #1 aconteceu; o #2 foi PULADO — nada foi inventado.
    expect(patchesDoLink(db)).toHaveLength(1);
    expect(logInteiro()).toContain('leitura de volta não encontrou');
  });

  it('um deboost lido continua ATIVO e viaja para o vínculo', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      getItemBaseInfo: () => baseInfo([linhaDeLeitura({ deboost: true, has_model: false })]),
    });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.deboost).toBe(true);
    expect(r.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.ativo);
  });
});

/* ========================================================================== */
/*  (6) the update body                                                        */
/* ========================================================================== */

describe('aplicarPublicacao — o corpo do update', () => {
  it('update_item nunca carrega item_status, original_price nem seller_stock', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db);
    const fake = clienteFake({ updateItem: () => ecoDeItem() });

    const { plano } = await planejar(db, fake);
    await aplicarPublicacao(deps(db, fake), plano);

    const corpo = fake.corpos[0] ?? {};
    expect('item_status' in corpo).toBe(false);
    expect('original_price' in corpo).toBe(false);
    expect('seller_stock' in corpo).toBe(false);
    expect(corpo).toMatchObject({ item_id: ITEM_ID });
  });
});

/* ========================================================================== */
/*  (7) the envelope warning                                                   */
/* ========================================================================== */

describe('aplicarPublicacao — o warning do envelope', () => {
  it('vira avisoShopee, e o log nomeia a ETAPA sem a prosa da Shopee', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const PROSA = 'PROSA-AVISO: o prazo de envio deste anúncio muda em 2026-10-01';
    const fake = clienteFake({ addItem: () => ecoDeItem({}, PROSA) });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.avisoShopee).toBe(PROSA);
    expect(logInteiro()).toContain('respondeu um warning');
    expect(logInteiro()).toContain('add_item');
    // ⚠️ A prosa do provedor chega ao operador pelo RESULTADO, nunca pelo log.
    expect(logInteiro()).not.toContain('PROSA-AVISO');
  });

  it("⛔ NEAR-MISS: 'success' e a string vazia NÃO são avisos", async () => {
    for (const ruido of ['success', '']) {
      const db = new FakeDb();
      semearCatalogo(db);
      const fake = clienteFake({ addItem: () => ecoDeItem({}, ruido) });
      const { plano } = await planejar(db, fake);
      const r = await aplicarPublicacao(deps(db, fake), plano);
      expect(r.avisoShopee).toBeNull();
    }
  });
});

/* ========================================================================== */
/*  (8) the brand cascade (C17)                                                */
/* ========================================================================== */

describe('prepararPublicacao — a cascata de marca', () => {
  it('brand_id 0 sai como No Brand SEM leitura nenhuma', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db, { brand_id: 0 });
    const fake = clienteFake({ updateItem: () => ecoDeItem() });

    const { plano, contexto } = await planejar(db, fake);
    expect(contexto.marca).toEqual({ brandId: 0, nome: null });
    // ⚠️ Nenhum get_brand_list e — acima de tudo — nenhuma leitura de
    // `brandshopee`, que é uma lista curada sem leitor e sem schema tipado.
    expect(fake.ops).not.toContain('get_brand_list');
    expect(db.caminhos.some((c) => c.includes('brandshopee'))).toBe(false);
    // O nome de wire é do mapeador, e é o único lugar em que a literal existe.
    expect(plano.item.atualizar?.brand).toEqual({ brand_id: 0, original_brand_name: 'No Brand' });
  });

  it('o original_brand_name ARMAZENADO vence, e custa zero chamadas', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db, { brand_id: MARCA_ID, original_brand_name: 'Delfrance' });
    const fake = clienteFake({ updateItem: () => ecoDeItem() });

    const { contexto } = await planejar(db, fake);
    expect(contexto.marca).toEqual({ brandId: MARCA_ID, nome: 'Delfrance' });
    expect(fake.ops).not.toContain('get_brand_list');
  });

  it('sem nome armazenado, pagina get_brand_list com o next_offset da Shopee', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db, { brand_id: MARCA_ID });
    const offsets: number[] = [];
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      getBrandList: (p) => {
        offsets.push(p.offset);
        return p.offset === 0
          ? // ⚠️ `next_offset` NÃO é `offset + page_size` — é o cursor da Shopee.
            { brand_list: [], has_next_page: true, next_offset: 37 }
          : {
              brand_list: [{ brand_id: MARCA_ID, original_brand_name: 'Delfrance' }],
              has_next_page: false,
              next_offset: null,
            };
      },
    });

    const { contexto } = await planejar(db, fake);
    expect(offsets).toEqual([0, 37]);
    expect(contexto.marca).toEqual({ brandId: MARCA_ID, nome: 'Delfrance' });
  });

  it('a paginação é LIMITADA: cinco páginas e o nome fica nulo', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db, { brand_id: MARCA_ID });
    let paginas = 0;
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      getBrandList: () => {
        paginas += 1;
        return { brand_list: [], has_next_page: true, next_offset: paginas * 100 };
      },
    });

    const { contexto } = await planejar(db, fake);
    expect(paginas).toBe(5);
    expect(contexto.marca).toEqual({ brandId: MARCA_ID, nome: null });
    // No UPDATE o bloco `brand` é OMITIDO — omitir não destrói nada, porque
    // `update_item` é campo a campo.
    expect(logInteiro()).toContain('marca não resolvida');
  });
});

/* ========================================================================== */
/*  (9) the failure stamp                                                      */
/* ========================================================================== */

describe('aplicarPublicacao — o carimbo de falha', () => {
  it('uma recusa no leg de modelos carimba falhaPublicacao{etapa} e RELANÇA', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      initTierVariation: () => {
        throw erroApi(
          'product.error_param',
          'Shopee: Model tier_index error',
          '/api/v2/product/init_tier_variation',
        );
      },
    });

    const { plano } = await planejar(db, fake);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toMatchObject({
      name: 'ShopeePublishRejectedError',
      etapa: 'init_tier_variation',
      // VERBATIM, prefixo de módulo e tudo: o prefixo diz qual lista de erros ler.
      shopeeCode: 'product.error_param',
    });

    const patches = patchesDoLink(db);
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({
      falhaPublicacao: expect.objectContaining({
        em: AGORA,
        etapa: 'init_tier_variation',
        erro: 'product.error_param',
      }),
    });
    // ⚠️ O item_id JÁ está gravado — é isso que torna a próxima publicação um
    // UPDATE que roda o leg de modelos de novo.
    expect(patches[0]).toMatchObject({ item_id: ITEM_ID });
    // E a lista nunca sai vazia ao lado de uma mensagem que conta problemas.
    expect(
      (patches[1]?.falhaPublicacao as { problemas?: unknown[] } | undefined)?.problemas,
    ).toHaveLength(1);
  });

  it('uma falha em add_item sem vínculo pré-existente não carimba nada e relança', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({
      addItem: () => {
        throw erroApi('product.error_busi', 'Shopee: this shop cannot create items');
      },
    });

    const { plano } = await planejar(db, fake);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toMatchObject({
      name: 'ShopeePublishRejectedError',
      etapa: 'add_item',
    });
    // Um vínculo que não existe não pode ser um fantasma: nada é criado.
    expect(db.writes).toEqual([]);
    expect(logInteiro()).toContain('nada a carimbar');
  });

  it('um ShopeeRateLimitError NÃO vira uma recusa de publicação', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db);
    const { ShopeeRateLimitError } = await import('@delfrance/integrations-shopee');
    const fake = clienteFake({
      updateItem: () => {
        throw new ShopeeRateLimitError('Shopee respondeu error_limit', {
          code: 'error_limit',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 200,
          path: '/api/v2/product/update_item',
        });
      },
    });

    const { plano } = await planejar(db, fake);
    // A classe original PROPAGA — tem mapeamento HTTP próprio (429) e é um
    // transiente, não uma recusa deste anúncio.
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
      ShopeeRateLimitError,
    );
    // ...e o carimbo ACONTECEU: o operador precisa ver por onde parou.
    expect(patchesDoLink(db)[0]).toMatchObject({
      falhaPublicacao: expect.objectContaining({ etapa: 'update_item', erro: 'error_limit' }),
    });
  });
});

/* ========================================================================== */
/*  (10) publicadoEm                                                           */
/* ========================================================================== */

describe('aplicarPublicacao — publicadoEm', () => {
  it('é escrito na primeira publicação e NUNCA reescrito', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({ addItem: () => ecoDeItem() });
    const { plano } = await planejar(db, fake);
    await aplicarPublicacao(deps(db, fake), plano);
    expect(patchesDoLink(db)[0]).toMatchObject({ publicadoEm: AGORA, dataCadastro: AGORA });

    const db2 = new FakeDb();
    semearCatalogo(db2);
    semearLink(db2, { publicadoEm: 1_700_000_000_000, dataCadastro: 1_700_000_000_000 });
    const fake2 = clienteFake({ updateItem: () => ecoDeItem() });
    const plan2 = await planejar(db2, fake2);
    await aplicarPublicacao(deps(db2, fake2), plan2.plano);
    const patch = patchesDoLink(db2)[0] ?? {};
    expect('publicadoEm' in patch).toBe(false);
    expect('dataCadastro' in patch).toBe(false);
  });
});

/* ========================================================================== */
/*  (11) relistagem                                                            */
/* ========================================================================== */

describe('aplicarPublicacao — a relistagem', () => {
  it('tenta unlist:false e cai para update_item em error_set_normal_unlisted_item', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      unlistItem: () =>
        ackDeUnlist(false, 'product.error_set_normal_unlisted_item: cannot set normal'),
      updateItem: () => ecoDeItem({ item_status: SHOPEE_ITEM_STATUS.normal }),
    });

    const { plano } = await planejar(db, fake);
    expect(plano.relistagem).toEqual(ORDEM_RELISTAGEM);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.relistagem).toBe('update');
    const corpoDoUpdate = fake.corpos.at(-1) ?? {};
    // ⚠️ A ÚNICA chamada do step 11 que manda `item_status`, e o corpo não leva
    // NADA além dele: um status junto de outros campos é ignorado em silêncio
    // em algumas listagens.
    expect(corpoDoUpdate).toEqual({ item_id: ITEM_ID, item_status: 'NORMAL' });
  });

  it('a ordem das portas é a do PLANO — invertê-la inverte a chamada', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      updateItem: () => ecoDeItem({ item_status: SHOPEE_ITEM_STATUS.normal }),
    });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), {
      ...plano,
      relistagem: ['update', 'unlist'],
    });

    expect(r.relistagem).toBe('update');
    expect(fake.ops).not.toContain('unlist_item');
  });

  it('as DUAS portas recusando ⇒ rejeitado em relistagem, sem terceira tentativa', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    let updates = 0;
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      unlistItem: () => ackDeUnlist(false, 'error_set_normal_unlisted_item'),
      updateItem: () => {
        updates += 1;
        throw erroApi(
          'product.error_set_normal_unlisted_item',
          'Shopee: error_set_normal_unlisted_item',
          '/api/v2/product/update_item',
        );
      },
    });

    const { plano } = await planejar(db, fake);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toMatchObject({
      name: 'ShopeePublishRejectedError',
      etapa: 'relistagem',
    });
    expect(updates).toBe(1);
    expect(fake.ops.filter((o) => o === 'unlist_item')).toHaveLength(1);

    // ⚠️ E o carimbo carrega a lista do PRÓPRIO erro, mais o código da Shopee no
    // campo `erro`. `ShopeePublishRejectedError` não é um `ShopeeApiError`, então
    // o classificador respondia `[]` — um carimbo dizendo "1 problema" ao lado de
    // uma lista vazia, e o nome da CLASSE onde deveria estar o código.
    const carimbo = patchesDoLink(db).at(-1)?.falhaPublicacao as Record<string, unknown>;
    expect(carimbo).toMatchObject({
      etapa: 'relistagem',
      erro: 'product.error_set_normal_unlisted_item',
    });
    expect(carimbo.problemas).toHaveLength(1);
  });

  it('uma recusa que NÃO é a de relistagem não tenta a segunda porta', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      unlistItem: () => ackDeUnlist(false, 'product.error_cannt_unlisted_in_promotion'),
    });

    const { plano } = await planejar(db, fake);
    await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toMatchObject({
      name: 'ShopeePublishRejectedError',
      etapa: 'relistagem',
      shopeeCode: 'error_cannt_unlisted_in_promotion',
    });
    expect(fake.ops).not.toContain('update_item');
  });
});

/* ========================================================================== */
/*  (12) the aviso resolver                                                    */
/* ========================================================================== */

describe('aplicarPublicacao — o aviso de violação', () => {
  it('uma leitura de volta limpa fecha o aviso aberto', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const { avisarAnuncioComViolacao, MOTIVO_AVISO_ANUNCIO } = await import('./avisoAnuncio');
    const { increment } = await import('../testing/fakeDb');
    await avisarAnuncioComViolacao(
      asDb(db),
      {
        integracaoId: INTEGRACAO,
        produtoId: PAI,
        itemId: ITEM_ID,
        motivo: MOTIVO_AVISO_ANUNCIO.violacao,
        violacaoTipo: 'Spam',
        prazoMs: null,
      },
      { increment, nowMs: AGORA - 1000 },
    );

    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      getItemBaseInfo: () => baseInfo([linhaDeLeitura({ has_model: false })]),
    });
    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.avisoResolvido).toBe(true);
  });

  it('⛔ NEAR-MISS: violações ARMAZENADAS mantêm o aviso aberto', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearLink(db, {
      violations: [{ violation_type: 'Spam', kind: 'status' }],
    });
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      getItemBaseInfo: () => baseInfo([linhaDeLeitura({ has_model: false })]),
    });

    const { plano } = await planejar(db, fake);
    const r = await aplicarPublicacao(deps(db, fake), plano);
    expect(r.avisoResolvido).toBe(false);
  });
});

/* ========================================================================== */
/*  (13) publicarAnuncioShopee — the glue                                      */
/* ========================================================================== */

describe('publicarAnuncioShopee', () => {
  it('resolve as fotos ANTES do plano e devolve o resultado inteiro', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const fake = clienteFake({ addItem: () => ecoDeItem() });
    const fotos = resolvedorFake();

    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
      entrada(),
    );

    expect(r).not.toBeNull();
    expect(r?.itemId).toBe(ITEM_ID);
    // As fotos entram no corpo: sem ids, `montarAnuncio` recusaria com sem-fotos.
    expect(fake.corpos[0]).toMatchObject({ image: { image_id_list: ['img-1', 'img-2'] } });
    expect(fotos.passes).toEqual([{ cap: null, fotos: 1 }]);
    expect(r?.fotos.enviadas).toBe(2);
    expect(logInteiro()).toContain('publicação de anúncio');
  });

  it('um produto ausente responde null sem tocar a Shopee', async () => {
    const db = new FakeDb();
    const fake = clienteFake();
    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: resolvedorQueRecusa() }),
      entrada(),
    );
    expect(r).toBeNull();
    expect(fake.ops).toEqual([]);
  });
});

/* ========================================================================== */
/*  (14) the tier-1 option images                                              */
/* ========================================================================== */

describe('resolverFotosDaPublicacao — as imagens de opção do tier 1', () => {
  it('sobem com cap 1 e são chaveadas pelo fake path da variante', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db, { fotos: [{ arquivoOuterRef: 'arquivos/arq-filho' }] });
    semearGrupo(db, { permiteFotos: true });
    const fake = clienteFake();
    const fotos = resolvedorFake();

    const contexto = await prepararPublicacao(deps(db, fake), entrada(), fotos.resolvedor);
    const resolvidas = await resolverFotosDaPublicacao(contexto!);

    expect(fotos.passes).toEqual([
      { cap: null, fotos: 1 },
      { cap: 1, fotos: 1 },
    ]);
    expect([...(resolvidas.imagensDeOpcao ?? new Map())]).toEqual([
      [CAMINHO_VARIANTE, 'img-opcao-1'],
    ]);
  });

  it('⛔ NEAR-MISS: uma opção sem foto própria é TUDO-OU-NADA — nenhuma sobe', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    // O filho não tem foto própria, e a regra NÃO herda a primeira do pai.
    semearFilho(db, { fotos: [] });
    semearGrupo(db, { permiteFotos: true });
    const fake = clienteFake();
    const fotos = resolvedorFake();

    const contexto = await prepararPublicacao(deps(db, fake), entrada(), fotos.resolvedor);
    const resolvidas = await resolverFotosDaPublicacao(contexto!);

    expect(resolvidas.imagensDeOpcao).toBeNull();
    // Só a passagem do ITEM rodou: nenhuma opção custou upload.
    expect(fotos.passes).toEqual([{ cap: null, fotos: 1 }]);
  });

  it('permiteFotos false não sobe imagem de opção nenhuma', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearFilho(db, { fotos: [{ arquivoOuterRef: 'arquivos/arq-filho' }] });
    const fake = clienteFake();
    const fotos = resolvedorFake();

    const contexto = await prepararPublicacao(deps(db, fake), entrada(), fotos.resolvedor);
    const resolvidas = await resolverFotosDaPublicacao(contexto!);

    expect(resolvidas.imagensDeOpcao).toBeNull();
    expect(fotos.passes).toEqual([{ cap: null, fotos: 1 }]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  ShopeeApiError,
  shopeeErrorFromEnvelope,
  shopeeLogisticsChannelSchema,
  shopeeSizeChartListSchema,
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
  entradaTabelaShopeeSchema,
  varianteFakePath,
} from '@delfrance/schemas';

import { FIXTURE_SIZE_CHART_DETAIL_DOC, lerDetalheDeTabelaDeMedidas } from '../fixtures/wireCorpus';
import { FakeDb, asDb } from '../testing/fakeDb';
import { listarTabelasDaCategoria } from '../tabelaMedidas/listarTabelasMedidas';
import { construirIndice } from '../taxonomia/categorias';
import { __setShopeeTaxonomiaClockForTests, type ShopeeTaxonomiaCtx } from '../taxonomia/cache';
import {
  ETAPA_PUBLICACAO,
  MOTIVO_PROBLEMA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
} from './errosPublicacao';
import {
  MOTIVO_FOTO_PUBLICACAO,
  type MotivoFotoPublicacao,
  type ResolvedorDeImagensShopee,
  type ResultadoFotosPublicacao,
} from './fotosPublicacao';
import { ORDEM_RELISTAGEM, planejarPublicacao, type PlanoPublicacao } from './planoPublicacao';
import {
  aplicarPublicacao,
  criarResolvedorDePublicacao,
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

/* ========================================================================== */
/*  (15) o preço do FILHO passa por precoDaTabela — passo 13 (#1521), M16/M17  */
/* ========================================================================== */

describe('publicar — o preço do filho é lido por precoDaTabela', () => {
  /** The body of the ONE `init_tier_variation` the fake received. */
  function modelosDoInit(fake: ClienteFake): unknown {
    const corpo = fake.corpos.find((c) => 'model' in c && 'standardise_tier_variation' in c);
    if (corpo === undefined) throw new Error('fixture: nenhum init_tier_variation foi enviado');
    return corpo.model;
  }

  function corpoDoAddItem(fake: ClienteFake): Record<string, unknown> {
    const corpo = fake.corpos.find((c) => 'item_name' in c);
    if (corpo === undefined) throw new Error('fixture: nenhum add_item foi enviado');
    return corpo;
  }

  /**
   * A live listing that has NO models yet (published without variations, the
   * produto gained a child since): the update's FRESH reading is empty, so the
   * leg answers `init` and the child's price rides `init_tier_variation`. Every
   * later reading is the model the init just minted.
   *
   * ⚠️ That is the path where a child priced `0` really REACHED the wire before
   * step 13: an update carries no item-level price refusal (they are CREATE-only),
   * so nothing but the tier mapper's `filho-sem-preco` stands in the way.
   */
  function leituraVaziaPrimeiro(): (p: { itemId: number }) => ShopeeModelList {
    let chamadas = 0;
    return () => {
      chamadas += 1;
      return chamadas === 1 ? modelList([]) : modelList();
    };
  }

  /**
   * ⚠️ D-9: the parent here does NOT propagate (`propagatePriceToChildren:
   * false`). These cases are about the CHILD's OWN price going through
   * `precoDaTabela`; under a propagating parent (an absent flag propagates) the
   * child's map is never read and they would test the parent's 49.9 instead.
   */
  const PAI_SEM_PROPAGACAO = { propagatePriceToChildren: false } as const;

  function semearUpdateComFilhoNovo(db: FakeDb, valor: number): void {
    semearCatalogo(db, PAI_SEM_PROPAGACAO);
    semearFilho(db, { precos: { [TABELA_NORMAL]: { valor } } });
    semearLink(db);
  }

  it('PAR: um filho a 10.567 chega ao init_tier_variation como 10.57 — e o descartável do add_item também', async () => {
    const db = new FakeDb();
    semearCatalogo(db, PAI_SEM_PROPAGACAO);
    semearFilho(db, { precos: { [TABELA_NORMAL]: { valor: 10.567 } } });
    const fake = clienteFake({ addItem: () => ecoDeItem() });

    const { plano, contexto } = await planejar(db, fake);
    expect(contexto.filhos[0]?.preco).toBe(10.57);
    expect(plano.problemas).toEqual([]);
    await aplicarPublicacao(deps(db, fake), plano);

    expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 10.57 })]);
    expect(corpoDoAddItem(fake).original_price).toBe(10.57);
  });

  it('⚠️ NEAR-MISS: um filho a 10.5 já está no centavo e chega intacto', async () => {
    const db = new FakeDb();
    semearCatalogo(db, PAI_SEM_PROPAGACAO);
    semearFilho(db, { precos: { [TABELA_NORMAL]: { valor: 10.5 } } });
    const fake = clienteFake({ addItem: () => ecoDeItem() });

    const { plano } = await planejar(db, fake);
    await aplicarPublicacao(deps(db, fake), plano);

    expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 10.5 })]);
  });

  it('⚠️ um filho a 0 (ou 0.004, ou negativo) agora é RECUSADO com filho-sem-preco — antes ia ao fio como original_price no init_tier_variation', async () => {
    for (const valor of [0, 0.004, -5]) {
      const db = new FakeDb();
      semearUpdateComFilhoNovo(db, valor);
      const fake = clienteFake({
        updateItem: () => ecoDeItem(),
        getModelList: leituraVaziaPrimeiro(),
      });

      const { plano, contexto } = await planejar(db, fake);
      expect(plano.ehAtualizacao).toBe(true);
      expect(contexto.filhos[0]?.preco).toBeNull();
      // O MAPEADOR DE TIERS recusa (`campo: 'model'`) — num update não há recusa
      // de preço no nível do item, então sem ela o 0 era enviado.
      expect(plano.problemas).toEqual([
        expect.objectContaining({
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
        }),
      ]);

      await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
        ShopeePublishBlockedError,
      );
      expect(fake.ops).not.toContain('update_item');
      expect(fake.ops).not.toContain('init_tier_variation');
      expect(db.writes).toEqual([]);
    }
  });

  it('⚠️ NEAR-MISS: o MESMO filho a 0.01 é ENVIADO — um centavo é preço', async () => {
    const db = new FakeDb();
    semearUpdateComFilhoNovo(db, 0.01);
    const fake = clienteFake({
      updateItem: () => ecoDeItem(),
      getModelList: leituraVaziaPrimeiro(),
    });

    const { plano, contexto } = await planejar(db, fake);
    expect(contexto.filhos[0]?.preco).toBe(0.01);
    expect(plano.problemas).toEqual([]);
    const r = await aplicarPublicacao(deps(db, fake), plano);

    expect(r.modelos.acao).toBe('init');
    expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 0.01 })]);
  });

  /* ------------------------------------------------------------------------ */
  /*  D-9: o preço do filho segue o PAI que propaga — a regra do Mercado Livre */
  /* ------------------------------------------------------------------------ */

  describe('D-9 — um pai que propaga dá o preço aos filhos (precoDoFilhoNaTabela)', () => {
    /**
     * A child with NO price of its own: one created after the parent's last price
     * edit, or step 9's import (it writes the parent's `precos` only). The produto
     * trigger copies the parent's map into the children only when the PARENT's
     * prices change, so this child is real under a propagating parent.
     */
    const SEM_PRECO_PROPRIO = { precos: {} } as const;

    it('PAR (UPDATE): pai que propaga, com preço, e um filho SEM preço próprio ⇒ nenhum filho-sem-preco, e o original_price do modelo é o do PAI', async () => {
      const db = new FakeDb();
      // Sem o campo `propagatePriceToChildren`: um documento anterior ao campo PROPAGA.
      semearCatalogo(db);
      semearFilho(db, SEM_PRECO_PROPRIO);
      semearLink(db);
      const fake = clienteFake({
        updateItem: () => ecoDeItem(),
        getModelList: leituraVaziaPrimeiro(),
      });

      const { plano, contexto } = await planejar(db, fake);
      expect(plano.ehAtualizacao).toBe(true);
      expect(contexto.filhos[0]?.preco).toBe(49.9);
      expect(plano.problemas).toEqual([]);
      const r = await aplicarPublicacao(deps(db, fake), plano);

      expect(r.modelos.acao).toBe('init');
      expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 49.9 })]);
    });

    it('PAR (CREATE): o MESMO par ⇒ o init_tier_variation E o descartável do add_item levam o preço do PAI', async () => {
      const db = new FakeDb();
      semearCatalogo(db);
      semearFilho(db, SEM_PRECO_PROPRIO);
      const fake = clienteFake({ addItem: () => ecoDeItem() });

      const { plano, contexto } = await planejar(db, fake);
      expect(plano.ehAtualizacao).toBe(false);
      expect(contexto.filhos[0]?.preco).toBe(49.9);
      expect(plano.problemas).toEqual([]);
      await aplicarPublicacao(deps(db, fake), plano);

      expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 49.9 })]);
      expect(corpoDoAddItem(fake).original_price).toBe(49.9);
    });

    it('⛔ NEAR-MISS: a MESMA família com propagatePriceToChildren false ⇒ filho-sem-preco, no UPDATE também, e nada é escrito nem enviado', async () => {
      for (const comVinculo of [false, true]) {
        const db = new FakeDb();
        semearCatalogo(db, PAI_SEM_PROPAGACAO);
        semearFilho(db, SEM_PRECO_PROPRIO);
        if (comVinculo) semearLink(db);
        const fake = clienteFake({
          addItem: () => ecoDeItem(),
          updateItem: () => ecoDeItem(),
          getModelList: leituraVaziaPrimeiro(),
        });

        const { plano, contexto } = await planejar(db, fake);
        expect(plano.ehAtualizacao).toBe(comVinculo);
        // O pai tem 49.9 e NÃO é lido: sem propagação o preço é o do filho, e ele não tem.
        expect(contexto.filhos[0]?.preco).toBeNull();
        expect(plano.problemas).toContainEqual(
          expect.objectContaining({
            campo: 'model',
            motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
          }),
        );

        await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
          ShopeePublishBlockedError,
        );
        expect(fake.ops).not.toContain('add_item');
        expect(fake.ops).not.toContain('update_item');
        expect(fake.ops).not.toContain('init_tier_variation');
        expect(db.writes).toEqual([]);
      }
    });

    it('PAR: pai que propaga (49.9) + um filho com preço DIFERENTE (10.5) ⇒ o preço do PAI chega ao corpo — o mapa do filho está velho, não é um override', async () => {
      const db = new FakeDb();
      semearCatalogo(db);
      semearFilho(db, { precos: { [TABELA_NORMAL]: { valor: 10.5 } } });
      const fake = clienteFake({ addItem: () => ecoDeItem() });

      const { plano, contexto } = await planejar(db, fake);
      expect(contexto.filhos[0]?.preco).toBe(49.9);
      expect(plano.problemas).toEqual([]);
      await aplicarPublicacao(deps(db, fake), plano);

      expect(modelosDoInit(fake)).toEqual([expect.objectContaining({ original_price: 49.9 })]);
      expect(corpoDoAddItem(fake).original_price).toBe(49.9);
    });

    it('⛔ NEAR-MISS: o propagatePriceToChildren do FILHO nunca é lido — false nele, com o pai propagando, ainda dá o preço do PAI', async () => {
      const db = new FakeDb();
      semearCatalogo(db);
      semearFilho(db, {
        propagatePriceToChildren: false,
        precos: { [TABELA_NORMAL]: { valor: 10.5 } },
      });
      const fake = clienteFake({ addItem: () => ecoDeItem() });

      const { contexto } = await planejar(db, fake);
      expect(contexto.filhos[0]?.preco).toBe(49.9);
    });

    it('⚠️ o gêmeo do "filho a 0": um pai que PROPAGA a 0.004 (e o filho a 49.9) ⇒ ainda filho-sem-preco — o arredondamento vale no braço do pai, e o filho não é fallback', async () => {
      const db = new FakeDb();
      semearCatalogo(db, { precos: { [TABELA_NORMAL]: { valor: 0.004 } } });
      semearFilho(db); // o filho TEM 49.9 próprio — e não é lido
      semearLink(db);
      const fake = clienteFake({
        updateItem: () => ecoDeItem(),
        getModelList: leituraVaziaPrimeiro(),
      });

      const { plano, contexto } = await planejar(db, fake);
      expect(plano.ehAtualizacao).toBe(true);
      expect(contexto.filhos[0]?.preco).toBeNull();
      expect(plano.problemas).toEqual([
        expect.objectContaining({
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
        }),
      ]);

      await expect(aplicarPublicacao(deps(db, fake), plano)).rejects.toBeInstanceOf(
        ShopeePublishBlockedError,
      );
      expect(fake.ops).not.toContain('update_item');
      expect(fake.ops).not.toContain('init_tier_variation');
      expect(db.writes).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------------ */
  /*  D-9: o TEXTO do filho-sem-preco nomeia quem tem o preço                  */
  /* ------------------------------------------------------------------------ */

  describe('D-9 — o texto do filho-sem-preco nomeia quem tem o preço (o motivo não muda)', () => {
    // Sob propagação a web RECUSA editar o preço de uma variação, então o texto
    // que mandava o operador ao preço do filho o mandava a um campo que ele não
    // pode editar. O remédio é o preço do PAI, ou desligar a propagação.
    const TEXTO_PAI_NO_ITEM =
      'o produto pai propaga o preço para as variações e não tem preço na tabela normal — ' +
      'defina o preço do pai ou desligue a propagação';
    const TEXTO_PAI_NO_TIER =
      `A variação ${FILHO} não tem preço: o produto pai propaga o preço para as variações e ` +
      'não tem preço na tabela normal — defina o preço do pai ou desligue a propagação.';
    const TEXTO_FILHO_NO_ITEM =
      'o primeiro filho não tem preço na tabela normal — é dele que sai o preço descartável do item';
    const TEXTO_FILHO_NO_TIER = `A variação ${FILHO} não tem preço e a Shopee exige um original_price por modelo.`;

    /** Every `filho-sem-preco` of the plan, as `[campo, mensagem]`. */
    function recusasDePreco(problemas: PlanoPublicacao['problemas']): [string | null, string][] {
      return problemas
        .filter((p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco)
        .map((p) => [p.campo, p.mensagem]);
    }

    /** Pai que PROPAGA (flag ausente) SEM preço; o filho tem 49.9 próprio, que não é lido. */
    const PAI_PROPAGA_SEM_PRECO = { pai: { precos: {} }, filho: {} };
    /** Pai que NÃO propaga (com 49.9, que não é lido); o filho não tem preço próprio. */
    const PAI_NAO_PROPAGA = { pai: { propagatePriceToChildren: false }, filho: { precos: {} } };

    async function planoDe(
      familia: { readonly pai: Record<string, unknown>; readonly filho: Record<string, unknown> },
      comVinculo: boolean,
    ) {
      const db = new FakeDb();
      semearCatalogo(db, familia.pai);
      semearFilho(db, familia.filho);
      if (comVinculo) semearLink(db);
      const fake = clienteFake({
        addItem: () => ecoDeItem(),
        updateItem: () => ecoDeItem(),
        getModelList: leituraVaziaPrimeiro(),
      });
      const { plano, contexto } = await planejar(db, fake);
      expect(plano.ehAtualizacao).toBe(comVinculo);
      expect(contexto.filhos[0]?.preco).toBeNull();
      return plano;
    }

    it('⚠️ PAR (CREATE): pai que PROPAGA sem preço na tabela normal ⇒ as DUAS recusas (a do item e a do tier) nomeiam o PAI e o remédio', async () => {
      const plano = await planoDe(PAI_PROPAGA_SEM_PRECO, false);
      expect(recusasDePreco(plano.problemas)).toEqual([
        ['original_price', TEXTO_PAI_NO_ITEM],
        ['model', TEXTO_PAI_NO_TIER],
      ]);
    });

    it('⚠️ PAR (UPDATE): o MESMO pai sem preço, anúncio já publicado ⇒ a recusa do tier nomeia o PAI', async () => {
      const plano = await planoDe(PAI_PROPAGA_SEM_PRECO, true);
      expect(recusasDePreco(plano.problemas)).toEqual([['model', TEXTO_PAI_NO_TIER]]);
    });

    it('⛔ QUASE-IGUAL (CREATE e UPDATE): pai que NÃO propaga + filho sem preço próprio ⇒ os textos de sempre, que nomeiam o FILHO — mesmo motivo', async () => {
      const criar = await planoDe(PAI_NAO_PROPAGA, false);
      expect(recusasDePreco(criar.problemas)).toEqual([
        ['original_price', TEXTO_FILHO_NO_ITEM],
        ['model', TEXTO_FILHO_NO_TIER],
      ]);
      const atualizar = await planoDe(PAI_NAO_PROPAGA, true);
      expect(recusasDePreco(atualizar.problemas)).toEqual([['model', TEXTO_FILHO_NO_TIER]]);
    });
  });
});

/* ========================================================================== */
/*  (14) size_chart_info — passo 18 (#1526), §2.7 + A.1                        */
/* ========================================================================== */

describe('publicar — size_chart_info (passo 18)', () => {
  const TABELA = 'tab-1';
  const REF_TABELA = `documents/tabMedi/${TABELA}`;
  /** Shopee's own doc-sample template id — never a real shop's. */
  const MODELO = 700_024_641;
  const OUTRA_CATEGORIA = CATEGORIA + 1;
  const ARQ_TABELA = 'arq-tabela-1';
  const ARQ_TABELA_2 = 'arq-tabela-2';
  const IMG_TABELA = 'img-tabela-1';
  const URL_LIDA = 'https://cf.shopee.invalido/file/sentinela-tabela';
  const FRASE_ID_INEXISTENTE = 'Size chart id not exist in this shop';
  const FRASE_VALIDADOR = 'Upload failed, please upload a more standard size chart image.';

  function entradaDaTabela(categoryId: number, sizeChartId = MODELO) {
    return { categoryId, size_chart_id: sizeChartId, name: 'Camisetas' };
  }

  /**
   * The tabela as the CORPUS carries it: another conta's per-key `null` and a
   * garbage ML map beside THIS conta's list (M77 — neither may cost a read),
   * plus two photos, so "the FIRST one" is a claim with a near-miss.
   */
  function semearTabela(db: FakeDb, entradas: readonly unknown[]): void {
    db.seed(`tabMedi/${TABELA}`, {
      nome: 'Camisetas',
      tabelasMedidasShopee: { 'int-2': null, [INTEGRACAO]: entradas },
      tabelasDeMedidasMercadoLivre: 'lixo-do-corpus',
      fotos: [
        { arquivoOuterRef: `arquivos/${ARQ_TABELA}` },
        { arquivoOuterRef: `arquivos/${ARQ_TABELA_2}` },
      ],
    });
  }

  function semearProdutoComTabela(db: FakeDb, over: Record<string, unknown> = {}): void {
    semearCatalogo(db, { tabelaDeMedidasModaUid: REF_TABELA, ...over });
  }

  interface PassagemDaFoto {
    readonly cap: number | null;
    readonly arquivos: readonly string[];
  }

  /**
   * The photo double, recording WHICH photos each pass asked for. The item pass
   * answers two ids; a pass over the tabela's photo answers {@link IMG_TABELA},
   * or a skipped picture when `falharTabela`.
   */
  function resolvedorDaTabela(
    op: {
      readonly falharTabela?: boolean;
      /** Why the tabela's photo failed — default: Shopee refused the upload. */
      readonly motivoDaFalha?: MotivoFotoPublicacao;
    } = {},
  ) {
    const passes: PassagemDaFoto[] = [];
    const resolvedor: ResolvedorDeImagensShopee = {
      resolver: (fotos, opcoes) => {
        const arquivos = fotos.map((f) => f.arquivoOuterRef);
        passes.push({ cap: opcoes?.cap ?? null, arquivos });
        const daTabela = arquivos.some((a) => a.includes('arq-tabela'));
        const falhou = daTabela && op.falharTabela === true;
        const ids = falhou ? [] : daTabela ? [IMG_TABELA] : ['img-1', 'img-2'];
        const resultado: ResultadoFotosPublicacao = {
          imageIds: ids,
          reutilizadas: 0,
          enviadas: ids.length,
          falhas: falhou
            ? [
                {
                  arquivoId: ARQ_TABELA,
                  motivo: op.motivoDaFalha ?? MOTIVO_FOTO_PUBLICACAO.uploadRecusado,
                  mensagem: 'upload recusado por índice: error_image_size',
                },
              ]
            : [],
          consideradas: fotos.length,
          descartadasPeloLimite: 0,
        };
        return Promise.resolve(resultado);
      },
      resumo: () => ({
        consideradas: 1,
        reutilizadas: 0,
        enviadas: 2,
        falhas: 0,
        descartadasPeloLimite: 0,
      }),
    };
    const daTabela = (): PassagemDaFoto[] =>
      passes.filter((p) => p.arquivos.some((a) => a.includes('arq-tabela')));
    return { resolvedor, passes, daTabela };
  }

  /** The category's `size_chart_limit`, answered by `get_item_limit`. */
  function comLimiteDeTabela(
    fake: ClienteFake,
    limite: {
      size_chart_mandatory: boolean | null;
      support_image_size_chart: boolean | null;
      support_template_size_chart: boolean | null;
    },
  ): void {
    Object.assign(fake.client, {
      getItemLimit: () => {
        fake.ops.push('get_item_limit');
        return Promise.resolve({
          ...BANDAS_DA_LOJA,
          response: { ...BANDAS_DA_LOJA.response, size_chart_limit: limite },
        });
      },
    });
  }

  /** The refusal exactly as the package's transport builds it from an envelope. */
  function erroDaTabela(code: string, frase: string, path = '/api/v2/product/add_item') {
    return shopeeErrorFromEnvelope(
      { error: code, message: frase, request_id: null, warning: null },
      { path, httpStatus: 200, surface: SHOPEE_SURFACE.business },
    );
  }

  function leiturasDaTabela(db: FakeDb): readonly string[] {
    return db.opLog.filter((o) => o.path.startsWith('tabMedi/')).map((o) => o.path);
  }

  it('M76: um produto SEM ref não lê tabMedi nenhum; COM ref, UMA leitura — e nenhuma escrita', async () => {
    const semRef = new FakeDb();
    semearCatalogo(semRef);
    semearTabela(semRef, [entradaDaTabela(CATEGORIA)]);
    const ctx = await prepararPublicacao(
      deps(semRef, clienteFake()),
      entrada(),
      resolvedorQueRecusa(),
    );
    expect(ctx?.tabelaDeMedidas).toEqual({ tipo: 'produto-sem-tabela' });
    expect(leiturasDaTabela(semRef)).toEqual([]);

    const comRef = new FakeDb();
    semearProdutoComTabela(comRef);
    semearTabela(comRef, [entradaDaTabela(CATEGORIA)]);
    const lido = await prepararPublicacao(
      deps(comRef, clienteFake()),
      entrada(),
      // ⚠️ preparar NUNCA sobe a foto da tabela: o resolvedor lança.
      resolvedorQueRecusa(),
    );
    expect(lido?.tabelaDeMedidas.tipo).toBe('lida');
    expect(leiturasDaTabela(comRef)).toEqual([`tabMedi/${TABELA}`]);
    expect(comRef.writes).toEqual([]);
  });

  it('M-A1: o modelo casa e a tabela TEM fotos ⇒ ZERO envios da foto, e o add_item leva só { size_chart_id }', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(CATEGORIA)]);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      getItemBaseInfo: () =>
        baseInfo([linhaDeLeitura({ size_chart_id: MODELO, size_chart: URL_LIDA })]),
    });
    const fotos = resolvedorDaTabela();

    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
      entrada(),
    );

    expect(fotos.daTabela()).toEqual([]);
    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart_id: MODELO });
    expect(r?.tabelaDeMedidas).toEqual({
      sizeChartId: MODELO,
      fonte: 'modelo',
      motivo: null,
      fotoOmitida: null,
      avisoObrigatoria: false,
      // A releitura ecoa o id CRU; a URL vira só PRESENÇA.
      lidaDeVolta: MODELO,
      fotoLidaDeVolta: true,
    });
    // A linha de log leva a decisão e o eco — por NOME, nunca a URL.
    const linha = infos.find((args) => args[0] === '[shopee/anuncios] publicação de anúncio');
    expect(linha?.[1]).toMatchObject({
      tabelaDeMedidas: {
        fonte: 'modelo',
        sizeChartId: MODELO,
        lidaDeVolta: MODELO,
        fotoLidaDeVolta: true,
      },
    });
    expect(logInteiro()).not.toContain(URL_LIDA);
  });

  it('M-A2/M-A3: sem modelo ⇒ UM resolver([fotos[0]], { cap: 1 }) — a PRIMEIRA foto, nunca a segunda', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(OUTRA_CATEGORIA)]);
    const fake = clienteFake({ addItem: () => ecoDeItem() });
    const fotos = resolvedorDaTabela();

    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
      entrada(),
    );

    expect(fotos.daTabela()).toEqual([{ cap: 1, arquivos: [`arquivos/${ARQ_TABELA}`] }]);
    expect(JSON.stringify(fotos.passes)).not.toContain(ARQ_TABELA_2);
    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
    expect(r?.tabelaDeMedidas).toMatchObject({
      fonte: 'foto',
      sizeChartId: null,
      motivo: 'categoria-sem-entrada',
      // A releitura padrão não traz tabela nenhuma.
      lidaDeVolta: null,
      fotoLidaDeVolta: false,
    });
    // O image_id da foto nunca chega à linha de log.
    expect(logInteiro()).not.toContain(IMG_TABELA);
  });

  it('A.1.7: a releitura de uma FOTO — URL presente e size_chart_id 0 ⇒ fotoLidaDeVolta true, lidaDeVolta 0 (os dois ecos são independentes)', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      // Uma tabela de IMAGEM não tem modelo: o id volta zerado e a URL presente.
      getItemBaseInfo: () => baseInfo([linhaDeLeitura({ size_chart_id: 0, size_chart: URL_LIDA })]),
    });

    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: resolvedorDaTabela().resolvedor }),
      entrada(),
    );

    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
    expect(r?.tabelaDeMedidas).toMatchObject({
      fonte: 'foto',
      lidaDeVolta: 0,
      fotoLidaDeVolta: true,
    });
    expect(logInteiro()).not.toContain(URL_LIDA);
  });

  it('⚠️ NEAR-MISS do eco: um size_chart_id 0 de zero-fill fica 0 (DADO, nunca null) e uma URL em branco é AUSÊNCIA', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(CATEGORIA)]);
    const fake = clienteFake({
      addItem: () => ecoDeItem(),
      getItemBaseInfo: () => baseInfo([linhaDeLeitura({ size_chart_id: 0, size_chart: '  ' })]),
    });

    const r = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: resolvedorDaTabela().resolvedor }),
      entrada(),
    );

    expect(r?.tabelaDeMedidas.lidaDeVolta).toBe(0);
    expect(r?.tabelaDeMedidas.fotoLidaDeVolta).toBe(false);
  });

  it('⚠️ fotoLidaDeVolta = uma URL http(s) — o "-" da Shopee (a amostra da própria página) é AUSÊNCIA, nunca "lida de volta"', async () => {
    const lerDeVolta = async (sizeChart: string): Promise<boolean | null | undefined> => {
      __resetAllReadCaches();
      const db = new FakeDb();
      semearProdutoComTabela(db);
      semearTabela(db, []);
      const fake = clienteFake({
        addItem: () => ecoDeItem(),
        getItemBaseInfo: () =>
          baseInfo([linhaDeLeitura({ size_chart_id: 0, size_chart: sizeChart })]),
      });
      const r = await publicarAnuncioShopee(
        deps(db, fake, { resolvedorDeImagens: resolvedorDaTabela().resolvedor }),
        entrada(),
      );
      return r?.tabelaDeMedidas.fotoLidaDeVolta;
    };

    // PAR: qualquer URL http(s) — esquema em qualquer caixa, borda aparada.
    for (const url of [
      URL_LIDA,
      'http://cf.shopee.invalido/file/x',
      ` HTTPS://cf.shopee.invalido/x `,
    ]) {
      expect(await lerDeVolta(url), url).toBe(true);
    }
    // QUASE-PAR: o marcador de ausência da Shopee e o que não é uma URL de imagem.
    for (const quase of [
      '-',
      ' - ',
      '',
      '   ',
      'https://',
      'ftp://cf.shopee.invalido/x',
      '/file/x',
    ]) {
      expect(await lerDeVolta(quase), JSON.stringify(quase)).toBe(false);
    }
  });

  it('M-A4: support_image_size_chart === false ⇒ nenhum envio e nenhuma chave; null ⇒ envia', async () => {
    const recusa = new FakeDb();
    semearProdutoComTabela(recusa);
    semearTabela(recusa, []);
    const fakeRecusa = clienteFake({ addItem: () => ecoDeItem() });
    comLimiteDeTabela(fakeRecusa, {
      size_chart_mandatory: null,
      support_image_size_chart: false,
      support_template_size_chart: null,
    });
    const fotosRecusa = resolvedorDaTabela();

    const r = await publicarAnuncioShopee(
      deps(recusa, fakeRecusa, { resolvedorDeImagens: fotosRecusa.resolvedor }),
      entrada(),
    );
    expect(fotosRecusa.daTabela()).toEqual([]);
    expect('size_chart_info' in (fakeRecusa.corpos[0] ?? {})).toBe(false);
    expect(r?.tabelaDeMedidas).toMatchObject({
      fonte: 'nenhuma',
      fotoOmitida: 'categoria-sem-foto',
    });

    // ⚠️ NEAR-MISS: desconhecido (null) NÃO retém a foto.
    __resetAllReadCaches();
    const nulo = new FakeDb();
    semearProdutoComTabela(nulo);
    semearTabela(nulo, []);
    const fakeNulo = clienteFake({ addItem: () => ecoDeItem() });
    comLimiteDeTabela(fakeNulo, {
      size_chart_mandatory: null,
      support_image_size_chart: null,
      support_template_size_chart: null,
    });
    const fotosNulo = resolvedorDaTabela();
    await publicarAnuncioShopee(
      deps(nulo, fakeNulo, { resolvedorDeImagens: fotosNulo.resolvedor }),
      entrada(),
    );
    expect(fotosNulo.daTabela()).toHaveLength(1);
    expect(fakeNulo.corpos[0]?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
  });

  it('M-A5: um image_id já em cache em arquivos.externalIds ⇒ nenhum upload_image, nenhum download', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    const cache = (externalId: string) => ({
      externalIds: [{ integracaoPath: REF_CONTA, externalId }],
    });
    db.seed('arquivos/arq-1', cache('img-cache-item'));
    db.seed(`arquivos/${ARQ_TABELA}`, cache('img-cache-tabela'));
    const fake = clienteFake();
    const d = deps(db, fake, {
      fetchImpl: () => Promise.reject(new Error('fixture: nada deveria ser baixado')),
    });

    // O resolvedor REAL — com o allow-list e o cache do passo 11 —, e um
    // partner client que LANÇA: um upload_image aqui mataria o teste.
    const contexto = await prepararPublicacao(d, entrada(), criarResolvedorDePublicacao(d, PAI));
    if (contexto === null) throw new Error('fixture: contexto nulo');
    const fotos = await resolverFotosDaPublicacao(contexto);
    const plano = planejarPublicacao(contexto, fotos);

    expect(fotos.tabelaDeMedidas).toEqual({ imageId: 'img-cache-tabela', falha: null });
    expect(plano.item.criar.size_chart_info).toEqual({ size_chart: 'img-cache-tabela' });
    expect(plano.recusaTabelaDeMedidas).toBeNull();
    expect(fotos.resumo.enviadas).toBe(0);
  });

  it('M-A7: a foto da tabela NÃO sobe ⇒ 422 em size_chart_info (nunca image), ANTES de qualquer escrita — nem o carimbo', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    // Uma REpublicação: há vínculo, então um carimbo de falha SERIA possível.
    semearLink(db);
    const fake = clienteFake();
    const fotos = resolvedorDaTabela({ falharTabela: true });

    const erro = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
      entrada(),
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    const recusa = erro as ShopeePublishRejectedError;
    expect(recusa.etapa).toBe(ETAPA_PUBLICACAO.fotos);
    expect(recusa.problemas).toEqual([
      expect.objectContaining({
        campo: 'size_chart_info',
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
      }),
    ]);
    expect(recusa.problemas[0]?.mensagem).toContain(MOTIVO_FOTO_PUBLICACAO.uploadRecusado);
    // A SHOPEE recusou o upload: a frase e o cabeçalho dizem isso — sem um "()" vazio.
    expect(recusa.problemas[0]?.mensagem).toContain('recusada pela Shopee');
    expect(recusa.recusadaPelaShopee).toBe(true);
    expect(recusa.message).toBe(
      `Publicação recusada pela Shopee em fotos no produto ${PAI} (item ${String(ITEM_ID)}): 1 problema`,
    );
    expect(fake.ops).not.toContain('add_item');
    expect(fake.ops).not.toContain('update_item');
    expect(db.writes).toEqual([]);
  });

  it('⛔ QUASE-PAR do M-A7: a foto que a Shopee NUNCA viu (download, rede) ⇒ o mesmo 422, mas "interrompida" e "tente de novo" — nunca "recusada pela Shopee"', async () => {
    for (const motivo of [
      MOTIVO_FOTO_PUBLICACAO.http,
      MOTIVO_FOTO_PUBLICACAO.contentType,
      MOTIVO_FOTO_PUBLICACAO.arquivoAusente,
    ]) {
      __resetAllReadCaches();
      const db = new FakeDb();
      semearProdutoComTabela(db);
      semearTabela(db, []);
      const fake = clienteFake();
      const fotos = resolvedorDaTabela({ falharTabela: true, motivoDaFalha: motivo });

      const erro = await publicarAnuncioShopee(
        deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
        entrada(),
      ).catch((e: unknown) => e);

      expect(erro, motivo).toBeInstanceOf(ShopeePublishRejectedError);
      const recusa = erro as ShopeePublishRejectedError;
      // A RECUSA não muda (Q1c): a mesma etapa, o mesmo campo, o mesmo motivo.
      expect(recusa.etapa, motivo).toBe(ETAPA_PUBLICACAO.fotos);
      expect(recusa.problemas, motivo).toEqual([
        expect.objectContaining({
          campo: 'size_chart_info',
          motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
        }),
      ]);
      // …mas ninguém culpa a Shopee, e o que fazer vem primeiro.
      expect(recusa.recusadaPelaShopee, motivo).toBe(false);
      expect(recusa.message, motivo).toBe(
        `Publicação interrompida em fotos no produto ${PAI}: 1 problema`,
      );
      expect(recusa.problemas[0]?.mensagem, motivo).toContain(
        'não foi possível enviar a foto da tabela de medidas — tente de novo',
      );
      expect(`${recusa.message} ${recusa.problemas[0]?.mensagem ?? ''}`, motivo).not.toContain(
        'Shopee',
      );
      expect(fake.ops, motivo).not.toContain('add_item');
      expect(db.writes, motivo).toEqual([]);
    }
  });

  it('⛔ pelo resolvedor REAL: um fetch que REJEITA (TypeError) na foto da tabela ⇒ 422 "interrompida", "tente de novo"', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    // A foto do ITEM vem do cache; a da TABELA precisa ser baixada — e a rede cai.
    db.seed('arquivos/arq-1', {
      externalIds: [{ integracaoPath: REF_CONTA, externalId: 'img-cache-item' }],
    });
    db.seed(`arquivos/${ARQ_TABELA}`, {
      url: 'https://firebasestorage.googleapis.com/v0/b/fixture/o/tabela.jpg?alt=media',
    });
    const fake = clienteFake();
    // Sem `resolvedorDeImagens`: o publicador monta o REAL (allow-list, cache, falhas).
    const d = deps(db, fake, {
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });

    const erro = await publicarAnuncioShopee(d, entrada()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    const recusa = erro as ShopeePublishRejectedError;
    expect(recusa.message).toBe(`Publicação interrompida em fotos no produto ${PAI}: 1 problema`);
    expect(recusa.problemas[0]?.mensagem).toBe(
      'não foi possível enviar a foto da tabela de medidas — tente de novo; se repetir, troque a ' +
        `primeira foto ou escolha um modelo em /medidas (envio da foto: ${MOTIVO_FOTO_PUBLICACAO.http}, tabela ${TABELA})`,
    );
    expect(fake.ops).not.toContain('add_item');
  });

  it('M-A8/M78: um modelo VELHO recusado no add_item ⇒ 422 em size_chart_info, UMA chamada, e NENHUMA tentativa de foto', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(CATEGORIA)]);
    const fake = clienteFake({
      addItem: () => {
        throw erroDaTabela('product.error_param', FRASE_ID_INEXISTENTE);
      },
    });
    const fotos = resolvedorDaTabela();

    const erro = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: fotos.resolvedor }),
      entrada(),
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    const recusa = erro as ShopeePublishRejectedError;
    expect(recusa.etapa).toBe(ETAPA_PUBLICACAO.addItem);
    expect(recusa.shopeeCode).toBe('product.error_param');
    expect(recusa.problemas).toEqual([
      expect.objectContaining({
        campo: 'size_chart_info',
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
      }),
    ]);
    // Sem retentativa sem a chave (Q4), e o fallback de FOTO nunca entra.
    expect(fake.ops.filter((o) => o === 'add_item')).toHaveLength(1);
    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart_id: MODELO });
    expect(fotos.daTabela()).toEqual([]);
    // Num create recusado no add_item não há vínculo: nada é gravado.
    expect(db.writes).toEqual([]);
  });

  it('o mesmo modelo velho no update_item ⇒ 422 em size_chart_info, UMA chamada', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(CATEGORIA)]);
    semearLink(db);
    const fake = clienteFake({
      updateItem: () => {
        throw erroDaTabela(
          'product.error_param',
          FRASE_ID_INEXISTENTE,
          '/api/v2/product/update_item',
        );
      },
    });

    const erro = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: resolvedorDaTabela().resolvedor }),
      entrada(),
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    expect((erro as ShopeePublishRejectedError).etapa).toBe(ETAPA_PUBLICACAO.updateItem);
    expect((erro as ShopeePublishRejectedError).problemas[0]).toMatchObject({
      campo: 'size_chart_info',
      motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
    });
    expect(fake.ops.filter((o) => o === 'update_item')).toHaveLength(1);
    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart_id: MODELO });
  });

  it('M-A6: o validador de IMAGEM da Shopee recusa a foto ⇒ 422 em size_chart_info, sem retentativa', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    const fake = clienteFake({
      addItem: () => {
        throw erroDaTabela('product.error_busi', FRASE_VALIDADOR);
      },
    });

    const erro = await publicarAnuncioShopee(
      deps(db, fake, { resolvedorDeImagens: resolvedorDaTabela().resolvedor }),
      entrada(),
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    expect((erro as ShopeePublishRejectedError).problemas).toEqual([
      expect.objectContaining({
        campo: 'size_chart_info',
        motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
      }),
    ]);
    expect(fake.ops.filter((o) => o === 'add_item')).toHaveLength(1);
    expect(fake.corpos[0]?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
    expect(db.writes).toEqual([]);
  });

  it('M75: a retentativa fiscal C13 tira SÓ tax_info — o size_chart_info fica no reenvio', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(CATEGORIA)]);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        if (chamadas === 1) throw erroApi('product.error_param', `Shopee: ${FRASE_BR}`);
        return ecoDeItem();
      },
    });

    const { plano } = await planejar(db, fake);
    const comFiscal: PlanoPublicacao = {
      ...plano,
      item: {
        ...plano.item,
        criar: { ...plano.item.criar, tax_info: { ncm: '61091000', cest: '2804200' } },
      },
    };
    await aplicarPublicacao(deps(db, fake), comFiscal);

    expect(chamadas).toBe(2);
    expect(fake.corpos[0]).toHaveProperty('tax_info');
    expect('tax_info' in (fake.corpos[1] ?? {})).toBe(false);
    expect(fake.corpos[1]?.size_chart_info).toEqual({ size_chart_id: MODELO });
  });

  it('M75 (A.1.5): …e mantém o que foi enviado — a FOTO também sobrevive à retentativa fiscal', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, []);
    let chamadas = 0;
    const fake = clienteFake({
      addItem: () => {
        chamadas += 1;
        if (chamadas === 1) throw erroApi('product.error_param', `Shopee: ${FRASE_BR}`);
        return ecoDeItem();
      },
    });

    const { plano } = await planejar(
      db,
      fake,
      {},
      {},
      { resolvedor: resolvedorDaTabela().resolvedor, passes: [] },
    );
    expect(plano.item.criar.size_chart_info).toEqual({ size_chart: IMG_TABELA });
    const comFiscal: PlanoPublicacao = {
      ...plano,
      item: {
        ...plano.item,
        criar: { ...plano.item.criar, tax_info: { ncm: '61091000', cest: '2804200' } },
      },
    };
    await aplicarPublicacao(deps(db, fake), comFiscal);

    expect(chamadas).toBe(2);
    expect('tax_info' in (fake.corpos[1] ?? {})).toBe(false);
    expect(fake.corpos[1]?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
  });

  it('⛔ M-A11: a passada da foto decide pela categoria do LINK — link 100017 + corpo 100018 + entrada só para 100018 ⇒ foto', async () => {
    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [entradaDaTabela(OUTRA_CATEGORIA)]);
    semearLink(db); // category_id = CATEGORIA
    const fake = clienteFake();
    const fotos = resolvedorDaTabela();

    const { plano } = await planejar(
      db,
      fake,
      {},
      { categoryId: OUTRA_CATEGORIA },
      { resolvedor: fotos.resolvedor, passes: [] },
    );

    // A entrada é do corpo da rota (100018); o anúncio está em 100017 ⇒ não casa,
    // a foto é a fonte — e a passada e o corpo concordam sobre isso.
    expect(plano.item.atualizar?.category_id).toBe(CATEGORIA);
    expect(fotos.daTabela()).toHaveLength(1);
    expect(plano.item.atualizar?.size_chart_info).toEqual({ size_chart: IMG_TABELA });
    expect(plano.recusaTabelaDeMedidas).toBeNull();
  });

  it('RT3: uma linha "700024641" em TEXTO no fio ⇒ o walker REAL da rota de lista ⇒ entrada do corpus ⇒ tabMedi ⇒ o add_item leva o NÚMERO JSON', async () => {
    // O PRODUTOR real da linha (`listarTabelasDaCategoria`, o que a rota `lista`
    // responde), sobre a página e o detalhe como o PACOTE os resolve — a linha
    // nunca é montada à mão. O detalhe é o da doc (pelo schema do pacote),
    // ecoando o id pedido — a amostra ecoa OUTRO id (A.3).
    const detalheDaDoc = lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC);
    const fake = clienteFake();
    Object.assign(fake.client, {
      getSizeChartList: () => {
        fake.ops.push('get_size_chart_list');
        return Promise.resolve(
          shopeeSizeChartListSchema.parse({
            error: '',
            message: '',
            response: { size_chart_list: [{ size_chart_id: '700024641' }], next_cursor: '' },
          }).response,
        );
      },
      getSizeChartDetail: (p: { readonly sizeChartId: number }) => {
        fake.ops.push('get_size_chart_detail');
        return Promise.resolve({ ...detalheDaDoc, size_chart_id: p.sizeChartId });
      },
    });
    const lista = await listarTabelasDaCategoria({ client: fake.client }, CATEGORIA);
    expect(lista.tabelas.map((t) => t.sizeChartId)).toEqual([MODELO]);
    const [linha] = lista.tabelas;
    if (linha === undefined) throw new Error('fixture: a lista não trouxe a linha');

    // O que o /medidas grava a partir dessa linha: a entrada do corpus.
    const guardada = entradaTabelaShopeeSchema.parse({
      categoryId: CATEGORIA,
      size_chart_id: linha.sizeChartId,
      name: 'Camisetas',
    });

    const db = new FakeDb();
    semearProdutoComTabela(db);
    semearTabela(db, [guardada]);
    const { plano } = await planejar(db, fake);

    expect(JSON.stringify(plano.item.criar)).toContain(
      '"size_chart_info":{"size_chart_id":700024641}',
    );
  });
});

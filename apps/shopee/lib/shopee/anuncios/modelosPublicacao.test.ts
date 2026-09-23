import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_TIER_MAX_OPTIONS,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  shopeeTierVariationSchema,
  shopeeTierWriteSchema,
  shopeeWriteAckSchema,
  type ShopeeLogisticsChannel,
  type ShopeeModelList,
  type ShopeeTierWriteResponse,
  type ShopeeWriteAck,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, SHOPEE_MODEL_STATUS, varianteFakePath } from '@delfrance/schemas';

import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import { FakeDb, asDb } from '../testing/fakeDb';
import type { AtributosProjetados } from '../taxonomia/dto';
import type { LimitesDeItemDto, LimitesDeItemLidos } from '../taxonomia/limites';
import { ShopeePublishBlockedError } from './errosPublicacao';
import type {
  ResolvedorDeImagensShopee,
  ResultadoFotosPublicacao,
  ResumoFotosPublicacao,
} from './fotosPublicacao';
import type { LinkDeVariacao } from './linkAnuncio';
import {
  type ClienteDeModelos,
  type DepsModelos,
  aplicarModelos,
  padronizadasDeTiers,
} from './modelosPublicacao';
import type { LinkListagemLido, ProdutoParaPublicar } from './montagemAnuncio';
import {
  type ContextoPublicacao,
  type FotosResolvidas,
  type PlanoPublicacao,
  planejarPublicacao,
} from './planoPublicacao';
import type { FilhoParaPublicar, GrupoParaTier } from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const [INDICE_VARIACAO] = INDICES_COMPOSTOS_SHOPEE;

const INTEGRACAO = 'int-1';
const ITEM_ID = 2500139861;
const CATEGORIA = 100017;
const TABELA_NORMAL = 'tab-normal';
const CANAL = 90003;
const PAI = 'prod-pai';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const FILHO_C = 'prod-filho-c';
const GRUPO = 'g-cor';
const LINK_PAI = 'link-1';
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const MODEL_ORFAO = 2000458804;
const MODEL_NOVO = 2000458805;
const AGORA = 1_757_000_000_000;
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_LINK_PAI = `documents/produtos/${PAI}/prodshopee/${LINK_PAI}`;

const BANDAS: LimitesDeItemDto = {
  priceLimit: { min: 1, max: 1000 },
  wholesalePriceThresholdPercentage: null,
  stockLimit: { min: 2, max: 1_000_000 },
  itemNameLengthLimit: { min: 10, max: 120 },
  itemImageCountLimit: { min: 1, max: 9 },
  itemDescriptionLengthLimit: { min: 20, max: 3000 },
  tierVariationNameLengthLimit: null,
  tierVariationOptionLengthLimit: null,
  itemCountLimit: null,
  extendedDescriptionLimit: null,
  dtsLimit: { daysToShipLimit: { min: 1, max: 30 }, nonPreOrderDaysToShip: 3 },
  weightLimit: null,
  dimensionLimit: null,
  sizeChartLimit: null,
};

const LIMITES: LimitesDeItemLidos = {
  limites: BANDAS,
  gtinLimit: { gtinValidationRule: 'Optional' },
  supportsPreOrder: true,
};

const PRODUTO: ProdutoParaPublicar = {
  id: PAI,
  nome: 'Camiseta básica branca',
  sku: 'CAM-BR',
  gtin: null,
  paiId: null,
  ehKit: false,
  ehKitVirtual: false,
  ehUsado: false,
  ofereceFreteGratis: false,
  crossdocking: null,
  pesoBrutoKg: 0.32,
  pesoLiquidoKg: 0.28,
  alturaCm: 2.1,
  larguraCm: 21.4,
  profundidadeCm: 29.2,
  precos: { [TABELA_NORMAL]: { valor: 49.9 } },
  variacoesUid: [],
  componentesKit: null,
  fotos: [],
};

const DESCRICAO = 'Camiseta de algodão penteado, gola redonda, unissex.';

function canal(): ShopeeLogisticsChannel {
  return shopeeLogisticsChannelSchema.parse({
    logistics_channel_id: CANAL,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
  });
}

const VARIANTES = [
  { varianteId: 'v-azul', nome: 'Azul', ordem: 1 },
  { varianteId: 'v-preto', nome: 'Preto', ordem: 2 },
  { varianteId: 'v-vermelho', nome: 'Vermelho', ordem: 3 },
];

function grupo(parcial: Partial<GrupoParaTier> = {}): GrupoParaTier {
  return {
    grupoId: GRUPO,
    nome: 'Cor',
    ordem: 1,
    permiteFotos: false,
    variacoes: VARIANTES,
    linksVariacoesShopee: [
      {
        name: 'Cor',
        category_id: CATEGORIA,
        variation_id: 0,
        variation_group_list: 0,
        integracaoShopeeId: INTEGRACAO,
        variationOptions: [],
      },
    ],
    ...parcial,
  };
}

function filho(
  produtoId: string,
  varianteId: string,
  parcial: Partial<FilhoParaPublicar> = {},
): FilhoParaPublicar {
  return {
    produtoId,
    sku: `SKU-${varianteId}`,
    gtin: null,
    ordem: 1,
    variacoesUid: [varianteFakePath(GRUPO, varianteId)],
    preco: 39.9,
    estoque: 5,
    fotos: [],
    linkModelId: null,
    linkDocId: null,
    tierIndexArmazenado: null,
    ...parcial,
  };
}

const LINK: LinkListagemLido = {
  item_id: ITEM_ID,
  item_name: null,
  description: null,
  category_id: CATEGORIA,
  brand_id: null,
  attributes: null,
  logistic_info: null,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
};

const RESUMO: ResumoFotosPublicacao = {
  consideradas: 1,
  reutilizadas: 1,
  enviadas: 0,
  falhas: 0,
  descartadasPeloLimite: 0,
};

const PASSAGEM: ResultadoFotosPublicacao = {
  imageIds: ['img-1'],
  reutilizadas: 1,
  enviadas: 0,
  falhas: [],
  consideradas: 1,
  descartadasPeloLimite: 0,
};

const FOTOS: FotosResolvidas = { item: PASSAGEM, imagensDeOpcao: null, resumo: RESUMO };

function resolvedorProibido(): ResolvedorDeImagensShopee {
  return {
    resolver: () => {
      throw new Error('o leg de modelos chamou o resolvedor de imagens');
    },
    resumo: () => {
      throw new Error('o leg de modelos leu o resumo do resolvedor');
    },
  };
}

const SEM_ATRIBUTOS: AtributosProjetados = { atributos: [], truncated: false };

function contexto(parcial: Partial<ContextoPublicacao> = {}): ContextoPublicacao {
  return {
    integracaoId: INTEGRACAO,
    produto: PRODUTO,
    descricao: DESCRICAO,
    filhos: [],
    grupos: [grupo()],
    link: null,
    linkDocId: null,
    linksDeVariacao: [],
    limites: LIMITES,
    atributos: SEM_ATRIBUTOS,
    veredictoFolha: 'folha',
    categoryId: CATEGORIA,
    marca: { brandId: 1234, nome: 'Delfrance' },
    canais: [canal()],
    imposto: { imposto: null, motivo: null },
    resolvedorDeImagens: resolvedorProibido(),
    ehAtualizacao: false,
    statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    tabelaNormalId: TABELA_NORMAL,
    ownDisponivel: 7,
    disponivelByProdutoId: {},
    nowMs: AGORA,
    ...parcial,
  };
}

function plano(parcial: Partial<ContextoPublicacao> = {}): PlanoPublicacao {
  const p = planejarPublicacao(contexto(parcial), FOTOS);
  if (p.problemas.length > 0) {
    throw new Error(`fixture bloqueada: ${p.problemas.map((x) => x.motivo).join(',')}`);
  }
  return p;
}

/**
 * A live reading of ONE custom tier with the named options, plus its models.
 *
 * ⚠️ `model_status` defaults to `MODEL_NORMAL` so a fresh row AGREES with what
 * {@link semearVinculo} stored: most cases here are about what a CHANGE writes,
 * and a fixture silently disagreeing on a second field would make every one of
 * them write for the wrong reason.
 */
function arvore(
  nomes: readonly string[],
  modelos: readonly Record<string, unknown>[],
): ShopeeModelList {
  return shopeeModelListPayloadSchema.parse({
    tier_variation: [
      shopeeTierVariationSchema.parse({
        name: 'Cor',
        option_list: nomes.map((option) => ({ option })),
      }),
    ],
    standardise_tier_variation: null,
    model: modelos.map((m) => ({ model_status: SHOPEE_MODEL_STATUS.normal, ...m })),
  });
}

function tierWrite(
  modelos: readonly (Record<string, unknown> | null)[],
  warning: string | null = null,
): ShopeeTierWriteResponse {
  return shopeeTierWriteSchema.parse({
    error: '',
    warning,
    response: { item_id: ITEM_ID, model: modelos },
  });
}

function ack(warning: string | null = null): ShopeeWriteAck {
  return shopeeWriteAckSchema.parse({ error: '', warning });
}

/* ------------------------------ the fake client --------------------------- */

interface ChamadaShopee {
  readonly op: string;
  readonly corpo: unknown;
}

interface ClienteFake {
  readonly client: ClienteDeModelos;
  readonly chamadas: ChamadaShopee[];
  readonly ops: () => readonly string[];
  corpoDe: (op: string) => unknown;
}

/**
 * A client over the five ops this leg owns, recording every call IN ORDER.
 *
 * `leituras` is a QUEUE: the update path consumes one at the top of the leg and
 * one as the reconciliation read, so the two readings can differ — which is the
 * only way to prove the sent `model_list` came from the second.
 */
function clienteFake(cfg: {
  readonly leituras?: readonly ShopeeModelList[];
  readonly init?: ShopeeTierWriteResponse;
  readonly add?: ShopeeTierWriteResponse;
  readonly ackTier?: ShopeeWriteAck;
  readonly ackModel?: ShopeeWriteAck;
  readonly falhaEm?: { readonly op: string; readonly erro: Error };
}): ClienteFake {
  const chamadas: ChamadaShopee[] = [];
  const fila = [...(cfg.leituras ?? [])];

  function registrar(op: string, corpo: unknown): void {
    chamadas.push({ op, corpo });
    if (cfg.falhaEm?.op === op) throw cfg.falhaEm.erro;
  }

  const client: ClienteDeModelos = {
    getModelList: (p) => {
      registrar('getModelList', p);
      // A QUEUE that never empties: the last reading answers every further call,
      // so a test supplies one entry when both reads see the same tree and two
      // when they must differ.
      const proxima = fila.length > 1 ? fila.shift() : fila[0];
      return Promise.resolve(proxima ?? arvore([], []));
    },
    initTierVariation: (body) => {
      registrar('initTierVariation', body);
      return Promise.resolve(cfg.init ?? tierWrite([]));
    },
    updateTierVariation: (body) => {
      registrar('updateTierVariation', body);
      return Promise.resolve(cfg.ackTier ?? ack());
    },
    addModel: (body) => {
      registrar('addModel', body);
      return Promise.resolve(cfg.add ?? tierWrite([]));
    },
    updateModel: (body) => {
      registrar('updateModel', body);
      return Promise.resolve(cfg.ackModel ?? ack());
    },
  };

  return {
    client,
    chamadas,
    ops: () => chamadas.map((c) => c.op),
    corpoDe: (op) => chamadas.find((c) => c.op === op)?.corpo,
  };
}

function deps(db: FakeDb, cliente: ClienteFake): DepsModelos {
  return { db: asDb(db), client: cliente.client, integracaoId: INTEGRACAO, nowMs: AGORA };
}

/* ------------------------------- db seeding ------------------------------- */

function semearFilhos(db: FakeDb, ...ids: readonly string[]): void {
  for (const id of ids) db.seed(`produtos/${id}`, { nome: `Filho ${id}`, paiId: PAI });
}

function semearVinculo(
  db: FakeDb,
  filhoId: string,
  docId: string,
  extra: Record<string, unknown> = {},
): void {
  db.seed(`produtos/${filhoId}/variashopee/${docId}`, {
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: REF_LINK_PAI,
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    ...extra,
  });
}

function vinculo(
  produtoId: string,
  linkDocId: string,
  modelId: number,
  tierIndex: readonly number[],
): LinkDeVariacao {
  return {
    produtoId,
    linkDocId,
    raw: {},
    modelId,
    tierIndex,
    modelStatus: SHOPEE_MODEL_STATUS.normal,
    modeloAusenteEm: null,
  };
}

function docsEm(db: FakeDb, filhoId: string): Record<string, unknown>[] {
  return db
    .idsEm(`produtos/${filhoId}/variashopee`)
    .map(
      (id) =>
        (db.store[`produtos/${filhoId}/variashopee/${id}`]?.data ?? {}) as Record<string, unknown>,
    );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                  (1) o caminho de CREATE — init + mintagem                  */
/* -------------------------------------------------------------------------- */

describe('aplicarModelos — o create com filhos', () => {
  it('manda UM init_tier_variation e só depois lê o get_model_list de reconciliação', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-v-azul' },
            { model_id: MODEL_B, tier_index: [1], model_sku: 'SKU-v-preto' },
          ],
        ),
      ],
      init: tierWrite([
        { model_id: MODEL_A, tier_index: [0] },
        { model_id: MODEL_B, tier_index: [1] },
      ]),
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual(['initTierVariation', 'getModelList']);
    expect(r.acao).toBe('init');
    expect(r.total).toBe(2);
    expect(r.criados).toBe(2);
    expect(r.passos.map((x) => x.tipo)).toEqual(['init_tier_variation', 'get_model_list']);
  });

  it('o corpo do init carrega os modelos completos e a árvore padronizada', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-v-azul' },
            { model_id: MODEL_B, tier_index: [1], model_sku: 'SKU-v-preto' },
          ],
        ),
      ],
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.corpoDe('initTierVariation')).toEqual({
      item_id: ITEM_ID,
      model: [
        {
          tier_index: [0],
          original_price: 39.9,
          seller_stock: [{ stock: 5 }],
          model_sku: 'SKU-v-azul',
        },
        {
          tier_index: [1],
          original_price: 39.9,
          seller_stock: [{ stock: 5 }],
          model_sku: 'SKU-v-preto',
        },
      ],
      standardise_tier_variation: [
        {
          variation_id: 0,
          variation_name: 'Cor',
          variation_option_list: [
            { variation_option_id: 0, variation_option_name: 'Azul' },
            { variation_option_id: 0, variation_option_name: 'Preto' },
          ],
        },
      ],
    });
  });

  it('os vínculos novos nascem apontando para o documento do LINK PAI', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0] },
            { model_id: MODEL_B, tier_index: [1] },
          ],
        ),
      ],
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(docsEm(db, FILHO_A)).toEqual([
      {
        contaVariacaoShopeeOuterRef: REF_CONTA,
        produtoShopeeOuterRef: REF_LINK_PAI,
        model_id: MODEL_A,
        tier_index: [0],
        model_status: SHOPEE_MODEL_STATUS.normal,
        promotion_id: null,
        modeloAusenteEm: null,
        // Step 12's two child diagnostics — born null, stamped only by the stock
        // sender's refusal write-back (`variacaoShopeeLinkSchema`).
        estoqueRecusaEm: null,
        estoqueRecusaCodigo: null,
      },
    ]);
    expect(docsEm(db, FILHO_B)[0]?.model_id).toBe(MODEL_B);
  });

  it('⛔ um modelo que a Shopee devolveu com model_id 0 NUNCA vira vínculo', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0] },
            { model_id: 0, tier_index: [1] },
          ],
        ),
      ],
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(r.criados).toBe(1);
    expect(r.ignorados).toBe(1);
    expect(r.semFilho).toEqual([]);
    expect(docsEm(db, FILHO_B)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*            (2) o republish — a lista vem da leitura FRESCA (M-50)           */
/* -------------------------------------------------------------------------- */

/** The three children, the three live options and the two stored links. */
function cenarioDeRepublish(db: FakeDb): {
  readonly p: PlanoPublicacao;
  readonly fresca: ShopeeModelList;
  /** The reconciliation reading, AFTER `add_model` minted the third position. */
  readonly depois: ShopeeModelList;
} {
  semearFilhos(db, FILHO_A, FILHO_B, FILHO_C);
  semearVinculo(db, FILHO_A, 'v-a', { model_id: MODEL_A, tier_index: [1] });
  semearVinculo(db, FILHO_B, 'v-b', { model_id: MODEL_B, tier_index: [0] });

  // ⚠️ The live models sit at the OPPOSITE positions from ours, and a third
  // model (`MODEL_ORFAO`) has no child at all.
  const fresca = arvore(
    ['Azul', 'Preto', 'Verde'],
    [
      { model_id: MODEL_A, tier_index: [1], model_sku: 'SKU-v-azul' },
      { model_id: MODEL_B, tier_index: [0], model_sku: 'SKU-v-preto' },
      { model_id: MODEL_ORFAO, tier_index: [2], model_sku: 'SKU-do-vendedor' },
    ],
  );

  const depois = arvore(
    ['Azul', 'Preto', 'Verde', 'Vermelho'],
    [
      { model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-v-azul' },
      { model_id: MODEL_B, tier_index: [1], model_sku: 'SKU-v-preto' },
      { model_id: MODEL_ORFAO, tier_index: [2], model_sku: 'SKU-do-vendedor' },
      { model_id: MODEL_NOVO, tier_index: [3], model_sku: 'SKU-v-vermelho' },
    ],
  );

  const p = plano({
    ehAtualizacao: true,
    link: LINK,
    linkDocId: LINK_PAI,
    filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto'), filho(FILHO_C, 'v-vermelho')],
    linksDeVariacao: [vinculo(FILHO_A, 'v-a', MODEL_A, [1]), vinculo(FILHO_B, 'v-b', MODEL_B, [0])],
  });

  return { p, fresca, depois };
}

describe('aplicarModelos — o republish', () => {
  it('M-50: o model_list vem da leitura FRESCA, nunca dos vínculos armazenados', async () => {
    const db = new FakeDb();
    const { p, fresca, depois } = cenarioDeRepublish(db);
    const cliente = clienteFake({
      leituras: [fresca, depois],
      add: tierWrite([{ model_id: MODEL_NOVO, tier_index: [3] }]),
    });

    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    const corpo = cliente.corpoDe('updateTierVariation') as {
      readonly model_list: readonly { readonly model_id: number }[];
    };
    expect(corpo.model_list.map((m) => m.model_id)).toEqual([MODEL_A, MODEL_B, MODEL_ORFAO]);
  });

  it('M-51: o model_list RE-LISTA todo modelo vivo, inclusive o que não tem filho', async () => {
    const db = new FakeDb();
    const { p, fresca, depois } = cenarioDeRepublish(db);
    const cliente = clienteFake({
      leituras: [fresca, depois],
      add: tierWrite([{ model_id: MODEL_NOVO, tier_index: [3] }]),
    });

    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    const corpo = cliente.corpoDe('updateTierVariation') as {
      readonly model_list: readonly { readonly model_id: number }[];
      readonly standardise_tier_variation: readonly {
        readonly variation_option_list: readonly { readonly variation_option_name: string }[];
      }[];
    };
    expect(corpo.model_list.map((m) => m.model_id)).toContain(MODEL_ORFAO);
    // A opção ocupada por um modelo sem filho permanece no conjunto enviado.
    expect(
      corpo.standardise_tier_variation[0]?.variation_option_list.map(
        (o) => o.variation_option_name,
      ),
    ).toEqual(['Azul', 'Preto', 'Verde', 'Vermelho']);
    expect(r.semFilho).toEqual([{ model_id: MODEL_ORFAO, model_sku: 'SKU-do-vendedor' }]);
  });

  it('M-52: add_model roda DEPOIS de update_tier_variation', async () => {
    const db = new FakeDb();
    const { p, fresca, depois } = cenarioDeRepublish(db);
    const cliente = clienteFake({
      leituras: [fresca, depois],
      add: tierWrite([{ model_id: MODEL_NOVO, tier_index: [3] }]),
    });

    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual([
      'getModelList',
      'updateTierVariation',
      'addModel',
      'getModelList',
    ]);
    const corpo = cliente.corpoDe('addModel') as {
      readonly model_list: readonly { readonly model_sku?: string }[];
    };
    expect(corpo.model_list.map((m) => m.model_sku)).toEqual(['SKU-v-vermelho']);
  });

  it('a posição de cada modelo casado é a NOSSA, e a do modelo sem filho é a dele', async () => {
    const db = new FakeDb();
    const { p, fresca, depois } = cenarioDeRepublish(db);
    const cliente = clienteFake({
      leituras: [fresca, depois],
      add: tierWrite([{ model_id: MODEL_NOVO, tier_index: [3] }]),
    });

    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.corpoDe('updateTierVariation')).toMatchObject({
      item_id: ITEM_ID,
      model_list: [
        { model_id: MODEL_A, tier_index: [0] },
        { model_id: MODEL_B, tier_index: [1] },
        { model_id: MODEL_ORFAO, tier_index: [2] },
      ],
    });
  });

  it('update_model entra só pelo sku divergente, e nunca leva preço nem estoque', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    semearVinculo(db, FILHO_A, 'v-a', { model_id: MODEL_A, tier_index: [0] });
    const fresca = arvore(
      ['Azul'],
      [{ model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-ANTIGO' }],
    );
    const cliente = clienteFake({ leituras: [fresca, fresca] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul')],
      linksDeVariacao: [vinculo(FILHO_A, 'v-a', MODEL_A, [0])],
    });
    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual([
      'getModelList',
      'updateTierVariation',
      'updateModel',
      'getModelList',
    ]);
    expect(cliente.corpoDe('updateModel')).toEqual({
      item_id: ITEM_ID,
      model: [{ model_id: MODEL_A, model_sku: 'SKU-v-azul' }],
    });
  });

  it('nada a mandar: UMA leitura só, e ela mesma serve de reconciliação', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    semearVinculo(db, FILHO_A, 'v-a', { model_id: MODEL_A, tier_index: [0] });
    const fresca = arvore(
      ['Azul'],
      [{ model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-v-azul' }],
    );
    const cliente = clienteFake({ leituras: [fresca] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul')],
      linksDeVariacao: [vinculo(FILHO_A, 'v-a', MODEL_A, [0])],
    });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual(['getModelList']);
    expect(r.acao).toBe('nenhuma');
    expect(r.atualizados).toBe(0);
    expect(r.criados).toBe(0);
  });

  it('uma mudança de PROFUNDIDADE cai no init, não no update', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    semearVinculo(db, FILHO_A, 'v-a', { model_id: MODEL_A, tier_index: [0, 0] });
    // Dois níveis vivos contra UM nosso.
    const fresca = shopeeModelListPayloadSchema.parse({
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        shopeeTierVariationSchema.parse({ name: 'Tam', option_list: [{ option: 'P' }] }),
      ],
      model: [{ model_id: MODEL_A, tier_index: [0, 0] }],
    });
    const depois = arvore(['Azul'], [{ model_id: MODEL_B, tier_index: [0] }]);
    const cliente = clienteFake({ leituras: [fresca, depois] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul', { linkDocId: 'v-a' })],
      linksDeVariacao: [vinculo(FILHO_A, 'v-a', MODEL_A, [0, 0])],
    });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual(['getModelList', 'initTierVariation', 'getModelList']);
    expect(r.acao).toBe('init');
    // O init invalidou o model_id: o vínculo é RE-APONTADO no lugar, nunca duplicado.
    expect(r.repontados).toBe(1);
    expect(docsEm(db, FILHO_A)).toHaveLength(1);
    expect(docsEm(db, FILHO_A)[0]?.model_id).toBe(MODEL_B);
    expect(docsEm(db, FILHO_A)[0]?.modeloAusenteEm).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                      (3) a sincronização dos vínculos                       */
/* -------------------------------------------------------------------------- */

describe('aplicarModelos — os vínculos de variação', () => {
  it('o vínculo cujo modelo desapareceu é MARCADO, e o patch é PLANO', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    semearVinculo(db, FILHO_A, 'v-a', { model_id: MODEL_A, tier_index: [0] });
    semearVinculo(db, FILHO_B, 'v-b', { model_id: MODEL_B, tier_index: [1] });
    const fresca = arvore(
      ['Azul', 'Preto'],
      [{ model_id: MODEL_A, tier_index: [0], model_sku: 'SKU-v-azul' }],
    );
    const cliente = clienteFake({ leituras: [fresca] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul')],
      linksDeVariacao: [
        vinculo(FILHO_A, 'v-a', MODEL_A, [0]),
        vinculo(FILHO_B, 'v-b', MODEL_B, [1]),
      ],
    });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(r.marcados).toBe(1);
    expect(r.desaparecidos).toEqual([{ produtoId: FILHO_B, modelId: MODEL_B }]);
    const patch = db.patches.find((x) => x.path.includes(FILHO_B))?.patch ?? {};
    expect(patch).toEqual({
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA,
    });
    for (const valor of Object.values(patch)) {
      expect(typeof valor === 'object' && valor !== null).toBe(false);
    }
  });

  it('o vínculo que mudou de POSIÇÃO é refrescado no lugar, nunca recriado', async () => {
    const db = new FakeDb();
    const { p, fresca, depois } = cenarioDeRepublish(db);
    const cliente = clienteFake({
      leituras: [fresca, depois],
      add: tierWrite([{ model_id: MODEL_NOVO, tier_index: [3] }]),
    });

    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    // O update_tier_variation mudou os modelos vivos para as NOSSAS posições, e
    // a leitura de reconciliação reporta as novas: os dois vínculos são
    // refrescados — no MESMO documento, com o model_id intacto.
    expect(r.atualizados).toBe(2);
    expect(r.marcados).toBe(0);
    expect(docsEm(db, FILHO_A)).toHaveLength(1);
    expect(docsEm(db, FILHO_A)[0]).toMatchObject({ model_id: MODEL_A, tier_index: [0] });
    expect(docsEm(db, FILHO_B)).toHaveLength(1);
    expect(docsEm(db, FILHO_B)[0]).toMatchObject({ model_id: MODEL_B, tier_index: [1] });
    // E o filho NOVO ganha o vínculo que ainda não existia, do modelo que o
    // add_model acabou de criar.
    expect(r.criados).toBe(1);
    expect(docsEm(db, FILHO_C)[0]?.model_id).toBe(MODEL_NOVO);
  });

  it('a conta do vínculo é filtrada: um vínculo de OUTRA conta não é tocado', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    semearVinculo(db, FILHO_A, 'v-a', {
      [INDICE_VARIACAO.campos[1]]: 'documents/integracao/outra',
      model_id: MODEL_B,
      tier_index: [9],
    });
    const fresca = arvore(['Azul'], [{ model_id: MODEL_A, tier_index: [0] }]);
    const cliente = clienteFake({ leituras: [fresca, fresca] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul')],
      linksDeVariacao: [],
    });
    await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(db.patches.filter((x) => x.path.endsWith('variashopee/v-a'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (4) o cruzamento, os avisos e as falhas                   */
/* -------------------------------------------------------------------------- */

describe('aplicarModelos — o eco da escrita nunca é a autoridade', () => {
  it('uma divergência de contagem no pareamento é UM console.warn, nunca um valor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0] },
            { model_id: MODEL_B, tier_index: [1] },
          ],
        ),
      ],
      // Mandamos DOIS modelos e a resposta pareou UM (a outra linha veio ilegível).
      init: tierWrite([{ model_id: MODEL_A, tier_index: [0] }, null]),
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    const linhas = warn.mock.calls.filter((c) => String(c[0]).includes('pareamento'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.[1]).toEqual({
      etapa: 'init_tier_variation',
      esperados: 2,
      recebidos: 1,
    });
    // O eco não decidiu nada: os dois vínculos saíram da leitura de reconciliação.
    expect(r.criados).toBe(2);
  });

  it('o warning do envelope é coletado no resultado, e o ruído da Shopee é descartado', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0] },
            { model_id: MODEL_B, tier_index: [1] },
          ],
        ),
      ],
      init: tierWrite([], 'model created with a deadline notice'),
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(r.avisos).toEqual(['model created with a deadline notice']);
  });

  it('⚠️ NEAR-MISS: "success" e "" são ruído e não entram nos avisos', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    const cliente = clienteFake({
      leituras: [arvore(['Azul'], [{ model_id: MODEL_A, tier_index: [0] }])],
      init: tierWrite([], 'success'),
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul')] });
    const r = await aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI);

    expect(r.avisos).toEqual([]);
  });

  it('⛔ uma falha da Shopee PROPAGA — nada aqui a engole', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A, FILHO_B);
    const erro = new Error('error_param: Model tier_index error');
    const cliente = clienteFake({
      leituras: [
        arvore(
          ['Azul', 'Preto'],
          [
            { model_id: MODEL_A, tier_index: [0] },
            { model_id: MODEL_B, tier_index: [1] },
          ],
        ),
      ],
      falhaEm: { op: 'initTierVariation', erro },
    });

    const p = plano({ filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto')] });
    await expect(aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI)).rejects.toBe(erro);

    expect(cliente.ops()).toEqual(['initTierVariation']);
    expect(docsEm(db, FILHO_A)).toEqual([]);
  });

  it('a árvore FRESCA que estoura o teto de opções BLOQUEIA antes de qualquer escrita', async () => {
    const db = new FakeDb();
    semearFilhos(db, FILHO_A);
    const nomes = Array.from({ length: SHOPEE_TIER_MAX_OPTIONS }, (_, i) => `Cor ${String(i)}`);
    const fresca = arvore(nomes, [{ model_id: MODEL_A, tier_index: [0] }]);
    const cliente = clienteFake({ leituras: [fresca, fresca] });

    const p = plano({
      ehAtualizacao: true,
      link: LINK,
      linkDocId: LINK_PAI,
      filhos: [filho(FILHO_A, 'v-azul')],
      linksDeVariacao: [],
    });

    await expect(aplicarModelos(deps(db, cliente), p, ITEM_ID, LINK_PAI)).rejects.toBeInstanceOf(
      ShopeePublishBlockedError,
    );
    expect(cliente.ops()).toEqual(['getModelList']);
    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (5) o leg que não precisa rodar                      */
/* -------------------------------------------------------------------------- */

describe('aplicarModelos — quando não há leg nenhum', () => {
  it('sem filhos e sem vínculos armazenados: ZERO chamadas à Shopee e ZERO escritas', async () => {
    const db = new FakeDb();
    const cliente = clienteFake({});

    const r = await aplicarModelos(deps(db, cliente), plano(), ITEM_ID, LINK_PAI);

    expect(cliente.ops()).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(r).toEqual({
      acao: 'nenhuma',
      total: 0,
      criados: 0,
      repontados: 0,
      atualizados: 0,
      marcados: 0,
      semFilho: [],
      desaparecidos: [],
      ignorados: 0,
      avisos: [],
      passos: [],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         (6) padronizadasDeTiers                            */
/* -------------------------------------------------------------------------- */

describe('padronizadasDeTiers — a projeção mecânica', () => {
  it('manda variation_id sempre; variation_name e variation_group_id só quando existem', () => {
    const projetado = padronizadasDeTiers([
      {
        grupoId: 'g-1',
        variation_id: 0,
        variation_group_id: null,
        variation_name: 'Cor',
        opcoes: [
          {
            varianteId: 'v-1',
            variation_option_id: 0,
            variation_option_name: 'Azul',
            image_id: null,
            ocupadaPorModeloSemFilho: false,
          },
        ],
      },
      {
        grupoId: 'g-2',
        variation_id: 100026,
        variation_group_id: 7,
        variation_name: null,
        opcoes: [
          {
            varianteId: 'v-2',
            variation_option_id: 4,
            variation_option_name: 'P',
            image_id: 'img-op',
            ocupadaPorModeloSemFilho: false,
          },
        ],
      },
    ]);

    expect(projetado).toEqual([
      {
        variation_id: 0,
        variation_name: 'Cor',
        variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Azul' }],
      },
      {
        variation_id: 100026,
        variation_group_id: 7,
        variation_option_list: [
          { variation_option_id: 4, variation_option_name: 'P', image_id: 'img-op' },
        ],
      },
    ]);
    expect('variation_group_id' in (projetado[0] ?? {})).toBe(false);
    expect('variation_name' in (projetado[1] ?? {})).toBe(false);
  });

  it('⚠️ variation_option_id 0 é um VALOR e vai sempre — é o sentinela de opção custom', () => {
    const projetado = padronizadasDeTiers([
      {
        grupoId: 'g-1',
        variation_id: 0,
        variation_group_id: null,
        variation_name: 'Cor',
        opcoes: [
          {
            varianteId: null,
            variation_option_id: 0,
            variation_option_name: 'Azul',
            image_id: null,
            ocupadaPorModeloSemFilho: true,
          },
        ],
      },
    ]);

    expect(projetado[0]?.variation_option_list[0]).toEqual({
      variation_option_id: 0,
      variation_option_name: 'Azul',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                   (7) C10 — UMA sincronização, importada                    */
/* -------------------------------------------------------------------------- */

describe('modelosPublicacao.ts — a disciplina do arquivo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./modelosPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('importa sincronizarLinksDeVariacao e NÃO declara nenhuma função sincronizar*', () => {
    expect(fonte).toContain("import { sincronizarLinksDeVariacao } from './linkAnuncio'");
    expect(/\bfunction\s+sincronizar/.exec(fonte)).toBeNull();
    expect(/\bconst\s+sincronizar\w*\s*=/.exec(fonte)).toBeNull();
  });

  it('chama a sincronização UMA vez, em um único lugar', () => {
    const chamadas = fonte.match(/sincronizarLinksDeVariacao\(/g) ?? [];
    expect(chamadas).toHaveLength(1);
  });

  it('não declara nenhum relógio nem espera — os dois são do publicador', () => {
    expect(/Date\.now\(|setTimeout\(/.exec(fonte)).toBeNull();
    expect(fonte).not.toContain('esperar(');
  });
});

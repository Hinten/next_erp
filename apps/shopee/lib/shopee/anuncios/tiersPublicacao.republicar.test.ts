/**
 * #2043, end to end: a grupo whose STORED binding entry is STANDARD and no
 * longer matches the live tier is refused by the publish's model leg — after
 * `update_item`, stamped, and with no tier or model write sent.
 *
 * The publisher twin of `publicarAnuncio.test.ts`'s Q2 case (a CUSTOM tier
 * that does not pair by name). It lives in its own file because the stack it
 * landed on had not merged #2015, which owns that suite (#1911 batch C,
 * reconcile §0's contingency). The doubles below are a trimmed copy of that
 * suite's: an in-memory Firestore, a `ShopeeClient` answering only what an
 * UPDATE may call, and the deps a publish takes. Invented ids only — never a
 * real partner, shop, item or buyer.
 *
 * The unit-level pairs and near-misses are `tiersPublicacao.test.ts` (2c-bis).
 *
 * #1911 P14b (Q1) adds the same end-to-end shape for the per-variante refusal of
 * an APPEND under a STANDARD entry paired by name with a live CUSTOM tier: it too
 * passes the plan (no live tree) and lands in the model leg, stamped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  shopeeLogisticsChannelSchema,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemWriteResponse,
  type ShopeeModelList,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  SHOPEE_ITEM_STATUS,
  SHOPEE_MODEL_STATUS,
  varianteFakePath,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { construirIndice } from '../taxonomia/categorias';
import { __setShopeeTaxonomiaClockForTests } from '../taxonomia/cache';
import { MOTIVO_PUBLICACAO_BLOQUEADA, ShopeePublishBlockedError } from './errosPublicacao';
import type { ResolvedorDeImagensShopee, ResultadoFotosPublicacao } from './fotosPublicacao';
import { planejarPublicacao } from './planoPublicacao';
import {
  aplicarPublicacao,
  prepararPublicacao,
  resolverFotosDaPublicacao,
  type PublicarAnuncioDeps,
} from './publicarAnuncio';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;

const PAI = 'prod-pai';
const FILHO = 'prod-filho-a';
const LINK_PAI = 'link-1';
const CAMINHO_LINK = `produtos/${PAI}/prodshopee/${LINK_PAI}`;

const GRUPO = 'grupo-cor';
const VARIANTE = 'var-azul';

const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const CATEGORIA = 100_017;
const CANAL = 90_003;
const TABELA_NORMAL = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';

const AGORA = 1_757_000_000_000;

/** Invented standard variations: the one the listing USES, and the one the operator re-bound to. */
const VARIACAO_VIVA = 77;
const VARIACAO_ARMAZENADA = 88;

function semearCatalogo(db: FakeDb): void {
  db.seed(`integracao/${INTEGRACAO}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: 987654,
  });
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

/**
 * The child, its stock, the LIVE link to the listing, its model link — and the
 * grupo, whose STORED `(integração, categoria)` entry is STANDARD
 * `variationId`, binding the child's variante to option `optionId` (the row
 * named `nomeDaLinha`). The variante itself is always named «Azul». An entry's
 * `name` is the CATEGORY's label, kept distinct from the grupo's on purpose: the
 * #2043 sentence interpolates the grupo's.
 */
function semearAnuncioPadrao(
  db: FakeDb,
  variationId: number,
  optionId: number,
  nomeDaLinha = 'Azul',
): void {
  db.seed(`produtos/${FILHO}`, {
    nome: 'Camiseta básica branca P',
    sku: 'CAM-BR-P',
    paiId: PAI,
    ordem: 1,
    variacoesUid: [varianteFakePath(GRUPO, VARIANTE)],
    precos: { [TABELA_NORMAL]: { valor: 49.9 } },
    fotos: [],
  });
  db.seed(`produtos/${FILHO}/estoques/est-filho`, {
    depositoOuterRef: DEPOSITO,
    quantidade: 7,
    quantidadeReservada: 0,
  });
  db.seed(`grupoDeVariacoes/${GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    permiteFotos: false,
    variacoes: [{ id: VARIANTE, nome: 'Azul' }],
    linksVariacoesShopee: [
      {
        name: 'Camisetas',
        category_id: CATEGORIA,
        variation_id: variationId,
        variation_group_list: 0,
        integracaoShopeeId: INTEGRACAO,
        variationOptions: [
          {
            shopee_option_id: optionId,
            shopee_option_name: nomeDaLinha,
            arakene_variation_id: [VARIANTE],
          },
        ],
      },
    ],
  });
  db.seed(CAMINHO_LINK, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta básica branca',
    item_id: ITEM_ID,
    category_id: CATEGORIA,
    brand_id: 0,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  });
  db.seed(`produtos/${FILHO}/variashopee/v-1`, {
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: `documents/${CAMINHO_LINK}`,
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
  });
}

function patchesDoLink(db: FakeDb): Record<string, unknown>[] {
  return db.writes
    .filter((w) => w.path.startsWith(`produtos/${PAI}/prodshopee/`))
    .map((w) => w.patch);
}

/* ------------------------------ the wire doubles --------------------------- */

function ecoDeItem(): ShopeeItemWriteResponse {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning: null,
    response: { item_id: ITEM_ID, item_status: SHOPEE_ITEM_STATUS_WRITABLE.unlist },
  } as unknown as ShopeeItemWriteResponse;
}

/**
 * The FRESH `get_model_list`: the listing's ONE tier is STANDARD
 * {@link VARIACAO_VIVA}, option 5 at [0], one model on it. By default its sku
 * DIVERGES from ours, so a paired leg has real work (`update`) rather than
 * answering `nenhuma`.
 */
function arvoreViva(modelSku = 'CAM-BR-P-ANTIGO', nomeDaOpcao = 'Azul'): ShopeeModelList {
  return {
    tier_variation: [{ name: 'Cor', option_list: [{ option: nomeDaOpcao }] }],
    standardise_tier_variation: [
      {
        variation_id: VARIACAO_VIVA,
        variation_name: 'Cor',
        variation_option_list: [{ variation_option_id: 5, variation_option_name: nomeDaOpcao }],
      },
    ],
    model: [
      {
        model_id: MODEL_A,
        tier_index: [0],
        model_status: SHOPEE_MODEL_STATUS.normal,
        model_sku: modelSku,
      },
    ],
  } as unknown as ShopeeModelList;
}

function baseInfo(): ShopeeItemBaseInfo {
  return {
    item_list: [
      {
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
      },
    ],
  } as unknown as ShopeeItemBaseInfo;
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

/** Every wire operation an UPDATE may reach, recorded in call order. */
function clienteDeAtualizacao(arvore: () => ShopeeModelList = () => arvoreViva()): {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly corposDeTier: readonly { readonly standardise_tier_variation: unknown }[];
} {
  const ops: string[] = [];
  const corposDeTier: { readonly standardise_tier_variation: unknown }[] = [];
  const vazio = { request_id: 'r', error: '', message: null, warning: null, response: {} };
  const registrar =
    <T>(nome: string, resposta: () => T) =>
    (): Promise<T> => {
      ops.push(nome);
      return Promise.resolve(resposta());
    };
  const client = {
    getItemLimit: registrar('get_item_limit', () => BANDAS_DA_LOJA),
    getAttributeTree: registrar('get_attribute_tree', () => ({ list: [] })),
    getChannelList: registrar('get_channel_list', () => ({
      logistics_channel_list: [CANAL_DA_LOJA],
    })),
    updateItem: registrar('update_item', ecoDeItem),
    getModelList: registrar('get_model_list', arvore),
    updateTierVariation: (corpo: { readonly standardise_tier_variation: unknown }) => {
      corposDeTier.push(corpo);
      return registrar('update_tier_variation', () => vazio)();
    },
    initTierVariation: registrar('init_tier_variation', () => vazio),
    addModel: registrar('add_model', () => vazio),
    updateModel: registrar('update_model', () => vazio),
    getItemBaseInfo: registrar('get_item_base_info', baseInfo),
  } as unknown as ShopeeClient;
  return { client, ops, corposDeTier };
}

/* ----------------------------- photos and deps ---------------------------- */

function resolvedorFake(): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos, op) => {
      const ids = op?.cap === 1 ? ['img-opcao-1'] : ['img-1', 'img-2'];
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
      enviadas: 2,
      falhas: 0,
      descartadasPeloLimite: 0,
    }),
  };
}

const INDICE = construirIndice([
  { category_id: CATEGORIA, parent_category_id: 0, has_children: false } as never,
]);

function deps(db: FakeDb, client: ShopeeClient, ops: string[]): PublicarAnuncioDeps {
  return {
    db: asDb(db),
    client,
    partnerClient: () => {
      throw new Error('fixture: o partner client só é usado pelo resolvedor de imagens');
    },
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: `documents/listaDePrecos/${TABELA_NORMAL}`,
    depositoOuterRef: DEPOSITO,
    operacaoOuterRef: null,
    nowMs: AGORA,
    esperar: (ms: number) => {
      ops.push(`esperar:${String(ms)}`);
      return Promise.resolve();
    },
    taxonomia: { integracaoId: INTEGRACAO, client, variationsPath: SHOPEE_GET_VARIATIONS_PATH },
    categorias: { carregar: () => Promise.resolve(INDICE) },
    aoVivo: {
      agora: () => AGORA,
      prazoDaRequisicao: null,
      aquecerCredencial: () => Promise.resolve(),
      confirmarSegundoAnuncio: false,
      confirmarCriacaoIncerta: false,
    },
  };
}

/** preparar → fotos → planejar → aplicar, the sequence `publicarAnuncioShopee` runs. */
async function republicar(db: FakeDb, client: ShopeeClient, ops: string[]): Promise<unknown> {
  const d = deps(db, client, ops);
  const contexto = await prepararPublicacao(
    d,
    { produtoId: PAI, categoryId: CATEGORIA, statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal },
    resolvedorFake(),
  );
  if (contexto === null) throw new Error('fixture: o contexto não deveria ser nulo');
  const plano = planejarPublicacao(contexto, await resolverFotosDaPublicacao(contexto));
  expect(plano.ehAtualizacao).toBe(true);
  return aplicarPublicacao(d, plano).then(
    () => null,
    (e: unknown) => e,
  );
}

const ESCRITAS_DE_TIER_E_MODELO = [
  'update_tier_variation',
  'init_tier_variation',
  'update_model',
  'add_model',
] as const;

beforeEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  The twin                                                                  */
/* -------------------------------------------------------------------------- */

describe('republicar — #2043: um tier PADRÃO armazenado que não casa com o tier vivo', () => {
  it('⚠️ é recusado DEPOIS do update_item, com a frase do vínculo, carimbado — e o leg de modelos não manda NADA', async () => {
    // The operator re-bound the grupo to standard variation 88 while the live
    // tier is 77. Only a stored entry carrying 77 claims it, so the grupo is
    // unpaired; the live model is addressable and the depth is unchanged, so the
    // leg would rewrite the tier IN PLACE and re-code the live model's option.
    const db = new FakeDb();
    semearCatalogo(db);
    semearAnuncioPadrao(db, VARIACAO_ARMAZENADA, 9);
    const { client, ops } = clienteDeAtualizacao();

    const err = await republicar(db, client, ops);

    expect(err).toBeInstanceOf(ShopeePublishBlockedError);
    const esperado = {
      campo: 'standardise_tier_variation',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
      // S3, with the ending #1911 P14b decided (P14a Q5): swap the binding or remove it.
      mensagem:
        'O vínculo do grupo "Cor" usa a variação padronizada 88, que nenhum tier do anúncio tem — republicar reescreveria as opções. Corrija o vínculo em Variações (aba Shopee): troque-o pela variação que o anúncio usa ou remova-o.',
    };
    expect((err as ShopeePublishBlockedError).problemas).toEqual([esperado]);

    expect(ops).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'update_item',
      'get_model_list',
    ]);
    for (const escrita of ESCRITAS_DE_TIER_E_MODELO) {
      expect(ops, escrita).not.toContain(escrita);
    }
    const carimbo = patchesDoLink(db).at(-1)?.falhaPublicacao as Record<string, unknown>;
    expect(carimbo).toMatchObject({ em: AGORA, erro: 'ShopeePublishBlockedError' });
    expect(carimbo.problemas).toEqual([esperado]);
  });

  it('⛔ par: a entrada armazenada 77, o MESMO tier vivo, casa — e o leg segue para update_tier_variation', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearAnuncioPadrao(db, VARIACAO_VIVA, 5);
    const { client, ops } = clienteDeAtualizacao();

    const err = await republicar(db, client, ops);

    expect(err).toBeNull();
    expect(ops.slice(0, 7)).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'update_item',
      'get_model_list',
      'update_tier_variation',
      'update_model',
    ]);
  });
});

describe('republicar — #1911 P14b (Q1): a entrada PADRÃO casada pelo NOME com o tier vivo CUSTOM', () => {
  /**
   * The FRESH `get_model_list` of a listing whose ONE tier is CUSTOM «Cor» (no
   * standard tree), option `nomeDaOpcao` at [0], the child's model on it — the sku
   * diverging, so a paired leg has real work.
   */
  function arvoreVivaPersonalizada(nomeDaOpcao: string): ShopeeModelList {
    return {
      tier_variation: [{ name: 'Cor', option_list: [{ option: nomeDaOpcao }] }],
      standardise_tier_variation: null,
      model: [
        {
          model_id: MODEL_A,
          tier_index: [0],
          model_status: SHOPEE_MODEL_STATUS.normal,
          model_sku: 'CAM-BR-P-ANTIGO',
        },
      ],
    } as unknown as ShopeeModelList;
  }

  it('⚠️ a variante «Azul», ligada à opção padrão 9 da entrada 88, contra a opção viva «Azul inventada»: o plano passa (sem árvore viva) e a recusa do ANEXO chega DEPOIS do update_item, carimbada — e o leg de modelos não manda NADA', async () => {
    // The live custom option is named otherwise than the variante, and no id-0 row
    // ties them, so the stored row would be APPENDED into the custom tier under 9
    // and the child's model moved onto it (#1911 P14b, Q1).
    const db = new FakeDb();
    semearCatalogo(db);
    semearAnuncioPadrao(db, VARIACAO_ARMAZENADA, 9);
    const { client, ops } = clienteDeAtualizacao(() => arvoreVivaPersonalizada('Azul inventada'));

    const err = await republicar(db, client, ops);

    expect(err).toBeInstanceOf(ShopeePublishBlockedError);
    const esperado = [
      {
        campo: 'standardise_tier_variation',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
        mensagem:
          'A variante "Azul" do grupo "Cor" não casa pelo nome com nenhuma opção do tier personalizado "Cor" do anúncio, e o vínculo do grupo usa a variação padronizada 88 — republicar acrescentaria uma opção e moveria o modelo. Renomeie a variante em Variações para o nome da opção do anúncio, ou mova as variações deste anúncio para outro grupo.',
      },
      {
        campo: 'model',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
        mensagem: `A variação ${FILHO} não tem posição no grupo "Cor" e o modelo não pode ser colocado.`,
      },
    ];
    expect((err as ShopeePublishBlockedError).problemas).toEqual(esperado);

    expect(ops).toEqual([
      'get_item_limit',
      'get_attribute_tree',
      'get_channel_list',
      'update_item',
      'get_model_list',
    ]);
    for (const escrita of ESCRITAS_DE_TIER_E_MODELO) {
      expect(ops, escrita).not.toContain(escrita);
    }
    const carimbo = patchesDoLink(db).at(-1)?.falhaPublicacao as Record<string, unknown>;
    expect(carimbo).toMatchObject({ em: AGORA, erro: 'ShopeePublishBlockedError' });
    expect(carimbo.problemas).toEqual(esperado);
  });

  it('⛔ par: a opção viva com o MESMO nome da variante («Azul») a reivindica pela dobra — nada é anexado, e o leg segue para update_tier_variation com a opção viva no índice dela', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    semearAnuncioPadrao(db, VARIACAO_ARMAZENADA, 9);
    const { client, ops, corposDeTier } = clienteDeAtualizacao(() =>
      arvoreVivaPersonalizada('Azul'),
    );

    expect(await republicar(db, client, ops)).toBeNull();

    expect(ops).toContain('update_tier_variation');
    expect(corposDeTier).toHaveLength(1);
    // Sent under the STORED 88 over the live option's id 0 — the caracterização
    // of tiersPublicacao.test.ts; Shopee's acceptance of that body is unmeasured.
    expect(corposDeTier[0]?.standardise_tier_variation).toEqual([
      expect.objectContaining({
        variation_id: VARIACAO_ARMAZENADA,
        variation_option_list: [
          expect.objectContaining({ variation_option_id: 0, variation_option_name: 'Azul' }),
        ],
      }),
    ]);
  });
});

describe('republicar — #1911 P14a (M1): o nome vivo só vai ao fio quando o leg de modelos manda o tier', () => {
  /** The stored row and the live tree name the option «Azul Turquesa»; the variante stays «Azul». */
  function semear(db: FakeDb): void {
    semearCatalogo(db);
    semearAnuncioPadrao(db, VARIACAO_VIVA, 5, 'Azul Turquesa');
  }

  it('⚠️ QUASE: sem divergência, o leg planeja `nenhuma` e NENHUM corpo de tier é enviado — `reconciliarModelos` nunca compara nomes de opção', async () => {
    const db = new FakeDb();
    semear(db);
    const { client, ops, corposDeTier } = clienteDeAtualizacao(() =>
      arvoreViva('CAM-BR-P', 'Azul Turquesa'),
    );

    expect(await republicar(db, client, ops)).toBeNull();

    expect(ops).not.toContain('update_tier_variation');
    expect(corposDeTier).toEqual([]);
  });

  it('⚠️ PAR: com o sku divergindo, o corpo do tier leva a opção sob o nome VIVO — nunca o da variante', async () => {
    const db = new FakeDb();
    semear(db);
    const { client, ops, corposDeTier } = clienteDeAtualizacao(() =>
      arvoreViva('CAM-BR-P-ANTIGO', 'Azul Turquesa'),
    );

    expect(await republicar(db, client, ops)).toBeNull();

    expect(ops).toContain('update_tier_variation');
    expect(corposDeTier).toHaveLength(1);
    expect(corposDeTier[0]?.standardise_tier_variation).toEqual([
      expect.objectContaining({
        variation_id: VARIACAO_VIVA,
        variation_option_list: [
          expect.objectContaining({
            variation_option_id: 5,
            variation_option_name: 'Azul Turquesa',
          }),
        ],
      }),
    ]);
  });
});

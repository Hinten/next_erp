import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  shopeeLogisticsChannelSchema,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, varianteFakePath } from '@delfrance/schemas';

import type { AtributosProjetados } from '../taxonomia/dto';
import type { LimitesDeItemDto, LimitesDeItemLidos } from '../taxonomia/limites';
import { RELIST_PRIMEIRO, ESPERA_APOS_ADD_ITEM_MS } from './constantesAnuncio';
import { MOTIVO_PUBLICACAO_BLOQUEADA } from './errosPublicacao';
import type {
  ResolvedorDeImagensShopee,
  ResultadoFotosPublicacao,
  ResumoFotosPublicacao,
} from './fotosPublicacao';
import type { LinkDeVariacao } from './linkAnuncio';
import type { LinkListagemLido, ProdutoParaPublicar } from './montagemAnuncio';
import {
  ORDEM_RELISTAGEM,
  type ContextoPublicacao,
  type FotosResolvidas,
  type PassoPublicacao,
  legDeModelosNecessario,
  passosDoLegDeModelos,
  planejarPublicacao,
  primeiroFilhoDoItem,
} from './planoPublicacao';
import { MOTIVO_TAX_INFO_OMITIDO } from './taxInfoPublicacao';
import type {
  FilhoParaPublicar,
  GrupoParaTier,
  ModeloMontado,
  PlanoDeModelos,
} from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ITEM_ID = 2500139861;
const CATEGORIA_FOLHA = 100017;
const CATEGORIA_DO_CORPO = 100099;
const TABELA_NORMAL = 'tab-normal';
const CANAL = 90003;
const PAI = 'prod-pai';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const GRUPO = 'g-cor';
const AGORA = 1_757_000_000_000;

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

function limites(bandas: Partial<LimitesDeItemDto> = {}): LimitesDeItemLidos {
  return {
    limites: { ...BANDAS, ...bandas },
    gtinLimit: { gtinValidationRule: 'Optional' },
    supportsPreOrder: true,
  };
}

const PRODUTO: ProdutoParaPublicar = {
  id: PAI,
  nome: 'Camiseta básica branca',
  sku: 'CAM-BR',
  gtin: '07891234567895',
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

function canal(parcial: Record<string, unknown> = {}): ShopeeLogisticsChannel {
  return shopeeLogisticsChannelSchema.parse({
    logistics_channel_id: CANAL,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
    ...parcial,
  });
}

const SEM_ATRIBUTOS: AtributosProjetados = { atributos: [], truncated: false };

/** One `linkVariacoesShopee` entry: a CUSTOM variation (`variation_id: 0`). */
function entradaDeGrupo(categoryId: number, integracaoShopeeId: string = INTEGRACAO): unknown {
  return {
    name: 'Cor',
    category_id: categoryId,
    variation_id: 0,
    variation_group_list: 0,
    integracaoShopeeId,
    variationOptions: [],
  };
}

/**
 * A grupo bound to this conta for BOTH categories the fixtures use — the
 * requested leaf and the one the stored link carries — so a create and a
 * republish of the same fixture differ only in the arm under test.
 */
function grupo(parcial: Partial<GrupoParaTier> = {}): GrupoParaTier {
  return {
    grupoId: GRUPO,
    nome: 'Cor',
    ordem: 1,
    permiteFotos: false,
    variacoes: [
      { varianteId: 'v-azul', nome: 'Azul', ordem: 1 },
      { varianteId: 'v-preto', nome: 'Preto', ordem: 2 },
    ],
    linksVariacoesShopee: [entradaDeGrupo(CATEGORIA_FOLHA), entradaDeGrupo(CATEGORIA_DO_CORPO)],
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
  category_id: CATEGORIA_DO_CORPO,
  brand_id: null,
  attributes: null,
  logistic_info: null,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
};

/**
 * A resolver that THROWS on every method.
 *
 * ⚠️ This is the whole proof that the plan is pure: the resolver is the one
 * async, Shopee-touching thing on the contexto, and reaching for it at plan time
 * is already the defect — whether or not the result is awaited.
 */
function resolvedorProibido(): ResolvedorDeImagensShopee {
  return {
    resolver: () => {
      throw new Error('o plano chamou o resolvedor de imagens');
    },
    resumo: () => {
      throw new Error('o plano leu o resumo do resolvedor');
    },
  };
}

const RESUMO: ResumoFotosPublicacao = {
  consideradas: 3,
  reutilizadas: 2,
  enviadas: 1,
  falhas: 0,
  descartadasPeloLimite: 0,
};

const PASSAGEM_DO_ITEM: ResultadoFotosPublicacao = {
  imageIds: ['img-1', 'img-2'],
  reutilizadas: 2,
  enviadas: 1,
  falhas: [],
  consideradas: 3,
  descartadasPeloLimite: 0,
};

function fotos(parcial: Partial<FotosResolvidas> = {}): FotosResolvidas {
  return { item: PASSAGEM_DO_ITEM, imagensDeOpcao: null, resumo: RESUMO, ...parcial };
}

function contexto(parcial: Partial<ContextoPublicacao> = {}): ContextoPublicacao {
  return {
    integracaoId: INTEGRACAO,
    produto: PRODUTO,
    descricao: DESCRICAO,
    filhos: [],
    grupos: [],
    link: null,
    linkDocId: null,
    linksDeVariacao: [],
    limites: limites(),
    atributos: SEM_ATRIBUTOS,
    veredictoFolha: 'folha',
    categoryId: CATEGORIA_FOLHA,
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

/** A create WITH children, everything else valid. */
function comFilhos(parcial: Partial<ContextoPublicacao> = {}): ContextoPublicacao {
  return contexto({
    grupos: [grupo()],
    filhos: [filho(FILHO_A, 'v-azul'), filho(FILHO_B, 'v-preto', { ordem: 2 })],
    ...parcial,
  });
}

function tipos(passos: readonly PassoPublicacao[]): readonly string[] {
  return passos.map((p) => p.tipo);
}

function planoDeModelos(parcial: Partial<PlanoDeModelos> = {}): PlanoDeModelos {
  return {
    acao: 'nenhuma',
    mudouProfundidade: false,
    modelList: [],
    novos: [],
    atualizarSku: [],
    modelosSemFilho: [],
    desaparecidos: [],
    ...parcial,
  };
}

function modeloMontado(produtoId: string, tierIndex: readonly number[]): ModeloMontado {
  return {
    produtoId,
    linkDocId: null,
    tier_index: tierIndex,
    original_price: 39.9,
    seller_stock: [{ stock: 5 }],
  };
}

/* -------------------------------------------------------------------------- */
/*                              (1) os passos                                 */
/* -------------------------------------------------------------------------- */

describe('planejarPublicacao — os passos são UMA derivação', () => {
  it('um create simples é fotos → add_item → leitura-de-volta, e mais nada', () => {
    const plano = planejarPublicacao(contexto(), fotos());

    expect(plano.problemas).toEqual([]);
    expect(tipos(plano.passos)).toEqual(['fotos', 'add_item', 'leitura-de-volta']);
    expect(plano.relistagem).toBeNull();
    expect(plano.temFilhos).toBe(false);
  });

  it('um create COM filhos espera entre o add_item e o leg, e planeja a relistagem', () => {
    const plano = planejarPublicacao(comFilhos(), fotos());

    expect(plano.problemas).toEqual([]);
    expect(tipos(plano.passos)).toEqual([
      'fotos',
      'add_item',
      'esperar',
      'init_tier_variation',
      'get_model_list',
      'relistagem',
      'leitura-de-volta',
    ]);
    expect(plano.passos[2]).toEqual({ tipo: 'esperar', ms: ESPERA_APOS_ADD_ITEM_MS });
  });

  it('um republish lê o get_model_list ANTES da chamada de tier, sem esperar e sem relistagem', () => {
    const plano = planejarPublicacao(
      comFilhos({ ehAtualizacao: true, link: LINK, linkDocId: 'link-1' }),
      fotos(),
    );

    const seq = tipos(plano.passos);
    expect(seq).toEqual([
      'fotos',
      'update_item',
      'get_model_list',
      'init_tier_variation',
      'get_model_list',
      'leitura-de-volta',
    ]);
    expect(seq).not.toContain('esperar');
    expect(seq).not.toContain('relistagem');
    expect(plano.itemId).toBe(ITEM_ID);
  });

  it('um plano BLOQUEADO carrega todos os problemas e nenhum passo além do diagnóstico', () => {
    const plano = planejarPublicacao(
      contexto({ produto: { ...PRODUTO, nome: '', pesoBrutoKg: null, pesoLiquidoKg: null } }),
      fotos(),
    );

    expect(plano.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.semNome,
      MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
    ]);
    expect(tipos(plano.passos)).toEqual(['fotos']);
  });

  it('os problemas saem na ordem: os do item e DEPOIS os dos tiers', () => {
    const plano = planejarPublicacao(
      comFilhos({
        produto: { ...PRODUTO, nome: '' },
        grupos: [grupo({ linksVariacoesShopee: [entradaDeGrupo(999999)] })],
      }),
      fotos(),
    );

    expect(plano.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.semNome,
      MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (2) o status inicial e a relistagem                    */
/* -------------------------------------------------------------------------- */

describe('planejarPublicacao — o status inicial de um create com filhos', () => {
  it('nasce UNLIST mesmo quando o operador pediu NORMAL', () => {
    const plano = planejarPublicacao(comFilhos(), fotos());

    expect(plano.statusPedido).toBe(SHOPEE_ITEM_STATUS_WRITABLE.normal);
    expect(plano.statusInicial).toBe(SHOPEE_ITEM_STATUS_WRITABLE.unlist);
    expect(plano.item.criar.item_status).toBe(SHOPEE_ITEM_STATUS_WRITABLE.unlist);
    expect(plano.passos[1]).toEqual({
      tipo: 'add_item',
      statusInicial: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    });
  });

  it('um create SEM filhos manda o status pedido direto e não planeja relistagem', () => {
    const plano = planejarPublicacao(contexto(), fotos());

    expect(plano.statusInicial).toBe(SHOPEE_ITEM_STATUS_WRITABLE.normal);
    expect(plano.relistagem).toBeNull();
  });

  it('⚠️ pedindo UNLIST, um create com filhos NÃO planeja relistagem', () => {
    const plano = planejarPublicacao(
      comFilhos({ statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.unlist }),
      fotos(),
    );

    expect(plano.statusInicial).toBe(SHOPEE_ITEM_STATUS_WRITABLE.unlist);
    expect(plano.relistagem).toBeNull();
    expect(tipos(plano.passos)).not.toContain('relistagem');
  });

  it('a ordem da relistagem é DERIVADA de RELIST_PRIMEIRO — nunca um segundo literal', () => {
    expect(ORDEM_RELISTAGEM).toHaveLength(2);
    expect(ORDEM_RELISTAGEM[0]).toBe(RELIST_PRIMEIRO === 'unlist' ? 'unlist' : 'update');
    expect([...ORDEM_RELISTAGEM].sort()).toEqual(['unlist', 'update']);

    const plano = planejarPublicacao(comFilhos(), fotos());
    expect(plano.relistagem).toEqual(ORDEM_RELISTAGEM);
    expect(plano.passos[5]).toEqual({ tipo: 'relistagem', ordem: ORDEM_RELISTAGEM });
  });
});

/* -------------------------------------------------------------------------- */
/*                        (3) passosDoLegDeModelos                            */
/* -------------------------------------------------------------------------- */

describe('passosDoLegDeModelos — a ONE derivação que o dry run e o aplicador leem', () => {
  it('a leitura fresca abre o leg só quando o chamador diz que leu', () => {
    const plano = planoDeModelos({ acao: 'init', novos: [modeloMontado(FILHO_A, [0])] });

    expect(tipos(passosDoLegDeModelos(plano, 1, false))).toEqual([
      'init_tier_variation',
      'get_model_list',
    ]);
    expect(tipos(passosDoLegDeModelos(plano, 1, true))).toEqual([
      'get_model_list',
      'init_tier_variation',
      'get_model_list',
    ]);
  });

  it('add_model existe só na ação update e sempre DEPOIS de update_tier_variation', () => {
    const plano = planoDeModelos({
      acao: 'update',
      modelList: [{ model_id: 2000458802, tier_index: [0] }],
      novos: [modeloMontado(FILHO_B, [1])],
    });

    expect(tipos(passosDoLegDeModelos(plano, 1, true))).toEqual([
      'get_model_list',
      'update_tier_variation',
      'add_model',
      'get_model_list',
    ]);
  });

  it('⚠️ na ação init os novos vão DENTRO do init — nunca um add_model separado', () => {
    const plano = planoDeModelos({
      acao: 'init',
      novos: [modeloMontado(FILHO_A, [0]), modeloMontado(FILHO_B, [1])],
    });

    const passos = passosDoLegDeModelos(plano, 1, false);
    expect(tipos(passos)).not.toContain('add_model');
    expect(passos[0]).toEqual({ tipo: 'init_tier_variation', tiers: 1, modelos: 2 });
  });

  it('update_model entra só quando há sku divergente, e carrega a contagem', () => {
    const plano = planoDeModelos({
      acao: 'update',
      modelList: [{ model_id: 2000458802, tier_index: [0] }],
      atualizarSku: [{ model_id: 2000458802, model_sku: 'SKU-NOVO' }],
    });

    const passos = passosDoLegDeModelos(plano, 1, true);
    expect(tipos(passos)).toEqual([
      'get_model_list',
      'update_tier_variation',
      'update_model',
      'get_model_list',
    ]);
    expect(passos[2]).toEqual({ tipo: 'update_model', modelos: 1 });
  });

  it('a ação nenhuma não emite chamada de tier nem leitura de reconciliação', () => {
    expect(passosDoLegDeModelos(planoDeModelos(), 0, false)).toEqual([]);
    expect(tipos(passosDoLegDeModelos(planoDeModelos(), 0, true))).toEqual(['get_model_list']);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (4) legDeModelosNecessario                           */
/* -------------------------------------------------------------------------- */

describe('legDeModelosNecessario — a ONE regra que abre (ou não) o leg', () => {
  const base = {
    integracaoId: INTEGRACAO,
    produtoPaiId: PAI,
    categoryId: CATEGORIA_DO_CORPO,
    grupos: [],
    bandaDeEstoque: null,
    imagensDeOpcao: null,
  } as const;

  it('sem filhos e sem vínculos armazenados o leg não é necessário', () => {
    expect(legDeModelosNecessario({ ...base, filhos: [], armazenados: [] })).toBe(false);
  });

  it('só um vínculo armazenado já basta — é ele que pode ter ficado órfão', () => {
    expect(
      legDeModelosNecessario({
        ...base,
        filhos: [],
        armazenados: [
          {
            produtoId: FILHO_A,
            linkDocId: 'v-1',
            modelId: 2000458802,
            modelSku: null,
            tierIndex: [0],
          },
        ],
      }),
    ).toBe(true);
  });

  it('só um filho já basta', () => {
    expect(
      legDeModelosNecessario({ ...base, filhos: [filho(FILHO_A, 'v-azul')], armazenados: [] }),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (5) a entrada que o aplicador re-roda                    */
/* -------------------------------------------------------------------------- */

describe('planejarPublicacao — modelosEntrada', () => {
  it('o categoryId vem do CORPO montado — a categoria do link vence a do pedido', () => {
    const plano = planejarPublicacao(
      comFilhos({
        ehAtualizacao: true,
        link: LINK,
        linkDocId: 'link-1',
        categoryId: CATEGORIA_FOLHA,
      }),
      fotos(),
    );

    expect(plano.item.criar.category_id).toBe(CATEGORIA_DO_CORPO);
    expect(plano.modelosEntrada.categoryId).toBe(CATEGORIA_DO_CORPO);
  });

  it('armazenados juntam o sku do FILHO — o vínculo não guarda model_sku', () => {
    const vinculo: LinkDeVariacao = {
      produtoId: FILHO_A,
      linkDocId: 'v-1',
      raw: {},
      modelId: 2000458802,
      tierIndex: [0],
      modelStatus: null,
      modeloAusenteEm: null,
    };
    const plano = planejarPublicacao(comFilhos({ linksDeVariacao: [vinculo] }), fotos());

    expect(plano.modelosEntrada.armazenados).toEqual([
      {
        produtoId: FILHO_A,
        linkDocId: 'v-1',
        modelId: 2000458802,
        modelSku: 'SKU-v-azul',
        tierIndex: [0],
      },
    ]);
  });

  it('⚠️ NEAR-MISS: um vínculo de um produto que NÃO está entre os filhos fica com sku null', () => {
    const vinculo: LinkDeVariacao = {
      produtoId: 'prod-filho-que-saiu',
      linkDocId: 'v-9',
      raw: {},
      modelId: 2000458809,
      tierIndex: [4],
      modelStatus: null,
      modeloAusenteEm: null,
    };
    const plano = planejarPublicacao(comFilhos({ linksDeVariacao: [vinculo] }), fotos());

    expect(plano.modelosEntrada.armazenados[0]?.modelSku).toBeNull();
  });

  it('um model_id armazenado inutilizável chega como 0 — o sentinela que ninguém vincula', () => {
    const vinculo: LinkDeVariacao = {
      produtoId: FILHO_A,
      linkDocId: 'v-1',
      raw: {},
      modelId: null,
      tierIndex: [],
      modelStatus: null,
      modeloAusenteEm: null,
    };
    const plano = planejarPublicacao(comFilhos({ linksDeVariacao: [vinculo] }), fotos());

    expect(plano.modelosEntrada.armazenados[0]?.modelId).toBe(0);
  });

  it('a banda de estoque vem de limites.limites.stockLimit', () => {
    const plano = planejarPublicacao(
      comFilhos({ limites: limites({ stockLimit: { min: 3, max: 900 } }) }),
      fotos(),
    );

    expect(plano.modelosEntrada.bandaDeEstoque).toEqual({ min: 3, max: 900 });
  });

  it('as imagens de opção atravessam a entrada sem serem reprojetadas', () => {
    const mapa = new Map([[varianteFakePath(GRUPO, 'v-azul'), 'img-op-1']]);
    const plano = planejarPublicacao(comFilhos(), fotos({ imagensDeOpcao: mapa }));

    expect(plano.modelosEntrada.imagensDeOpcao).toBe(mapa);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (6) o resto do plano, campo por campo                   */
/* -------------------------------------------------------------------------- */

describe('planejarPublicacao — os campos derivados', () => {
  it('taxInfoOmitido é o motivo do LEITOR quando ele recusou', () => {
    const plano = planejarPublicacao(
      contexto({ imposto: { imposto: null, motivo: MOTIVO_TAX_INFO_OMITIDO.semOperacao } }),
      fotos(),
    );

    expect(plano.taxInfoOmitido).toBe(MOTIVO_TAX_INFO_OMITIDO.semOperacao);
  });

  it('⚠️ NEAR-MISS: sem motivo do leitor, é o do MAPEADOR que fica', () => {
    const plano = planejarPublicacao(
      contexto({ imposto: { imposto: null, motivo: null } }),
      fotos(),
    );

    expect(plano.taxInfoOmitido).toBe(MOTIVO_TAX_INFO_OMITIDO.semImposto);
    expect('tax_info' in plano.item.criar).toBe(false);
  });

  it('o passo de fotos conta do RESUMO do publish, não da passagem do item', () => {
    const plano = planejarPublicacao(
      contexto(),
      fotos({
        resumo: { ...RESUMO, enviadas: 5, reutilizadas: 4 },
      }),
    );

    expect(plano.passos[0]).toEqual({ tipo: 'fotos', enviadas: 5, reutilizadas: 4 });
  });

  it('as falhas de foto vêm da passagem do ITEM e nunca bloqueiam o plano', () => {
    const falha = { arquivoId: 'arq-1', motivo: 'http' as const, mensagem: 'HTTP 502' };
    const plano = planejarPublicacao(
      contexto(),
      fotos({ item: { ...PASSAGEM_DO_ITEM, falhas: [falha] } }),
    );

    expect(plano.falhasDeFoto).toEqual([falha]);
    expect(plano.problemas).toEqual([]);
  });

  it('as imagens do item vão para o corpo na ORDEM em que chegaram', () => {
    const plano = planejarPublicacao(
      contexto(),
      fotos({ item: { ...PASSAGEM_DO_ITEM, imageIds: ['b', 'a', 'c'] } }),
    );

    expect(plano.item.criar.image).toEqual({ image_id_list: ['b', 'a', 'c'] });
  });

  it('nenhuma foto resolvida é um BLOQUEIO por sem-fotos, nunca uma exceção', () => {
    const plano = planejarPublicacao(
      contexto(),
      fotos({ item: { ...PASSAGEM_DO_ITEM, imageIds: [] } }),
    );

    expect(plano.problemas.map((p) => p.motivo)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semFotos);
  });

  it('um item_id armazenado não positivo vira null', () => {
    const plano = planejarPublicacao(contexto({ link: { ...LINK, item_id: 0 } }), fotos());
    expect(plano.itemId).toBeNull();
  });

  it('o plano NUNCA toca o resolvedor de imagens — ele é do aplicador', () => {
    expect(() => planejarPublicacao(comFilhos(), fotos())).not.toThrow();
  });

  it('o plano é a mesma resposta para a mesma entrada — nada de relógio nem de rede', () => {
    const ctx = comFilhos();
    const a = planejarPublicacao(ctx, fotos());
    const b = planejarPublicacao(ctx, fotos());

    expect(tipos(a.passos)).toEqual(tipos(b.passos));
    expect(a.item.criar).toEqual(b.item.criar);
    expect(a.modelos).toEqual(b.modelos);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (7) primeiroFilhoDoItem                            */
/* -------------------------------------------------------------------------- */

describe('primeiroFilhoDoItem — de quem sai o preço/estoque descartável', () => {
  it('a menor ordem vence, qualquer que seja a posição na lista', () => {
    const escolhido = primeiroFilhoDoItem([
      filho(FILHO_B, 'v-preto', { ordem: 7, preco: 10 }),
      filho(FILHO_A, 'v-azul', { ordem: 2, preco: 20 }),
    ]);

    expect(escolhido?.produtoId).toBe(FILHO_A);
  });

  it('⚠️ PAR/NEAR-MISS: empate na ordem desempata pelo id, e a ordem da lista não muda nada', () => {
    const a = filho('prod-a', 'v-azul', { ordem: 3 });
    const b = filho('prod-b', 'v-preto', { ordem: 3 });

    expect(primeiroFilhoDoItem([a, b])?.produtoId).toBe('prod-a');
    expect(primeiroFilhoDoItem([b, a])?.produtoId).toBe('prod-a');
  });

  it('uma lista vazia responde null', () => {
    expect(primeiroFilhoDoItem([])).toBeNull();
  });

  it('o preço e o estoque descartáveis do item saem desse filho', () => {
    const plano = planejarPublicacao(
      comFilhos({
        filhos: [
          filho(FILHO_B, 'v-preto', { ordem: 2, preco: 99.5, estoque: 11 }),
          filho(FILHO_A, 'v-azul', { ordem: 1, preco: 44.5, estoque: 4 }),
        ],
      }),
      fotos(),
    );

    expect(plano.item.criar.original_price).toBe(44.5);
    expect(plano.item.criar.seller_stock).toEqual([{ stock: 4 }]);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (8) o narrowing dos problemas                         */
/* -------------------------------------------------------------------------- */

describe('planejarPublicacao — o vocabulário de bloqueio', () => {
  it('todo problema do plano é um membro do vocabulário bloqueado, sem aviso nenhum', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const conhecidos = new Set<string>(Object.values(MOTIVO_PUBLICACAO_BLOQUEADA));

    const plano = planejarPublicacao(
      contexto({ produto: { ...PRODUTO, nome: '', precos: null } }),
      fotos(),
    );

    expect(plano.problemas.length).toBeGreaterThan(0);
    for (const problema of plano.problemas) expect(conhecidos.has(problema.motivo)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

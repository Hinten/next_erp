import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHOPEE_ITEM_IMAGE_MAX, SHOPEE_ITEM_STATUS_WRITABLE } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import type { AtributoDto, AtributosProjetados } from '../taxonomia/dto';
import type { LimitesDeItemDto, LimitesDeItemLidos } from '../taxonomia/limites';
import { MOTIVO_PUBLICACAO_BLOQUEADA, type ProblemaPublicacao } from './errosPublicacao';
import {
  type ArgsMontarAnuncio,
  type LinkListagemLido,
  type LogisticaParaMontar,
  type ProdutoParaPublicar,
  atributosParaPublicar,
  condicaoDoProduto,
  dimensaoParaPublicar,
  montarAnuncio,
  pesoParaPublicar,
  preOrderParaPublicar,
  quantidadeParaPublicarShopee,
} from './montagemAnuncio';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const ITEM_ID = 2500139861;
const CATEGORIA_FOLHA = 100017;
const TABELA_NORMAL = 'tab-normal';
const CANAL_NORMAL = 90003;
/** `announcement 1094` — the one channel that refuses `pre_order`. */
const CANAL_SEM_PRE_ORDER_ID = 90021;

const BANDAS: LimitesDeItemDto = {
  priceLimit: { min: 1, max: 1000 },
  wholesalePriceThresholdPercentage: null,
  /** The sandbox shop's measured minimum on 2026-09-17. */
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

function limites(
  bandas: Partial<LimitesDeItemDto> = {},
  extra: Partial<Omit<LimitesDeItemLidos, 'limites'>> = {},
): LimitesDeItemLidos {
  return {
    limites: { ...BANDAS, ...bandas },
    gtinLimit: { gtinValidationRule: 'Optional' },
    supportsPreOrder: true,
    ...extra,
  };
}

const PRODUTO: ProdutoParaPublicar = {
  id: 'prod-1',
  nome: 'Camiseta básica branca P',
  sku: 'CAM-BR-P',
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

function produto(over: Partial<ProdutoParaPublicar> = {}): ProdutoParaPublicar {
  return { ...PRODUTO, ...over };
}

const LINK: LinkListagemLido = {
  item_id: ITEM_ID,
  item_name: null,
  description: null,
  category_id: CATEGORIA_FOLHA,
  brand_id: null,
  attributes: null,
  logistic_info: null,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
};

function link(over: Partial<LinkListagemLido> = {}): LinkListagemLido {
  return { ...LINK, ...over };
}

const LOGISTICA: LogisticaParaMontar = {
  logistic_info: [{ logistic_id: CANAL_NORMAL, enabled: true, is_free: false }],
  canaisHabilitados: [CANAL_NORMAL],
  problemas: [],
};

const SEM_ATRIBUTOS: AtributosProjetados = { atributos: [], truncated: false };

function atributoObrigatorio(attributeId: number, name: string): AtributoDto {
  return { attributeId, mandatory: true, name, attributeInfo: null, attributeValueList: [] };
}

const DESCRICAO = 'Camiseta de algodão penteado, gola redonda, unissex.';

function args(over: Partial<ArgsMontarAnuncio> = {}): ArgsMontarAnuncio {
  return {
    produto: PRODUTO,
    descricao: DESCRICAO,
    link: null,
    limites: limites(),
    atributos: SEM_ATRIBUTOS,
    veredictoFolha: 'folha',
    categoryId: CATEGORIA_FOLHA,
    marca: { brandId: 1234, nome: 'Delfrance' },
    logistica: LOGISTICA,
    taxInfo: { taxInfo: null, omitido: 'sem-imposto' },
    imagens: ['img-1', 'img-2'],
    ehAtualizacao: false,
    statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    temFilhos: false,
    tabelaNormalId: TABELA_NORMAL,
    precoDoPrimeiroFilho: null,
    estoqueDoPrimeiroFilho: null,
    ownDisponivel: 7,
    disponivelByProdutoId: {},
    ...over,
  };
}

function motivos(problemas: readonly ProblemaPublicacao[]): readonly string[] {
  return problemas.map((p) => p.motivo);
}

/* -------------------------------------------------------------------------- */
/*                    (1) o corpo de CREATE, chave por chave                   */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — o corpo de add_item', () => {
  it('um produto completo sai como um add_item exato, na grafia do wire', () => {
    const montado = montarAnuncio(args());

    expect(montado.problemas).toEqual([]);
    expect(montado.criar).toEqual({
      item_name: 'Camiseta básica branca P',
      description: DESCRICAO,
      description_type: 'normal',
      original_price: 49.9,
      weight: 0.32,
      category_id: CATEGORIA_FOLHA,
      image: { image_id_list: ['img-1', 'img-2'] },
      logistic_info: [{ logistic_id: CANAL_NORMAL, enabled: true, is_free: false }],
      item_status: 'UNLIST',
      condition: 'NEW',
      dimension: { package_height: 3, package_width: 22, package_length: 30 },
      brand: { brand_id: 1234, original_brand_name: 'Delfrance' },
      item_sku: 'CAM-BR-P',
      gtin_code: '07891234567895',
      seller_stock: [{ stock: 7 }],
      pre_order: { is_pre_order: false },
    });
  });

  it('o seller_stock do item nunca carrega location_id — a estrutura é imutável por item', () => {
    const montado = montarAnuncio(args());
    expect(montado.criar.seller_stock).toEqual([{ stock: 7 }]);
    expect('location_id' in (montado.criar.seller_stock?.[0] ?? {})).toBe(false);
  });

  it('nenhum dos campos que o passo 11 nunca envia aparece no corpo', () => {
    const montado = montarAnuncio(args());
    const proibidos = [
      'wholesale',
      'size_chart_info',
      'scheduled_publish_time',
      'video_upload_id',
      'promotion_images',
      'complaint_policy',
      'item_dangerous',
      'description_info',
      'authorised_brand_id',
      'certification_info',
      'purchase_limit_info',
    ] as const;
    for (const chave of proibidos) {
      expect(chave in montado.criar).toBe(false);
    }
  });

  it('condition sai USED quando ehUsado e NEW quando não — em create E em update', () => {
    const usado = montarAnuncio(
      args({ produto: produto({ ehUsado: true }), link: link(), ehAtualizacao: true }),
    );
    expect(usado.criar.condition).toBe('USED');
    expect(usado.atualizar?.condition).toBe('USED');

    const novo = montarAnuncio(args({ link: link(), ehAtualizacao: true }));
    expect(novo.criar.condition).toBe('NEW');
    expect(novo.atualizar?.condition).toBe('NEW');
    expect(condicaoDoProduto(produto({ ehUsado: true }))).toBe('USED');
  });

  it('description_type é sempre normal — extended é whitelist e não é enviado', () => {
    const montado = montarAnuncio(args({ link: link(), ehAtualizacao: true }));
    expect(montado.criar.description_type).toBe('normal');
    expect(montado.atualizar?.description_type).toBe('normal');
  });
});

/* -------------------------------------------------------------------------- */
/*                       (2) o corpo de UPDATE — M-62                          */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — o corpo de update_item', () => {
  it('update nunca carrega item_status, original_price nem seller_stock', () => {
    const montado = montarAnuncio(args({ link: link(), ehAtualizacao: true }));
    const corpo = montado.atualizar;
    expect(corpo).not.toBeNull();
    expect('item_status' in (corpo ?? {})).toBe(false);
    expect('original_price' in (corpo ?? {})).toBe(false);
    expect('seller_stock' in (corpo ?? {})).toBe(false);
    // `pre_order` não existe na página do update — um republish não o move.
    expect('pre_order' in (corpo ?? {})).toBe(false);
  });

  it('o update carrega as TRÊS listas inteiras — attribute_list, image e logistic_info', () => {
    const montado = montarAnuncio(
      args({
        link: link({
          attributes: [{ attribute_id: 100, attribute_value_list: [{ value_id: 55 }] }],
        }),
        ehAtualizacao: true,
      }),
    );
    expect(montado.atualizar?.attribute_list).toEqual([
      { attribute_id: 100, attribute_value_list: [{ value_id: 55 }] },
    ]);
    expect(montado.atualizar?.image).toEqual({ image_id_list: ['img-1', 'img-2'] });
    expect(montado.atualizar?.logistic_info).toEqual(LOGISTICA.logistic_info);
  });

  it('atualizar é null quando nenhum item_id positivo é conhecido — nunca um item_id 0', () => {
    expect(montarAnuncio(args({ link: link({ item_id: null }) })).atualizar).toBeNull();
    expect(montarAnuncio(args({ link: link({ item_id: 0 }) })).atualizar).toBeNull();
    expect(montarAnuncio(args({ link: null })).atualizar).toBeNull();
    expect(montarAnuncio(args({ link: link() })).atualizar?.item_id).toBe(ITEM_ID);
  });
});

/* -------------------------------------------------------------------------- */
/*              (3) o vocabulário: um fixture por membro produzido             */
/* -------------------------------------------------------------------------- */

interface CasoDeRecusa {
  readonly motivo: string;
  readonly rotulo: string;
  readonly args: ArgsMontarAnuncio;
}

const RECUSAS: readonly CasoDeRecusa[] = [
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semNome,
    rotulo: 'nome em branco',
    args: args({ produto: produto({ nome: '   ' }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.nomeForaDaFaixa,
    rotulo: 'nome abaixo do mínimo da categoria',
    args: args({ produto: produto({ nome: 'Curto' }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
    rotulo: 'descrição ausente',
    args: args({ descricao: null }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.descricaoForaDaFaixa,
    rotulo: 'descrição abaixo do mínimo da categoria',
    args: args({ descricao: 'Curta demais' }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semPreco,
    rotulo: 'sem preço na tabela normal',
    args: args({ produto: produto({ precos: null }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
    rotulo: 'com filhos e o primeiro filho sem preço',
    args: args({ temFilhos: true, precoDoPrimeiroFilho: null }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa,
    rotulo: 'preço acima do máximo da categoria',
    args: args({ produto: produto({ precos: { [TABELA_NORMAL]: { valor: 5000 } } }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
    rotulo: 'sem peso bruto nem líquido',
    args: args({ produto: produto({ pesoBrutoKg: null, pesoLiquidoKg: null }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semDimensoes,
    rotulo: 'um eixo do pacote ausente',
    args: args({ produto: produto({ alturaCm: null }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semFotos,
    rotulo: 'nenhuma imagem resolvida',
    args: args({ imagens: [] }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.semGtin,
    rotulo: 'categoria com gtin_validation_rule Mandatory e produto sem GTIN',
    args: args({
      produto: produto({ gtin: null }),
      limites: limites({}, { gtinLimit: { gtinValidationRule: 'Mandatory' } }),
    }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.categoriaInvalida,
    rotulo: 'categoria que não é folha',
    args: args({ veredictoFolha: 'nao-folha' }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.atributoObrigatorio,
    rotulo: 'atributo obrigatório da categoria sem valor armazenado',
    args: args({
      atributos: { atributos: [atributoObrigatorio(100, 'Material')], truncated: false },
    }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.marcaSemNome,
    rotulo: 'brand_id não-zero sem nome resolvido, no CREATE',
    args: args({ marca: { brandId: 1234, nome: null } }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.estoqueAbaixoDoMinimo,
    rotulo: 'estoque disponível abaixo do min_limit da loja',
    args: args({ ownDisponivel: 1 }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
    rotulo: 'estadoAnuncio armazenado é removido',
    args: args({ link: link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
    rotulo: 'o produto tem pai',
    args: args({ produto: produto({ paiId: 'pai-1' }) }),
  },
  {
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
    rotulo: 'o produto é um kit',
    args: args({ produto: produto({ ehKit: true }) }),
  },
];

describe('montarAnuncio — o vocabulário de recusa', () => {
  it('o fixture completo não produz problema nenhum (sem isso, cada caso abaixo é vácuo)', () => {
    expect(montarAnuncio(args()).problemas).toEqual([]);
  });

  it.each(RECUSAS)('$motivo — $rotulo', ({ motivo, args: caso }) => {
    const montado = montarAnuncio(caso);
    expect(motivos(montado.problemas)).toContain(motivo);
  });

  it('percorre EXATAMENTE os dezoito membros que este módulo produz', () => {
    const cobertos = new Set(RECUSAS.map((c) => c.motivo));
    expect(cobertos.size).toBe(18);
    const outros = Object.values(MOTIVO_PUBLICACAO_BLOQUEADA).filter((m) => !cobertos.has(m));
    expect([...outros].sort()).toEqual([
      'combinacao-duplicada',
      'logistica-sem-canal',
      'opcoes-demais',
      'variacao-sem-vinculo',
    ]);
  });

  it('o docblock nomeia os quatro membros que este módulo NÃO produz, com o arquivo produtor', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./montagemAnuncio.ts', import.meta.url)), {
      encoding: 'utf8',
    });
    for (const membro of [
      'variacao-sem-vinculo',
      'combinacao-duplicada',
      'opcoes-demais',
      'logistica-sem-canal',
    ]) {
      expect(fonte).toContain(membro);
    }
    expect(fonte).toContain('anuncios/tiersPublicacao.ts');
    expect(fonte).toContain('anuncios/logisticaPublicacao.ts');
    expect(fonte).toContain('anuncios/problemasPublicacao.ts');
  });

  it('problemas é a UNIÃO de todas as recusas, nunca a primeira', () => {
    const montado = montarAnuncio(
      args({
        produto: produto({ nome: '  ', pesoBrutoKg: null, pesoLiquidoKg: null, alturaCm: null }),
        imagens: [],
      }),
    );
    expect(motivos(montado.problemas)).toEqual(
      expect.arrayContaining(['sem-nome', 'sem-peso', 'sem-dimensoes', 'sem-fotos']),
    );
  });

  it('os problemas da logística são RELAIADOS, não re-decididos', () => {
    const vindo: ProblemaPublicacao = {
      campo: 'logistic_info',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemCanal,
      mensagem: 'nenhum canal habilitado cabe no item',
    };
    const montado = montarAnuncio(
      args({ logistica: { ...LOGISTICA, logistic_info: [], problemas: [vindo] } }),
    );
    expect(montado.problemas).toContainEqual(vindo);
  });

  it('nenhuma mensagem de problema passa de 500 caracteres', () => {
    for (const caso of RECUSAS) {
      for (const p of montarAnuncio(caso.args).problemas) {
        expect(p.mensagem.length).toBeLessThanOrEqual(500);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                        (4) peso, dimensão, sku, gtin                        */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — peso e dimensão', () => {
  it('weight ausente vira problema sem-peso e nunca o 1 do legado', () => {
    const montado = montarAnuncio(
      args({ produto: produto({ pesoBrutoKg: null, pesoLiquidoKg: null }) }),
    );
    expect(motivos(montado.problemas)).toContain('sem-peso');
    expect(montado.criar.weight).not.toBe(1);
    expect(pesoParaPublicar(produto({ pesoBrutoKg: null, pesoLiquidoKg: null }))).toBeNull();
  });

  it('o peso bruto vence, mas um bruto ZERO cai no líquido utilizável', () => {
    expect(pesoParaPublicar(produto({ pesoBrutoKg: 0.9, pesoLiquidoKg: 0.2 }))).toBe(0.9);
    expect(pesoParaPublicar(produto({ pesoBrutoKg: 0, pesoLiquidoKg: 0.2 }))).toBe(0.2);
    expect(pesoParaPublicar(produto({ pesoBrutoKg: -1, pesoLiquidoKg: 0.2 }))).toBe(0.2);
  });

  it('dimensão usa EIXOS_PACOTE_SHOPEE_INVERSO e arredonda para CIMA', () => {
    const d = dimensaoParaPublicar(
      produto({ alturaCm: 10.2, larguraCm: 20.1, profundidadeCm: 30.9 }),
    );
    expect(d).toEqual({ package_height: 11, package_width: 21, package_length: 31 });
  });

  it('dimensão com um eixo nulo vira problema sem-dimensoes e nunca o 10 do legado', () => {
    expect(dimensaoParaPublicar(produto({ larguraCm: null }))).toBeNull();
    const montado = montarAnuncio(args({ produto: produto({ larguraCm: null }) }));
    expect(motivos(montado.problemas)).toContain('sem-dimensoes');
    expect('dimension' in montado.criar).toBe(false);
  });

  it('item_sku nulo é OMITIDO — nunca a string vazia, que DELETA no update', () => {
    const montado = montarAnuncio(
      args({ produto: produto({ sku: null }), link: link(), ehAtualizacao: true }),
    );
    expect('item_sku' in montado.criar).toBe(false);
    expect('item_sku' in (montado.atualizar ?? {})).toBe(false);

    const branco = montarAnuncio(args({ produto: produto({ sku: '   ' }) }));
    expect('item_sku' in branco.criar).toBe(false);
  });

  it('gtin_code só é enviado quando o produto tem um — nunca um placeholder no update', () => {
    const comGtin = montarAnuncio(args({ link: link(), ehAtualizacao: true }));
    expect(comGtin.criar.gtin_code).toBe('07891234567895');
    expect(comGtin.atualizar?.gtin_code).toBe('07891234567895');

    const sem = montarAnuncio(
      args({ produto: produto({ gtin: null }), link: link(), ehAtualizacao: true }),
    );
    expect('gtin_code' in sem.criar).toBe(false);
    expect('gtin_code' in (sem.atualizar ?? {})).toBe(false);
  });

  it('gtin ausente com regra Optional NÃO vira sem-gtin; com Mandatory vira', () => {
    const opcional = montarAnuncio(args({ produto: produto({ gtin: null }) }));
    expect(motivos(opcional.problemas)).not.toContain('sem-gtin');

    const ausente = montarAnuncio(
      args({ produto: produto({ gtin: null }), limites: limites({}, { gtinLimit: null }) }),
    );
    expect(motivos(ausente.problemas)).not.toContain('sem-gtin');

    const obrigatorio = montarAnuncio(
      args({
        produto: produto({ gtin: null }),
        limites: limites({}, { gtinLimit: { gtinValidationRule: 'Mandatory' } }),
      }),
    );
    expect(motivos(obrigatorio.problemas)).toContain('sem-gtin');
  });
});

/* -------------------------------------------------------------------------- */
/*                      (5) a banda de estoque — O3                            */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — a banda de estoque da loja', () => {
  it('um estoque de min - 1 vira estoque-abaixo-do-minimo e a mensagem nomeia a banda', () => {
    const montado = montarAnuncio(args({ ownDisponivel: 1 }));
    const achado = montado.problemas.find((p) => p.motivo === 'estoque-abaixo-do-minimo');
    expect(achado?.campo).toBe('seller_stock');
    expect(achado?.mensagem).toContain('2..1000000');
  });

  it('⚠️ NEAR-MISS: um estoque de min - 1 NUNCA é arredondado para o mínimo da banda', () => {
    const montado = montarAnuncio(args({ ownDisponivel: 1 }));
    expect(montado.criar.seller_stock).toEqual([{ stock: 1 }]);
    expect(
      quantidadeParaPublicarShopee({
        ehKit: false,
        ehKitVirtual: false,
        componentesKit: null,
        ownDisponivel: 1,
        disponivelByProdutoId: {},
        banda: { min: 2, max: 1_000_000 },
      }),
    ).toBe(1);
  });

  it('um estoque acima do máximo é limitado PARA BAIXO, sem problema nenhum', () => {
    const montado = montarAnuncio(
      args({ ownDisponivel: 1_000_001, limites: limites({ stockLimit: { min: 2, max: 10 } }) }),
    );
    expect(montado.criar.seller_stock).toEqual([{ stock: 10 }]);
    expect(motivos(montado.problemas)).not.toContain('estoque-abaixo-do-minimo');
  });

  it('o estoque descartável de um create COM filhos é no mínimo o min_limit da loja', () => {
    const zerado = montarAnuncio(
      args({ temFilhos: true, precoDoPrimeiroFilho: 19.9, estoqueDoPrimeiroFilho: 0 }),
    );
    expect(zerado.criar.seller_stock).toEqual([{ stock: 2 }]);
    expect(motivos(zerado.problemas)).not.toContain('estoque-abaixo-do-minimo');

    const cheio = montarAnuncio(
      args({ temFilhos: true, precoDoPrimeiroFilho: 19.9, estoqueDoPrimeiroFilho: 44 }),
    );
    expect(cheio.criar.seller_stock).toEqual([{ stock: 44 }]);
  });

  it('o preço do item de um create COM filhos é o do PRIMEIRO filho, descartável', () => {
    const montado = montarAnuncio(
      args({
        temFilhos: true,
        precoDoPrimeiroFilho: 19.9,
        estoqueDoPrimeiroFilho: 5,
        produto: produto({ precos: { [TABELA_NORMAL]: { valor: 999 } } }),
      }),
    );
    expect(montado.criar.original_price).toBe(19.9);
  });

  it('um republish não envia estoque, então não pode recusar por estoque', () => {
    const montado = montarAnuncio(args({ ownDisponivel: 0, link: link(), ehAtualizacao: true }));
    expect(motivos(montado.problemas)).not.toContain('estoque-abaixo-do-minimo');
  });

  it('uma banda sem stockLimit não tem mínimo — zero publica', () => {
    const montado = montarAnuncio(
      args({ ownDisponivel: 0, limites: limites({ stockLimit: null }) }),
    );
    expect(montado.criar.seller_stock).toEqual([{ stock: 0 }]);
    expect(motivos(montado.problemas)).not.toContain('estoque-abaixo-do-minimo');
  });
});

/* -------------------------------------------------------------------------- */
/*              (5b) as três recusas de preço são CREATE-only                  */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — o preço não recusa um update', () => {
  // ⚠️ `update_item` não carrega `original_price` (ponto 1 do docblock do módulo,
  // e `atualizar` não tem a chave), então recusar um update por preço tornava um
  // produto sem entrada na tabela normal da conta — um import do passo 9, um
  // `tabelaNormalOuterRef` em branco, um preço que mora em outra lista —
  // impossível de ATUALIZAR: nem descrição, nem fotos, nem o leg de tiers.
  it('PAR: um update sem preço nenhum não produz problema e não manda original_price', () => {
    const montado = montarAnuncio(
      args({ produto: produto({ precos: null }), link: link(), ehAtualizacao: true }),
    );
    expect(motivos(montado.problemas)).not.toContain('sem-preco');
    expect(montado.problemas).toEqual([]);
    expect(Object.keys(montado.atualizar ?? {})).not.toContain('original_price');
  });

  it('⚠️ NEAR-MISS: o MESMO produto sem preço ainda recusa um CREATE', () => {
    const montado = montarAnuncio(args({ produto: produto({ precos: null }) }));
    expect(motivos(montado.problemas)).toContain('sem-preco');
  });

  it('PAR: um update com preço fora da faixa da categoria não produz problema', () => {
    const montado = montarAnuncio(
      args({
        produto: produto({ precos: { [TABELA_NORMAL]: { valor: 5000 } } }),
        link: link(),
        ehAtualizacao: true,
      }),
    );
    expect(motivos(montado.problemas)).not.toContain('preco-fora-da-faixa');
    expect(Object.keys(montado.atualizar ?? {})).not.toContain('original_price');
  });

  it('⚠️ NEAR-MISS: o MESMO preço fora da faixa ainda recusa um CREATE', () => {
    const montado = montarAnuncio(
      args({ produto: produto({ precos: { [TABELA_NORMAL]: { valor: 5000 } } }) }),
    );
    expect(motivos(montado.problemas)).toContain('preco-fora-da-faixa');
  });

  it('PAR: filho-sem-preco também é create-only', () => {
    const atualizar = montarAnuncio(
      args({ temFilhos: true, precoDoPrimeiroFilho: null, link: link(), ehAtualizacao: true }),
    );
    expect(motivos(atualizar.problemas)).not.toContain('filho-sem-preco');

    // ⚠️ NEAR-MISS: o descartável do primeiro filho só existe no create, e lá ele
    // continua sendo obrigatório.
    const criar = montarAnuncio(args({ temFilhos: true, precoDoPrimeiroFilho: null }));
    expect(motivos(criar.problemas)).toContain('filho-sem-preco');
  });
});

/* -------------------------------------------------------------------------- */
/*                   (6) a quantidade ciente de kit — P2 §3.3                  */
/* -------------------------------------------------------------------------- */

describe('quantidadeParaPublicarShopee', () => {
  const componentes = {
    'comp-a': { quantidade: 2, limitarEstoque: true },
    'comp-b': { quantidade: 1, limitarEstoque: true },
  } as unknown as ProdutoParaPublicar['componentesKit'];

  it('um kit usa o mínimo dos componentes e NÃO soma o estoque próprio', () => {
    expect(
      quantidadeParaPublicarShopee({
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: componentes,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
        banda: null,
      }),
    ).toBe(4);
  });

  it('um kit VIRTUAL toma o MESMO ramo — nunca null e nunca o estoque próprio', () => {
    expect(
      quantidadeParaPublicarShopee({
        ehKit: false,
        ehKitVirtual: true,
        componentesKit: componentes,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 5 },
        banda: null,
      }),
    ).toBe(4);
  });

  it('um kit sem componente que limite cai no estoque próprio', () => {
    expect(
      quantidadeParaPublicarShopee({
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: null,
        ownDisponivel: 6,
        disponivelByProdutoId: {},
        banda: null,
      }),
    ).toBe(6);
  });

  it('um componente sem estoque resolvível conta ZERO (#238), não é ignorado', () => {
    expect(
      quantidadeParaPublicarShopee({
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: componentes,
        ownDisponivel: 100,
        disponivelByProdutoId: { 'comp-a': 9 },
        banda: null,
      }),
    ).toBe(0);
  });

  it('o resultado é inteiro e nunca negativo', () => {
    expect(
      quantidadeParaPublicarShopee({
        ehKit: false,
        ehKitVirtual: false,
        componentesKit: null,
        ownDisponivel: -4,
        disponivelByProdutoId: {},
        banda: null,
      }),
    ).toBe(0);
    expect(
      quantidadeParaPublicarShopee({
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: componentes,
        ownDisponivel: 0,
        disponivelByProdutoId: { 'comp-a': 9, 'comp-b': 9 },
        banda: null,
      }),
    ).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*                             (7) pre_order                                   */
/* -------------------------------------------------------------------------- */

describe('preOrderParaPublicar', () => {
  it('pre_order só é true acima de non_pre_order_days_to_ship', () => {
    expect(preOrderParaPublicar(3, limites(), [CANAL_NORMAL])).toEqual({ is_pre_order: false });
    expect(preOrderParaPublicar(7, limites(), [CANAL_NORMAL])).toEqual({
      is_pre_order: true,
      days_to_ship: 7,
    });
  });

  it('⚠️ PAR: pre_order é false quando um canal habilitado é 90021 (announcement 1094)', () => {
    expect(preOrderParaPublicar(7, limites(), [CANAL_NORMAL, CANAL_SEM_PRE_ORDER_ID])).toEqual({
      is_pre_order: false,
    });
  });

  it('⚠️ NEAR-MISS: pre_order permanece true quando o canal habilitado é 90003 e não 90021', () => {
    expect(preOrderParaPublicar(7, limites(), [CANAL_NORMAL])).toEqual({
      is_pre_order: true,
      days_to_ship: 7,
    });
  });

  it('supportsPreOrder false e um crossdocking fora da faixa recusam a pré-venda', () => {
    expect(preOrderParaPublicar(7, limites({}, { supportsPreOrder: false }), [])).toEqual({
      is_pre_order: false,
    });
    expect(preOrderParaPublicar(90, limites(), [])).toEqual({ is_pre_order: false });
    expect(preOrderParaPublicar(null, limites(), [])).toEqual({ is_pre_order: false });
  });

  it('days_to_ship é OMITIDO quando is_pre_order é false', () => {
    const resultado = preOrderParaPublicar(null, limites(), []);
    expect('days_to_ship' in resultado).toBe(false);
  });

  it('o canal 90021 derruba a PRÉ-VENDA, nunca o canal', () => {
    const montado = montarAnuncio(
      args({
        produto: produto({ crossdocking: 7 }),
        logistica: {
          logistic_info: [{ logistic_id: CANAL_SEM_PRE_ORDER_ID, enabled: true, is_free: false }],
          canaisHabilitados: [CANAL_SEM_PRE_ORDER_ID],
          problemas: [],
        },
      }),
    );
    expect(montado.criar.pre_order).toEqual({ is_pre_order: false });
    expect(montado.criar.logistic_info).toEqual([
      { logistic_id: CANAL_SEM_PRE_ORDER_ID, enabled: true, is_free: false },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              (8) atributos                                  */
/* -------------------------------------------------------------------------- */

describe('atributosParaPublicar', () => {
  it('atributo obrigatório ausente vira UM problema nomeando o atributo', () => {
    const montado = montarAnuncio(
      args({
        atributos: {
          atributos: [atributoObrigatorio(100, 'Material'), atributoObrigatorio(101, 'Gênero')],
          truncated: false,
        },
      }),
    );
    const achados = montado.problemas.filter((p) => p.motivo === 'atributo-obrigatorio');
    expect(achados).toHaveLength(1);
    expect(achados[0]?.mensagem).toContain('Material');
    expect(achados[0]?.mensagem).toContain('Gênero');
    expect(achados[0]?.campo).toBe('attribute_list');
  });

  it('valor customizado sai com value_id 0 e original_value_name', () => {
    const { lista } = atributosParaPublicar(
      [
        {
          attribute_id: 100,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão', value_unit: 'g' }],
        },
      ],
      SEM_ATRIBUTOS,
    );
    expect(lista).toEqual([
      {
        attribute_id: 100,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão', value_unit: 'g' }],
      },
    ]);
  });

  it('um value_id não-zero não leva original_value_name', () => {
    const { lista } = atributosParaPublicar(
      [{ attribute_id: 100, attribute_value_list: [{ value_id: 55, original_value_name: 'X' }] }],
      SEM_ATRIBUTOS,
    );
    expect(lista[0]?.attribute_value_list).toEqual([{ value_id: 55 }]);
  });

  it('um value_id 0 sem nome é DESCARTADO, e o atributo vazio não é enviado', () => {
    const { lista } = atributosParaPublicar(
      [{ attribute_id: 100, attribute_value_list: [{ value_id: 0 }] }],
      SEM_ATRIBUTOS,
    );
    expect(lista).toEqual([]);
  });

  it('um atributo com attribute_value_list vazia não é enviado — vazio DELETA na Shopee', () => {
    const { lista } = atributosParaPublicar(
      [{ attribute_id: 100, attribute_value_list: [] }, { attribute_id: 101 }, 'lixo', null],
      SEM_ATRIBUTOS,
    );
    expect(lista).toEqual([]);
  });

  it('⚠️ PAR: duas entradas com o MESMO attribute_id colapsam — a primeira vence', () => {
    const { lista } = atributosParaPublicar(
      [
        { attribute_id: 100, attribute_value_list: [{ value_id: 1 }] },
        { attribute_id: 100, attribute_value_list: [{ value_id: 2 }] },
      ],
      SEM_ATRIBUTOS,
    );
    expect(lista).toEqual([{ attribute_id: 100, attribute_value_list: [{ value_id: 1 }] }]);
  });

  it('⚠️ NEAR-MISS: 1 e 10 NÃO colapsam, e um attribute_id "100" em string é RECUSADO', () => {
    const { lista } = atributosParaPublicar(
      [
        { attribute_id: 1, attribute_value_list: [{ value_id: 1 }] },
        { attribute_id: 10, attribute_value_list: [{ value_id: 2 }] },
        { attribute_id: '100', attribute_value_list: [{ value_id: 3 }] },
      ],
      SEM_ATRIBUTOS,
    );
    expect(lista.map((a) => a.attribute_id)).toEqual([1, 10]);
  });

  it('um obrigatório sem nome é reportado pelo id, nunca em branco', () => {
    const { faltando } = atributosParaPublicar(null, {
      atributos: [
        {
          attributeId: 77,
          mandatory: true,
          name: null,
          attributeInfo: null,
          attributeValueList: [],
        },
      ],
      truncated: false,
    });
    expect(faltando).toEqual(['#77']);
  });
});

/* -------------------------------------------------------------------------- */
/*                                (9) brand                                    */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — brand', () => {
  it('brand_id 0 sai como No Brand, sem leitura nenhuma e sem problema', () => {
    const montado = montarAnuncio(args({ marca: { brandId: 0, nome: null } }));
    expect(montado.criar.brand).toEqual({ brand_id: 0, original_brand_name: 'No Brand' });
    expect(motivos(montado.problemas)).not.toContain('marca-sem-nome');
  });

  it('brand_id não-zero sem nome: problema no CREATE, brand OMITIDO no UPDATE', () => {
    const criar = montarAnuncio(args({ marca: { brandId: 1234, nome: null } }));
    expect(motivos(criar.problemas)).toContain('marca-sem-nome');
    expect('brand' in criar.criar).toBe(false);

    const atualizar = montarAnuncio(
      args({ marca: { brandId: 1234, nome: null }, link: link(), ehAtualizacao: true }),
    );
    expect(motivos(atualizar.problemas)).not.toContain('marca-sem-nome');
    expect('brand' in (atualizar.atualizar ?? {})).toBe(false);
  });

  it('o brand_id armazenado no link vence o resolvido pela cascata', () => {
    const montado = montarAnuncio(
      args({ link: link({ brand_id: 0 }), marca: { brandId: 1234, nome: 'Delfrance' } }),
    );
    expect(montado.criar.brand).toEqual({ brand_id: 0, original_brand_name: 'No Brand' });
  });
});

/* -------------------------------------------------------------------------- */
/*                             (10) tax_info                                   */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — tax_info', () => {
  it('tax_info omitido não apaga o bloco no update: a CHAVE está ausente, nunca null', () => {
    const montado = montarAnuncio(
      args({
        taxInfo: { taxInfo: null, omitido: 'sem-imposto' },
        link: link(),
        ehAtualizacao: true,
      }),
    );
    expect('tax_info' in montado.criar).toBe(false);
    expect('tax_info' in (montado.atualizar ?? {})).toBe(false);
  });

  it('um taxInfo ausente por completo também não põe a chave', () => {
    const montado = montarAnuncio(args({ taxInfo: null }));
    expect('tax_info' in montado.criar).toBe(false);
  });

  it('o bloco de dez membros vai INTEIRO nos dois corpos quando existe', () => {
    const bloco = {
      ncm: '61091000',
      cest: '2806400',
      origin: '0',
      csosn: '102',
      pis: '1.65',
      cofins: '7.60',
      pis_cofins_cst: '01',
      same_state_cfop: '5102',
      diff_state_cfop: '6102',
      measure_unit: 'UN',
    };
    const montado = montarAnuncio(
      args({ taxInfo: { taxInfo: bloco, omitido: null }, link: link(), ehAtualizacao: true }),
    );
    expect(montado.criar.tax_info).toEqual(bloco);
    expect(montado.atualizar?.tax_info).toEqual(bloco);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (11) nome/descrição: o link vence, em branco = ausente     */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — o que o link armazenado decide', () => {
  it('item_name e description do link vencem os do produto', () => {
    const montado = montarAnuncio(
      args({
        link: link({ item_name: 'Camiseta Premium Algodão Pima', description: 'A'.repeat(40) }),
      }),
    );
    expect(montado.criar.item_name).toBe('Camiseta Premium Algodão Pima');
    expect(montado.criar.description).toBe('A'.repeat(40));
  });

  it('⚠️ PAR: um item_name em branco, só com espaços ou null COLAPSAM em ausente', () => {
    for (const armazenado of [null, '', '   ', '\t\n']) {
      const montado = montarAnuncio(args({ link: link({ item_name: armazenado }) }));
      expect(montado.criar.item_name).toBe(PRODUTO.nome);
    }
  });

  it('⚠️ NEAR-MISS: espaços em volta são aparados, mas o CASE nunca é dobrado', () => {
    const montado = montarAnuncio(args({ link: link({ item_name: '  CAMISETA BÁSICA  ' }) }));
    expect(montado.criar.item_name).toBe('CAMISETA BÁSICA');
    expect(montado.criar.item_name).not.toBe('camiseta básica');
  });

  it('item_name fora da faixa vira problema — nunca truncado', () => {
    const longo = 'x'.repeat(200);
    const montado = montarAnuncio(args({ produto: produto({ nome: longo }) }));
    expect(motivos(montado.problemas)).toContain('nome-fora-da-faixa');
    expect(montado.criar.item_name).toBe(longo);
  });

  it('o category_id do link vence o categoryId do corpo da rota', () => {
    const montado = montarAnuncio(args({ link: link({ category_id: 999 }), categoryId: 111 }));
    expect(montado.criar.category_id).toBe(999);
  });

  it('⚠️ NEAR-MISS: um outerRef inteiro como tabelaNormalId não resolve preço nenhum', () => {
    const montado = montarAnuncio(
      args({ tabelaNormalId: `documents/listaDePrecos/${TABELA_NORMAL}` }),
    );
    expect(motivos(montado.problemas)).toContain('sem-preco');
    expect(montado.criar.original_price).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                              (12) imagens                                   */
/* -------------------------------------------------------------------------- */

describe('montarAnuncio — image_id_list', () => {
  it('a lista é limitada pelo menor entre SHOPEE_ITEM_IMAGE_MAX e a banda da categoria', () => {
    const doze = Array.from({ length: 12 }, (_v, i) => `img-${String(i)}`);
    const pelaBanda = montarAnuncio(
      args({ imagens: doze, limites: limites({ itemImageCountLimit: { min: 1, max: 4 } }) }),
    );
    expect(pelaBanda.criar.image.image_id_list).toEqual(doze.slice(0, 4));

    const pelaConstante = montarAnuncio(
      args({ imagens: doze, limites: limites({ itemImageCountLimit: null }) }),
    );
    expect(pelaConstante.criar.image.image_id_list).toHaveLength(SHOPEE_ITEM_IMAGE_MAX);
  });

  it('a ORDEM de entrada é preservada — a Shopee renderiza posicionalmente', () => {
    const montado = montarAnuncio(args({ imagens: ['c', 'a', 'b'] }));
    expect(montado.criar.image.image_id_list).toEqual(['c', 'a', 'b']);
  });
});

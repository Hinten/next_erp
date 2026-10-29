import { describe, expect, it } from 'vitest';

import { SHOPEE_ITEM_STATUS_WRITABLE } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, descreverFaixaShopee } from '@delfrance/schemas';

import type { LimitesDeItemDto } from '../taxonomia/limites';
import { MOTIVO_PUBLICACAO_BLOQUEADA, type ProblemaPublicacao } from './errosPublicacao';
import {
  type ArgsMontarAnuncio,
  type LinkListagemLido,
  type ProdutoParaPublicar,
  montarAnuncio,
} from './montagemAnuncio';

/**
 * `montarAnuncio`'s WIRING of the band check and text resolution that #1911 P2
 * moved to `@delfrance/schemas` (`faixaShopee.ts`). The functions themselves
 * are pinned there; this file pins that the publisher CALLS them on the inputs
 * it reads — a blank link description falls back to the produto's (the twin
 * of `montagemAnuncio.test.ts`'s `item_name` pair, which had none), and a
 * refusal's message prints the TRIMMED length and the band it was checked
 * against. A sibling file, so `montagemAnuncio.test.ts` stays the UNEDITED
 * neutrality proof of P2.
 */

const TABELA_NORMAL = 'tab-normal';
const CANAL_NORMAL = 90003;

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

const LINK: LinkListagemLido = {
  item_id: 2500139861,
  item_name: null,
  description: null,
  category_id: 100017,
  brand_id: null,
  attributes: null,
  logistic_info: null,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  kitNativo: false,
  marcaNaoEscolhida: false,
};

const DESCRICAO = 'Camiseta de algodão penteado, gola redonda, unissex.';

function args(over: Partial<ArgsMontarAnuncio> = {}): ArgsMontarAnuncio {
  return {
    produto: PRODUTO,
    descricao: DESCRICAO,
    link: null,
    limites: {
      limites: BANDAS,
      gtinLimit: { gtinValidationRule: 'Optional' },
      supportsPreOrder: true,
    },
    atributos: { atributos: [], truncated: false },
    veredictoFolha: 'folha',
    categoryId: 100017,
    marca: { brandId: 1234, nome: 'Delfrance' },
    logistica: {
      logistic_info: [{ logistic_id: CANAL_NORMAL, enabled: true, is_free: false }],
      canaisHabilitados: [CANAL_NORMAL],
      problemas: [],
    },
    taxInfo: { taxInfo: null, omitido: 'sem-imposto' },
    imagens: ['img-1', 'img-2'],
    ehAtualizacao: false,
    statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.unlist,
    temFilhos: false,
    tabelaNormalId: TABELA_NORMAL,
    precoDoPrimeiroFilho: null,
    precoDoPrimeiroFilhoVemDoPai: false,
    estoqueDoPrimeiroFilho: null,
    ownDisponivel: 7,
    disponivelByProdutoId: {},
    tabelaDeMedidas: { tipo: 'produto-sem-tabela' },
    imagemTabelaDeMedidas: null,
    ...over,
  };
}

function problemaDe(problemas: readonly ProblemaPublicacao[], motivo: string): ProblemaPublicacao {
  const achado = problemas.find((p) => p.motivo === motivo);
  expect(achado, `nenhum problema ${motivo}`).toBeDefined();
  return achado as ProblemaPublicacao;
}

describe('montarAnuncio — o nome: o veredito é sobre o título RESOLVIDO, não sobre o link cru', () => {
  it('⚠️ PAR: um item_name do link em branco não recusa por sem-nome — o corpo e o veredito leem o MESMO texto', () => {
    // `montagemAnuncio.test.ts` pina o CORPO deste caso; este pina o VEREDITO.
    for (const armazenado of [null, '', '   ', '\t\n']) {
      const montado = montarAnuncio(args({ link: { ...LINK, item_name: armazenado } }));
      expect(montado.criar.item_name).toBe(PRODUTO.nome);
      expect(montado.problemas.map((p) => p.motivo)).not.toContain(
        MOTIVO_PUBLICACAO_BLOQUEADA.semNome,
      );
    }
  });
});

describe('montarAnuncio — a descrição: o link vence, em branco = a do produto', () => {
  it('⚠️ PAR: uma description do link em branco, só com espaços ou null COLAPSA na do produto', () => {
    for (const armazenada of [null, '', '   ', '\t\n']) {
      const montado = montarAnuncio(args({ link: { ...LINK, description: armazenada } }));
      expect(montado.criar.description).toBe(DESCRICAO);
      expect(montado.problemas.map((p) => p.motivo)).not.toContain(
        MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
      );
    }
  });

  it('NEAR-MISS: uma description do link utilizável VENCE — aparada, nunca a do produto', () => {
    const montado = montarAnuncio(
      args({ link: { ...LINK, description: `  ${'B'.repeat(30)}  ` } }),
    );
    expect(montado.criar.description).toBe('B'.repeat(30));
  });
});

describe('montarAnuncio — a mensagem de uma recusa de faixa', () => {
  it('nome: imprime o comprimento APARADO e a faixa da categoria', () => {
    // 200 caracteres úteis entre espaços: o cru tem 204, o aparado 200.
    const montado = montarAnuncio(
      args({ produto: { ...PRODUTO, nome: `  ${'x'.repeat(200)}  ` } }),
    );
    const { mensagem } = problemaDe(montado.problemas, MOTIVO_PUBLICACAO_BLOQUEADA.nomeForaDaFaixa);
    expect(mensagem).toContain('o nome tem 200 caracteres');
    expect(mensagem).toContain(`(${descreverFaixaShopee(BANDAS.itemNameLengthLimit)})`);
    expect(mensagem).toContain('(10..120)');
  });

  it('descrição: imprime o comprimento APARADO e a faixa da categoria', () => {
    // 'Curta demais' = 12 úteis (16 cru), abaixo de 20.
    const montado = montarAnuncio(args({ descricao: '  Curta demais  ' }));
    const { mensagem } = problemaDe(
      montado.problemas,
      MOTIVO_PUBLICACAO_BLOQUEADA.descricaoForaDaFaixa,
    );
    expect(mensagem).toContain('a descrição tem 12 caracteres');
    expect(mensagem).toContain('(20..3000)');
  });

  it('preço: a mensagem nomeia a faixa da categoria', () => {
    const montado = montarAnuncio(
      args({ produto: { ...PRODUTO, precos: { [TABELA_NORMAL]: { valor: 5000 } } } }),
    );
    const { mensagem } = problemaDe(
      montado.problemas,
      MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa,
    );
    expect(mensagem).toContain('(1..1000)');
  });
});

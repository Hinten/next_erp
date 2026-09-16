import { describe, expect, it } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  shopeeModelSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { ShopeeImportBlockedError } from './errosImportacao';
import type { ItemLido } from './itemLido';
import {
  idCategoriaShopee,
  planejarImportacaoShopee,
  type PreparoFilhoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const AGORA = 1_757_000_000_000;

const PRECO_BRL = [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }];

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

function modelos(models: Record<string, unknown>[], tiers?: unknown) {
  return shopeeModelListPayloadSchema.parse({
    model: models,
    tier_variation: tiers ?? [
      { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
    ],
  });
}

function item(parcial: Record<string, unknown> = {}, models?: ItemLido['models']): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      category_id: 100017,
      ...parcial,
    }),
    models: models ?? null,
    taxInfo: null,
    kit: null,
    itemId: ITEM_ID,
  };
}

function filho(modelo: ShopeeModel, parcial: Partial<PreparoFilhoShopee> = {}): PreparoFilhoShopee {
  return {
    modelo,
    existente: null,
    vinculoDeOutraFamilia: false,
    link: null,
    estoque: null,
    ...parcial,
  };
}

function preparo(parcial: Partial<PreparoImportacaoShopee> = {}): PreparoImportacaoShopee {
  return {
    entrada: item({ price_info: PRECO_BRL }),
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-promo',
    depositoOuterRef: DEPOSITO,
    pai: {
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      estoque: null,
    },
    filhos: [],
    linkPai: null,
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
}

/* ------------------------- 1. as três recusas ----------------------------- */

describe('planejarImportacaoShopee — as recusas', () => {
  it('recusa um anúncio DELETADO antes de planejar qualquer coisa', () => {
    for (const status of ['SELLER_DELETE', 'SHOPEE_DELETE']) {
      const p = preparo({ entrada: item({ item_status: status }) });
      expect(() => planejarImportacaoShopee(p)).toThrow(ShopeeImportBlockedError);
      try {
        planejarImportacaoShopee(p);
      } catch (err) {
        if (!(err instanceof ShopeeImportBlockedError)) throw err;
        expect(err.motivo).toBe('item-deletado');
        expect(err.itemId).toBe(ITEM_ID);
      }
    }
  });

  it('recusa um `item_name` em branco — um produto sem nome não é um produto', () => {
    const p = preparo({ entrada: item({ item_name: '   ' }) });
    try {
      planejarImportacaoShopee(p);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeImportBlockedError)) throw err;
      expect(err.motivo).toBe('sem-nome');
    }
  });

  it('recusa um `prodshopee` que está sob um produto FILHO', () => {
    const p = preparo({
      pai: {
        existente: { id: 'f-1', raw: {} },
        extraData: null,
        linkSobFilho: true,
        jaTemFilhos: false,
        estoque: null,
      },
    });
    try {
      planejarImportacaoShopee(p);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeImportBlockedError)) throw err;
      expect(err.motivo).toBe('vinculo-inconsistente');
      expect(err.mensagem).toContain('prodshopee');
    }
  });

  it('recusa um `variashopee` que aponta para OUTRA família, nomeando o modelo', () => {
    const p = preparo({
      entrada: item({ has_model: true }, modelos([{ model_id: MODEL_ID, tier_index: [0] }])),
      filhos: [
        filho(shopeeModelSchema.parse({ model_id: MODEL_ID }), { vinculoDeOutraFamilia: true }),
      ],
    });
    try {
      planejarImportacaoShopee(p);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeImportBlockedError)) throw err;
      expect(err.motivo).toBe('vinculo-inconsistente');
      expect(err.mensagem).toContain(String(MODEL_ID));
    }
  });

  it('⛔ as recusas vêm ANTES de qualquer plano — nada parcial é devolvido', () => {
    // O contrato de que o job depende para conter um item bloqueado: nenhum
    // produto meio escrito, nenhum vínculo meio escrito, nenhum grupo órfão.
    const p = preparo({ entrada: item({ item_status: 'SELLER_DELETE' }) });
    expect(() => planejarImportacaoShopee(p)).toThrow();
  });
});

/* --------------------------- 2. a ORDEM de escrita ------------------------ */

describe('planejarImportacaoShopee — a ordem de escrita', () => {
  it('o plano enumera os passos NA ORDEM em que a wave 5 os executa', () => {
    const plano = planejarImportacaoShopee(preparo());
    const ordem = Object.keys(plano);
    const esperada = [
      'taxonomia',
      'categorias',
      'precosPai',
      'produtoPai',
      'extraData',
      'estoquePai',
      'linkPai',
      'filhos',
      'filhoUnico',
      'fotos',
    ];
    // Uma SEQUÊNCIA, não um conjunto: a posição de `precosPai` ANTES de
    // `produtoPai` é a que carrega o `lastUpdateTime` que o merge invalidaria.
    expect(ordem.filter((k) => esperada.includes(k))).toEqual(esperada);
  });

  it('o preço guardado do pai vem ANTES do merge do produto e é um caminho PONTILHADO', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        pai: {
          existente: { id: 'p-1', raw: {} },
          extraData: null,
          linkSobFilho: false,
          jaTemFilhos: false,
          estoque: null,
        },
      }),
    );
    expect(plano.precosPai).toEqual({
      produtoId: 'p-1',
      patch: { 'precos.tab-normal': { valor: 99.9 } },
    });
    // E o merge do produto NÃO carrega `precos` — o mapa legado nunca é revalidado.
    expect(plano.produtoPai?.data ?? {}).not.toHaveProperty('precos');
  });

  it('na CRIAÇÃO não há `precosPai` — o preço é dobrado no documento', () => {
    const plano = planejarImportacaoShopee(preparo());
    expect(plano.precosPai).toBeNull();
    expect(plano.produtoPai?.criar).toBe(true);
    expect(plano.produtoPai?.data.precos).toEqual({ 'tab-normal': { valor: 99.9 } });
  });
});

/* ------------------------ 3. criar vs atualizar --------------------------- */

describe('planejarImportacaoShopee — criar vs atualizar', () => {
  it('cria no id determinístico e `add`iona o vínculo do pai', () => {
    const plano = planejarImportacaoShopee(preparo());
    expect(plano.criar).toBe(true);
    expect(plano.produtoId).toMatch(/^[0-9a-f]{64}$/);
    expect(plano.linkPai.acao).toBe('add');
    expect(plano.linkPai.docId).toBeNull();
    expect(plano.linkPaiRefPendente).toBe(true);
  });

  it('`merge`ia sobre o vínculo resolvido quando ele já existe', () => {
    const plano = planejarImportacaoShopee(
      preparo({ linkPai: { id: 'link-1', raw: { dataCadastro: 111 } } }),
    );
    expect(plano.linkPai.acao).toBe('merge');
    expect(plano.linkPai.docId).toBe('link-1');
    expect(plano.linkPai.dados.dataCadastro).toBe(111);
    expect(plano.linkPaiRefPendente).toBe(false);
  });

  it('⛔ uma reimportação byte-idêntica NÃO produz patch de produto', () => {
    const entrada = item({ item_name: 'Camiseta Básica', item_sku: 'SKU-1' });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada,
        options: opcoes({ importarPreco: false, importarEstoque: false, importarFotos: false }),
        pai: {
          existente: { id: 'p-1', raw: { sku: 'SKU-1', publicado: true } },
          extraData: { descricao: 'já existe', marca: 'já existe' },
          linkSobFilho: false,
          jaTemFilhos: false,
          estoque: null,
        },
      }),
    );
    expect(plano.produtoPai).toBeNull();
    expect(plano.extraData).toBeNull();
  });
});

/* ---------------------------- 4. os filhos -------------------------------- */

describe('planejarImportacaoShopee — os filhos', () => {
  it('uma listagem SEM modelos não planeja nenhum documento variashopee', () => {
    const plano = planejarImportacaoShopee(preparo());
    expect(plano.filhos).toEqual([]);
    expect(plano.resultado.variacoes).toEqual({ total: 0, criadas: 0, semLink: 0 });
    expect(JSON.stringify(plano)).not.toContain('variashopee');
  });

  it('uma listagem de UM modelo vira pai + UM filho, e a família de um é derivada depois', () => {
    const m = shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [0], model_sku: 'MSKU-1' });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true }, modelos([{ model_id: MODEL_ID, tier_index: [0] }])),
        filhos: [filho(m)],
        linkPai: { id: 'link-1', raw: {} },
      }),
    );
    expect(plano.filhos).toHaveLength(1);
    expect(plano.filhos[0]?.produto?.data.paiId).toBe(plano.produtoId);
    // O ponteiro NÃO é derivado aqui: a wave 5 relê o conjunto COMPLETO de filhos.
    expect(plano.filhoUnico).toEqual({
      paiId: plano.produtoId,
      idsPlanejados: [plano.filhos[0]?.produto?.produtoId],
    });
  });

  it('o sku do filho é o `model_sku` VERBATIM e ⛔ NUNCA ganha o sufixo `-UN`', () => {
    const m = shopeeModelSchema.parse({
      model_id: MODEL_ID,
      tier_index: [0],
      model_sku: 'SKU-PAI',
    });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true, item_sku: 'SKU-PAI' }, modelos([{ model_id: MODEL_ID }])),
        filhos: [filho(m)],
        linkPai: { id: 'link-1', raw: {} },
      }),
    );
    expect(plano.filhos[0]?.produto?.data.sku).toBe('SKU-PAI');
    expect(JSON.stringify(plano)).not.toContain('-UN');
  });

  it('⛔ `model_id: 0` planeja o FILHO, não planeja o vínculo e conta em `semLink`', () => {
    const m = shopeeModelSchema.parse({ model_id: 0, tier_index: [0] });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true }, modelos([{ model_id: 0 }])),
        filhos: [filho(m)],
        linkPai: { id: 'link-1', raw: {} },
      }),
    );
    expect(plano.filhos[0]?.produto).not.toBeNull();
    expect(plano.filhos[0]?.link).toBeNull();
    expect(plano.resultado.variacoes.semLink).toBe(1);
  });

  it('um `model_id` normal planeja o vínculo apontando para o documento do PAI', () => {
    const m = shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [0] });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true }, modelos([{ model_id: MODEL_ID }])),
        filhos: [filho(m)],
        linkPai: { id: 'link-1', raw: {} },
      }),
    );
    expect(plano.filhos[0]?.link?.dados.produtoShopeeOuterRef).toBe(
      `documents/produtos/${plano.produtoId}/prodshopee/link-1`,
    );
  });

  it('um pai com filhos não recebe preço nem estoque — as duas recusas dizem por quê', () => {
    const m = shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [0] });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item(
          { has_model: true, stock_info_v2: { seller_stock: [{ stock: 5 }] } },
          modelos([{ model_id: MODEL_ID }]),
        ),
        filhos: [filho(m)],
      }),
    );
    expect(plano.precosPai).toBeNull();
    expect(plano.estoquePai).toBeNull();
    expect(plano.precoPaiIgnorado).toBe('pai-com-filhos');
    expect(plano.estoquePaiIgnorado).toBe('pai-com-filhos');
  });

  it('a taxonomia resolvida chega ao filho como os dois campos de wire do produto', () => {
    const m = shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [1] });
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true }, modelos([{ model_id: MODEL_ID, tier_index: [1] }])),
        filhos: [filho(m)],
        linkPai: { id: 'link-1', raw: {} },
      }),
    );
    expect(plano.taxonomia).toHaveLength(1);
    expect(plano.filhos[0]?.produto?.data.grupoDeVariacoesUid).toEqual(['n-cor']);
    expect(plano.filhos[0]?.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/n-cor/variacoes/n-verde',
    ]);
  });
});

/* -------------------------- 5. categorias e fotos ------------------------- */

describe('planejarImportacaoShopee — categorias', () => {
  const cadeia = [
    { category_id: 1, parent_category_id: 0, display_category_name: 'Moda', has_children: true },
    {
      category_id: 2,
      parent_category_id: 1,
      display_category_name: 'Camisetas',
      has_children: false,
    },
  ].map((c) => shopeeCategoriaSchema.parse(c));

  it('planeja a cadeia RAIZ→FOLHA encadeada, com o prefixo no doc id', () => {
    const plano = planejarImportacaoShopee(preparo({ categorias: cadeia }));
    expect(plano.categorias.map((c) => c.docId)).toEqual(['shopee-1', 'shopee-2']);
    expect(plano.categorias[0]?.data.categoriaPaiOuterRef).toBeNull();
    expect(plano.categorias[1]?.data.categoriaPaiOuterRef).toBe('documents/categorias/shopee-1');
    expect(plano.categorias[1]?.data.nomeCompleto).toBe('Moda > Camisetas');
    expect(idCategoriaShopee(2)).toBe('shopee-2');
    // A FOLHA é o que vincula o produto.
    expect(plano.produtoPai?.data.categoriaProdutoOuterRef).toBe('documents/categorias/shopee-2');
  });

  it('`importarCategorias: false` não planeja categoria nenhuma e não vincula nada', () => {
    const plano = planejarImportacaoShopee(
      preparo({ categorias: cadeia, options: opcoes({ importarCategorias: false }) }),
    );
    expect(plano.categorias).toEqual([]);
    expect(plano.produtoPai?.data.categoriaProdutoOuterRef).toBeNull();
  });

  it('um id desconhecido (cadeia vazia) não vincula nada e não falha', () => {
    const plano = planejarImportacaoShopee(preparo({ categorias: [] }));
    expect(plano.categorias).toEqual([]);
    expect(plano.produtoPai?.data.categoriaProdutoOuterRef).toBeNull();
  });
});

describe('planejarImportacaoShopee — fotos', () => {
  const comImagens = (urls: string[], ids: string[]) =>
    item({ price_info: PRECO_BRL, image: { image_url_list: urls, image_id_list: ids } });

  it('pareia url↔image_id por ÍNDICE', () => {
    const plano = planejarImportacaoShopee(
      preparo({ entrada: comImagens(['https://a/1', 'https://a/2'], ['i1', 'i2']) }),
    );
    expect(plano.fotos.baixar).toEqual([
      { url: 'https://a/1', imageId: 'i1' },
      { url: 'https://a/2', imageId: 'i2' },
    ]);
  });

  it('comprimentos DIFERENTES não lançam: a url extra entra sem id, o id extra é ignorado', () => {
    const maisUrls = planejarImportacaoShopee(
      preparo({ entrada: comImagens(['https://a/1', 'https://a/2'], ['i1']) }),
    );
    expect(maisUrls.fotos.baixar).toEqual([
      { url: 'https://a/1', imageId: 'i1' },
      { url: 'https://a/2', imageId: null },
    ]);

    const maisIds = planejarImportacaoShopee(
      preparo({ entrada: comImagens(['https://a/1'], ['i1', 'i2']) }),
    );
    expect(maisIds.fotos.baixar).toHaveLength(1);
  });

  it('uma imagem já cacheada para ESTA integração é contada em `ignoradas`', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: comImagens(['https://a/1', 'https://a/2'], ['i1', 'i2']),
        imagensJaCacheadas: ['i1'],
      }),
    );
    expect(plano.fotos.ignoradas).toBe(1);
    expect(plano.fotos.baixar).toEqual([{ url: 'https://a/2', imageId: 'i2' }]);
    expect(plano.resultado.fotos).toEqual({ aBaixar: 1, ignoradas: 1 });
  });

  it('`importarFotos: false` não planeja download nenhum', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: comImagens(['https://a/1'], ['i1']),
        options: opcoes({ importarFotos: false }),
      }),
    );
    expect(plano.fotos).toEqual({ baixar: [], ignoradas: 0 });
  });
});

/* --------------------------- 6. relógios e unidades ----------------------- */

describe('planejarImportacaoShopee — relógios', () => {
  it('⛔ o plano não contém NENHUM microssegundo e nenhum relógio próprio', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({
          price_info: PRECO_BRL,
          stock_info_v2: { seller_stock: [{ stock: 2 }] },
          create_time: 1_757_000_000,
          update_time: 1_757_000_100,
        }),
        categorias: [
          shopeeCategoriaSchema.parse({
            category_id: 2,
            parent_category_id: 0,
            display_category_name: 'Camisetas',
            has_children: false,
          }),
        ],
      }),
    );
    const numeros: number[] = [];
    JSON.stringify(plano, (_k, v) => {
      if (typeof v === 'number') numeros.push(v);
      return v as unknown;
    });
    // Todo carimbo é EXATAMENTE o `nowMs` recebido — nenhuma leitura de relógio dentro.
    const carimbos = numeros.filter((n) => n > 1_000_000_000_000);
    expect(carimbos.length).toBeGreaterThan(0);
    expect(new Set(carimbos)).toEqual(new Set([AGORA]));
    // E nada em escala de microssegundos (~1.75e15) chegou ao plano.
    expect(numeros.every((n) => n < 1e15)).toBe(true);
  });

  it('⛔ os relógios de wire da Shopee (SEGUNDOS) não são armazenados em lugar nenhum', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        // Escolhidos para NÃO serem prefixo do `nowMs` em ms — senão o teste
        // passaria/falharia por artefato de substring, não pelo que afirma.
        entrada: item({
          price_info: PRECO_BRL,
          create_time: 1_600_000_001,
          update_time: 1_600_000_002,
        }),
      }),
    );
    const texto = JSON.stringify(plano);
    expect(texto).not.toContain('1600000001');
    expect(texto).not.toContain('1600000002');
    expect(texto).not.toContain('update_time');
    expect(texto).not.toContain('create_time');
  });
});

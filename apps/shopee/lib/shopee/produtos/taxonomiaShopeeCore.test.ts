import { describe, expect, it } from 'vitest';

import { shopeeModelSchema, type ShopeeModel } from '@delfrance/integrations-shopee';
import { TIPO_VARIACAO, type LinkVariacoesShopee } from '@delfrance/schemas';

import type { GrupoMemo } from './itemLido';
import {
  fundirLinksVariacoesShopee,
  normalizarParaSlug,
  planejarTaxonomia,
  tiersDoItem,
  tipoDeVariacaoShopee,
  trocarEspacoHifen,
  trocarVogalDeGenero,
  type TierShopee,
} from './taxonomiaShopeeCore';

/* ---------------------------------- fixtures ------------------------------ */

const INTEGRACAO = 'int-1';
const CATEGORIA = 100017;
const AGORA = 1_757_000_000_000;

function memo(docs: { id: string; raw: Record<string, unknown> }[] = []): GrupoMemo['docs'] {
  return docs;
}

function tier(parcial: Partial<TierShopee> = {}): TierShopee {
  return {
    nome: 'Cor',
    variationId: 0,
    opcoes: [{ nome: 'Azul', optionId: 0 }],
    ...parcial,
  };
}

function modelo(tierIndex: number[], modelId = 1): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: modelId, tier_index: tierIndex });
}

function entrada(parcial: Partial<LinkVariacoesShopee> = {}): LinkVariacoesShopee {
  return {
    name: 'Camisetas',
    category_id: CATEGORIA,
    variation_id: 0,
    variation_group_list: 0,
    integracaoShopeeId: INTEGRACAO,
    variationOptions: [],
    ...parcial,
  };
}

/* ------------------------------ 1. os dois folds -------------------------- */

describe('tipoDeVariacaoShopee', () => {
  it('dobra tamanho/size e cor/color nas duas línguas, trim + lowercase', () => {
    for (const n of ['Tamanho', 'tamanho', 'TAMANHO', ' Tamanho ', 'Tamanhos', 'Size', 'sizes']) {
      expect(tipoDeVariacaoShopee(n)).toBe(TIPO_VARIACAO.tamanho);
    }
    // A loja do sandbox usa literalmente `color` e `Size`, que é o que faz os
    // membros em inglês ganharem o lugar deles.
    for (const n of ['Cor', 'cor', 'COR', ' Cor ', 'Cores', 'color', 'Colour', 'colors']) {
      expect(tipoDeVariacaoShopee(n)).toBe(TIPO_VARIACAO.cor);
    }
  });

  it('⛔ NEAR-MISS: `Tamanho do Pé` não é tamanho', () => {
    expect(tipoDeVariacaoShopee('Tamanho do Pé')).toBe(TIPO_VARIACAO.outros);
  });

  it('⛔ NEAR-MISS: `Corte` não é cor — a pertinência é EXATA, nunca um prefixo', () => {
    expect(tipoDeVariacaoShopee('Corte')).toBe(TIPO_VARIACAO.outros);
  });

  it('⛔ NEAR-MISS: `Colorido` não é cor', () => {
    expect(tipoDeVariacaoShopee('Colorido')).toBe(TIPO_VARIACAO.outros);
  });

  it('⛔ NEAR-MISS: `Cor da Alça` não é cor', () => {
    expect(tipoDeVariacaoShopee('Cor da Alça')).toBe(TIPO_VARIACAO.outros);
  });

  it('⛔ NEAR-MISS: `Côr` NÃO é dobrado — a estreiteza é conhecida e fixada', () => {
    // Alargar o fold alarga o que o RUNG DE TIPO casa, e um casamento errado
    // amarra os tamanhos de um anúncio ao grupo de cores do operador.
    expect(tipoDeVariacaoShopee('Côr')).toBe(TIPO_VARIACAO.outros);
    expect(tipoDeVariacaoShopee(null)).toBe(TIPO_VARIACAO.outros);
  });
});

describe('normalizarParaSlug e as duas trocas literais', () => {
  it('normaliza para `[a-z0-9-]`, com as corridas de espaço virando UM hífen', () => {
    expect(normalizarParaSlug(' Cor da Alça ')).toBe('cor-da-ala');
    expect(normalizarParaSlug('Azul  Marinho')).toBe('azul-marinho');
  });

  it('a troca de vogal de gênero funciona nos dois sentidos e nas duas caixas', () => {
    expect(trocarVogalDeGenero('Vermelha')).toBe('Vermelho');
    expect(trocarVogalDeGenero('Vermelho')).toBe('Vermelha');
    expect(trocarVogalDeGenero('BRANCA')).toBe('BRANCO');
  });

  it('⛔ NEAR-MISS: uma palavra sem vogal final trocável devolve null', () => {
    expect(trocarVogalDeGenero('Verde')).toBeNull();
    expect(trocarVogalDeGenero('')).toBeNull();
  });

  it('a troca espaço⇄hífen é de uma classe só', () => {
    expect(trocarEspacoHifen('Azul Marinho')).toBe('Azul-Marinho');
    expect(trocarEspacoHifen('Azul-Marinho')).toBe('Azul Marinho');
    expect(trocarEspacoHifen('Verde')).toBe('Verde');
  });

  it('⛔ NEAR-MISS: dois espaços viram dois hífens e NÃO casam com um só', () => {
    expect(trocarEspacoHifen('Azul  Marinho')).toBe('Azul--Marinho');
    expect(trocarEspacoHifen('Azul  Marinho')).not.toBe('Azul-Marinho');
  });
});

/* ---------------------------- 2. a lista de tiers ------------------------- */

describe('tiersDoItem', () => {
  const tiers = [
    { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
    { name: 'Tamanho', option_list: [{ option: 'P' }] },
  ] as never;

  it('pareia os ids por ÍNDICE quando os dois vetores têm o mesmo comprimento', () => {
    const lista = tiersDoItem({
      tiers,
      padronizados: [
        {
          variation_id: 100015,
          variation_option_list: [{ variation_option_id: 5001 }, { variation_option_id: 5002 }],
        },
        { variation_id: 100016, variation_option_list: [{ variation_option_id: 5003 }] },
      ] as never,
    });
    expect(lista[0]?.variationId).toBe(100015);
    expect(lista[0]?.opcoes[1]).toEqual({ nome: 'Verde', optionId: 5002 });
    expect(lista[1]?.variationId).toBe(100016);
  });

  it('⛔ NEAR-MISS: comprimentos DIFERENTES ⇒ os ids são ignorados e só os NOMES casam', () => {
    // Parear por índice um par desalinhado grudaria o id de um tier no nome de outro.
    const lista = tiersDoItem({
      tiers,
      padronizados: [{ variation_id: 100015, variation_option_list: [] }] as never,
    });
    expect(lista.map((t) => t.variationId)).toEqual([0, 0]);
    expect(lista[0]?.opcoes.map((o) => o.optionId)).toEqual([0, 0]);
  });

  it('tolera as DUAS árvores ausentes', () => {
    expect(tiersDoItem({ tiers: [], padronizados: [] })).toEqual([]);
  });

  it('descarta um tier sem nome E sem id — não há identidade para casar nem nome para criar', () => {
    const lista = tiersDoItem({
      tiers: [{ name: '  ', option_list: [{ option: '' }] }] as never,
      padronizados: [],
    });
    expect(lista).toEqual([]);
  });
});

/* -------------------------- 3. a cascata de grupos ------------------------ */

describe('planejarTaxonomia — a cascata de GRUPO', () => {
  const base = {
    modelos: [] as ShopeeModel[],
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Camisetas',
    nowMs: AGORA,
  };

  it('rung 1a: casa pelo doc id `shopee-<variation_id>`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Qualquer Coisa', variationId: 100015 })],
      candidatos: memo([{ id: 'shopee-100015', raw: { nome: 'Cor do Operador' } }]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('shopee-100015');
    expect(plano.grupos[0]?.criar).toBe(false);
  });

  it('rung 1b: casa por um `linksVariacoesShopee` do MEMO com o mesmo variation_id', () => {
    // O mapeamento que o operador autorou é exatamente o que a publicação lê;
    // não encontrá-lo cria um grupo duplicado E quebra um publish futuro.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Qualquer Coisa', variationId: 100015 })],
      candidatos: memo([
        {
          id: 'g-operador',
          raw: {
            nome: 'Cor do Operador',
            linksVariacoesShopee: [
              { integracaoShopeeId: INTEGRACAO, category_id: 999, variation_id: 100015 },
            ],
          },
        },
      ]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('g-operador');
  });

  it('⛔ NEAR-MISS: um link de OUTRA integração no mesmo grupo NÃO casa', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Qualquer Coisa', variationId: 100015 })],
      candidatos: memo([
        {
          id: 'g-operador',
          raw: {
            nome: 'Cor do Operador',
            linksVariacoesShopee: [
              { integracaoShopeeId: 'int-2', category_id: 999, variation_id: 100015 },
            ],
          },
        },
      ]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('shopee-100015');
    expect(plano.grupos[0]?.criar).toBe(true);
  });

  it('⛔ NEAR-MISS: um `variation_id: 0` armazenado casa com NADA — 0 é custom, não curinga', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Estampa', variationId: 0 })],
      candidatos: memo([
        {
          id: 'g-operador',
          raw: {
            nome: 'Outro Nome',
            linksVariacoesShopee: [
              { integracaoShopeeId: INTEGRACAO, category_id: CATEGORIA, variation_id: 0 },
            ],
          },
        },
      ]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('n-estampa');
    expect(plano.grupos[0]?.criar).toBe(true);
  });

  it('rung 2: casa por `nome` EXATO, byte a byte', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor' })],
      candidatos: memo([{ id: 'g-cor', raw: { nome: 'Cor' } }]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('g-cor');
  });

  it('⛔ NEAR-MISS: `cor` minúsculo e `Cor ` com espaço NÃO casam pelo nome', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor' })],
      candidatos: memo([
        { id: 'g-a', raw: { nome: 'cor' } },
        { id: 'g-b', raw: { nome: 'Cor ' } },
      ]),
    });
    // Nenhum dos dois casa pelo NOME; o rung 3 (tipo) então decide, e nenhum
    // deles declara tipo — logo, criação.
    expect(plano.grupos[0]?.criar).toBe(true);
  });

  it('rung 3: casa por TIPO — um grupo `Cores` com tipo 2 serve um tier `Color`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Color' })],
      candidatos: memo([{ id: 'g-cores', raw: { nome: 'Cores', tipo: TIPO_VARIACAO.cor } }]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('g-cores');
  });

  it('⛔ NEAR-MISS: um tier `Corte` dobra para `outros`, então o rung de tipo NUNCA roda', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Corte' })],
      candidatos: memo([{ id: 'g-cores', raw: { nome: 'Cores', tipo: TIPO_VARIACAO.cor } }]),
    });
    expect(plano.grupos[0]?.grupoId).toBe('n-corte');
    expect(plano.grupos[0]?.criar).toBe(true);
  });

  it('rung 4: cria com `ordem: i + 1` e o tipo do fold', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [
        tier({ nome: 'Cor' }),
        tier({ nome: 'Tamanho', opcoes: [{ nome: 'P', optionId: 0 }] }),
      ],
      candidatos: memo(),
    });
    expect(plano.grupos[0]?.docNovo).toMatchObject({
      nome: 'Cor',
      ordem: 1,
      tipo: TIPO_VARIACAO.cor,
      permiteFotos: true,
      timestamp: AGORA,
      ultimaModificacao: null,
    });
    expect(plano.grupos[1]?.docNovo).toMatchObject({
      nome: 'Tamanho',
      ordem: 2,
      tipo: TIPO_VARIACAO.tamanho,
      permiteFotos: false,
    });
  });

  it('⛔ a `ordem` de um grupo EXISTENTE nunca é tocada — ela é do operador', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor' })],
      candidatos: memo([{ id: 'g-cor', raw: { nome: 'Cor', ordem: 9 } }]),
    });
    expect(plano.grupos[0]?.patch ?? {}).not.toHaveProperty('ordem');
    expect(plano.grupos[0]?.docNovo).toBeNull();
  });

  it('o patch nomeia SÓ os três campos que a escrita guardada pode mascarar', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor' })],
      candidatos: memo([{ id: 'g-cor', raw: { nome: 'Cor' } }]),
    });
    expect(Object.keys(plano.grupos[0]?.patch ?? {}).sort()).toEqual([
      'linksVariacoesShopee',
      'variacoes',
      'variacoesIds',
    ]);
  });
});

/* ------------------------ 4. a cascata de variantes ----------------------- */

describe('planejarTaxonomia — a cascata de VARIANTE', () => {
  const base = {
    modelos: [] as ShopeeModel[],
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Camisetas',
    nowMs: AGORA,
  };

  const grupoCom = (variacoes: unknown[], extra: Record<string, unknown> = {}) =>
    memo([{ id: 'g-cor', raw: { nome: 'Cor', variacoes, ...extra } }]);

  it('rung 1: o mapeamento de OPÇÃO do operador vence, qualquer que seja o nome', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul Celeste', optionId: 5001 }] })],
      candidatos: grupoCom([{ id: 'v-escolhida', nome: 'Um Nome Totalmente Outro' }], {
        linksVariacoesShopee: [
          {
            name: 'Camisetas',
            category_id: CATEGORIA,
            variation_id: 0,
            variation_group_list: 0,
            integracaoShopeeId: INTEGRACAO,
            variationOptions: [
              {
                shopee_option_id: 5001,
                shopee_option_name: 'qualquer',
                arakene_variation_id: ['v-escolhida'],
              },
            ],
          },
        ],
      }),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-escolhida']);
  });

  it('⛔ NEAR-MISS: `shopee_option_id: 0` não casa por id — ele é custom, não curinga', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-outra', nome: 'Verde' }], {
        linksVariacoesShopee: [
          {
            name: 'Camisetas',
            category_id: CATEGORIA,
            variation_id: 0,
            variation_group_list: 0,
            integracaoShopeeId: INTEGRACAO,
            variationOptions: [
              {
                shopee_option_id: 0,
                shopee_option_name: 'Verde',
                arakene_variation_id: ['v-outra'],
              },
            ],
          },
        ],
      }),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-roxo']);
  });

  it('rung 2: casa por nome EXATO', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-azul', nome: 'Azul' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-azul']);
  });

  it('⛔ NEAR-MISS: `azul` minúsculo NÃO casa por nome', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-azul', nome: 'azul' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-azul']);
  });

  it('rung 3a: a vogal de gênero casa `Vermelha` com o armazenado `Vermelho`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vermelho', nome: 'Vermelho' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-vermelho']);
  });

  it('rung 3b: espaço⇄hífen casa `Azul Marinho` com `Azul-Marinho`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul Marinho', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-am', nome: 'Azul-Marinho' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-am']);
  });

  it('⛔ NEAR-MISS: as duas trocas NUNCA são combinadas — vogal DEPOIS hífen não alcança', () => {
    // O par tem de ser alcançável pela COMPOSIÇÃO e por nenhuma das trocas
    // sozinha, senão o teste não distingue nada: `Vermelha Clara` → (vogal)
    // `Vermelha Claro` → (hífen) `Vermelha-Claro`, que é EXATAMENTE o valor
    // armazenado. Duas edições de distância já não é uma variação de grafia de
    // uma palavra: é outro valor, e amarrá-lo move o estoque do anúncio para a
    // variante errada.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha Clara', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vc', nome: 'Vermelha-Claro' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-vermelha-clara']);
  });

  it('⛔ NEAR-MISS: e na ordem INVERSA também não — hífen depois vogal', () => {
    // `Azul-Vermelha` → (hífen) `Azul Vermelha` → (vogal) `Azul Vermelho`.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul-Vermelha', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-av', nome: 'Azul Vermelho' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-azul-vermelha']);
  });

  it('⛔ NEAR-MISS: `Vermelha Clara` ainda NÃO alcança `Vermelho-Claro` (duas palavras)', () => {
    // A troca de vogal mexe só no ÚLTIMO caractere, então nem a composição
    // chega aqui — o par é mantido como documentação do limite real do fold.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha Clara', optionId: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vc2', nome: 'Vermelho-Claro' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-vermelha-clara']);
  });

  it('rung 4: cria com `codigo: null` e o `externalVariacaoLinks` da integração', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 5009 }] })],
      candidatos: memo(),
    });
    const variacoes = (plano.grupos[0]?.docNovo?.variacoes ?? []) as Record<string, unknown>[];
    expect(variacoes[0]).toMatchObject({
      id: 'shopee-5009',
      nome: 'Roxo',
      codigo: null,
      timestamp: AGORA,
    });
    expect(variacoes[0]?.externalVariacaoLinks).toEqual([
      {
        tipo: 5,
        integracaoId: INTEGRACAO,
        externalId: '5009',
        externalName: 'Roxo',
        timestamp: AGORA,
      },
    ]);
  });

  it('carimba `externalVariacaoLinks` numa variante que casou e ainda não tem o par', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 5001 }] })],
      candidatos: grupoCom([{ id: 'v-azul', nome: 'Azul' }]),
    });
    const variacoes = (plano.grupos[0]?.patch?.variacoes ?? []) as Record<string, unknown>[];
    expect(variacoes[0]?.externalVariacaoLinks).toEqual([
      {
        tipo: 5,
        integracaoId: INTEGRACAO,
        externalId: '5001',
        externalName: 'Azul',
        timestamp: AGORA,
      },
    ]);
  });

  it('⛔ não duplica o carimbo quando o par (integração, externalId) já existe', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 5001 }] })],
      candidatos: grupoCom([
        {
          id: 'v-azul',
          nome: 'Azul',
          externalVariacaoLinks: [{ tipo: 5, integracaoId: INTEGRACAO, externalId: '5001' }],
        },
      ]),
    });
    // Nada mudou nas variações; o patch (se houver) vem só do link da categoria.
    const variacoes = (plano.grupos[0]?.patch?.variacoes ?? []) as Record<string, unknown>[];
    expect((variacoes[0]?.externalVariacaoLinks as unknown[]).length).toBe(1);
  });

  it('usa o NOME como `externalId` quando a opção é custom (id 0)', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 0 }] })],
      candidatos: memo(),
    });
    const variacoes = (plano.grupos[0]?.docNovo?.variacoes ?? []) as Record<string, unknown>[];
    expect(variacoes[0]?.externalVariacaoLinks).toEqual([
      {
        tipo: 5,
        integracaoId: INTEGRACAO,
        externalId: 'Roxo',
        externalName: 'Roxo',
        timestamp: AGORA,
      },
    ]);
  });
});

/* ------------------------- 5. os combos por modelo ------------------------ */

describe('planejarTaxonomia — os combos', () => {
  it('projeta cada modelo nos dois campos de wire do produto', () => {
    const plano = planejarTaxonomia({
      tiers: [
        tier({
          nome: 'Cor',
          opcoes: [
            { nome: 'Azul', optionId: 0 },
            { nome: 'Verde', optionId: 0 },
          ],
        }),
        tier({
          nome: 'Tamanho',
          opcoes: [
            { nome: 'P', optionId: 0 },
            { nome: 'M', optionId: 0 },
          ],
        }),
      ],
      modelos: [modelo([1, 0], 11), modelo([0, 1], 12)],
      candidatos: memo(),
      integracaoId: INTEGRACAO,
      categoryId: CATEGORIA,
      nomeCategoria: 'Camisetas',
      nowMs: AGORA,
    });
    expect(plano.combosPorModelo.get(11)).toEqual({
      grupoDeVariacoesUid: ['n-cor', 'n-tamanho'],
      variacoesUid: [
        'documents/grupoDeVariacoes/n-cor/variacoes/n-verde',
        'documents/grupoDeVariacoes/n-tamanho/variacoes/n-p',
      ],
    });
    expect(plano.combos[1]).toEqual(plano.combosPorModelo.get(12));
  });

  it('⛔ um tier fora dos limites não vira placeholder nem caminho pendurado', () => {
    const plano = planejarTaxonomia({
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0 }] })],
      modelos: [modelo([9], 11)],
      candidatos: memo(),
      integracaoId: INTEGRACAO,
      categoryId: CATEGORIA,
      nomeCategoria: 'Camisetas',
      nowMs: AGORA,
    });
    expect(plano.combosPorModelo.get(11)).toEqual({
      grupoDeVariacoesUid: null,
      variacoesUid: null,
    });
  });
});

/* -------------------- 6. a fusão de linksVariacoesShopee ------------------ */

describe('fundirLinksVariacoesShopee', () => {
  it('acrescenta a nossa entrada quando não há nenhuma', () => {
    const r = fundirLinksVariacoesShopee(null, entrada());
    expect(r.mudou).toBe(true);
    expect(r.array).toHaveLength(1);
  });

  it('não sobrescreve um `variation_id` NÃO-ZERO do operador', () => {
    const armazenado = [{ ...entrada({ variation_id: 100015 }) }];
    const r = fundirLinksVariacoesShopee(armazenado, entrada({ variation_id: 200000 }));
    expect((r.array[0] as LinkVariacoesShopee).variation_id).toBe(100015);
  });

  it('preenche um `variation_id` ZERO com o nosso', () => {
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ variation_id: 0 }) }],
      entrada({ variation_id: 100015 }),
    );
    expect((r.array[0] as LinkVariacoesShopee).variation_id).toBe(100015);
    expect(r.mudou).toBe(true);
  });

  it('une `arakene_variation_id` sem remover nenhum', () => {
    const armazenado = [
      {
        ...entrada({
          variationOptions: [
            {
              shopee_option_id: 5001,
              shopee_option_name: 'Azul',
              arakene_variation_id: ['v-do-op'],
            },
          ],
        }),
      },
    ];
    const r = fundirLinksVariacoesShopee(
      armazenado,
      entrada({
        variationOptions: [
          { shopee_option_id: 5001, shopee_option_name: 'Azul', arakene_variation_id: ['v-nosso'] },
        ],
      }),
    );
    const opcao = (r.array[0] as LinkVariacoesShopee).variationOptions[0];
    expect(opcao?.arakene_variation_id).toEqual(['v-do-op', 'v-nosso']);
  });

  it('mantém VERBATIM um elemento que não passa no schema', () => {
    // O formulário Flutter autorou isto. Um elemento que não sabemos ler ainda
    // é trabalho do operador — nunca é um elemento que podemos apagar.
    const lixo = { algo: 'que o schema não entende' };
    const r = fundirLinksVariacoesShopee([lixo], entrada());
    expect(r.array[0]).toBe(lixo);
    expect(r.array).toHaveLength(2);
  });

  it('⛔ NEAR-MISS: `Azul` e `azul` com id 0 ficam DUAS opções', () => {
    // O nome volta para a Shopee verbatim na publicação: um fold de caixa aqui
    // funde duas opções reais e derruba o mapeamento de uma delas.
    const armazenado = [
      {
        ...entrada({
          variationOptions: [
            { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v1'] },
          ],
        }),
      },
    ];
    const r = fundirLinksVariacoesShopee(
      armazenado,
      entrada({
        variationOptions: [
          { shopee_option_id: 0, shopee_option_name: 'azul', arakene_variation_id: ['v2'] },
        ],
      }),
    );
    expect((r.array[0] as LinkVariacoesShopee).variationOptions).toHaveLength(2);
  });

  it('⛔ NEAR-MISS: duas opções custom distintas nunca casam "na entrada de id 0"', () => {
    const armazenado = [
      {
        ...entrada({
          variationOptions: [
            { shopee_option_id: 0, shopee_option_name: 'Roxo', arakene_variation_id: ['v1'] },
          ],
        }),
      },
    ];
    const r = fundirLinksVariacoesShopee(
      armazenado,
      entrada({
        variationOptions: [
          { shopee_option_id: 0, shopee_option_name: 'Lilás', arakene_variation_id: ['v2'] },
        ],
      }),
    );
    expect((r.array[0] as LinkVariacoesShopee).variationOptions).toHaveLength(2);
  });

  it('uma reimportação idêntica devolve `mudou: false` — e nada é escrito', () => {
    const nossa = entrada({
      variationOptions: [
        { shopee_option_id: 5001, shopee_option_name: 'Azul', arakene_variation_id: ['v1'] },
      ],
    });
    const r = fundirLinksVariacoesShopee([{ ...nossa }], nossa);
    expect(r.mudou).toBe(false);
  });

  it('a chave é (integracaoShopeeId, category_id) — outra categoria é OUTRA entrada', () => {
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ category_id: 999 }) }],
      entrada({ category_id: CATEGORIA }),
    );
    expect(r.array).toHaveLength(2);
  });

  it('`integracaoShopeeId` é gravado como doc id BARE, nunca como outer-ref', () => {
    const r = fundirLinksVariacoesShopee(null, entrada());
    expect((r.array[0] as LinkVariacoesShopee).integracaoShopeeId).toBe('int-1');
    expect(JSON.stringify(r.array)).not.toContain('documents/integracao');
  });
});
